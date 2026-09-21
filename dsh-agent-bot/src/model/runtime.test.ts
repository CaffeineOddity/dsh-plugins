/**
 * ensureAgent：live / resume / create（G8）；unload disposeAll（G13）。假 agents 服务，不启 webServer。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  applyFullAccess,
  applyPermission,
  attachSessionToWorkspace,
  createAgentRuntime,
  workspaceDisplayTitle,
  type AgentHandleLike,
  type AgentLike,
  type AgentsService,
  type HostServices,
} from './runtime.js'

interface FakeSession {
  seq: number
  appended: Array<{ type: string; data: Record<string, unknown> }>
  snapshotEvents(): []
  append(type: string, data: Record<string, unknown>): void
}

function fakeAgent(): { agent: AgentLike; session: FakeSession } {
  const session: FakeSession = {
    seq: 0,
    appended: [],
    snapshotEvents: () => [],
    append(type, data) {
      this.appended.push({ type, data })
    },
  }
  return {
    session,
    agent: {
      session,
      followup() {
        return
      },
      async whenIdle() {
        return
      },
    },
  }
}

function handleOf(agent: AgentLike): AgentHandleLike {
  return {
    agent,
    async dispose() {
      return
    },
  }
}

function hostOf(partial: {
  agents?: AgentsService
  model?: { provider: string; model: string }
  persistedIds?: string[]
  archivedIds?: string[]
  sessionGet?: (id: string) => unknown
  mounts?: string[]
  attached?: Array<{ cwd: string; sessionId: string; title?: string }>
  titles?: Array<{ cwd: string; from: string; to: string }>
  existingTitle?: string
  attachError?: string
  renameError?: string
}): HostServices {
  const mounts = partial.mounts ?? []
  const model = partial.model
  const persistedIds = partial.persistedIds
  const archivedIds = partial.archivedIds
  const sessionGet = partial.sessionGet
  const attached = partial.attached
  const titles = partial.titles
  const existingTitle = partial.existingTitle
  const attachError = partial.attachError
  const renameError = partial.renameError
  return {
    agents: () => partial.agents,
    agentDefaultModel: () =>
      model === undefined ? undefined : { currentSelection: () => model },
    agentPresets: () => ({
      async mount(_ctx: Context, id?: string) {
        mounts.push(id ?? '')
      },
    }),
    sessionPersistence:
      persistedIds === undefined
        ? () => undefined
        : () => ({
            async list() {
              return persistedIds.map((id) => ({ id }))
            },
          }),
    sessions: () => (sessionGet === undefined ? undefined : { get: sessionGet }),
    workspaceRegistry: () => {
      if (
        archivedIds === undefined &&
        attached === undefined &&
        attachError === undefined &&
        titles === undefined &&
        existingTitle === undefined &&
        renameError === undefined
      ) {
        return undefined
      }
      return {
        archivedSessionIds: archivedIds,
        async create(path: string, title?: string) {
          if (attachError !== undefined) throw new Error(attachError)
          const currentTitle = existingTitle ?? title ?? ''
          return {
            title: currentTitle,
            async attachSession(sessionId: string) {
              attached?.push({ cwd: path, sessionId, title })
            },
            async setTitle(next: string) {
              if (renameError !== undefined) throw new Error(renameError)
              titles?.push({ cwd: path, from: currentTitle, to: next })
              this.title = next
            },
          }
        },
      }
    },
  }
}

/** 带 setup 探针的 agents：create/resume 时调用 opts.setup 并注入假 systemPrompt。 */
function probingAgents(
  live: Map<string, AgentLike>,
  created: Array<Record<string, unknown>>,
  resumed: Array<Record<string, unknown>>,
  sections: Array<{ name: string; text: string }>,
  variables: string[],
): AgentsService {
  async function runSetup(opts: Record<string, unknown>): Promise<void> {
    const setup = opts.setup as ((ctx: Context) => Promise<void>) | undefined
    if (setup === undefined) return
    const fakeCtx = {
      get(name: string) {
        if (name !== 'systemPrompt') return undefined
        return {
          variable(n: string) {
            variables.push(n)
          },
          section(opts: { name: string; text: string }) {
            sections.push({ name: opts.name, text: opts.text })
          },
        }
      },
    }
    await setup(fakeCtx as Context)
  }
  return {
    get(id) {
      return live.get(id)
    },
    async create(options) {
      created.push(options)
      await runSetup(options)
      const { agent } = fakeAgent()
      live.set(String(options.sessionId), agent)
      return handleOf(agent)
    },
    async resume(options) {
      resumed.push(options)
      await runSetup(options)
      const { agent } = fakeAgent()
      live.set(String(options.resumeSessionId), agent)
      return handleOf(agent)
    },
  }
}

