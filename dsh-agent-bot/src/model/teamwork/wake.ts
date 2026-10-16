/**
 * 叫醒链（docs/specs/12 §谁改状态）。
 * 纯函数合集：定位会话、完成情况指纹、叫醒文本、终态判定。
 * 只依赖静态模块（task-board / board-tools / relay / agents / config / types），不依赖运行时宿主，
 * 因此可独立测试、被 patrol / deliver 复用。
 */
import type { AgentLike } from '../runtime.js'
import { getAgent as getAgentConfig } from '../agents.js'
import { marshalText } from './board-tools.js'
import { taskSlotKey } from './relay.js'
import { encodeSessionKey, sessionPartsForEncode } from '../../types.js'
import type { Assignee, TaskBoard } from './task-board.js'

/** 终态：不再需要等它（idle=干完了 / failed=废了）。 */
export function isTerminal(a: Assignee): boolean {
  return a.status === 'idle' || a.status === 'failed'
}

/**
 * 某专家还有没有「没上报完的下游」：它派出去的人仍在跑/排队/待决，
 * **或者**那条下游刚终态但上报还没被消费（`wake=true`）。
 * 有 → 它自己虽然 idle 了也不算做完，不能叫醒它的上级；否则上级会抢在下游结果被综合之前被叫醒。
 */
export function hasPendingDownstream(task: TaskBoard, expertId: string): boolean {
  return task.assignees.some((c) => c.dispatchedBy === expertId && (!isTerminal(c) || c.wake))
}

/**
 * 该在这单里用哪条会话叫醒某 agent。**返回 sessionId**（不是槽 key）。
 *  - 它是这单的被派专家 → 用它自己的协作槽会话（纯被派、从没被直 @ 过的中间层也醒得来）。
 *  - 否则当作 taskLead → 用本任务记的 providerId/sessionParts（按人隔离时加 sender）反推通道槽，再取槽里的 sessionId。
 * 反推不出来（没这条槽 / 该 agent 不在 agents.json）→ undefined，调用方跳过。
 */
export function wakeSessionIdFor(task: TaskBoard, agentId: string): string | undefined {
  const own = task.assignees.find((a) => a.expertId === agentId)
  if (own !== undefined) return own.sessionId === '' ? undefined : own.sessionId
  const cfg = getAgentConfig(agentId)
  if (cfg === undefined) return undefined
  // 该 agent 在这单的任务槽（入站软路由可能把它放进来了）优先于通道槽
  const slot = cfg.sessions[taskSlotKey(task.taskId, agentId)]
  if (slot !== undefined && slot.sessionId !== '') return slot.sessionId
  // 槽丢了（清槽 / 换 key 格式 / agent 重建）→ 用 md 里的兜底记录，否则这单会僵在 running/
  if (agentId === task.taskLead && task.leadSessionId !== undefined && task.leadSessionId !== '') {
    return task.leadSessionId
  }
  try {
    const parts = sessionPartsForEncode(task.sessionParts, task.sender, cfg.session_by_sender)
    const slot = cfg.sessions[encodeSessionKey(parts, task.providerId)]
    if (slot === undefined) return undefined
    return slot.sessionId === '' ? undefined : slot.sessionId
  } catch {
    // sessionParts 为空 / 缺 sender：没有可定位的通道槽
    return undefined
  }
}

/** 专家在任务文件里的 assignee 记录（status 实时）。 */
export function assigneeOf(task: TaskBoard, expertId: string): Assignee | undefined {
  return task.assignees.find((a) => a.expertId === expertId)
}

/** 纯函数：finish 时该任务是否需要 deliver（有 assignee 或 taskLead 问过人）。 */
export function shouldDeliver(task: TaskBoard): boolean {
  return task.assignees.length > 0 || task.pendingHuman !== undefined
}

/** 终态 assignees 的 `expertId:status` 指纹（排序后稳定）。 */
export function terminalFingerprint(list: readonly Assignee[]): string {
  return list
    .filter((a) => isTerminal(a))
    .map((a) => `${a.expertId}:${a.status}`)
    .sort()
    .join(',')
}

/**
 * 被叫醒方的「完成情况指纹」：taskLead 看全单终态面，中间层看自己那几路。
 * 两者共用同一套，使「上报给 lead」与「全终态叫 lead 综合」自然去重。
 */
export function wakeFingerprint(task: TaskBoard, agentId: string): string {
  if (agentId === task.taskLead) return `done:${terminalFingerprint(task.assignees)}`
  return `kids:${terminalFingerprint(task.assignees.filter((a) => a.dispatchedBy === agentId))}`
}

/** 叫醒文本：先说清「谁做完/失败了」，再附 md 全文（不让人自己猜）。 */
export function wakeText(task: TaskBoard, finished: readonly Assignee[]): string {
  const parts = finished.map((a) => {
    const name = a.expertName === '' ? a.expertId : a.expertName
    return a.status === 'failed' ? `${name} 失败` : `${name} 已完成`
  })
  const head = parts.length === 0
    ? '任务有进展。'
    : `${parts.join('、')}。你派出去的这一路有结果了，请继续或收口。`
  return `${head}\n\n${marshalText(task)}`
}