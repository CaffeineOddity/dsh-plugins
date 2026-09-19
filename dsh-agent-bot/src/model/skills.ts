/**
 * Skills 扫描与分组（Model）。
 * 扫描产物写入 skills-map.json；分组在 skill-groups.json。
 * 不改 SKILL.md；扫描时逐根读 `{root}/.agentbot/linkmap.json` 套用分组。
 * 不在本模块打软链。
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  expandHomePath,
  loadConfig,
  loadSkillsMap,
  saveConfig,
  saveSkillsMap,
  type AgentBotFileConfig,
  type SkillGroupConfig,
  type SkillsMapEntry,
  type SkillsMapFile,
} from './config.js'

/** 保存分组时剔除的未知 skill id，供 UI 提示。 */
export interface SaveSkillGroupsResult {
  droppedSkillIds: string[]
}

/** 扫描结果：技能列表 + 本次套用的 linkmap 分组。 */
export interface ScanSkillsResult extends SkillsMapFile {
  groupsApplied: string[]
  droppedSkillIds: string[]
  ambiguousSkillIds: string[]
  groupCount: number
}

/** skill 目录相对所属 root 的 posix id。根目录自身含 SKILL.md 时为 `.`。 */
export function toSkillId(skillRoot: string, absDir: string): string {
  const rel = relative(resolve(skillRoot), resolve(absDir)).split(sep).join('/')
  if (rel === '' || rel === '.') return '.'
  if (rel.startsWith('../')) {
    throw new Error(`agent-bot: 技能目录不在扫描根内: ${absDir}`)
  }
  return rel
}

/** 同一 id 映射到不同 path 则显式报错。 */
export function registerSkillId(ids: Map<string, string>, id: string, path: string): void {
  const prev = ids.get(id)
  if (prev !== undefined && prev !== path) {
    throw new Error(`agent-bot: skill id 冲突 "${id}": ${prev} 与 ${path}`)
  }
  ids.set(id, path)
}

/** 扫描 skill_roots。root 空串扫全部；否则只扫该已配置根并合并进已有 skills-map。 */
export function scanSkills(root: string): ScanSkillsResult {
  const cfg = loadConfig()
  const configured = uniqueSkillRoots(cfg.skill_roots)
  if (configured.length === 0) throw new Error('agent-bot: 未配置扫描目录，无法扫描')
  const trimmed = root.trim()
  if (trimmed === '') {
    const resolvedRoots = uniqueSkillRoots(configured.map((raw) => expandHomePath(raw)))
    return finishScan(scanRoots(resolvedRoots), resolvedRoots, resolvedRoots)
  }
  const target = matchConfiguredRoot(configured, trimmed)
  const scanned = scanRoots([target])
  const prev = loadSkillsMap()
  const ids = new Map<string, string>()
  const merged: SkillsMapEntry[] = []
  for (const skill of prev.skills) {
    if (pathIsUnderRoot(skill.path, target)) continue
    registerSkillId(ids, skill.id, skill.path)
    merged.push(skill)
  }
  for (const skill of scanned) {
    registerSkillId(ids, skill.id, skill.path)
    merged.push(skill)
  }
  const mapRoots = uniqueSkillRoots([...prev.roots.filter((r) => resolve(r) !== target), target])
  return finishScan(merged, mapRoots, [target])
}

function matchConfiguredRoot(configured: string[], raw: string): string {
  const requested = resolve(expandHomePath(raw))
  for (const item of configured) {
    const resolved = resolve(expandHomePath(item))
    if (resolved === requested) return resolved
  }
  throw new Error(`agent-bot: 扫描目录不在 skill_roots 内: ${raw}`)
}

