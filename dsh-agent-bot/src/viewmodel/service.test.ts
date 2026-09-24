/**
 * agentBot 门面：listAgents / getAgent / registerProvider / ask（含 H5：未知 agent、按人、空回复、pending reject）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAgent } from '../model/agents.js'
import { resetConfigCache, saveConfig } from '../model/config.js'
import type { AgentLike, AgentsService, HostServices } from '../model/runtime.js'
import { createAgentBotService, emptyHostServices } from './service.js'
import { inboundFor, resetInboundCache } from '../model/teamwork/inbound.js'

function fakeHost(
  events: Array<{ seq: number; type: string; data?: unknown }>,
  whenIdle: () => Promise<void>,
  record?: { followups: unknown[] },
): HostServices {
  const live = new Map<string, AgentLike>()
  const agents: AgentsService = {
    get(id) {
      return live.get(id)
    },
    async create(options) {
      const agent: AgentLike = {
        session: {
          seq: 0,
          snapshotEvents: () => events,
          append() {
            return
          },
        },
        followup(input) {
          record?.followups.push(input)
        },
        whenIdle,
      }
      live.set(String(options.sessionId), agent)
      return {
        agent,
        async dispose() {
          return
        },
      }
    },
    async resume() {
      throw new Error('test: unexpected resume')
    },
  }
  return {
    agents: () => agents,
    agentDefaultModel: () => ({ currentSelection: () => ({ provider: 'p', model: 'm' }) }),
    agentPresets: () => ({
      async mount() {
        return
      },
    }),
    sessionPersistence: () => ({
      async list() {
        return []
      },
    }),
    sessions: () => undefined,
    workspaceRegistry: () => undefined,
  }
}

function idleNow(): Promise<void> {
  return Promise.resolve()
}

/** 上一轮立刻闲；本轮与 pending 二次竞速永不 idle。 */
function hangAfterFirstIdle(): () => Promise<void> {
  let calls = 0
  return () => {
    calls += 1
    if (calls === 1) return Promise.resolve()
    return new Promise(() => undefined)
  }
}

function seedRunnableAgent(sessionBySender: boolean, timeoutMs: number): void {
  mkdirSync(join(configDir, 'ws'), { recursive: true })
  saveConfig({
    skill_roots: [],
    skill_groups: {},
    prompts: {},
    agents: [
      {
        id: 'a1',
        name: '联运',
        description: '',
        workspace: join(configDir, 'ws'),
        prompt: '',
        prompt_placement: 'system',
        skill_groups: [],
        prompt_append_skills: true,
        reuse_session: true,
        session_by_sender: sessionBySender,
        permission_mode: 'danger-full-access',
        session_timeout_minutes: 30,
          concurrency: "serial",
          needs_target_workspace: false,
        sessions: {},
      },
    ],
    skill_apply: {},
    agent_wait_timeout_ms: timeoutMs,
    expert_liveness_max_renew: 3,
    task_round_timeout_ms: 7200000,
    use_hub_experts: true,
  })
}

function askReq(traceId: string, sender: string): {
  agentId: string
  context: string
  meta: { traceId: string; providerId: string; sessionParts: { bot_id: string; group_id: string }; sender: string }
} {
  return {
    agentId: 'a1',
    context: '用户[alice]: 你好',
    meta: {
      traceId,
      providerId: 'demo',
      sessionParts: { bot_id: 'r1', group_id: '1' },
      sender,
    },
  }
}

let configDir: string
let prevEnv: string | undefined

beforeEach(() => {
  prevEnv = process.env.AGENT_BOT_CONFIG_DIR
  configDir = mkdtempSync(join(tmpdir(), 'agentbot-service-'))
  process.env.AGENT_BOT_CONFIG_DIR = configDir
  resetConfigCache()
  resetInboundCache()
})

afterEach(() => {
  resetConfigCache()
  resetInboundCache()
  if (prevEnv === undefined) delete process.env.AGENT_BOT_CONFIG_DIR
  else process.env.AGENT_BOT_CONFIG_DIR = prevEnv
  rmSync(configDir, { recursive: true, force: true })
})

