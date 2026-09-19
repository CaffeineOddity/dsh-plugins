/**
 * 配置站 RPC：POST /agent-bot-rpc，信封 { endpoint, payload }。
 * 把 View 意图转成 Model 调用；不操作 DOM、不 readFile 静态页。
 * 不要用 connection.rpc.handle。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  applyGlobalSkillGroups,
  applySkillGroups,
  clearSession,
  deleteAgent,
  listAgents,
  saveAgent,
  type AgentWrite,
} from '../model/agents.js'
import {
  configDirPath,
  copySkillApply,
  loadConfig,
  loadSkillsMap,
  parseAgentWaitTimeoutMs,
  parsePermissionMode,
  parsePromptPlacement,
  saveConfig,
  type PromptConfig,
  type SkillGroupConfig,
} from '../model/config.js'
import { listPrompts, savePrompts, type PromptListItem } from '../model/prompts.js'
import { pickNativeDirectory, runNativeCommand } from '../model/pick-directory.js'
import { listDirectories, listSkillGroups, listSkills, saveSkillGroups, saveSkillRoots, scanSkills } from '../model/skills.js'
import type { AgentOutboundMessage, AgentChannelProviderInfo } from '../types.js'

/** RPC 应答信封。 */
export interface AgentBotRpcResponse {
  ok: boolean
  value?: unknown
  error?: string
}

/** RPC 需要的运行时门面（providers 来自 agentBot 服务）。 */
export interface AgentBotRpcHost {
  listProviders(): AgentChannelProviderInfo[]
  /** 本地对话页 / agent 命令共用：解析 rawInput 调本地 ask，展平 pending。 */
  localAsk(rawInput: string, sessionKey?: string): Promise<{ messages: AgentOutboundMessage[]; error?: string }>
  /** 打开系统选文件夹；未注入则走本机 osascript/zenity。测试注入假实现。 */
  pickDirectory?(): Promise<string | null>
}

const LOG_LIMIT = 200
const bootLog: string[] = []
const askLog: string[] = []
const scanLog: string[] = []

/** 追加配置站日志尾。kind 对应 log 页三栏。 */
export function appendLog(kind: 'boot' | 'ask' | 'scan', line: string): void {
  const bucket = kind === 'boot' ? bootLog : kind === 'ask' ? askLog : scanLog
  bucket.push(line)
  if (bucket.length > LOG_LIMIT) bucket.splice(0, bucket.length - LOG_LIMIT)
}

/** 测试用：清空日志尾。 */
export function resetLogs(): void {
  bootLog.length = 0
  askLog.length = 0
  scanLog.length = 0
}

function logTail(lines: string[]): string {
  return lines.join('\n')
}

function asRecord(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return {}
  return payload as Record<string, unknown>
}

function asString(raw: unknown): string {
  return typeof raw === 'string' ? raw : ''
}

function asBool(raw: unknown, whenMissing: boolean): boolean {
  if (raw === true) return true
  if (raw === false) return false
  return whenMissing
}

function asStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item === 'string') out.push(item)
  }
  return out
}

function statusValue(host: AgentBotRpcHost): Record<string, unknown> {
  return {
    configDir: configDirPath(),
    providers: host.listProviders(),
    bootLogTail: logTail(bootLog),
    askLogTail: logTail(askLog),
    scanLogTail: logTail(scanLog),
  }
}

function listValue(host: AgentBotRpcHost): Record<string, unknown> {
  const cfg = loadConfig()
  const map = loadSkillsMap()
  return {
    skill_roots: cfg.skill_roots,
    skills: listSkills(),
    skill_groups: listSkillGroups(),
    skill_apply: copySkillApply(cfg.skill_apply),
    scanned_at: map.scanned_at,
    status: statusValue(host),
  }
}

function parseGroups(raw: unknown): Record<string, SkillGroupConfig> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('agent-bot: groups 须为对象')
  }
  const out: Record<string, SkillGroupConfig> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`agent-bot: 技能组 ${key} 格式错误`)
    }
    const o = value as Record<string, unknown>
    const id = asString(o.id) !== '' ? asString(o.id) : key
    out[id] = { id, name: asString(o.name), skill_ids: asStringArray(o.skill_ids) }
  }
  return out
}

function parsePrompts(raw: unknown): Record<string, PromptConfig> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('agent-bot: prompts 须为对象')
  }
  const out: Record<string, PromptConfig> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`agent-bot: 预设 ${key} 格式错误`)
    }
    const o = value as Record<string, unknown>
    out[key] = { system_prompt: asString(o.system_prompt), tools: asStringArray(o.tools) }
  }
  return out
}

function parseAgentWrite(payload: Record<string, unknown>): AgentWrite {
  const timeoutRaw = payload.session_timeout_minutes
  let timeout: number
  if (typeof timeoutRaw === 'number') timeout = timeoutRaw
  else if (typeof timeoutRaw === 'string' && timeoutRaw.trim() !== '') timeout = Number(timeoutRaw.trim())
  else timeout = Number.NaN
  return {
    id: asString(payload.id),
    name: asString(payload.name),
    slug: asString(payload.slug),
    description: asString(payload.description),
    workspace: asString(payload.workspace),
    prompt: asString(payload.prompt),
    prompt_placement: parsePromptPlacement(payload.prompt_placement),
    skill_groups: asStringArray(payload.skill_groups),
    prompt_append_skills: asBool(payload.prompt_append_skills, true),
    reuse_session: asBool(payload.reuse_session, true),
    session_by_sender: asBool(payload.session_by_sender, false),
    permission_mode: parsePermissionMode(payload.permission_mode),
    session_timeout_minutes: timeout,
  }
}

