/**
 * 看板工具（specs/12 §工具）。
 * 每个 agent-bot agent 的 setup 都 scoped 注册这 6 个工具（无 is_lead）：
 *   list_group_experts / list_tasks / open_task / update_task / dispatch_expert / ask_task_lead
 *
 * 调用方身份：`exec.agent?.id` 即 DSH sessionId；经 agentIdentity 解析成 agentId/agentName。
 * 本任务绑定：binding.ts（session→taskId），open_task / 入站 followup 落。
 *
 * 工具输出不直接向模型隐藏：render 给纯文本，附完整能力卡片与任务摘要。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { clearSession, getAgent as getAgentConfig, listAgents as listAgentConfigs, touchSession } from '../agents.js'
import { expandHomePath, loadConfig, type AgentConfig } from '../config.js'
import { listSkills } from '../skills.js'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { buildRelay, resolveFenceDir, taskSlotKey, type Relay, type RelayHost } from './relay.js'
import { bindSession, boundTaskId, bindIfAbsent } from './binding.js'
import {
  readTask,
  writeTask,
  listTasksIn,
  describeTasks,
  filterByConversation,
  isTaskId,
  marshalTaskYaml,
  createTask,
  taskFilePath,
  type Access,
  type TaskBoard,
  type AssigneeStatus,
} from './task-board.js'
import { inboundFor } from './inbound.js'

/** 调用方 agent 身份解析。sessionId → { agentId, agentName }。 */
export interface AgentIdentity {
  (sessionId: string): { agentId: string; agentName: string } | undefined
}

export interface BoardToolDeps {
  /** 对话标识：同 providerId + 同 key 的任务才算「本群」。由 service 注入（用通道的 conversationKey）。 */
  conversationKeyFor: (providerId: string, parts: Record<string, string>) => string
  agentIdentity: AgentIdentity
  ensureAgent: RelayHost['ensureAgent']
  agents: RelayHost['agents']
}

/** 一个专家的能力卡片（供 list_group_experts / 派发 turn 包装，不写进被派专家 prompt）。 */
export interface ExpertCard {
  agentId: string
  name: string
  description?: string
  needs_target_workspace?: boolean
  workspaceCandidates?: Array<{ name: string; workspace: string }>
  skills?: Array<{ name: string; description: string }>
}

/** 群快照（由 Provider 在派发 / 入站时发现；任务创建时缓存一份写进 frontmatter）。 */
export interface GroupSnapshotInput {
  members: Array<{ agentId: string; name: string; description: string }>
}

/** 路线 b：中枢全集成员投影（agents.json），不带技能（技能由 buildExpertCards 补齐）。 */
export function hubMembers(): Array<{ agentId: string; name: string; description: string }> {
  return listAgentConfigs().map((a) => ({ agentId: a.id, name: a.name, description: a.description }))
}

/** 组装专家卡片（从 agents.json + skills-map 补齐 description / skills）。 */
export function buildExpertCards(members: Array<{ agentId: string; name: string; description: string }>): ExpertCard[] {
  const configs = new Map(listAgentConfigs().map((a) => [a.id, a]))
  const skillsMap = new Map(listSkills().map((s) => [s.id, s]))
  const cards: ExpertCard[] = []
  for (const m of members) {
    const cfg = configs.get(m.agentId)
    if (cfg === undefined) continue // 不在 agents.json：丢掉
    const card: ExpertCard = { agentId: cfg.id, name: cfg.name }
    if (cfg.description !== '') card.description = cfg.description
    if (cfg.needs_target_workspace) {
      card.needs_target_workspace = true
      card.workspaceCandidates = members
        .filter((x) => x.agentId !== cfg.id)
        .map((x) => {
          const c = configs.get(x.agentId)
          return { name: c?.name ?? x.name, workspace: c?.workspace ?? '' }
        })
        .filter((c) => c.workspace !== '')
    }
    const skills: Array<{ name: string; description: string }> = []
    for (const gid of cfg.skill_groups) {
      const group = loadConfig().skill_groups[gid]
      if (group === undefined) continue
      for (const skillId of group.skill_ids) {
        const entry = skillsMap.get(skillId)
        if (entry === undefined) continue
        skills.push({ name: basename(entry.path), description: entry.description })
      }
    }
    if (skills.length > 0) card.skills = skills
    cards.push(card)
  }
  return cards
}