const input = {
  sessionId: 'sid-1',
  cwd: '/tmp/ws',
  agentId: 'agent-1',
  agentName: '联运助手',
  promptText: '你是联运助手',
  variables: { sender: 'alice', session_key: 'r1_1', provider_id: 'demo', bot_id: 'r1', group_id: '1' },
  permissionMode: 'danger-full-access' as const,
}

describe('ensureAgent', () => {
  it('agents 服务不可用 / 未配模型 / 空 id 显式抛错', async () => {
    const rt = createAgentRuntime(hostOf({}))
    await expect(rt.ensureAgent(input)).rejects.toThrow(/agents 服务不可用/)
    const live = new Map<string, AgentLike>()
    const rt2 = createAgentRuntime(
      hostOf({
        agents: probingAgents(live, [], [], [], []),
      }),
    )
    await expect(rt2.ensureAgent(input)).rejects.toThrow(/未配置默认模型/)
    const rt3 = createAgentRuntime(
      hostOf({
        agents: probingAgents(live, [], [], [], []),
        model: { provider: 'p', model: 'm' },
      }),
    )
    await expect(rt3.ensureAgent({ ...input, sessionId: '' })).rejects.toThrow(/sessionId 不可为空/)
    await expect(rt3.ensureAgent({ ...input, cwd: '  ' })).rejects.toThrow(/cwd 不可为空/)
  })

  it('live 优先：不 create、不 resume', async () => {
    const { agent } = fakeAgent()
    const live = new Map<string, AgentLike>([['sid-1', agent]])
    const created: Array<Record<string, unknown>> = []
    const resumed: Array<Record<string, unknown>> = []
    const rt = createAgentRuntime(
      hostOf({
        agents: probingAgents(live, created, resumed, [], []),
        model: { provider: 'p', model: 'm' },
        persistedIds: ['sid-1'],
      }),
    )
    expect(await rt.ensureAgent(input)).toBe(agent)
    expect(created).toEqual([])
    expect(resumed).toEqual([])
  })

  it('磁盘有则 resume，禁止同 id create；按权限写三元组', async () => {
    const live = new Map<string, AgentLike>()
    const created: Array<Record<string, unknown>> = []
    const resumed: Array<Record<string, unknown>> = []
    const mounts: string[] = []
    const sections: Array<{ name: string; text: string }> = []
    const variables: string[] = []
    const agents = probingAgents(live, created, resumed, sections, variables)
    const origResume = agents.resume.bind(agents)
    let resumedAgent: AgentLike | undefined
    agents.resume = async (options) => {
      const handle = await origResume(options)
      resumedAgent = handle.agent
      return handle
    }
    const rt = createAgentRuntime(
      hostOf({
        agents,
        model: { provider: 'p', model: 'm' },
        persistedIds: ['sid-1'],
        mounts,
      }),
    )
    const got = await rt.ensureAgent(input)
    expect(got).toBe(resumedAgent)
    expect(created).toEqual([])
    expect(resumed).toHaveLength(1)
    expect(resumed[0]?.resumeSessionId).toBe('sid-1')
    expect(resumed[0]?.meta).toBeUndefined()
    expect(mounts).toEqual(['standard'])
    expect(sections).toEqual([{ name: 'agent-bot:prompt', text: '你是联运助手' }])
    expect(variables).toEqual(['sender', 'session_key', 'provider_id', 'bot_id', 'group_id'])
    expect((got.session as FakeSession).appended).toEqual([
      { type: 'permission/preset', data: { preset: 'danger-full-access' } },
      { type: 'sandbox/mode', data: { mode: 'danger-full-access' } },
      { type: 'approval/policy', data: { policy: 'never' } },
    ])
  })

  it('无 live 无磁盘则 create：cwd=workspace、standard、full-access，并挂进 workspace 分组', async () => {
    const live = new Map<string, AgentLike>()
    const created: Array<Record<string, unknown>> = []
    const resumed: Array<Record<string, unknown>> = []
    const mounts: string[] = []
    const attached: Array<{ cwd: string; sessionId: string; title?: string }> = []
    const rt = createAgentRuntime(
      hostOf({
        agents: probingAgents(live, created, resumed, [], []),
        model: { provider: 'p', model: 'm' },
        persistedIds: [],
        mounts,
        attached,
      }),
    )
    const got = await rt.ensureAgent(input)
    expect(created).toHaveLength(1)
    expect(resumed).toEqual([])
    expect(created[0]?.sessionId).toBe('sid-1')
    expect(created[0]?.meta).toEqual({ cwd: '/tmp/ws' })
    expect(mounts).toEqual(['standard'])
    expect(attached).toEqual([{ cwd: '/tmp/ws', sessionId: 'sid-1', title: 'agent_联运助手' }])
    expect((got.session as FakeSession).appended).toEqual([
      { type: 'permission/preset', data: { preset: 'danger-full-access' } },
      { type: 'sandbox/mode', data: { mode: 'danger-full-access' } },
      { type: 'approval/policy', data: { policy: 'never' } },
    ])
  })

  it('prompt 里未提供的 {{webhook_url}} 登记为未知变量，不覆盖已知名', async () => {
    const live = new Map<string, AgentLike>()
    const variables: string[] = []
    const rt = createAgentRuntime(
      hostOf({
        agents: probingAgents(live, [], [], [], variables),
        model: { provider: 'p', model: 'm' },
        persistedIds: [],
      }),
    )
    await rt.ensureAgent({
      ...input,
      promptText: 'webhook={{webhook_url}} sender={{sender}} cwd={{cwd}}',
    })
    expect(variables).toEqual(['sender', 'session_key', 'provider_id', 'bot_id', 'group_id', 'webhook_url'])
  })

  it('resume / live 同样 attach，把历史未分组会话收进 workspace', async () => {
    const liveEmpty = new Map<string, AgentLike>()
    const attachedResume: Array<{ cwd: string; sessionId: string }> = []
    const rtResume = createAgentRuntime(
      hostOf({
        agents: probingAgents(liveEmpty, [], [], [], []),
        model: { provider: 'p', model: 'm' },
        persistedIds: ['sid-1'],
        attached: attachedResume,
      }),
    )
    await rtResume.ensureAgent(input)
    expect(attachedResume).toEqual([{ cwd: '/tmp/ws', sessionId: 'sid-1', title: 'agent_联运助手' }])

    const { agent } = fakeAgent()
    const live = new Map<string, AgentLike>([['sid-1', agent]])
    const attachedLive: Array<{ cwd: string; sessionId: string }> = []
    const rtLive = createAgentRuntime(
      hostOf({
        agents: probingAgents(live, [], [], [], []),
        model: { provider: 'p', model: 'm' },
        persistedIds: ['sid-1'],
        attached: attachedLive,
      }),
    )
    expect(await rtLive.ensureAgent(input)).toBe(agent)
    expect(attachedLive).toEqual([{ cwd: '/tmp/ws', sessionId: 'sid-1', title: 'agent_联运助手' }])
  })

  it('无 workspaceRegistry 时跳过 attach；create 失败显式抛错', async () => {
    const live = new Map<string, AgentLike>()
    const created: Array<Record<string, unknown>> = []
    const rtSkip = createAgentRuntime(
      hostOf({
        agents: probingAgents(live, created, [], [], []),
        model: { provider: 'p', model: 'm' },
        persistedIds: [],
      }),
    )
    await rtSkip.ensureAgent(input)
    expect(created).toHaveLength(1)

    const rtFail = createAgentRuntime(
      hostOf({
        agents: probingAgents(new Map(), [], [], [], []),
        model: { provider: 'p', model: 'm' },
        persistedIds: [],
        attachError: 'path missing',
      }),
    )
    await expect(rtFail.ensureAgent({ ...input, sessionId: 'sid-fail' })).rejects.toThrow(
      /无法登记 workspace/,
    )
  })

  it('同 sessionId 并发 ensure 共用 opening，只 create 一次', async () => {
    const live = new Map<string, AgentLike>()
    const created: Array<Record<string, unknown>> = []
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const agents = probingAgents(live, created, [], [], [])
    const orig = agents.create.bind(agents)
    agents.create = async (options) => {
      await gate
      return orig(options)
    }
    const rt = createAgentRuntime(
      hostOf({
        agents,
        model: { provider: 'p', model: 'm' },
        persistedIds: [],
      }),
    )
    const a = rt.ensureAgent(input)
    const b = rt.ensureAgent(input)
    release()
    const [one, two] = await Promise.all([a, b])
    expect(one).toBe(two)
    expect(created).toHaveLength(1)
  })

  it('无 persistence 时用 sessions.get 判断磁盘', async () => {
    const live = new Map<string, AgentLike>()
    const resumed: Array<Record<string, unknown>> = []
    const rt = createAgentRuntime(
      hostOf({
        agents: probingAgents(live, [], resumed, [], []),
        model: { provider: 'p', model: 'm' },
        sessionGet: (id) => (id === 'sid-1' ? { id } : undefined),
      }),
    )
    await rt.ensureAgent(input)
    expect(resumed).toHaveLength(1)
  })

  it('isArchived 读 workspaceRegistry', () => {
    const rt = createAgentRuntime(hostOf({ archivedIds: ['sid-old'] }))
    expect(rt.isArchived('sid-old')).toBe(true)
    expect(rt.isArchived('sid-new')).toBe(false)
  })
})

