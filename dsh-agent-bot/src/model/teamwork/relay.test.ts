/**
 * 中继驱动单测：协作槽 / FIFO 栅栏 / followup 包装。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, resetConfigCache, type AgentConfig } from '../config.js'
import { saveAgent, type AgentWrite } from '../agents.js'
import { buildRelay, isCollabSessionKey, taskSlotKey, wrapDispatchFollowup, writeFenceKey, type RelayHost } from './relay.js'
import { boundTaskId, resetBindingsCache } from './binding.js'

let dir: string
let prevEnv: string | undefined
let bobId = 'bob'

/** 把 agent 落盘（保证 touchSession 能更新 sessions[]）。 */
function persistAgent(): AgentConfig {
  const wrote = saveAgent({
    id: '',
    name: 'Bob',
    description: '',
    workspace: '/tmp/bob-ws',
    prompt: '',
    prompt_placement: 'system',
    skill_groups: [],
    prompt_append_skills: false,
    reuse_session: true,
    session_by_sender: false,
    permission_mode: 'danger-full-access',
    session_timeout_minutes: 30,
    concurrency: 'serial',
    needs_target_workspace: false,
    agent_wait_timeout_ms: 0,
  } satisfies AgentWrite)
  bobId = wrote.agent.id
  return wrote.agent
}

function actAgent(): AgentConfig {
  const found = loadConfig().agents.find((a) => a.id === bobId)
  if (found === undefined) throw new Error('agent bob 未落盘')
  return found
}

beforeEach(() => {
  prevEnv = process.env.AGENT_BOT_CONFIG_DIR
  dir = mkdtempSync(join(tmpdir(), 'relay-test-'))
  process.env.AGENT_BOT_CONFIG_DIR = dir
  resetConfigCache()
  resetBindingsCache()
})

afterEach(() => {
  resetConfigCache()
  resetBindingsCache()
  if (prevEnv === undefined) delete process.env.AGENT_BOT_CONFIG_DIR
  else process.env.AGENT_BOT_CONFIG_DIR = prevEnv
  rmSync(dir, { recursive: true, force: true })
})

describe('taskSlotKey / isCollabSessionKey / writeFenceKey', () => {
  it('前缀隔离通道键', () => {
    expect(taskSlotKey('task_1', 'bob')).toBe('task:task_1:bob')
    expect(isCollabSessionKey('task:x:y')).toBe(true)
    expect(isCollabSessionKey('channel')).toBe(false)
  })

  it('target 优先级：target_workspace > 任务 target > 专家 workspace', () => {
    expect(writeFenceKey('write', '/proj', '/other', '/expert')).toBe('write:/proj')
    expect(writeFenceKey('write', undefined, '/other', '/expert')).toBe('write:/other')
    expect(writeFenceKey('write', undefined, undefined, '/expert')).toBe('write:/expert')
    expect(writeFenceKey('read', undefined, undefined, '/expert')).toBe('read:/expert')
  })
})

describe('wrapDispatchFollowup', () => {
  it('注入 md 全文 + access 说明', () => {
    const out = wrapDispatchFollowup({ instruction: '做 X', mdText: 'md... task_1', access: 'write', targetWorkspace: '/proj' })
    expect(out).toContain('不是在对群友说话')
    expect(out).toContain('task_1')
    expect(out).toContain('/proj')
    expect(out).not.toContain('你的 cwd')
  })

  it('给了任务文件绝对路径就写进 prompt（让专家自己重读）', () => {
    const out = wrapDispatchFollowup({
      instruction: '做 X', mdText: 'md', access: 'read',
      taskPath: '/cfg/jobs/running/task_1.md',
    })
    expect(out).toContain('/cfg/jobs/running/task_1.md')
    expect(out).toContain('可随时重读')
  })
})

describe('buildRelay', () => {
  it('resolveSession 续槽 / 新槽写回', () => {
    const host: RelayHost = {
      ensureAgent: async () => ({ session: { seq: 0, snapshotEvents: () => [] }, followup: () => undefined, whenIdle: async () => undefined }),
      agents: () => undefined,
    }
    const relay = buildRelay(host)
    persistAgent()
    const agent = actAgent()
    const s1 = relay.resolveSession(agent, 'task_1', bobId, 'reuse', 1000)
    expect(s1).toBeTruthy()
    // reuse 再取同槽
    expect(relay.resolveSession(actAgent(), 'task_1', bobId, 'reuse', 1001)).toBe(s1)
    // new 换新 uuid
    expect(relay.resolveSession(actAgent(), 'task_1', bobId, 'new', 1002)).not.toBe(s1)
  })

  it('startTurn 启动专家并 followup 指令', async () => {
    let calledId = ''
    let calledText = ''
    const host: RelayHost = {
      ensureAgent: async (input) => {
        calledId = input.sessionId
        return { session: { seq: 0, snapshotEvents: () => [] }, followup: () => undefined, whenIdle: async () => undefined }
      },
      agents: () => {
        const live = new Map<string, unknown>()
        if (calledId !== '') live.set(calledId, { followup: () => undefined })
        return { get: (id) => live.get(id) }
      },
    }
    const relay = buildRelay(host)
    persistAgent()
    const r = await relay.startTurn({
      agent: actAgent(),
      taskId: 'task_1',
      expertId: bobId,
      instruction: '做 X',
      mdText: 'md',
      access: 'write',
      session: 'reuse',
      nowMs: 1000,
      variables: { sender: 'alice', provider_id: 'demo' },
      promptText: '',
      permissionMode: 'danger-full-access',
    })
    expect(r.kind).toBe('running')
    expect(r.sessionId).toBeTruthy()
    void calledText
  })

  it('startTurn 把协作槽绑到本任务（fiber 绑定，专家不必自己填 taskId）', async () => {
    let calledId = ''
    const host: RelayHost = {
      ensureAgent: async (input) => {
        calledId = input.sessionId
        return { session: { seq: 0, snapshotEvents: () => [] }, followup: () => undefined, whenIdle: async () => undefined }
      },
      agents: () => ({ get: (id: string) => (id === calledId ? { followup: () => undefined } : undefined) }),
    }
    const relay = buildRelay(host)
    persistAgent()
    const r = await relay.startTurn({
      agent: actAgent(),
      taskId: 'task_1',
      expertId: bobId,
      instruction: '做 X',
      mdText: 'md',
      access: 'read',
      session: 'reuse',
      nowMs: 1000,
      variables: { sender: 'alice', provider_id: 'demo' },
      promptText: '',
      permissionMode: 'danger-full-access',
    })
    expect(boundTaskId(r.sessionId)).toBe('task_1')
  })
})