describe('listAgents / getAgent', () => {
  it('只返回通道摘要，不含 sessions', () => {
    saveConfig({
      skill_roots: [],
      skill_groups: {},
      prompts: {},
      agents: [
        {
          id: 'a1',
          name: '联运',
          description: '说明',
          workspace: '/tmp/ws',
          prompt: '',
          prompt_placement: 'system',
          skill_groups: [],
          prompt_append_skills: true,
          reuse_session: true,
          session_by_sender: false,
          permission_mode: 'danger-full-access',
          session_timeout_minutes: 30,
          concurrency: "serial",
          needs_target_workspace: false,
          sessions: { demo_r1_1: { sessionId: 'sid', lastAskAt: 1 } },
        },
      ],
      skill_apply: {},
      agent_wait_timeout_ms: 180000,
      expert_liveness_max_renew: 3,
      task_round_timeout_ms: 7200000,
      use_hub_experts: true,
    })
    const svc = createAgentBotService(emptyHostServices())
    expect(svc.listAgents()).toEqual([
      { id: 'a1', name: '联运', description: '说明', workspace: '/tmp/ws' },
    ])
    expect(svc.getAgent('a1')).toEqual({
      id: 'a1',
      name: '联运',
      description: '说明',
      workspace: '/tmp/ws',
    })
    expect(svc.getAgent('missing')).toBeUndefined()
  })
})

describe('registerProvider', () => {
  it('空 id 抛错；listProviders 返回在线通道（含内置 local）', () => {
    const svc = createAgentBotService(emptyHostServices())
    expect(() => svc.registerProvider({ id: '', label: 'x' })).toThrow(/非空 id/)
    const local = { id: 'local', label: '本地' }
    expect(svc.listProviders()).toEqual([local])
    const dispose = svc.registerProvider({ id: 'demo', label: '示例通道' })
    expect(svc.listProviders()).toEqual([local, { id: 'demo', label: '示例通道' }])
    dispose()
    expect(svc.listProviders()).toEqual([local])
  })

  it('重复注册后写覆盖；旧 disposer 不删新代；内置 local 不受影响', () => {
    const svc = createAgentBotService(emptyHostServices())
    const local = { id: 'local', label: '本地' }
    const oldDispose = svc.registerProvider({ id: 'demo', label: '旧' })
    const newDispose = svc.registerProvider({ id: 'demo', label: '新' })
    expect(svc.listProviders()).toEqual([local, { id: 'demo', label: '新' }])
    oldDispose()
    expect(svc.listProviders()).toEqual([local, { id: 'demo', label: '新' }])
    newDispose()
    expect(svc.listProviders()).toEqual([local])
  })

  it('label 空则回退为 id', () => {
    const svc = createAgentBotService(emptyHostServices())
    svc.registerProvider({ id: 'feishu', label: '' })
    expect(svc.listProviders()).toEqual([{ id: 'local', label: '本地' }, { id: 'feishu', label: 'feishu' }])
  })
})

