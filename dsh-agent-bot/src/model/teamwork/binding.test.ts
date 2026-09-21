/**
 * session → 任务绑定（specs/12）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resetConfigCache } from '../config.js'
import { bindSession, bindIfAbsent, boundTaskId, unbindSession, resetBindingsCache } from './binding.js'

let dir: string
let prevEnv: string | undefined

beforeEach(() => {
  prevEnv = process.env.AGENT_BOT_CONFIG_DIR
  dir = mkdtempSync(join(tmpdir(), 'binding-test-'))
  process.env.AGENT_BOT_CONFIG_DIR = dir
  resetConfigCache()
  resetBindingsCache()
})

afterEach(() => {
  resetBindingsCache()
  resetConfigCache()
  if (prevEnv === undefined) delete process.env.AGENT_BOT_CONFIG_DIR
  else process.env.AGENT_BOT_CONFIG_DIR = prevEnv
  rmSync(dir, { recursive: true, force: true })
})

describe('bindSession', () => {
  it('绑定后可查；重复绑同任务幂等；写盘', () => {
    bindSession('sess-a', 'task_abc', 1000)
    expect(boundTaskId('sess-a')).toBe('task_abc')
    bindSession('sess-a', 'task_abc', 1000)
    expect(boundTaskId('sess-a')).toBe('task_abc')
    expect(existsSync(join(dir, 'jobs', '.bindings.json'))).toBe(true)
    const raw = readFileSync(join(dir, 'jobs', '.bindings.json'), 'utf8')
    expect(raw).toContain('task_abc')
  })

  it('非法参抛错', () => {
    expect(() => bindSession('', 'task_abc')).toThrow(/sessionId/)
    expect(() => bindSession('sess', 'abc')).toThrow(/taskId/)
  })
})

describe('bindIfAbsent', () => {
  it('无绑定则绑真；有不同绑定则不动', () => {
    expect(bindIfAbsent('s1', 'task_1', 1000)).toBe(true)
    expect(boundTaskId('s1')).toBe('task_1')
    expect(bindIfAbsent('s1', 'task_2', 1000)).toBe(false)
    expect(boundTaskId('s1')).toBe('task_1')
  })
})

describe('unbindSession', () => {
  it('解绑后 undefined', () => {
    bindSession('s2', 'task_x')
    unbindSession('s2')
    expect(boundTaskId('s2')).toBeUndefined()
  })
})