function pathIsUnderRoot(absPath: string, root: string): boolean {
  const path = resolve(absPath)
  if (path === root) return true
  return path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

function scanRoots(roots: string[]): SkillsMapEntry[] {
  const ids = new Map<string, string>()
  const skills: SkillsMapEntry[] = []
  for (const root of roots) {
    validateSkillRoot(root)
    const dirs = collectSkillDirs(root)
    for (const dir of dirs) {
      const id = toSkillId(root, dir)
      registerSkillId(ids, id, dir)
      const md = findSkillMarkdown(dir)
      if (md === null) throw new Error(`agent-bot: 目录缺少 SKILL.md: ${dir}`)
      const parsed = readSkillMeta(md, fallbackName(id, dir))
      skills.push({
        id,
        name: parsed.name,
        path: dir,
        description: parsed.description,
      })
    }
  }
  return skills
}

function finishScan(skills: SkillsMapEntry[], mapRoots: string[], linkRoots: string[]): ScanSkillsResult {
  const sorted = [...skills].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const map: SkillsMapFile = {
    roots: mapRoots,
    scanned_at: Date.now(),
    skills: sorted,
  }
  saveSkillsMap(map)
  const applied = { groupsApplied: [], droppedSkillIds: [], ambiguousSkillIds: [] } as {
    groupsApplied: string[]
    droppedSkillIds: string[]
    ambiguousSkillIds: string[]
  }
  for (const root of linkRoots) {
    const linkResult = applyLinkmapToSkills(root, sorted)
    applied.groupsApplied.push(...linkResult.groupsApplied)
    applied.droppedSkillIds.push(...linkResult.droppedSkillIds)
    applied.ambiguousSkillIds.push(...linkResult.ambiguousSkillIds)
  }
  return {
    ...map,
    groupsApplied: applied.groupsApplied,
    droppedSkillIds: applied.droppedSkillIds,
    ambiguousSkillIds: applied.ambiguousSkillIds,
    groupCount: Object.keys(listSkillGroups()).length,
  }
}

function validateSkillRoot(root: string): void {
  if (!existsSync(root)) throw new Error(`agent-bot: 扫描目录不存在: ${root}`)
  let st
  try {
    st = statSync(root)
  } catch (err) {
    throw new Error(`agent-bot: 无法读取扫描目录 ${root}: ${(err as Error).message}`)
  }
  if (!st.isDirectory()) throw new Error(`agent-bot: 扫描目录不是目录: ${root}`)
}

/** 当前扫描产物。 */
export function listSkills(): SkillsMapEntry[] {
  return loadSkillsMap().skills
}

/** 浏览弹窗一层：当前目录、父目录、子目录（不含隐藏与 node_modules）。 */
export interface DirectoryListResult {
  path: string
  parent: string | null
  home: string
  entries: Array<{ name: string; path: string }>
}

/** 列一层子目录。空 path 从家目录起；须能解析成绝对路径。 */
export function listDirectories(rawPath: string): DirectoryListResult {
  const home = homedir()
  const requested = rawPath.trim() === '' ? home : expandHomePath(rawPath.trim())
  const target = resolve(requested)
  if (!isAbsolute(target)) throw new Error(`agent-bot: 目录须为绝对路径: ${rawPath}`)
  if (!existsSync(target)) throw new Error(`agent-bot: 目录不存在: ${target}`)
  let st
  try {
    st = statSync(target)
  } catch (err) {
    throw new Error(`agent-bot: 无法读取目录 ${target}: ${(err as Error).message}`)
  }
  if (!st.isDirectory()) throw new Error(`agent-bot: 不是目录: ${target}`)
  let dirents
  try {
    dirents = readdirSync(target, { withFileTypes: true })
  } catch (err) {
    throw new Error(`agent-bot: 无法读取目录 ${target}: ${(err as Error).message}`)
  }
  const entries: Array<{ name: string; path: string }> = []
  for (const entry of dirents) {
    if (entry.name === '.' || entry.name === '..') continue
    if (entry.name.startsWith('.')) continue
    if (entry.name === 'node_modules') continue
    const child = join(target, entry.name)
    let childStat
    try {
      childStat = statSync(child)
    } catch {
      continue
    }
    if (childStat.isDirectory()) entries.push({ name: entry.name, path: child })
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const parentDir = dirname(target)
  return {
    path: target,
    parent: parentDir === target ? null : parentDir,
    home,
    entries,
  }
}

/** 保存扫描目录数组：trim、丢掉空项、去重。不自动扫描。 */
export function saveSkillRoots(skillRoots: string[]): void {
  const cfg = loadConfig()
  saveConfig({
    skill_roots: uniqueSkillRoots(skillRoots),
    skill_groups: cfg.skill_groups,
    prompts: cfg.prompts,
    agents: cfg.agents,
    skill_apply: cfg.skill_apply,
    agent_wait_timeout_ms: cfg.agent_wait_timeout_ms,
  })
}

function uniqueSkillRoots(raw: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const trimmed = item.trim()
    if (trimmed === '') continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/** 当前分组（config 拷贝，不暴露缓存引用）。 */
export function listSkillGroups(): Record<string, SkillGroupConfig> {
  return copyGroups(loadConfig().skill_groups)
}

/** 解析 linkmap：组名 → 技能 id 数组。非法结构显式报错。 */
export function parseLinkmap(raw: unknown): Record<string, string[]> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('agent-bot: linkmap 须为对象（组名 → 技能 id 数组）')
  }
  const out: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = key.trim()
    if (id === '') throw new Error('agent-bot: linkmap 组名不可为空')
    if (!Array.isArray(value)) throw new Error(`agent-bot: linkmap 组 ${id} 须为字符串数组`)
    const ids: string[] = []
    for (const item of value) {
      if (typeof item !== 'string' || item.trim() === '') {
        throw new Error(`agent-bot: linkmap 组 ${id} 含非法技能 id`)
      }
      ids.push(item.trim())
    }
    out[id] = ids
  }
  return out
}

