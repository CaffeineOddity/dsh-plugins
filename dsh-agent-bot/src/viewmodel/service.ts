/**
 * provide('agentBot') 门面。
 * G1–G7：list / get / provider / 校验 / sessionKey / 队列。
 * G8：队列内 planSession + ensureAgent。
 * G9：followup 超时从实际开始起算。
 * G10：idle 收口成单条 markdown。
 * G11：超时未 idle 时 pending 二次竞速，安全阀到点 reject。
 * G12：本轮收口写 lastAskAt 并落盘。
 * G13：unload 时 dispose 全部 live handle。
 */
import { randomUUID } from 'node:crypto'
import { planSession, prepareAsk, settleAskRound } from '../model/ask.js'
import { getAgent as getAgentConfig, listAgents as listAgentConfigs, touchSession } from '../model/agents.js'
import { loadConfig } from '../model/config.js'
import { appendLog } from './rpc.js'
import { assemblePromptText, appendPromptToUserContext, getPrompt, promptFingerprintFor, promptVariableNames, skillToolNamesForAgent } from '../model/prompts.js'
import { createAskQueue, enqueueHoldPending } from '../model/queue.js'
import { createAgentRuntime, type HostServices } from '../model/runtime.js'
import type { AgentConfig } from '../model/config.js'
import { registerBoardTools } from '../model/teamwork/board-tools.js'
import { createPatrol } from '../model/teamwork/patrol.js'
import { describeTasks, listTasksIn, type GroupMember } from '../model/teamwork/task-board.js'
import { rememberInbound } from '../model/teamwork/inbound.js'
import type {
  AgentAskRequest,
  AgentAskResponse,
  AgentBotService,
  AgentChannelProviderInfo,
  AgentChannelProviderRegistration,
  AgentDeliverRequest,
  AgentOutboundMessage,
  AgentSummary,
} from '../types.js'

function toSummary(agent: { id: string; name: string; slug?: string; description: string; workspace: string }): AgentSummary {
  return {
    id: agent.id,
    name: agent.name,
    slug: agent.slug,
    description: agent.description,
    workspace: agent.workspace,
  }
}

/** 空宿主：未注入 DSH 服务时 ensureAgent 显式抛「agents 服务不可用」。 */
export function emptyHostServices(): HostServices {
  return {
    agents: () => undefined,
    agentDefaultModel: () => undefined,
    agentPresets: () => undefined,
    sessionPersistence: () => undefined,
    sessions: () => undefined,
    workspaceRegistry: () => undefined,
    toolsMount: () => undefined,
  }
}

/** 从 Cordis ctx duck-type 取出宿主服务。 */
export function hostServicesFromContext(ctx: { get(name: string): unknown }): HostServices {
  return {
    agents: () => ctx.get('agents') as ReturnType<HostServices['agents']>,
    agentDefaultModel: () => ctx.get('agentDefaultModel') as ReturnType<HostServices['agentDefaultModel']>,
    agentPresets: () => ctx.get('agentPresets') as ReturnType<HostServices['agentPresets']>,
    sessionPersistence: () => ctx.get('sessionPersistence') as ReturnType<HostServices['sessionPersistence']>,
    sessions: () => ctx.get('sessions') as ReturnType<HostServices['sessions']>,
    workspaceRegistry: () => ctx.get('workspaceRegistry') as ReturnType<HostServices['workspaceRegistry']>,
    toolsMount: () => undefined,
  }
}

function promptTextFor(
  agentId: string,
  promptName: string,
  skillGroupIds: readonly string[],
  appendSkills: boolean,
): string {
  if (promptName.trim() === '') return ''
  const preset = getPrompt(promptName)
  if (preset === undefined) throw new Error(`agent-bot: agent ${agentId} 引用了未知预设 ${promptName}`)
  const tools = appendSkills ? skillToolNamesForAgent(skillGroupIds) : []
  return assemblePromptText(preset, tools)
}

