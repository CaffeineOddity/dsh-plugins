/**
 * Prompts CRUD 与注入文本组装（Model）。
 * 变量只登记名字，不做拼接期静态替换（注册发生在 ask 的会话 setup，见 docs/specs/06-prompts.md）。
 * 文本里未提供的合法 {{name}}（含旧预设 {{webhook_url}}）登记为 `-`。
 */
import { flattenSkillLinkName } from './agents.js'
import {
  loadConfig,
  saveConfig,
  type AgentBotFileConfig,
  type PromptConfig,
  type PromptPlacement,
} from './config.js'

/** 大脑内置 prompt 变量（不含 sessionParts 键）。 */
export const BUILTIN_PROMPT_VARIABLES: readonly string[] = ['sender', 'session_key', 'provider_id']

/** 文本里未登记的 `{{name}}` 填这个，避免 DSH 整轮失败。 */
export const UNKNOWN_PROMPT_VARIABLE_FALLBACK = '-'

/** 与 DSH systemPrompt 一致：`{{name}}` 且 name 为小写字母开头。 */
const PROMPT_PLACEHOLDER = /\{\{([a-z][a-z0-9_]*)\}\}/g

/** 宿主 setup 时已经登记、本插件不得再写的变量。 */
const HARNESS_PROMPT_VARIABLES = new Set(['provider', 'model', 'cwd'])

/**
 * 从 prompt 文本抽出合法占位符名，去重保序。
 * 畸形 `{{...}}` 不收录（DSH 仍会因 malformed 失败）。
 */
export function promptPlaceholderNames(text: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  const re = new RegExp(PROMPT_PLACEHOLDER.source, 'g')
  let match = re.exec(text)
  while (match !== null) {
    const name = match[1]
    if (name !== undefined && !seen.has(name)) {
      seen.add(name)
      names.push(name)
    }
    match = re.exec(text)
  }
  return names
}

/** 文本里有、但本轮未提供值、且不是宿主内置的占位符，setup 时登记为 `-`。 */
export function unknownPromptVariableNames(text: string, known: ReadonlySet<string>): string[] {
  const out: string[] = []
  for (const name of promptPlaceholderNames(text)) {
    if (known.has(name) || HARNESS_PROMPT_VARIABLES.has(name)) continue
    out.push(name)
  }
  return out
}

/** 禁止出现在 prompt 变量里的键（投递字段；sender 走内置名）。 */
const FORBIDDEN_PROMPT_VARIABLES = new Set(['webhook_url', 'webhook', 'toid', 'sender'])

/** 把字面量 \\r\\n / \\n / \\r 转成真换行；已有 U+000A/U+000D 不动。 */
export function unescapePromptNewlines(prompt: string): string {
  return prompt.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\r/g, '\r')
}

/** 注入 agent 前把孤立换行扩成空行。 */
export function expandPromptNewlinesForAssembly(prompt: string): string {
  const normalized = unescapePromptNewlines(prompt).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  return normalized.replace(/\n+/g, (block) => (block.length >= 2 ? block : '\n\n'))
}

