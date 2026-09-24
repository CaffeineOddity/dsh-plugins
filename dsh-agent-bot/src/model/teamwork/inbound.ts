/**
 * 入站上下文（specs/12 §入站怎么绑任务）。
 *
 * 入站 ask 时把本轮的 sender / providerId / sessionParts / 群成员快照记在这里，
 * 供**同一轮**里模型调 `open_task` 新建任务时取用——工具作用域里本来没有这些。
 *
 * 只放内存，不落盘：任务文件本身就是持久记录；进程重启后的新入站会重新登记。
 * key 用 sessionId（工具的 `exec.agent.id` 就是它）。
 */
import type { GroupMember } from './task-board.js'

/** 一次入站带下来的上下文。 */
export interface InboundContext {
  sender: string
  providerId: string
  sessionParts: Record<string, string>
  /** 原 @ 原文（写进任务 md 的 originContext）。 */
  originContext: string
  /** 本轮群成员快照（已按 agents.json 过滤、去掉自己）。 */
  groupSnapshot: GroupMember[]
  /** 何时登记（epoch ms），仅供排查。 */
  at: number
}

const bySession = new Map<string, InboundContext>()

/** 记下某会话本轮入站上下文（覆盖上一轮：总是以最新一轮为准）。 */
export function rememberInbound(sessionId: string, ctx: Omit<InboundContext, 'at'>): void {
  if (sessionId === '') return
  bySession.set(sessionId, { ...ctx, sessionParts: { ...ctx.sessionParts }, groupSnapshot: ctx.groupSnapshot.map((m) => ({ ...m })), at: Date.now() })
}

/** 取某会话本轮的入站上下文；不在入站回合（如中继内部 followup）为 undefined。 */
export function inboundFor(sessionId: string): InboundContext | undefined {
  return bySession.get(sessionId)
}

/** 清掉某会话的入站上下文（可选：会话结束时）。 */
export function forgetInbound(sessionId: string): void {
  bySession.delete(sessionId)
}

/** 测试用：清空整表。 */
export function resetInboundCache(): void {
  bySession.clear()
}
