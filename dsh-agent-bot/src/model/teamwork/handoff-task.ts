/**
 * 跨会话接入：调用方会话 A 把活交给专家会话 B 时建 job。
 * 同一会话自己做完不建。B 已绑着 running 单则复用，不另起。
 */
import { touchSession } from '../agents.js'
import { bindSession, boundTaskId } from './binding.js'
import { createTask, readTask, type GroupMember, type TaskBoard } from './task-board.js'
import { taskSlotKey } from './relay.js'

/** 调用方是另一条 DSH 会话，且专家要在不同会话里处理。 */
export function isCrossSessionHandoff(callerSession: string, expertSessionId: string, callerIsAgentSession: boolean): boolean {
  const caller = callerSession.trim()
  if (!callerIsAgentSession) return false
  if (caller === '' || caller === 'local' || caller === expertSessionId) return false
  return true
}

/** 这条 running 单是「A 交给 B」：调用方会话记在 sessionParts.session，处理会话是 leadSessionId。 */
export function isHandoffTask(task: TaskBoard, expertSessionId: string): boolean {
  const caller = (task.sessionParts.session ?? '').trim()
  if (caller === '' || caller === 'local' || caller === expertSessionId) return false
  return task.leadSessionId === expertSessionId
}

export interface HandoffJobInput {
  expertId: string
  expertName: string
  expertSessionId: string
  sender: string
  providerId: string
  sessionParts: Record<string, string>
  originContext: string
  target?: string
  groupSnapshot: GroupMember[]
}

/** 没有 running 绑定就新建并绑上 B。已有则原样返回。 */
export function ensureHandoffJob(input: HandoffJobInput): TaskBoard {
  const existingId = boundTaskId(input.expertSessionId)
  if (existingId !== undefined) {
    const existing = readTask('running', existingId)
    if (existing !== undefined) return existing
  }
  const target = input.target === undefined || input.target.trim() === '' ? undefined : input.target.trim()
  const task = createTask({
    taskLead: input.expertId,
    leadName: input.expertName,
    leadSessionId: input.expertSessionId,
    sender: input.sender,
    providerId: input.providerId,
    sessionParts: input.sessionParts,
    originContext: input.originContext,
    access: 'write',
    target,
    groupSnapshot: input.groupSnapshot,
    body: '- 跨会话接入：调用方会话交给本专家处理。',
  })
  bindSession(input.expertSessionId, task.taskId)
  touchSession(input.expertId, taskSlotKey(task.taskId, input.expertId), input.expertSessionId, Date.now(), '')
  return task
}
