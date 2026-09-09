// cron-core 冒烟测试：tsx --test 运行。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCron, computeNextRun, matches, CronParseError, describeCron } from './cron-core.ts'

test('every minute steps past seconds', () => {
  const p = parseCron('* * * * *')
  const next = computeNextRun(p, new Date(2026, 0, 1, 10, 30, 15))
  assert.equal(next.getMinutes(), 31)
  assert.equal(next.getSeconds(), 0)
})

test('weekday 9am advances to next business day', () => {
  const p = parseCron('0 9 * * 1-5')
  const next = computeNextRun(p, new Date(2026, 0, 1, 12, 0, 0)) // 周四
  assert.equal(next.getDate(), 2)
  assert.equal(next.getHours(), 9)
})

test('friday evening rolls to monday', () => {
  const p = parseCron('0 9 * * 1-5')
  const next = computeNextRun(p, new Date(2026, 0, 2, 18, 31, 0)) // 周五
  assert.equal(next.getDay(), 1)
  assert.equal(next.getHours(), 9)
})

test('step minutes', () => {
  const p = parseCron('*/15 * * * *')
  const next = computeNextRun(p, new Date(2026, 0, 1, 10, 7, 0))
  assert.equal(next.getMinutes(), 15)
})

test('month alias parses', () => {
  const p = parseCron('30 18 * DEC 5')
  assert.ok(p.months.has(12))
})

test('invalid minute throws CronParseError', () => {
  assert.throws(() => parseCron('61 * * * *'), CronParseError)
})

test('wrong field count throws', () => {
  assert.throws(() => parseCron('* * * *'), CronParseError)
})

test('dom/dow restricted OR convention', () => {
  const p = parseCron('0 0 1 1 fri')
  assert.ok(matches(p, new Date(2026, 0, 1, 0, 0)))
})

test('describeCron common patterns', () => {
  assert.equal(describeCron('* * * * *'), '每分钟')
  assert.equal(describeCron('0 9 * * *'), '每天 09:00')
  assert.equal(describeCron('30 18 * * *'), '每天 18:30')
  assert.equal(describeCron('0 9 * * 1-5'), '工作日 09:00')
  assert.equal(describeCron('*/15 * * * *'), '每 15 分钟')
  assert.equal(describeCron('0 9 1 * *'), '每月 1 号 09:00')
})

test('describeCron falls back to raw expr', () => {
  assert.equal(describeCron('bad expr'), 'bad expr')
})
