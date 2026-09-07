// cron-loop 存储：基于 dsh-storage-domain 的 jobs / runs 两张表。
// 纯数据访问层：不含调度与 HTTP 逻辑，供 scheduler/web/commands 共用。

import type { Context } from '@deepseek-ai/cordis'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/** 一条定时任务。 */
export interface CronJobRecord {
  /** 任务 id（`cron-<序号>`）。 */
  id: string
  /** 展示名（默认取 prompt 前 24 字）。 */
  name: string
  /** 任务归属的绝对工作目录（项目级归属）。 */
  cwd: string
  /** 5 段 cron 表达式。 */
  cron: string
  /** 到期注入会话的任务 prompt。 */
  prompt: string
  /** 是否启用（停用不触发也不补跑）。 */
  enabled: boolean
  /** 保留字段：v1 固定本地时区。 */
  timezone: string
  /** 创建时间（epoch ms）。 */
  createdAt: number
  /** 最近更新时间（epoch ms）。 */
  updatedAt: number
  /** 最近一次触发时间（epoch ms）。 */
  lastRunAt?: number
  /** 最近一次触发结果。 */
  lastStatus?: 'ok' | 'error' | 'running'
  /** 由调度器刷新的下次触发时间（epoch ms）。 */
  nextRunAt?: number
}

/** 一次执行记录。 */
export interface CronRunRecord {
  /** run id（`run-<jobId>-<时间戳>`）。 */
  id: string
  /** 所属任务 id。 */
  jobId: string
  /** 任务名快照（删除任务后历史仍可读）。 */
  jobName: string
  /** 开始时间（epoch ms）。 */
  startedAt: number
  /** 结束时间（epoch ms）；running 时缺省。 */
  finishedAt?: number
  /** 执行状态。 */
  status: 'running' | 'ok' | 'error'
  /** 执行会话 id（可跳转续聊）。 */
  sessionId?: string
  /** 最终 assistant 文本（截断 500 字）。 */
  summary?: string
  /** 失败原因。 */
  error?: string
}

/** 每任务保留的历史条数。 */
export const MAX_RUNS_PER_JOB = 50

/** zod 校验：job 记录。 */
const jobSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  cwd: z.string().min(1),
  cron: z.string().min(1),
  prompt: z.string().min(1),
  enabled: z.boolean(),
  timezone: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastRunAt: z.number().optional(),
  lastStatus: z.enum(['ok', 'error', 'running']).optional(),
  nextRunAt: z.number().optional(),
})

/** zod 校验：run 记录。 */
const runSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  jobName: z.string().min(1),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  status: z.enum(['running', 'ok', 'error']),
  sessionId: z.string().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
})

/** storage-domain 领域声明（jobs + runs 两表；unit 名只允许 [a-z0-9_]）。 */
export const cronDomainSpec = {
  name: 'cron_loop',
  version: 1,
  tables: {
    jobs: { valueSchema: jobSchema },
    runs: { valueSchema: runSchema },
  },
} as const

/** 打开后的 domain 句柄类型。 */
export type CronDomain = Domain<typeof cronDomainSpec>

/** cron-loop 存储服务：域句柄 + 便捷读写方法。 */
export class CronStore {
  /** 已打开的 domain（ctx.storageDomain.open 的结果）。 */
  private readonly domain: CronDomain

  private constructor(domain: CronDomain) {
    this.domain = domain
  }

  /** jobs 表。 */
  get jobs(): KvTable<string, CronJobRecord> {
    return this.domain.table('jobs')
  }

  /** runs 表。 */
  get runs(): KvTable<string, CronRunRecord> {
    return this.domain.table('runs')
  }

  /** 打开 domain 并包装为服务；ctx.effect 卸载时统一关闭。 */
  static async open(ctx: Context): Promise<CronStore> {
    const domain = await ctx.storageDomain.open(cronDomainSpec)
    const store = new CronStore(domain)
    ctx.effect(() => {
      // 返回异步 teardown：fiber 卸载时关闭 domain 并排空写链。
      return async () => {
        await domain.close()
      }
    }, 'cron-store.close')
    return store
  }

  /** 全部任务（按创建时间升序）。 */
  listJobs(): CronJobRecord[] {
    return [...this.jobs.entries()]
      .map(([, v]) => v)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /** 某目录（项目）下的任务，按创建时间升序。 */
  listJobsByCwd(cwd: string): CronJobRecord[] {
    return this.listJobs().filter((job) => job.cwd === cwd)
  }

  /** 新建任务并落盘。 */
  async putJob(job: CronJobRecord): Promise<void> {
    await this.jobs.put(job.id, job)
  }

  /** 某任务的最近 N 条 run（新→旧）。 */
  listRunsByJob(jobId: string, limit: number): CronRunRecord[] {
    return [...this.runs.entries()]
      .map(([, v]) => v)
      .filter((r) => r.jobId === jobId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit)
  }

  /** 全部 run（新→旧），limit 缺省 100。 */
  listAllRuns(limit: number): CronRunRecord[] {
    return [...this.runs.entries()]
      .map(([, v]) => v)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit)
  }

  /** 写入一条 run 并裁剪该任务超量的历史。 */
  async putRun(run: CronRunRecord): Promise<void> {
    await this.runs.put(run.id, run)
    const old = this.listRunsByJob(run.jobId, Number.MAX_SAFE_INTEGER)
    for (const stale of old.slice(MAX_RUNS_PER_JOB)) {
      await this.runs.delete(stale.id)
    }
  }

  /** 删除任务及其全部历史。 */
  async deleteJobCascade(jobId: string): Promise<boolean> {
    const removed = await this.jobs.delete(jobId)
    for (const run of this.listRunsByJob(jobId, Number.MAX_SAFE_INTEGER)) {
      await this.runs.delete(run.id)
    }
    return removed
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    cronLoopStore: CronStore
  }
}

/** cordis 插件名。 */
export const name = 'cron-store'
/** 硬依赖：storage-domain。 */
export const inject = ['storageDomain']

export async function apply(ctx: Context): Promise<void> {
  const store = await CronStore.open(ctx)
  ctx.provide('cronLoopStore', store)
}
