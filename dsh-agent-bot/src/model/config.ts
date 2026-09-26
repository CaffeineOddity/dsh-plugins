/**
 * 智能体中枢配置读写与热更新。
 *
 * 目录：`env:AGENT_BOT_CONFIG_DIR`，缺省 `~/.dsh/storages/agentbot`。
 * `config.json`（skill_roots / skill_apply / 超时）与 `skill-groups.json` /
 * `prompts.json` / `agents.json` / `skills-map.json` 同目录，不套 `config/`。
 * 本插件只认这一目录。缺文件给内存默认值、不落盘
 * （见 docs/specs/04-config-model.md）。
 */
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** agent 等待超时默认值（毫秒）。 */
export const DEFAULT_AGENT_WAIT_TIMEOUT_MS = 180_000

/** agent 等待超时下限（毫秒）。 */
export const MIN_AGENT_WAIT_TIMEOUT_MS = 1_000

/** agent 等待超时上限（毫秒）。 */
export const MAX_AGENT_WAIT_TIMEOUT_MS = 1_800_000

/** 专家活性探针续期上限默认值。 */
export const DEFAULT_EXPERT_LIVENESS_MAX_RENEW = 3

/** 任务墙钟默认值（毫秒，2h）。 */
export const DEFAULT_TASK_ROUND_TIMEOUT_MS = 7_200_000

/** 专家清单来源默认值：true=中枢全集（路线 b），false=群快照（Provider 投影）。 */
export const DEFAULT_USE_HUB_EXPERTS = true

/** 空闲超时默认值（分钟）。 */
export const DEFAULT_SESSION_TIMEOUT_MINUTES = 30

/** 会话权限预设。对齐 DSH permission/preset。 */
export type PermissionMode = 'danger-full-access' | 'workspace-write' | 'read-only'

/** 合法权限预设。 */
export const PERMISSION_MODES: readonly PermissionMode[] = [
  'danger-full-access',
  'workspace-write',
  'read-only',
]

/** 权限默认值：完全访问。 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'danger-full-access'

/** prompt 注入位置：系统提示词或接到用户对话后。 */
export type PromptPlacement = 'system' | 'user'

/** 合法注入位置。 */
export const PROMPT_PLACEMENTS: readonly PromptPlacement[] = ['system', 'user']

/** 注入位置默认值：系统提示词。 */
export const DEFAULT_PROMPT_PLACEMENT: PromptPlacement = 'system'

/** 磁盘并发模式：serial=该专家所有来源进同一 FIFO；concurrent=不同 target 的 write 可并行。 */
export type Concurrency = 'serial' | 'concurrent'

/** 合法并发模式。 */
export const CONCURRENCIES: readonly Concurrency[] = ['serial', 'concurrent']

/** 并发默认值：串行。 */
export const DEFAULT_CONCURRENCY: Concurrency = 'serial'

/** 存储根：~/.dsh/storages/agentbot。 */
export const STORAGE_ROOT = join(homedir(), '.dsh', 'storages', 'agentbot')

/** 技能分组。 */
export interface SkillGroupConfig {
  id: string
  name: string
  skill_ids: string[]
}

/** Prompt 预设。 */
export interface PromptConfig {
  system_prompt: string
  tools: string[]
}

/** 会话槽：sessionKey → { sessionId, lastAskAt, promptFingerprint? }。 */
export interface SessionSlot {
  sessionId: string
  lastAskAt: number
  /** 本轮注入文本；缺省表示旧槽，续接时视为与当前一致。 */
  promptFingerprint?: string
}

/** 一个工具的落点槽：槽名 → 路径模板。 */
export type SkillApplySlots = Record<string, string>

/** 按工具名组织的软链落点。 */
export type SkillApplyConfig = Record<string, SkillApplySlots>

/** 缺省落点：dsh / openclaw / claudecode 各 global + workspace。 */
export const DEFAULT_SKILL_APPLY: SkillApplyConfig = {
  dsh: { global: '~/.dsh/skills', workspace: '{workspace}/.dsh/skills' },
  openclaw: { global: '~/.openclaw/skills', workspace: '{workspace}/.openclaw/skills' },
  claudecode: { global: '~/.claude/skills', workspace: '{workspace}/.claude/skills' },
}

