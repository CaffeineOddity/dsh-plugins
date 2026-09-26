/**
 * DSH 智能体中枢 -- Host 半体入口。
 * 组合根：provide / 路由 / effect。unload 时 dispose live handle。
 */
import '@deepseek-ai/dsh-host-webserver' // 激活 Context.webServer 类型扩展
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { watchConfig } from './model/config.js'
import { listAgents } from './model/agents.js'
import { appendLog, registerRpcRoute } from './viewmodel/rpc.js'
import { createAgentBotService, hostServicesFromContext } from './viewmodel/service.js'
import { registerConfigSite } from './view/config-site/serve.js'

export const name = 'agent-bot'

/**
 * DSH 的 agent 生命周期事件（`agent/status`）。本地声明，不 import `@deepseek-ai/dsh-agent`
 * ——该包在插件运行时不可解析（profile 由 tarball 安装）。事件服务是 cordis 根级单例，
 * 插件级 `ctx.on` 收得到全进程所有 agent 的状态迁移。
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    'agent/status'(payload: { agent: { id: string }; status: 'idle' | 'running' }): void
    'agent/disposed'(payload: { agent: { id: string } }): void
    /** 会话日志 post-commit 追加 feed（只用来观测审批审计事件）。 */
    'session/event'(session: { id: string }, event: { type: string; data?: unknown }): void
  }
}

export const inject = ['webServer', 'commands', 'tools']

export type { AgentAskMeta, AgentAskRequest, AgentAskResponse, AgentBotService, AgentOutboundMessage, AgentSummary } from './types.js'
import type { AgentBotService } from './types.js'
export { encodeSessionKey, sessionPartsForEncode } from './types.js'

export interface AgentBotConfig {
  /** 配置目录（env:AGENT_BOT_CONFIG_DIR 覆盖；缺省 ~/.dsh/storages/agentbot）。 */
  configDir?: string
}

/** commands 服务的最小类型（不强依赖 dsh-commands 包）。 */
interface CommandRuntime {
  register(def: {
    name: string
    description: string
    input?: { hint: string }
    handler: (inv: { agent: { id: string; followup(input: unknown): void }; rawInput: string; signal: AbortSignal }) => Promise<{ kind: 'success' | 'error'; text?: string }>
  }): () => void
}

/** tools 服务的最小类型（不强依赖 dsh-tools 包）。 */
interface ToolRuntime {
  register(def: unknown): () => void
}

/**
 * 注册 `agent_ask` 工具：当前会话的 agent 在对话流里调用它，把问题转交给
 * agent-bot 的 agent（设计师等），回复作为 tool result 返回。渲染顺序天然为
 * 用户消息 -> 工具调用入口 -> 工具结果 -> agent 复述，无命令卡片、无手动注入。
 */
function registerAgentAskTool(tools: ToolRuntime, service: AgentBotService): () => void {
  const dispose = tools.register(defineTool({
    name: 'agent_ask',
    description: '把一个问题转交给某个专业 agent（如设计师）处理，返回它的回复。当用户明确要求某个 agent 处理任务、或需要专业能力（设计、写作等）时调用。',
    parameters: {
      agent: {
        type: 'string',
        required: true,
        description: '目标 agent 的名字或 id（中文名可用），如「设计师」。',
      },
      question: {
        type: 'string',
        required: true,
        description: '要转交给该 agent 的问题或任务描述。',
      },
      target_workspace: {
        type: 'string',
        description: '目标项目绝对路径。目标勾了「需要项目工作区」时使用；缺省为当前会话 cwd。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reply: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.reply }],
    },
    async execute(args, exec) {
      const started = Date.now()
      appendLog('ask', `agent_ask 入口: agent=${args.agent} question=${args.question.slice(0, 60)}`)
      // 调用方那条 DSH 会话 = 这一单的「对话」：patrol 之后的异步消息（问卷/进度/提醒）
      // 会往这条会话推（specs/12 §会话分层），所以这里必须把 sessionId 传下去。
      const callerSessionId = exec.agent?.id === undefined ? '' : String(exec.agent.id)
      const explicit = typeof args.target_workspace === 'string' ? args.target_workspace.trim() : ''
      const targetWorkspace = explicit !== '' ? explicit : sessionCwd(exec.agent)
      const r = await service.localAsk(`${args.agent} ${args.question}`, callerSessionId, targetWorkspace)
      const elapsed = Date.now() - started
      const text = r.messages.map((m) => m.text).filter((t) => t !== '').join('\n\n')
      if (r.error) {
        appendLog('ask', `agent_ask 失败(${elapsed}ms): ${r.error}`)
        return { reply: r.error }
      }
      if (text === '') {
        appendLog('ask', `agent_ask 空回复(${elapsed}ms)`)
        return { reply: '命令完成但无内容' }
      }
      appendLog('ask', `agent_ask 成功(${elapsed}ms) -> ${args.agent} -> ${text.length} 字`)
      return { reply: text }
    },
  }))
  appendLog('boot', '已注册 agent_ask 工具')
  return dispose
}

/**
 * 把问题投递给当前会话的 agent，引导它调用 `agent_ask` 工具转交给目标 agent。
 *
 * 不直接调 localAsk（那会让回复落在 command 卡片里，命令卡片又固定在顶部）；
 * 改为 followup 投递一条指令给当前 agent，由 agent loop 产生
 * user/message -> tool/call(agent_ask) -> tool/result -> assistant/message 的
 * 对话流顺序（同 dsh-command-goal 的 followup 模式）。
 */
function sessionCwd(agent: unknown): string {
  if (typeof agent !== 'object' || agent === null) return ''
  const cwd = (agent as { session?: { header?: { cwd?: unknown } } }).session?.header?.cwd
  return typeof cwd === 'string' ? cwd.trim() : ''
}

function delegateViaTool(
  agent: { followup(input: unknown): void },
  targetName: string,
  question: string,
  targetWorkspace?: string,
): void {
  const target = targetWorkspace !== undefined && targetWorkspace !== '' ? `，target_workspace="${targetWorkspace}"` : ''
  const text = `请立即调用 agent_ask 工具（直接调用，不要输出任何解释或复述）。参数：agent="${targetName.trim()}"，question="${question.trim()}"${target}。`
  appendLog('ask', `delegateViaTool 投递 followup: ${text.slice(0, 80)}`)
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'agent-bot' },
  }))
}

