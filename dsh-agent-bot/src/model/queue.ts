/**
 * ask 串行队列（G7 / G11）。
 * 同一 (agentId, sessionKey) 且 reuse_session=true 时 FIFO，不设上限；
 * 上一轮整段（含 pending 安全阀 settle）后才放行下一轮。reuse_session=false 不排队。
 */

export interface AskQueue {
  enqueue<T>(agentId: string, sessionKey: string, reuseSession: boolean, run: () => Promise<T>): Promise<T>
}

function queueKey(agentId: string, sessionKey: string): string {
  if (agentId.trim() === '') throw new Error('agent-bot: 队列需要非空 agentId')
  if (sessionKey.trim() === '') throw new Error('agent-bot: 队列需要非空 sessionKey')
  return `${agentId}\0${sessionKey}`
}

/** 创建进程内 ask 队列。失败的上一轮不吞掉下一轮。 */
export function createAskQueue(): AskQueue {
  const tails = new Map<string, Promise<void>>()
  return {
    enqueue<T>(agentId: string, sessionKey: string, reuseSession: boolean, run: () => Promise<T>): Promise<T> {
      if (!reuseSession) return run()
      const key = queueKey(agentId, sessionKey)
      const prev = tails.get(key) ?? Promise.resolve()
      const next = prev.then(run, run)
      tails.set(
        key,
        next.then(
          () => undefined,
          () => undefined,
        ),
      )
      return next
    },
  }
}

/**
 * 立刻把 result 交给 ask 调用方；若带 pending，等它 fulfill/reject 后才放行下一轮。
 * pending reject 不堵队列，也不改写调用方拿到的那份 Promise。
 */
export function enqueueHoldPending<T extends { pending: Promise<unknown> | null }>(
  queue: AskQueue,
  agentId: string,
  sessionKey: string,
  reuseSession: boolean,
  run: () => Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    void queue.enqueue(agentId, sessionKey, reuseSession, async () => {
      try {
        const result = await run()
        resolve(result)
        if (result.pending !== null) {
          await result.pending.then(
            () => undefined,
            () => undefined,
          )
        }
      } catch (error) {
        reject(error)
      }
    })
  })
}