/** 一个智能体。 */
export interface AgentConfig {
  id: string
  name: string
  /** 英文命令别名：非空时注册 /agent_<slug> 斜杠命令。须匹配 ^[a-z][a-z0-9_-]*$。 */
  slug?: string
  description: string
  workspace: string
  prompt: string
  prompt_placement: PromptPlacement
  skill_groups: string[]
  prompt_append_skills: boolean
  reuse_session: boolean
  session_by_sender: boolean
  permission_mode: PermissionMode
  session_timeout_minutes: number
  /** 磁盘并发：serial 该专家所有来源同一 FIFO；concurrent 不同 target 的 write 可并行。 */
  concurrency: Concurrency
  /** true：被 dispatch_expert / 直连 / 直 @ 时必须带已存在的绝对路径 target_workspace。会话 cwd 仍是 workspace。 */
  needs_target_workspace: boolean
  /** per-agent 覆盖单次 waitIdle；缺字段用全局；0 fallback 全局。 */
  agent_wait_timeout_ms?: number
  sessions: Record<string, SessionSlot>
}

/** 内存中的完整配置（由多个 JSON 合成）。 */
export interface AgentBotFileConfig {
  skill_roots: string[]
  skill_groups: Record<string, SkillGroupConfig>
  prompts: Record<string, PromptConfig>
  agents: AgentConfig[]
  skill_apply: SkillApplyConfig
  agent_wait_timeout_ms: number
  expert_liveness_max_renew: number
  task_round_timeout_ms: number
  /** 专家清单来源：true=中枢全集（路线 b）；false=群快照（Provider listGroupAgents）。 */
  use_hub_experts: boolean
}

/** 扫描产物 skills-map.json；不进 config.json。 */
export interface SkillsMapFile {
  roots: string[]
  scanned_at: number
  skills: SkillsMapEntry[]
}

/** skills-map 里一条技能。 */
export interface SkillsMapEntry {
  id: string
  name: string
  path: string
  description: string
}

let cache: AgentBotFileConfig | null = null
let cacheDir: string | null = null
let watcher: FSWatcher | null = null
let watcherStart = 0

/** 配置目录：显式 env → 缺省 ~/.dsh/storages/agentbot。 */
export function configDirPath(): string {
  const fromEnv = process.env.AGENT_BOT_CONFIG_DIR
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return STORAGE_ROOT
}

/** config.json 绝对路径。 */
export function configFilePath(): string {
  return join(configDirPath(), 'config.json')
}

/** skill-groups.json 绝对路径。 */
export function skillGroupsFilePath(): string {
  return join(configDirPath(), 'skill-groups.json')
}

/** prompts.json 绝对路径。 */
export function promptsFilePath(): string {
  return join(configDirPath(), 'prompts.json')
}

/** agents.json 绝对路径。 */
export function agentsFilePath(): string {
  return join(configDirPath(), 'agents.json')
}

/** skills-map.json 绝对路径（与 config.json 同目录）。 */
export function skillsMapFilePath(): string {
  return join(configDirPath(), 'skills-map.json')
}

/** 任务看板根目录：jobs/{todo|running|done}/task_{id}.md（见 docs/specs/12）。 */
export function jobsRootPath(): string {
  return join(configDirPath(), 'jobs')
}

function defaultConfig(): AgentBotFileConfig {
  return {
    skill_roots: [],
    skill_groups: {},
    prompts: {},
    agents: [],
    skill_apply: defaultSkillApply(),
    agent_wait_timeout_ms: DEFAULT_AGENT_WAIT_TIMEOUT_MS,
    expert_liveness_max_renew: DEFAULT_EXPERT_LIVENESS_MAX_RENEW,
    task_round_timeout_ms: DEFAULT_TASK_ROUND_TIMEOUT_MS,
    use_hub_experts: DEFAULT_USE_HUB_EXPERTS,
  }
}

function defaultSkillsMap(): SkillsMapFile {
  return { roots: [], scanned_at: 0, skills: [] }
}

/** 测试用：清掉内存缓存，使下次 load 重新读盘 / 换目录。 */
export function resetConfigCache(): void {
  cache = null
  cacheDir = null
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`loadConfig: 解析失败 ${path}: ${(err as Error).message}`)
  }
}

function writeJsonFile(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8')
}

function asObject(raw: unknown, path: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`loadConfig: ${path} 须为对象`)
  }
  return raw as Record<string, unknown>
}

