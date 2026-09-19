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
import { assemblePromptText, appendPromptToUserContext, getPrompt, promptFingerprintFor, promptVariableNames, skillToolNamesForAgent } from '../model/prompts.js'
import { createAskQueue, enqueueHoldPending } from '../model/queue.js'
import { createAgentRuntime, type HostServices } from '../model/runtime.js'
import type {
  AgentAskRequest,
  AgentAskResponse,
  AgentBotService,
  AgentChannelProviderInfo,
  AgentChannelProviderRegistration,
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

/** 内置本地 Provider：无 IM 通道时本地对话页与 ask 仍可用，红点不空。固定，不可被 registerProvider 覆盖。 */
export const LOCAL_PROVIDER: AgentChannelProviderInfo = { id: 'local', label: '本地' }

/** 创建 agentBot 服务。host 由组合根注入；测试可传假服务。 */
export function createAgentBotService(host: HostServices): AgentBotHostService {
  const providers = new Map<string, { label: string; token: symbol }>()
  // 预置内置 local provider：不走 registerProvider（无 disposer、固定）。
  providers.set(LOCAL_PROVIDER.id, { label: LOCAL_PROVIDER.label, token: Symbol('agent-bot:builtin-local') })
  const queue = createAskQueue()
  const runtime = createAgentRuntime(host)
  return {
    listAgents() {
      return listAgentConfigs().map(toSummary)
    },
    getAgent(id: string) {
      const found = getAgentConfig(id)
      if (found === undefined) return undefined
      return toSummary(found)
    },
    listProviders() {
      const out: AgentChannelProviderInfo[] = []
      for (const [id, { label }] of providers) out.push({ id, label })
      return out
    },
    registerProvider(reg: AgentChannelProviderRegistration) {
      if (!reg.id) throw new Error('agent-bot: registerProvider 需要非空 id')
      if (providers.has(reg.id)) {
        console.warn(`agent-bot: provider ${reg.id} 重复注册，后写覆盖`)
      }
      const token = Symbol('agent-bot:provider-generation')
      providers.set(reg.id, { label: reg.label || reg.id, token })
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
        const agent = await runtime.ensureAgent({
          sessionId: decision.sessionId,
          cwd: live.workspace,
          agentName: live.name,
          promptText: live.prompt_placement === 'user' ? '' : promptText,
          variables: values,
          permissionMode: live.permission_mode,
        })
        const followupContext =
          live.prompt_placement === 'user'
            ? appendPromptToUserContext(req.context, promptText, values)
            : req.context
        const result = await settleAskRound(agent, followupContext, loadConfig().agent_wait_timeout_ms)
        touchSession(
          live.id,
          current.sessionKey,
          decision.sessionId,
          Date.now(),
          promptFingerprintFor(live.prompt, live.prompt_placement, live.skill_groups, live.prompt_append_skills),
        )
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
      await runtime.disposeAll()
    },
  }
}
