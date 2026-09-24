/**
 * 巡检器单测：状态机判定 + **真跑一轮**（tickOnce）覆盖叫醒链。
 * 假 host：只实现 ensureAgent / agents().get / deliver，不拉真 agent。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resetConfigCache } from '../config.js'
import { getAgent as getAgentConfig, saveAgent, touchSession } from '../agents.js'
import { writeTask, type TaskBoard, type Assignee } from './task-board.js'
import { bindSession, boundTaskId, resetBindingsCache } from './binding.js'
import { assigneeOf, createPatrol, hasPendingDownstream, shouldDeliver, wakeSessionIdFor, wakeText } from './patrol.js'
import type { AgentLike } from '../runtime.js'

let dir: string
let prevEnv: string | undefined

function mkAgent(name: string, slots: Array<{ key: string; sessionId: string }> = [], sessionBySender = false): string {
  const wrote = saveAgent({
    id: '',
    name,
    description: '',
    workspace: join(dir, name),
    prompt: '',
    prompt_placement: 'system',
    skill_groups: [],
    prompt_append_skills: false,
    reuse_session: true,
    session_by_sender: sessionBySender,
    permission_mode: 'danger-full-access',
    session_timeout_minutes: 30,
    concurrency: 'serial',
    needs_target_workspace: false,
  })
  for (const s of slots) touchSession(wrote.agent.id, s.key, s.sessionId, 1, '')
  return wrote.agent.id
}

function task(over: Partial<TaskBoard> = {}): TaskBoard {
  return {
    taskId: 'task_t1',
    taskLead: 'lead',
    sender: 'alice',
    providerId: 'demo',
    sessionParts: { bot_id: 'b1', group_id: 'g1' },
    originContext: '原始',
    access: 'write',
    target: '/tmp/proj',
    createdAt: Date.now(),
    deadlineAt: Date.now() + 60_000,
    groupSnapshot: [{ agentId: 'lead', name: 'Lead', description: '' }],
    assignees: [],
    body: '# 海报\n',
    ...over,
  }
}

function assignee(over: Partial<Assignee> = {}): Assignee {
  return {
    expertId: 'e1',
    expertName: 'E',
    dispatchedBy: 'lead',
    dispatchedByName: 'Lead',
    sessionId: 's',
    access: 'write',
    status: 'running',
    wake: true,
    ...over,
  }
}

/** 假 host：记录 followup 到的 sessionId；agents().get 只看注册过的 id。 */
function fakeHost(live: string[], delivered: Array<{ providerId: string; text: string[] }> = []) {
  const woken: Array<{ sessionId: string; text: string }> = []
  const host = {
    async ensureAgent(input: { sessionId: string }): Promise<AgentLike> {
      if (!live.includes(input.sessionId)) live.push(input.sessionId)
      return {} as AgentLike
    },
    agents: () => ({
      get: (sessionId: string) => (live.includes(sessionId) ? ({ whenIdle: () => Promise.resolve() } as unknown as AgentLike) : undefined),
    }),
    async deliver(providerId: string, _sessionParts: Record<string, string>, messages: Array<{ text: string }>) {
      delivered.push({ providerId, text: messages.map((m) => m.text) })
    },
  }
  // followup 由 patrol 内部 live.followup 调用 → 用 whenIdle 对象挂 followup
  const origAgents = host.agents
  host.agents = () => ({
    get: (sessionId: string) => {
      if (!live.includes(sessionId)) return undefined
      return {
        whenIdle: () => Promise.resolve(),
        followup: (msg: { content: Array<{ text: string }> }) => {
          woken.push({ sessionId, text: msg.content[0]?.text ?? '' })
        },
      } as unknown as AgentLike
    },
  })
  void origAgents
  return { host, woken, delivered }
}

function loadAgent(id: string) {
  const cfg = getAgentConfig(id)
  if (cfg === undefined) throw new Error(`agent ${id} 未落盘`)
  return cfg
}