/** 读取配置；文件不存在则返回默认值（不落盘）。分文件优先，否则回退旧 config.json 嵌套字段。 */
export function loadConfig(): AgentBotFileConfig {
  const dir = configDirPath()
  if (cache !== null && cacheDir === dir) return cache
  const corePath = configFilePath()
  const groupsPath = skillGroupsFilePath()
  const promptsPath = promptsFilePath()
  const agentsPath = agentsFilePath()
  const hasAny =
    existsSync(corePath) || existsSync(groupsPath) || existsSync(promptsPath) || existsSync(agentsPath)
  if (!hasAny) {
    cache = defaultConfig()
    cacheDir = dir
    return cache
  }
  const core = existsSync(corePath) ? asObject(readJsonFile(corePath), corePath) : {}
  cache = normalize({
    skill_roots: core.skill_roots,
    skill_apply: core.skill_apply,
    agent_wait_timeout_ms: core.agent_wait_timeout_ms,
    expert_liveness_max_renew: core.expert_liveness_max_renew,
    task_round_timeout_ms: core.task_round_timeout_ms,
    use_hub_experts: core.use_hub_experts,
    skill_groups: existsSync(groupsPath) ? readJsonFile(groupsPath) : core.skill_groups,
    prompts: existsSync(promptsPath) ? readJsonFile(promptsPath) : core.prompts,
    agents: existsSync(agentsPath) ? readJsonFile(agentsPath) : core.agents,
  })
  cacheDir = dir
  return cache
}

/** 保存配置并更新缓存。config.json 只写核心字段；分组 / prompts / agents 各写独立文件。 */
export function saveConfig(data: AgentBotFileConfig): void {
  const dir = configDirPath()
  const normalized = normalize(data)
  mkdirSync(dir, { recursive: true })
  writeJsonFile(configFilePath(), {
    skill_roots: normalized.skill_roots,
    skill_apply: normalized.skill_apply,
    agent_wait_timeout_ms: normalized.agent_wait_timeout_ms,
    expert_liveness_max_renew: normalized.expert_liveness_max_renew,
    task_round_timeout_ms: normalized.task_round_timeout_ms,
    use_hub_experts: normalized.use_hub_experts,
  })
  writeJsonFile(skillGroupsFilePath(), normalized.skill_groups)
  writeJsonFile(promptsFilePath(), normalized.prompts)
  writeJsonFile(agentsFilePath(), normalized.agents)
  cache = normalized
  cacheDir = dir
}

/** 读取扫描产物；缺文件给空 map，不落盘。 */
export function loadSkillsMap(): SkillsMapFile {
  const path = skillsMapFilePath()
  if (!existsSync(path)) return defaultSkillsMap()
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`loadSkillsMap: 解析失败 ${path}: ${(err as Error).message}`)
  }
  return normalizeSkillsMap(parsed)
}

/** 覆盖写入 skills-map.json（扫描产物，不进 config.json）。 */
export function saveSkillsMap(data: SkillsMapFile): void {
  const dir = configDirPath()
  mkdirSync(dir, { recursive: true })
  writeFileSync(skillsMapFilePath(), JSON.stringify(normalizeSkillsMap(data), null, 2), 'utf8')
}

/**
 * 解析 agent 等待超时（毫秒）。
 * 接受有限正整数或整数字符串；范围 1000–1800000。非法返回 null。
 */
export function parseAgentWaitTimeoutMs(raw: unknown): number | null {
  let n: number
  if (typeof raw === 'number') n = raw
  else if (typeof raw === 'string' && raw.trim() !== '') n = Number(raw.trim())
  else return null
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null
  if (n < MIN_AGENT_WAIT_TIMEOUT_MS || n > MAX_AGENT_WAIT_TIMEOUT_MS) return null
  return n
}

/** 把路径里开头的 `~` 展开为 home；非 ~ 开头原样返回。 */
export function expandHomePath(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

/** 合法并发保留；缺字段或非法回退串行。 */
export function parseConcurrency(raw: unknown): Concurrency {
  if (raw === 'concurrent') return 'concurrent'
  return DEFAULT_CONCURRENCY
}

/**
 * agent 级 waitIdle 覆盖：接受有限正整数或整数字符串；`0` 表示 fallback 全局。
 * 缺字段 / 非法返回 undefined（用全局）。
 */
export function parseAgentWaitTimeoutOverride(raw: unknown): number | undefined {
  let n: number
  if (typeof raw === 'number') n = raw
  else if (typeof raw === 'string' && raw.trim() !== '') n = Number(raw.trim())
  else return undefined
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined
  if (n === 0) return 0
  if (n < MIN_AGENT_WAIT_TIMEOUT_MS || n > MAX_AGENT_WAIT_TIMEOUT_MS) return undefined
  return n
}

/** 活性探针续期上限：整数 ≥ 1；非法回退默认。 */
export function parseExpertLivenessMaxRenew(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1) {
    return DEFAULT_EXPERT_LIVENESS_MAX_RENEW
  }
  return raw
}

