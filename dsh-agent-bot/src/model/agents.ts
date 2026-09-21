/**
 * Agents CRUD（Model）。
 * 保存组列表本身不打软链；软链只走 applySkillGroups（E4）。
 * 开关字段直绑、不取反。sessions 由 ask 收口 touchSession 维护，本模块不手填。
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  expandHomePath,
  loadConfig,
  loadSkillsMap,
  parseConcurrency,
  parseAgentWaitTimeoutOverride,
  parsePermissionMode,
  saveConfig,
  parsePromptPlacement,
  type AgentBotFileConfig,
  type AgentConfig,
  type Concurrency,
  type PermissionMode,
  type PromptPlacement,
  type SkillApplyConfig,
} from './config.js'

/** 工具目录里记录本插件建过的软链名，apply 时只删这些。 */
const MANAGED_LINKS_FILE = '.agent-bot-managed.json'

/** 保存 agent 时剔除的未知 skill 组 id，供 UI 提示。 */
export interface SaveAgentResult {
  agent: AgentConfig
  droppedSkillGroupIds: string[]
}

/** 配置站写入的 agent 字段（不含 sessions）。id 空串 = 创建。 */
export interface AgentWrite {
  id: string
  name: string
  /** 英文命令别名：非空须匹配 ^[a-z][a-z0-9_-]*$，且全局唯一。 */
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
  concurrency: Concurrency
  needs_target_workspace: boolean
  agent_wait_timeout_ms?: number
}

/** 当前 agents 拷贝。 */
export function listAgents(): AgentConfig[] {
  return loadConfig().agents.map(copyAgent)
}

/** 按 id 取一条；没有则 undefined。 */
export function getAgent(id: string): AgentConfig | undefined {
  const found = loadConfig().agents.find((a) => a.id === id)
  if (found === undefined) return undefined
  return copyAgent(found)
}

/** 创建：生成 id，之后不可改。 */
export function createAgent(input: Omit<AgentWrite, 'id'>): SaveAgentResult {
  return saveAgent({ ...input, id: '' })
}

/**
 * 保存：id 空则创建；已有 id 不可改。
 * workspace 必填、可 mkdir、不得与其它 agent 撞库。
 * 未知 skill_groups 剔除并提示。不自动软链。
 */
export function saveAgent(input: AgentWrite): SaveAgentResult {
  const cfg = loadConfig()
  const name = input.name.trim()
  if (name === '') throw new Error('agent-bot: agent 名称必填')
  const prompt = input.prompt.trim()
  if (prompt !== '' && cfg.prompts[prompt] === undefined) {
    throw new Error(`agent-bot: 未知 prompt 预设 ${prompt}`)
  }
  const timeout = input.session_timeout_minutes
  if (!Number.isInteger(timeout) || timeout < 0) {
    throw new Error('agent-bot: session_timeout_minutes 须为 ≥ 0 的整数')
  }
  const workspace = resolveWorkspacePath(input.workspace)
  const creating = input.id.trim() === ''
  const id = creating ? randomUUID() : input.id.trim()
  if (!creating && cfg.agents.every((a) => a.id !== id)) {
    throw new Error(`agent-bot: 未知 agent ${id}`)
  }
  assertWorkspaceUnique(cfg.agents, workspace, id)

  // slug：可选，非空须匹配命令名正则 ^[a-z][a-z0-9_-]*$ 且全局唯一。
  const SLUG_RE = /^[a-z][a-z0-9_-]*$/
  const slug = typeof input.slug === 'string' ? input.slug.trim() : ''
  if (slug !== '' && !SLUG_RE.test(slug)) {
    throw new Error(`agent-bot: slug 须匹配 ${SLUG_RE.source}（小写字母/数字/_/-，首字符须字母）`)
  }
  if (slug !== '') {
    const clash = cfg.agents.find((a) => a.id !== id && a.slug === slug)
    if (clash !== undefined) throw new Error(`agent-bot: slug "${slug}" 与 agent「${clash.name}」冲突`)
  }

  const knownGroups = new Set(Object.keys(cfg.skill_groups))
  const droppedSkillGroupIds: string[] = []
  const skill_groups = uniqueStrings(input.skill_groups, knownGroups, droppedSkillGroupIds)

  try {
    mkdirSync(workspace, { recursive: true })
  } catch (err) {
    throw new Error(`agent-bot: 无法创建 workspace ${workspace}: ${(err as Error).message}`)
  }

  const existing = cfg.agents.find((a) => a.id === id)
  const agent: AgentConfig = {
    id,
    name,
    slug: slug !== '' ? slug : undefined,
    description: typeof input.description === 'string' ? input.description : '',
    workspace,
    prompt,
    prompt_placement: parsePromptPlacement(input.prompt_placement),
    skill_groups,
    prompt_append_skills: input.prompt_append_skills === false ? false : true,
    reuse_session: input.reuse_session === false ? false : true,
    session_by_sender: input.session_by_sender === true,
    permission_mode: parsePermissionMode(input.permission_mode),
    session_timeout_minutes: timeout,
    concurrency: parseConcurrency(input.concurrency),
    needs_target_workspace: input.needs_target_workspace === true,
    agent_wait_timeout_ms: parseAgentWaitTimeoutOverride(input.agent_wait_timeout_ms),
    sessions: existing === undefined ? {} : { ...existing.sessions },
  }
  const agents = creating
    ? [...cfg.agents.map(copyAgent), agent]
    : cfg.agents.map((a) => (a.id === id ? agent : copyAgent(a)))
  persistAgents(cfg, agents)
  return { agent: copyAgent(agent), droppedSkillGroupIds }
}