describe('ask 校验先于回合', () => {
  it('未注册 provider 先抛错，不走到回合', async () => {
    const svc = createAgentBotService(emptyHostServices())
    await expect(
      svc.ask({
        agentId: 'a1',
        context: '用户[alice]: 你好',
        meta: {
          traceId: 't1',
          providerId: 'demo',
          sessionParts: { bot_id: 'r1', group_id: '1' },
          sender: 'alice',
        },
      }),
    ).rejects.toThrow(/未注册 provider demo/)
  })

  it('校验通过后同槽排队，idle 收口成单条 markdown', async () => {
    mkdirSync(join(configDir, 'ws'), { recursive: true })
    saveConfig({
      skill_roots: [],
      skill_groups: {},
      prompts: {},
      agents: [
        {
          id: 'a1',
          name: '联运',
          description: '',
          workspace: join(configDir, 'ws'),
          prompt: '',
          prompt_placement: 'system',
          skill_groups: [],
          prompt_append_skills: true,
          reuse_session: true,
          session_by_sender: false,
          permission_mode: 'danger-full-access',
          session_timeout_minutes: 30,
          concurrency: "serial",
          needs_target_workspace: false,
          sessions: {},
        },
      ],
      skill_apply: {},
      agent_wait_timeout_ms: 180000,
      expert_liveness_max_renew: 3,
      task_round_timeout_ms: 7200000,
      use_hub_experts: true,
    })
    const svc = createAgentBotService(fakeHost([], idleNow))
    svc.registerProvider({ id: 'demo', label: '示例通道' })
    const req = askReq('t1', 'alice')
    const first = svc.ask(req)
    const second = svc.ask(askReq('t2', 'alice'))
    await expect(first).resolves.toEqual({ messages: [], pending: null })
    await expect(second).resolves.toEqual({ messages: [], pending: null })
  })

  it('idle 时把本轮最后一条助手文本收成单条 markdown', async () => {
    mkdirSync(join(configDir, 'ws'), { recursive: true })
    saveConfig({
      skill_roots: [],
      skill_groups: {},
      prompts: {},
      agents: [
        {
          id: 'a1',
          name: '联运',
          description: '',
          workspace: join(configDir, 'ws'),
          prompt: '',
          prompt_placement: 'system',
          skill_groups: [],
          prompt_append_skills: true,
          reuse_session: true,
          session_by_sender: false,
          permission_mode: 'danger-full-access',
          session_timeout_minutes: 30,
          concurrency: "serial",
          needs_target_workspace: false,
          sessions: {},
        },
      ],
      skill_apply: {},
      agent_wait_timeout_ms: 180000,
      expert_liveness_max_renew: 3,
      task_round_timeout_ms: 7200000,
      use_hub_experts: true,
    })
    const svc = createAgentBotService(
      fakeHost(
        [
          { seq: 0, type: 'turn/start' },
          { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '你好世界' }] } } },
        ],
        idleNow,
      ),
    )
    svc.registerProvider({ id: 'demo', label: '示例通道' })
    await expect(
      svc.ask({
        agentId: 'a1',
        context: '用户[alice]: 你好',
        meta: {
          traceId: 't1',
          providerId: 'demo',
          sessionParts: { bot_id: 'r1', group_id: '1' },
          sender: 'alice',
        },
      }),
    ).resolves.toEqual({
      messages: [{ kind: 'markdown', text: '你好世界', url: '', atUserIds: [], atAll: false }],
      pending: null,
    })
    const slot = getAgent('a1')?.sessions.demo_r1_1
    expect(slot?.sessionId).toEqual(expect.any(String))
    expect(slot?.sessionId.length).toBeGreaterThan(0)
    expect(slot?.lastAskAt).toBeGreaterThan(1_700_000_000_000)
  })

  it('同槽第二轮读到上一轮 lastAskAt 后复用 sessionId', async () => {
    mkdirSync(join(configDir, 'ws'), { recursive: true })
    saveConfig({
      skill_roots: [],
      skill_groups: {},
      prompts: {},
      agents: [
        {
          id: 'a1',
          name: '联运',
          description: '',
          workspace: join(configDir, 'ws'),
          prompt: '',
          prompt_placement: 'system',
          skill_groups: [],
          prompt_append_skills: true,
          reuse_session: true,
          session_by_sender: false,
          permission_mode: 'danger-full-access',
          session_timeout_minutes: 30,
          concurrency: "serial",
          needs_target_workspace: false,
          sessions: {},
        },
      ],
      skill_apply: {},
      agent_wait_timeout_ms: 180000,
      expert_liveness_max_renew: 3,
      task_round_timeout_ms: 7200000,
      use_hub_experts: true,
    })
    const svc = createAgentBotService(fakeHost([], idleNow))
    svc.registerProvider({ id: 'demo', label: '示例通道' })
    const req = askReq('t1', 'alice')
    await svc.ask(req)
    const first = getAgent('a1')?.sessions.demo_r1_1
    if (first === undefined) throw new Error('test: 第一轮应收口写槽')
    await svc.ask({ ...req, meta: { ...req.meta, traceId: 't2' } })
    const second = getAgent('a1')?.sessions.demo_r1_1
    expect(second?.sessionId).toBe(first.sessionId)
    expect(second?.lastAskAt).toBeGreaterThanOrEqual(first.lastAskAt)
    expect(second?.promptFingerprint).toBe('')
  })

  it('改 prompt 后同槽下次 ask 开新会话', async () => {
    mkdirSync(join(configDir, 'ws'), { recursive: true })
    saveConfig({
      skill_roots: [],
      skill_groups: {},
      prompts: { default: { system_prompt: '旧文', tools: [] } },
      agents: [
        {
          id: 'a1',
          name: '联运',
          description: '',
          workspace: join(configDir, 'ws'),
          prompt: 'default',
          prompt_placement: 'system',
          skill_groups: [],
          prompt_append_skills: true,
          reuse_session: true,
          session_by_sender: false,
          permission_mode: 'danger-full-access',
          session_timeout_minutes: 30,
          concurrency: "serial",
          needs_target_workspace: false,
          sessions: {},
        },
      ],
      skill_apply: {},
      agent_wait_timeout_ms: 180000,
      expert_liveness_max_renew: 3,
      task_round_timeout_ms: 7200000,
      use_hub_experts: true,
    })
    const svc = createAgentBotService(fakeHost([], idleNow))
    svc.registerProvider({ id: 'demo', label: '示例通道' })
    const req = askReq('t1', 'alice')
    await svc.ask(req)
    const first = getAgent('a1')?.sessions.demo_r1_1
    if (first === undefined) throw new Error('test: 第一轮应收口写槽')
    expect(first.promptFingerprint).toBe('旧文')
    const cfg = getAgent('a1')
    if (cfg === undefined) throw new Error('test: agent 应存在')
    saveConfig({
      skill_roots: [],
      skill_groups: {},
      prompts: { default: { system_prompt: '新文', tools: [] } },
      agents: [cfg],
      skill_apply: {},
      agent_wait_timeout_ms: 180000,
      expert_liveness_max_renew: 3,
      task_round_timeout_ms: 7200000,
      use_hub_experts: true,
    })
    await svc.ask({ ...req, meta: { ...req.meta, traceId: 't2' } })
    const second = getAgent('a1')?.sessions.demo_r1_1
    expect(second?.sessionId).not.toBe(first.sessionId)
    expect(second?.promptFingerprint).toBe('新文')
  })

  it('prompt_placement=user 不写系统提示词，接到用户对话后', async () => {
    mkdirSync(join(configDir, 'ws'), { recursive: true })
    saveConfig({
      skill_roots: [],
      skill_groups: {},
      prompts: { default: { system_prompt: '你是{{sender}}助手', tools: [] } },
      agents: [
        {
          id: 'a1',
          name: '联运',
          description: '',
          workspace: join(configDir, 'ws'),
          prompt: 'default',
          prompt_placement: 'user',
          skill_groups: [],
          prompt_append_skills: true,
          reuse_session: true,
          session_by_sender: false,
          permission_mode: 'danger-full-access',
          session_timeout_minutes: 30,
          concurrency: "serial",
          needs_target_workspace: false,
          sessions: {},
        },
      ],
      skill_apply: {},
      agent_wait_timeout_ms: 180000,
      expert_liveness_max_renew: 3,
      task_round_timeout_ms: 7200000,
      use_hub_experts: true,
    })
    const followups: unknown[] = []
    const svc = createAgentBotService(fakeHost([], idleNow, { followups }))
    svc.registerProvider({ id: 'demo', label: '示例通道' })
    await svc.ask(askReq('t1', 'alice'))
    const payload = followups[0] as { content: Array<{ text: string }> }
    expect(payload.content[0]?.text).toBe('用户[alice]: 你好\n\n你是alice助手\n\n——本群任务板（specs/12）——\n（本群暂无 running 任务；你可以 open_task 新建一份，或直接自己做）')
    expect(getAgent('a1')?.sessions.demo_r1_1?.promptFingerprint).toBe('user\n你是{{sender}}助手')
  })

  it('ask 按 agent skill_groups 追加推荐工具', async () => {
    mkdirSync(join(configDir, 'ws'), { recursive: true })
    saveConfig({
      skill_roots: [],
      skill_groups: { rd: { id: 'rd', name: 'rd', skill_ids: ['hub/union-xxx', 'git-skill'] } },
      prompts: { default: { system_prompt: '角色说明', tools: ['bash'] } },
      agents: [
        {
          id: 'a1',
          name: '联运',
          description: '',
          workspace: join(configDir, 'ws'),
          prompt: 'default',
          prompt_placement: 'user',
          skill_groups: ['rd'],
          prompt_append_skills: true,
          reuse_session: true,
          session_by_sender: false,
          permission_mode: 'danger-full-access',
          session_timeout_minutes: 30,
          concurrency: "serial",
          needs_target_workspace: false,
          sessions: {},
        },
      ],
      skill_apply: {},
      agent_wait_timeout_ms: 180000,
      expert_liveness_max_renew: 3,
      task_round_timeout_ms: 7200000,
      use_hub_experts: true,
    })
    const followups: unknown[] = []
    const svc = createAgentBotService(fakeHost([], idleNow, { followups }))
    svc.registerProvider({ id: 'demo', label: '示例通道' })
    await svc.ask(askReq('t1', 'alice'))
    const payload = followups[0] as { content: Array<{ text: string }> }
    expect(payload.content[0]?.text).toBe('用户[alice]: 你好\n\n角色说明\n\n推荐工具：union-xxx, git-skill\n\n——本群任务板（specs/12）——\n（本群暂无 running 任务；你可以 open_task 新建一份，或直接自己做）')
    expect(getAgent('a1')?.sessions.demo_r1_1?.promptFingerprint).toBe('user\n角色说明\n\n推荐工具：union-xxx, git-skill')
  })

  it('prompt_append_skills=false 不把技能名写进 prompt', async () => {
    mkdirSync(join(configDir, 'ws'), { recursive: true })
    saveConfig({
      skill_roots: [],
      skill_groups: { rd: { id: 'rd', name: 'rd', skill_ids: ['hub/union-xxx'] } },
      prompts: { default: { system_prompt: '角色说明', tools: ['bash'] } },
      agents: [
        {
          id: 'a1',
          name: '联运',
          description: '',
          workspace: join(configDir, 'ws'),
          prompt: 'default',
          prompt_placement: 'user',
          skill_groups: ['rd'],
          prompt_append_skills: false,
          reuse_session: true,
          session_by_sender: false,
          permission_mode: 'danger-full-access',
          session_timeout_minutes: 30,
          concurrency: "serial",
          needs_target_workspace: false,
          sessions: {},
        },
      ],
      skill_apply: {},
      agent_wait_timeout_ms: 180000,
      expert_liveness_max_renew: 3,
      task_round_timeout_ms: 7200000,
      use_hub_experts: true,
    })
    const followups: unknown[] = []
    const svc = createAgentBotService(fakeHost([], idleNow, { followups }))
    svc.registerProvider({ id: 'demo', label: '示例通道' })
    await svc.ask(askReq('t1', 'alice'))
    const payload = followups[0] as { content: Array<{ text: string }> }
    expect(payload.content[0]?.text).toBe('用户[alice]: 你好\n\n角色说明\n\n——本群任务板（specs/12）——\n（本群暂无 running 任务；你可以 open_task 新建一份，或直接自己做）')
    expect(getAgent('a1')?.sessions.demo_r1_1?.promptFingerprint).toBe('user\n角色说明')
  })

  it('校验通过后无 agents 服务显式抛错', async () => {
    mkdirSync(join(configDir, 'ws'), { recursive: true })
    saveConfig({
      skill_roots: [],
      skill_groups: {},
      prompts: {},
      agents: [
        {
          id: 'a1',
          name: '联运',
          description: '',
          workspace: join(configDir, 'ws'),
          prompt: '',
          prompt_placement: 'system',
          skill_groups: [],
          prompt_append_skills: true,
          reuse_session: true,
          session_by_sender: false,
          permission_mode: 'danger-full-access',
          session_timeout_minutes: 30,
          concurrency: "serial",
          needs_target_workspace: false,
          sessions: {},
        },
      ],
      skill_apply: {},
      agent_wait_timeout_ms: 180000,
      expert_liveness_max_renew: 3,
      task_round_timeout_ms: 7200000,
      use_hub_experts: true,
    })
    const svc = createAgentBotService(emptyHostServices())
    svc.registerProvider({ id: 'demo', label: '示例通道' })
    await expect(
      svc.ask({
        agentId: 'a1',
        context: '用户[alice]: 你好',
        meta: {
          traceId: 't1',
          providerId: 'demo',
          sessionParts: { bot_id: 'r1', group_id: '1' },
          sender: 'alice',
        },
      }),
    ).rejects.toThrow(/agents 服务不可用/)
  })

  it('unload dispose 释放本轮 create 的 handle', async () => {
    mkdirSync(join(configDir, 'ws'), { recursive: true })
    saveConfig({
      skill_roots: [],
      skill_groups: {},
      prompts: {},
      agents: [
        {
          id: 'a1',
          name: '联运',
          description: '',
          workspace: join(configDir, 'ws'),
          prompt: '',
          prompt_placement: 'system',
          skill_groups: [],
          prompt_append_skills: true,
          reuse_session: true,
          session_by_sender: false,
          permission_mode: 'danger-full-access',
          session_timeout_minutes: 30,
          concurrency: "serial",
          needs_target_workspace: false,
          sessions: {},
        },
      ],
      skill_apply: {},
      agent_wait_timeout_ms: 180000,
      expert_liveness_max_renew: 3,
      task_round_timeout_ms: 7200000,
      use_hub_experts: true,
    })
    let disposed = 0
    const host = fakeHost([], idleNow)
    const origCreate = host.agents()?.create
    if (origCreate === undefined) throw new Error('test: fakeHost 缺 create')
    const agents = host.agents()
    if (agents === undefined) throw new Error('test: fakeHost 缺 agents')
    agents.create = async (options) => {
      const handle = await origCreate(options)
      return {
        agent: handle.agent,
        async dispose() {
          disposed += 1
          await handle.dispose()
        },
      }
    }
    const svc = createAgentBotService(host)
    svc.registerProvider({ id: 'demo', label: '示例通道' })
    await svc.ask({
      agentId: 'a1',
      context: '用户[alice]: 你好',
      meta: {
        traceId: 't1',
        providerId: 'demo',
        sessionParts: { bot_id: 'r1', group_id: '1' },
        sender: 'alice',
      },
    })
    expect(disposed).toBe(0)
    await svc.dispose()
    expect(disposed).toBe(1)
    await svc.dispose()
    expect(disposed).toBe(1)
  })

  it('未知 agent 显式抛错', async () => {
    const svc = createAgentBotService(emptyHostServices())
    svc.registerProvider({ id: 'demo', label: '示例通道' })
    await expect(svc.ask(askReq('t1', 'alice'))).rejects.toThrow(/未知 agent a1/)
  })

  it('session_by_sender 按人编 key 并写槽', async () => {
    seedRunnableAgent(true, 180000)
    const svc = createAgentBotService(fakeHost([], idleNow))
    svc.registerProvider({ id: 'demo', label: '示例通道' })
    await svc.ask(askReq('t1', 'alice'))
    expect(getAgent('a1')?.sessions.demo_r1_1_alice?.sessionId).toEqual(expect.any(String))
    expect(getAgent('a1')?.sessions.demo_r1_1).toBeUndefined()
    await expect(svc.ask(askReq('t2', ''))).rejects.toThrow(/session_by_sender 需要非空 sender/)
  })

  it('空回复：idle 且无助手文本 → messages=[] pending=null', async () => {
    seedRunnableAgent(false, 180000)
    const svc = createAgentBotService(fakeHost([], idleNow))
    svc.registerProvider({ id: 'demo', label: '示例通道' })
    await expect(svc.ask(askReq('t1', 'alice'))).resolves.toEqual({ messages: [], pending: null })
  })

  it('pending 安全阀到点 reject，不把超时文案塞进 messages', async () => {
    seedRunnableAgent(false, 1000)
    const svc = createAgentBotService(fakeHost([], hangAfterFirstIdle()))
    svc.registerProvider({ id: 'demo', label: '示例通道' })
    const result = await svc.ask(askReq('t1', 'alice'))
    expect(result.messages).toEqual([])
    expect(result.pending).not.toBeNull()
    expect(JSON.stringify(result.pending)).toBe('{}')
    await expect(result.pending).rejects.toThrow(/pending 安全阀超时/)
  })
})