/** 读 `{root}/.agentbot/linkmap.json` 覆盖对应组。缺文件不改组；非法 JSON 抛错。 */
function applyLinkmapToSkills(
  root: string,
  skills: SkillsMapEntry[],
): { groupsApplied: string[]; droppedSkillIds: string[]; ambiguousSkillIds: string[] } {
  const file = join(root, '.agentbot', 'linkmap.json')
  if (!existsSync(file)) {
    return { groupsApplied: [], droppedSkillIds: [], ambiguousSkillIds: [] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch (err) {
    throw new Error(`agent-bot: 无法解析 ${file}: ${(err as Error).message}`)
  }
  const linkmap = parseLinkmap(parsed)
  const dropped = new Set<string>()
  const ambiguous = new Set<string>()
  const next = copyGroups(loadConfig().skill_groups)
  const groupsApplied: string[] = []
  for (const [groupId, names] of Object.entries(linkmap)) {
    const skill_ids = resolveLinkmapSkillIds(names, skills, dropped, ambiguous)
    const prev = next[groupId]
    next[groupId] = { id: groupId, name: prev !== undefined ? prev.name : groupId, skill_ids }
    groupsApplied.push(groupId)
  }
  const saved = saveSkillGroups(next)
  for (const id of saved.droppedSkillIds) dropped.add(id)
  return {
    groupsApplied,
    droppedSkillIds: [...dropped],
    ambiguousSkillIds: [...ambiguous],
  }
}

/** 整表保存分组：剔除未知 skill_ids；消失的组从所有 agent 上摘掉。 */
export function saveSkillGroups(groups: Record<string, SkillGroupConfig>): SaveSkillGroupsResult {
  const known = new Set(loadSkillsMap().skills.map((s) => s.id))
  const droppedSet = new Set<string>()
  const normalized: Record<string, SkillGroupConfig> = {}
  for (const group of Object.values(groups)) {
    const cleaned = cleanGroup(group, known, droppedSet)
    normalized[cleaned.id] = cleaned
  }
  assertGroupIdentitiesUnique(Object.values(normalized))
  persistGroups(normalized)
  return { droppedSkillIds: [...droppedSet] }
}

/** 创建组：名称必填，id 由名称 slug；与其它组 id/name 撞则抛错。 */
export function createSkillGroup(name: string, skillIds: string[]): SaveSkillGroupsResult {
  const trimmed = name.trim()
  if (trimmed === '') throw new Error('agent-bot: 技能组名称必填')
  const id = slugGroupId(trimmed)
  const cfg = loadConfig()
  assertNameAvailable(cfg.skill_groups, id, trimmed, '')
  const next = copyGroups(cfg.skill_groups)
  next[id] = { id, name: trimmed, skill_ids: [...skillIds] }
  return saveSkillGroups(next)
}

/** 编辑组：改名、改 skill_ids；id 不可改。 */
export function updateSkillGroup(id: string, name: string, skillIds: string[]): SaveSkillGroupsResult {
  if (id === '') throw new Error('agent-bot: 技能组 id 不可为空')
  const cfg = loadConfig()
  if (cfg.skill_groups[id] === undefined) throw new Error(`agent-bot: 未知技能组 ${id}`)
  const trimmed = name.trim()
  if (trimmed === '') throw new Error('agent-bot: 技能组名称必填')
  assertNameAvailable(cfg.skill_groups, id, trimmed, id)
  const next = copyGroups(cfg.skill_groups)
  next[id] = { id, name: trimmed, skill_ids: [...skillIds] }
  return saveSkillGroups(next)
}

/** 删组：从所有 agents[].skill_groups 去掉该 id，再删组。 */
export function deleteSkillGroup(id: string): void {
  if (id === '') throw new Error('agent-bot: 技能组 id 不可为空')
  const cfg = loadConfig()
  if (cfg.skill_groups[id] === undefined) throw new Error(`agent-bot: 未知技能组 ${id}`)
  const next = copyGroups(cfg.skill_groups)
  delete next[id]
  persistGroups(next)
}

function lastSegment(id: string): string {
  const parts = id.split('/')
  return parts[parts.length - 1] ?? id
}

/** 精确 id，其次末段唯一匹配。 */
function resolveLinkmapSkillIds(
  names: string[],
  skills: SkillsMapEntry[],
  dropped: Set<string>,
  ambiguous: Set<string>,
): string[] {
  const byId = new Map<string, string>()
  const byTail = new Map<string, string[]>()
  for (const s of skills) {
    byId.set(s.id, s.id)
    const tail = lastSegment(s.id)
    const list = byTail.get(tail)
    if (list === undefined) byTail.set(tail, [s.id])
    else list.push(s.id)
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const name of names) {
    const exact = byId.get(name)
    if (exact !== undefined) {
      if (!seen.has(exact)) {
        seen.add(exact)
        out.push(exact)
      }
      continue
    }
    const tails = byTail.get(name)
    if (tails !== undefined && tails.length === 1) {
      const id = tails[0]
      if (!seen.has(id)) {
        seen.add(id)
        out.push(id)
      }
      continue
    }
    if (tails !== undefined && tails.length > 1) {
      ambiguous.add(name)
      continue
    }
    dropped.add(name)
  }
  return out
}

function persistGroups(groups: Record<string, SkillGroupConfig>): void {
  const cfg = loadConfig()
  const keep = new Set(Object.keys(groups))
  const agents = cfg.agents.map((agent) => ({
    ...agent,
    skill_groups: agent.skill_groups.filter((gid) => keep.has(gid)),
    sessions: { ...agent.sessions },
  }))
  const next: AgentBotFileConfig = {
    skill_roots: cfg.skill_roots,
    skill_groups: groups,
    prompts: cfg.prompts,
    agents,
    skill_apply: cfg.skill_apply,
    agent_wait_timeout_ms: cfg.agent_wait_timeout_ms,
  }
  saveConfig(next)
}

function cleanGroup(
  group: SkillGroupConfig,
  known: Set<string>,
  dropped: Set<string>,
): SkillGroupConfig {
  const id = group.id.trim()
  const name = group.name.trim()
  if (id === '') throw new Error('agent-bot: 技能组 id 不可为空')
  if (name === '') throw new Error('agent-bot: 技能组名称必填')
  const skill_ids: string[] = []
  const seen = new Set<string>()
  for (const raw of group.skill_ids) {
    if (raw === '') continue
    if (!known.has(raw)) {
      dropped.add(raw)
      continue
    }
    if (seen.has(raw)) continue
    seen.add(raw)
    skill_ids.push(raw)
  }
  return { id, name, skill_ids }
}

function assertGroupIdentitiesUnique(groups: SkillGroupConfig[]): void {
  const seen = new Map<string, string>()
  for (const g of groups) {
    claimIdentity(seen, g.id, g.id, 'id')
    if (g.name !== g.id) claimIdentity(seen, g.name, g.id, 'name')
  }
}

function claimIdentity(seen: Map<string, string>, key: string, ownerId: string, kind: string): void {
  const prev = seen.get(key)
  if (prev !== undefined && prev !== ownerId) {
    throw new Error(`agent-bot: 技能组 ${kind} "${key}" 与组 ${prev} 冲突`)
  }
  seen.set(key, ownerId)
}

function assertNameAvailable(
  groups: Record<string, SkillGroupConfig>,
  newId: string,
  name: string,
  ignoreId: string,
): void {
  for (const g of Object.values(groups)) {
    if (g.id === ignoreId) continue
    if (g.id === newId || g.id === name || g.name === newId || g.name === name) {
      throw new Error(`agent-bot: 技能组 id/name 与组 ${g.id} 冲突`)
    }
  }
}

function slugGroupId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug === '') throw new Error(`agent-bot: 无法从名称生成技能组 id: ${name}`)
  return slug
}

