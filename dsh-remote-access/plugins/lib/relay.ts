import { randomBytes } from 'node:crypto'

export interface RelayResult {
  status: number
  body: unknown
}

export type RelayOp = 'status' | 'sessions' | 'prompt'

export interface RelayJob {
  id: string
  op: RelayOp
  body?: unknown
}

const ONLINE_MS = 45_000
const RESULT_MS = 15_000
const QUEUE_CAP = 4

/**
 * 中枢内存信箱：公司电脑出站 poll 领任务，浏览器的 /route 等它交回结果。
 * 不落盘。进程重启后对方再 poll 一次即恢复在线。
 */
export class RelayHub {
  private lastSeen = new Map<string, number>()
  private queues = new Map<string, RelayJob[]>()
  private owners = new Map<string, string>()
  private results = new Map<string, (result: RelayResult) => void>()

  touch(slug: string, now: number): void {
    this.lastSeen.set(slug, now)
  }

  online(slug: string, now: number): boolean {
    const seen = this.lastSeen.get(slug)
    return seen !== undefined && now - seen < ONLINE_MS
  }

  enqueue(slug: string, op: RelayOp, body: unknown | undefined, now: number): Promise<RelayResult> {
    if (!this.online(slug, now)) return Promise.resolve({ status: 503, body: { error: '这台电脑没有连上中枢' } })
    const queue = this.queues.get(slug) ?? []
    if (queue.length >= QUEUE_CAP) return Promise.resolve({ status: 429, body: { error: '这台电脑还有请求没处理完' } })
    const id = randomBytes(16).toString('base64url')
    const job: RelayJob = body === undefined ? { id, op } : { id, op, body }
    queue.push(job)
    this.queues.set(slug, queue)
    this.owners.set(id, slug)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.results.delete(id)
        this.drop(slug, id)
        resolve({ status: 504, body: { error: '中枢等这台电脑回应超时' } })
      }, RESULT_MS)
      timer.unref()
      this.results.set(id, (result) => {
        clearTimeout(timer)
        resolve(result)
      })
    })
  }

  /** 领走一条。调用方必须已经用令牌对上 slug。 */
  poll(slug: string, now: number): RelayJob | null {
    this.touch(slug, now)
    const queue = this.queues.get(slug) ?? []
    const job = queue.shift() ?? null
    this.queues.set(slug, queue)
    return job
  }

  complete(slug: string, id: string, result: RelayResult): boolean {
    if (this.owners.get(id) !== slug) return false
    const done = this.results.get(id)
    if (done === undefined) return false
    this.results.delete(id)
    this.drop(slug, id)
    done(result)
    return true
  }

  private drop(slug: string, id: string): void {
    this.owners.delete(id)
    const queue = this.queues.get(slug)
    if (queue === undefined) return
    this.queues.set(slug, queue.filter((job) => job.id !== id))
  }
}