/** 解析运行中的 session 归属哪个 agent（channel 槽 or 协作槽），供 running_experts。 */
function runningExpertIds(snapshotMembers: Array<{ agentId: string; name: string; description: string }>): string[] {
  const configs = new Map(listAgentConfigs().map((a) => [a.id, a]))
  const running = new Set<string>()
  for (const m of snapshotMembers) {
    const cfg = configs.get(m.agentId)
    if (cfg === undefined) continue
    for (const slot of Object.values(cfg.sessions)) {
      // 通道槽 / 协作槽都算：会话活着（agents.get）即未 idle
      if (slot.sessionId !== '' ) running.add(m.agentId)
    }
  }
  return [...running]
}

/** 校验 target_workspace：needs_target_workspace=true 才检查；绝对路径 + 目录存在。 */
export function resolveTargetWorkspace(agent: AgentConfig, raw: string | undefined): { ok: true; path: string } | { ok: false; reason: string } {
  if (agent.needs_target_workspace !== true) return { ok: true, path: '' }
  const value = (raw ?? '').trim()
  if (value === '') return { ok: false, reason: `专家 ${agent.name} 需要目标项目目录：请传绝对路径 target_workspace` }
  const expanded = expandHomePath(value)
  if (!expanded.startsWith('/')) return { ok: false, reason: `target_workspace 必须是绝对路径，收到: ${value}` }
  if (!existsSync(expanded)) return { ok: false, reason: `目标目录不存在: ${expanded}` }
  return { ok: true, path: expanded }
}

function getBoundTask(sessionId: string): { task: TaskBoard; status: 'running' } | undefined {
  const taskId = boundTaskId(sessionId)
  if (taskId === undefined) return undefined
  const task = readTask('running', taskId)
  if (task === undefined) return undefined
  return { task, status: 'running' }
}

/** 派发写入：解析名称 + 落 assignees[]（status 按 FIFO / 并行判定）。 */
function upsertAssignee(
  task: TaskBoard,
  expert: { agentId: string; name: string; sessionId: string; dispatchedBy: string; dispatchedByName: string; access: Access; target?: string; status: AssigneeStatus; instruction?: string },
  wake = true,
): void {
  const idx = task.assignees.findIndex((a) => a.expertId === expert.agentId)
  const record = {
    expertId: expert.agentId,
    expertName: expert.name,
    dispatchedBy: expert.dispatchedBy,
    dispatchedByName: expert.dispatchedByName,
    sessionId: expert.sessionId,
    access: expert.access,
    target: expert.target,
    status: expert.status,
    wake,
    instruction: expert.instruction,
  }
  if (idx < 0) task.assignees.push(record)
  else task.assignees[idx] = record
}

/**
 * 派发方自己是这单的 assignee（中间层 B 再派 C）→ 把自己标 `waiting`（暂停等下游）。
 * `waiting` 不算终态，因此不会被上报给 A；等 C 那几路终态后由上报链叫醒 B，
 * 那时再把 B 改回 `running` 让它接着做（见 patrol）。
 */
function pauseSelfIfIntermediate(task: TaskBoard, callerAgentId: string, relay: Relay): boolean {
  const self = task.assignees.find((a) => a.expertId === callerAgentId)
  if (self === undefined) return false
  if (self.status === 'waiting') return false
  self.status = 'waiting'
  // 暂停期间没在写 → **必须让出目标锁**，否则：
  // 它派到同一 target 的下游会一直排在队列里 → 下游永不完成 → 它永远不恢复 → 死锁
  if (self.access === 'write') {
    const cfg = getAgentConfig(callerAgentId)
    relay.writeFence.release(resolveFenceDir(self.target, task.target, cfg?.workspace), self.sessionId)
  }
  return true
}

