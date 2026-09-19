/**
 * 配置站 RPC 端点（F4）。不启 webServer，直接调 handleRpc。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, resetConfigCache } from '../model/config.js'
import { handleRpc, resetLogs, type AgentBotRpcHost } from './rpc.js'

let configDir: string
let prevEnv: string | undefined

beforeEach(() => {
  prevEnv = process.env.AGENT_BOT_CONFIG_DIR
  configDir = mkdtempSync(join(tmpdir(), 'agentbot-rpc-'))
  process.env.AGENT_BOT_CONFIG_DIR = configDir
  resetConfigCache()
  resetLogs()
})

afterEach(() => {
  resetConfigCache()
  resetLogs()
  if (prevEnv === undefined) delete process.env.AGENT_BOT_CONFIG_DIR
  else process.env.AGENT_BOT_CONFIG_DIR = prevEnv
  rmSync(configDir, { recursive: true, force: true })
})

const host: AgentBotRpcHost = {
  listProviders() {
    return [{ id: 'demo', label: '示例通道' }]
  },
  async localAsk(rawInput) {
    // 测试桩：rawInput = "<agentId> <context>"，回显 context，单条 markdown。
    const sp = rawInput.indexOf(' ')
    const context = sp < 0 ? '' : rawInput.slice(sp + 1).trim()
    return { messages: [{ kind: 'markdown' as const, text: context, url: '', atUserIds: [], atAll: false }] }
  },
}

describe('handleRpc', () => {
  it('未知端点返回 error', async () => {
    const r = await handleRpc(host, 'nope', {})
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/unknown endpoint/)
  })

  it('list / settings / status 带配置目录与 providers', async () => {
    const list = await handleRpc(host, 'list', {})
    expect(list.ok).toBe(true)
    const lv = list.value as Record<string, unknown>
    expect(lv.skill_roots).toEqual([])
    expect((lv.skill_apply as { dsh: { global: string } }).dsh.global).toBe('~/.dsh/skills')
    expect((lv.status as { providers: unknown[] }).providers).toEqual([{ id: 'demo', label: '示例通道' }])
    const settings = await handleRpc(host, 'settings', {})
    expect(settings.ok).toBe(true)
    expect((settings.value as { configDir: string }).configDir).toBe(configDir)
    expect((settings.value as { agent_wait_timeout_ms: number }).agent_wait_timeout_ms).toBe(180000)
    const status = await handleRpc(host, 'status', {})
    expect((status.value as { providers: { id: string }[] }).providers[0].id).toBe('demo')
  })

  it('saveSkillRoots + scanSkills + saveSkillGroups', async () => {
    const root = join(configDir, 'skills')
    const git = join(root, 'git-skill')
    mkdirSync(git, { recursive: true })
    writeFileSync(join(git, 'SKILL.md'), '# Git\n\n摘要\n', 'utf8')
    const saved = await handleRpc(host, 'saveSkillRoots', { skill_roots: [root] })
    expect(saved.ok).toBe(true)
    expect(loadConfig().skill_roots).toEqual([root])
    const scanned = await handleRpc(host, 'scanSkills', {})
    expect(scanned.ok).toBe(true)
    expect((scanned.value as { skills: { id: string }[] }).skills.map((s) => s.id)).toEqual(['git-skill'])
    const groups = await handleRpc(host, 'saveSkillGroups', {
      groups: { rd: { id: 'rd', name: 'rd', skill_ids: ['git-skill', 'gone'] } },
    })
    expect(groups.ok).toBe(true)
    expect((groups.value as { droppedSkillIds: string[] }).droppedSkillIds).toEqual(['gone'])
    const list = await handleRpc(host, 'list', {})
    expect(((list.value as { skill_groups: Record<string, { skill_ids: string[] }> }).skill_groups.rd.skill_ids)).toEqual([
      'git-skill',
    ])
  })

  it('saveSkillRoots 支持多个目录合并扫描', async () => {
    const rootA = join(configDir, 'skills-a')
    const rootB = join(configDir, 'skills-b')
    mkdirSync(join(rootA, 'git-skill'), { recursive: true })
    writeFileSync(join(rootA, 'git-skill', 'SKILL.md'), '# Git\n\n摘要\n', 'utf8')
    mkdirSync(join(rootB, 'team', 'icafe'), { recursive: true })
    writeFileSync(join(rootB, 'team', 'icafe', 'SKILL.md'), '# iCafe\n\n卡片\n', 'utf8')
    const saved = await handleRpc(host, 'saveSkillRoots', { skill_roots: [rootA, rootB] })
    expect(saved.ok).toBe(true)
    const scanned = await handleRpc(host, 'scanSkills', {})
    expect(scanned.ok).toBe(true)
    expect((scanned.value as { skills: { id: string }[] }).skills.map((s) => s.id)).toEqual(['git-skill', 'team/icafe'])
    expect((scanned.value as { roots: string[] }).roots).toEqual([rootA, rootB])
    const list = await handleRpc(host, 'list', {})
    expect((list.value as { skill_roots: string[] }).skill_roots).toEqual([rootA, rootB])
    const one = await handleRpc(host, 'scanSkills', { root: rootB })
    expect(one.ok).toBe(true)
    expect((one.value as { skills: { id: string }[] }).skills.map((s) => s.id)).toEqual(['git-skill', 'team/icafe'])
  })

  it('scanSkills 有 linkmap 则写入分组', async () => {
    const root = join(configDir, 'skills')
    mkdirSync(join(root, 'git-skill'), { recursive: true })
    writeFileSync(join(root, 'git-skill', 'SKILL.md'), '# Git\n\n摘要\n', 'utf8')
    mkdirSync(join(root, '.agentbot'), { recursive: true })
    writeFileSync(join(root, '.agentbot', 'linkmap.json'), JSON.stringify({ global: ['git-skill'] }), 'utf8')
    await handleRpc(host, 'saveSkillRoots', { skill_roots: [root] })
    const r = await handleRpc(host, 'scanSkills', {})
    expect(r.ok).toBe(true)
    expect((r.value as { groupsApplied: string[]; groupCount: number }).groupsApplied).toEqual(['global'])
    expect((r.value as { groupCount: number }).groupCount).toBe(1)
    const list = await handleRpc(host, 'list', {})
    expect((list.value as { skill_groups: Record<string, { skill_ids: string[] }> }).skill_groups.global.skill_ids).toEqual([
      'git-skill',
    ])
  })

  it('listDirectories 空 path 从家目录起', async () => {
    const r = await handleRpc(host, 'listDirectories', {})
    expect(r.ok).toBe(true)
    const v = r.value as { path: string; home: string; entries: unknown[] }
    expect(v.path).toBe(v.home)
    expect(Array.isArray(v.entries)).toBe(true)
  })

  it('pickDirectory 取消返回 path:null；选中返回绝对路径', async () => {
    const canceled = await handleRpc({ ...host, pickDirectory: async () => null }, 'pickDirectory', {})
    expect(canceled.ok).toBe(true)
    expect((canceled.value as { path: string | null }).path).toBe(null)
    const picked = await handleRpc({ ...host, pickDirectory: async () => '/abs/skills' }, 'pickDirectory', {})
    expect((picked.value as { path: string | null }).path).toBe('/abs/skills')
  })

  it('prompts CRUD；被引用则禁止删', async () => {
    const save = await handleRpc(host, 'savePrompts', {
      prompts: { default: { system_prompt: 'hi', tools: ['bash'] } },
    })
    expect(save.ok).toBe(true)
    const listed = await handleRpc(host, 'listPrompts', { query: 'def' })
    expect((listed.value as { name: string }[])[0].name).toBe('default')
    const ws = join(configDir, 'ws-a')
    const agent = await handleRpc(host, 'saveAgent', {
      id: '',
      name: '联运',
      workspace: ws,
      prompt: 'default',
      skill_groups: [],
      reuse_session: true,
      session_by_sender: false,
      session_timeout_minutes: 30,
    })
    expect(agent.ok).toBe(true)
    const blocked = await handleRpc(host, 'savePrompts', { prompts: {} })
    expect(blocked.ok).toBe(false)
    expect(blocked.error).toMatch(/仍被 agent 引用/)
  })

  it('saveAgent / listAgents / applySkillGroups / clearSession / deleteAgent', async () => {
    const root = join(configDir, 'skills')
    const git = join(root, 'git-skill')
    mkdirSync(git, { recursive: true })
    writeFileSync(join(git, 'SKILL.md'), '# Git\n', 'utf8')
    await handleRpc(host, 'saveSkillRoots', { skill_roots: [root] })
    await handleRpc(host, 'scanSkills', {})
    await handleRpc(host, 'saveSkillGroups', { groups: { rd: { id: 'rd', name: 'rd', skill_ids: ['git-skill'] } } })
    const ws = join(configDir, 'ws-a')
    const created = await handleRpc(host, 'saveAgent', {
      id: '',
      name: '联运',
      description: '说明',
      workspace: ws,
      prompt: '',
      skill_groups: ['rd'],
      reuse_session: false,
      session_by_sender: true,
      permission_mode: 'workspace-write',
      session_timeout_minutes: 0,
    })
    expect(created.ok).toBe(true)
    const id = (created.value as { agent: { id: string; reuse_session: boolean; permission_mode: string } }).agent.id
    expect((created.value as { agent: { reuse_session: boolean; permission_mode: string } }).agent.reuse_session).toBe(false)
    expect((created.value as { agent: { permission_mode: string } }).agent.permission_mode).toBe('workspace-write')
    const listed = await handleRpc(host, 'listAgents', {})
    expect((listed.value as { id: string }[])[0].id).toBe(id)
    const applied = await handleRpc(host, 'applySkillGroups', { id, tool: 'dsh', slot: 'workspace', groupIds: ['rd'] })
    expect(applied.ok).toBe(true)
    expect(existsSync(join(ws, '.dsh', 'skills', 'git-skill'))).toBe(true)
    const blockedGlobal = await handleRpc(host, 'applySkillGroups', { id, tool: 'dsh', slot: 'global', groupIds: ['rd'] })
    expect(blockedGlobal.ok).toBe(false)
    expect(blockedGlobal.error).toMatch(/global 槽请在 skills组页应用全局/)
    const emptyGlobal = await handleRpc(host, 'applyGlobalSkillGroups', {
      tool: 'dsh',
      slot: 'global',
      groupIds: [],
    })
    expect(emptyGlobal.ok).toBe(false)
    expect(emptyGlobal.error).toMatch(/请先选择技能组/)
    const missingSlot = await handleRpc(host, 'clearSession', { id, sessionKey: 'r1_1' })
    expect(missingSlot.ok).toBe(false)
    const deleted = await handleRpc(host, 'deleteAgent', { id })
    expect(deleted.ok).toBe(true)
    const after = await handleRpc(host, 'listAgents', {})
    expect(after.value).toEqual([])
  })

  it('saveSettings 校验范围', async () => {
    const bad = await handleRpc(host, 'saveSettings', { agent_wait_timeout_ms: 500 })
    expect(bad.ok).toBe(false)
    const ok = await handleRpc(host, 'saveSettings', { agent_wait_timeout_ms: '120000' })
    expect(ok.ok).toBe(true)
    expect((ok.value as { agent_wait_timeout_ms: number }).agent_wait_timeout_ms).toBe(120000)
    expect(loadConfig().agent_wait_timeout_ms).toBe(120000)
  })

  it('ask 端点校验必填并回执', async () => {
    const noAgent = await handleRpc(host, 'ask', { context: 'hi' })
    expect(noAgent.ok).toBe(false)
    expect(noAgent.error).toMatch(/agentId 必填/)
    const noContext = await handleRpc(host, 'ask', { agentId: 'a1' })
    expect(noContext.ok).toBe(false)
    expect(noContext.error).toMatch(/context 必填/)
    const r = await handleRpc(host, 'ask', { agentId: 'a1', context: '你好', sessionKey: 's1' })
    expect(r.ok).toBe(true)
    const v = r.value as { messages: { text: string; kind: string }[] }
    expect(v.messages).toHaveLength(1)
    expect(v.messages[0].text).toContain('你好')
  })
})
