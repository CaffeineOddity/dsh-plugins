/**
 * 任务看板 model（docs/specs/12）。
 * jobs/{todo|running|done}/task_{id}.md 的 frontmatter 读写与目录迁移。
 * frontmatter 是运行时维护的真相；正文只由模型写，运行时不解析正文当状态。
 * 校验输入、失败显式抛错，不伪造成功。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { jobsRootPath, loadConfig } from '../config.js'

/** 任务目录状态。todo=建好未开工；running=至少一路在做；done=已交付收口；cancel=人手工取消。 */
export type TaskStatus = 'todo' | 'running' | 'done' | 'cancel'

export const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'running', 'done', 'cancel']

/** assignee 状态。 */
export type AssigneeStatus = 'running' | 'idle' | 'failed' | 'waiting' | 'need_decision'

/** 任务读写访问。 */
export type Access = 'read' | 'write'

/** 群快照里的一位成员（大脑按 agents.json + skills-map 补齐卡片）。 */
export interface GroupMember {
  agentId: string
  name: string
  description: string
}

/** assignees[] 一条。expertName / dispatchedByName 派发时写入；agent 改名不回填。 */
export interface Assignee {
  expertId: string
  expertName: string
  dispatchedBy: string
  dispatchedByName: string
  sessionId: string
  access: Access
  target?: string
  status: AssigneeStatus
  wake: boolean
  /** 派发时那句指令（write 排队后轮到时要拿它重启；frontmatter 里单行 JSON 存）。 */
  instruction?: string
}

/** 待决问题（抛给人或任务 lead）。 */
export interface PendingHuman {
  questions: string[]
  askedBy: string
  askedAt: number
  /** true=这是给**人**的问卷（要 deliver @sender 并把墙钟顺延）；缺省=只上抛给 taskLead。 */
  toHuman?: boolean
}

/** 一份任务的前台字段（运行时读写）。 */
export interface TaskBoard {
  taskId: string
  taskLead: string
  sender: string
  providerId: string
  sessionParts: Record<string, string>
  originContext: string
  access: Access
  target?: string
  createdAt: number
  deadlineAt: number
  groupSnapshot: GroupMember[]
  assignees: Assignee[]
  pendingHuman?: PendingHuman
  body: string
}

/** 解析结果：字段错误显式抛，不静默吞。 */
function asRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('agent-bot: 任务 frontmatter 须为对象')
  }
  return raw as Record<string, unknown>
}

function reqString(raw: Record<string, unknown>, key: string, where: string): string {
  const v = raw[key]
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`agent-bot: 任务 ${where} 缺 ${key}`)
  }
  return v
}

function reqNumber(raw: Record<string, unknown>, key: string, where: string): number {
  const v = raw[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`agent-bot: 任务 ${where} 缺数字 ${key}`)
  }
  return v
}

function parseGroupSnapshot(raw: unknown, where: string): GroupMember[] {
  if (!Array.isArray(raw)) return []
  const out: GroupMember[] = []
  for (const item of raw) {
    const rec = asRecord(item)
    const agentId = typeof rec.agentId === 'string' ? rec.agentId.trim() : ''
    if (agentId === '') continue
    out.push({ agentId, name: typeof rec.name === 'string' ? rec.name : '', description: typeof rec.description === 'string' ? rec.description : '' })
  }
  return out
}

function parseSessionParts(raw: unknown): Record<string, string> {
  const rec = asRecord(raw)
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === 'string' && v !== '') out[k] = v
  }
  return out
}

