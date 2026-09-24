/**
 * Prompt CRUD / 删除保护 / 组装文本 / 变量名（H3 / D1–D4）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, resetConfigCache, saveConfig, type AgentBotFileConfig, type AgentConfig } from './config.js'
import {
  appendPromptToUserContext,
  assemblePromptText,
  BUILTIN_PROMPT_VARIABLES,
  deletePrompt,
  deletePromptClearingRefs,
  expandPromptNewlinesForAssembly,
  getPrompt,
  listPrompts,
  promptPlaceholderNames,
  promptVariableNames,
  renderPromptVariables,
  recommendedToolNames,
  savePrompt,
  savePrompts,
  unknownPromptVariableNames,
  UNKNOWN_PROMPT_VARIABLE_FALLBACK,
  promptFingerprintFor,
  skillToolNamesForAgent,
} from './prompts.js'

let configDir: string
let prevEnv: string | undefined

beforeEach(() => {
  prevEnv = process.env.AGENT_BOT_CONFIG_DIR
  configDir = mkdtempSync(join(tmpdir(), 'agentbot-prompts-'))
  process.env.AGENT_BOT_CONFIG_DIR = configDir
  resetConfigCache()
})

afterEach(() => {
  resetConfigCache()
  if (prevEnv === undefined) delete process.env.AGENT_BOT_CONFIG_DIR
  else process.env.AGENT_BOT_CONFIG_DIR = prevEnv
  rmSync(configDir, { recursive: true, force: true })
})

function agent(partial: Partial<AgentConfig> & Pick<AgentConfig, 'id' | 'name'>): AgentConfig {
  return {
    description: '',
    workspace: `/w/${partial.id}`,
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
    sessions: {},
    ...partial,
  }
}

function cfg(overrides: Partial<AgentBotFileConfig> = {}): AgentBotFileConfig {
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

describe('assemblePromptText', () => {
  it('展开孤立换行并追加传入的技能名，不读 prompts.*.tools', () => {
    expect(expandPromptNewlinesForAssembly('a\\nb')).toBe('a\n\nb')
    expect(recommendedToolNames([' bash ', '', 'bash', 'skill'])).toEqual(['bash', 'skill'])
    expect(assemblePromptText({ system_prompt: '你好\\n世界', tools: ['bash', 'skill'] }, ['union-xxx', 'git-skill'])).toBe(
      '你好\n\n世界\n\n推荐工具：union-xxx, git-skill',
    )
    expect(assemblePromptText({ system_prompt: '', tools: ['bash'] }, ['git-skill'])).toBe('推荐工具：git-skill')
    expect(assemblePromptText({ system_prompt: 'only', tools: ['bash'] }, [])).toBe('only')
  })

  it('skillToolNamesForAgent：按组展开 posix 末段，未知组跳过，去重保序', () => {
    saveConfig(
      cfg({
        skill_groups: {
          rd: { id: 'rd', name: 'rd', skill_ids: ['hub/union-xxx', 'git-skill'] },
          ops: { id: 'ops', name: 'ops', skill_ids: ['git-skill', 'team/icafe'] },
        },
      }),
    )
    expect(skillToolNamesForAgent(['rd', 'gone', 'ops'])).toEqual(['union-xxx', 'git-skill', 'icafe'])
    expect(skillToolNamesForAgent([])).toEqual([])
  })

  it('promptFingerprintFor：空绑定为空串；未知预设抛错；user 加前缀；技能组进指纹', () => {
    saveConfig(
      cfg({
        prompts: { default: { system_prompt: '你好', tools: ['bash'] } },
        skill_groups: { rd: { id: 'rd', name: 'rd', skill_ids: ['hub/union-xxx'] } },
      }),
    )
    expect(promptFingerprintFor('', 'system', [], true)).toBe('')
    expect(promptFingerprintFor('default', 'system', [], true)).toBe('你好')
    expect(promptFingerprintFor('default', 'user', [], true)).toBe('user\n你好')
    expect(promptFingerprintFor('default', 'system', ['rd'], true)).toBe('你好\n\n推荐工具：union-xxx')
    expect(promptFingerprintFor('default', 'system', ['rd'], false)).toBe('你好')
    expect(() => promptFingerprintFor('missing', 'system', [], true)).toThrow(/未知预设 missing/)
  })
})

describe('appendPromptToUserContext', () => {
  it('替换 {{变量}}；空 prompt 不改 context；中间空一行', () => {
    expect(renderPromptVariables('hi {{sender}} {{gone}}', { sender: 'alice' })).toBe('hi alice -')
    expect(appendPromptToUserContext('用户[alice]: 你好', '', {})).toBe('用户[alice]: 你好')
    expect(appendPromptToUserContext('', '角色说明', {})).toBe('角色说明')
    expect(appendPromptToUserContext('用户[alice]: 你好', '你是{{sender}}', { sender: 'alice' })).toBe(
      '用户[alice]: 你好\n\n你是alice',
    )
  })
})

describe('promptVariableNames', () => {
  it('内置 sender / session_key / provider_id，并并入 sessionParts 键', () => {
    expect(BUILTIN_PROMPT_VARIABLES).toEqual(['sender', 'session_key', 'provider_id'])
    expect(promptVariableNames({ bot_id: 'r1', group_id: '6031348' })).toEqual([
      'sender',
      'session_key',
      'provider_id',
      'bot_id',
      'group_id',
    ])
  })

  it('禁止 webhook_url 等投递字段', () => {
    expect(() => promptVariableNames({ webhook_url: 'http://x' })).toThrow(/禁止 webhook_url/)
    expect(() => promptVariableNames({ webhook: 'x' })).toThrow(/禁止 webhook/)
    expect(() => promptVariableNames({ toid: '1' })).toThrow(/禁止 toid/)
    expect(() => promptVariableNames({ sender: 'a' })).toThrow(/禁止 sender/)
  })
})

describe('unknownPromptVariableNames', () => {
  it('抽出合法占位符；未知的填 -，不覆盖已知与宿主内置', () => {
    expect(UNKNOWN_PROMPT_VARIABLE_FALLBACK).toBe('-')
    expect(promptPlaceholderNames('a {{sender}} b {{webhook_url}} {{sender}} {{Cwd}} {{x-y}}')).toEqual([
      'sender',
      'webhook_url',
    ])
    expect(
      unknownPromptVariableNames('{{sender}} {{webhook_url}} {{cwd}} {{model}}', new Set(['sender'])),
    ).toEqual(['webhook_url'])
  })
})

describe('CRUD', () => {
  it('可按名称筛；保存后能读回', () => {
    savePrompt('default', { system_prompt: 'hi', tools: ['bash'] })
    savePrompt('rd', { system_prompt: 'rd', tools: [] })
    expect(listPrompts('').map((p) => p.name)).toEqual(['default', 'rd'])
    expect(listPrompts('De').map((p) => p.name)).toEqual(['default'])
    expect(getPrompt('default')?.tools).toEqual(['bash'])
  })

  it('空名抛错', () => {
    expect(() => savePrompt('  ', { system_prompt: 'x', tools: [] })).toThrow(/预设名必填/)
  })
})

describe('删除保护', () => {
  it('仍有 agent 引用则默认禁止删', () => {
    saveConfig(
      cfg({
        prompts: { default: { system_prompt: 'hi', tools: [] } },
        agents: [agent({ id: 'a1', name: '联运', prompt: 'default' })],
      }),
    )
    expect(() => deletePrompt('default')).toThrow(/仍被 agent 引用: a1/)
    expect(getPrompt('default')).toBeDefined()
    expect(loadConfig().agents[0].prompt).toBe('default')
  })

  it('无引用可删；二次确认路径清空引用', () => {
    saveConfig(
      cfg({
        prompts: {
          default: { system_prompt: 'hi', tools: [] },
          extra: { system_prompt: 'e', tools: [] },
        },
        agents: [agent({ id: 'a1', name: '联运', prompt: 'default' })],
      }),
    )
    deletePrompt('extra')
    expect(getPrompt('extra')).toBeUndefined()
    deletePromptClearingRefs('default')
    expect(getPrompt('default')).toBeUndefined()
    expect(loadConfig().agents[0].prompt).toBe('')
  })

  it('savePrompts 删掉被引用预设同样抛错', () => {
    saveConfig(
      cfg({
        prompts: { default: { system_prompt: 'hi', tools: [] } },
        agents: [agent({ id: 'a1', name: '联运', prompt: 'default' })],
      }),
    )
    expect(() => savePrompts({})).toThrow(/仍被 agent 引用: a1/)
    savePrompts({ default: { system_prompt: '新', tools: ['bash'] } })
    expect(getPrompt('default')?.system_prompt).toBe('新')
  })
})
