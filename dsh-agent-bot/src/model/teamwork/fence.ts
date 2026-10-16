/**
 * 任务锁 / write 队列（docs/specs/12 §并发）。
 * 目标目录 write 串行：锁释放、FIFO 队列推进、waiting 恢复。
 * 运行时依赖 `relay`（writeFence + startTurn）显式传入；静态依赖 task-board / board-tools / agents / config。
 * 原为 patrol 内闭包，抽出后保持纯函数 + 显式传参，便于独立测试。
 */
import type { AgentConfig } from '../config.js'
import { getAgent as getAgentConfig } from '../agents.js'
import { marshalText } from './board-tools.js'
import { resolveFenceDir, type Relay } from './relay.js'
import { readTask, writeTask, type Assignee, type TaskBoard } from './task-board.js'

/** 该 assignee 的 write 串行目录（按目标目录；read 不占锁）。 */
export function fenceDirOf(task: TaskBoard, a: Assignee, cfg: AgentConfig): string {
  return resolveFenceDir(a.target, task.target, cfg.workspace)
}

/** 该中间层是否正卡在"等目标锁"上（waiting + write + 锁被占）。 */
export function isWaitingForLock(task: TaskBoard, agentId: string, relay: Relay): boolean {
  const self = task.assignees.find((a) => a.expertId === agentId)
  if (self === undefined || self.status !== 'waiting' || self.access !== 'write') return false
  const cfg = getAgentConfig(agentId)
  if (cfg === undefined) return false
  return relay.writeFence.occupied(fenceDirOf(task, self, cfg))
}

/** write 那一轮结束（idle/failed）→ 释放目标锁，并叫醒同一目标排队中的下一个。 */
export async function releaseAndAdvance(task: TaskBoard, a: Assignee, cfg: AgentConfig, relay: Relay): Promise<void> {
  if (a.access !== 'write') return
  const dir = fenceDirOf(task, a, cfg)
  relay.writeFence.release(dir, a.sessionId)
  await advanceWriteQueue(task.taskId, dir, relay)
}

/**
 * 同一目标目录的 write 队列推进（FIFO，按 md 里 assignees 顺序）：
 * 锁空着就取第一个 waiting 启动它（用派发时存下的 instruction）。
 */
export async function advanceWriteQueue(taskId: string, dir: string, relay: Relay): Promise<void> {
  if (relay.writeFence.occupied(dir)) return
  const fresh = readTask('running', taskId)
  if (fresh === undefined) return
  for (const a of fresh.assignees) {
    if (a.status !== 'waiting' || a.access !== 'write') continue
    const cfg = getAgentConfig(a.expertId)
    if (cfg === undefined) continue
    if (fenceDirOf(fresh, a, cfg) !== dir) continue
    if (a.instruction === undefined || a.instruction === '') {
      // 排队项没存下指令：无法重启 → 明确告警（不再静默地永远 waiting）
      console.warn(`agent-bot: 任务 ${taskId} 的 ${a.expertId} 在等 ${dir}，但没存 instruction，无法自动续跑`)
      continue
    }
    relay.writeFence.begin(dir, a.sessionId)
    a.status = 'running'
    a.wake = true
    writeTask('running', fresh)
    try {
      await relay.startTurn({
        agent: cfg,
        taskId: fresh.taskId,
        expertId: a.expertId,
        instruction: a.instruction,
        mdText: marshalText(fresh),
        access: a.access,
        session: 'reuse',
        nowMs: Date.now(),
        variables: { sender: fresh.sender, provider_id: fresh.providerId },
        promptText: '',
        permissionMode: cfg.permission_mode,
        targetWorkspace: a.target,
      })
    } catch (err) {
      console.warn(`agent-bot: 推进 write 队列启动 ${a.expertId} 失败: ${(err as Error).message}`)
    }
    return
  }
}

/**
 * 把"等下游"的中间层恢复成 running。返回是否真的恢复了。
 * 若它这一路是 write 且目标锁已被别人占着 → **不恢复**（保持 waiting，
 * 等那把锁的持有者结束、队列推进时再启动它），否则会出现两个 write 同写一个目录。
 */
export function resumeWaiting(task: TaskBoard, agentId: string, relay: Relay): boolean {
  const self = task.assignees.find((a) => a.expertId === agentId)
  if (self === undefined || self.status !== 'waiting') return false
  if (self.access === 'write') {
    const cfg = getAgentConfig(agentId)
    if (cfg === undefined) return false
    const dir = fenceDirOf(task, self, cfg)
    if (relay.writeFence.occupied(dir)) return false // 锁还占着：继续等
    relay.writeFence.begin(dir, self.sessionId)
  }
  self.status = 'running'
  return true
}