function parseAssignee(raw: unknown, where: string): Assignee {
  const rec = asRecord(raw)
  const expertId = typeof rec.expertId === 'string' ? rec.expertId.trim() : ''
  if (expertId === '') throw new Error(`agent-bot: 任务 ${where} 缺 assignee.expertId`)
  const access: Access = rec.access === 'read' ? 'read' : 'write'
  const statusRaw = typeof rec.status === 'string' ? rec.status : 'idle'
  const status: AssigneeStatus = ['running', 'idle', 'failed', 'waiting', 'need_decision'].includes(statusRaw)
    ? (statusRaw as AssigneeStatus)
    : 'idle'
  return {
    expertId,
    expertName: typeof rec.expertName === 'string' ? rec.expertName : '',
    dispatchedBy: typeof rec.dispatchedBy === 'string' ? rec.dispatchedBy : '',
    dispatchedByName: typeof rec.dispatchedByName === 'string' ? rec.dispatchedByName : '',
    sessionId: typeof rec.sessionId === 'string' ? rec.sessionId : '',
    access,
    target: typeof rec.target === 'string' && rec.target !== '' ? rec.target : undefined,
    status,
    wake: rec.wake === true,
    instruction: typeof rec.instruction === 'string' && rec.instruction !== '' ? decodeText(rec.instruction) : undefined,
  }
}

/** 读回 instruction（JSON 编码；解不开就当原文，兼容手写的 md）。 */
function decodeText(raw: string): string {
  try {
    const v = JSON.parse(raw)
    return typeof v === 'string' ? v : raw
  } catch {
    return raw
  }
}

function parseAssignees(raw: unknown, where: string): Assignee[] {
  if (!Array.isArray(raw)) return []
  return raw.map((item) => parseAssignee(item, where))
}

function parsePendingHuman(raw: unknown, where: string): PendingHuman | undefined {
  if (raw === undefined || raw === null) return undefined
  const rec = asRecord(raw)
  const questions = Array.isArray(rec.questions)
    ? rec.questions.filter((q): q is string => typeof q === 'string' && q !== '')
    : []
  const askedAt = typeof rec.askedAt === 'number' ? rec.askedAt : 0
  if (questions.length === 0) return undefined
  return {
    questions,
    askedBy: typeof rec.askedBy === 'string' ? rec.askedBy : '',
    askedAt,
    toHuman: rec.toHuman === true,
  }
}

/** frontmatter 内可见字段的源（含可缺省目标目录）。 */
interface SerializeTask {
  taskId: string
  taskLead: string
  sender: string
  providerId: string
  sessionParts: Record<string, string>
  originContext: string
  access: Access
  target?: string
  createdAt: number
  deadlineAt: number
  groupSnapshot: GroupMember[]
  assignees: Assignee[]
  pendingHuman?: PendingHuman
}

/** 把任务字段序列化成 frontmatter YAML（本插件手写子集；键字母序，注释标记运行时维护）。 */
export function marshalTaskYaml(task: SerializeTask, body: string): string {
  const lines: string[] = ['---']
  lines.push(`taskId: ${task.taskId}`)
  lines.push(`taskLead: ${task.taskLead}`)
  lines.push(`sender: ${yamlScalar(task.sender)}`)
  lines.push(`providerId: ${task.providerId}`)
  lines.push('sessionParts:')
  for (const [k, v] of Object.entries(task.sessionParts)) {
    lines.push(`  ${k}: ${yamlScalar(String(v))}`)
  }
  lines.push(`originContext: ${yamlScalar(task.originContext)}`)
  lines.push(`access: ${task.access}`)
  if (task.target) lines.push(`target: ${yamlScalar(task.target)}`)
  lines.push(`createdAt: ${task.createdAt}`)
  lines.push(`deadlineAt: ${task.deadlineAt}`)
  lines.push('groupSnapshot:')
  for (const m of task.groupSnapshot) {
    lines.push(`  - agentId: ${m.agentId}`)
    lines.push(`    name: ${yamlScalar(m.name)}`)
    if (m.description !== '') lines.push(`    description: ${yamlScalar(m.description)}`)
  }
  lines.push('assignees:')
  for (const a of task.assignees) {
    lines.push(`  - expertId: ${a.expertId}`)
    lines.push(`    expertName: ${yamlScalar(a.expertName)}`)
    lines.push(`    dispatchedBy: ${a.dispatchedBy}`)
    lines.push(`    dispatchedByName: ${yamlScalar(a.dispatchedByName)}`)
    if (a.sessionId !== '') lines.push(`    sessionId: ${a.sessionId}`)
    lines.push(`    access: ${a.access}`)
    if (a.target) lines.push(`    target: ${yamlScalar(a.target)}`)
    lines.push(`    status: ${a.status}`)
    lines.push(`    wake: ${a.wake}`)
    if (a.instruction !== undefined && a.instruction !== '') {
      // 单行存：JSON 把换行转义成 \n，再由 yamlScalar 加引号 → 不会破坏 frontmatter 的行结构
      lines.push(`    instruction: ${yamlScalar(JSON.stringify(a.instruction))}`)
    }
  }
  if (task.pendingHuman) {
    lines.push('pendingHuman:')
    lines.push(`  questions:`)
    for (const q of task.pendingHuman.questions) lines.push(`    - ${yamlScalar(q)}`)
    lines.push(`  askedBy: ${task.pendingHuman.askedBy}`)
    lines.push(`  askedAt: ${task.pendingHuman.askedAt}`)
    if (task.pendingHuman.toHuman === true) lines.push('  toHuman: true')
  }
  lines.push('---')
  lines.push('')
  return lines.join('\n') + body + '\n'
}

