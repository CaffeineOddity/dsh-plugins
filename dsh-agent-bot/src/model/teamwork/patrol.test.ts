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
import { readTask, writeTask, type TaskBoard, type Assignee } from './task-board.js'
import { bindSession, boundTaskId, resetBindingsCache } from './binding.js'
import { assigneeOf, createPatrol, hasPendingDownstream, shouldDeliver, wakeSessionIdFor, wakeText } from './patrol.js'
import { taskSlotKey } from './relay.js'
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
function fakeHost(
  live: string[],
  delivered: Array<{ providerId: string; text: string[] }> = [],
  eventsBySession: Record<string, Array<{ seq: number; type: string; data?: unknown }>> = {},
  busy: string[] = [],
  onFollowup?: (sessionId: string) => void,
  cancelled: string[] = [],
) {
  const woken: Array<{ sessionId: string; text: string }> = []
  const host = {
    async ensureAgent(input: { sessionId: string }): Promise<AgentLike> {
      if (!live.includes(input.sessionId)) live.push(input.sessionId)
      return {} as AgentLike
    },
    agents: () => ({
      get: (sessionId: string) => {
        if (!live.includes(sessionId)) return undefined
        return {
          cancel: () => { cancelled.push(sessionId) },
          whenIdle: () => (busy.includes(sessionId) ? new Promise<void>(() => undefined) : Promise.resolve()),
          followup: (msg: { content: Array<{ text: string }> }) => {
            woken.push({ sessionId, text: msg.content[0]?.text ?? '' })
            onFollowup?.(sessionId)
          },
          session: { seq: 0, snapshotEvents: () => eventsBySession[sessionId] ?? [] },
        } as unknown as AgentLike
      },
    }),
    async deliver(providerId: string, _sessionParts: Record<string, string>, messages: Array<{ text: string }>) {
      delivered.push({ providerId, text: messages.map((m) => m.text) })
    },
  }
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
    // encodeSessionKey = <providerId>_<按 key 字母序的值>：demo + b1,g1 -> 'demo_b1_g1'
    const id = mkAgent('A', [{ key: 'demo_b1_g1', sessionId: 'sess-chan-a' }])
    const t = task({ taskLead: id, sessionParts: { bot_id: 'b1', group_id: 'g1' } })
    expect(wakeSessionIdFor(t, id)).toBe('sess-chan-a')
  })

  it('session_by_sender=true 时带上 sender 再定位', () => {
    const id = mkAgent('A', [{ key: 'demo_b1_g1_alice', sessionId: 'sess-chan-alice' }], true)
    const t = task({ taskLead: id, sender: 'alice', sessionParts: { bot_id: 'b1', group_id: 'g1' } })
    expect(wakeSessionIdFor(t, id)).toBe('sess-chan-alice')
  })

  it('多群时不乱挑：只认任务那条群', () => {
    const id = mkAgent('A', [
      { key: 'demo_b_g_other', sessionId: 'sess-other-group' },
      { key: 'demo_b1_g1', sessionId: 'sess-right-group' },
    ])
    const t = task({ taskLead: id, sessionParts: { bot_id: 'b1', group_id: 'g1' } })
    expect(wakeSessionIdFor(t, id)).toBe('sess-right-group')
  })

  it('有任务槽 → 优先用任务槽（入站软路由把它放进来的那条）', () => {
    const id = mkAgent('A', [{ key: 'demo_b1_g1', sessionId: 'sess-chan' }])
    touchSession(id, taskSlotKey('task_t1', id), 'sess-task', 1, '')
    const t = task({ taskLead: id, sessionParts: { bot_id: 'b1', group_id: 'g1' } })
    expect(wakeSessionIdFor(t, id)).toBe('sess-task')
  })

  it('没有对应槽 → undefined（调用方跳过）', () => {
    const id = mkAgent('A', [{ key: 'demo_b_other', sessionId: 'sess-x' }])
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
    const a = mkAgent('A', [{ key: 'demo_b1_g1', sessionId: 'sess-a' }])
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
    const patrol = createPatrol(host, { windowMs: 1 })
    await patrol.tickOnce()

    // B 的下游 C 已终态 → 叫醒 B；A 不该被叫（B 自己还没做综合）
    expect(woken.map((w) => w.sessionId)).toEqual(['sess-b'])
    expect(woken[0]?.text).toContain('C 已完成')
  })

  it('B 派完 C 但 C 还在跑 → 谁都不叫（不提前叫醒 A）', async () => {
    const a = mkAgent('A', [{ key: 'demo_b1_g1', sessionId: 'sess-a' }])
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
    const patrol = createPatrol(host, { windowMs: 1 })
    await patrol.tickOnce()
    expect(woken).toEqual([])
  })

  it('全终态 → 叫醒 taskLead 综合；同状态再跑不重复叫', async () => {
    const a = mkAgent('A', [{ key: 'demo_b1_g1', sessionId: 'sess-a' }])
    const b = mkAgent('B', [{ key: 'task:task_t1:B', sessionId: 'sess-b' }])
    writeTask('running', task({
      taskId: 'task_t1',
      taskLead: a,
      assignees: [assignee({ expertId: b, expertName: 'B', dispatchedBy: a, sessionId: 'sess-b', status: 'idle', wake: true })],
    }))
    const { host, woken } = fakeHost(['sess-a', 'sess-b'])
    const patrol = createPatrol(host, { windowMs: 1 })
    await patrol.tickOnce()
    await patrol.tickOnce()
    await patrol.tickOnce()
    expect(woken.map((w) => w.sessionId)).toEqual(['sess-a']) // 只叫一次
  })

  it('待决 → 叫醒 taskLead 拍板，也只叫一次', async () => {
    const a = mkAgent('A', [{ key: 'demo_b1_g1', sessionId: 'sess-a' }])
    writeTask('running', task({
      taskId: 'task_t1',
      taskLead: a,
      pendingHuman: { questions: ['要哪个尺寸？'], askedBy: 'B', askedAt: 7 },
    }))
    const { host, woken } = fakeHost(['sess-a'])
    const patrol = createPatrol(host, { windowMs: 1 })
    await patrol.tickOnce()
    await patrol.tickOnce()
    expect(woken.map((w) => w.sessionId)).toEqual(['sess-a'])
  })

  it('墙钟到点但专家还在跑 → 顺延墙钟 + 一条进度反馈，不移 done', async () => {
    const a = mkAgent('A', [{ key: 'demo_b1_g1', sessionId: 'sess-a' }])
    const b = mkAgent('B', [{ key: 'task:task_t1:B', sessionId: 'sess-b' }])
    const past = Date.now() - 1
    writeTask('running', task({
      taskId: 'task_t1',
      taskLead: a,
      deadlineAt: past,
      assignees: [assignee({ expertId: b, expertName: 'B', dispatchedBy: a, sessionId: 'sess-b', status: 'running', wake: true })],
    }))
    const { host, delivered } = fakeHost(['sess-a', 'sess-b'])
    const patrol = createPatrol(host, { windowMs: 1 })
    await patrol.tickOnce()
    expect(delivered[0]?.text[0]).toContain('还在做')
    const back = readTask('running', 'task_t1')
    expect(back).toBeDefined() // 没被移走
    expect(back!.deadlineAt).toBeGreaterThan(past)
    // 同一 deadlineAt 再跑不重复发
    await patrol.tickOnce()
    expect(delivered).toHaveLength(1)
  })

  it('墙钟到点、专家救不动（不在 agents.json）→ 交回给人拍板，任务留在 running/', async () => {
    const a = mkAgent('A', [{ key: 'demo_b1_g1', sessionId: 'sess-a' }])
    writeTask('running', task({
      taskId: 'task_t1',
      taskLead: a,
      deadlineAt: Date.now() - 1,
      assignees: [assignee({ expertId: 'ghost', expertName: '幽灵', dispatchedBy: a, sessionId: 'sess-x', status: 'running', wake: true })],
    }))
    const { host, delivered } = fakeHost(['sess-a']) // 专家会话不在线且救不动
    const patrol = createPatrol(host, { windowMs: 1 })
    await patrol.tickOnce()
    expect(delivered[0]?.text[0]).toContain('需要你确认')
    expect(readTask('running', 'task_t1')).toBeDefined()
  })

  it('全终态 → 收口：叫醒 lead、取它这轮产出交付、移 done/ 并解绑', async () => {
    const a = mkAgent('A', [{ key: 'demo_b1_g1', sessionId: 'sess-a' }])
    const b = mkAgent('B', [{ key: 'task:task_t1:B', sessionId: 'sess-b' }])
    bindSession('sess-b', 'task_t1')
    bindSession('sess-a', 'task_t1')
    writeTask('running', task({
      taskId: 'task_t1',
      taskLead: a,
      assignees: [assignee({ expertId: b, expertName: 'B', dispatchedBy: a, sessionId: 'sess-b', status: 'idle', wake: true })],
    }))
    const { host, delivered } = fakeHost(['sess-a', 'sess-b'], [], {
      'sess-a': [
        { seq: 1, type: 'turn/start' },
        { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '海报已出好，见附件' }] } } },
      ],
    })
    const patrol = createPatrol(host, { windowMs: 50 })
    await patrol.tickOnce()
    await patrol.flush()
    expect(delivered[0]?.text[0]).toContain('海报已出好')
    expect(readTask('running', 'task_t1')).toBeUndefined()
    expect(readTask('done', 'task_t1')).toBeDefined()
    expect(boundTaskId('sess-b')).toBeUndefined()
  })

  it('中间层在等下游（waiting）→ 下游终态后恢复 running 并叫醒它，不叫 A', async () => {
    const a = mkAgent('A', [{ key: 'demo_b1_g1', sessionId: 'sess-a' }])
    const b = mkAgent('B', [{ key: 'task:task_t1:B', sessionId: 'sess-b' }])
    const c = mkAgent('C', [{ key: 'task:task_t1:C', sessionId: 'sess-c' }])
    writeTask('running', task({
      taskId: 'task_t1',
      taskLead: a,
      assignees: [
        assignee({ expertId: b, expertName: 'B', dispatchedBy: a, sessionId: 'sess-b', status: 'waiting', wake: true }),
        assignee({ expertId: c, expertName: 'C', dispatchedBy: b, sessionId: 'sess-c', status: 'idle', wake: true }),
      ],
    }))
    const { host, woken } = fakeHost(['sess-a', 'sess-b', 'sess-c'], [], {}, ['sess-b'])
    const patrol = createPatrol(host, { windowMs: 1 })
    await patrol.tickOnce()
    expect(woken.map((w) => w.sessionId)).toEqual(['sess-b'])
    const back = readTask('running', 'task_t1')
    expect(back?.assignees.find((x) => x.expertId === b)?.status).toBe('running') // 恢复了
  })

  it('事件快路径：会话变 idle 立刻转态并上报（不等轮询）', async () => {
    const a = mkAgent('A', [{ key: 'demo_b1_g1', sessionId: 'sess-a' }])
    const b = mkAgent('B', [{ key: 'task:task_t1:B', sessionId: 'sess-b' }])
    writeTask('running', task({
      taskId: 'task_t1',
      taskLead: a,
      assignees: [assignee({ expertId: b, expertName: 'B', dispatchedBy: a, sessionId: 'sess-b', status: 'running', wake: true })],
    }))
    // A 有自己的通道会话；B 的协作会话在跑（busy）→ 模拟「只有 B 做完」这一事件
    const { host, woken } = fakeHost(['sess-a', 'sess-b'], [], {}, [])
    const patrol = createPatrol(host, { windowMs: 1 })
    await patrol.reconcile('sess-b')
    // B 被转成 idle 并上报给 A（A 的通道会话被叫醒）
    const back = readTask('running', 'task_t1')
    expect(back?.assignees.find((x) => x.expertId === b)?.status).toBe('idle')
    expect(woken.map((w) => w.sessionId)).toContain('sess-a')
  })

  it('墙钟由定时器触发（无轮询）：到点自动顺延并给人进度反馈', async () => {
    const a = mkAgent('A', [{ key: 'demo_b1_g1', sessionId: 'sess-a' }])
    const b = mkAgent('B', [{ key: 'task:task_t1:B', sessionId: 'sess-b' }])
    const past = Date.now() - 1
    writeTask('running', task({
      taskId: 'task_t1',
      taskLead: a,
      deadlineAt: past,
      assignees: [assignee({ expertId: b, expertName: 'B', dispatchedBy: a, sessionId: 'sess-b', status: 'running', wake: true })],
    }))
    const { host, delivered } = fakeHost(['sess-a', 'sess-b'], [], {}, ['sess-b'])
    const patrol = createPatrol(host, { windowMs: 1 })
    await patrol.start() // 启动补扫 + 建定时器；之后没有任何轮询
    await new Promise((r) => setTimeout(r, 30))
    expect(delivered[0]?.text[0]).toContain('还在做')
    expect(readTask('running', 'task_t1')!.deadlineAt).toBeGreaterThan(past)
    patrol.stop()
  })

  it('给人发的问卷（toHuman）→ deliver 问题 + 墙钟顺延成「发出时刻 + 一个墙钟」', async () => {
    const a = mkAgent('A', [{ key: 'demo_b1_g1', sessionId: 'sess-a' }])
    const b = mkAgent('B', [{ key: 'task:task_t1:B', sessionId: 'sess-b' }])
    const past = Date.now() - 1
    writeTask('running', task({
      taskId: 'task_t1',
      taskLead: a,
      deadlineAt: past,
      assignees: [assignee({ expertId: b, expertName: 'B', dispatchedBy: a, sessionId: 'sess-b', status: 'idle', wake: false })],
      pendingHuman: { questions: ['要哪个尺寸？'], askedBy: a, askedAt: 123, toHuman: true },
    }))
    const { host, delivered } = fakeHost(['sess-a', 'sess-b'])
    const patrol = createPatrol(host, { windowMs: 1 })
    await patrol.tickOnce()
    expect(delivered[0]?.text[0]).toContain('要哪个尺寸？')
    expect(delivered[0]?.text[0]).toContain('@' + a)
    const back = readTask('running', 'task_t1')!
    expect(back.deadlineAt).toBeGreaterThan(past)          // 问卷发出 → 顺延
    expect(back.deadlineAt - Date.now()).toBeGreaterThan(60_000) // 是一个完整墙钟（不是 0）
    // 同一 askedAt 不重复发
    await patrol.tickOnce()
    expect(delivered).toHaveLength(1)
  })

  it('上抛给 lead 的待决：lead 答完后自动清掉（不靠模型记得 clear_pending）', async () => {
    const a = mkAgent('A', [{ key: 'demo_b1_g1', sessionId: 'sess-a' }])
    const b = mkAgent('B', [{ key: 'task:task_t1:B', sessionId: 'sess-b' }])
    writeTask('running', task({
      taskId: 'task_t1',
      taskLead: a,
      assignees: [assignee({ expertId: b, expertName: 'B', dispatchedBy: a, sessionId: 'sess-b', status: 'idle', wake: false })],
      pendingHuman: { questions: ['用哪个字体？'], askedBy: b, askedAt: 555 },
    }))
    const { host, woken } = fakeHost(['sess-a', 'sess-b'])
    const patrol = createPatrol(host, { windowMs: 50 })
    await patrol.tickOnce()
    await patrol.flush() // 等「叫醒 lead → 等它答完 → 清待决」这个后台 job
    expect(woken.map((w) => w.sessionId)).toContain('sess-a') // 叫醒了 lead
    expect(readTask('running', 'task_t1')?.pendingHuman).toBeUndefined() // 自动清掉
  })

  it('lead 这轮又问了新问题（askedAt 变了）→ 保留新的待决', async () => {
    const a = mkAgent('A', [{ key: 'demo_b1_g1', sessionId: 'sess-a' }])
    const b = mkAgent('B', [{ key: 'task:task_t1:B', sessionId: 'sess-b' }])
    writeTask('running', task({
      taskId: 'task_t1',
      taskLead: a,
      assignees: [assignee({ expertId: b, expertName: 'B', dispatchedBy: a, sessionId: 'sess-b', status: 'idle', wake: false })],
      pendingHuman: { questions: ['用哪个字体？'], askedBy: b, askedAt: 555 },
    }))
    // lead 那轮里改成新问题（模拟 ask_human 写了新的 askedAt）
    const { host } = fakeHost(['sess-a', 'sess-b'], [], {
      'sess-a': [{ seq: 1, type: 'turn/start' }],
    }, [], () => {
      const t = readTask('running', 'task_t1')!
      t.pendingHuman = { questions: ['要哪个尺寸？'], askedBy: a, askedAt: 999, toHuman: true }
      writeTask('running', t)
    })
    const patrol = createPatrol(host, { windowMs: 50 })
    await patrol.tickOnce()
    await patrol.flush()
    expect(readTask('running', 'task_t1')?.pendingHuman?.askedAt).toBe(999) // 新的还在
  })

  it('专家卡在等审批 → 标 need_decision + 通知人（只发一次）；批准后回到 running', async () => {
    const a = mkAgent('A', [{ key: 'demo_b1_g1', sessionId: 'sess-a' }])
    const b = mkAgent('B', [{ key: 'task:task_t1:B', sessionId: 'sess-b' }])
    const bEvents: Array<{ seq: number; type: string; data?: unknown }> = [
      { seq: 1, type: 'turn/start' },
      { seq: 2, type: 'approval/asked', data: { id: 'ap1', toolName: 'write_file', reason: '要写工作区外文件' } },
    ]
    writeTask('running', task({
      taskId: 'task_t1',
      taskLead: a,
      assignees: [assignee({ expertId: b, expertName: 'B', dispatchedBy: a, sessionId: 'sess-b', status: 'running', wake: true })],
    }))
    const { host, delivered } = fakeHost(['sess-a', 'sess-b'], [], { 'sess-b': bEvents }, ['sess-b'])
    const patrol = createPatrol(host, { windowMs: 1 })

    await patrol.tickOnce()
    expect(readTask('running', 'task_t1')?.assignees[0]?.status).toBe('need_decision')
    expect(delivered[0]?.text[0]).toContain('等你批准')
    expect(delivered[0]?.text[0]).toContain('write_file')

    await patrol.tickOnce() // 仍卡着 → 不重复通知
    expect(delivered).toHaveLength(1)

    // 人批准了 → 会话日志出现配对的 decided → 回到 running
    bEvents.push({ seq: 3, type: 'approval/decided', data: { id: 'ap1', outcome: 'allowed-once' } })
    await patrol.tickOnce()
    expect(readTask('running', 'task_t1')?.assignees[0]?.status).toBe('running')
  })

  it('只有专家在等审批时，到点不再无限顺延，而是交回给人', async () => {
    const a = mkAgent('A', [{ key: 'demo_b1_g1', sessionId: 'sess-a' }])
    const b = mkAgent('B', [{ key: 'task:task_t1:B', sessionId: 'sess-b' }])
    writeTask('running', task({
      taskId: 'task_t1',
      taskLead: a,
      deadlineAt: Date.now() - 1,
      assignees: [assignee({ expertId: b, expertName: 'B', dispatchedBy: a, sessionId: 'sess-b', status: 'need_decision', wake: true })],
    }))
    const { host, delivered } = fakeHost(['sess-a', 'sess-b'], [], {}, ['sess-b'])
    const patrol = createPatrol(host, { windowMs: 1 })
    await patrol.tickOnce()
    expect(delivered.some((d) => d.text[0]?.includes('需要你确认'))).toBe(true)
  })

  it('IM 任务里专家调了 ask_user_question → 取消那轮、写待决、发问卷到群', async () => {
    const a = mkAgent('A', [{ key: 'demo_b1_g1', sessionId: 'sess-a' }])
    const b = mkAgent('B', [{ key: 'task:task_t1:B', sessionId: 'sess-b' }])
    const bEvents = [
      { seq: 1, type: 'turn/start' },
      {
        seq: 2,
        type: 'tool/call',
        data: { callId: 'c1', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q1', question: '要哪个尺寸？' }] }) },
      },
    ]
    writeTask('running', task({
      taskId: 'task_t1',
      taskLead: a,
      providerId: 'demo', // IM
      assignees: [assignee({ expertId: b, expertName: 'B', dispatchedBy: a, sessionId: 'sess-b', status: 'running', wake: true })],
    }))
    const cancelled: string[] = []
    const { host, delivered } = fakeHost(['sess-a', 'sess-b'], [], { 'sess-b': bEvents }, ['sess-b'], undefined, cancelled)
    const patrol = createPatrol(host, { windowMs: 1, askHandoffGraceMs: 1 })
    await patrol.tickOnce()
    await new Promise((r) => setTimeout(r, 20))
    expect(cancelled).toEqual(['sess-b'])                       // 取消了那轮
    const back = readTask('running', 'task_t1')!
    expect(back.assignees[0]?.status).toBe('need_decision')      // 标记在等人
    expect(back.pendingHuman?.toHuman).toBe(true)
    expect(back.pendingHuman?.questions).toEqual(['要哪个尺寸？'])
    expect(delivered[0]?.text[0]).toContain('要哪个尺寸？')      // 问卷发到群
    expect(back.deadlineAt).toBeGreaterThan(Date.now())          // 顺延墙钟
  })

  it('local（Web）任务里调 ask_user_question → 不接管，留给网页 answerer', async () => {
    const a = mkAgent('A', [{ key: 'demo_b1_g1', sessionId: 'sess-a' }])
    const b = mkAgent('B', [{ key: 'task:task_t1:B', sessionId: 'sess-b' }])
    const bEvents = [
      { seq: 1, type: 'tool/call', data: { callId: 'c1', name: 'ask_user_question', arguments: '{"questions":[{"id":"q1","question":"?"}]}' } },
    ]
    writeTask('running', task({
      taskId: 'task_t1', taskLead: a, providerId: 'local',
      assignees: [assignee({ expertId: b, expertName: 'B', dispatchedBy: a, sessionId: 'sess-b', status: 'running', wake: true })],
    }))
    const cancelled: string[] = []
    const { host, delivered } = fakeHost(['sess-a', 'sess-b'], [], { 'sess-b': bEvents }, ['sess-b'], undefined, cancelled)
    const patrol = createPatrol(host, { windowMs: 1, askHandoffGraceMs: 1 })
    await patrol.tickOnce()
    await new Promise((r) => setTimeout(r, 20))
    expect(cancelled).toEqual([])
    expect(delivered).toHaveLength(0)
    expect(readTask('running', 'task_t1')?.pendingHuman).toBeUndefined()
  })

  it('任务被人挪走（cancel/）→ 解绑清理把会话解掉', async () => {
    mkAgent('A', [{ key: 'demo_b1_g1', sessionId: 'sess-a' }])
    bindSession('sess-a', 'task_t1')
    // running/ 里没有这份任务（相当于人已 mv 到 cancel/）
    const { host } = fakeHost(['sess-a'])
    const patrol = createPatrol(host, { windowMs: 1 })
    await patrol.tickOnce()
    expect(boundTaskId('sess-a')).toBeUndefined()
  })
})