beforeEach(() => {
  prevEnv = process.env.AGENT_BOT_CONFIG_DIR
  dir = mkdtempSync(join(tmpdir(), 'patrol-test-'))
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

describe('wakeSessionIdFor', () => {
  it('被派专家 → 用协作槽会话 id（不是槽 key）', () => {
    const id = mkAgent('B', [{ key: 'task:t1:b', sessionId: 'sess-collab-b' }])
    const t = task({ assignees: [assignee({ expertId: id, sessionId: 'sess-collab-b' })] })
    expect(wakeSessionIdFor(t, id)).toBe('sess-collab-b')
  })

  it('纯被派、没有通道槽的中间层也叫得醒', () => {
    const id = mkAgent('B', [{ key: 'task:t1:b', sessionId: 'sess-collab-b' }])
    const t = task({ assignees: [assignee({ expertId: id, sessionId: 'sess-collab-b' })] })
    expect(loadAgent(id).sessions['task:t1:b']?.sessionId).toBe('sess-collab-b')
    expect(wakeSessionIdFor(t, id)).toBe('sess-collab-b')
  })

  it('taskLead → 按任务的 providerId/sessionParts 反推通道槽，取 sessionId', () => {
    // encodeSessionKey 按 key 字母序连接值：bot_id=b1, group_id=g1 -> 'b1_g1'
    const id = mkAgent('A', [{ key: 'b1_g1', sessionId: 'sess-chan-a' }])
    const t = task({ taskLead: id, sessionParts: { bot_id: 'b1', group_id: 'g1' } })
    expect(wakeSessionIdFor(t, id)).toBe('sess-chan-a')
  })

  it('session_by_sender=true 时带上 sender 再定位', () => {
    const id = mkAgent('A', [{ key: 'b1_g1_alice', sessionId: 'sess-chan-alice' }], true)
    const t = task({ taskLead: id, sender: 'alice', sessionParts: { bot_id: 'b1', group_id: 'g1' } })
    expect(wakeSessionIdFor(t, id)).toBe('sess-chan-alice')
  })

  it('多群时不乱挑：只认任务那条群', () => {
    const id = mkAgent('A', [
      { key: 'b1_g_other', sessionId: 'sess-other-group' },
      { key: 'b1_g1', sessionId: 'sess-right-group' },
    ])
    const t = task({ taskLead: id, sessionParts: { bot_id: 'b1', group_id: 'g1' } })
    expect(wakeSessionIdFor(t, id)).toBe('sess-right-group')
  })

  it('没有对应槽 → undefined（调用方跳过）', () => {
    const id = mkAgent('A', [{ key: 'b1_other', sessionId: 'sess-x' }])
    const t = task({ taskLead: id, sessionParts: { bot_id: 'b1', group_id: 'g1' } })
    expect(wakeSessionIdFor(t, id)).toBeUndefined()
  })
})

describe('hasPendingDownstream', () => {
  it('有下游还在跑 → true（B 不算做完）', () => {
    const t = task({
      assignees: [
        assignee({ expertId: 'B', status: 'idle' }),
        assignee({ expertId: 'C', dispatchedBy: 'B', status: 'running' }),
      ],
    })
    expect(hasPendingDownstream(t, 'B')).toBe(true)
  })
  it('下游终态但上报还没消费（wake=true）→ 仍算没上报完', () => {
    const t = task({
      assignees: [
        assignee({ expertId: 'B', status: 'idle' }),
        assignee({ expertId: 'C', dispatchedBy: 'B', status: 'idle', wake: true }),
      ],
    })
    expect(hasPendingDownstream(t, 'B')).toBe(true)
  })
  it('下游全终态且上报已消费 → false', () => {
    const t = task({
      assignees: [
        assignee({ expertId: 'B', status: 'idle' }),
        assignee({ expertId: 'C', dispatchedBy: 'B', status: 'idle', wake: false }),
      ],
    })
    expect(hasPendingDownstream(t, 'B')).toBe(false)
  })
})

describe('wakeText', () => {
  it('点名谁做完了', () => {
    const t = task({ assignees: [assignee({ expertId: 'C', expertName: '设计师', status: 'idle' })] })
    expect(wakeText(t, [t.assignees[0]!])).toContain('设计师 已完成')
  })
  it('失败也说清楚', () => {
    const t = task({ assignees: [assignee({ expertId: 'C', expertName: '设计师', status: 'failed' })] })
    expect(wakeText(t, [t.assignees[0]!])).toContain('设计师 失败')
  })
})

describe('assigneeOf / shouldDeliver', () => {
  it('assignee 命中 / 未命中', () => {
    const t = task({ assignees: [assignee({ expertId: 'e1' })] })
    expect(assigneeOf(t, 'e1')?.status).toBe('running')
    expect(assigneeOf(t, 'ghost')).toBeUndefined()
  })
  it('shouldDeliver：无专家无待决 false；有专家 true；有待决 true', () => {
    expect(shouldDeliver(task())).toBe(false)
    expect(shouldDeliver(task({ assignees: [assignee({ dispatchedBy: '', wake: false })] }))).toBe(true)
    expect(shouldDeliver(task({ pendingHuman: { questions: ['q'], askedBy: 'e', askedAt: 1 } }))).toBe(true)
  })
})

describe('tickOnce 叫醒链（A→B→C）', () => {
  it('C 完成 → 叫醒 B（用 B 的协作会话）；本级未齐不叫 A', async () => {
    const a = mkAgent('A', [{ key: 'b1_g1', sessionId: 'sess-a' }])
    const b = mkAgent('B', [{ key: 'task:task_t1:B', sessionId: 'sess-b' }])
    const c = mkAgent('C', [{ key: 'task:task_t1:C', sessionId: 'sess-c' }])
    writeTask('running', task({
      taskId: 'task_t1',
      taskLead: a,
      assignees: [
        assignee({ expertId: b, expertName: 'B', dispatchedBy: a, sessionId: 'sess-b', status: 'idle', wake: true }),
        assignee({ expertId: c, expertName: 'C', dispatchedBy: b, sessionId: 'sess-c', status: 'idle', wake: true }),
      ],
    }))
    const { host, woken } = fakeHost(['sess-a', 'sess-b', 'sess-c'])
    const patrol = createPatrol(host, { windowMs: 1, intervalMs: 1 })
    await patrol.tickOnce()

    // B 的下游 C 已终态 → 叫醒 B；A 不该被叫（B 自己还没做综合）
    expect(woken.map((w) => w.sessionId)).toEqual(['sess-b'])
    expect(woken[0]?.text).toContain('C 已完成')
  })

  it('B 派完 C 但 C 还在跑 → 谁都不叫（不提前叫醒 A）', async () => {
    const a = mkAgent('A', [{ key: 'b1_g1', sessionId: 'sess-a' }])
    const b = mkAgent('B', [{ key: 'task:task_t1:B', sessionId: 'sess-b' }])
    const c = mkAgent('C', [{ key: 'task:task_t1:C', sessionId: 'sess-c' }])
    writeTask('running', task({
      taskId: 'task_t1',
      taskLead: a,
      assignees: [
        assignee({ expertId: b, expertName: 'B', dispatchedBy: a, sessionId: 'sess-b', status: 'idle', wake: true }),
        assignee({ expertId: c, expertName: 'C', dispatchedBy: b, sessionId: 'sess-c', status: 'running', wake: true }),
      ],
    }))
    const { host, woken } = fakeHost(['sess-a', 'sess-b', 'sess-c'])
    const patrol = createPatrol(host, { windowMs: 1, intervalMs: 1 })
    await patrol.tickOnce()
    expect(woken).toEqual([])
  })

  it('全终态 → 叫醒 taskLead 综合；同状态再跑不重复叫', async () => {
    const a = mkAgent('A', [{ key: 'b1_g1', sessionId: 'sess-a' }])
    const b = mkAgent('B', [{ key: 'task:task_t1:B', sessionId: 'sess-b' }])
    writeTask('running', task({
      taskId: 'task_t1',
      taskLead: a,
      assignees: [assignee({ expertId: b, expertName: 'B', dispatchedBy: a, sessionId: 'sess-b', status: 'idle', wake: true })],
    }))
    const { host, woken } = fakeHost(['sess-a', 'sess-b'])
    const patrol = createPatrol(host, { windowMs: 1, intervalMs: 1 })
    await patrol.tickOnce()
    await patrol.tickOnce()
    await patrol.tickOnce()
    expect(woken.map((w) => w.sessionId)).toEqual(['sess-a']) // 只叫一次
  })

  it('待决 → 叫醒 taskLead 拍板，也只叫一次', async () => {
    const a = mkAgent('A', [{ key: 'b1_g1', sessionId: 'sess-a' }])
    writeTask('running', task({
      taskId: 'task_t1',
      taskLead: a,
      pendingHuman: { questions: ['要哪个尺寸？'], askedBy: 'B', askedAt: 7 },
    }))
    const { host, woken } = fakeHost(['sess-a'])
    const patrol = createPatrol(host, { windowMs: 1, intervalMs: 1 })
    await patrol.tickOnce()
    await patrol.tickOnce()
    expect(woken.map((w) => w.sessionId)).toEqual(['sess-a'])
  })

  it('墙钟到点 → deliver「处理超时」并移进 done/，同时解绑', async () => {
    const a = mkAgent('A', [{ key: 'b1_g1', sessionId: 'sess-a' }])
    const b = mkAgent('B', [{ key: 'task:task_t1:B', sessionId: 'sess-b' }])
    bindSession('sess-b', 'task_t1')
    writeTask('running', task({
      taskId: 'task_t1',
      taskLead: a,
      deadlineAt: Date.now() - 1,
      assignees: [assignee({ expertId: b, expertName: 'B', dispatchedBy: a, sessionId: 'sess-b', status: 'running', wake: true })],
    }))
    const { host, delivered } = fakeHost(['sess-a', 'sess-b'])
    const patrol = createPatrol(host, { windowMs: 1, intervalMs: 1 })
    await patrol.tickOnce()
    expect(delivered[0]?.text[0]).toBe('处理超时')
    expect(boundTaskId('sess-b')).toBeUndefined()
  })
})