/** YAML 单行标量：不裸释放冒号/井号，空则空引号。 */
/**
 * 字符串标量出码。会被 YAML 回读成 number / boolean / null 的（纯数字、true/false/null/~）
 * **必须加引号**，否则往返后变成非字符串——`sender` / `sessionParts` 的值常是纯数字用户 id、
 * 群 id（如 `6031348`），不加引号会被 `parseSessionParts` / `reqString` 丢掉或直接读失败。
 */
function yamlScalar(v: string): string {
  if (v === '') return "''"
  const looksNonString = /^-?\d+(\.\d+)?$/.test(v) || v === 'true' || v === 'false' || v === 'null' || v === '~'
  if (!looksNonString && /^[A-Za-z0-9_./:+=@-]+$/.test(v)) return v
  const escaped = String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")
  return `'${escaped}'`
}

/** 反序列化：frontmatter 缺字段显式抛错。body 取第一个 `---` 之后。 */
export function unmarshalTask(markdown: string): TaskBoard {
  if (typeof markdown !== 'string') throw new Error('agent-bot: 任务文件内容须为字符串')
  const header = markdown.startsWith('---\n') ? markdown.slice(4) : markdown
  const sep = header.indexOf('\n---\n')
  if (sep < 0) throw new Error('agent-bot: 任务文件缺 frontmatter 结束标记')
  const yaml = header.slice(0, sep)
  const body = header.slice(sep + 5).replace(/\s+$/, '')
  const rec = parseYamlBlock(yaml)
  const where = String(rec.taskId ?? '?')
  const sessionParts = parseSessionParts(rec.sessionParts)
  if (Object.keys(sessionParts).length === 0) {
    throw new Error(`agent-bot: 任务 ${where} 缺 sessionParts`)
  }
  const access: Access = rec.access === 'read' ? 'read' : 'write'
  return {
    taskId: reqString(rec, 'taskId', where),
    taskLead: reqString(rec, 'taskLead', where),
    sender: reqString(rec, 'sender', where),
    providerId: reqString(rec, 'providerId', where),
    sessionParts,
    originContext: typeof rec.originContext === 'string' ? rec.originContext : '',
    access,
    target: typeof rec.target === 'string' && rec.target !== '' ? rec.target : undefined,
    createdAt: reqNumber(rec, 'createdAt', where),
    deadlineAt: reqNumber(rec, 'deadlineAt', where),
    groupSnapshot: parseGroupSnapshot(rec.groupSnapshot, where),
    assignees: parseAssignees(rec.assignees, where),
    pendingHuman: parsePendingHuman(rec.pendingHuman, where),
    body,
  }
}

