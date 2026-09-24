/**
 * Skills 扫描冲突 / 分组 CRUD / 删组连带（H2 / C1–C4）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, resetConfigCache, saveConfig, type AgentBotFileConfig } from './config.js'
import {
  createSkillGroup,
  deleteSkillGroup,
  listDirectories,
  listSkillGroups,
  parseLinkmap,
  parseSkillMarkdown,
  registerSkillId,
  saveSkillRoots,
  scanSkills,
  toSkillId,
  updateSkillGroup,
} from './skills.js'

let configDir: string
let prevEnv: string | undefined

beforeEach(() => {
  prevEnv = process.env.AGENT_BOT_CONFIG_DIR
  configDir = mkdtempSync(join(tmpdir(), 'agentbot-skills-'))
  process.env.AGENT_BOT_CONFIG_DIR = configDir
  resetConfigCache()
})

afterEach(() => {
  resetConfigCache()
  if (prevEnv === undefined) delete process.env.AGENT_BOT_CONFIG_DIR
  else process.env.AGENT_BOT_CONFIG_DIR = prevEnv
  rmSync(configDir, { recursive: true, force: true })
})

function writeSkill(dir: string, md: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), md, 'utf8')
}

function emptyCfg(overrides: Partial<AgentBotFileConfig> = {}): AgentBotFileConfig {
  return {
    skill_roots: [],
    skill_groups: {},
    prompts: {},
    agents: [],
    skill_apply: {},
    agent_wait_timeout_ms: 180000,
    expert_liveness_max_renew: 3,
    task_round_timeout_ms: 7200000,
    use_hub_experts: true,
    ...overrides,
  }
}

describe('toSkillId / registerSkillId', () => {
  it('id 是相对 skill_root 的 posix 路径，可嵌套', () => {
    const root = join(configDir, 'skills')
    expect(toSkillId(root, join(root, 'git-skill'))).toBe('git-skill')
    expect(toSkillId(root, join(root, 'team', 'git'))).toBe('team/git')
  })

  it('同一 id 两个目录显式报错', () => {
    const ids = new Map<string, string>()
    registerSkillId(ids, 'git', '/a/git')
    expect(() => registerSkillId(ids, 'git', '/b/git')).toThrow(/skill id 冲突 "git"/)
    expect(() => registerSkillId(ids, 'git', '/a/git')).not.toThrow()
  })
})

describe('parseSkillMarkdown', () => {
  it('优先 frontmatter name/description，否则标题与首段', () => {
    expect(
      parseSkillMarkdown('---\nname: Git\ndescription: 摘要\n---\n# 忽略\n\n正文', 'fallback'),
    ).toEqual({ name: 'Git', description: '摘要' })
    expect(parseSkillMarkdown('# Git 技能\n\n首段摘要。\n\n更多', 'fallback')).toEqual({
      name: 'Git 技能',
      description: '首段摘要。',
    })
    expect(parseSkillMarkdown('没有标题', 'dir-name')).toEqual({ name: 'dir-name', description: '没有标题' })
  })
})

describe('listDirectories', () => {
  it('空 path 从家目录起；只列子目录', () => {
    const listed = listDirectories('')
    expect(listed.path).toBeTruthy()
    expect(listed.home).toBeTruthy()
    expect(listed.entries.every((e) => e.name !== '.' && !e.name.startsWith('.'))).toBe(true)
  })

  it('列给定目录的一层子目录，可回到父级', () => {
    const root = join(configDir, 'browse')
    mkdirSync(join(root, 'alpha'), { recursive: true })
    mkdirSync(join(root, 'beta'), { recursive: true })
    writeFileSync(join(root, 'file.txt'), 'x', 'utf8')
    const listed = listDirectories(root)
    expect(listed.path).toBe(root)
    expect(listed.parent).toBe(configDir)
    expect(listed.entries.map((e) => e.name)).toEqual(['alpha', 'beta'])
  })

  it('不存在的路径显式报错', () => {
    expect(() => listDirectories(join(configDir, 'gone'))).toThrow(/目录不存在/)
  })
})

describe('scanSkills', () => {
  it('skill_roots 为空则扫描报错', () => {
    saveConfig(emptyCfg())
    expect(() => scanSkills('')).toThrow(/未配置扫描目录/)
  })

  it('递归找含 SKILL.md 的目录并覆盖 skills-map', () => {
    const root = join(configDir, 'skills')
    writeSkill(join(root, 'git-skill'), '# Git\n\n版本控制')
    writeSkill(join(root, 'team', 'icafe'), '---\nname: iCafe\ndescription: 卡片\n---\n')
    mkdirSync(join(root, 'empty'), { recursive: true })
    saveConfig(emptyCfg({ skill_roots: [root] }))
    const map = scanSkills('')
    expect(map.roots).toEqual([root])
    expect(map.skills.map((s) => s.id).sort()).toEqual(['git-skill', 'team/icafe'])
    expect(map.skills.find((s) => s.id === 'git-skill')?.name).toBe('Git')
    expect(map.skills.find((s) => s.id === 'team/icafe')?.description).toBe('卡片')
    expect(loadConfig().skill_groups).toEqual({})
  })

  it('skill.md 小写也算技能目录', () => {
    const root = join(configDir, 'skills')
    const dir = join(root, 'harmony', 'arkts-course')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'skill.md'), '# ArkTS\n\n鸿蒙课程\n', 'utf8')
    saveConfig(emptyCfg({ skill_roots: [root] }))
    const map = scanSkills('')
    expect(map.skills.map((s) => s.id)).toEqual(['harmony/arkts-course'])
    expect(map.skills[0]?.name).toBe('ArkTS')
  })

  it('多个扫描目录合并扫描，按 id 排序', () => {
    const rootA = join(configDir, 'skills-a')
    const rootB = join(configDir, 'skills-b')
    writeSkill(join(rootA, 'git-skill'), '# Git\n\n版本控制')
    writeSkill(join(rootB, 'team', 'icafe'), '# iCafe\n\n卡片')
    writeSkill(join(rootB, 'aa-skill'), '# AA\n\n先排')
    saveConfig(emptyCfg({ skill_roots: [rootA, rootB] }))
    const map = scanSkills('')
    expect(map.roots).toEqual([rootA, rootB])
    expect(map.skills.map((s) => s.id)).toEqual(['aa-skill', 'git-skill', 'team/icafe'])
    expect(map.skills.find((s) => s.id === 'git-skill')?.path).toBe(join(rootA, 'git-skill'))
    expect(map.skills.find((s) => s.id === 'team/icafe')?.path).toBe(join(rootB, 'team', 'icafe'))
  })

  it('跨目录同 id 扫描显式报错', () => {
    const rootA = join(configDir, 'skills-a')
    const rootB = join(configDir, 'skills-b')
    writeSkill(join(rootA, 'global', 'brainstorming'), '# A\n\na')
    writeSkill(join(rootB, 'global', 'brainstorming'), '# B\n\nb')
    saveConfig(emptyCfg({ skill_roots: [rootA, rootB] }))
    expect(() => scanSkills('')).toThrow(/skill id 冲突 "global\/brainstorming"/)
  })

  it('空项跳过；root 不存在显式报错', () => {
    const root = join(configDir, 'skills')
    writeSkill(join(root, 'git-skill'), '# Git\n\nok')
    saveConfig(emptyCfg({ skill_roots: ['', root] }))
    const map = scanSkills('')
    expect(map.skills.map((s) => s.id)).toEqual(['git-skill'])
    saveConfig(emptyCfg({ skill_roots: [join(configDir, 'gone')] }))
    expect(() => scanSkills('')).toThrow(/扫描目录不存在/)
  })

  it('指定 root 只扫该根，其它根已有技能保留', () => {
    const rootA = join(configDir, 'skills-a')
    const rootB = join(configDir, 'skills-b')
    writeSkill(join(rootA, 'git-skill'), '# Git\n\n版本控制')
    writeSkill(join(rootB, 'team', 'icafe'), '# iCafe\n\n卡片')
    saveConfig(emptyCfg({ skill_roots: [rootA, rootB] }))
    scanSkills(rootA)
    writeSkill(join(rootA, 'extra'), '# Extra\n\n后加')
    const map = scanSkills(rootB)
    expect(map.skills.map((s) => s.id)).toEqual(['git-skill', 'team/icafe'])
    expect(map.roots.sort()).toEqual([rootA, rootB].sort())
    const again = scanSkills(rootA)
    expect(again.skills.map((s) => s.id)).toEqual(['extra', 'git-skill', 'team/icafe'])
    expect(() => scanSkills(join(configDir, 'gone'))).toThrow(/不在 skill_roots 内/)
  })
})

describe('saveSkillRoots', () => {
  it('trim、丢掉空项、去重', () => {
    saveConfig(emptyCfg())
    saveSkillRoots(['  /a  ', '', '/b', '/a', '/b'])
    expect(loadConfig().skill_roots).toEqual(['/a', '/b'])
  })
})

describe('skill groups', () => {
  it('未知 skill_ids 保存时剔除并提示', () => {
    const root = join(configDir, 'skills')
    writeSkill(join(root, 'git-skill'), '# Git\n\nok')
    saveConfig(emptyCfg({ skill_roots: [root] }))
    scanSkills('')
    const result = createSkillGroup('rd', ['git-skill', 'gone', 'git-skill'])
    expect(result.droppedSkillIds).toEqual(['gone'])
    expect(listSkillGroups().rd.skill_ids).toEqual(['git-skill'])
  })

  it('名称冲突抛错；改名改 skill_ids', () => {
    const root = join(configDir, 'skills')
    writeSkill(join(root, 'a'), '# A\n\na')
    writeSkill(join(root, 'b'), '# B\n\nb')
    saveConfig(emptyCfg({ skill_roots: [root] }))
    scanSkills('')
    createSkillGroup('rd', ['a'])
    expect(() => createSkillGroup('rd', ['b'])).toThrow(/冲突/)
    const r = updateSkillGroup('rd', '研发', ['b'])
    expect(r.droppedSkillIds).toEqual([])
    expect(listSkillGroups().rd).toEqual({ id: 'rd', name: '研发', skill_ids: ['b'] })
  })

  it('删组从所有 agents[].skill_groups 去掉该 id', () => {
    const root = join(configDir, 'skills')
    writeSkill(join(root, 'git-skill'), '# Git\n\nok')
    saveConfig(
      emptyCfg({
        skill_roots: [root],
        skill_groups: {
          rd: { id: 'rd', name: 'rd', skill_ids: ['git-skill'] },
          ops: { id: 'ops', name: 'ops', skill_ids: [] },
        },
        agents: [
          {
            id: 'a1',
            name: '联运',
            description: '',
            workspace: '/w1',
            prompt: '',
            prompt_placement: 'system',
            skill_groups: ['rd', 'ops'],
            prompt_append_skills: true,
            reuse_session: true,
            session_by_sender: false,
            permission_mode: 'danger-full-access',
            session_timeout_minutes: 30,
            concurrency: 'serial',
            needs_target_workspace: false,
            sessions: {},
          },
          {
            id: 'a2',
            name: '其它',
            description: '',
            workspace: '/w2',
            prompt: '',
            prompt_placement: 'system',
            skill_groups: ['rd'],
            prompt_append_skills: true,
            reuse_session: true,
            session_by_sender: false,
            permission_mode: 'danger-full-access',
            session_timeout_minutes: 30,
            concurrency: 'serial',
            needs_target_workspace: false,
            sessions: {},
          },
        ],
      }),
    )
    deleteSkillGroup('rd')
    const cfg = loadConfig()
    expect(cfg.skill_groups.rd).toBeUndefined()
    expect(cfg.skill_groups.ops).toBeDefined()
    expect(cfg.agents[0].skill_groups).toEqual(['ops'])
    expect(cfg.agents[1].skill_groups).toEqual([])
  })
})

describe('parseLinkmap / 扫描套用 linkmap', () => {
  it('拒绝非对象与非字符串数组', () => {
    expect(() => parseLinkmap([])).toThrow(/须为对象/)
    expect(() => parseLinkmap({ g: 'a' })).toThrow(/须为字符串数组/)
    expect(() => parseLinkmap({ g: ['ok', 1] })).toThrow(/非法技能 id/)
  })

  it('扫描时读 .agentbot/linkmap.json：精确 id、末段匹配、未知剔除、覆盖同 id 组', () => {
    const root = join(configDir, 'skills')
    writeSkill(join(root, 'git-skill'), '# Git\n\nok')
    writeSkill(join(root, 'team', 'icafe'), '# iCafe\n\nok')
    mkdirSync(join(root, '.agentbot'), { recursive: true })
    writeFileSync(
      join(root, '.agentbot', 'linkmap.json'),
      JSON.stringify({
        global: ['git-skill', 'gone'],
        'union-data': ['icafe'],
      }),
      'utf8',
    )
    saveConfig(
      emptyCfg({
        skill_roots: [root],
        skill_groups: { keep: { id: 'keep', name: '保留', skill_ids: [] } },
      }),
    )
    const r = scanSkills('')
    expect(r.groupsApplied.sort()).toEqual(['global', 'union-data'])
    expect(r.droppedSkillIds).toEqual(['gone'])
    expect(r.ambiguousSkillIds).toEqual([])
    expect(r.groupCount).toBe(3)
    const groups = listSkillGroups()
    expect(groups.keep).toEqual({ id: 'keep', name: '保留', skill_ids: [] })
    expect(groups.global.skill_ids).toEqual(['git-skill'])
    expect(groups['union-data'].skill_ids).toEqual(['team/icafe'])
  })

  it('多个目录各自的 linkmap 依次套用；针对合并后的完整产物匹配', () => {
    const rootA = join(configDir, 'skills-a')
    const rootB = join(configDir, 'skills-b')
    writeSkill(join(rootA, 'git-skill'), '# Git\n\nok')
    writeSkill(join(rootB, 'team', 'icafe'), '# iCafe\n\nok')
    mkdirSync(join(rootA, '.agentbot'), { recursive: true })
    writeFileSync(join(rootA, '.agentbot', 'linkmap.json'), JSON.stringify({ rd: ['git-skill'] }), 'utf8')
    mkdirSync(join(rootB, '.agentbot'), { recursive: true })
    writeFileSync(join(rootB, '.agentbot', 'linkmap.json'), JSON.stringify({ data: ['icafe'] }), 'utf8')
    saveConfig(emptyCfg({ skill_roots: [rootA, rootB] }))
    const r = scanSkills('')
    expect(r.groupsApplied.sort()).toEqual(['data', 'rd'])
    const groups = listSkillGroups()
    expect(groups.rd.skill_ids).toEqual(['git-skill'])
    expect(groups.data.skill_ids).toEqual(['team/icafe'])
  })

  it('缺 linkmap 仍扫描成功，不改已有组', () => {
    const root = join(configDir, 'skills')
    writeSkill(join(root, 'a'), '# A\n\na')
    saveConfig(
      emptyCfg({
        skill_roots: [root],
        skill_groups: { keep: { id: 'keep', name: '保留', skill_ids: [] } },
      }),
    )
    const r = scanSkills('')
    expect(r.skills.map((s) => s.id)).toEqual(['a'])
    expect(r.groupsApplied).toEqual([])
    expect(r.groupCount).toBe(1)
    expect(listSkillGroups().keep).toEqual({ id: 'keep', name: '保留', skill_ids: [] })
  })
})