/**
 * 「我」属于哪个对话：优先本轮入站上下文，其次已绑定任务。
 * 两个都没有 → undefined（调用方**不列**，而不是返回全部）。
 */
function myConversation(
  sessionId: string,
  keyFor: (providerId: string, parts: Record<string, string>) => string,
): { providerId: string; key: string } | undefined {
  const inb = inboundFor(sessionId)
  if (inb !== undefined) return { providerId: inb.providerId, key: keyFor(inb.providerId, inb.sessionParts) }
  const taskId = boundTaskId(sessionId)
  if (taskId !== undefined) {
    const t = readTask('running', taskId)
    if (t !== undefined) return { providerId: t.providerId, key: keyFor(t.providerId, t.sessionParts) }
  }
  return undefined
}

/** 本群 running 任务（按对话隔离）。定位不到自己的对话 → 返回 undefined。 */
function myRunningTasks(
  sessionId: string,
  keyFor: (providerId: string, parts: Record<string, string>) => string,
): TaskBoard[] | undefined {
  const mine = myConversation(sessionId, keyFor)
  if (mine === undefined) return undefined
  return filterByConversation(listTasksIn('running'), mine, keyFor)
}

/** 旧单 md 里的 leadSessionId 若指向这条会话，清掉（换单时别让旧单叫醒到新单的会话）。 */
function clearLeadSessionIfPointingAt(taskId: string, sessionId: string): void {
  const t = readTask('running', taskId)
  if (t === undefined || t.leadSessionId !== sessionId) return
  t.leadSessionId = undefined
  writeTask('running', t)
}

/** 旧单的任务槽若指向这条会话，清掉（换单时防"一槽两单"）。 */
function clearTaskSlotIfPointingAt(taskId: string, agentId: string, sessionId: string): void {
  const cfg = getAgentConfig(agentId)
  if (cfg === undefined) return
  const key = taskSlotKey(taskId, agentId)
  if (cfg.sessions[key]?.sessionId !== sessionId) return
  clearSession(agentId, key)
}

function notBoundError(): Error {
  return new Error('agent-bot: 尚未绑定任务。先 open_task 新建/捡起一份，或等入站自动绑定后再操作。')
}

export interface BoardTools {
  dispose(): void
}

/**
 * 在 agent 会话的 scoped ctx 上注册 6 个看板工具。
 * deps 由 service 提供（identity 来自 runtime.identityFor；ensureAgent/agents 来自 runtime）。
 */
