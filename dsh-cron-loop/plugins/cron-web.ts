// cron-loop Web 任务中心：`/cron` 页面 + jobs/runs JSON API。
// 复用 ruliu-config 的「前缀路由 + assets 单文件页」形态；所有变更走 cronStore，
// cron 校验复用 cron-core，保证与工具/命令同一套语义。

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import '@deepseek-ai/dsh-host-webserver' // 激活 Context.webServer 类型扩展
import { parseCron, computeNextRun } from './lib/cron-core.ts'
import { createJob } from './cron-scheduler.ts'
import type { CronLoopScheduler } from './cron-scheduler.ts'
import type { CronJobRecord } from './cron-store.ts'
import { normalizeCwd } from './cron-store.ts'

/** 插件名。 */
export const name = 'cron-web'
/** 硬依赖：webServer 与存储服务。 */
export const inject = ['webServer', 'cronLoopStore']

/** 任务中心页面 HTML（启动时从 assets 读取一次）。 */
const PAGE_HTML = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'assets', 'cron.html'),
  'utf8',
)

/** 读请求体（JSON，上限 1MB）。 */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 1024 * 1024) {
        reject(new Error('request body exceeds 1MB'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** JSON 响应。 */
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

/** job 的对外投影（附加计算好的下次触发时间）。 */
function jobView(job: CronJobRecord): CronJobRecord & { nextRunAtView: string | null } {
  let nextView: string | null = null
  if (job.enabled) {
    try {
      nextView = computeNextRun(parseCron(job.cron), new Date()).toISOString()
    } catch {
      nextView = null
    }
  }
  return { ...job, nextRunAtView: nextView }
}

export function apply(ctx: Context): void {
  const web = ctx.webServer
  const store = () => ctx.cronLoopStore

  // 任务中心页面
  web.register({
    kind: 'exact',
    path: '/cron',
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PAGE_HTML)
    },
  })

  // jobs 集合：GET 全量 / POST 新建
  web.register({
    kind: 'exact',
    path: '/cron/api/jobs',
    handler: (req, res) => {
      const method = req.method ?? 'GET'
      if (method === 'GET') {
        json(res, 200, { jobs: store().listJobs().map(jobView) })
        return
      }
      if (method === 'POST') {
        void (async () => {
          try {
            const body = JSON.parse((await readBody(req)).toString('utf8')) as {
              name?: string
              cwd?: string
              cron?: string
              prompt?: string
            }
            if (body.cwd === undefined || body.cwd === '') throw new Error('cwd is required')
            if (body.prompt === undefined || body.prompt === '') throw new Error('prompt is required')
            if (body.cron === undefined || body.cron === '') throw new Error('cron is required')
            const job = await createJob(ctx, {
              name: body.name,
              cwd: normalizeCwd(body.cwd),
              cron: body.cron,
              prompt: body.prompt,
            })
            json(res, 200, { ok: true, job: jobView(job) })
          } catch (error: unknown) {
            json(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        })()
        return
      }
      json(res, 405, { error: 'method not allowed' })
    },
  })

  // 单个 job：PUT 更新 / DELETE 删除 / POST trigger
  // 注意：prefix 路径不能带尾斜杠——webserver 按 `pathname.startsWith(prefix + '/')` 匹配。
  web.register({
    kind: 'prefix',
    path: '/cron/api/jobs',
    handler: (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const id = url.pathname.slice('/cron/api/jobs/'.length)
      const method = req.method ?? 'GET'
      // 动作子资源：/cron/api/jobs/<id>/trigger（立即执行）
      if (method === 'POST' && id.endsWith('/trigger')) {
        const jobId = id.slice(0, -'/trigger'.length)
        void (async () => {
          try {
            const scheduler = ctx.get('cronLoopScheduler') as CronLoopScheduler | undefined
            if (scheduler === undefined) throw new Error('cron-scheduler is not active')
            await scheduler.triggerJobNow(jobId)
            json(res, 200, { ok: true })
          } catch (error: unknown) {
            json(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        })()
        return
      }
      if (id === '' || id.includes('/')) {
        json(res, 404, { error: 'job id required' })
        return
      }
      if (method === 'PUT') {
        void (async () => {
          try {
            const job = store().jobs.get(id)
            if (job === undefined) throw new Error(`job ${id} not found`)
            const body = JSON.parse((await readBody(req)).toString('utf8')) as {
              name?: string
              cron?: string
              prompt?: string
              enabled?: boolean
            }
            if (body.cron !== undefined) parseCron(body.cron)
            const next: CronJobRecord = {
              ...job,
              name: body.name ?? job.name,
              cron: body.cron ?? job.cron,
              prompt: body.prompt ?? job.prompt,
              enabled: body.enabled ?? job.enabled,
              updatedAt: Date.now(),
            }
            await store().putJob(next)
            json(res, 200, { ok: true, job: jobView(next) })
          } catch (error: unknown) {
            json(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        })()
        return
      }
      if (method === 'DELETE') {
        void (async () => {
          try {
            const removed = await store().deleteJobCascade(id)
            if (!removed) throw new Error(`job ${id} not found`)
            json(res, 200, { ok: true })
          } catch (error: unknown) {
            json(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        })()
        return
      }
      json(res, 405, { error: 'method not allowed' })
    },
  })

  // 执行历史：?jobId=&limit=
  web.register({
    kind: 'exact',
    path: '/cron/api/runs',
    handler: (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const jobId = url.searchParams.get('jobId')
      const limitRaw = url.searchParams.get('limit')
      const limit = limitRaw !== null && limitRaw !== '' ? Number(limitRaw) : 100
      const runs = jobId !== null && jobId !== ''
        ? store().listRunsByJob(jobId, Number.isFinite(limit) ? limit : 100)
        : store().listAllRuns(Number.isFinite(limit) ? limit : 100)
      json(res, 200, { runs })
    },
  })
}