/** 任务墙钟：正整数毫秒（禁止 0 表示永不超时）；非法回退默认。 */
export function parseTaskRoundTimeoutMs(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
    return DEFAULT_TASK_ROUND_TIMEOUT_MS
  }
  return raw
}

/** 专家清单来源：布尔；缺省/非法回退 true（中枢全集）。 */
export function parseUseHubExperts(raw: unknown): boolean {
  if (typeof raw !== 'boolean') return DEFAULT_USE_HUB_EXPERTS
  return raw
}

/** 将运行时结构规范化到 AgentBotFileConfig（补默认值、忽略无关字段）。 */
export function normalize(raw: unknown): AgentBotFileConfig {
  const d = defaultConfig()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return d
  const o = raw as Record<string, unknown>
  return {
    skill_roots: stringArray(o.skill_roots),
    skill_groups: normalizeSkillGroups(o.skill_groups),
    prompts: normalizePrompts(o.prompts),
    agents: normalizeAgents(o.agents),
    skill_apply: normalizeSkillApply(o.skill_apply),
    agent_wait_timeout_ms: parseAgentWaitTimeoutMs(o.agent_wait_timeout_ms) ?? d.agent_wait_timeout_ms,
    expert_liveness_max_renew: parseExpertLivenessMaxRenew(o.expert_liveness_max_renew),
    task_round_timeout_ms: parseTaskRoundTimeoutMs(o.task_round_timeout_ms),
    use_hub_experts: parseUseHubExperts(o.use_hub_experts),
  }
}

function normalizeSkillGroups(raw: unknown): Record<string, SkillGroupConfig> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, SkillGroupConfig> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const o = value as Record<string, unknown>
    const id = typeof o.id === 'string' && o.id !== '' ? o.id : key
    if (id === '') continue
    out[id] = {
      id,
      name: typeof o.name === 'string' ? o.name : id,
      skill_ids: stringArray(o.skill_ids),
    }
  }
  return out
}

function normalizePrompts(raw: unknown): Record<string, PromptConfig> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, PromptConfig> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === '') continue
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const o = value as Record<string, unknown>
    out[key] = {
      system_prompt: typeof o.system_prompt === 'string' ? o.system_prompt : '',
      tools: stringArray(o.tools),
    }
  }
  return out
}

function normalizeAgents(raw: unknown): AgentConfig[] {
  if (!Array.isArray(raw)) return []
  const out: AgentConfig[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const o = item as Record<string, unknown>
    const id = typeof o.id === 'string' ? o.id : ''
    if (id === '') continue
    out.push({
      id,
      name: typeof o.name === 'string' ? o.name : '',
      slug: typeof o.slug === 'string' && o.slug !== '' ? o.slug : undefined,
      description: typeof o.description === 'string' ? o.description : '',
      workspace: typeof o.workspace === 'string' ? o.workspace : '',
      prompt: typeof o.prompt === 'string' ? o.prompt : '',
      prompt_placement: parsePromptPlacement(o.prompt_placement),
      skill_groups: stringArray(o.skill_groups),
      prompt_append_skills: o.prompt_append_skills === false ? false : true,
      reuse_session: o.reuse_session === false ? false : true,
      session_by_sender: o.session_by_sender === true,
      permission_mode: parsePermissionMode(o.permission_mode),
      session_timeout_minutes: parseSessionTimeoutMinutes(o.session_timeout_minutes),
      concurrency: parseConcurrency(o.concurrency),
      needs_target_workspace: o.needs_target_workspace === true,
      agent_wait_timeout_ms: parseAgentWaitTimeoutOverride(o.agent_wait_timeout_ms),
      sessions: normalizeSessions(o.sessions),
    })
  }
  return out
}

