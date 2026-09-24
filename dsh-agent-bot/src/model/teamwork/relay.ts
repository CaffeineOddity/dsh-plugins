/**
 * 中继驱动（specs/12 §中继驱动）。
 * 区别于通道 `ask`：不走 prepareAsk / 通道 sessionKey / 通道 pending。
 * 复用 createAgentRuntime.ensureAgent + followup。
 *
 * 职责：
 *  - 协作会话槽 `task:{taskId}:{expertId}`（与通道 encodeSessionKey 隔离）。
 *  - 启动一次专家 turn：解析槽 → ensureAgent → followup(包装指令 + md 全文)。
 *  - read 并行、write 同 target FIFO（进程内栅栏；跨进程序列不在本项目处理）。
 *
 * 读写 md（assignees[] 落槽）交 board-tools / patrol，本模块只负责「拉起并叫醒」。
 */
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentConfig } from '../config.js'
import { touchSession } from '../agents.js'
import type { EnsureAgentInput, AgentLike } from '../runtime.js'
import { bindSession } from './binding.js'
import { taskFilePath } from './task-board.js'

export const COLLAB_SESSION_PREFIX = 'task:'

/** 协作槽 key。`task:{taskId}:{expertId}`，禁止撞通道 encodeSessionKey。 */
export function taskSlotKey(taskId: string, expertId: string): string {
  return `task:${taskId}:${expertId}`
}

export function isCollabSessionKey(key: string): boolean {
  return key.startsWith(COLLAB_SESSION_PREFIX)
}

/**
 * 解析协作槽 session：`session=reuse` 槽在则续、否则新 uuid；`session=new` 直接新 uuid。
 * 一律写回该专家 agents[].sessions[task:...]（可带 title 由调用方另改会话标题）。
 */
export function resolveCollabSlotSession(
  agent: AgentConfig,
  taskId: string,
  expertId: string,
  session: 'reuse' | 'new',
  nowMs: number,
): string {
  const key = taskSlotKey(taskId, expertId)
  if (session === 'reuse') {
    const existing = agent.sessions[key]?.sessionId
    if (existing !== undefined && existing !== '') return existing
  }
  const sessionId = randomUUID()
  touchSession(agent.id, key, sessionId, nowMs, '')
  return sessionId
}

/**
 * write 串行的目标目录：`target_workspace ?? 任务 target ?? 该专家 cwd`。
 * 取到时做**归一化**（展开 `~`、去尾斜杠、解软链），避免同一目录的不同写法绕过锁。
 */
export function resolveFenceDir(targetWorkspace?: string, taskTarget?: string, expertWorkspace?: string): string {
  const raw = targetWorkspace ?? taskTarget ?? expertWorkspace ?? ''
  return normalizeDir(raw)
}