/** 推荐工具名：去空白、去空串、去重，保持原顺序。 */
export function recommendedToolNames(tools: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tools) {
    const name = raw.trim()
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/** 当前 agent 技能组展开成推荐工具名（posix 末段，与软链名一致）。未知组跳过。 */
export function skillToolNamesForAgent(skillGroupIds: readonly string[]): string[] {
  const groups = loadConfig().skill_groups
  const ids: string[] = []
  for (const gid of skillGroupIds) {
    const group = groups[gid]
    if (group === undefined) continue
    for (const skillId of group.skill_ids) ids.push(skillId)
  }
  return recommendedToolNames(ids.map(flattenSkillLinkName))
}

/**
 * 组装注入文本：换行展开后追加当前 agent 技能组展开的推荐工具。
 * 不读 prompts.*.tools，不调用宿主 tools 注册表、不裁剪工具面。
 */
export function assemblePromptText(preset: PromptConfig, skillToolNames: readonly string[]): string {
  const body = expandPromptNewlinesForAssembly(preset.system_prompt)
  const tools = recommendedToolNames(skillToolNames)
  if (tools.length === 0) return body
  const block = `推荐工具：${tools.join(', ')}`
  return body === '' ? block : `${body}\n\n${block}`
}

/** 槽上记录的 prompt 指纹：当前将注入的文本（空绑定 = 空串）。user 位置加前缀，避免与 system 同文撞指纹。 */
export function promptFingerprintFor(
  promptName: string,
  placement: PromptPlacement,
  skillGroupIds: readonly string[],
  appendSkills: boolean,
): string {
  const name = promptName.trim()
  if (name === '') return ''
  const preset = getPrompt(name)
  if (preset === undefined) throw new Error(`agent-bot: 未知预设 ${name}`)
  const tools = appendSkills ? skillToolNamesForAgent(skillGroupIds) : []
  const text = assemblePromptText(preset, tools)
  if (placement === 'user') return `user\n${text}`
  return text
}

/** 把 {{name}} 换成本轮变量值；未提供的填 `-`。宿主内置名同样按本轮 map 填。 */
export function renderPromptVariables(text: string, values: Record<string, string>): string {
  return text.replace(new RegExp(PROMPT_PLACEHOLDER.source, 'g'), (_all, name: string) => {
    const value = values[name]
    if (value === undefined || value === '') return UNKNOWN_PROMPT_VARIABLE_FALLBACK
    return value
  })
}

/** user 注入：把组装后的 prompt 接到用户 context 后，中间空一行。 */
export function appendPromptToUserContext(context: string, promptText: string, values: Record<string, string>): string {
  const rendered = renderPromptVariables(promptText, values)
  if (rendered === '') return context
  if (context === '') return rendered
  return `${context}\n\n${rendered}`
}

/**
 * 本轮应注册的 prompt 变量名：内置三项 + sessionParts 的键。
 * 通道 parts 含禁止键则抛错。不做静态替换。
 */
export function promptVariableNames(sessionParts: Record<string, string>): string[] {
  const names: string[] = [...BUILTIN_PROMPT_VARIABLES]
  const seen = new Set(names)
  for (const key of Object.keys(sessionParts)) {
    if (FORBIDDEN_PROMPT_VARIABLES.has(key)) {
      throw new Error(`agent-bot: prompt 变量禁止 ${key}`)
    }
    if (key === '' || sessionParts[key] === '') {
      throw new Error('agent-bot: sessionParts 键值不可为空')
    }
    if (seen.has(key)) continue
    seen.add(key)
    names.push(key)
  }
  return names
}

/** 列表项：预设名。tools 仍回传，配置站不展示。 */
export interface PromptListItem {
  name: string
  system_prompt: string
  tools: string[]
}

/** 当前 prompts；query 非空则按名称包含匹配（大小写不敏感）。 */
export function listPrompts(query: string): PromptListItem[] {
  const q = query.trim().toLowerCase()
  const items: PromptListItem[] = []
  for (const [name, preset] of Object.entries(loadConfig().prompts)) {
    if (q !== '' && !name.toLowerCase().includes(q)) continue
    items.push({ name, system_prompt: preset.system_prompt, tools: [...preset.tools] })
  }
  items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return items
}

/** 按名取一条；没有则 undefined。 */
export function getPrompt(name: string): PromptConfig | undefined {
  const preset = loadConfig().prompts[name]
  if (preset === undefined) return undefined
  return { system_prompt: preset.system_prompt, tools: [...preset.tools] }
}

/** 创建或覆盖一条。名称非空、唯一（覆盖同名即编辑）。 */
export function savePrompt(name: string, preset: PromptConfig): void {
  const key = name.trim()
  if (key === '') throw new Error('agent-bot: 预设名必填')
  const cfg = loadConfig()
  const next = copyPrompts(cfg.prompts)
  next[key] = cleanPreset(preset)
  persistPrompts(cfg, next)
}

/** 整表保存。将要删掉且仍被 agent 引用的预设会抛错。 */
export function savePrompts(prompts: Record<string, PromptConfig>): void {
  const cfg = loadConfig()
  const next: Record<string, PromptConfig> = {}
  for (const [rawName, preset] of Object.entries(prompts)) {
    const name = rawName.trim()
    if (name === '') throw new Error('agent-bot: 预设名必填')
    next[name] = cleanPreset(preset)
  }
  assertUnreferencedDeletions(cfg, Object.keys(next))
  persistPrompts(cfg, next)
}

/** 删除预设。仍有 agent 引用则禁止，提示先改 agent。 */
export function deletePrompt(name: string): void {
  const key = name.trim()
  if (key === '') throw new Error('agent-bot: 预设名必填')
  const cfg = loadConfig()
  if (cfg.prompts[key] === undefined) throw new Error(`agent-bot: 未知预设 ${key}`)
  const refs = agentsUsingPrompt(cfg, key)
  if (refs.length > 0) {
    throw new Error(`agent-bot: 预设 ${key} 仍被 agent 引用: ${refs.join(', ')}`)
  }
  const next = copyPrompts(cfg.prompts)
  delete next[key]
  persistPrompts(cfg, next)
}

/** 二次确认路径：删预设并把引用该名的 agent.prompt 置空。 */
export function deletePromptClearingRefs(name: string): void {
  const key = name.trim()
  if (key === '') throw new Error('agent-bot: 预设名必填')
  const cfg = loadConfig()
  if (cfg.prompts[key] === undefined) throw new Error(`agent-bot: 未知预设 ${key}`)
  const next = copyPrompts(cfg.prompts)
  delete next[key]
  const agents = cfg.agents.map((agent) => ({
    ...agent,
    prompt: agent.prompt === key ? '' : agent.prompt,
    sessions: { ...agent.sessions },
    skill_groups: [...agent.skill_groups],
  }))
  saveConfig({
    skill_roots: cfg.skill_roots,
    skill_groups: cfg.skill_groups,
    prompts: next,
    agents,
    skill_apply: cfg.skill_apply,
    agent_wait_timeout_ms: cfg.agent_wait_timeout_ms,
    expert_liveness_max_renew: cfg.expert_liveness_max_renew,
    task_round_timeout_ms: cfg.task_round_timeout_ms,
  })
}

function cleanPreset(preset: PromptConfig): PromptConfig {
  return {
    system_prompt: typeof preset.system_prompt === 'string' ? preset.system_prompt : '',
    tools: recommendedToolNames(preset.tools),
  }
}

function copyPrompts(prompts: Record<string, PromptConfig>): Record<string, PromptConfig> {
  const out: Record<string, PromptConfig> = {}
  for (const [k, v] of Object.entries(prompts)) {
    out[k] = { system_prompt: v.system_prompt, tools: [...v.tools] }
  }
  return out
}

function persistPrompts(cfg: AgentBotFileConfig, prompts: Record<string, PromptConfig>): void {
  saveConfig({
    skill_roots: cfg.skill_roots,
    skill_groups: cfg.skill_groups,
    prompts,
    agents: cfg.agents,
    skill_apply: cfg.skill_apply,
    agent_wait_timeout_ms: cfg.agent_wait_timeout_ms,
    expert_liveness_max_renew: cfg.expert_liveness_max_renew,
    task_round_timeout_ms: cfg.task_round_timeout_ms,
  })
}

function agentsUsingPrompt(cfg: AgentBotFileConfig, name: string): string[] {
  const ids: string[] = []
  for (const agent of cfg.agents) {
    if (agent.prompt === name) ids.push(agent.id)
  }
  return ids
}

function assertUnreferencedDeletions(cfg: AgentBotFileConfig, keepNames: string[]): void {
  const keep = new Set(keepNames)
  for (const name of Object.keys(cfg.prompts)) {
    if (keep.has(name)) continue
    const refs = agentsUsingPrompt(cfg, name)
    if (refs.length > 0) {
      throw new Error(`agent-bot: 预设 ${name} 仍被 agent 引用: ${refs.join(', ')}`)
    }
  }
}
