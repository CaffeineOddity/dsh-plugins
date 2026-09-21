/**
 * Agents CRUD / workspace 撞库 / 保存不自动软链（E1–E3）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, resetConfigCache, saveConfig, saveSkillsMap, type AgentBotFileConfig } from './config.js'
import {
  applyGlobalSkillGroupsAt,
  applySkillGroups,
  resolveApplyTemplate,
  clearSession,
  createAgent,
  deleteAgent,
  flattenSkillLinkName,
  getAgent,
  listAgents,
  saveAgent,
  touchSession,
  type AgentWrite,
} from './agents.js'

let configDir: string
let prevEnv: string | undefined

beforeEach(() => {
  prevEnv = process.env.AGENT_BOT_CONFIG_DIR
  configDir = mkdtempSync(join(tmpdir(), 'agentbot-agents-'))
  process.env.AGENT_BOT_CONFIG_DIR = configDir
  resetConfigCache()
})

afterEach(() => {
  resetConfigCache()
  if (prevEnv === undefined) delete process.env.AGENT_BOT_CONFIG_DIR
  else process.env.AGENT_BOT_CONFIG_DIR = prevEnv
  rmSync(configDir, { recursive: true, force: true })
})

function seed(overrides: Partial<AgentBotFileConfig> = {}): void {
  saveConfig({
    skill_roots: [],
    skill_groups: { rd: { id: 'rd', name: 'rd', skill_ids: [] } },
    prompts: { default: { system_prompt: 'hi', tools: [] } },
    agents: [],
    skill_apply: {
      dsh: { global: '~/.dsh/skills', workspace: '{workspace}/.dsh/skills' },
      openclaw: { global: '~/.openclaw/skills', workspace: '{workspace}/.openclaw/skills' },
      claudecode: { global: '~/.claude/skills', workspace: '{workspace}/.claude/skills' },
    },
    agent_wait_timeout_ms: 180000,
    expert_liveness_max_renew: 3,
    task_round_timeout_ms: 7200000,
    ...overrides,
  })
}

function write(partial: Partial<AgentWrite> & Pick<AgentWrite, 'name' | 'workspace'>): AgentWrite {
  return {
    id: '',
    description: '',
    prompt: '',
    prompt_placement: 'system',
    skill_groups: [],
    prompt_append_skills: true,
    reuse_session: true,
    session_by_sender: false,
    permission_mode: 'danger-full-access',
    session_timeout_minutes: 30,
    concurrency: 'serial',
    needs_target_workspace: false,
    ...partial,
  }
}

describe('CRUD', () => {
  it('创建生成 id；name 必填；prompt 须是已有预设名或空', () => {
    seed()
    const ws = join(configDir, 'ws-a')
    const created = createAgent(write({ name: '联运', workspace: ws, prompt: 'default' }))
    expect(created.agent.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(created.agent.name).toBe('联运')
    expect(created.agent.prompt).toBe('default')
    expect(listAgents()).toHaveLength(1)
    expect(() => createAgent(write({ name: '  ', workspace: join(configDir, 'ws-b') }))).toThrow(/名称必填/)
    expect(() =>
      createAgent(write({ name: 'x', workspace: join(configDir, 'ws-c'), prompt: 'nope' })),
    ).toThrow(/未知 prompt 预设 nope/)
  })

  it('id 创建后不可改；未知 id 保存抛错', () => {
    seed()
    const ws = join(configDir, 'ws-a')
    const { agent } = createAgent(write({ name: '联运', workspace: ws }))
    const saved = saveAgent(write({ id: agent.id, name: '改名', workspace: ws }))
    expect(saved.agent.id).toBe(agent.id)
    expect(saved.agent.name).toBe('改名')
    expect(() => saveAgent(write({ id: 'missing', name: 'x', workspace: join(configDir, 'ws-x') }))).toThrow(
      /未知 agent missing/,
    )
  })

  it('删 agent 时 sessions map 随走', () => {
    seed({
      agents: [
        {
          id: 'a1',
          name: '联运',
          description: '',
          workspace: join(configDir, 'ws-a'),
          prompt: '',
          prompt_placement: 'system',
          skill_groups: [],
          prompt_append_skills: true,
          reuse_session: true,
          session_by_sender: false,
          permission_mode: 'danger-full-access',
          session_timeout_minutes: 30,
          concurrency: 'serial',
          needs_target_workspace: false,
          sessions: { r1_1: { sessionId: 'sid', lastAskAt: 1 } },
        },
      ],
    })
    deleteAgent('a1')
    expect(getAgent('a1')).toBeUndefined()
    expect(listAgents()).toEqual([])
  })
})

describe('workspace', () => {
  it('必填；保存时 mkdir；不得与其它 agent 重复', () => {
    seed()
    const ws = join(configDir, 'shared', 'proj')
    createAgent(write({ name: 'A', workspace: ws }))
    expect(existsSync(ws)).toBe(true)
    expect(() => createAgent(write({ name: 'B', workspace: ws }))).toThrow(/workspace 已被 agent/)
    expect(() => createAgent(write({ name: 'C', workspace: '   ' }))).toThrow(/workspace 必填/)
  })
})

describe('skill_groups', () => {
  it('一份组 id；未知剔除；保存不自动软链', () => {
    seed()
    const ws = join(configDir, 'ws-a')
    const r = createAgent(write({ name: '联运', workspace: ws, skill_groups: ['rd', 'gone', 'rd'] }))
    expect(r.droppedSkillGroupIds).toEqual(['gone'])
    expect(r.agent.skill_groups).toEqual(['rd'])
    expect(existsSync(join(ws, '.dsh', 'skills'))).toBe(false)
    expect(existsSync(join(ws, '.openclaw', 'skills'))).toBe(false)
    expect(existsSync(join(ws, '.claude', 'skills'))).toBe(false)
  })
})

describe('开关直绑', () => {
  it('reuse_session / session_by_sender / session_timeout_minutes 不取反', () => {
    seed()
    const ws = join(configDir, 'ws-sw')
    const r = createAgent(
      write({
        name: '开关',
        workspace: ws,
        reuse_session: false,
        session_by_sender: true,
        session_timeout_minutes: 0,
      }),
    )
    expect(r.agent.reuse_session).toBe(false)
    expect(r.agent.session_by_sender).toBe(true)
    expect(r.agent.session_timeout_minutes).toBe(0)
    expect(r.agent.permission_mode).toBe('danger-full-access')
    expect(r.agent.prompt_append_skills).toBe(true)
    const off = createAgent(write({ name: '不追加', workspace: join(configDir, 'ws-naskill'), prompt_append_skills: false }))
    expect(off.agent.prompt_append_skills).toBe(false)
    expect(r.agent.prompt_placement).toBe('system')
    const placed = createAgent(write({ name: '用户对话', workspace: join(configDir, 'ws-place'), prompt_placement: 'user' }))
    expect(placed.agent.prompt_placement).toBe('user')
    const ws2 = join(configDir, 'ws-perm')
    const p = createAgent(write({ name: '只读', workspace: ws2, permission_mode: 'read-only' }))
    expect(p.agent.permission_mode).toBe('read-only')
    const fallback = createAgent(
      write({ name: '非法', workspace: join(configDir, 'ws-bad'), permission_mode: 'custom' as 'read-only' }),
    )
    expect(fallback.agent.permission_mode).toBe('danger-full-access')
  })
})

describe('clearSession', () => {
  it('只删指定槽，其它槽保留', () => {
    const ws = join(configDir, 'ws-sess')
    seed({
      agents: [
        {
          id: 'a1',
          name: '联运',
          description: '',
          workspace: ws,
          prompt: '',
          prompt_placement: 'system',
          skill_groups: [],
          prompt_append_skills: true,
          reuse_session: true,
          session_by_sender: false,
          permission_mode: 'danger-full-access',
          session_timeout_minutes: 30,
          concurrency: 'serial',
          needs_target_workspace: false,
          sessions: {
            r1_1: { sessionId: 'sid-1', lastAskAt: 1 },
            r1_2: { sessionId: 'sid-2', lastAskAt: 2 },
          },
        },
      ],
    })
    clearSession('a1', 'r1_1')
    expect(getAgent('a1')?.sessions).toEqual({ r1_2: { sessionId: 'sid-2', lastAskAt: 2 } })
    expect(() => clearSession('a1', 'missing')).toThrow(/没有会话槽/)
  })
})

describe('touchSession', () => {
  it('收口写槽并覆盖同 key；未知 agent / 空字段抛错', () => {
    const ws = join(configDir, 'ws-touch')
    seed({
      agents: [
        {
          id: 'a1',
          name: '联运',
          description: '',
          workspace: ws,
          prompt: '',
          prompt_placement: 'system',
          skill_groups: [],
          prompt_append_skills: true,
          reuse_session: true,
          session_by_sender: false,
          permission_mode: 'danger-full-access',
          session_timeout_minutes: 30,
          concurrency: 'serial',
          needs_target_workspace: false,
          sessions: { r1_1: { sessionId: 'sid-old', lastAskAt: 1 } },
        },
      ],
    })
    touchSession('a1', 'r1_1', 'sid-new', 1_700_000_000_000, '文A')
    expect(getAgent('a1')?.sessions).toEqual({
      r1_1: { sessionId: 'sid-new', lastAskAt: 1_700_000_000_000, promptFingerprint: '文A' },
    })
    touchSession('a1', 'r1_2', 'sid-2', 1_700_000_000_100, '')
    expect(getAgent('a1')?.sessions).toEqual({
      r1_1: { sessionId: 'sid-new', lastAskAt: 1_700_000_000_000, promptFingerprint: '文A' },
      r1_2: { sessionId: 'sid-2', lastAskAt: 1_700_000_000_100, promptFingerprint: '' },
    })
    expect(() => touchSession('missing', 'k', 'sid', 1, '')).toThrow(/未知 agent/)
    expect(() => touchSession('a1', '', 'sid', 1, '')).toThrow(/sessionKey 不可为空/)
    expect(() => touchSession('a1', 'k', '', 1, '')).toThrow(/sessionId 不可为空/)
    expect(() => touchSession('a1', 'k', 'sid', 0, '')).toThrow(/lastAskAt 须为正的有限毫秒/)
  })
})

describe('applySkillGroups', () => {
  it('嵌套 id 用末段作单层名，不把分类目录编进软链名', () => {
    expect(flattenSkillLinkName('hub/union-business-daily-report')).toBe('union-business-daily-report')
    expect(flattenSkillLinkName('team/git')).toBe('git')
    expect(flattenSkillLinkName('git-skill')).toBe('git-skill')
    expect(() => flattenSkillLinkName('.')).toThrow(/无法为 skill id/)
    expect(() => flattenSkillLinkName('')).toThrow(/无法为 skill id/)
  })

  it('只动目标工具目录里本插件建的软链；不动其它工具目录', () => {
    const skillRoot = join(configDir, 'skills')
    const gitDir = join(skillRoot, 'git-skill')
    const nestedDir = join(skillRoot, 'team', 'icafe')
    mkdirSync(gitDir, { recursive: true })
    mkdirSync(nestedDir, { recursive: true })
    writeFileSync(join(gitDir, 'SKILL.md'), '# Git\n', 'utf8')
    writeFileSync(join(nestedDir, 'SKILL.md'), '# iCafe\n', 'utf8')
    saveSkillsMap({
      roots: [skillRoot],
      scanned_at: 1,
      skills: [
        { id: 'git-skill', name: 'Git', path: gitDir, description: '' },
        { id: 'team/icafe', name: 'iCafe', path: nestedDir, description: '' },
      ],
    })
    const ws = join(configDir, 'ws-apply')
    seed({
      skill_roots: [skillRoot],
      skill_groups: {
        rd: { id: 'rd', name: 'rd', skill_ids: ['git-skill', 'team/icafe'] },
      },
    })
    const { agent } = createAgent(write({ name: '联运', workspace: ws, skill_groups: ['rd'] }))

    const otherDir = join(ws, '.openclaw', 'skills')
    mkdirSync(otherDir, { recursive: true })
    const otherLink = join(otherDir, 'keep-me')
    symlinkSync(gitDir, otherLink, 'dir')
    const foreign = join(ws, '.dsh', 'skills', 'foreign')
    mkdirSync(join(ws, '.dsh', 'skills'), { recursive: true })
    writeFileSync(foreign, 'not-ours', 'utf8')

    applySkillGroups(agent.id, 'dsh', 'workspace', ['rd'])
    const dshDir = join(ws, '.dsh', 'skills')
    expect(lstatSync(join(dshDir, 'git-skill')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(dshDir, 'git-skill'))).toBe(gitDir)
    expect(lstatSync(join(dshDir, 'icafe')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(dshDir, 'icafe'))).toBe(nestedDir)
    expect(existsSync(foreign)).toBe(true)
    expect(lstatSync(otherLink).isSymbolicLink()).toBe(true)
    expect(existsSync(join(ws, '.claude', 'skills'))).toBe(false)

    applySkillGroups(agent.id, 'dsh', 'workspace', ['rd'])
    expect(lstatSync(join(dshDir, 'git-skill')).isSymbolicLink()).toBe(true)
    expect(existsSync(foreign)).toBe(true)
    expect(() => applySkillGroups(agent.id, 'unknown', 'workspace', ['rd'])).toThrow(/未知工具/)
    expect(() => applySkillGroups(agent.id, 'dsh', 'workspace', [])).toThrow(/请先选择技能组/)
  })

  it('global 槽写到传入家目录下 ~/.dsh/skills，不动 workspace', () => {
    const skillRoot = join(configDir, 'skills')
    const gitDir = join(skillRoot, 'git-skill')
    mkdirSync(gitDir, { recursive: true })
    writeFileSync(join(gitDir, 'SKILL.md'), '# Git\n', 'utf8')
    saveSkillsMap({
      roots: [skillRoot],
      scanned_at: 1,
      skills: [{ id: 'git-skill', name: 'Git', path: gitDir, description: '' }],
    })
    const ws = join(configDir, 'ws-home')
    const fakeHome = join(configDir, 'fake-home')
    seed({
      skill_roots: [skillRoot],
      skill_groups: { rd: { id: 'rd', name: 'rd', skill_ids: ['git-skill'] } },
    })
    const { agent } = createAgent(write({ name: '联运', workspace: ws, skill_groups: ['rd'] }))
    expect(() => applySkillGroups(agent.id, 'dsh', 'global', ['rd'])).toThrow(/global 槽请在 skills组页应用全局/)
    applyGlobalSkillGroupsAt('dsh', 'global', ['rd'], fakeHome)
    const homeDir = join(fakeHome, '.dsh', 'skills')
    expect(lstatSync(join(homeDir, 'git-skill')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(homeDir, 'git-skill'))).toBe(gitDir)
    expect(existsSync(join(ws, '.dsh', 'skills', 'git-skill'))).toBe(false)
    expect(resolveApplyTemplate('{workspace}/.dsh/skills', ws, fakeHome)).toBe(join(ws, '.dsh', 'skills'))
    expect(resolveApplyTemplate('~/.openclaw/skills', ws, fakeHome)).toBe(join(fakeHome, '.openclaw', 'skills'))
    expect(() => applyGlobalSkillGroupsAt('dsh', 'workspace', ['rd'], fakeHome)).toThrow(/必须是 global/)
    expect(() => applyGlobalSkillGroupsAt('dsh', 'global', [], fakeHome)).toThrow(/请先选择技能组/)
  })

  it('同一落点末段冲突显式报错', () => {
    const skillRoot = join(configDir, 'skills')
    const hubDir = join(skillRoot, 'hub', 'crash')
    const androidDir = join(skillRoot, 'android', 'crash')
    mkdirSync(hubDir, { recursive: true })
    mkdirSync(androidDir, { recursive: true })
    writeFileSync(join(hubDir, 'SKILL.md'), '# Hub crash\n', 'utf8')
    writeFileSync(join(androidDir, 'SKILL.md'), '# Android crash\n', 'utf8')
    saveSkillsMap({
      roots: [skillRoot],
      scanned_at: 1,
      skills: [
        { id: 'hub/crash', name: 'Hub crash', path: hubDir, description: '' },
        { id: 'android/crash', name: 'Android crash', path: androidDir, description: '' },
      ],
    })
    const ws = join(configDir, 'ws-dup')
    seed({
      skill_roots: [skillRoot],
      skill_groups: {
        rd: { id: 'rd', name: 'rd', skill_ids: ['hub/crash', 'android/crash'] },
      },
    })
    const { agent } = createAgent(write({ name: '联运', workspace: ws, skill_groups: ['rd'] }))
    expect(() => applySkillGroups(agent.id, 'dsh', 'workspace', ['rd'])).toThrow(/软链名冲突 crash/)
  })

  it('顶层 skill_apply 自定义模板生效；保存 agent 不改这份表', () => {
    const skillRoot = join(configDir, 'skills')
    const gitDir = join(skillRoot, 'git-skill')
    mkdirSync(gitDir, { recursive: true })
    writeFileSync(join(gitDir, 'SKILL.md'), '# Git\n', 'utf8')
    saveSkillsMap({
      roots: [skillRoot],
      scanned_at: 1,
      skills: [{ id: 'git-skill', name: 'Git', path: gitDir, description: '' }],
    })
    const ws = join(configDir, 'ws-custom')
    seed({
      skill_roots: [skillRoot],
      skill_groups: { rd: { id: 'rd', name: 'rd', skill_ids: ['git-skill'] } },
      skill_apply: { dsh: { workspace: '{workspace}/skills' } },
    })
    const { agent } = createAgent(write({ name: '联运', workspace: ws, skill_groups: ['rd'] }))
    applySkillGroups(agent.id, 'dsh', 'workspace', ['rd'])
    expect(lstatSync(join(ws, 'skills', 'git-skill')).isSymbolicLink()).toBe(true)
    expect(existsSync(join(ws, '.dsh', 'skills', 'git-skill'))).toBe(false)
    expect(loadConfig().skill_apply).toEqual({ dsh: { workspace: '{workspace}/skills' } })
  })

  it('apply 用传入的组，不读磁盘上旧的 skill_groups，并写回 agent', () => {
    const skillRoot = join(configDir, 'skills')
    const gitDir = join(skillRoot, 'git-skill')
    const unionDir = join(skillRoot, 'hub', 'union-data')
    mkdirSync(gitDir, { recursive: true })
    mkdirSync(unionDir, { recursive: true })
    writeFileSync(join(gitDir, 'SKILL.md'), '# Git\n', 'utf8')
    writeFileSync(join(unionDir, 'SKILL.md'), '# Union\n', 'utf8')
    saveSkillsMap({
      roots: [skillRoot],
      scanned_at: 1,
      skills: [
        { id: 'git-skill', name: 'Git', path: gitDir, description: '' },
        { id: 'hub/union-data', name: 'Union', path: unionDir, description: '' },
      ],
    })
    const ws = join(configDir, 'ws-form')
    seed({
      skill_roots: [skillRoot],
      skill_groups: {
        rd: { id: 'rd', name: 'rd', skill_ids: ['git-skill'] },
        'union-data': { id: 'union-data', name: 'union-data', skill_ids: ['hub/union-data'] },
      },
    })
    const { agent } = createAgent(write({ name: '联运', workspace: ws, skill_groups: ['union-data'] }))
    applySkillGroups(agent.id, 'dsh', 'workspace', ['rd', 'union-data'])
    const dshDir = join(ws, '.dsh', 'skills')
    expect(lstatSync(join(dshDir, 'git-skill')).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(dshDir, 'union-data')).isSymbolicLink()).toBe(true)
    expect(getAgent(agent.id)?.skill_groups).toEqual(['rd', 'union-data'])
  })
})
