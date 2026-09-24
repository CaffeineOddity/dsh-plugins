/**
 * ask 入站校验 / sessionKey / 续接 / followup / v1 单条 markdown / pending（G4–G11）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetConfigCache, saveConfig, type AgentConfig } from './config.js'
import {
  collectPendingMessages,
  idleTimedOut,
  planSession,
  prepareAsk,
  remainingMarkdown,
  resolveAgentLifecycle,
  resolveSessionReuse,
  runFollowupTurn,
  settleAskRound,
  summarizeOwnedInterval,
  toMarkdownMessages,
  waitIdleOrTimeout,
  type FollowupAgent,
  type RunEvent,
} from './ask.js'
import type { AgentAskRequest } from '../types.js'

let configDir: string
let prevEnv: string | undefined
let workspace: string

beforeEach(() => {
  prevEnv = process.env.AGENT_BOT_CONFIG_DIR
  configDir = mkdtempSync(join(tmpdir(), 'agentbot-ask-'))
  process.env.AGENT_BOT_CONFIG_DIR = configDir
  resetConfigCache()
  workspace = join(configDir, 'ws-a')
  mkdirSync(workspace, { recursive: true })
  saveConfig({
    skill_roots: [],
    skill_groups: {},
    prompts: {},
    agents: [agent({ id: 'a1', name: '联运', workspace })],
    skill_apply: {},
    expert_liveness_max_renew: 3,
    task_round_timeout_ms: 7200000,
    use_hub_experts: true,
    agent_wait_timeout_ms: 180000,
  })
})

afterEach(() => {
  resetConfigCache()
  if (prevEnv === undefined) delete process.env.AGENT_BOT_CONFIG_DIR
  else process.env.AGENT_BOT_CONFIG_DIR = prevEnv
  rmSync(configDir, { recursive: true, force: true })
})

function agent(partial: Partial<AgentConfig> & Pick<AgentConfig, 'id' | 'name' | 'workspace'>): AgentConfig {
  return {
    description: '',
    prompt: '',
    prompt_placement: 'system',
    skill_groups: [],
    prompt_append_skills: true,
    reuse_session: true,
    session_by_sender: false,
    permission_mode: 'danger-full-access',
    session_timeout_minutes: 30,
    concurrency: 'serial',
    needs_target_workspace: false,
    sessions: {},
    ...partial,
  }
}

function req(overrides: Partial<AgentAskRequest> = {}): AgentAskRequest {
  const { meta, ...rest } = overrides
  return {
    agentId: 'a1',
    context: '用户[alice]: 你好',
    ...rest,
    meta: {
      traceId: 't1',
      providerId: 'demo',
      sessionParts: { bot_id: 'r1', group_id: '6031348' },
      sender: 'alice',
      ...(meta ?? {}),
    },
  }
}

const providers = new Set(['demo'])

describe('prepareAsk 校验', () => {
  it('未注册 provider / 未知 agent / 空 id 显式抛错', () => {
    expect(() => prepareAsk(req(), new Set())).toThrow(/未注册 provider demo/)
    expect(() => prepareAsk(req({ agentId: 'missing' }), providers)).toThrow(/未知 agent missing/)
    expect(() => prepareAsk(req({ agentId: '  ' }), providers)).toThrow(/agentId 不可为空/)
    expect(() => prepareAsk(req({ meta: { ...req().meta, providerId: '' } }), providers)).toThrow(
      /providerId 不可为空/,
    )
    expect(() => prepareAsk(req({ meta: { ...req().meta, traceId: '' } }), providers)).toThrow(/traceId 不可为空/)
  })

  it('workspace 不存在或不是目录则抛错', () => {
    const gone = join(configDir, 'gone')
    saveConfig({
      skill_roots: [],
      skill_groups: {},
      prompts: {},
      agents: [agent({ id: 'a2', name: '空', workspace: gone })],
      skill_apply: {},
    expert_liveness_max_renew: 3,
    task_round_timeout_ms: 7200000,
    use_hub_experts: true,
      agent_wait_timeout_ms: 180000,
    })
    expect(() => prepareAsk(req({ agentId: 'a2' }), providers)).toThrow(/workspace 不存在/)
    const file = join(configDir, 'not-dir')
    writeFileSync(file, 'x', 'utf8')
    saveConfig({
      skill_roots: [],
      skill_groups: {},
      prompts: {},
      agents: [agent({ id: 'a3', name: '文件', workspace: file })],
      skill_apply: {},
    expert_liveness_max_renew: 3,
    task_round_timeout_ms: 7200000,
    use_hub_experts: true,
      agent_wait_timeout_ms: 180000,
    })
    expect(() => prepareAsk(req({ agentId: 'a3' }), providers)).toThrow(/workspace 不是目录/)
  })

  it('通道传入 sessionKey / reset / webhook_url 则抛错', () => {
    expect(() => prepareAsk({ ...req(), sessionKey: 'r1_1' } as AgentAskRequest, providers)).toThrow(
      /禁止传入 sessionKey/,
    )
    expect(() => prepareAsk({ ...req(), reset: true } as AgentAskRequest, providers)).toThrow(/禁止传入 reset/)
    expect(() =>
      prepareAsk(req({ meta: { ...req().meta, webhook_url: 'http://x' } as AgentAskRequest['meta'] }), providers),
    ).toThrow(/禁止 webhook_url/)
    expect(() =>
      prepareAsk(
        req({ meta: { ...req().meta, sessionParts: { bot_id: 'r1', webhook_url: 'http://x' } } }),
        providers,
      ),
    ).toThrow(/禁止字段 webhook_url/)
  })
})

describe('prepareAsk sessionKey', () => {
  it('只在大脑按字母序编 key，不含 providerId', () => {
    const prepared = prepareAsk(req(), providers)
    expect(prepared.sessionKey).toBe('r1_6031348')
    expect(prepared.parts).toEqual({ bot_id: 'r1', group_id: '6031348' })
  })

  it('session_by_sender 并入 sender；空 sender 抛错', () => {
    saveConfig({
      skill_roots: [],
      skill_groups: {},
      prompts: {},
      agents: [agent({ id: 'a1', name: '联运', workspace, session_by_sender: true })],
      skill_apply: {},
    expert_liveness_max_renew: 3,
    task_round_timeout_ms: 7200000,
    use_hub_experts: true,
      agent_wait_timeout_ms: 180000,
    })
    expect(prepareAsk(req(), providers).sessionKey).toBe('r1_6031348_alice')
    expect(() => prepareAsk(req({ meta: { ...req().meta, sender: '' } }), providers)).toThrow(
      /session_by_sender 需要非空 sender/,
    )
  })
})

describe('resolveAgentLifecycle', () => {
  it('live 优先，其次 resume，否则 create', () => {
    expect(resolveAgentLifecycle(true, true)).toBe('live')
    expect(resolveAgentLifecycle(true, false)).toBe('live')
    expect(resolveAgentLifecycle(false, true)).toBe('resume')
    expect(resolveAgentLifecycle(false, false)).toBe('create')
  })
})

describe('resolveSessionReuse', () => {
  const now = 1_700_000_000_000
  const slot = { sessionId: 'sid-old', lastAskAt: now - 10 * 60_000 }
  const reuseBase = {
    reuseSession: true,
    sessionTimeoutMinutes: 30,
    archived: false,
    nowMs: now,
    newSessionId: 'sid-new',
    promptFingerprint: '',
  }

  it('reuse_session=false 每次新建并覆盖槽', () => {
    expect(
      resolveSessionReuse({
        reuseSession: false,
        sessionTimeoutMinutes: 30,
        slot,
        archived: false,
        nowMs: now,
        newSessionId: 'sid-new',
        promptFingerprint: '',
      }),
    ).toEqual({ action: 'create', sessionId: 'sid-new' })
  })

  it('无记录 / 已归档 / 空闲超时则新建', () => {
    expect(resolveSessionReuse({ ...reuseBase, slot: undefined })).toEqual({ action: 'create', sessionId: 'sid-new' })
    expect(resolveSessionReuse({ ...reuseBase, slot, archived: true })).toEqual({ action: 'create', sessionId: 'sid-new' })
    expect(
      resolveSessionReuse({
        ...reuseBase,
        slot: { sessionId: 'sid-old', lastAskAt: now - 31 * 60_000 },
      }),
    ).toEqual({ action: 'create', sessionId: 'sid-new' })
  })

  it('槽在且未超时则复用；0 分钟不因空闲拆', () => {
    expect(resolveSessionReuse({ ...reuseBase, slot })).toEqual({ action: 'reuse', sessionId: 'sid-old' })
    expect(
      resolveSessionReuse({
        ...reuseBase,
        sessionTimeoutMinutes: 0,
        slot: { sessionId: 'sid-old', lastAskAt: now - 24 * 60 * 60_000 },
      }),
    ).toEqual({ action: 'reuse', sessionId: 'sid-old' })
    expect(idleTimedOut(now - 10 * 60_000, now, 30)).toBe(false)
    expect(idleTimedOut(now - 31 * 60_000, now, 30)).toBe(true)
    expect(idleTimedOut(now - 31 * 60_000, now, 0)).toBe(false)
  })

  it('槽上指纹与当前不一致则新建；缺指纹视为一致', () => {
    expect(
      resolveSessionReuse({
        ...reuseBase,
        slot: { sessionId: 'sid-old', lastAskAt: now - 10 * 60_000, promptFingerprint: '旧文' },
        promptFingerprint: '新文',
      }),
    ).toEqual({ action: 'create', sessionId: 'sid-new' })
    expect(
      resolveSessionReuse({
        ...reuseBase,
        slot: { sessionId: 'sid-old', lastAskAt: now - 10 * 60_000, promptFingerprint: '同文' },
        promptFingerprint: '同文',
      }),
    ).toEqual({ action: 'reuse', sessionId: 'sid-old' })
    expect(
      resolveSessionReuse({
        ...reuseBase,
        slot: { sessionId: 'sid-old', lastAskAt: now - 10 * 60_000 },
        promptFingerprint: '新文',
      }),
    ).toEqual({ action: 'reuse', sessionId: 'sid-old' })
  })

  it('清槽后 prepareAsk 视为无记录；槽在则 planSession 复用', () => {
    const prepared = prepareAsk(req(), providers)
    expect(prepared.agent.sessions[prepared.sessionKey]).toBeUndefined()
    expect(planSession(prepared, false, now, 'sid-new')).toEqual({ action: 'create', sessionId: 'sid-new' })
    saveConfig({
      skill_roots: [],
      skill_groups: {},
      prompts: {},
      agents: [
        agent({
          id: 'a1',
          name: '联运',
          workspace,
          sessions: { r1_6031348: { sessionId: 'sid-old', lastAskAt: now - 60_000 } },
        }),
      ],
      skill_apply: {},
    expert_liveness_max_renew: 3,
    task_round_timeout_ms: 7200000,
    use_hub_experts: true,
      agent_wait_timeout_ms: 180000,
    })
    expect(planSession(prepareAsk(req(), providers), false, now, 'sid-new')).toEqual({
      action: 'reuse',
      sessionId: 'sid-old',
    })
  })

  it('改预设正文后 planSession 开新会话', () => {
    saveConfig({
      skill_roots: [],
      skill_groups: {},
      prompts: { default: { system_prompt: '新文', tools: [] } },
      agents: [
        agent({
          id: 'a1',
          name: '联运',
          workspace,
          prompt: 'default',
          sessions: {
            r1_6031348: { sessionId: 'sid-old', lastAskAt: now - 60_000, promptFingerprint: '旧文' },
          },
        }),
      ],
      skill_apply: {},
    expert_liveness_max_renew: 3,
    task_round_timeout_ms: 7200000,
    use_hub_experts: true,
      agent_wait_timeout_ms: 180000,
    })
    expect(planSession(prepareAsk(req(), providers), false, now, 'sid-new')).toEqual({
      action: 'create',
      sessionId: 'sid-new',
    })
  })

  it('改 prompt_placement 后 planSession 开新会话', () => {
    saveConfig({
      skill_roots: [],
      skill_groups: {},
      prompts: { default: { system_prompt: '同文', tools: [] } },
      agents: [
        agent({
          id: 'a1',
          name: '联运',
          workspace,
          prompt: 'default',
          prompt_placement: 'user',
          sessions: {
            r1_6031348: { sessionId: 'sid-old', lastAskAt: now - 60_000, promptFingerprint: '同文' },
          },
        }),
      ],
      skill_apply: {},
    expert_liveness_max_renew: 3,
    task_round_timeout_ms: 7200000,
    use_hub_experts: true,
      agent_wait_timeout_ms: 180000,
    })
    expect(planSession(prepareAsk(req(), providers), false, now, 'sid-new')).toEqual({
      action: 'create',
      sessionId: 'sid-new',
    })
  })

  it('改 skill_groups 后 planSession 开新会话', () => {
    saveConfig({
      skill_roots: [],
      skill_groups: { rd: { id: 'rd', name: 'rd', skill_ids: ['git-skill'] } },
      prompts: { default: { system_prompt: '同文', tools: [] } },
      agents: [
        agent({
          id: 'a1',
          name: '联运',
          workspace,
          prompt: 'default',
          skill_groups: ['rd'],
          sessions: {
            r1_6031348: { sessionId: 'sid-old', lastAskAt: now - 60_000, promptFingerprint: '同文' },
          },
        }),
      ],
      skill_apply: {},
    expert_liveness_max_renew: 3,
    task_round_timeout_ms: 7200000,
    use_hub_experts: true,
      agent_wait_timeout_ms: 180000,
    })
    expect(planSession(prepareAsk(req(), providers), false, now, 'sid-new')).toEqual({
      action: 'create',
      sessionId: 'sid-new',
    })
  })

  it('关掉 prompt_append_skills 后 planSession 开新会话', () => {
    saveConfig({
      skill_roots: [],
      skill_groups: { rd: { id: 'rd', name: 'rd', skill_ids: ['git-skill'] } },
      prompts: { default: { system_prompt: '同文', tools: [] } },
      agents: [
        agent({
          id: 'a1',
          name: '联运',
          workspace,
          prompt: 'default',
          skill_groups: ['rd'],
          prompt_append_skills: false,
          sessions: {
            r1_6031348: {
              sessionId: 'sid-old',
              lastAskAt: now - 60_000,
              promptFingerprint: '同文\n\n推荐工具：git-skill',
            },
          },
        }),
      ],
      skill_apply: {},
    expert_liveness_max_renew: 3,
    task_round_timeout_ms: 7200000,
    use_hub_experts: true,
      agent_wait_timeout_ms: 180000,
    })
    expect(planSession(prepareAsk(req(), providers), false, now, 'sid-new')).toEqual({
      action: 'create',
      sessionId: 'sid-new',
    })
  })
})

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

describe('waitIdleOrTimeout', () => {
  it('立即 idle', async () => {
    expect(await waitIdleOrTimeout(Promise.resolve(), 1000)).toBe('idle')
  })

  it('超时返回 timeout', async () => {
    const never = new Promise<void>(() => undefined)
    expect(await waitIdleOrTimeout(never, 20)).toBe('timeout')
  })

  it('timeoutMs<=0 只等 idle', async () => {
    expect(await waitIdleOrTimeout(Promise.resolve(), 0)).toBe('idle')
  })
})

describe('runFollowupTurn', () => {
  it('上一轮 idle 不消耗本轮超时；超时从 followup 起算', async () => {
    let idleCalls = 0
    let followupAt = 0
    const agent: FollowupAgent = {
      session: { seq: 7, snapshotEvents: () => [] },
      followup() {
        followupAt = Date.now()
      },
      whenIdle() {
        idleCalls += 1
        if (idleCalls === 1) return delay(40)
        return new Promise<void>(() => undefined)
      },
    }
    const started = Date.now()
    const result = await runFollowupTurn(agent, '用户[alice]: 你好', 25)
    expect(result).toEqual({ wait: 'timeout', firstSeq: 7 })
    expect(idleCalls).toBe(2)
    expect(followupAt - started).toBeGreaterThanOrEqual(35)
    expect(Date.now() - followupAt).toBeGreaterThanOrEqual(20)
    expect(Date.now() - started).toBeGreaterThanOrEqual(55)
  })

  it('followup 后很快 idle 则 wait=idle，并记下 firstSeq', async () => {
    const payloads: unknown[] = []
    const agent: FollowupAgent = {
      session: { seq: 3, snapshotEvents: () => [] },
      followup(input) {
        payloads.push(input)
      },
      async whenIdle() {
        return
      },
    }
    const result = await runFollowupTurn(agent, '用户[alice]: 你好', 1000)
    expect(result).toEqual({ wait: 'idle', firstSeq: 3 })
    const payload = payloads[0] as { content: Array<{ text: string }> }
    expect(payload.content[0]?.text).toBe('用户[alice]: 你好')
  })
})

describe('summarizeOwnedInterval', () => {
  it('从 turn/start 起取最后一条非空 assistant 文本', () => {
    const events: RunEvent[] = [
      { seq: 1, type: 'turn/start' },
      { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一段' }] } } },
      { seq: 3, type: 'tool/result' },
      { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '最终答案' }] } } },
    ]
    expect(summarizeOwnedInterval(events, 1)).toBe('最终答案')
  })

  it('firstSeq 之前的事件不计入', () => {
    const events: RunEvent[] = [
      { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '旧' }] } } },
      { seq: 5, type: 'turn/start' },
      { seq: 6, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '新' }] } } },
    ]
    expect(summarizeOwnedInterval(events, 5)).toBe('新')
  })

  it('空文本的 tool-call assistant 不覆盖已有答案；无 turn/start 则空串', () => {
    const events: RunEvent[] = [
      { seq: 1, type: 'turn/start' },
      { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '答案' }] } } },
      { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call' }] } } },
    ]
    expect(summarizeOwnedInterval(events, 1)).toBe('答案')
    expect(
      summarizeOwnedInterval(
        [{ seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '漏' }] } } }],
        1,
      ),
    ).toBe('')
  })
})

describe('toMarkdownMessages', () => {
  it('空文本 → 空数组', () => {
    expect(toMarkdownMessages('')).toEqual([])
  })

  it('非空文本收成单条 markdown', () => {
    expect(toMarkdownMessages('最终答案')).toEqual([
      { kind: 'markdown', text: '最终答案', url: '', atUserIds: [], atAll: false },
    ])
  })
})

describe('remainingMarkdown', () => {
  it('后文空或与首次相同 → 空数组', () => {
    expect(remainingMarkdown('答案', '')).toEqual([])
    expect(remainingMarkdown('答案', '答案')).toEqual([])
    expect(remainingMarkdown('', '')).toEqual([])
  })

  it('后文不同 → 单条 markdown', () => {
    expect(remainingMarkdown('', '后来')).toEqual([
      { kind: 'markdown', text: '后来', url: '', atUserIds: [], atAll: false },
    ])
    expect(remainingMarkdown('先', '后')).toEqual([
      { kind: 'markdown', text: '后', url: '', atUserIds: [], atAll: false },
    ])
  })
})

describe('collectPendingMessages', () => {
  it('二次 idle 给出剩余条', async () => {
    const events: RunEvent[] = [{ seq: 1, type: 'turn/start' }]
    const agent: FollowupAgent = {
      session: { seq: 1, snapshotEvents: () => events },
      followup() {
        return
      },
      async whenIdle() {
        events.push({
          seq: 2,
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: '补发' }] } },
        })
      },
    }
    await expect(collectPendingMessages(agent, 1, '', 1000)).resolves.toEqual([
      { kind: 'markdown', text: '补发', url: '', atUserIds: [], atAll: false },
    ])
  })

  it('安全阀到点 reject；pending 是 Promise 不能当 JSON', async () => {
    const agent: FollowupAgent = {
      session: { seq: 1, snapshotEvents: () => [] },
      followup() {
        return
      },
      whenIdle() {
        return new Promise(() => undefined)
      },
    }
    const pending = collectPendingMessages(agent, 1, '', 20)
    expect(typeof pending.then).toBe('function')
    expect(JSON.stringify(pending)).toBe('{}')
    await expect(pending).rejects.toThrow(/pending 安全阀超时/)
  })
})

describe('settleAskRound', () => {
  it('idle 收口 pending=null，空文本给空 messages', async () => {
    const agent: FollowupAgent = {
      session: { seq: 3, snapshotEvents: () => [] },
      followup() {
        return
      },
      async whenIdle() {
        return
      },
    }
    await expect(settleAskRound(agent, '用户[alice]: 你好', 1000)).resolves.toEqual({
      messages: [],
      pending: null,
    })
  })

  it('首次超时先返回已有条，pending 再 idle 补剩余', async () => {
    const events: RunEvent[] = [
      { seq: 1, type: 'turn/start' },
      { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '先发' }] } } },
    ]
    let idleCalls = 0
    const agent: FollowupAgent = {
      session: { seq: 1, snapshotEvents: () => events },
      followup() {
        return
      },
      whenIdle() {
        idleCalls += 1
        if (idleCalls === 1) return Promise.resolve()
        if (idleCalls === 2) return delay(50)
        events.push({
          seq: 3,
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: '后发' }] } },
        })
        return Promise.resolve()
      },
    }
    const result = await settleAskRound(agent, '用户[alice]: 你好', 20)
    expect(result.messages).toEqual([
      { kind: 'markdown', text: '先发', url: '', atUserIds: [], atAll: false },
    ])
    expect(result.pending).not.toBeNull()
    await expect(result.pending).resolves.toEqual([
      { kind: 'markdown', text: '后发', url: '', atUserIds: [], atAll: false },
    ])
  })

  it('首次超时无正文、安全阀仍未 idle 则 pending reject', async () => {
    let idleCalls = 0
    const agent: FollowupAgent = {
      session: { seq: 1, snapshotEvents: () => [] },
      followup() {
        return
      },
      whenIdle() {
        idleCalls += 1
        if (idleCalls === 1) return Promise.resolve()
        return new Promise(() => undefined)
      },
    }
    const result = await settleAskRound(agent, '用户[alice]: 你好', 20)
    expect(result.messages).toEqual([])
    expect(result.pending).not.toBeNull()
    await expect(result.pending).rejects.toThrow(/pending 安全阀超时/)
  })
})