describe('disposeAll', () => {
  it('create 后 unload 调 dispose；再调是空操作', async () => {
    const live = new Map<string, AgentLike>()
    let disposed = 0
    const agents = probingAgents(live, [], [], [], [])
    const orig = agents.create.bind(agents)
    agents.create = async (options) => {
      const handle = await orig(options)
      return {
        agent: handle.agent,
        async dispose() {
          disposed += 1
        },
      }
    }
    const rt = createAgentRuntime(
      hostOf({
        agents,
        model: { provider: 'p', model: 'm' },
        persistedIds: [],
      }),
    )
    await rt.ensureAgent(input)
    expect(rt.liveCount()).toBe(1)
    await rt.disposeAll()
    expect(disposed).toBe(1)
    expect(rt.liveCount()).toBe(0)
    await rt.disposeAll()
    expect(disposed).toBe(1)
  })

  it('live 路径没有本插件 handle，unload 不误 dispose', async () => {
    const { agent } = fakeAgent()
    const live = new Map<string, AgentLike>([['sid-1', agent]])
    const rt = createAgentRuntime(
      hostOf({
        agents: probingAgents(live, [], [], [], []),
        model: { provider: 'p', model: 'm' },
        persistedIds: ['sid-1'],
      }),
    )
    expect(await rt.ensureAgent(input)).toBe(agent)
    expect(rt.liveCount()).toBe(0)
    await rt.disposeAll()
    expect(rt.liveCount()).toBe(0)
  })
})

