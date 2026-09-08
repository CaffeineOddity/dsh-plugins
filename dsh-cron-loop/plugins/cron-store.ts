// cron-loop 存储：直接 fs 文件树，按项目目录名分组。
// 布局：~/.dsh/storages/crons/<project-basename>/<job-id>.json
//       ~/.dsh/storages/crons/<project-basename>/run-<job-id>-<ts>.json
// 纯数据访问层：不含调度与 HTTP 逻辑，供 scheduler/web/commands 共用。

import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { homedir } from 'node:os'
import { join, basename, dirname } from 'node:path'
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'

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

/**
 * 把 cwd 标准化为绝对路径：展开 `~`，保留原样（不 resolve symlink）。
 * 用于从 cwd 推导存储目录名，以及任务记录里的 cwd 字段。
 */
export function normalizeCwd(cwd: string): string {
  if (cwd.startsWith('~/')) return join(homedir(), cwd.slice(2))
  if (cwd === '~') return homedir()
  return cwd
}

/**
 * 从 cwd 推导存储子目录名（项目目录 basename）。
 * 例：`/Users/yy.inc/YYInc/Me/dsh-plugins` -> `dsh-plugins`。
 */
export function projectKey(cwd: string): string {
  const normalized = normalizeCwd(cwd)
  const key = basename(normalized)
  if (key === '' || key === '/' || key === '.') {
    throw new Error(`cron-store: cannot derive project key from cwd "${cwd}"`)
  }
  return key
}

/** cron 存储根目录：~/.dsh/storages/crons/。 */
function cronsRoot(): string {
  return join(homedir(), '.dsh', 'storages', 'crons')
}

/** 某项目的存储目录：~/.dsh/storages/crons/<project-key>/。 */
function projectDir(cwd: string): string {
  return join(cronsRoot(), projectKey(cwd))
}

/** 原子写入：先写临时文件再 rename（同目录，跨平台安全）。 */
async function writeAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await writeFile(tmp, data, 'utf8')
  // Node 没有 rename 跨平台原子保证，但同目录 rename 在 POSIX 上原子。
  const { rename } = await import('node:fs/promises')
  await rename(tmp, path)
}

/** 读取并校验一个 JSON 文件；缺失返回 undefined，格式错误抛错。 */
async function readJsonFile<T>(path: string, schema: { parse(value: unknown): T }): Promise<T | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error: unknown) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
  return schema.parse(JSON.parse(text))
}

/** 扫描某项目目录下的所有 job 文件（文件名不含 `run-` 前缀）。 */
async function readJobsInDir(dir: string): Promise<CronJobRecord[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (error: unknown) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
  const jobs: CronJobRecord[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    if (entry.startsWith('run-')) continue
    const job = await readJsonFile(join(dir, entry), jobSchema)
    if (job !== undefined) jobs.push(job)
  }
  return jobs
}

/** 扫描某项目目录下的所有 run 文件（文件名含 `run-` 前缀）。 */
async function readRunsInDir(dir: string): Promise<CronRunRecord[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (error: unknown) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
  const runs: CronRunRecord[] = []
  for (const entry of entries) {
    if (!entry.startsWith('run-') || !entry.endsWith('.json')) continue
    const run = await readJsonFile(join(dir, entry), runSchema)
    if (run !== undefined) runs.push(run)
  }
  return runs
}

/** 扫描 crons 根目录下所有项目子目录。 */
async function readAllProjectDirs(): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(cronsRoot())
  } catch (error: unknown) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
  const dirs: string[] = []
  for (const entry of entries) {
    const full = join(cronsRoot(), entry)
    if (existsSync(full)) dirs.push(full)
  }
  return dirs
}

/** cron-loop 存储服务：按项目目录分组的文件树读写。 */
export class CronStore {
  /** 内存缓存：按 project-key -> Map<jobId, job>，open 时全量加载。 */
  private readonly jobsByProject = new Map<string, Map<string, CronJobRecord>>()
  /** 内存缓存：按 project-key -> Map<runId, run>，open 时全量加载。 */
  private readonly runsByProject = new Map<string, Map<string, CronRunRecord>>()

  private constructor() {}