/** 归一化目录：展开 `~`、去尾斜杠、尽量解软链（解不开就用原路径）。 */
export function normalizeDir(raw: string): string {
  let p = raw.trim()
  if (p === '') return ''
  if (p === '~') p = homedir()
  else if (p.startsWith('~/')) p = join(homedir(), p.slice(2))
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/**
 * 两个目标目录是否算"同一处"：相等，或**互为祖先**（`/proj` 与 `/proj/design`）。
 * 祖先也算冲突：往 `/proj` 写完全可能覆盖 `/proj/design` 里的文件。
 */
export function dirsConflict(a: string, b: string): boolean {
  if (a === '' || b === '') return a === b // 空（无目录信息）只与空冲突
  if (a === b) return true
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

/**
 * 进程内 write 串行栅栏（按目标目录，read 不占）。
 * 真实并发只有本进程驱动，进程内判定足够；重启后栅栏清空，占位会话以 `agents.get(sessionId)` 判活性。
 * 注意：**必须进程级共享**（见 `getWriteFence`）——`buildRelay` 是每个 agent 会话各建一份的。
 */
export interface WriteFence {
  begin(dir: string, sessionId: string): void
  /** 是否有**活的**会话正占着与该目录冲突（相等或祖先）的位置。 */
  occupied(dir: string): boolean
  release(dir: string, sessionId: string): void
}

export function createWriteFence(agents: () => { get(sessionId: string): unknown } | undefined): WriteFence {
  const holders = new Map<string, { dir: string; sessionId: string }>()
  const alive = (sessionId: string): boolean => agents()?.get(sessionId) !== undefined
  /** 清掉已经不在线的占位（进程重启 / 会话销毁后自动让位）。 */
  const reap = (): void => {
    for (const [k, v] of holders) if (!alive(v.sessionId)) holders.delete(k)
  }
  return {
    begin(dir, sessionId) {
      holders.set(`${dir}\0${sessionId}`, { dir, sessionId })
    },
    occupied(dir) {
      reap()
      for (const v of holders.values()) {
        if (dirsConflict(v.dir, dir)) return true
      }
      return false
    },
    release(dir, sessionId) {
      holders.delete(`${dir}\0${sessionId}`)
    },
  }
}

/**
 * 进程级共享的 write 栅栏。
 * 必须共享：`buildRelay` 是**每个 agent 会话**各建一份的，若栅栏跟着会话建，
 * 同一目标目录的两个专家会各拿一把锁 → 串行失效。
 */
let sharedFence: WriteFence | null = null
let sharedAgents: (() => { get(sessionId: string): unknown } | undefined) | null = null

/** 测试用：丢掉共享栅栏（进程级单例，测试之间要隔离）。 */
export function resetWriteFence(): void {
  sharedFence = null
  sharedAgents = null
}

export function getWriteFence(agents: () => { get(sessionId: string): unknown } | undefined): WriteFence {
  if (sharedFence === null) {
    sharedAgents = agents
    sharedFence = createWriteFence(() => sharedAgents?.())
  }
  return sharedFence
}

/** 中继所需宿主（只读面向运行时的最小面）。 */
export interface RelayHost {
  ensureAgent(input: EnsureAgentInput): Promise<AgentLike>
  agents(): { get(sessionId: string): unknown } | undefined
}

export interface Relay {
  /** 解析该专家在这份任务下应使用的真实 sessionId（槽或新 uuid），并落槽。 */
  resolveSession(agent: AgentConfig, taskId: string, expertId: string, session: 'reuse' | 'new', nowMs: number): string
  /**
   * 启动一次专家 turn：resolveSession → ensureAgent → followup(包装文本)。
   * 返回实际使用的 { sessionId, kind: 'running' }。不等待 idle。
   */
  startTurn(input: {
    agent: AgentConfig
    taskId: string
    expertId: string
    instruction: string
    mdText: string
    access: 'read' | 'write'
    session: 'reuse' | 'new'
    nowMs: number
    variables: Record<string, string>
    promptText: string
    permissionMode: AgentConfig['permission_mode']
    targetWorkspace?: string
  }): Promise<{ kind: 'running'; sessionId: string }>
  writeFence: WriteFence
}

/** 包装 followup：被派做共享任务板上的一单，不是对群友说话；注入 md 全文 + 文件绝对路径。 */
export function wrapDispatchFollowup(input: {
  instruction: string
  mdText: string
  access: 'read' | 'write'
  targetWorkspace?: string
  /** 任务文件绝对路径（专家可随时自己重读最新版本）。 */
  taskPath?: string
}): string {
  const lines: string[] = [
    '你是被派做共享任务板上的一单，不是在对群友说话；本任务 access 见 md。',
    '缺信息时：你不是任务 lead 就调 ask_task_lead 把问题上抛，或把问题写进结果摘要后收口；不要在正文里只提问。',
    '做完把进展写回 md（update_task）后收口。',
  ]
  if (input.taskPath !== undefined && input.taskPath !== '') {
    lines.push(`任务文件（可随时重读最新版本）：${input.taskPath}`)
  }
  if (input.access === 'write' && input.targetWorkspace !== undefined && input.targetWorkspace !== '') {
    lines.push(`产出写到目标目录 ${input.targetWorkspace}，不要写到自己的 cwd。`)
  }
  lines.push('本次指令：', input.instruction, '')
  lines.push('——以下为任务文件全文——')
  lines.push(input.mdText)
  return lines.join('\n')
}

/**
 * 启动一个专家 turn 并写入协作槽。重复启动同 (taskId, expertId) 幂等换 sessionId。
 */
export function buildRelay(host: RelayHost): Relay {
  const writeFence = getWriteFence(host.agents)
  return {
    resolveSession(agent, taskId, expertId, session, nowMs) {
      return resolveCollabSlotSession(agent, taskId, expertId, session, nowMs)
    },
    async startTurn(input) {
      const sessionId = this.resolveSession(input.agent, input.taskId, input.expertId, input.session, input.nowMs)
      // fiber 绑定：被派专家一进来就已经在做这一单，不必自己填 taskId（specs/12 §中继驱动）。
      bindSession(sessionId, input.taskId)
      const followupText = wrapDispatchFollowup({
        instruction: input.instruction,
        mdText: input.mdText,
        access: input.access,
        targetWorkspace: input.targetWorkspace,
        taskPath: taskFilePath('running', input.taskId),
      })
      const ensureInput: EnsureAgentInput = {
        sessionId,
        cwd: input.agent.workspace, // 专家 cwd = 自己的 workspace，永不改目标项目
        agentId: input.agent.id,
        agentName: input.agent.name,
        promptText: input.promptText,
        variables: {
          sender: input.variables.sender ?? '',
          session_key: taskSlotKey(input.taskId, input.expertId),
          provider_id: input.variables.provider_id ?? '',
          target_workspace: input.targetWorkspace ?? '',
          ...input.variables,
        },
        permissionMode: input.permissionMode,
      }
      await host.ensureAgent(ensureInput)
      const agent = host.agents()?.get(sessionId) as AgentLike | undefined
      if (agent === undefined) throw new Error(`agent-bot: 启动专家 ${input.expertId} 后未拿到 live agent`)
      agent.followup({
        id: `agent-bot-${Date.now()}`,
        role: 'user',
        content: [{ type: 'text', text: followupText }],
        source: { kind: 'user' },
      })
      return { kind: 'running', sessionId }
    },
    writeFence,
  }
}