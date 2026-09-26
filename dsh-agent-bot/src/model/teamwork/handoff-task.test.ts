import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetConfigCache, saveConfig } from '../config.js'
import { boundTaskId, resetBindingsCache } from './binding.js'
import { ensureHandoffJob, isCrossSessionHandoff, isHandoffTask } from './handoff-task.js'
import { readTask } from './task-board.js'

let configDir: string
let prevEnv: string | undefined

beforeEach(() => {
  prevEnv = process.env.AGENT_BOT_CONFIG_DIR
  configDir = mkdtempSync(join(tmpdir(), 'handoff-job-'))
  process.env.AGENT_BOT_CONFIG_DIR = configDir
  resetConfigCache()
  resetBindingsCache()
  saveConfig({
    skill_roots: [],
    skill_groups: {},
    prompts: {},
    agents: [{
      id: 'designer',
      name: '设计师',
      description: '',
      workspace: join(configDir, 'ws'),
      prompt: '',
      prompt_placement: 'system',
      skill_groups: [],
      prompt_append_skills: false,
      reuse_session: true,
      session_by_sender: false,
      permission_mode: 'danger-full-access',
      session_timeout_minutes: 30,
      concurrency: 'serial',
      needs_target_workspace: true,
      sessions: {},
    }],
    skill_apply: {},
    agent_wait_timeout_ms: 180000,
    expert_liveness_max_renew: 3,
    task_round_timeout_ms: 7200000,
    use_hub_experts: true,
  })
})

afterEach(() => {
  resetConfigCache()
  resetBindingsCache()
  if (prevEnv === undefined) delete process.env.AGENT_BOT_CONFIG_DIR
  else process.env.AGENT_BOT_CONFIG_DIR = prevEnv
  rmSync(configDir, { recursive: true, force: true })
})

describe('isCrossSessionHandoff', () => {
  it('调用方不是另一条 agent 会话 → 不建', () => {
    expect(isCrossSessionHandoff('', 'expert', false)).toBe(false)
    expect(isCrossSessionHandoff('local', 'expert', true)).toBe(false)
    expect(isCrossSessionHandoff('chat-1', 'expert', false)).toBe(false)
    expect(isCrossSessionHandoff('session-a', 'session-a', true)).toBe(false)
  })

  it('会话 A 交给另一条专家会话 B → 要建', () => {
    expect(isCrossSessionHandoff('session-a', 'expert-b', true)).toBe(true)
  })
})

describe('ensureHandoffJob', () => {
  it('新建并绑定专家会话；已有 running 绑定则复用', () => {
    const first = ensureHandoffJob({
      expertId: 'designer',
      expertName: '设计师',
      expertSessionId: 'sess-b',
      sender: 'local',
      providerId: 'local',
      sessionParts: { session: 'session-a' },
      originContext: '设计首页',
      target: '/proj',
      groupSnapshot: [],
    })
    expect(first.taskLead).toBe('designer')
    expect(first.leadSessionId).toBe('sess-b')
    expect(first.sessionParts.session).toBe('session-a')
    expect(first.target).toBe('/proj')
    expect(boundTaskId('sess-b')).toBe(first.taskId)
    expect(isHandoffTask(first, 'sess-b')).toBe(true)
    expect(readTask('running', first.taskId)?.taskId).toBe(first.taskId)

    const again = ensureHandoffJob({
      expertId: 'designer',
      expertName: '设计师',
      expertSessionId: 'sess-b',
      sender: 'local',
      providerId: 'local',
      sessionParts: { session: 'session-a' },
      originContext: '再来一次',
      groupSnapshot: [],
    })
    expect(again.taskId).toBe(first.taskId)
  })
})
