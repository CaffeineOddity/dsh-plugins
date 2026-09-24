/**
 * 入站上下文小本子（specs/12 §入站怎么绑任务）：记本轮 sender/providerId/群快照，供 open_task 新建取用。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { forgetInbound, inboundFor, rememberInbound, resetInboundCache } from './inbound.js'

afterEach(() => {
  resetInboundCache()
})

describe('inbound 登记表', () => {
  it('登记后能取回；按 sessionId 区分', () => {
    rememberInbound('sess-1', {
      sender: 'alice',
      providerId: 'demo',
      sessionParts: { bot_id: 'r1', group_id: 'g1' },
      originContext: '@A 出一张海报',
      groupSnapshot: [{ agentId: 'b1', name: 'B', description: '' }],
    })
    const got = inboundFor('sess-1')
    expect(got?.sender).toBe('alice')
    expect(got?.sessionParts).toEqual({ bot_id: 'r1', group_id: 'g1' })
    expect(got?.groupSnapshot).toEqual([{ agentId: 'b1', name: 'B', description: '' }])
    expect(inboundFor('sess-other')).toBeUndefined()
  })

  it('同一会话新一轮覆盖上一轮（以最新为准）', () => {
    rememberInbound('sess-1', { sender: 'alice', providerId: 'd', sessionParts: { a: '1' }, originContext: '第一轮', groupSnapshot: [] })
    rememberInbound('sess-1', { sender: 'bob', providerId: 'd', sessionParts: { a: '2' }, originContext: '第二轮', groupSnapshot: [] })
    expect(inboundFor('sess-1')?.sender).toBe('bob')
    expect(inboundFor('sess-1')?.originContext).toBe('第二轮')
  })

  it('存的是副本：外部改数组/对象不影响已登记内容', () => {
    const parts = { a: '1' }
    const snap = [{ agentId: 'b1', name: 'B', description: '' }]
    rememberInbound('sess-1', { sender: 's', providerId: 'd', sessionParts: parts, originContext: 'c', groupSnapshot: snap })
    parts.a = 'changed'
    snap.push({ agentId: 'b2', name: 'B2', description: '' })
    expect(inboundFor('sess-1')?.sessionParts).toEqual({ a: '1' })
    expect(inboundFor('sess-1')?.groupSnapshot).toHaveLength(1)
  })

  it('空 sessionId 忽略；forget 清掉', () => {
    rememberInbound('', { sender: 's', providerId: 'd', sessionParts: { a: '1' }, originContext: 'c', groupSnapshot: [] })
    expect(inboundFor('')).toBeUndefined()
    rememberInbound('sess-1', { sender: 's', providerId: 'd', sessionParts: { a: '1' }, originContext: 'c', groupSnapshot: [] })
    forgetInbound('sess-1')
    expect(inboundFor('sess-1')).toBeUndefined()
  })
})