/** 极简 frontmatter YAML 解析（本插件写、本插件读）：支持 map / 双层缩进 / list-of-map。 */
function parseYamlBlock(yaml: string): Record<string, unknown> {
  const lines = yaml.split('\n')
  return parseMapBlock(lines, 0, -1).rec
}

interface YamlLine {
  key: string
  value: string
  hasValue: boolean
}

function splitYamlLine(line: string): YamlLine {
  const trimmed = line.trim()
  const idx = trimmed.indexOf(':')
  if (idx < 0) return { key: '', value: '', hasValue: false }
  const key = trimmed.slice(0, idx).trim()
  const rest = trimmed.slice(idx + 1).trim()
  return { key, value: rest, hasValue: rest !== '' }
}

function parseYamlScalar(raw: string): unknown {
  if (raw === "''" || raw === '""') return ''
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw === 'null' || raw === '~') return null
  if (/^-?\d+$/.test(raw)) return Number(raw)
  if (/^-?\d+\.\d+$/.test(raw)) return Number(raw)
  if (raw.startsWith("'")) {
    const inner = raw.endsWith("'") ? raw.slice(1, -1) : raw.slice(1)
    return inner.replace(/''/g, "'")
  }
  if (raw.startsWith('"')) {
    const inner = raw.endsWith('"') ? raw.slice(1, -1) : raw.slice(1)
    return inner.replace(/\\"/g, '"')
  }
  return raw
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

function isListDash(line: string | undefined): boolean {
  return typeof line === 'string' && line.trimStart().startsWith('- ') && !line.trim().startsWith('#')
}

/** 解析一段 map：parentIndent 之下的行都算本块；返回解析结果与下一个未消费行。 */
function parseMapBlock(
  lines: string[],
  start: number,
  parentIndent: number,
): { rec: Record<string, unknown>; next: number } {
  const rec: Record<string, unknown> = {}
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) {
      i++
      continue
    }
    const indent = indentOf(line)
    if (indent <= parentIndent) break
    if (isListDash(line)) {
      // map 里不该出现列表项，跳过防死循环
      i++
      continue
    }
    const { key, value, hasValue } = splitYamlLine(line)
    if (key === '') {
      i++
      continue
    }
    if (hasValue) {
      rec[key] = parseYamlScalar(value)
      i++
      continue
    }
    // 空值键 → 子块
    if (i + 1 < lines.length && indentOf(lines[i + 1]) > indent) {
      if (isListDash(lines[i + 1])) {
        const res = parseListBlock(lines, i + 1, indent)
        rec[key] = res.list
        i = res.next
        continue
      }
      const res = parseMapBlock(lines, i + 1, indent)
      rec[key] = res.rec
      i = res.next
      continue
    }
    rec[key] = null
    i++
  }
  return { rec, next: i }
}

/** 解析一段 list-of-map / 标量列表：parentIndent 之下、以 `- ` 开头的行；每项的后续深缩进行归到该项。 */
function parseListBlock(
  lines: string[],
  start: number,
  parentIndent: number,
): { list: unknown[]; next: number } {
  const list: unknown[] = []
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i++
      continue
    }
    const indent = indentOf(line)
    if (indent <= parentIndent || !isListDash(line)) break
    const item = line.trimStart().slice(2)
    const col = item.indexOf(':')
    if (col < 0) {
      list.push(parseYamlScalar(item))
      i++
      continue
    }
    const itemKey = item.slice(0, col).trim()
    const itemValue = item.slice(col + 1).trim()
    const rec: Record<string, unknown> = {}
    // 该项自身带值，或仅键名。
    if (itemValue !== '') {
      rec[itemKey] = parseYamlScalar(itemValue)
      i++
    } else {
      rec[itemKey] = null
      i++
    }
    // 后续比 item 更深缩进的行都属于当前该项 → 并入 rec。
    while (i < lines.length) {
      const nxt = lines[i]
      if (nxt.trim() === '') {
        i++
        continue
      }
      const nIndent = indentOf(nxt)
      if (nIndent <= indent) break
      if (isListDash(nxt)) {
        const res = parseListBlock(lines, i, indent)
        if (rec[itemKey] === null) rec[itemKey] = res.list
        i = res.next
        continue
      }
      const sub = parseMapBlock(lines, i, indent)
      Object.assign(rec, sub.rec)
      i = sub.next
    }
    list.push(rec)
  }
  return { list, next: i }
}