describe('attachSessionToWorkspace', () => {
  it('无 registry 或无 create 则跳过；attach 失败包一层错误', async () => {
    await attachSessionToWorkspace(hostOf({}), 'sid-1', '/tmp/ws', 'agent_联运助手')
    await attachSessionToWorkspace(
      {
        ...hostOf({}),
        workspaceRegistry: () => ({ archivedSessionIds: [] }),
      },
      'sid-1',
      '/tmp/ws',
      'agent_联运助手',
    )
    const attached: Array<{ cwd: string; sessionId: string; title?: string }> = []
    await attachSessionToWorkspace(hostOf({ attached }), 'sid-1', '/tmp/ws', 'agent_联运助手')
    expect(attached).toEqual([{ cwd: '/tmp/ws', sessionId: 'sid-1', title: 'agent_联运助手' }])
    await expect(
      attachSessionToWorkspace(
        {
          ...hostOf({}),
          workspaceRegistry: () => ({
            async create() {
              return {
                async attachSession() {
                  throw new Error('cwd mismatch')
                },
              }
            },
          }),
        },
        'sid-1',
        '/tmp/ws',
        'agent_联运助手',
      ),
    ).rejects.toThrow(/无法把会话 sid-1 挂到 workspace/)
  })

  it('已有同路径记录标题不一致则 setTitle；已是目标名则跳过', async () => {
    expect(workspaceDisplayTitle(' 联运助手 ')).toBe('agent_联运助手')
    expect(() => workspaceDisplayTitle('  ')).toThrow(/agent 名称必填/)
    const titles: Array<{ cwd: string; from: string; to: string }> = []
    await attachSessionToWorkspace(
      hostOf({ attached: [], titles, existingTitle: '旧名' }),
      'sid-1',
      '/tmp/ws',
      'agent_联运助手',
    )
    expect(titles).toEqual([{ cwd: '/tmp/ws', from: '旧名', to: 'agent_联运助手' }])
    const skipped: Array<{ cwd: string; from: string; to: string }> = []
    await attachSessionToWorkspace(
      hostOf({ attached: [], titles: skipped, existingTitle: 'agent_联运助手' }),
      'sid-1',
      '/tmp/ws',
      'agent_联运助手',
    )
    expect(skipped).toEqual([])
    await expect(
      attachSessionToWorkspace(
        hostOf({ attached: [], existingTitle: '旧名', renameError: 'name-conflict' }),
        'sid-1',
        '/tmp/ws',
        'agent_联运助手',
      ),
    ).rejects.toThrow(/无法把 workspace \/tmp\/ws 改名为 agent_联运助手/)
  })
})

describe('applyPermission', () => {
  it('没有 append 则抛错', () => {
    expect(() =>
      applyFullAccess({
        seq: 0,
        snapshotEvents: () => [],
      }),
    ).toThrow(/不支持 append/)
  })

  it('workspace-write / read-only 写 ask 审批', () => {
    const session: FakeSession = {
      seq: 0,
      appended: [],
      snapshotEvents: () => [],
      append(type, data) {
        this.appended.push({ type, data })
      },
    }
    applyPermission(session, 'workspace-write')
    expect(session.appended).toEqual([
      { type: 'permission/preset', data: { preset: 'workspace-write' } },
      { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
      { type: 'approval/policy', data: { policy: 'ask' } },
    ])
  })
})
