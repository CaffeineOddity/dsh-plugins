/**
 * 任务看板 frontmatter 读写与迁移（specs/12 任务文件）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resetConfigCache } from '../config.js'
import {
  marshalTaskYaml,
  unmarshalTask,
  writeTask,
  readTask,
  moveTask,
  listTasksIn,
  isTaskId,
  describeTasks,
  type TaskBoard,
} from './task-board.js'

let dir: string
let prevEnv: string | undefined

function sampleTask(id = 'task_abc'): TaskBoard {
  return {
    taskId: id,
    taskLead: 'lead1',
    sender: 'alice',
    providerId: 'demo',
    sessionParts: { bot_id: 'r1', group_id: 'g9' },
    originContext: '@lead 出一张海报',
    access: 'write',
    target: '/tmp/proj',
    createdAt: 1000,
    deadlineAt: 2000,
    groupSnapshot: [
      { agentId: 'lead1', name: '周bot通', description: '' },
      { agentId: 'expert-d', name: '设计师', description: '视觉' },
    ],
    assignees: [
      {
        expertId: 'expert-d',
        expertName: '设计师',
        dispatchedBy: 'lead1',
        dispatchedByName: '周bot通',
        sessionId: 'sess-1',
        access: 'write',
        target: '/tmp/proj',
        status: 'running',
        wake: true,
      },
    ],
    body: '# 海报\n\n要做一张 banner。',
  }
}

beforeEach(() => {
  prevEnv = process.env.AGENT_BOT_CONFIG_DIR
  dir = mkdtempSync(join(tmpdir(), 'taskboard-test-'))
  process.env.AGENT_BOT_CONFIG_DIR = dir
  resetConfigCache()
})

afterEach(() => {
  resetConfigCache()
  if (prevEnv === undefined) delete process.env.AGENT_BOT_CONFIG_DIR
  else process.env.AGENT_BOT_CONFIG_DIR = prevEnv
  rmSync(dir, { recursive: true, force: true })
})

describe('marshal / unmarshal 往返', () => {
  it('写读一致，保留全部字段', () => {
    writeTask('running', sampleTask('task_abc'))
    const t = readTask('running', 'task_abc') as TaskBoard
    expect(t.taskId).toBe('task_abc')
    expect(t.taskLead).toBe('lead1')
    expect(t.sender).toBe('alice')
    expect(t.sessionParts).toEqual({ bot_id: 'r1', group_id: 'g9' })
    expect(t.originContext).toBe('@lead 出一张海报')
    expect(t.access).toBe('write')
    expect(t.target).toBe('/tmp/proj')
    expect(t.createdAt).toBe(1000)
    expect(t.deadlineAt).toBe(2000)
    expect(t.groupSnapshot).toEqual([
      { agentId: 'lead1', name: '周bot通', description: '' },
      { agentId: 'expert-d', name: '设计师', description: '视觉' },
    ])
    expect(t.assignees).toEqual([
      {
        expertId: 'expert-d',
        expertName: '设计师',
        dispatchedBy: 'lead1',
        dispatchedByName: '周bot通',
        sessionId: 'sess-1',
        access: 'write',
        target: '/tmp/proj',
        status: 'running',
        wake: true,
      },
    ])
    expect(t.body).toBe('# 海报\n\n要做一张 banner。')
  })

  it('缺关键字段抛错', () => {
    const yaml = marshalTaskYaml(sampleTask('task_abc'), '')
    // 把 taskId 抠掉
    const broken = yaml.replace('taskId: task_abc\n', '')
    expect(() => unmarshalTask(broken)).toThrow(/taskId/)
  })
})

describe('迁移与列表', () => {
  it('moveTask 迁移并保留内容', () => {
    writeTask('todo', sampleTask('task_x'))
    const moved = moveTask('todo', 'running', 'task_x')
    expect(moved.taskId).toBe('task_x')
    expect(readTask('todo', 'task_x')).toBeUndefined()
    expect(readTask('running', 'task_x')).toBeDefined()
    expect(listTasksIn('running')).toHaveLength(1)
    expect(listTasksIn('todo')).toHaveLength(0)
  })
})

describe('describeTasks 短摘要', () => {
  it('含 pendingHuman 与 assignees 投影', () => {
    const t = sampleTask('task_p')
    t.pendingHuman = { questions: ['要什么尺寸？'], askedBy: 'lead1', askedAt: 1500 }
    const row = describeTasks([t])[0] as Record<string, unknown>
    expect(row.taskId).toBe('task_p')
    expect(row.sender).toBe('alice')
    expect((row.pendingHuman as { questions: string[] }).questions).toEqual(['要什么尺寸？'])
    expect(Array.isArray(row.assignees)).toBe(true)
  })
})

describe('isTaskId', () => {
  it('校验', () => {
    expect(isTaskId('task_abc')).toBe(true)
    expect(isTaskId('task_a-1_x')).toBe(true)
    expect(isTaskId('abc')).toBe(false)
    expect(isTaskId('')).toBe(false)
  })
})