/** 任务 id 合法性。 */
export function isTaskId(v: string): boolean {
  return /^task_[A-Za-z0-9_-]+$/.test(v)
}

/**
 * 板可见性：只保留与「我」同一个对话的任务（同 `providerId` + 同 conversationKey）。
 * 判据不含 bot_id / sender —— 同群各台 bot、同群不同人都看**同一块板**（specs/12 §入站怎么绑任务）。
 */
export function filterByConversation<T extends { providerId: string; sessionParts: Record<string, string> }>(
  tasks: readonly T[],
  mine: { providerId: string; key: string },
  keyFor: (providerId: string, parts: Record<string, string>) => string,
): T[] {
  return tasks.filter(
    (t) => t.providerId === mine.providerId && keyFor(t.providerId, t.sessionParts) === mine.key,
  )
}

/** 任务文件绝对路径（派发时告知专家去读；也是运维排查入口）。 */
export function taskFilePath(status: TaskStatus, taskId: string): string {
  return taskFile(status, taskId)
}

function taskFile(status: TaskStatus, taskId: string): string {
  return join(jobsRootPath(), status, `${taskId}.md`)
}

/** 新建任务的入参（sender / providerId / sessionParts / 群快照由入站上下文提供）。 */
export interface CreateTaskInput {
  /** 谁被 @，谁就是这一单的 lead。 */
  taskLead: string
  sender: string
  providerId: string
  sessionParts: Record<string, string>
  originContext: string
  access: Access
  target?: string
  groupSnapshot: GroupMember[]
  /** 任务墙钟毫秒；<=0 用全局 task_round_timeout_ms。 */
  roundTimeoutMs?: number
  /** 正文初值（缺省空）。 */
  body?: string
  nowMs?: number
}

/**
 * 新建一份任务并落 `running/`（specs/12：建好即开工，「todo/」少见）。
 * taskId = `task_<本地时间戳>`；同毫秒冲突时递增毫秒，保证唯一。
 */
export function createTask(input: CreateTaskInput): TaskBoard {
  const now = input.nowMs ?? Date.now()
  const timeout = input.roundTimeoutMs !== undefined && input.roundTimeoutMs > 0
    ? input.roundTimeoutMs
    : loadConfig().task_round_timeout_ms
  ensureJobsDirs()
  const taskId = mintTaskId(now)
  const task: TaskBoard = {
    taskId,
    taskLead: input.taskLead,
    sender: input.sender,
    providerId: input.providerId,
    sessionParts: { ...input.sessionParts },
    originContext: input.originContext,
    access: input.access,
    target: input.target === undefined || input.target === '' ? undefined : input.target,
    createdAt: now,
    deadlineAt: now + timeout,
    groupSnapshot: input.groupSnapshot.map((m) => ({ ...m })),
    assignees: [],
    body: input.body ?? '',
  }
  writeTask('running', task)
  return task
}

