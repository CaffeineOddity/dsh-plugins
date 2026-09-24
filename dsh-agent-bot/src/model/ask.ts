/**
 * ask 入站校验与 sessionKey 编码（Model）。
 * 通道禁止传入 sessionKey / reset / webhook_url；key 只在本模块编。
 * G6 续接策略是纯函数；G7 队列在 model/queue.ts；G8 ensureAgent 在 model/runtime.ts。
 * G9 followup 超时从实际开始起算；G10 v1 单条 markdown。
 * G11 超时未 idle 时 pending 二次竞速，安全阀到点 reject。
 * G12 收口写 lastAskAt 在 agents.touchSession，由门面在 settle 后调用。
 */
import { existsSync, statSync } from 'node:fs'
import { getAgent } from './agents.js'
import type { AgentConfig, SessionSlot } from './config.js'
import { promptFingerprintFor } from './prompts.js'
import {
  encodeSessionKey,
  sessionPartsForEncode,
  type AgentAskRequest,
  type AgentAskResponse,
  type AgentOutboundMessage,
} from '../types.js'

/** 校验通过后的 ask 准备结果。回合尚未执行。 */
export interface PreparedAsk {
  agent: AgentConfig
  sessionKey: string
  parts: Record<string, string>
}

/** live / 磁盘续接 / 新建。live 优先；磁盘有则必须 resume，禁止同 id create。 */
export type AgentLifecycle = 'live' | 'resume' | 'create'

/** 槽策略：复用已有 sessionId，或覆盖为新建 uuid。 */
export type SessionReuseDecision =
  | { action: 'reuse'; sessionId: string }
  | { action: 'create'; sessionId: string }

function asRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  return raw as Record<string, unknown>
}

/**
 * 校验 ask 请求并编码 sessionKey。
 * 失败显式抛错，不返回空数组冒充成功。
 */
export function prepareAsk(req: AgentAskRequest, registeredProviderIds: ReadonlySet<string>): PreparedAsk {
  const bag = asRecord(req)
  if ('sessionKey' in bag) throw new Error('agent-bot: 通道禁止传入 sessionKey')
  if ('reset' in bag) throw new Error('agent-bot: 通道禁止传入 reset')
  const metaBag = asRecord(req.meta)
  if ('webhook_url' in metaBag || 'webhook' in metaBag || 'toid' in metaBag) {
    throw new Error('agent-bot: meta 禁止 webhook_url / webhook / toid')
  }
  if ('sessionKey' in metaBag || 'reset' in metaBag) {
    throw new Error('agent-bot: meta 禁止 sessionKey / reset')
  }

  const agentId = typeof req.agentId === 'string' ? req.agentId.trim() : ''
  if (agentId === '') throw new Error('agent-bot: agentId 不可为空')
  const providerId = typeof req.meta?.providerId === 'string' ? req.meta.providerId.trim() : ''
  if (providerId === '') throw new Error('agent-bot: providerId 不可为空')
  if (!registeredProviderIds.has(providerId)) {
    throw new Error(`agent-bot: 未注册 provider ${providerId}`)
  }
  if (typeof req.meta?.traceId !== 'string' || req.meta.traceId.trim() === '') {
    throw new Error('agent-bot: traceId 不可为空')
  }
  if (typeof req.context !== 'string') throw new Error('agent-bot: context 须为字符串')

  const agent = getAgent(agentId)
  if (agent === undefined) throw new Error(`agent-bot: 未知 agent ${agentId}`)
  if (agent.workspace.trim() === '') throw new Error(`agent-bot: agent ${agentId} 没有 workspace`)
  if (!existsSync(agent.workspace)) {
    throw new Error(`agent-bot: workspace 不存在: ${agent.workspace}`)
  }
  let st
  try {
    st = statSync(agent.workspace)
  } catch (err) {
    throw new Error(`agent-bot: 无法读取 workspace ${agent.workspace}: ${(err as Error).message}`)
  }
  if (!st.isDirectory()) throw new Error(`agent-bot: workspace 不是目录: ${agent.workspace}`)

  const sender = typeof req.meta.sender === 'string' ? req.meta.sender : ''
  const parts = sessionPartsForEncode(req.meta.sessionParts ?? {}, sender, agent.session_by_sender)
  const sessionKey = encodeSessionKey(parts, providerId)
  return { agent, sessionKey, parts }
}

