/**
 * encodeSessionKey / sessionPartsForEncode 单测（B5）。
 */
import { describe, expect, it } from 'vitest'
import { conversationKeyOf, encodeSessionKey, sessionPartsForEncode } from './types.js'

describe('sessionPartsForEncode', () => {
  it('session_by_sender=false 时原样返回通道 parts', () => {
    expect(sessionPartsForEncode({ bot_id: 'r1', group_id: '6031348' }, 'alice', false)).toEqual({
      bot_id: 'r1',
      group_id: '6031348',
    })
  })

  it('session_by_sender=true 时并入 sender', () => {
    expect(sessionPartsForEncode({ bot_id: 'r1', group_id: '6031348' }, 'alice', true)).toEqual({
      bot_id: 'r1',
      group_id: '6031348',
      sender: 'alice',
    })
  })

  it('session_by_sender=true 且 sender 为空则抛错', () => {
    expect(() => sessionPartsForEncode({ bot_id: 'r1', group_id: '1' }, '', true)).toThrow(
      /session_by_sender 需要非空 sender/,
    )
  })

  it('禁止 webhook_url / webhook / toid / sender 键', () => {
    expect(() => sessionPartsForEncode({ webhook_url: 'x' }, 'a', false)).toThrow(/禁止字段 webhook_url/)
    expect(() => sessionPartsForEncode({ webhook: 'x' }, 'a', false)).toThrow(/禁止字段 webhook/)
    expect(() => sessionPartsForEncode({ toid: '1' }, 'a', false)).toThrow(/禁止字段 toid/)
    expect(() => sessionPartsForEncode({ sender: 'a' }, 'b', false)).toThrow(/禁止字段 sender/)
  })

  it('空 map 或空键值抛错', () => {
    expect(() => sessionPartsForEncode({}, 'a', false)).toThrow(/至少一对键值/)
    expect(() => sessionPartsForEncode({ bot_id: '' }, 'a', false)).toThrow(/不可为空/)
    expect(() => sessionPartsForEncode({ '': 'x' }, 'a', false)).toThrow(/不可为空/)
  })
})

describe('encodeSessionKey', () => {
  it('providerId 打头，再按 key 字母序取值用下划线连接', () => {
    expect(encodeSessionKey({ bot_id: 'r1', group_id: '6031348' }, 'feishu')).toBe('feishu_r1_6031348')
    expect(encodeSessionKey({ group_id: '6031348', bot_id: 'r1' }, 'feishu')).toBe('feishu_r1_6031348')
  })

  it('不同通道的同一对 parts 不会共用槽', () => {
    const parts = { bot_id: 'r1', group_id: '6031348' }
    expect(encodeSessionKey(parts, 'feishu')).not.toBe(encodeSessionKey(parts, 'ruliu'))
  })

  it('并入 sender 后得到按人 key', () => {
    const parts = sessionPartsForEncode({ bot_id: 'r1', group_id: '6031348' }, 'alice', true)
    expect(encodeSessionKey(parts, 'feishu')).toBe('feishu_r1_6031348_alice')
  })

  it('值本身含下划线仍可查找（不反向解析）', () => {
    expect(encodeSessionKey({ bot_id: 'r_1', group_id: '6_0' }, 'feishu')).toBe('feishu_r_1_6_0')
  })

  it('空 map 抛错', () => {
    expect(() => encodeSessionKey({}, 'feishu')).toThrow(/非空 sessionParts/)
  })

  it('providerId 为空抛错', () => {
    expect(() => encodeSessionKey({ bot_id: 'r1' }, '  ')).toThrow(/需要 providerId/)
  })
})

describe('conversationKeyOf（板可见性标识）', () => {
  it('通道自定义优先', () => {
    expect(conversationKeyOf({ bot_id: 'A', group_id: 'G1' }, () => 'custom')).toBe('custom')
  })
  it('缺省取 group_id（不带 bot_id）', () => {
    expect(conversationKeyOf({ bot_id: 'A', group_id: 'G1' })).toBe('G1')
    expect(conversationKeyOf({ bot_id: 'B', group_id: 'G1' })).toBe('G1')
  })
  it('没有 group_id 时规范化拼接', () => {
    expect(conversationKeyOf({ session: 'conv1' })).toBe('session=conv1')
  })
})
