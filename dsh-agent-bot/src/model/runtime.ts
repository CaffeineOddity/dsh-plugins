/**
 * DSH agent 运行时（G8）：ensureAgent live / resume / create。
 * 宿主服务 duck-type，不依赖 @deepseek-ai/dsh-*。followup 在 ask.ts 的 runFollowupTurn。
 * G13：unload 调 disposeAll，释放本插件 create/resume 拿到的 handle。
 */
import type { Context } from '@deepseek-ai/cordis'
import { resolveAgentLifecycle } from './ask.js'
import { DEFAULT_PERMISSION_MODE, parsePermissionMode, type PermissionMode } from './config.js'
import { UNKNOWN_PROMPT_VARIABLE_FALLBACK, unknownPromptVariableNames } from './prompts.js'

/** agents 服务最小面。 */
export interface AgentsService {
  get(id: string): AgentLike | undefined
  create(options: Record<string, unknown>): Promise<AgentHandleLike>
  resume(options: Record<string, unknown>): Promise<AgentHandleLike>
}

/** live agent 最小面。 */
export interface AgentLike {
  session: AgentSessionLike
  followup(input: unknown): void
  whenIdle(): Promise<void>
}

/** 会话最小面：seq / snapshotEvents 供 G9–G10 截取；append 写 full-access。 */
export interface AgentSessionLike {
  seq: number
  snapshotEvents(): Array<{ seq: number; type: string; data?: unknown }>
  append?(type: string, data: Record<string, unknown>): unknown
}

/** create/resume 返回的 handle。 */
export interface AgentHandleLike {
  agent: AgentLike
  dispose(): Promise<void>
}

/** 会话 setup 时用的 systemPrompt 最小面。 */
export interface SystemPromptService {
  variable?(name: string, fn: () => unknown): void
  section?(opts: { name: string; order?: number; text: string }): void
}

/** 已登记的 workspace 最小面：挂会话 + 改 GUI 标题。 */
export interface WorkspaceLike {
  title?: string
  attachSession(sessionId: string): Promise<void>
  setTitle?(title: string): Promise<void>
}

/** workspace 注册表最小面：归档探测 + 把会话挂进 GUI 分组。 */
export interface WorkspaceRegistryLike {
  archivedSessionIds?: readonly string[]
  create?(path: string, title?: string): Promise<WorkspaceLike>
}

/** 宿主服务袋。Model 不直接拿 Context。 */
export interface HostServices {
  agents(): AgentsService | undefined
  agentDefaultModel(): { currentSelection(): { provider?: string; model?: string } } | undefined
  agentPresets(): { mount(agentCtx: Context, id?: string): Promise<unknown> } | undefined
  sessionPersistence(): { list(): Promise<Array<{ id: string }>> } | undefined
  sessions(): { get?(id: string): unknown } | undefined
  workspaceRegistry(): WorkspaceRegistryLike | undefined
}

/** ensureAgent 入参。cwd 必须是 agent.workspace。 */
export interface EnsureAgentInput {
  sessionId: string
  cwd: string
  agentName: string
  promptText: string
  variables: Record<string, string>
  permissionMode: PermissionMode
}

/** 进程内 live handle 与 opening 去重。 */
export interface AgentRuntime {
  ensureAgent(input: EnsureAgentInput): Promise<AgentLike>
  isPersisted(sessionId: string): Promise<boolean>
  isArchived(sessionId: string): boolean
  disposeAll(): Promise<void>
  liveCount(): number
}

/** DSH 侧边栏标题：`agent_<智能体名>`。 */
export function workspaceDisplayTitle(agentName: string): string {
  const name = agentName.trim()
  if (name === '') throw new Error('agent-bot: agent 名称必填')
  return `agent_${name}`
}

/**
 * 把会话挂进 cwd 对应的 workspace，GUI 才进该目录分组而不是「未分组」。
 * 无 registry / 无 create 视为宿主未开此能力，跳过。attach / 改标题失败显式抛错。
 */
export async function attachSessionToWorkspace(
  host: HostServices,
  sessionId: string,
  cwd: string,
  title: string,
): Promise<void> {
  const registry = host.workspaceRegistry()
  if (registry === undefined || typeof registry.create !== 'function') return
  let workspace: WorkspaceLike
  try {
    workspace = await registry.create(cwd, title)
  } catch (err) {
    throw new Error(
      `agent-bot: 无法登记 workspace ${cwd}（session ${sessionId}）: ${(err as Error).message}`,
    )
  }
  try {
    await workspace.attachSession(sessionId)
  } catch (err) {
    throw new Error(
      `agent-bot: 无法把会话 ${sessionId} 挂到 workspace ${cwd}: ${(err as Error).message}`,
    )
  }
  if (workspace.title === title) return
  if (typeof workspace.setTitle !== 'function') return
  try {
    await workspace.setTitle(title)
  } catch (err) {
    throw new Error(
      `agent-bot: 无法把 workspace ${cwd} 改名为 ${title}: ${(err as Error).message}`,
    )
  }
}

/** 权限预设对应的沙箱与审批。 */
const PERMISSION_SPEC: Record<PermissionMode, { sandbox: string; approval: string }> = {
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  'read-only': { sandbox: 'read-only', approval: 'ask' },
}

