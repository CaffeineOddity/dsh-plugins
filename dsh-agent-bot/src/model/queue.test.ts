/**
 * ask 串行队列：同槽 FIFO、失败不堵、异槽并行、不续接不排队（G7）；
 * pending 未 settle 不放行下一轮（G11）。
 */
import { describe, expect, it } from 'vitest'
import { createAskQueue, enqueueHoldPending } from './queue.js'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

describe('createAskQueue', () => {
  it('reuse_session=true 同槽 FIFO，截取完成才放行下一轮', async () => {
    const queue = createAskQueue()
    const order: string[] = []
    const first = queue.enqueue('a1', 'r1_1', true, async () => {
      order.push('first-start')
      await delay(30)
      order.push('first-capture')
      return 1
    })
    const second = queue.enqueue('a1', 'r1_1', true, async () => {
      order.push('second-start')
      return 2
    })
    expect(await Promise.all([first, second])).toEqual([1, 2])
    expect(order).toEqual(['first-start', 'first-capture', 'second-start'])
  })

  it('上一轮失败不堵下一轮', async () => {
    const queue = createAskQueue()
    const first = queue.enqueue('a1', 'k', true, async () => {
      throw new Error('boom')
    })
    const second = queue.enqueue('a1', 'k', true, async () => 'ok')
    await expect(first).rejects.toThrow(/boom/)
    await expect(second).resolves.toBe('ok')
  })

  it('不同 (agentId, sessionKey) 并行', async () => {
    const queue = createAskQueue()
    let concurrent = 0
    let max = 0
    const bump = async (value: string) => {
      concurrent += 1
      max = Math.max(max, concurrent)
      await delay(20)
      concurrent -= 1
      return value
    }
    const a = queue.enqueue('a1', 'k1', true, () => bump('a'))
    const b = queue.enqueue('a1', 'k2', true, () => bump('b'))
    const c = queue.enqueue('a2', 'k1', true, () => bump('c'))
    expect(await Promise.all([a, b, c])).toEqual(['a', 'b', 'c'])
    expect(max).toBeGreaterThan(1)
  })

  it('reuse_session=false 同槽不排队', async () => {
    const queue = createAskQueue()
    let concurrent = 0
    let max = 0
    const bump = async (value: number) => {
      concurrent += 1
      max = Math.max(max, concurrent)
      await delay(20)
      concurrent -= 1
      return value
    }
    const a = queue.enqueue('a1', 'k', false, () => bump(1))
    const b = queue.enqueue('a1', 'k', false, () => bump(2))
    expect(await Promise.all([a, b])).toEqual([1, 2])
    expect(max).toBe(2)
  })

  it('空 agentId / sessionKey 抛错', () => {
    const queue = createAskQueue()
    expect(() => queue.enqueue('', 'k', true, async () => 1)).toThrow(/非空 agentId/)
    expect(() => queue.enqueue('a1', '  ', true, async () => 1)).toThrow(/非空 sessionKey/)
  })
})

describe('enqueueHoldPending', () => {
  it('ask 立刻拿到 result；pending 未 settle 不放行下一轮', async () => {
    const queue = createAskQueue()
    const order: string[] = []
    let release: (() => void) | undefined
    const hanging = new Promise<string[]>((resolve) => {
      release = () => resolve([])
    })
    const first = enqueueHoldPending(queue, 'a1', 'k', true, async () => {
      order.push('first-return')
      return { pending: hanging }
    })
    const second = enqueueHoldPending(queue, 'a1', 'k', true, async () => {
      order.push('second-start')
      return { pending: null }
    })
    expect(await first).toEqual({ pending: hanging })
    expect(order).toEqual(['first-return'])
    if (release === undefined) throw new Error('test: release 未赋值')
    release()
    await second
    expect(order).toEqual(['first-return', 'second-start'])
  })

  it('pending reject 不堵下一轮', async () => {
    const queue = createAskQueue()
    const first = enqueueHoldPending(queue, 'a1', 'k', true, async () => ({
      pending: Promise.reject(new Error('安全阀')),
    }))
    const second = enqueueHoldPending(queue, 'a1', 'k', true, async () => ({ pending: null, ok: true }))
    await expect(first).resolves.toMatchObject({ pending: expect.any(Promise) })
    await expect(first.then((row) => row.pending)).rejects.toThrow(/安全阀/)
    await expect(second).resolves.toEqual({ pending: null, ok: true })
  })
})
