/**
 * 交付 / 通知（docs/specs/12 §谁改状态）。
 * 发消息给原发送者、进度反馈、审批等待通知、事件序号判定。
 * 运行时依赖 `channel`（host.deliver）与共享去重 `notified` Map 显式传入，保持纯函数 + 显式传参。
 * 收口综合（summarizeAndDeliver / retryDeliver）依赖 patrol 主循环的 synthesizing / 定时器，仍在 patrol 编排。
 */
import type { AgentOutboundMessage } from '../../types.js'
import type { Assignee, TaskBoard } from './task-board.js'

/** 发消息通道（最小面）：host.deliver。 */
export interface DeliverChannel {
  deliver(providerId: string, sessionParts: Record<string, string>, messages: AgentOutboundMessage[]): Promise<void>
}

/** 从 firstSeq 之后有没有新事件（用来判断"叫醒的那一轮到底跑没跑过"）。 */
export function hasEventsAfter(
  live: { session: { snapshotEvents(): Array<{ seq: number }> } },
  firstSeq: number,
): boolean {
  return live.session.snapshotEvents().some((e) => e.seq > firstSeq)
}

/** 发一条 markdown 给人（原发送者所在的会话/群）。返回是否真发出去了。 */
export async function deliverToSender(task: TaskBoard, text: string, channel: DeliverChannel): Promise<boolean> {
  const sessionParts = { provider_id: task.providerId, ...task.sessionParts }
  try {
    await channel.deliver(task.providerId, sessionParts, [
      { kind: 'markdown', text, url: '', atUserIds: task.sender === '' ? [] : [task.sender], atAll: false },
    ])
    return true
  } catch (err) {
    console.warn(`agent-bot: deliver 失败（文件留在 running/）: ${(err as Error).message}`)
    return false
  }
}

/** 进度反馈：给原发送者发一条「还在做」，同一 deadlineAt 只发一次（不刷屏）。 */
export async function notifyProgress(
  task: TaskBoard,
  unfinished: readonly Assignee[],
  channel: DeliverChannel,
  notified: Map<string, string>,
): Promise<void> {
  const names = unfinished.map((a) => (a.expertName === '' ? a.expertId : a.expertName))
  const fingerprint = `progress:${task.deadlineAt}:${names.join(',')}`
  const key = `${task.taskId}\0__human__`
  if (notified.get(key) === fingerprint) return
  const ok = await deliverToSender(task, `还在做：${names.join('、')}。做完我会回来答复。`, channel)
  if (ok) notified.set(key, fingerprint)
}

/** 通知人：某专家卡在等审批（同一请求 id 只发一次）。 */
export async function notifyApprovalWait(
  task: TaskBoard,
  a: Assignee,
  open: ReadonlyArray<{ id: string; toolName: string; reason: string }>,
  channel: DeliverChannel,
  notified: Map<string, string>,
): Promise<void> {
  const name = a.expertName === '' ? a.expertId : a.expertName
  const fingerprint = `approval:${open.map((o) => o.id).sort().join(',')}`
  const key = `${task.taskId}\0${a.expertId}`
  if (notified.get(key) === fingerprint) return
  const detail = open
    .map((o) => `${o.toolName === '' ? '某操作' : o.toolName}${o.reason === '' ? '' : `（${o.reason}）`}`)
    .join('、')
  const ok = await deliverToSender(task, `${name} 卡在等你批准：${detail}。\n\n请到网页确认；确认后它会自己继续，我等它做完再回来答复。`, channel)
  if (ok) notified.set(key, fingerprint)
}