/**
 * 审批 / 问卷接管（docs/specs/12 §决策链路）。
 * 纯检测：从会话事件快照里找「挂起的审批请求」与「挂起的 ask_user_question 调用」。
 * 动作部分（宽限转交 / 发问卷 / 交回给人）依赖运行时宿主，由 patrol 编排 / 后续模块承接。
 */
import type { AgentLike } from '../runtime.js'

/** 内置问卷工具名（DSH 自带，会阻塞回合等网页 answerer）。 */
export const ASK_TOOL_NAME = 'ask_user_question'

/** 一份未决审批请求。 */
export interface OpenApproval {
  id: string
  toolName: string
  reason: string
}

/** 一个挂起的 ask_user_question 调用。 */
export interface OpenAskCall {
  callId: string
  questions: string[]
}

/**
 * 该会话此刻未配对的审批请求（`approval/asked` 有、`approval/decided` 没有）。
 * 审批审计事件写在**会话日志**里（`session.append`），读自己这一路的日志即可，
 * 会话关联天然就有（specs/12 §决策链路）。
 */
export function openApprovals(live: AgentLike): OpenApproval[] {
  const events = live.session.snapshotEvents() as Array<{ type: string; data?: unknown }>
  const asked = new Map<string, OpenApproval>()
  for (const e of events) {
    const d = (e.data ?? {}) as { id?: unknown; toolName?: unknown; reason?: unknown }
    const id = typeof d.id === 'string' ? d.id : ''
    if (id === '') continue
    if (e.type === 'approval/asked') {
      asked.set(id, {
        id,
        toolName: typeof d.toolName === 'string' ? d.toolName : '',
        reason: typeof d.reason === 'string' ? d.reason : '',
      })
    } else if (e.type === 'approval/decided') {
      asked.delete(id)
    }
  }
  return [...asked.values()]
}

/** 解析 ask_user_question 的 arguments（JSON 串）成题干列表。解析不出来给空数组。 */
export function parseAskQuestions(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw === '') return []
  try {
    const parsed = JSON.parse(raw) as { questions?: unknown }
    if (!Array.isArray(parsed.questions)) return []
    const out: string[] = []
    for (const q of parsed.questions) {
      if (typeof q !== 'object' || q === null) continue
      const rec = q as { question?: unknown; header?: unknown }
      const text = typeof rec.question === 'string' ? rec.question.trim() : ''
      if (text === '') continue
      const header = typeof rec.header === 'string' && rec.header.trim() !== '' ? `${rec.header.trim()}：` : ''
      out.push(`${header}${text}`)
    }
    return out
  } catch {
    return []
  }
}

/**
 * 挂起的 `ask_user_question` 调用（有 `tool/call`、没有配对的 `tool/result`）。
 * 它会把这一轮**阻塞**在会话里等网页 answerer —— IM 任务里没人看网页，所以必须接管。
 */
export function openAskCalls(live: AgentLike): OpenAskCall[] {
  const events = live.session.snapshotEvents() as Array<{ type: string; data?: unknown }>
  const open = new Map<string, string[]>()
  for (const e of events) {
    const d = (e.data ?? {}) as {
      callId?: unknown
      name?: unknown
      arguments?: unknown
      message?: { source?: { callId?: unknown } }
    }
    if (e.type === 'tool/call') {
      if (d.name !== ASK_TOOL_NAME) continue
      const callId = typeof d.callId === 'string' ? d.callId : ''
      if (callId === '') continue
      open.set(callId, parseAskQuestions(d.arguments))
    } else if (e.type === 'tool/result') {
      const callId = typeof d.message?.source?.callId === 'string' ? d.message.source.callId : ''
      if (callId !== '') open.delete(callId)
    }
  }
  return [...open.entries()].map(([callId, questions]) => ({ callId, questions }))
}