/** 把 prepareAsk 结果接到槽策略。archived / now / 新 uuid 由运行时传入。 */
export function planSession(
  prepared: PreparedAsk,
  archived: boolean,
  nowMs: number,
  newSessionId: string,
): SessionReuseDecision {
  return resolveSessionReuse({
    reuseSession: prepared.agent.reuse_session,
    sessionTimeoutMinutes: prepared.agent.session_timeout_minutes,
    slot: prepared.agent.sessions[prepared.sessionKey],
    archived,
    nowMs,
    newSessionId,
    promptFingerprint: promptFingerprintFor(
      prepared.agent.prompt,
      prepared.agent.prompt_placement,
      prepared.agent.skill_groups,
      prepared.agent.prompt_append_skills,
    ),
  })
}

/**
 * 决定 create/resume/复用 live：live 优先；否则磁盘有会话必须 resume，禁止同 id create。
 */
export function resolveAgentLifecycle(live: boolean, persisted: boolean): AgentLifecycle {
  if (live) return 'live'
  if (persisted) return 'resume'
  return 'create'
}

/**
 * 按 agent 配置决定本轮 sessionId：不续接则每次新建；续接时看槽、归档、空闲超时、prompt 指纹。
 * session_timeout_minutes=0 不因空闲拆会话。newSessionId 由调用方生成，便于单测。
 */
export function resolveSessionReuse(input: {
  reuseSession: boolean
  sessionTimeoutMinutes: number
  slot: SessionSlot | undefined
  archived: boolean
  nowMs: number
  newSessionId: string
  promptFingerprint: string
}): SessionReuseDecision {
  if (input.newSessionId.trim() === '') throw new Error('agent-bot: newSessionId 不可为空')
  if (!input.reuseSession) return { action: 'create', sessionId: input.newSessionId }
  const slot = input.slot
  if (slot === undefined || slot.sessionId.trim() === '') {
    return { action: 'create', sessionId: input.newSessionId }
  }
  if (input.archived) return { action: 'create', sessionId: input.newSessionId }
  if (idleTimedOut(slot.lastAskAt, input.nowMs, input.sessionTimeoutMinutes)) {
    return { action: 'create', sessionId: input.newSessionId }
  }
  if (slot.promptFingerprint !== undefined && slot.promptFingerprint !== input.promptFingerprint) {
    return { action: 'create', sessionId: input.newSessionId }
  }
  return { action: 'reuse', sessionId: slot.sessionId }
}

/** 空闲超时：timeoutMinutes=0 永不因空闲拆；lastAskAt 非法视为无记录。 */
export function idleTimedOut(lastAskAt: number, nowMs: number, timeoutMinutes: number): boolean {
  if (timeoutMinutes === 0) return false
  if (timeoutMinutes < 0) throw new Error('agent-bot: session_timeout_minutes 须为 ≥ 0 的整数')
  if (!Number.isFinite(lastAskAt) || lastAskAt <= 0) return true
  const limitMs = timeoutMinutes * 60_000
  return nowMs - lastAskAt > limitMs
}

/** 拥有区间的结束方式：等到 idle，或安全阀超时。 */
export type IdleWaitResult = 'idle' | 'timeout'

/** 一条会话事件的最小投影（只读 type/seq；data 按 type 收窄）。 */
export interface RunEvent {
  seq: number
  type: string
  data?: unknown
}

/** followup 最小面。不 import runtime，避免环依赖。 */
export interface FollowupAgent {
  session: { seq: number; snapshotEvents(): RunEvent[] }
  followup(input: unknown): void
  whenIdle(): Promise<void>
}

/** 本轮 followup 的计时结果。 */
export interface FollowupTurnResult {
  wait: IdleWaitResult
  firstSeq: number
}

/** 从 assistant/message 的 data 抽出非空 text 块。 */
function assistantText(data: unknown): string {
  if (data === null || typeof data !== 'object') return ''
  const message = (data as { message?: { content?: unknown } }).message
  if (message === undefined || !Array.isArray(message.content)) return ''
  const parts: string[] = []
  for (const block of message.content) {
    if (block === null || typeof block !== 'object') continue
    const row = block as { type?: unknown; text?: unknown }
    if (row.type !== 'text' || typeof row.text !== 'string' || row.text === '') continue
    parts.push(row.text)
  }
  return parts.join('')
}

