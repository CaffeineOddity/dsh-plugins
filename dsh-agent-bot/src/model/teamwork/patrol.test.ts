/**
 * 巡检器纯逻辑单测：状态机判定 / 通道槽解析 / 收口判定。
 * 不跑真 agent：只测决策与文件读写。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resetConfigCache } from '../config.js'
import { saveAgent, touchSession } from '../agents.js'
import type { TaskBoard, Assignee } from './task-board.js'
import { assigneeOf, channelSessionKeyOf, shouldDeliver } from './patrol.js'

let dir: string
let prevEnv: string | undefined

function mkAgent(name: string, slots: Array<{ key: string; sessionId: string }> = []): string {
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
    session_by_sender: false,
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
    sessionParts: { provider_id: 'demo', group_id: 'g1' },
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

beforeEach(() => {
  prevEnv = process.env.AGENT_BOT_CONFIG_DIR
  dir = mkdtempSync(join(tmpdir(), 'patrol-test-'))
  process.env.AGENT_BOT_CONFIG_DIR = dir
  resetConfigCache()
})

afterEach(() => {
  resetConfigCache()
  if (prevEnv === undefined) delete process.env.AGENT_BOT_CONFIG_DIR
  else process.env.AGENT_BOT_CONFIG_DIR = prevEnv
  rmSync(dir, { recursive: true, force: true })
})

describe('channelSessionKeyOf', () => {
  it('取第一个非 task: 前缀的槽 key', () => {
    const id = mkAgent('A', [
      { key: 'g1:u1', sessionId: 'sess-1' },
      { key: 'task:t1:a', sessionId: 'sess-collab' },
    ])
    const cfg = loadAgent(id)
    expect(channelSessionKeyOf(cfg)).toBe('g1:u1')
  })
  it('全协作槽返回 undefined', () => {
    const id = mkAgent('B', [{ key: 'task:t1:b', sessionId: 's' }])
    expect(channelSessionKeyOf(loadAgent(id))).toBeUndefined()
  })
})

describe('assigneeOf / shouldDeliver', () => {
  it('assignee 命中 / 未命中', () => {
    const t = task({
      assignees: [{ expertId: 'e1', expertName: 'E', dispatchedBy: 'lead', dispatchedByName: 'Lead', sessionId: 's', access: 'write', status: 'running', wake: true }],
    })
    expect(assigneeOf(t, 'e1')?.status).toBe('running')
    expect(assigneeOf(t, 'ghost')).toBeUndefined()
  })
  it('shouldDeliver：无专家无待决 false；有专家 true；有待决 true', () => {
    expect(shouldDeliver(task())).toBe(false)
    expect(shouldDeliver(task({ assignees: [{ expertId: 'e', expertName: 'E', dispatchedBy: '', dispatchedByName: '', sessionId: 's', access: 'read', status: 'idle', wake: false }] }))).toBe(true)
    expect(shouldDeliver(task({ pendingHuman: { questions: ['q'], askedBy: 'e', askedAt: 1 } }))).toBe(true)
  })
})

function loadAgent(id: string) {
  const cfg = getAgentConfig(id)
  if (cfg === undefined) throw new Error(`agent ${id} 未落盘`)
  return cfg
}
import { getAgent as getAgentConfig } from '../agents.js'
