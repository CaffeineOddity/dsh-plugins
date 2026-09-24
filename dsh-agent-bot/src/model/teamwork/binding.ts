/**
 * session → 任务绑定（specs/12）。
 * 一个 agent 会话（一条通道 session 或一条协作槽）在同一 fiber 内归属一份 md。
 * 内部 followup 必须带 taskId 就是靠这份绑定在运行时侧解析，不让模型填空。
 * 落盘在 jobs/.bindings.json，供进程重启后会话续用时仍能认出自己那份任务。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { jobsRootPath } from '../config.js'
import { isTaskId } from './task-board.js'

interface Bound {
  taskId: string
  createdAt: number
}

let cache: Record<string, Bound> | undefined

function bindingsFile(): string {
  return join(jobsRootPath(), '.bindings.json')
}

function ensureRoot(): void {
  const root = jobsRootPath()
  if (!existsSync(root)) mkdirSync(root, { recursive: true })
}

function load(): Record<string, Bound> {
  if (cache !== undefined) return cache
  const file = bindingsFile()
  if (!existsSync(file)) {
    cache = {}
    return cache
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`agent-bot: 读取任务绑定失败: ${(err as Error).message}`)
  }
  const out: Record<string, Bound> = {}
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const s = (v ?? {}) as Record<string, unknown>
      if (typeof s.taskId === 'string' && typeof s.createdAt === 'number') {
        out[k] = { taskId: s.taskId, createdAt: s.createdAt }
      }
    }
  }
  cache = out
  return out
}

function persist(map: Record<string, Bound>): void {
  ensureRoot()
  try {
    writeFileSync(bindingsFile(), JSON.stringify(map, null, 2), 'utf8')
  } catch (err) {
    throw new Error(`agent-bot: 写任务绑定失败: ${(err as Error).message}`)
  }
}

/** 记录一个 session 当前占用的任务。重复绑同任务幂等。 */
export function bindSession(sessionId: string, taskId: string, nowMs = Date.now()): void {
  if (sessionId.trim() === '') throw new Error('agent-bot: sessionId 不可为空')
  if (!isTaskId(taskId)) throw new Error(`agent-bot: 非法 taskId ${taskId}`)
  ensureRoot()
  const map = load()
  if (map[sessionId]?.taskId === taskId) return
  map[sessionId] = { taskId, createdAt: nowMs }
  persist(map)
}

/** 绑定时不覆盖已有不同任务（用于 open_task 新建话术）。 */
export function bindIfAbsent(sessionId: string, taskId: string, nowMs = Date.now()): boolean {
  if (sessionId.trim() === '') throw new Error('agent-bot: sessionId 不可为空')
  if (!isTaskId(taskId)) throw new Error(`agent-bot: 非法 taskId ${taskId}`)
  ensureRoot()
  const map = load()
  if (map[sessionId] !== undefined) return false
  map[sessionId] = { taskId, createdAt: nowMs }
  persist(map)
  return true
}

/** 查询 session 当前绑定任务；无则 undefined。 */
export function boundTaskId(sessionId: string): string | undefined {
  return load()[sessionId]?.taskId
}

/** 解除绑定。 */
export function unbindSession(sessionId: string): void {
  const map = load()
  if (map[sessionId] === undefined) return
  delete map[sessionId]
  persist(map)
}

/** 当前全部绑定（供收口清理：任务已被挪走时解绑其会话）。 */
export function listBindings(): Array<{ sessionId: string; taskId: string }> {
  return Object.entries(load()).map(([sessionId, v]) => ({ sessionId, taskId: v.taskId }))
}

/** 测试用：清内存缓存。 */
export function resetBindingsCache(): void {
  cache = undefined
}