function copyGroups(groups: Record<string, SkillGroupConfig>): Record<string, SkillGroupConfig> {
  const out: Record<string, SkillGroupConfig> = {}
  for (const [k, v] of Object.entries(groups)) {
    out[k] = { id: v.id, name: v.name, skill_ids: [...v.skill_ids] }
  }
  return out
}

function collectSkillDirs(root: string): string[] {
  const found: string[] = []
  const visited = new Set<string>()
  walk(root, found, visited)
  return found
}

function walk(dir: string, found: string[], visited: Set<string>): void {
  let real: string
  try {
    real = realpathSync(dir)
  } catch (err) {
    throw new Error(`agent-bot: 无法解析技能目录 ${dir}: ${(err as Error).message}`)
  }
  if (visited.has(real)) return
  visited.add(real)

  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    throw new Error(`agent-bot: 无法读取目录 ${dir}: ${(err as Error).message}`)
  }
  if (skillMarkdownFromEntries(entries) !== null) found.push(dir)
  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..') continue
    if (entry.name.startsWith('.')) continue
    if (entry.name === 'node_modules') continue
    const child = join(dir, entry.name)
    let childStat
    try {
      childStat = statSync(child)
    } catch {
      continue
    }
    if (childStat.isDirectory()) walk(child, found, visited)
  }
}

