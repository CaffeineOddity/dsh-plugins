/**
 * 叫醒链纯函数单测（wakeSessionIdFor / hasPendingDownstream / wakeText / assigneeOf / shouldDeliver）。
 * 不拉真 agent，只测会话定位与完成情况判定。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resetConfigCache } from '../config.js'
import { getAgent as getAgentConfig, saveAgent, touchSession } from '../agents.js'
import { taskSlotKey } from './relay.js'
import { assigneeOf, hasPendingDownstream, shouldDeliver, wakeSessionIdFor, wakeText } from './wake.js'
import type { TaskBoard, Assignee } from './task-board.js'

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
    leadName: 'Lead',
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

function loadAgent(id: string) {
  const cfg = getAgentConfig(id)
  if (cfg === undefined) throw new Error(`agent ${id} 未落盘`)
  return cfg
}

beforeEach(() => {
  prevEnv = process.env.AGENT_BOT_CONFIG_DIR
  dir = mkdtempSync(join(tmpdir(), 'wake-test-'))
  process.env.AGENT_BOT_CONFIG_DIR = dir
  resetConfigCache()
})

afterEach(() => {
  resetConfigCache()
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

  it('任务槽丢了 → 用 md 里的 leadSessionId 兜底（否则这单会僵在 running/）', () => {
    const id = mkAgent('A', [])
    const t = task({ taskLead: id, leadSessionId: 'sess-from-md', sessionParts: { bot_id: 'b1', group_id: 'g1' } })
    expect(wakeSessionIdFor(t, id)).toBe('sess-from-md')
  })

  it('任务槽在时优先于 md 兜底', () => {
    const id = mkAgent('A', [{ key: 'demo_b1_g1', sessionId: 'sess-chan' }])
    touchSession(id, taskSlotKey('task_t1', id), 'sess-slot', 1, '')
    const t = task({ taskLead: id, leadSessionId: 'sess-from-md', sessionParts: { bot_id: 'b1', group_id: 'g1' } })
    expect(wakeSessionIdFor(t, id)).toBe('sess-slot')
  })

  it('md 兜底只对 taskLead 生效（不会把专家叫到 lead 的会话）', () => {
    const lead = mkAgent('Lead2', [])
    const other = mkAgent('Other', [])
    const t = task({ taskLead: lead, leadSessionId: 'sess-from-md' })
    expect(wakeSessionIdFor(t, other)).toBeUndefined()
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