function variableValues(req: AgentAskRequest, sessionKey: string): Record<string, string> {
  promptVariableNames(req.meta.sessionParts)
  const values: Record<string, string> = {
    sender: req.meta.sender,
    session_key: sessionKey,
    provider_id: req.meta.providerId,
  }
  for (const [key, value] of Object.entries(req.meta.sessionParts)) {
    values[key] = value
  }
  return values
}

/** 门面 + unload 时 dispose live handle。dispose 不进通道契约。 */
export type AgentBotHostService = AgentBotService & { dispose(): Promise<void> }

/** 从登记的 provider 查 listGroupAgents / deliver。 */
export const LOCAL_PROVIDER: AgentChannelProviderInfo = { id: 'local', label: '本地' }

/** 创建 agentBot 服务。host 由组合根注入；测试可传假服务。 */
/** 进程内已登记 Provider：公共字段 + 内部代令牌。 */
interface StoredProvider extends AgentChannelProviderInfo {
  token: symbol
}

export function createAgentBotService(host: HostServices): AgentBotHostService {
  /** 交互动兜底入口（ask 结束后调用，定义见下）。 */
  let service_notifyIdle: (sessionId: string) => void = () => undefined
  const providers = new Map<string, StoredProvider>()
  // 预置内置 local provider：不走 registerProvider（无 disposer、固定）。
  providers.set(LOCAL_PROVIDER.id, { ...LOCAL_PROVIDER, token: Symbol('agent-bot:builtin-local') })
  const queue = createAskQueue()

  /** 入站绑定点：包入站 running 摘要；群快照由组员发现函数单独登记（见 rememberInbound）。 */
  function boardContextFor(live: AgentConfig): { text: string; variables: Record<string, string> } {
    // 卡片按需由 list_group_experts 取（hub 模式可能很多，不塞进 prompt）；这里只带 running 摘要。
    const running = describeTasks(listTasksIn('running'))
    const lines: string[] = ['——本群任务板（specs/12）——']
    if (running.length === 0) {
      lines.push('（本群暂无 running 任务；你可以 open_task 新建一份，或直接自己做）')
    } else {
      for (const r of running) {
        const ph = r.pendingHuman as undefined | { questions?: string[] }
        const pending = ph === undefined ? '' : ` 待决:${String(ph.questions?.join('; ') ?? '')}`
        lines.push(`- ${String(r.taskId)}: lead=${String(r.taskLead)} sender=${String(r.sender)} access=${String(r.access)} 摘要=${String(r.summary ?? '')}${pending}`)
      }
    }
    void live
    return { text: lines.join('\n'), variables: {} }
  }

  /**
   * 本轮群成员快照（供 open_task 新建时写进任务文件）。
   * 开关 `use_hub_experts=true`（默认）：中枢全集；否则问本通道 `listGroupAgents`。
   * 两种都按 agents.json 过滤幽灵成员、去掉调用方自己（specs/12 §专家清单来源）。
   */
  function groupSnapshotFor(providerId: string, sessionParts: Record<string, string>, selfAgentId: string): GroupMember[] {
    const cfgMap = new Map(listAgentConfigs().map((a) => [a.id, a]))
    if (loadConfig().use_hub_experts !== false) {
      return listAgentConfigs()
        .filter((a) => a.id !== selfAgentId)
        .map((a) => ({ agentId: a.id, name: a.name, description: a.description }))
    }
    const provider = providers.get(providerId)
    const listed = provider?.listGroupAgents?.(sessionParts) ?? []
    const out: GroupMember[] = []
    for (const m of listed) {
      if (m.agentId === '' || m.agentId === selfAgentId) continue
      const cfg = cfgMap.get(m.agentId)
      if (cfg === undefined) continue // 不在 agents.json：幽灵成员，丢掉
      out.push({ agentId: m.agentId, name: cfg.name, description: cfg.description })
    }
    return out
  }

  // 看板工具挂载：每个 agent 会话 setup 时 scoped 注册。identity 从运行时会话映射解析。
  const hostWithMount: HostServices = {
    ...host,
    toolsMount: () => (sessionId, agentId, agentName, agentCtx) => {
      registerBoardTools(agentCtx, {
        agentIdentity: (sid) => runtime.identityFor(sid),
        ensureAgent: (input) => runtime.ensureAgent(input),
        agents: () => runtime.hostAgents(),
      })
      void agentId
      void agentName
      void sessionId
    },
  }
  const runtime = createAgentRuntime(hostWithMount)

  // 看板巡检器：扫描 running/ 收口叫醒/综合/超时。run() 常驻循环，service dispose 时 stop。
  const patrol = createPatrol(
    {
      ensureAgent: (input) => runtime.ensureAgent(input),
      agents: () => runtime.hostAgents(),
      deliver: (providerId, sessionParts, messages) => {
        const deliver = providerDeliver(providerId)
        if (deliver === undefined) {
          appendLog('deliver', `provider ${providerId} 未实现 deliver，收口只打日志: ${messages.map((m) => m.text).filter(Boolean).join(' ')}`)
          return Promise.resolve()
        }
        return deliver({ sessionParts, messages })
      },
    },
    {},
  )
  void patrol.start() // 启动补扫一次；之后完全由 agent/status / agent/disposed 事件驱动
  service_notifyIdle = (sessionId: string): void => {
    void patrol.reconcile(sessionId).catch(() => undefined)
  }


  /** 按 providerId 找通道的 deliver 能力（缺省打日志）。 */
  function providerDeliver(providerId: string): ((req: AgentDeliverRequest) => Promise<void>) | undefined {
    const info = providers.get(providerId)
    return info?.deliver
  }

  return {
    listAgents() {
      return listAgentConfigs().map(toSummary)
    },
    getAgent(id: string) {
      const found = getAgentConfig(id)
      if (found === undefined) return undefined
      return toSummary(found)
    },
    providerDeliver,
    notifyAgentDisposed(sessionId: string): void {
      void patrol.handleDisposed(sessionId).catch((err: unknown) => {
        appendLog('patrol', `会话销毁处理失败 sid=${sessionId}: ${err instanceof Error ? err.message : String(err)}`)
      })
    },
    notifyAgentIdle(sessionId: string): void {
      // 事件驱动快路径：不 await（事件是同步 emit，别拖慢派发链）
      void patrol.reconcile(sessionId).catch((err: unknown) => {
        appendLog('patrol', `事件复核失败 sid=${sessionId}: ${err instanceof Error ? err.message : String(err)}`)
      })
    },
    listProviders() {
      const out: AgentChannelProviderInfo[] = []
      for (const [id, info] of providers) out.push({ id, label: info.label, listGroupAgents: info.listGroupAgents, deliver: info.deliver })
      return out
    },
    registerProvider(reg: AgentChannelProviderRegistration) {
      if (!reg.id) throw new Error('agent-bot: registerProvider 需要非空 id')
      if (providers.has(reg.id)) {
        console.warn(`agent-bot: provider ${reg.id} 重复注册，后写覆盖`)
      }
      const token = Symbol('agent-bot:provider-generation')
      providers.set(reg.id, {
        id: reg.id,
        label: reg.label || reg.id,
        token,
        listGroupAgents: reg.listGroupAgents,
        deliver: reg.deliver,
      })
      return () => {
        const current = providers.get(reg.id)
        if (current !== undefined && current.token === token) providers.delete(reg.id)
      }
    },
    async ask(req: AgentAskRequest): Promise<AgentAskResponse> {
      const prepared = prepareAsk(req, new Set(providers.keys()))
      return enqueueHoldPending(queue, prepared.agent.id, prepared.sessionKey, prepared.agent.reuse_session, async () => {
        const live = getAgentConfig(prepared.agent.id)
        if (live === undefined) throw new Error(`agent-bot: 未知 agent ${prepared.agent.id}`)
        const current = { ...prepared, agent: live }
        const slot = live.sessions[current.sessionKey]
        const archived = slot === undefined ? false : runtime.isArchived(slot.sessionId)
        const decision = planSession(current, archived, Date.now(), randomUUID())
        const promptText = promptTextFor(live.id, live.prompt, live.skill_groups, live.prompt_append_skills)
        const values = variableValues(req, current.sessionKey)
        // 入站包装（specs/12 §入站怎么绑任务）：附本群 running 短摘要，让 LLM 认捡起/新建。
        const boardCtx = boardContextFor(live)
        // 入站上下文（specs/12 §入站怎么绑任务）：记下 sender/providerId/群快照，
        // 供本轮模型调 open_task 新建任务时取用（工具作用域里本来没有这些）。
        rememberInbound(decision.sessionId, {
          sender: req.meta.sender,
          providerId: req.meta.providerId,
          sessionParts: req.meta.sessionParts,
          originContext: req.context,
          groupSnapshot: groupSnapshotFor(req.meta.providerId, req.meta.sessionParts, live.id),
        })
        const promptTextForAgent = live.prompt_placement === 'user' ? '' : promptText
        const agent = await runtime.ensureAgent({
          sessionId: decision.sessionId,
          cwd: live.workspace,
          agentId: live.id,
          agentName: live.name,
          promptText: promptTextForAgent,
          variables: { ...values, ...boardCtx.variables },
          permissionMode: live.permission_mode,
        })
        const followupContext =
          live.prompt_placement === 'user'
            ? appendPromptToUserContext(req.context, promptText, values)
            : req.context
        const contextWithBoard = boardCtx.text === '' ? followupContext : `${followupContext}\n\n${boardCtx.text}`
        const result = await settleAskRound(agent, contextWithBoard, loadConfig().agent_wait_timeout_ms)
        touchSession(
          live.id,
          current.sessionKey,
          decision.sessionId,
          Date.now(),
          promptFingerprintFor(live.prompt, live.prompt_placement, live.skill_groups, live.prompt_append_skills),
        )
        // 交互兜底：只要还有人跟这单互动，漏掉的事件就能在这一刻补上（不再有周期巡检）
        service_notifyIdle(decision.sessionId)
        return result
      })
    },
    async localAsk(rawInput: string, sessionKey = 'local'): Promise<{ messages: AgentOutboundMessage[]; error?: string }> {
      // rawInput 第一 token = agent 标识（id 精确 / name 精确 / name 大小写不敏感），剩余 = 问题
      const trimmed = rawInput.trim()
      const sp = trimmed.indexOf(' ')
      const key = sp < 0 ? trimmed : trimmed.slice(0, sp)
      const question = sp < 0 ? '' : trimmed.slice(sp + 1).trim()
      if (key === '') return { messages: [], error: '请输入：/agent <名字或id> <问题>' }
      const agents = listAgentConfigs()
      const match =
        agents.find((a) => a.id === key) ??
        agents.find((a) => a.name === key) ??
        agents.find((a) => a.name.toLowerCase() === key.toLowerCase())
      if (match === undefined) return { messages: [], error: `找不到 agent：${key}` }
      if (question === '') return { messages: [], error: `请输入问题：/agent ${match.name} <问题>` }
      try {
        const result = await this.ask({
          agentId: match.id,
          context: '用户[local]: ' + question,
          meta: {
            traceId: randomUUID(),
            providerId: 'local',
            sessionParts: { session: sessionKey },
            sender: 'local',
          },
        })
        const all: AgentOutboundMessage[] = [...result.messages]
        if (result.pending !== null) all.push(...(await result.pending))
        return { messages: all }
      } catch (err) {
        return { messages: [], error: err instanceof Error ? err.message : String(err) }
      }
    },
    async dispose() {
      patrol.stop()
      await runtime.disposeAll()
    },
  }
}