/** 目录内技能说明文件；大小写不敏感，优先精确 `SKILL.md`。 */
function skillMarkdownFromEntries(entries: Array<{ isFile(): boolean; name: string }>): string | null {
  let fallback: string | null = null
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (entry.name.toLowerCase() !== 'skill.md') continue
    if (entry.name === 'SKILL.md') return entry.name
    if (fallback === null) fallback = entry.name
  }
  return fallback
}

function findSkillMarkdown(dir: string): string | null {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    throw new Error(`agent-bot: 无法读取目录 ${dir}: ${(err as Error).message}`)
  }
  const name = skillMarkdownFromEntries(entries)
  if (name === null) return null
  return join(dir, name)
}

function readSkillMeta(file: string, fallbackName: string): { name: string; description: string } {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    throw new Error(`agent-bot: 无法读取 ${file}: ${(err as Error).message}`)
  }
  return parseSkillMarkdown(raw, fallbackName)
}

/** 从 SKILL.md 取展示名与首段摘要；无标题则用目录名。 */
export function parseSkillMarkdown(raw: string, fallbackName: string): { name: string; description: string } {
  let body = raw
  let fmName = ''
  let fmDesc = ''
  if (raw.startsWith('---')) {
    const closer = raw.indexOf('\n---', 3)
    if (closer >= 0) {
      const fm = raw.slice(3, closer)
      body = raw.slice(closer + 4)
      fmName = yamlScalar(fm, 'name')
      fmDesc = yamlScalar(fm, 'description')
    }
  }
  const heading = firstHeading(body)
  const para = firstParagraph(stripHeading(body, heading))
  const name = fmName !== '' ? fmName : heading !== '' ? heading : fallbackName
  const description = fmDesc !== '' ? fmDesc : para
  return { name, description }
}

function yamlScalar(fm: string, key: string): string {
  const re = new RegExp(`^${key}:\\s*(.*)$`, 'm')
  const m = re.exec(fm)
  if (m === null) return ''
  let v = m[1].trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1)
  }
  return v
}

function firstHeading(body: string): string {
  const m = /^#\s+(.+)$/m.exec(body)
  return m === null ? '' : m[1].trim()
}

function stripHeading(body: string, heading: string): string {
  if (heading === '') return body
  return body.replace(/^#\s+.+$/m, '')
}

function firstParagraph(body: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const buf: string[] = []
  for (const line of lines) {
    const t = line.trim()
    if (t === '' || t.startsWith('#')) {
      if (buf.length > 0) break
      continue
    }
    buf.push(t)
  }
  return buf.join(' ')
}

function fallbackName(id: string, dir: string): string {
  if (id === '.' || id === '') return basename(dir)
  const parts = id.split('/')
  return parts[parts.length - 1] ?? basename(dir)
}