  /** 全量加载所有项目的 jobs 和 runs 到内存。 */
  static async open(ctx: Context): Promise<CronStore> {
    const store = new CronStore()
    await store.loadAll()
    ctx.effect(() => {
      return async () => {
        // fs 句柄无状态，无需关闭；清理仅清空内存缓存。
        store.jobsByProject.clear()
        store.runsByProject.clear()
      }
    }, 'cron-store.teardown')
    return store
  }

  /** 全量扫描磁盘，填充内存缓存。 */
  private async loadAll(): Promise<void> {
    for (const dir of await readAllProjectDirs()) {
      const key = basename(dir)
      const jobs = new Map<string, CronJobRecord>()
      for (const job of await readJobsInDir(dir)) jobs.set(job.id, job)
      this.jobsByProject.set(key, jobs)
      const runs = new Map<string, CronRunRecord>()
      for (const run of await readRunsInDir(dir)) runs.set(run.id, run)
      this.runsByProject.set(key, runs)
    }
  }

  /** 取某 job 所属的项目 key（内存缓存查找）。 */
  private projectKeyOf(jobId: string): string | undefined {
    for (const [key, jobs] of this.jobsByProject) {
      if (jobs.has(jobId)) return key
    }
    return undefined
  }

  /** 某 job 所属项目的 jobs map（用于 get/put）。 */
  private jobMap(cwd: string): Map<string, CronJobRecord> {
    const key = projectKey(cwd)
    let map = this.jobsByProject.get(key)
    if (map === undefined) {
      map = new Map()
      this.jobsByProject.set(key, map)
    }
    return map
  }

  /** 某 job 所属项目的 runs map（用于 putRun/deleteRun）。 */
  private runMap(cwd: string): Map<string, CronRunRecord> {
    const key = projectKey(cwd)
    let map = this.runsByProject.get(key)
    if (map === undefined) {
      map = new Map()
      this.runsByProject.set(key, map)
    }
    return map
  }

  /** 全部任务（按创建时间升序）。 */
  listJobs(): CronJobRecord[] {
    const all: CronJobRecord[] = []
    for (const jobs of this.jobsByProject.values()) {
      for (const job of jobs.values()) all.push(job)
    }
    return all.sort((a, b) => a.createdAt - b.createdAt)
  }