/** 生成不撞车的 taskId：`task_<年月日时分秒>_<毫秒>`（只含 [A-Za-z0-9_-]），撞了就往后推毫秒。 */
function mintTaskId(nowMs: number): string {
  const p2 = (n: number) => String(n).padStart(2, '0')
  const p3 = (n: number) => String(n).padStart(3, '0')
  const fmt = (d: Date) =>
    `task_${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}_${p3(d.getMilliseconds())}`
  const d = new Date(nowMs)
  let id = fmt(d)
  while (readTask('running', id) !== undefined || readTask('done', id) !== undefined || readTask('todo', id) !== undefined || readTask('cancel', id) !== undefined) {
    d.setMilliseconds(d.getMilliseconds() + 1)
    id = fmt(d)
  }
  return id
}

function ensureJobsDirs(): void {
  for (const status of TASK_STATUSES) {
    const dir = join(jobsRootPath(), status)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
}

/** 读取某状态的某任务；不存在返回 undefined。读失败显式抛错。 */
export function readTask(status: TaskStatus, taskId: string): TaskBoard | undefined {
  const file = taskFile(status, taskId)
  if (!existsSync(file)) return undefined
  try {
    return unmarshalTask(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`agent-bot: 读取任务 ${status}/${taskId}.md 失败: ${(err as Error).message}`)
  }
}

/** 写某状态某任务；目录不存在先建。写失败显式抛错。 */
export function writeTask(status: TaskStatus, task: TaskBoard): void {
  if (!isTaskId(task.taskId)) throw new Error(`agent-bot: 非法 taskId ${task.taskId}`)
  ensureJobsDirs()
  const content = marshalTaskYaml(task, task.body)
  try {
    writeFileSync(taskFile(status, task.taskId), content, 'utf8')
  } catch (err) {
    throw new Error(`agent-bot: 写任务 ${status}/${task.taskId}.md 失败: ${(err as Error).message}`)
  }
}

/** 迁移任务到新状态（todo→running→done）。失败显式抛错。 */
export function moveTask(from: TaskStatus, to: TaskStatus, taskId: string): TaskBoard {
  const src = taskFile(from, taskId)
  if (!existsSync(src)) throw new Error(`agent-bot: 迁移任务 ${taskId} 源不存在`)
  ensureJobsDirs()
  const dst = taskFile(to, taskId)
  try {
    renameSync(src, dst)
  } catch (err) {
    throw new Error(`agent-bot: 迁移任务 ${taskId} → ${to} 失败: ${(err as Error).message}`)
  }
  return readTask(to, taskId) as TaskBoard
}

/** 列出某状态的全部任务（读失败的那份显式抛）。 */
export function listTasksIn(status: TaskStatus): TaskBoard[] {
  const dir = join(jobsRootPath(), status)
  if (!existsSync(dir)) return []
  const out: TaskBoard[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue
    const taskId = name.slice(0, -3)
    const task = readTask(status, taskId)
    if (task !== undefined) out.push(task)
  }
  return out
}

/** 删除某任务文件（仅测试/清理用）。 */
export function removeTask(status: TaskStatus, taskId: string): void {
  const file = taskFile(status, taskId)
  if (!existsSync(file)) {
    rmSync(file, { force: true })
    return
  }
  rmSync(file)
}

/** 当前状态目录内的任务（供入站扫描 running 摘要）。 */
export function describeTasks(tasks: TaskBoard[]): Record<string, unknown>[] {
  return tasks.map((t) => ({
    taskId: t.taskId,
    taskLead: t.taskLead,
    sender: t.sender,
    originContext: t.originContext,
    access: t.access,
    target: t.target ?? undefined,
    summary: firstBodyLine(t.body),
    assignees: t.assignees.map((a) => ({ expertId: a.expertId, status: a.status, access: a.access, target: a.target ?? undefined })),
    pendingHuman: t.pendingHuman
      ? { questions: t.pendingHuman.questions, askedBy: t.pendingHuman.askedBy, toHuman: t.pendingHuman.toHuman === true }
      : undefined,
    deadlineAt: t.deadlineAt,
  }))
}

function firstBodyLine(body: string): string {
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    return trimmed.slice(0, 200)
  }
  return ''
}