/** 删 agent：sessions map 随走。不 dispose live handle（unload 时由运行时做）。 */
export function deleteAgent(id: string): void {
  if (id.trim() === '') throw new Error('agent-bot: agent id 不可为空')
  const cfg = loadConfig()
  if (cfg.agents.every((a) => a.id !== id)) throw new Error(`agent-bot: 未知 agent ${id}`)
  persistAgents(
    cfg,
    cfg.agents.filter((a) => a.id !== id).map(copyAgent),
  )
}

/** 清除该会话槽；下次 ask 视为无记录。不手填 key。 */
export function clearSession(agentId: string, sessionKey: string): void {
  if (agentId.trim() === '') throw new Error('agent-bot: agent id 不可为空')
  if (sessionKey.trim() === '') throw new Error('agent-bot: sessionKey 不可为空')
  const cfg = loadConfig()
  const agent = cfg.agents.find((a) => a.id === agentId)
  if (agent === undefined) throw new Error(`agent-bot: 未知 agent ${agentId}`)
  if (agent.sessions[sessionKey] === undefined) {
    throw new Error(`agent-bot: agent ${agentId} 没有会话槽 ${sessionKey}`)
  }
  const next = copyAgent(agent)
  const sessions: AgentConfig['sessions'] = {}
  for (const [k, v] of Object.entries(next.sessions)) {
    if (k !== sessionKey) sessions[k] = v
  }
  next.sessions = sessions
  persistAgents(
    cfg,
    cfg.agents.map((a) => (a.id === agentId ? next : copyAgent(a))),
  )
}

/**
 * 本轮收口写槽：覆盖 sessions[sessionKey] = { sessionId, lastAskAt, promptFingerprint } 并落盘。
 * reuse_session=false 也覆盖该 key，下次 ask 读到的是这一轮。
 */
export function touchSession(
  agentId: string,
  sessionKey: string,
  sessionId: string,
  nowMs: number,
  promptFingerprint: string,
): void {
  if (agentId.trim() === '') throw new Error('agent-bot: agent id 不可为空')
  if (sessionKey.trim() === '') throw new Error('agent-bot: sessionKey 不可为空')
  if (sessionId.trim() === '') throw new Error('agent-bot: sessionId 不可为空')
  if (!Number.isFinite(nowMs) || nowMs <= 0) throw new Error('agent-bot: lastAskAt 须为正的有限毫秒')
  const cfg = loadConfig()
  const agent = cfg.agents.find((a) => a.id === agentId)
  if (agent === undefined) throw new Error(`agent-bot: 未知 agent ${agentId}`)
  const next = copyAgent(agent)
  next.sessions = { ...next.sessions, [sessionKey]: { sessionId, lastAskAt: nowMs, promptFingerprint } }
  persistAgents(
    cfg,
    cfg.agents.map((a) => (a.id === agentId ? next : copyAgent(a))),
  )
}

/** 展开模板：`{workspace}` 与 `~` / `~/`。home 显式传入，测试不写真实家目录。 */
export function resolveApplyTemplate(template: string, workspace: string, home: string): string {
  const trimmed = template.trim()
  if (trimmed === '') throw new Error('agent-bot: 落点路径不可为空')
  const withWs = trimmed.split('{workspace}').join(workspace)
  const homeRoot = resolve(home.trim() === '' ? expandHomePath('~') : home.trim())
  if (withWs === '~') return homeRoot
  if (withWs.startsWith('~/')) return join(homeRoot, withWs.slice(2))
  return resolve(withWs)
}