export function apply(ctx: Context, config: AgentBotConfig = {}): void {
  if (config.configDir !== undefined && config.configDir !== '') {
    process.env.AGENT_BOT_CONFIG_DIR = config.configDir
  }

  const service = createAgentBotService(hostServicesFromContext(ctx))
  ctx.provide('agentBot', service)
  appendLog('boot', 'agent-bot 已启动')

  const get = (ctx as unknown as { get?: (n: string) => unknown }).get?.bind(ctx)
  const commands = get?.('commands') as CommandRuntime | undefined
  const tools = get?.('tools') as ToolRuntime | undefined
  appendLog('boot', `commands=${commands ? 'ok' : '缺失'} tools=${tools ? 'ok' : '缺失'}`)

  // 事件驱动：专家会话一 idle 就立刻上报/收口（轮询只做兜底）。
  const disposeAgentStatus = ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    service.notifyAgentIdle(String(agent.id))
  })

  // 会话被销毁 → 它那一路要重启或判死（替代轮询里的「会话缺失」分支）
  const disposeAgentDisposed = ctx.on('agent/disposed', ({ agent }) => {
    service.notifyAgentDisposed(String(agent.id))
  })

  // 审批审计事件写在会话日志里：靠 session/event 实时观测，检测「卡在等审批」。
  // 事件很频（每次 append 都发），所以只认这几个 type，其余立即返回。
  const disposeSessionEvent = ctx.on('session/event', (session, event) => {
    if (event.type === 'approval/asked' || event.type === 'approval/decided') {
      service.notifySessionEvent(String(session.id))
      return
    }
    // 回合里调了 DSH 自带 ask_user_question → 立刻复核，让巡检的「检测挂起 tool/call →
    // 取消回合改问人」即时启动；否则要等到墙钟（默认 2h）或下次互动才触发，IM 回合卡死。
    if (event.type === 'tool/call') {
      const data = event.data as { name?: unknown } | undefined
      if (data?.name === 'ask_user_question') service.notifySessionEvent(String(session.id))
    }
  })

  const disposeRpc = registerRpcRoute(ctx, {
    listProviders: () => service.listProviders(),
    localAsk: (rawInput: string, sessionKey?: string) => service.localAsk(rawInput, sessionKey),
    drainLocalInbox: (sessionKey: string) => service.drainLocalInbox(sessionKey),
  })
  const disposePage = registerConfigSite(ctx)
  const disposeTool = tools ? registerAgentAskTool(tools, service) : undefined
  if (tools === undefined) appendLog('boot', 'tools 服务不可用，agent_ask 工具未注册')

  // agents 变了重新注册 /agent_<slug> 命令
  let disposeSlug = commands ? registerSlugCommands(commands, service) : undefined
  const unwatch = watchConfig(() => {
    disposeSlug?.()
    disposeSlug = commands ? registerSlugCommands(commands, service) : undefined
  })

  ctx.effect(() => () => {
    disposeAgentStatus()
    disposeAgentDisposed()
    disposeSessionEvent()
    unwatch()
    if (disposeRpc) disposeRpc()
    if (disposePage) disposePage()
    disposeSlug?.()
    disposeTool?.()
    void service.dispose()
  })
}

/** 为每个有 slug 的 agent 注册 /agent_<slug> 命令。 */
function registerSlugCommands(commands: CommandRuntime, _service: AgentBotService): () => void {
  const agents = listAgents().filter((a) => a.slug && a.slug !== '')
  const disposes = agents.map((a) =>
    commands.register({
      name: `agent_${a.slug}`,
      description: `调出 agent「${a.name}」`,
      input: { hint: '<问题>' },
      async handler({ agent, rawInput }) {
        const question = rawInput.trim()
        if (question === '') return { kind: 'error', text: `请输入问题：/agent_${a.slug} <问题>` }
        const cwd = sessionCwd(agent)
        if (a.needs_target_workspace && cwd === '') {
          return { kind: 'error', text: `agent「${a.name}」需要目标项目目录，但当前会话没有工作区` }
        }
        // 投递给当前 agent，引导它调 agent_ask 工具（对话流顺序）。
        delegateViaTool(agent, a.name, question, a.needs_target_workspace ? cwd : undefined)
        return { kind: 'success', text: `已转交 agent「${a.name}」处理` }
      },
    }),
  )
  return () => {
    for (const d of disposes) d()
  }
}