/**
 * 处理一个 RPC 端点。抛错转成 { ok:false, error }。
 * 不启 webServer；单测直接调本函数。
 */
export async function handleRpc(
  host: AgentBotRpcHost,
  endpoint: string,
  payload: unknown,
): Promise<AgentBotRpcResponse> {
  try {
    switch (endpoint) {
      case 'list':
        return { ok: true, value: listValue(host) }
      case 'saveSkillRoots': {
        saveSkillRoots(asStringArray(asRecord(payload).skill_roots))
        return { ok: true, value: { skill_roots: loadConfig().skill_roots } }
      }
      case 'listDirectories': {
        return { ok: true, value: listDirectories(asString(asRecord(payload).path)) }
      }
      case 'pickDirectory': {
        const pick = host.pickDirectory
        const path = pick === undefined ? await pickNativeDirectory(runNativeCommand, process.platform) : await pick()
        return { ok: true, value: { path } }
      }
      case 'scanSkills': {
        const map = scanSkills(asString(asRecord(payload).root))
        appendLog('scan', `扫描完成 ${map.skills.length} 个技能、${map.groupCount} 个分组（${map.roots.length} 个目录）`)
        return { ok: true, value: map }
      }
      case 'saveSkillGroups': {
        const result = saveSkillGroups(parseGroups(asRecord(payload).groups))
        return { ok: true, value: result }
      }
      case 'applyGlobalSkillGroups': {
        const p = asRecord(payload)
        applyGlobalSkillGroups(asString(p.tool), asString(p.slot), asStringArray(p.groupIds))
        return { ok: true, value: { applied: true } }
      }
      case 'listPrompts': {
        const items: PromptListItem[] = listPrompts(asString(asRecord(payload).query))
        return { ok: true, value: items }
      }
      case 'savePrompts': {
        savePrompts(parsePrompts(asRecord(payload).prompts))
        return { ok: true, value: { saved: true } }
      }
      case 'listAgents':
        return { ok: true, value: listAgents() }
      case 'ask': {
        // 本地对话页入口：用内置 local provider 调 ask（localAsk 解析 + 展平 pending）。
        const p = asRecord(payload)
        const agentId = asString(p.agentId)
        const context = asString(p.context)
        if (agentId === '') return { ok: false, error: 'bad-request: agentId 必填' }
        if (context === '') return { ok: false, error: 'bad-request: context 必填' }
        const sessionKey = asString(p.sessionKey)
        const r = await host.localAsk(`${agentId} ${context}`, sessionKey !== '' ? sessionKey : 'local')
        if (r.error) { appendLog('ask', `ask ${agentId} 失败: ${r.error}`); return { ok: false, error: r.error } }
        appendLog('ask', `ask ${agentId} -> ${r.messages.length} 条`)
        return { ok: true, value: { messages: r.messages } }
      }
      case 'saveAgent': {
        const result = saveAgent(parseAgentWrite(asRecord(payload)))
        return { ok: true, value: result }
      }
      case 'deleteAgent': {
        deleteAgent(asString(asRecord(payload).id))
        return { ok: true, value: { deleted: true } }
      }
      case 'applySkillGroups': {
        const p = asRecord(payload)
        applySkillGroups(asString(p.id), asString(p.tool), asString(p.slot), asStringArray(p.groupIds))
        return { ok: true, value: { applied: true } }
      }
      case 'clearSession': {
        const p = asRecord(payload)
        clearSession(asString(p.id), asString(p.sessionKey))
        return { ok: true, value: { cleared: true } }
      }
      case 'settings': {
        const cfg = loadConfig()
        return {
          ok: true,
          value: {
            agent_wait_timeout_ms: cfg.agent_wait_timeout_ms,
            configDir: configDirPath(),
            providers: host.listProviders(),
          },
        }
      }
      case 'saveSettings': {
        const ms = parseAgentWaitTimeoutMs(asRecord(payload).agent_wait_timeout_ms)
        if (ms === null) {
          return { ok: false, error: 'bad-request: agent_wait_timeout_ms 须为 1000–1800000 的正整数毫秒' }
        }
        const cfg = loadConfig()
        saveConfig({
          skill_roots: cfg.skill_roots,
          skill_groups: cfg.skill_groups,
          prompts: cfg.prompts,
          agents: cfg.agents,
          skill_apply: cfg.skill_apply,
          agent_wait_timeout_ms: ms,
        })
        return { ok: true, value: { saved: true, agent_wait_timeout_ms: ms } }
      }
      case 'status':
        return { ok: true, value: statusValue(host) }
      default:
        return { ok: false, error: `unknown endpoint: ${endpoint}` }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 1024 * 1024) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', reject)
  })
}

/** 注册 POST /agent-bot-rpc。webServer 不可用时返回 null。 */
export function registerRpcRoute(ctx: Context, host: AgentBotRpcHost): (() => void) | null {
  const web = ctx.webServer
  if (!web || typeof web.register !== 'function') return null
  return web.register({
    kind: 'exact',
    path: '/agent-bot-rpc',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if ((req.method ?? 'GET') !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
        return
      }
      let body: Record<string, unknown> | undefined
      try {
        body = await readJsonBody(req)
      } catch (error) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
        return
      }
      const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : ''
      const result = await handleRpc(host, endpoint, body?.payload ?? {})
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(result))
    },
  })
}