/** 读顶层 skill_apply[tool][slot]，用当前 agent workspace 解析成绝对目录。 */
export function resolveSkillApplyDir(
  apply: SkillApplyConfig,
  workspace: string,
  tool: string,
  slot: string,
  home: string,
): string {
  const slots = apply[tool]
  if (slots === undefined) throw new Error(`agent-bot: 未知工具 ${tool}`)
  const template = slots[slot]
  if (template === undefined) throw new Error(`agent-bot: 工具 ${tool} 没有槽 ${slot}`)
  return resolveApplyTemplate(template, workspace, home)
}

/**
 * 把 groupIds 里各组的 skill 软链到顶层 skill_apply[tool][slot]，并写回 agent.skill_groups。
 * slot 不得为 global（应用全局走 applyGlobalSkillGroups）。
 * 只删该目录里本插件建的旧软链；不动其它落点。symlink 失败显式抛错。
 */
export function applySkillGroups(agentId: string, tool: string, slot: string, groupIds: string[]): void {
  applySkillGroupsAt(agentId, tool, slot, groupIds, homedir())
}

/** 与 applySkillGroups 相同，家目录显式传入（测试用临时目录，避免写真实 ~）。 */
export function applySkillGroupsAt(
  agentId: string,
  tool: string,
  slot: string,
  groupIds: string[],
  home: string,
): void {
  if (agentId.trim() === '') throw new Error('agent-bot: agent id 不可为空')
  if (slot.trim() === 'global') throw new Error('agent-bot: global 槽请在 skills组页应用全局')
  if (groupIds.length === 0) throw new Error('agent-bot: 请先选择技能组')
  const cfg = loadConfig()
  const agent = cfg.agents.find((a) => a.id === agentId)
  if (agent === undefined) throw new Error(`agent-bot: 未知 agent ${agentId}`)
  const dropped: string[] = []
  const skill_groups = uniqueStrings(groupIds, new Set(Object.keys(cfg.skill_groups)), dropped)
  if (skill_groups.length === 0) throw new Error('agent-bot: 请先选择技能组')
  const destDir = resolveSkillApplyDir(cfg.skill_apply, agent.workspace, tool, slot, home)
  writeSkillLinks(destDir, resolveWantedLinks(cfg, skill_groups))
  persistAgents(
    cfg,
    cfg.agents.map((a) => (a.id === agentId ? { ...copyAgent(a), skill_groups } : copyAgent(a))),
  )
}

/**
 * 把选中的技能组软链到 skill_apply[tool].global（本机 agent-ide 全局目录）。
 * slot 必须是 global；模板不得含 {workspace}。
 */
export function applyGlobalSkillGroups(tool: string, slot: string, groupIds: string[]): void {
  applyGlobalSkillGroupsAt(tool, slot, groupIds, homedir())
}

/** 与 applyGlobalSkillGroups 相同，家目录显式传入。 */
export function applyGlobalSkillGroupsAt(tool: string, slot: string, groupIds: string[], home: string): void {
  if (slot.trim() !== 'global') throw new Error('agent-bot: 应用全局落点必须是 global 槽')
  if (groupIds.length === 0) throw new Error('agent-bot: 请先选择技能组')
  const cfg = loadConfig()
  const slots = cfg.skill_apply[tool]
  if (slots === undefined) throw new Error(`agent-bot: 未知工具 ${tool}`)
  const template = slots.global
  if (template === undefined) throw new Error(`agent-bot: 工具 ${tool} 没有槽 global`)
  if (template.includes('{workspace}')) {
    throw new Error(`agent-bot: global 路径不得含 {workspace}: ${template}`)
  }
  const destDir = resolveApplyTemplate(template, '', home)
  writeSkillLinks(destDir, resolveWantedLinks(cfg, groupIds))
}

function writeSkillLinks(destDir: string, wanted: Array<{ name: string; target: string }>): void {
  try {
    mkdirSync(destDir, { recursive: true })
  } catch (err) {
    throw new Error(`agent-bot: 无法创建工具目录 ${destDir}: ${(err as Error).message}`)
  }
  removeManagedLinks(destDir)
  const created: string[] = []
  for (const link of wanted) {
    const dest = join(destDir, link.name)
    if (existsSync(dest)) {
      throw new Error(`agent-bot: 工具目录已有非托管路径，拒绝覆盖: ${dest}`)
    }
    try {
      symlinkSync(link.target, dest, 'dir')
    } catch (err) {
      throw new Error(`agent-bot: 创建软链失败 ${dest} → ${link.target}: ${(err as Error).message}`)
    }
    created.push(link.name)
  }
  writeManagedLinks(destDir, created)
}

