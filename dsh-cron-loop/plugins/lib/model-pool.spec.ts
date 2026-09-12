// model-pool 冒烟测试：tsx --test 运行。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ModelPool, computeRecoveryAt } from './model-pool.ts'
import type { ModelEntry, ModelPoolFile } from './model-pool.ts'

/** 构造测试用 pool（绕过文件读取）。 */
function makePool(models: ModelEntry[], enabled = true): ModelPool {
  return ModelPool.fromConfig({ enabled, models })
}

test('pickAvailable returns highest priority non-exhausted model', () => {
  const pool = makePool([
    { id: 'b', provider: 'p2', model: 'm2', priority: 2, quotaReset: { type: 'hours', value: 24 } },
    { id: 'a', provider: 'p1', model: 'm1', priority: 1, quotaReset: { type: 'hours', value: 24 } },
  ])
  const picked = pool.pickAvailable()
  assert.equal(picked?.id, 'a')
  assert.equal(picked?.provider, 'p1')
})

test('pickAvailable skips exhausted models', () => {
  const pool = makePool([
    { id: 'a', provider: 'p1', model: 'm1', priority: 1, quotaReset: { type: 'hours', value: 24 }, exhausted: true, exhaustedAt: Date.now() },
    { id: 'b', provider: 'p2', model: 'm2', priority: 2, quotaReset: { type: 'hours', value: 24 } },
  ])
  const picked = pool.pickAvailable()
  assert.equal(picked?.id, 'b')
})

test('pickAvailable returns null when all exhausted', () => {
  const pool = makePool([
    { id: 'a', provider: 'p1', model: 'm1', priority: 1, quotaReset: { type: 'hours', value: 24 }, exhausted: true, exhaustedAt: Date.now() },
    { id: 'b', provider: 'p2', model: 'm2', priority: 2, quotaReset: { type: 'hours', value: 24 }, exhausted: true, exhaustedAt: Date.now() },
  ])
  assert.equal(pool.pickAvailable(), null)
})

test('pickAvailable recovers exhausted model after reset period', () => {
  const past = Date.now() - 25 * 3_600_000 // 25 小时前
  const pool = makePool([
    { id: 'a', provider: 'p1', model: 'm1', priority: 1, quotaReset: { type: 'hours', value: 24 }, exhausted: true, exhaustedAt: past },
  ])
  // save 会被调用，但它写文件，这里只验证逻辑恢复
  try { pool.pickAvailable() } catch { /* save 可能失败，不影响逻辑验证 */ }
  const snapshot = pool.snapshot()
  assert.equal(snapshot?.models[0]?.exhausted, false)
})

test('pickAvailable skips permanentlyUnavailable models', () => {
  const pool = makePool([
    { id: 'a', provider: 'p1', model: 'm1', priority: 1, quotaReset: { type: 'hours', value: 24 }, permanentlyUnavailable: true },
    { id: 'b', provider: 'p2', model: 'm2', priority: 2, quotaReset: { type: 'hours', value: 24 } },
  ])
  const picked = pool.pickAvailable()
  assert.equal(picked?.id, 'b')
})

test('computeRecoveryAt hours type', () => {
  const entry: ModelEntry = {
    id: 'a', provider: 'p', model: 'm', priority: 1,
    quotaReset: { type: 'hours', value: 12 },
    exhaustedAt: 1000000,
  }
  assert.equal(computeRecoveryAt(entry), 1000000 + 12 * 3_600_000)
})

test('computeRecoveryAt returns null when not exhausted', () => {
  const entry: ModelEntry = {
    id: 'a', provider: 'p', model: 'm', priority: 1,
    quotaReset: { type: 'hours', value: 24 },
  }
  assert.equal(computeRecoveryAt(entry), null)
})

test('disabled pool returns null', () => {
  const pool = makePool([], false)
  assert.equal(pool.pickAvailable(), null)
})