/** 合法权限保留；缺字段或非法回退完全访问。 */
export function parsePermissionMode(raw: unknown): PermissionMode {
  if (raw === 'danger-full-access' || raw === 'workspace-write' || raw === 'read-only') return raw
  return DEFAULT_PERMISSION_MODE
}

/** 合法注入位置保留；缺字段或非法回退系统提示词。 */
export function parsePromptPlacement(raw: unknown): PromptPlacement {
  if (raw === 'system' || raw === 'user') return raw
  return DEFAULT_PROMPT_PLACEMENT
}

function parseSessionTimeoutMinutes(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0) {
    return DEFAULT_SESSION_TIMEOUT_MINUTES
  }
  return raw
}

function normalizeSessions(raw: unknown): Record<string, SessionSlot> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, SessionSlot> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === '') continue
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const o = value as Record<string, unknown>
    const sessionId = typeof o.sessionId === 'string' ? o.sessionId : ''
    const lastAskAt = typeof o.lastAskAt === 'number' && Number.isFinite(o.lastAskAt) ? o.lastAskAt : 0
    if (sessionId === '') continue
    const slot: SessionSlot = { sessionId, lastAskAt }
    if (typeof o.promptFingerprint === 'string') slot.promptFingerprint = o.promptFingerprint
    out[key] = slot
  }
  return out
}

/** 深拷贝落点表。 */
export function copySkillApply(raw: SkillApplyConfig): SkillApplyConfig {
  const out: SkillApplyConfig = {}
  for (const [tool, slots] of Object.entries(raw)) {
    out[tool] = { ...slots }
  }
  return out
}

/** 内置缺省落点的拷贝。 */
export function defaultSkillApply(): SkillApplyConfig {
  return copySkillApply(DEFAULT_SKILL_APPLY)
}

/**
 * 规范化 skill_apply。缺字段 / 非法用内置缺省。
 * 显式 `{}` 表示无落点；工具值为 `{}` 表示该工具无槽。空路径丢掉。
 */
export function normalizeSkillApply(raw: unknown): SkillApplyConfig {
  if (raw === undefined) return defaultSkillApply()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return defaultSkillApply()
  const out: SkillApplyConfig = {}
  for (const [toolRaw, slotsRaw] of Object.entries(raw as Record<string, unknown>)) {
    const tool = toolRaw.trim()
    if (tool === '') continue
    if (typeof slotsRaw !== 'object' || slotsRaw === null || Array.isArray(slotsRaw)) continue
    const slots: SkillApplySlots = {}
    for (const [slotRaw, pathRaw] of Object.entries(slotsRaw as Record<string, unknown>)) {
      const slot = slotRaw.trim()
      if (slot === '') continue
      if (typeof pathRaw !== 'string') continue
      const path = pathRaw.trim()
      if (path === '') continue
      slots[slot] = path
    }
    out[tool] = slots
  }
  return out
}

function stringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item === 'string' && item !== '') out.push(item)
  }
  return out
}

function normalizeSkillsMap(raw: unknown): SkillsMapFile {
  const d = defaultSkillsMap()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return d
  const o = raw as Record<string, unknown>
  const skillsRaw = Array.isArray(o.skills) ? o.skills : []
  const skills: SkillsMapEntry[] = []
  for (const item of skillsRaw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const s = item as Record<string, unknown>
    const id = typeof s.id === 'string' ? s.id : ''
    const path = typeof s.path === 'string' ? s.path : ''
    if (id === '' || path === '') continue
    skills.push({
      id,
      name: typeof s.name === 'string' && s.name !== '' ? s.name : id,
      path,
      description: typeof s.description === 'string' ? s.description : '',
    })
  }
  return {
    roots: stringArray(o.roots),
    scanned_at: typeof o.scanned_at === 'number' && Number.isFinite(o.scanned_at) ? o.scanned_at : d.scanned_at,
    skills,
  }
}

/** 启动对配置文件的监听，文件变化时刷新缓存。返回取消函数。 */
export function watchConfig(onChange: () => void): () => void {
  if (watcher !== null) return () => undefined
  const dir = configDirPath()
  mkdirSync(dir, { recursive: true })
  watcherStart = Date.now()
  watcher = watch(dir, { persistent: false }, () => {
    if (Date.now() - watcherStart < 200) return
    cache = null
    cacheDir = null
    loadConfig()
    onChange()
  })
  return () => {
    watcher?.close()
    watcher = null
  }
}
