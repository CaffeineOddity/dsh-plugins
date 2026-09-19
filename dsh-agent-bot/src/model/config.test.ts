/**
 * 配置规范化与默认路径（H1 / B2 / B3）。测试用临时目录覆盖 env。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  configDirPath,
  agentsFilePath,
  configFilePath,
  DEFAULT_AGENT_WAIT_TIMEOUT_MS,
  loadConfig,
  loadSkillsMap,
  normalize,
  parseAgentWaitTimeoutMs,
  promptsFilePath,
  resetConfigCache,
  saveConfig,
  saveSkillsMap,
  skillGroupsFilePath,
  skillsMapFilePath,
  STORAGE_ROOT,
  type AgentBotFileConfig,
} from './config.js'

let configDir: string
let prevEnv: string | undefined

beforeEach(() => {
  prevEnv = process.env.AGENT_BOT_CONFIG_DIR
  configDir = mkdtempSync(join(tmpdir(), 'agentbot-test-'))
  process.env.AGENT_BOT_CONFIG_DIR = configDir
  resetConfigCache()
})

afterEach(() => {
  resetConfigCache()
  if (prevEnv === undefined) delete process.env.AGENT_BOT_CONFIG_DIR
  else process.env.AGENT_BOT_CONFIG_DIR = prevEnv
  rmSync(configDir, { recursive: true, force: true })
})

describe('configDirPath', () => {
  it('缺省 ~/.dsh/storages/agentbot；env 覆盖', () => {
    delete process.env.AGENT_BOT_CONFIG_DIR
    expect(configDirPath()).toBe(STORAGE_ROOT)
    process.env.AGENT_BOT_CONFIG_DIR = configDir
    expect(configDirPath()).toBe(configDir)
    expect(configFilePath()).toBe(join(configDir, 'config.json'))
    expect(skillGroupsFilePath()).toBe(join(configDir, 'skill-groups.json'))
    expect(promptsFilePath()).toBe(join(configDir, 'prompts.json'))
    expect(agentsFilePath()).toBe(join(configDir, 'agents.json'))
    expect(skillsMapFilePath()).toBe(join(configDir, 'skills-map.json'))
  })
})

describe('parseAgentWaitTimeoutMs', () => {
  it('只接受 1000–1800000 的正整数', () => {
    expect(parseAgentWaitTimeoutMs(180000)).toBe(180000)
    expect(parseAgentWaitTimeoutMs('60000')).toBe(60000)
    expect(parseAgentWaitTimeoutMs(0)).toBe(null)
    expect(parseAgentWaitTimeoutMs(-1)).toBe(null)
    expect(parseAgentWaitTimeoutMs(999)).toBe(null)
    expect(parseAgentWaitTimeoutMs(1800001)).toBe(null)
    expect(parseAgentWaitTimeoutMs(1.5)).toBe(null)
    expect(parseAgentWaitTimeoutMs('abc')).toBe(null)
  })
})

describe('normalize', () => {
  it('缺字段给默认值；非法超时回退 180000', () => {
    const cfg = normalize({
      agent_wait_timeout_ms: 500,
      agents: [{ id: 'a1', name: '联运' }],
    })
    expect(cfg.agent_wait_timeout_ms).toBe(DEFAULT_AGENT_WAIT_TIMEOUT_MS)
    expect(cfg.skill_roots).toEqual([])
    expect(cfg.skill_groups).toEqual({})
    expect(cfg.prompts).toEqual({})
    expect(cfg.agents).toHaveLength(1)
    expect(cfg.agents[0]).toEqual({
      id: 'a1',
      name: '联运',
      description: '',
      workspace: '',
      prompt: '',
      prompt_placement: 'system',
      skill_groups: [],
      prompt_append_skills: true,
      reuse_session: true,
      session_by_sender: false,
      permission_mode: 'danger-full-access',
      session_timeout_minutes: 30,
      sessions: {},
    })
    expect(cfg.skill_apply).toEqual({
      dsh: { global: '~/.dsh/skills', workspace: '{workspace}/.dsh/skills' },
      openclaw: { global: '~/.openclaw/skills', workspace: '{workspace}/.openclaw/skills' },
      claudecode: { global: '~/.claude/skills', workspace: '{workspace}/.claude/skills' },
    })
  })

  it('显式 false / 0 不被默认值覆盖', () => {
    const cfg = normalize({
      agents: [
        {
          id: 'a1',
          name: 'x',
          reuse_session: false,
          session_by_sender: true,
          permission_mode: 'workspace-write',
          session_timeout_minutes: 0,
        },
      ],
    })
    expect(cfg.agents[0].reuse_session).toBe(false)
    expect(cfg.agents[0].session_by_sender).toBe(true)
    expect(cfg.agents[0].permission_mode).toBe('workspace-write')
    expect(cfg.agents[0].session_timeout_minutes).toBe(0)
  })

  it('permission_mode 缺字段或非法回退完全访问', () => {
    expect(normalize({ agents: [{ id: 'a1', name: 'x' }] }).agents[0].permission_mode).toBe('danger-full-access')
    expect(
      normalize({ agents: [{ id: 'a1', name: 'x', permission_mode: 'read-only' }] }).agents[0].permission_mode,
    ).toBe('read-only')
    expect(
      normalize({ agents: [{ id: 'a1', name: 'x', permission_mode: 'custom' }] }).agents[0].permission_mode,
    ).toBe('danger-full-access')
  })

  it('prompt_placement 缺字段或非法回退系统提示词', () => {
    expect(normalize({ agents: [{ id: 'a1', name: 'x' }] }).agents[0].prompt_placement).toBe('system')
    expect(
      normalize({ agents: [{ id: 'a1', name: 'x', prompt_placement: 'user' }] }).agents[0].prompt_placement,
    ).toBe('user')
    expect(
      normalize({ agents: [{ id: 'a1', name: 'x', prompt_placement: 'other' }] }).agents[0].prompt_placement,
    ).toBe('system')
  })

  it('prompt_append_skills 缺字段回退 true', () => {
    expect(normalize({ agents: [{ id: 'a1', name: 'x' }] }).agents[0].prompt_append_skills).toBe(true)
    expect(
      normalize({ agents: [{ id: 'a1', name: 'x', prompt_append_skills: false }] }).agents[0].prompt_append_skills,
    ).toBe(false)
  })

  it('缺 skill_apply 用内置缺省；显式 {} 表示无落点', () => {
    const missing = normalize({ agents: [{ id: 'a1', name: 'x' }] })
    expect(missing.skill_apply.dsh.global).toBe('~/.dsh/skills')
    expect(missing.skill_apply.dsh.workspace).toBe('{workspace}/.dsh/skills')
    const empty = normalize({ skill_apply: {}, agents: [{ id: 'a1', name: 'x' }] })
    expect(empty.skill_apply).toEqual({})
    const custom = normalize({
      skill_apply: { dsh: { workspace: '{workspace}/skills' } },
      agents: [{ id: 'a1', name: 'x' }],
    })
    expect(custom.skill_apply).toEqual({ dsh: { workspace: '{workspace}/skills' } })
  })

  it('合法超时保留；agent 无 id 丢弃', () => {
    const cfg = normalize({
      agent_wait_timeout_ms: 120000,
      agents: [{ name: '无 id' }, { id: 'ok', name: '有' }],
    })
    expect(cfg.agent_wait_timeout_ms).toBe(120000)
    expect(cfg.agents.map((a) => a.id)).toEqual(['ok'])
  })
})

describe('loadConfig / saveConfig', () => {
  it('缺文件给默认值且不落盘', () => {
    const cfg = loadConfig()
    expect(cfg.agents).toEqual([])
    expect(cfg.agent_wait_timeout_ms).toBe(DEFAULT_AGENT_WAIT_TIMEOUT_MS)
    expect(existsSync(configFilePath())).toBe(false)
    expect(existsSync(skillGroupsFilePath())).toBe(false)
    expect(existsSync(promptsFilePath())).toBe(false)
    expect(existsSync(agentsFilePath())).toBe(false)
  })

  it('save 后拆成四个文件；config.json 不含 groups/prompts/agents', () => {
    const data: AgentBotFileConfig = {
      skill_roots: ['/abs/skills'],
      skill_groups: { rd: { id: 'rd', name: 'rd', skill_ids: ['git-skill'] } },
      prompts: { default: { system_prompt: 'hi', tools: ['bash'] } },
      agents: [
        {
          id: 'a1',
          name: '联运RD',
          description: '答疑',
          workspace: '~/Documents/agents/union-rd',
          prompt: 'default',
          prompt_placement: 'system',
          skill_groups: ['rd'],
          prompt_append_skills: true,
          reuse_session: true,
          session_by_sender: false,
          permission_mode: 'danger-full-access',
          session_timeout_minutes: 30,
          sessions: { r1_6031348: { sessionId: 'uuid-1', lastAskAt: 1730000000000 } },
        },
      ],
      skill_apply: {
        dsh: { global: '~/.dsh/skills', workspace: '{workspace}/.dsh/skills' },
      },
      agent_wait_timeout_ms: 60000,
    }
    saveConfig(data)
    expect(existsSync(configFilePath())).toBe(true)
    resetConfigCache()
    const loaded = loadConfig()
    expect(loaded.skill_roots).toEqual(['/abs/skills'])
    expect(loaded.skill_apply).toEqual({ dsh: { global: '~/.dsh/skills', workspace: '{workspace}/.dsh/skills' } })
    expect(loaded.agents[0].sessions.r1_6031348.sessionId).toBe('uuid-1')
    expect(loaded.skill_groups.rd.skill_ids).toEqual(['git-skill'])
    expect(loaded.prompts.default.system_prompt).toBe('hi')
    const disk = JSON.parse(readFileSync(configFilePath(), 'utf8')) as Record<string, unknown>
    expect(disk.agent_wait_timeout_ms).toBe(60000)
    expect(disk.skill_groups).toBeUndefined()
    expect(disk.prompts).toBeUndefined()
    expect(disk.agents).toBeUndefined()
    expect(JSON.parse(readFileSync(skillGroupsFilePath(), 'utf8')).rd.id).toBe('rd')
    expect(JSON.parse(readFileSync(promptsFilePath(), 'utf8')).default.tools).toEqual(['bash'])
    expect(JSON.parse(readFileSync(agentsFilePath(), 'utf8'))[0].id).toBe('a1')
  })

  it('分文件优先；缺分文件时回退旧 config.json 嵌套字段', () => {
    writeFileSync(
      configFilePath(),
      JSON.stringify({
        skill_roots: ['/old'],
        skill_groups: { rd: { id: 'rd', name: 'rd', skill_ids: ['git-skill'] } },
        prompts: { default: { system_prompt: '旧', tools: [] } },
        agents: [{ id: 'a1', name: '联运' }],
        skill_apply: { dsh: { global: '~/.dsh/skills' } },
        agent_wait_timeout_ms: 60000,
      }),
      'utf8',
    )
    const nested = loadConfig()
    expect(nested.skill_roots).toEqual(['/old'])
    expect(nested.skill_groups.rd.name).toBe('rd')
    expect(nested.prompts.default.system_prompt).toBe('旧')
    expect(nested.agents[0].id).toBe('a1')
    resetConfigCache()
    writeFileSync(skillGroupsFilePath(), JSON.stringify({ ops: { id: 'ops', name: 'ops', skill_ids: [] } }), 'utf8')
    writeFileSync(promptsFilePath(), JSON.stringify({ p: { system_prompt: '新', tools: [] } }), 'utf8')
    writeFileSync(agentsFilePath(), JSON.stringify([{ id: 'a2', name: '拆出' }]), 'utf8')
    const split = loadConfig()
    expect(split.skill_groups.ops.name).toBe('ops')
    expect(split.skill_groups.rd).toBeUndefined()
    expect(split.prompts.p.system_prompt).toBe('新')
    expect(split.agents.map((a) => a.id)).toEqual(['a2'])
    expect(split.skill_roots).toEqual(['/old'])
  })
})

describe('不读外部旧配置', () => {
  it('即使 LEGACY_CONFIG_DIR 里有 presets 也不进中枢', () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'legacy-old-'))
    writeFileSync(
      join(legacyDir, 'config.json'),
      JSON.stringify({ presets: { default: { system_prompt: '旧预设', tools: [] } } }),
      'utf8',
    )
    process.env.LEGACY_CONFIG_DIR = legacyDir
    const cfg = loadConfig()
    expect(cfg.prompts).toEqual({})
    expect(existsSync(configFilePath())).toBe(false)
    delete process.env.LEGACY_CONFIG_DIR
    rmSync(legacyDir, { recursive: true, force: true })
  })
})

describe('skills-map.json', () => {
  it('与 config.json 同目录；扫描覆盖；不进 config.json', () => {
    saveSkillsMap({
      roots: ['/abs/skills'],
      scanned_at: 123,
      skills: [{ id: 'git-skill', name: 'Git', path: '/abs/skills/git-skill', description: '摘要' }],
    })
    expect(skillsMapFilePath()).toBe(join(configDir, 'skills-map.json'))
    const map = loadSkillsMap()
    expect(map.skills[0].id).toBe('git-skill')
    saveConfig({
      skill_roots: ['/abs/skills'],
      skill_groups: {},
      prompts: {},
      agents: [],
      skill_apply: {},
      agent_wait_timeout_ms: 180000,
    })
    const disk = JSON.parse(readFileSync(configFilePath(), 'utf8')) as Record<string, unknown>
    expect(disk.skills).toBeUndefined()
    expect(disk.roots).toBeUndefined()
    expect(existsSync(skillsMapFilePath())).toBe(true)
  })

  it('缺 skills-map 给空 map 不落盘', () => {
    const map = loadSkillsMap()
    expect(map).toEqual({ roots: [], scanned_at: 0, skills: [] })
    expect(existsSync(skillsMapFilePath())).toBe(false)
  })
})