/** 嵌套 skill id 展成工具目录单层名：用 posix 末段（`hub/union-xxx` → `union-xxx`）。 */
export function flattenSkillLinkName(skillId: string): string {
  const id = skillId.trim()
  if (id === '' || id === '.') throw new Error(`agent-bot: 无法为 skill id "${skillId}" 生成软链名`)
  const parts = id.split('/').filter((p) => p !== '')
  const tail = parts[parts.length - 1]
  if (tail === undefined || tail === '.' || tail === '..') {
    throw new Error(`agent-bot: 无法为 skill id "${skillId}" 生成软链名`)
  }
  return tail
}

/** 展开 ~ 并 resolve 成绝对路径。空则抛错。 */
export function resolveWorkspacePath(workspace: string): string {
  const trimmed = workspace.trim()
  if (trimmed === '') throw new Error('agent-bot: workspace 必填')
  return resolve(expandHomePath(trimmed))
}

function assertWorkspaceUnique(agents: AgentConfig[], workspace: string, selfId: string): void {
  for (const other of agents) {
    if (other.id === selfId) continue
    if (resolveWorkspacePath(other.workspace) === workspace) {
      throw new Error(`agent-bot: workspace 已被 agent ${other.id} 占用: ${workspace}`)
    }
  }
}

function uniqueStrings(raw: string[], known: Set<string>, dropped: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (item === '') continue
    if (!known.has(item)) {
      dropped.push(item)
      continue
    }
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

function copyAgent(agent: AgentConfig): AgentConfig {
  return {
    ...agent,
    skill_groups: [...agent.skill_groups],
    sessions: { ...agent.sessions },
  }
}

function persistAgents(cfg: AgentBotFileConfig, agents: AgentConfig[]): void {
  saveConfig({
    skill_roots: cfg.skill_roots,
    skill_groups: cfg.skill_groups,
    prompts: cfg.prompts,
    agents,
    skill_apply: cfg.skill_apply,
    agent_wait_timeout_ms: cfg.agent_wait_timeout_ms,
    expert_liveness_max_renew: cfg.expert_liveness_max_renew,
    task_round_timeout_ms: cfg.task_round_timeout_ms,
  })
}

function resolveWantedLinks(
  cfg: AgentBotFileConfig,
  groupIds: string[],
): Array<{ name: string; target: string }> {
  const map = loadSkillsMap()
  const byId = new Map(map.skills.map((s) => [s.id, s]))
  const wanted: Array<{ name: string; target: string }> = []
  const usedNames = new Set<string>()
  for (const gid of groupIds) {
    const group = cfg.skill_groups[gid]
    if (group === undefined) continue
    for (const skillId of group.skill_ids) {
      const skill = byId.get(skillId)
      if (skill === undefined) {
        throw new Error(`agent-bot: skills-map 缺少 ${skillId}，请先扫描`)
      }
      const name = flattenSkillLinkName(skill.id)
      if (usedNames.has(name)) {
        throw new Error(`agent-bot: 软链名冲突 ${name}（skill id ${skill.id}）`)
      }
      usedNames.add(name)
      wanted.push({ name, target: skill.path })
    }
  }
  return wanted
}

function managedLinksPath(destDir: string): string {
  return join(destDir, MANAGED_LINKS_FILE)
}

function readManagedLinks(destDir: string): string[] {
  const file = managedLinksPath(destDir)
  if (!existsSync(file)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`agent-bot: 解析托管软链清单失败 ${file}: ${(err as Error).message}`)
  }
  if (!Array.isArray(parsed)) throw new Error(`agent-bot: 托管软链清单格式错误: ${file}`)
  const names: string[] = []
  for (const item of parsed) {
    if (typeof item === 'string' && item !== '') names.push(item)
  }
  return names
}

function writeManagedLinks(destDir: string, names: string[]): void {
  writeFileSync(managedLinksPath(destDir), JSON.stringify(names, null, 2), 'utf8')
}

function removeManagedLinks(destDir: string): void {
  for (const name of readManagedLinks(destDir)) {
    const dest = join(destDir, name)
    if (!existsSync(dest) && !isBrokenSymlink(dest)) continue
    let st
    try {
      st = lstatSync(dest)
    } catch (err) {
      throw new Error(`agent-bot: 无法读取 ${dest}: ${(err as Error).message}`)
    }
    if (!st.isSymbolicLink()) {
      throw new Error(`agent-bot: 托管路径已不是软链，拒绝删除: ${dest}`)
    }
    try {
      unlinkSync(dest)
    } catch (err) {
      throw new Error(`agent-bot: 删除软链失败 ${dest}: ${(err as Error).message}`)
    }
  }
}

function isBrokenSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}