  /** 某目录（项目）下的任务，按创建时间升序。 */
  listJobsByCwd(cwd: string): CronJobRecord[] {
    const key = projectKey(cwd)
    return [...(this.jobsByProject.get(key)?.values() ?? [])]
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /** 新建/更新任务并落盘。 */
  async putJob(job: CronJobRecord): Promise<void> {
    const dir = projectDir(job.cwd)
    const map = this.jobMap(job.cwd)
    map.set(job.id, job)
    await writeAtomic(join(dir, `${job.id}.json`), JSON.stringify(job, null, 2))
  }

  /** 某 job 的 runs map（按 jobId 定位项目）。 */
  private runMapForJob(jobId: string): Map<string, CronRunRecord> | undefined {
    const key = this.projectKeyOf(jobId)
    if (key === undefined) return undefined
    return this.runsByProject.get(key)
  }

  /** 某任务的最近 N 条 run（新->旧）。 */
  listRunsByJob(jobId: string, limit: number): CronRunRecord[] {
    // 先按 jobId 在内存里筛（跨项目也覆盖，保证删除任务后仍能读到残留历史）。
    const all: CronRunRecord[] = []
    for (const runs of this.runsByProject.values()) {
      for (const run of runs.values()) {
        if (run.jobId === jobId) all.push(run)
      }
    }
    return all.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
  }

  /** 全部 run（新->旧），limit 缺省 100。 */
  listAllRuns(limit: number): CronRunRecord[] {
    const all: CronRunRecord[] = []
    for (const runs of this.runsByProject.values()) {
      for (const run of runs.values()) all.push(run)
    }
    return all.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
  }

  /** 写入一条 run 并裁剪该任务超量的历史。 */
  async putRun(run: CronRunRecord): Promise<void> {
    // run 需要写入 job 所属的项目目录（靠 jobId 反查 project key）。
    const jobKey = this.projectKeyOf(run.jobId)
    if (jobKey === undefined) {
      throw new Error(`cron-store: cannot find project for run jobId=${run.jobId} (job may have been deleted)`)
    }
    const dir = join(cronsRoot(), jobKey)
    const map = this.runsByProject.get(jobKey) ?? new Map<string, CronRunRecord>()
    this.runsByProject.set(jobKey, map)
    map.set(run.id, run)
    await writeAtomic(join(dir, `${run.id}.json`), JSON.stringify(run, null, 2))
    // 裁剪超量历史。
    const old = this.listRunsByJob(run.jobId, Number.MAX_SAFE_INTEGER)
    for (const stale of old.slice(MAX_RUNS_PER_JOB)) {
      await this.deleteRun(stale.id, jobKey)
    }
  }

  /** 删除一条 run（内部用，已知 project key）。 */
  private async deleteRun(runId: string, jobKey: string): Promise<void> {
    const map = this.runsByProject.get(jobKey)
    if (map !== undefined) map.delete(runId)
    await rm(join(cronsRoot(), jobKey, `${runId}.json`), { force: true })
  }

  /** 删除任务及其全部历史。 */
  async deleteJobCascade(jobId: string): Promise<boolean> {
    const jobKey = this.projectKeyOf(jobId)
    if (jobKey === undefined) return false
    const jobMap = this.jobsByProject.get(jobKey)
    if (jobMap === undefined || !jobMap.has(jobId)) return false
    jobMap.delete(jobId)
    await rm(join(cronsRoot(), jobKey, `${jobId}.json`), { force: true })
    // 删除该任务的全部 run。
    const runMap = this.runsByProject.get(jobKey)
    if (runMap !== undefined) {
      for (const run of [...runMap.values()]) {
        if (run.jobId === jobId) {
          runMap.delete(run.id)
          await rm(join(cronsRoot(), jobKey, `${run.id}.json`), { force: true })
        }
      }
    }
    return true
  }

  /**
   * 兼容旧 API：jobs 表句柄（get/put/delete/entries）。
   * 保留是因为 scheduler/web/commands 部分代码直接用 store.jobs.get/put。
   */
  get jobs(): {
    get(id: string): CronJobRecord | undefined
    put(id: string, job: CronJobRecord): Promise<void>
    delete(id: string): Promise<boolean>
  } {
    const self = this
    return {
      get(id: string): CronJobRecord | undefined {
        for (const jobs of self.jobsByProject.values()) {
          const job = jobs.get(id)
          if (job !== undefined) return job
        }
        return undefined
      },
      async put(_id: string, job: CronJobRecord): Promise<void> {
        await self.putJob(job)
      },
      async delete(id: string): Promise<boolean> {
        return self.deleteJobCascade(id)
      },
    }
  }

  /**
   * 兼容旧 API：runs 表句柄（get/put/delete/entries）。
   * 保留是因为 scheduler 部分代码直接用 store.runs.put/delete。
   */
  get runs(): {
    get(id: string): CronRunRecord | undefined
    put(id: string, run: CronRunRecord): Promise<void>
    delete(id: string): Promise<boolean>
  } {
    const self = this
    return {
      get(id: string): CronRunRecord | undefined {
        for (const runs of self.runsByProject.values()) {
          const run = runs.get(id)
          if (run !== undefined) return run
        }
        return undefined
      },
      async put(_id: string, run: CronRunRecord): Promise<void> {
        await self.putRun(run)
      },
      async delete(id: string): Promise<boolean> {
        // 反查 run 所属 project key。
        let jobKey: string | undefined
        for (const [key, runs] of self.runsByProject) {
          if (runs.has(id)) { jobKey = key; break }
        }
        if (jobKey === undefined) return false
        await self.deleteRun(id, jobKey)
        return true
      },
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    cronLoopStore: CronStore
  }
}

/** cordis 插件名。 */
export const name = 'cron-store'
/** 无硬依赖：直接 fs 读写，不需要 storage-domain 服务。 */
export const inject: readonly string[] = []

export async function apply(ctx: Context): Promise<void> {
  const store = await CronStore.open(ctx)
  ctx.provide('cronLoopStore', store)
}
