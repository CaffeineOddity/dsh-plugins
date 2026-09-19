/**
 * 配置站 siteKey：前缀 /agent-bot，白名单，拒绝穿越（F2）。不启 webServer。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FILES, siteKey } from './serve.js'

describe('config-site siteKey', () => {
  it('把 /agent-bot 与已知子路径映射为白名单键', () => {
    expect(siteKey('/agent-bot')).toBe('')
    expect(siteKey('/agent-bot/')).toBe('')
    expect(siteKey('/agent-bot/skills')).toBe('skills')
    expect(siteKey('/agent-bot/prompts')).toBe('prompts')
    expect(siteKey('/agent-bot/agents')).toBe('agents')
    expect(siteKey('/agent-bot/chat')).toBe('chat')
    expect(siteKey('/agent-bot/settings')).toBe('settings')
    expect(siteKey('/agent-bot/log')).toBe('log')
    expect(siteKey('/agent-bot/site.css')).toBe('site.css')
    expect(siteKey('/agent-bot/site.js')).toBe('site.js')
  })

  it('拒绝穿越与未知前缀', () => {
    expect(siteKey('/agent-bot/../index.js')).toBe(null)
    expect(siteKey('/agent-bot/a/b')).toBe(null)
    expect(siteKey('/agent-bot-rpc')).toBe(null)
    expect(siteKey('/random')).toBe(null)
    expect(siteKey('/other')).toBe(null)
  })

  it('白名单文件都在 assets 目录', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'assets')
    const names = [...new Set(Object.values(FILES))]
    expect(names.sort()).toEqual(['agents.html', 'chat.html', 'log.html', 'prompts.html', 'settings.html', 'site.css', 'site.js', 'skills.html'])
    for (const file of names) {
      expect(existsSync(join(dir, file)), file).toBe(true)
    }
  })
})