/** 给会话写权限三元组（create / resume）。live 不重写。 */
export function applyPermission(session: AgentSessionLike, permissionMode: PermissionMode): void {
  if (typeof session.append !== 'function') {
    throw new Error('agent-bot: session 不支持 append，无法写入权限')
  }
  const mode = parsePermissionMode(permissionMode)
  const spec = PERMISSION_SPEC[mode]
  session.append('permission/preset', { preset: mode })
  session.append('sandbox/mode', { mode: spec.sandbox })
  session.append('approval/policy', { policy: spec.approval })
}

/** 给会话写 danger-full-access 三元组。 */
export function applyFullAccess(session: AgentSessionLike): void {
  applyPermission(session, DEFAULT_PERMISSION_MODE)
}

/** 创建运行时。handles 按 sessionId 去重；同 id 并发 ensure 共用 opening。 */
export function createAgentRuntime(host: HostServices): AgentRuntime {
  const handles = new Map<string, AgentHandleLike>()
  const opening = new Map<string, Promise<AgentLike>>()
  const lastVars = new Map<string, Record<string, string>>()

  async function isPersisted(sessionId: string): Promise<boolean> {
    const persistence = host.sessionPersistence()
    if (persistence === undefined) {
      const sessions = host.sessions()
      return sessions?.get?.(sessionId) !== undefined
    }
    const headers = await persistence.list()
    return headers.some((header) => header.id === sessionId)
  }

  function isArchived(sessionId: string): boolean {
    const registry = host.workspaceRegistry()
    if (registry?.archivedSessionIds === undefined) return false
    return registry.archivedSessionIds.includes(sessionId)
  }

  async function openAgent(input: EnsureAgentInput): Promise<AgentLike> {
    const agents = host.agents()
    if (agents === undefined) throw new Error('agent-bot: agents 服务不可用')
    if (input.sessionId.trim() === '') throw new Error('agent-bot: sessionId 不可为空')
    if (input.cwd.trim() === '') throw new Error('agent-bot: cwd 不可为空')

    lastVars.set(input.sessionId, input.variables)
    const live = agents.get(input.sessionId)
    const persisted = await isPersisted(input.sessionId)
    const lifecycle = resolveAgentLifecycle(live !== undefined, persisted)
    if (lifecycle === 'live') {
      if (live === undefined) {
        throw new Error(`agent-bot: session ${input.sessionId} 判定 live 但 agents.get 为空`)
      }
      return live
    }

    const sel = host.agentDefaultModel()?.currentSelection() ?? {}
    if (!sel.provider || !sel.model) {
      throw new Error('agent-bot: 未配置默认模型（settings.yaml 的 agent-default-model）')
    }

    const opts = {
      agentOptions: { provider: sel.provider, model: sel.model },
      setup: async (agentCtx: Context): Promise<void> => {
        const presets = host.agentPresets()
        if (presets?.mount) await presets.mount(agentCtx, 'standard')
        const sp = agentCtx.get('systemPrompt') as SystemPromptService | undefined
        const names = Object.keys(input.variables)
        for (const name of names) {
          sp?.variable?.(name, () => lastVars.get(input.sessionId)?.[name] ?? '')
        }
        for (const name of unknownPromptVariableNames(input.promptText, new Set(names))) {
          sp?.variable?.(name, () => UNKNOWN_PROMPT_VARIABLE_FALLBACK)
        }
        if (input.promptText !== '') {
          sp?.section?.({ name: 'agent-bot:prompt', order: 1, text: input.promptText })
        }
      },
    }

    let handle: AgentHandleLike
    if (lifecycle === 'resume') {
      handle = await agents.resume({ resumeSessionId: input.sessionId, ...opts })
    } else {
      handle = await agents.create({ sessionId: input.sessionId, meta: { cwd: input.cwd }, ...opts })
    }
    applyPermission(handle.agent.session, input.permissionMode)

    const previous = handles.get(input.sessionId)
    handles.set(input.sessionId, handle)
    if (previous !== undefined && previous !== handle) {
      void previous.dispose().catch(() => undefined)
    }
    return handle.agent
  }

  return {
    async ensureAgent(input: EnsureAgentInput): Promise<AgentLike> {
      const key = input.sessionId
      const pending = opening.get(key)
      if (pending !== undefined) return pending
      const job = (async () => {
        let agent: AgentLike
        try {
          agent = await openAgent(input)
        } catch (error: unknown) {
          const live = host.agents()?.get(key)
          if (live === undefined) throw error
          agent = live
        }
        // attach 必须在 create/resume 的 live 兜底之后：失败不得被「已有 live」吞掉。
        await attachSessionToWorkspace(
          host,
          input.sessionId,
          input.cwd,
          workspaceDisplayTitle(input.agentName),
        )
        return agent
      })()
      opening.set(key, job)
      try {
        return await job
      } finally {
        if (opening.get(key) === job) opening.delete(key)
      }
    },
    isPersisted,
    isArchived,
    async disposeAll(): Promise<void> {
      const jobs = [...handles.values()].map((handle) => handle.dispose().catch(() => undefined))
      handles.clear()
      opening.clear()
      lastVars.clear()
      await Promise.all(jobs)
    },
    liveCount(): number {
      return handles.size
    },
  }
}