/**
 * 汇总一段自有运行区间的最终 assistant 文本。
 * 从 firstSeq 起遇到 turn/start 才开始记账，空文本的 tool-call assistant 不覆盖已有答案。
 */
export function summarizeOwnedInterval(events: readonly RunEvent[], firstSeq: number): string {
  let started = false
  let text = ''
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type !== 'assistant/message') continue
    const joined = assistantText(event.data)
    if (joined !== '') text = joined
  }
  return text
}

/** v1 出站：本轮最后一条助手文本收成单条 markdown。空文本 → 空数组。 */
export function toMarkdownMessages(text: string): AgentOutboundMessage[] {
  if (text === '') return []
  return [{ kind: 'markdown', text, url: '', atUserIds: [], atAll: false }]
}

/** pending 补发：后文与首次相同或仍空则空数组，避免通道把同一条再发一遍。 */
export function remainingMarkdown(firstText: string, laterText: string): AgentOutboundMessage[] {
  if (laterText === '' || laterText === firstText) return []
  return toMarkdownMessages(laterText)
}

/**
 * pending 第二段：再 race(whenIdle, timeoutMs)。idle 给剩余条；到点 reject。
 * 禁止 JSON.stringify 这条 Promise。
 */
export async function collectPendingMessages(
  agent: FollowupAgent,
  firstSeq: number,
  firstText: string,
  timeoutMs: number,
): Promise<AgentOutboundMessage[]> {
  const wait = await waitIdleOrTimeout(agent.whenIdle(), timeoutMs)
  if (wait === 'timeout') throw new Error('agent-bot: pending 安全阀超时')
  const laterText = summarizeOwnedInterval(agent.session.snapshotEvents(), firstSeq)
  return remainingMarkdown(firstText, laterText)
}

/**
 * 跑完 followup 后收口。idle → pending=null；超时 → pending 二次竞速。
 * ack / 超时 / 空回复文案不进 messages。
 */
export async function settleAskRound(
  agent: FollowupAgent,
  context: string,
  timeoutMs: number,
): Promise<AgentAskResponse> {
  const turn = await runFollowupTurn(agent, context, timeoutMs)
  const text = summarizeOwnedInterval(agent.session.snapshotEvents(), turn.firstSeq)
  const messages = toMarkdownMessages(text)
  if (turn.wait === 'idle') return { messages, pending: null }
  return {
    messages,
    pending: collectPendingMessages(agent, turn.firstSeq, text, timeoutMs),
  }
}

/**
 * 竞速 whenIdle 与超时。timeoutMs<=0 表示只等 idle。
 * 必须在 followup 调用之后再调，排队/上一轮 idle 不消耗本轮超时。
 */
export async function waitIdleOrTimeout(whenIdle: Promise<void>, timeoutMs: number): Promise<IdleWaitResult> {
  if (timeoutMs <= 0) {
    await whenIdle
    return 'idle'
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<IdleWaitResult>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
    })
    const idle = whenIdle.then((): IdleWaitResult => 'idle')
    return await Promise.race([idle, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 只**投递**本轮（等上一轮先闲），不等它跑完 —— 返回本轮产出的起点 seq。
 * 用于「通道有 deliver」的异步模式：立刻回执，产出等回合结束再由调用方推回去。
 */
export async function startFollowupTurn(agent: FollowupAgent, context: string): Promise<number> {
  if (typeof context !== 'string') throw new Error('agent-bot: context 须为字符串')
  await agent.whenIdle()
  const firstSeq = agent.session.seq
  agent.followup({
    id: `agent-bot-${Date.now()}`,
    role: 'user',
    content: [{ type: 'text', text: context }],
    source: { kind: 'user' },
  })
  return firstSeq
}

/**
 * 上一轮必须先闲，再 followup，超时从 followup 实际开始起算。
 */
export async function runFollowupTurn(
  agent: FollowupAgent,
  context: string,
  timeoutMs: number,
): Promise<FollowupTurnResult> {
  if (typeof context !== 'string') throw new Error('agent-bot: context 须为字符串')
  await agent.whenIdle()
  const firstSeq = agent.session.seq
  agent.followup({
    id: `agent-bot-${Date.now()}`,
    role: 'user',
    content: [{ type: 'text', text: context }],
    source: { kind: 'user' },
  })
  const wait = await waitIdleOrTimeout(agent.whenIdle(), timeoutMs)
  return { wait, firstSeq }
}