describe('入站登记入站上下文（specs/12 §入站怎么绑任务）', () => {
  /** 两个 agent：a1（被 @ 的）+ a2（可派的专家）。 */
  function seedTwoAgents(useHubExperts: boolean): void {
    mkdirSync(join(configDir, 'ws'), { recursive: true })
    const base = {
      description: '',
      workspace: join(configDir, 'ws'),
      prompt: '',
      prompt_placement: 'system' as const,
      skill_groups: [] as string[],
      prompt_append_skills: true,
      reuse_session: true,
      session_by_sender: false,
      permission_mode: 'danger-full-access' as const,
      session_timeout_minutes: 30,
      concurrency: 'serial' as const,
      needs_target_workspace: false,
      sessions: {},
    }
    saveConfig({
      skill_roots: [],
      skill_groups: {},
      prompts: {},
      agents: [
        { ...base, id: 'a1', name: '联运' },
        { ...base, id: 'a2', name: '设计师' },
      ],
      skill_apply: {},
      agent_wait_timeout_ms: 180000,
      expert_liveness_max_renew: 3,
      task_round_timeout_ms: 7200000,
      use_hub_experts: useHubExperts,
    })
  }

  it('ask 后登记 sender / providerId / sessionParts / originContext', async () => {
    seedTwoAgents(true)
    const svc = createAgentBotService(fakeHost([], idleNow))
    svc.registerProvider({ id: 'demo', label: '示例通道' })
    await svc.ask(askReq('t1', 'alice'))
    const sid = getAgent('a1')?.sessions.demo_r1_1?.sessionId ?? ''
    const ctx = inboundFor(sid)
    expect(ctx?.sender).toBe('alice')
    expect(ctx?.providerId).toBe('demo')
    expect(ctx?.sessionParts).toEqual({ bot_id: 'r1', group_id: '1' })
    expect(ctx?.originContext).toBe('用户[alice]: 你好')
  })

  it('开关默认开：快照 = agents.json 全集，且去掉自己', async () => {
    seedTwoAgents(true)
    let asked = false
    const svc = createAgentBotService(fakeHost([], idleNow))
    svc.registerProvider({
      id: 'demo',
      label: '示例通道',
      listGroupAgents: () => {
        asked = true
        return [{ agentId: 'a2', name: '设计师', description: '' }]
      },
    })
    await svc.ask(askReq('t1', 'alice'))
    const sid = getAgent('a1')?.sessions.demo_r1_1?.sessionId ?? ''
    const snap = inboundFor(sid)?.groupSnapshot ?? []
    expect(snap.map((m) => m.agentId)).toEqual(['a2'])
    expect(asked).toBe(false) // hub 模式不问通道
  })

  it('人 @lead 说完这一轮 → 旧问卷待决自动清掉', async () => {
    seedRunnableAgent(false, 180000)
    const { createTask, readTask, writeTask } = await import('../model/teamwork/task-board.js')
    const t = createTask({
      taskLead: 'a1', sender: 'alice', providerId: 'demo',
      sessionParts: { bot_id: 'r1', group_id: '1' }, originContext: 'c',
      access: 'write', groupSnapshot: [],
    })
    const w = readTask('running', t.taskId)!
    w.pendingHuman = { questions: ['要哪个尺寸？'], askedBy: 'a1', askedAt: 42, toHuman: true }
    writeTask('running', w)

    const svc = createAgentBotService(fakeHost([], idleNow))
    svc.registerProvider({ id: 'demo', label: '示例通道' })
    await svc.ask(askReq('t1', 'alice')) // 人回话（软路由进该单任务槽 → 已绑定）
    expect(readTask('running', t.taskId)?.pendingHuman).toBeUndefined()
  })

  it('开关关闭：问 listGroupAgents，过滤幽灵成员与自己', async () => {
    seedTwoAgents(false)
    let asked = 0
    const svc = createAgentBotService(fakeHost([], idleNow))
    svc.registerProvider({
      id: 'demo',
      label: '示例通道',
      listGroupAgents: () => {
        asked += 1
        return [
          { agentId: 'a2', name: '设计师', description: '' },
          { agentId: 'a1', name: '自己', description: '' },   // 自己 → 去掉
          { agentId: 'ghost', name: '幽灵', description: '' }, // 不在 agents.json → 丢掉
        ]
      },
    })
    await svc.ask(askReq('t1', 'alice'))
    const sid = getAgent('a1')?.sessions.demo_r1_1?.sessionId ?? ''
    const snap = inboundFor(sid)?.groupSnapshot ?? []
    expect(asked).toBe(1)
    expect(snap.map((m) => m.agentId)).toEqual(['a2'])
  })
})