export function registerBoardTools(ctx: {
  get(name: string): unknown
  effect(fn: () => () => void): unknown
}, deps: BoardToolDeps): BoardTools {
  const tools = ctx.get('tools') as { register(def: unknown): () => void } | undefined
  if (tools === undefined) {
    throw new Error('agent-bot: 会话上下文没有 tools 服务，无法注册看板工具')
  }
  const relay = buildRelay({
    ensureAgent: deps.ensureAgent,
    agents: deps.agents,
  })
  const disposeFns: Array<() => void> = []

  const caller = (sessionId: string | undefined): { agentId: string; agentName: string; sessionId: string } => {
    if (sessionId === undefined || sessionId === '') throw new Error('agent-bot: 工具调用缺少调用方会话')
    const ident = deps.agentIdentity(sessionId)
    if (ident === undefined) throw new Error(`agent-bot: 无法解析调用方会话 ${sessionId} 的 agent 身份`)
    return { ...ident, sessionId }
  }

  const bound = (sessionId: string | undefined): { task: TaskBoard; agentId: string; agentName: string } => {
    const who = caller(sessionId)
    const got = getBoundTask(who.sessionId)
    if (got === undefined) throw notBoundError()
    return { task: got.task, agentId: who.agentId, agentName: who.agentName }
  }

  disposeFns.push(
    tools.register(
      defineTool({
        name: 'list_group_experts',
        description: '列出本群专家的能力卡片与此刻运行中的专家。无参数。',
        parameters: {},
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
          render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        async execute(_args, exec) {
          const who = caller(exec.agent?.id)
          const useHub = loadConfig().use_hub_experts !== false
          let members: Array<{ agentId: string; name: string; description: string }>
          if (useHub) {
            members = hubMembers()
          } else {
            const got = getBoundTask(who.sessionId)
            if (got === undefined) {
              return { text: '未绑定任务，暂无本群专家清单' }
            }
            members = got.task.groupSnapshot
          }
          // 两种来源都不含调用方自己（派活给自己无意义）
          members = members.filter((m) => m.agentId !== who.agentId)
          const cards = buildExpertCards(members)
          const runningIds = runningExpertIds(members)
          const lines: string[] = []
          for (const c of cards) {
            const parts = [`- ${c.name} (${c.agentId})`]
            if (c.description) parts.push(c.description)
            if (c.needs_target_workspace) {
              parts.push('需要目标项目目录')
              const ws = c.workspaceCandidates?.map((w) => `${w.name}=${w.workspace}`).join('; ')
              if (ws) parts.push(`候选: ${ws}`)
            }
            if (c.skills && c.skills.length > 0) {
              parts.push(`技能: ${c.skills.map((s) => `${s.name}${s.description ? `(${s.description})` : ''}`).join(', ')}`)
            }
            if (runningIds.includes(c.agentId)) parts.push('(运行中)')
            lines.push(parts.join('；'))
          }
          return { text: lines.join('\n') || (useHub ? '（中枢没有其它 agent，自己答）' : '（群快照为空，自己答）') }
        },
      }),
    ),
  )

  disposeFns.push(
    tools.register(
      defineTool({
        name: 'list_tasks',
        description: '列出本群 running/ 全部任务的短摘要。无参数。',
        parameters: {},
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
          render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        async execute(_args, exec) {
          const who = caller(exec.agent?.id)
          const mine = myRunningTasks(who.sessionId, deps.conversationKeyFor)
          if (mine === undefined) return { text: '（无法确定本群，暂不列任务；先 open_task 或等入站）' }
          const running = describeTasks(mine)
          if (running.length === 0) return { text: '（本群暂无 running 任务）' }
          const lines = running.map((r) => `- ${String(r.taskId)}: sender=${String(r.sender)} access=${String(r.access)} 摘要=${String(r.summary ?? '')}`)
          return { text: lines.join('\n') }
        },
      }),
    ),
  )

  disposeFns.push(
    tools.register(
      defineTool({
        name: 'open_task',
        description: '打开一份任务：有 taskId 则绑定那份（必须是本群 running）；无则新建并绑定（本 agent 成为 taskLead）。已绑着别的单又想开新单时传 new=true。',
        parameters: {
          taskId: { type: 'string', description: '要绑定的任务 id（task_xxx）。缺省新建。' },
          new: { type: 'boolean', description: 'true = 强制新建一单（即使本会话已绑着别的 running 单）' },
          access: { type: 'string', description: '新建时的访问级别：read 或 write（缺省 write）' },
          target: { type: 'string', description: '新建时的目标目录（绝对路径；write 产出写这里）' },
        },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { taskId: { type: 'string', required: true }, text: { type: 'string', required: true } } },
          render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        async execute(args, exec) {
          const who = caller(exec.agent?.id)
          if (args.taskId !== undefined) {
            if (!isTaskId(args.taskId)) throw new Error(`agent-bot: 非法 taskId ${args.taskId}`)
            const task = readTask('running', args.taskId)
            if (task === undefined) throw new Error(`agent-bot: 任务 ${args.taskId} 不在 running/`)
            // 改认另一单：允许切换（路由判偏不该锁死 LLM 的最终决定权）。
            // 但要防「一槽两单」：旧单的任务槽若指向本会话，先清掉它，
            // 否则旧单的入站/叫醒还会进这条会话，而 binding 只认新单 → 串单。
            const existing = boundTaskId(who.sessionId)
            if (existing !== undefined && existing !== args.taskId) {
              clearTaskSlotIfPointingAt(existing, who.agentId, who.sessionId)
              clearLeadSessionIfPointingAt(existing, who.sessionId)
            }
            bindSession(who.sessionId, args.taskId)
            // 这一轮用的会话就是「本 agent 在该单的任务槽」：后续入站/叫醒都命中同一条，
            // 记忆连续，也不会与后续消息并发改同一份 md（specs/12 §会话分层与入站路由）
            touchSession(who.agentId, taskSlotKey(args.taskId, who.agentId), who.sessionId, Date.now(), '')
            // md 里也留一份兜底（槽丢了还能把 lead 叫醒）
            if (task.leadSessionId !== who.sessionId) {
              task.leadSessionId = who.sessionId
              writeTask('running', task)
            }
            return { taskId: args.taskId, text: `已绑定任务 ${args.taskId}（taskLead=${task.taskLead}）` }
          }
          // 新建：谁 open 谁是 taskLead（只在这个 agent 自己的上下文）
          const existing = boundTaskId(who.sessionId)
          if (existing !== undefined && args.new !== true) {
            const task = readTask('running', existing)
            if (task !== undefined) return { taskId: existing, text: `已绑定任务 ${existing}，无需新建` }
            bindIfAbsent(who.sessionId, existing)
          }
          const inbound = inboundFor(who.sessionId)
          if (inbound === undefined) {
            throw new Error('agent-bot: 新建任务只在入站回合可用（缺 sender / providerId / 群快照）；中继回合请带 taskId 捡起已存在的任务')
          }
          const access = args.access === undefined ? 'write' : args.access
          if (access !== 'read' && access !== 'write') throw new Error('agent-bot: access 只能是 read 或 write')
          const rawTarget = args.target === undefined ? '' : expandHomePath(args.target.trim())
          if (rawTarget !== '' && !rawTarget.startsWith('/')) throw new Error('agent-bot: target 必须是绝对路径')
          const task = createTask({
            taskLead: who.agentId,
            leadName: who.agentName,
            leadSessionId: who.sessionId,
            sender: inbound.sender,
            providerId: inbound.providerId,
            sessionParts: inbound.sessionParts,
            originContext: inbound.originContext,
            access,
            target: rawTarget === '' ? undefined : rawTarget,
            groupSnapshot: inbound.groupSnapshot,
          })
          bindSession(who.sessionId, task.taskId)
          touchSession(who.agentId, taskSlotKey(task.taskId, who.agentId), who.sessionId, Date.now(), '')
          return {
            taskId: task.taskId,
            text: `已新建任务 ${task.taskId}（taskLead=${who.agentName}，access=${task.access}）\n文件：${taskFilePath('running', task.taskId)}\n接下来可按 list_group_experts 的卡片 dispatch_expert，或直接自己做。`,
          }
        },
      }),
    ),
  )

  disposeFns.push(
    tools.register(
      defineTool({
        name: 'update_task',
        description: '更新本轮已绑定任务的正文或允许字段（markdown / access / target / summary / clear_pending）。改不了 taskLead / sender。',
        parameters: {
          markdown: { type: 'string', description: '新的正文（替换 md 正文）' },
          access: { type: 'string', description: '任务访问级别：read 或 write' },
          target: { type: 'string', description: 'write 时的目标目录（绝对路径）' },
          summary: { type: 'string', description: '追加一行进展摘要到正文末尾' },
          clear_pending: { type: 'boolean', description: '清掉待决标记（拍板/回填后调用，否则任务会一直停在待决）' },
        },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
          render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        async execute(args, exec) {
          const { task } = bound(exec.agent?.id)
          if (args.markdown !== undefined) task.body = args.markdown
          if (args.access !== undefined) {
            if (args.access !== 'read' && args.access !== 'write') throw new Error('agent-bot: access 只能是 read 或 write')
            task.access = args.access
          }
          if (args.target !== undefined) {
            const expanded = expandHomePath(args.target.trim())
            if (expanded !== '' && !expanded.startsWith('/')) throw new Error('agent-bot: target 必须是绝对路径')
            task.target = expanded === '' ? undefined : expanded
          }
          if (args.summary !== undefined && args.summary.trim() !== '') {
            task.body = `${task.body}\n\n- ${args.summary.trim()}`
          }
          const cleared = args.clear_pending === true && task.pendingHuman !== undefined
          if (cleared) task.pendingHuman = undefined
          writeTask('running', task)
          return { text: `已更新任务 ${task.taskId}${cleared ? '（已清待决）' : ''}` }
        },
      }),
    ),
  )

  disposeFns.push(
    tools.register(
      defineTool({
        name: 'dispatch_expert',
        description:
          '派活给本群另一位专家（本任务快照内）。access 必填。返回 { kind: "running", sessionId }，不等对方跑完。目标不能是自己。',
        parameters: {
          expert_id: { type: 'string', required: true, description: '目标专家 agentId（见 list_group_experts）' },
          instruction: { type: 'string', required: true, description: '给专家的指令' },
          access: { type: 'string', required: true, description: 'read 或 write' },
          session: { type: 'string', description: 'reuse（默认）或 new' },
          title: { type: 'string', description: '可选会话标题' },
          target_workspace: { type: 'string', description: 'needs_target_workspace 专家必填：目标项目绝对路径' },
          wake: { type: 'boolean', description: '默认 true；false 则只落 assignees 不立刻叫醒' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true },
              sessionId: { type: 'string', required: true },
              text: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        async execute(args, exec) {
          const { task, agentId, agentName } = bound(exec.agent?.id)
          if (args.expert_id === agentId) throw new Error('agent-bot: 不能派活给自己')
          if (args.access !== 'read' && args.access !== 'write') throw new Error('agent-bot: access 只能是 read 或 write')
          const expertCfg = getAgentConfig(args.expert_id)
          if (expertCfg === undefined) throw new Error(`agent-bot: 未知 agent ${args.expert_id}`)
          const useHub = loadConfig().use_hub_experts !== false
          let expertName: string
          if (useHub) {
            expertName = expertCfg.name
          } else {
            const snapshot = task.groupSnapshot.find((m) => m.agentId === args.expert_id)
            if (snapshot === undefined) {
              throw new Error(`agent-bot: 专家 ${args.expert_id} 不在本任务快照内（见 list_group_experts）`)
            }
            expertName = snapshot.name
          }
          const target = resolveTargetWorkspace(expertCfg, args.target_workspace)
          if (!target.ok) throw new Error(`agent-bot: ${target.reason}`)

          // write 串行域 = **目标目录**（同一 target 的 write 一律串行；read 并行；不同 target 并行）
          const assigneeTarget = target.path !== '' ? target.path : task.target
          const fenceDir = resolveFenceDir(assigneeTarget, task.target, expertCfg.workspace)
          const mustQueue = args.access === 'write' && relay.writeFence.occupied(fenceDir)
          // 重复派发同 expert 同 target：占着仍可派（spec：不拒，FIFO）
          const status: AssigneeStatus = mustQueue ? 'waiting' : 'running'
          const sessionId = relay.resolveSession(expertCfg, task.taskId, args.expert_id, args.session === 'new' ? 'new' : 'reuse', Date.now())
          if (mustQueue) {
            upsertAssignee(task, {
              agentId: args.expert_id,
              name: expertName,
              sessionId,
              dispatchedBy: agentId,
              dispatchedByName: agentName,
              access: args.access,
              target: assigneeTarget,
              status,
              instruction: args.instruction,
            }, false)
            writeTask('running', task)
            return {
              kind: 'waiting',
              sessionId,
              text: `目标目录 ${assigneeTarget ?? '(专家 cwd)'} 上已有 write 在跑，已把 ${expertName} 排进队列（status=waiting），轮到会立刻叫醒它`,
            }
          }
          if (args.access === 'write') relay.writeFence.begin(fenceDir, sessionId)
          upsertAssignee(task, {
            agentId: args.expert_id,
            name: expertName,
            sessionId,
            dispatchedBy: agentId,
            dispatchedByName: agentName,
            access: args.access,
            target: assigneeTarget,
            status,
            instruction: args.instruction,
          }, args.wake !== false)
          // 中间层（B 派 C）：B 自己暂停等下游，等 C 那几路终态后由上报链叫醒它接着做
          const paused = pauseSelfIfIntermediate(task, agentId, relay)
          writeTask('running', task)

          if (args.wake === false) {
            return {
              kind: 'waiting',
              sessionId,
              text: `已把 ${expertName} 记为待命（wake=false），未叫醒${paused ? '；你已记为等下游，等它做完再继续' : ''}`,
            }
          }
          const mdText = marshalText(task)
          await relay.startTurn({
            agent: expertCfg,
            taskId: task.taskId,
            expertId: args.expert_id,
            instruction: args.instruction,
            mdText,
            access: args.access,
            session: args.session === 'new' ? 'new' : 'reuse',
            nowMs: Date.now(),
            variables: { sender: task.sender, provider_id: task.providerId },
            promptText: '',
            permissionMode: expertCfg.permission_mode,
            targetWorkspace: target.path !== '' ? target.path : undefined,
          })
          return {
            kind: 'running',
            sessionId,
            text: `已派给 ${expertName}，正在处理${paused ? `；你已记为等下游（waiting），等 ${expertName} 做完会再叫醒你继续` : ''}`,
          }
        },
      }),
    ),
  )

  disposeFns.push(
    tools.register(
      defineTool({
        name: 'ask_human',
        description: '把问题上抛给**人**（原发送者）：写入待决并群里发问卷 @sender，墙钟顺延等人回答。仅 taskLead 可用。',
        parameters: {
          questions: { type: 'array', description: '要问人的问题（1 条以上）' },
        },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
          render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        async execute(args, exec) {
          const { task, agentId } = bound(exec.agent?.id)
          if (agentId !== task.taskLead) {
            throw new Error('agent-bot: ask_human 仅 taskLead 可用；被派专家请用 ask_task_lead 上抛给 lead')
          }
          const questions = (args.questions ?? [])
            .filter((q): q is string => typeof q === 'string')
            .map((q) => q.trim())
            .filter((q) => q !== '')
          if (questions.length === 0) throw new Error('agent-bot: ask_human 需要至少一条问题')
          task.pendingHuman = { questions, askedBy: agentId, askedAt: Date.now(), toHuman: true }
          writeTask('running', task)
          return { text: `已把 ${questions.length} 条问题发给原发送者（待决挂在这一单上，墙钟已顺延等人回答）` }
        },
      }),
    ),
  )

  disposeFns.push(
    tools.register(
      defineTool({
        name: 'ask_task_lead',
        description: '把问题上抛给本任务的任务 lead。仅当本 agent 不是 taskLead 时可用。taskLead 自己调会报错（应走 ask_user_question）。',
        parameters: {
          questions: {
            type: 'array',
            items: { type: 'string' },
            required: true,
            description: '要问的问题列表',
          },
        },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
          render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        async execute(args, exec) {
          const { task, agentId } = bound(exec.agent?.id)
          if (agentId === task.taskLead) {
            throw new Error('agent-bot: 你是任务 lead，应走 ask_user_question 直接问人')
          }
          const questions = (args.questions ?? []).map((q) => String(q).trim()).filter((q) => q !== '')
          if (questions.length === 0) throw new Error('agent-bot: questions 不能为空')
          task.pendingHuman = { questions, askedBy: agentId, askedAt: Date.now() }
          writeTask('running', task)
          // 叫醒任务 lead：任务 lead 的通道 session 由入站 FIFO 管；这里记 wake，交给巡检器
          return { text: `已把问题记入任务 ${task.taskId}，等待任务 lead 处理` }
        },
      }),
    ),
  )

  return {
    dispose() {
      for (const fn of disposeFns) {
        try {
          fn()
        } catch {
          // 注册失效不阻断其余清理
        }
      }
    },
  }
}

/** 把 TaskBoard 渲染成 md 文本（frontmatter + 正文），供 followup 注入。 */
export function marshalText(task: TaskBoard): string {
  return marshalTaskYaml(task, task.body)
}