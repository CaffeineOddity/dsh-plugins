// cron-loop 调度器：30s tick 扫描到期任务，创建/续接 cron 会话执行任务 prompt。
// 同时注册模型工具 `cron_job`（add/list/update/remove/pause/resume/runs）。
//
// 执行模型对齐 ruliu-bridge / 官方 headless：
//   live agent → 复用；磁盘已有 id → resume；否则 create（会话 id = `cron-<jobId>`）。
//   whenIdle → followup(prompt) → whenIdle → flush → 取本轮最后一条 assistant 文本。

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import '@deepseek-ai/cordis-plugin-timer' // 激活 Context.timer 类型扩展
import '@deepseek-ai/dsh-agent-presets' // 激活 Context.agentPresets 类型扩展
import '@deepseek-ai/dsh-agent-default-model' // 激活 Context.agentDefaultModel 类型扩展
import '@deepseek-ai/dsh-system-prompt' // 激活 Context.systemPrompt 类型扩展
import { computeNextRun, parseCron } from './lib/cron-core.ts'
import { summarizeOwnedInterval, waitIdleOrTimeout } from './lib/agent-run.ts'
import type { CronJobRecord, CronRunRecord } from './cron-store.ts'
import { normalizeCwd } from './cron-store.ts'

/** 调度 tick 间隔（ms）：分钟级任务的最大触发延迟。 */
const TICK_MS = 30_000

/** 单轮执行的安全阀（ms）：超时后按当前文本收口，agent 后台继续。 */
const RUN_TIMEOUT_MS = 10 * 60_000

/** 本插件 create/resume 得到的 handle（卸载时统一 dispose）。 */
const handles = new Map<string, AgentHandle>()

/** 同一 job 的执行串行标记（防重入：一个 job 同时至多一个在途执行）。 */
const inFlight = new Set<string>()

/** persistence.list() 的最小形状（宿主 web profile 必有该服务）。 */
interface PersistenceList {
  list(): Promise<Array<{ id: string }>>
}

/** 磁盘（persistence.list）是否已有该会话；无 persistence 服务时退回内存 store。 */
async function isPersisted(ctx: Context, sid: SessionId): Promise<boolean> {
  const persistence = ctx.get('sessionPersistence') as PersistenceList | undefined
  if (persistence === undefined) return ctx.sessions.get(sid) !== undefined
  const headers = await persistence.list()
  return headers.some((header) => header.id === sid)
}

/**
 * 照搬 web-app（dsh-host-apiproxy）的会话级模型接线：把 agent 的 model-selection
 * 接上 `agentDefaultModel`（settings.yaml 的 `agent-default-model`）。
 */
function installSelection(ctx: Context, agentCtx: Context): void {
  const agent = agentCtx.agent as Agent | undefined
  if (agent === undefined) {
    throw new Error('cron-scheduler: agent setup has no scoped agent')
  }
  let picked: { provider: string; model: string } | undefined
  const selection = {
    get current(): { provider: string; model: string } {
      if (picked !== undefined) return picked
      const logged = agent.session.requestHeader()?.config
      if (logged === undefined) return ctx.agentDefaultModel.currentSelection()
      return { provider: logged.provider, model: logged.model }
    },
    set current(next: { provider: string; model: string }) {
      picked = next
    },
    assembled: undefined,
  }
  installModelSelection(agentCtx, selection)
}

/** 组装 cron 会话的 scoped world：挂宿主 `standard` preset（完整 agent-loop 工具面）。 */
async function setupAgent(ctx: Context, agentCtx: Context, jobId: string): Promise<void> {
  await ctx.agentPresets.mount(agentCtx, 'standard')
  installSelection(ctx, agentCtx)
  agentCtx.systemPrompt.section({
    name: 'cron-loop:job',
    order: 1,
    text: '你是一次定时任务（cron-loop）的执行会话。按用户消息里的任务说明完成工作，产出尽量精炼的结论。',
  })
}

/** 确保目标会话有 live agent：已 live 直接取，否则按磁盘状态 resume/create。 */
async function ensureAgent(ctx: Context, sid: SessionId, jobId: string, cwd: string): Promise<Agent> {
  const live = ctx.agents.get(sid)
  if (live !== undefined) return live
  const persisted = await isPersisted(ctx, sid)
  const selection = ctx.agentDefaultModel.currentSelection()
  if (selection.provider === '' || selection.model === '') {
    throw new Error(`cron-scheduler: no default model for job ${jobId} — set agent-default-model in ~/.dsh/settings.yaml`)
  }
  const opts = {
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: async (agentCtx: Context): Promise<void> => {
      await setupAgent(ctx, agentCtx, jobId)
    },
  }
  const handle = persisted
    ? await ctx.agents.resume({ resumeSessionId: sid, ...opts })
    : await ctx.agents.create({ sessionId: sid, meta: { cwd }, ...opts })
  const key = String(sid)
  const previous = handles.get(key)
  handles.set(key, handle)
  if (previous !== undefined && previous !== handle) {
    void previous.dispose()
  }
  return handle.agent
}

/** 执行一个到期任务：写 running run → agent 回合 → 收口写结果 run。 */
async function runJob(ctx: Context, job: CronJobRecord): Promise<void> {
  const store = ctx.cronLoopStore
  const sid = SessionId(`cron-${job.id}`)
  const runId = `run-${job.id}-${Date.now()}`
  const startedAt = Date.now()
  const running: CronRunRecord = {
    id: runId,
    jobId: job.id,
    jobName: job.name,
    startedAt,
    status: 'running',
  }
  await store.putRun(running)
  await store.jobs.put(job.id, { ...job, lastRunAt: startedAt, lastStatus: 'running' })
  ctx.logger?.info?.(`cron-scheduler: job ${job.id} (${job.name}) fired`)
  try {
    const agent = await ensureAgent(ctx, sid, job.id, job.cwd)
    // 首个 whenIdle 同样加安全阀：会话 hang 死时不至于永久占住 inFlight。
    const pre = await waitIdleOrTimeout(agent.whenIdle(), RUN_TIMEOUT_MS)
    if (pre === 'timeout') throw new Error(`cron-scheduler: job ${job.id} agent not idle within ${RUN_TIMEOUT_MS}ms (pre-turn)`)
    const firstSeq = agent.session.seq
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: job.prompt }],
      source: { kind: 'user' },
    }))
    const wait = await waitIdleOrTimeout(agent.whenIdle(), RUN_TIMEOUT_MS)
    const text = summarizeOwnedInterval(agent.session.snapshotEvents(), firstSeq)
    await ctx.sessions.flush(agent.session)
    const finishedAt = Date.now()
    const summary = text !== ''
      ? text.slice(0, 500)
      : (wait === 'timeout' ? '执行超时，未产生最终文本' : '执行完成（无文本输出）')
    await store.putRun({ ...running, finishedAt, status: 'ok', sessionId: String(sid), summary })
    await store.jobs.put(job.id, { ...job, lastRunAt: startedAt, lastStatus: 'ok', updatedAt: finishedAt })
    ctx.logger?.info?.(`cron-scheduler: job ${job.id} finished ok in ${finishedAt - startedAt}ms`)
  } catch (error: unknown) {
    const finishedAt = Date.now()
    const message = error instanceof Error ? error.message : String(error)
    await store.putRun({ ...running, finishedAt, status: 'error', sessionId: String(sid), error: message })
    await store.jobs.put(job.id, { ...job, lastRunAt: startedAt, lastStatus: 'error', updatedAt: finishedAt })
    ctx.logger?.error?.(`cron-scheduler: job ${job.id} failed: ${message}`)
  } finally {
    inFlight.delete(job.id)
  }
}

/** 一个 tick：刷新 nextRunAt，触发到期且未在途的任务。 */
async function tick(ctx: Context): Promise<void> {
  const store = ctx.cronLoopStore
  const now = Date.now()
  for (const job of store.listJobs()) {
    if (!job.enabled) {
      if (job.nextRunAt !== undefined) {
        await store.jobs.put(job.id, { ...job, nextRunAt: undefined })
      }
      continue
    }
    let plan
    try {
      plan = parseCron(job.cron)
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      ctx.logger?.error?.(`cron-scheduler: job ${job.id} has invalid cron "${job.cron}": ${reason}`)
      continue
    }
    // 下次触发时间以「当前时刻」为锚点；到期即触发（错过多次只补一次，latest-only）。
    const next = computeNextRun(plan, new Date(now))
    if (job.nextRunAt !== next.getTime()) {
      await store.jobs.put(job.id, { ...job, nextRunAt: next.getTime() })
    }
    if (next.getTime() <= now && !inFlight.has(job.id)) {
      inFlight.add(job.id)
      const current = store.jobs.get(job.id)
      void runJob(ctx, current ?? { ...job, nextRunAt: next.getTime() })
    }
  }
}

/** 调度器对外能力（trigger 由 scheduler 的 ctx 执行，避免调用方 ctx 缺 inject）。 */
export interface CronLoopScheduler {
  triggerJobNow(jobId: string): Promise<void>
}

/** scheduler 激活后暴露的服务句柄；未激活时为 undefined。 */
let schedulerApi: CronLoopScheduler | undefined

/** 获取 scheduler 服务句柄；未激活时抛清晰错误。 */
export function getCronLoopScheduler(): CronLoopScheduler {
  if (schedulerApi === undefined) throw new Error('cron-scheduler is not active')
  return schedulerApi
}

/** 立即执行一次任务（服务入口：经 scheduler 自己的 ctx 执行，供工具/命令/Web 使用）。 */
async function triggerJobNowOn(ctx: Context, jobId: string): Promise<void> {
  const job = ctx.cronLoopStore.jobs.get(jobId)
  if (job === undefined) throw new Error(`cron-scheduler: job ${jobId} not found`)
  if (inFlight.has(jobId)) throw new Error(`cron-scheduler: job ${jobId} already running`)
  inFlight.add(jobId)
  await runJob(ctx, job)
}

/** 新建任务的公共入口（工具/命令/Web 共用）：校验 cron、生成 id、落盘。 */
export async function createJob(
  ctx: Context,
  input: { name?: string; cwd: string; cron: string; prompt: string; enabled?: boolean },
): Promise<CronJobRecord> {
  parseCron(input.cron) // 非法即抛 CronParseError
  const cwd = normalizeCwd(input.cwd)
  if (cwd === '' || !cwd.startsWith('/')) {
    throw new Error(`cron-scheduler: cwd must be an absolute path (after ~ expansion), got "${input.cwd}"`)
  }
  const store = ctx.cronLoopStore
  const existing = store.listJobs().map((job) => job.id)
  let index = 1
  while (existing.includes(`cron-${index}`)) index++
  const now = Date.now()
  const fallbackName = input.prompt.replace(/\s+/g, ' ').trim().slice(0, 24) || '未命名任务'
  const job: CronJobRecord = {
    id: `cron-${index}`,
    name: input.name !== undefined && input.name !== '' ? input.name : fallbackName,
    cwd,
    cron: input.cron,
    prompt: input.prompt,
    enabled: input.enabled ?? true,
    timezone: 'local',
    createdAt: now,
    updatedAt: now,
  }
  await store.putJob(job)
  ctx.logger?.info?.(`cron-scheduler: job ${job.id} created for ${input.cwd}`)
  return job
}

/** cron_job 工具的入参（defineTool 按参数 schema 收窄后与此一致）。 */
interface CronToolArgs {
  action: 'add' | 'list' | 'update' | 'remove' | 'pause' | 'resume' | 'runs'
  id?: string
  cron?: string
  prompt?: string
  name?: string
  cwd?: string
  enabled?: boolean
}

/** 文本输出（output schema: string，render 原样返回）。 */
function textResult(text: string): string {
  return text
}

/** cron-scheduler 插件：调度循环 + cron_job 模型工具。 */
export const name = 'cron-scheduler'
export const inject = ['tools', 'timer', 'agents', 'sessions', 'agentPresets', 'agentDefaultModel', 'systemPrompt', 'cronLoopStore']

export function apply(ctx: Context): void {
  // 对外暴露 trigger 服务：调用方拿到的 ctx 是 scheduler 自己的 fiber ctx，
  // 保证 runJob 内读 agents/sessions 等服务时 inject 检查通过。
  ctx.provide('cronLoopScheduler', {
    triggerJobNow: (jobId: string) => triggerJobNowOn(ctx, jobId),
  } satisfies CronLoopScheduler)
  schedulerApi = ctx.get('cronLoopScheduler') as CronLoopScheduler

  // 调度循环：进程存活期间每 30s 扫描一次；store/agents 等通过惰性 ctx.get 读取。
  ctx.effect(() => ctx.timer.interval(() => {
    const store = ctx.get('cronLoopStore')
    if (store === undefined) return
    void tick(ctx).catch((error: unknown) => {
      ctx.logger?.error?.(`cron-scheduler: tick failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }, TICK_MS), 'cron-scheduler.tick')

  ctx.tools.register(defineTool({
    name: 'cron_job',
    description: [
      '管理项目级 cron 定时任务。action:',
      '- add: 新建任务（prompt 必填；cron 缺省每分钟；cwd 缺省当前项目目录）',
      '- list: 列出全部任务（id/名称/cron/启用状态/下次触发时间）',
      '- update: 修改任务（id 必填；cron/prompt/name/enabled 可选）',
      '- remove: 删除任务及其历史（id 必填）',
      '- pause / resume: 停用 / 启用任务（id 必填）',
      '- runs: 查看任务最近执行历史（id 必填）',
    ].join('\n'),
    parameters: {
      action: { type: 'string', enum: ['add', 'list', 'update', 'remove', 'pause', 'resume', 'runs'], required: true, description: '要执行的动作' },
      id: { type: 'string', description: '任务 id（add 之外必填）' },
      cron: { type: 'string', description: '5 段 cron 表达式' },
      prompt: { type: 'string', description: '任务说明' },
      name: { type: 'string', description: '展示名' },
      cwd: { type: 'string', description: '任务归属目录（add 可选；缺省为当前项目目录）' },
      enabled: { type: 'boolean', description: '启用状态' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args: CronToolArgs, exec) {
      const store = ctx.cronLoopStore
      // 当前会话的项目目录：任务归属的缺省 cwd。
      const sessionCwd = exec.agent !== undefined ? exec.agent.session.header.cwd : undefined
      switch (args.action) {
        case 'add': {
          if (args.prompt === undefined || args.prompt === '') throw new Error('cron_job add: prompt is required')
          // cwd 优先用参数，缺省用当前会话 cwd；两者都必须是真实存在的目录。
          const rawCwd = args.cwd ?? sessionCwd
          if (rawCwd === undefined || rawCwd === '') {
            throw new Error('cron_job add: cwd is required when the current session has no project directory')
          }
          const cwd = normalizeCwd(rawCwd)
          const job = await createJob(ctx, {
            name: args.name,
            cwd,
            cron: args.cron ?? '* * * * *',
            prompt: args.prompt,
          })
          return textResult(`已创建任务 ${job.id}「${job.name}」\ncron: ${job.cron}\n目录: ${job.cwd}\nprompt: ${job.prompt}`)
        }
        case 'list': {
          const jobs = store.listJobs()
          if (jobs.length === 0) return textResult('暂无定时任务')
          const lines = jobs.map((job) => {
            const next = job.nextRunAt !== undefined ? new Date(job.nextRunAt).toLocaleString() : '—'
            return `${job.id} | ${job.enabled ? '✅' : '⏸'} | ${job.cron} | 下次: ${next} | ${job.cwd} | ${job.name}`
          })
          return textResult(['id | 状态 | cron | 下次触发 | 目录 | 名称', ...lines].join('\n'))
        }
        case 'update': {
          if (args.id === undefined) throw new Error('cron_job update: id is required')
          const job = store.jobs.get(args.id)
          if (job === undefined) throw new Error(`cron_job update: job ${args.id} not found`)
          if (args.cron !== undefined) parseCron(args.cron)
          const next: CronJobRecord = {
            ...job,
            cron: args.cron ?? job.cron,
            prompt: args.prompt ?? job.prompt,
            name: args.name ?? job.name,
            enabled: args.enabled ?? job.enabled,
            updatedAt: Date.now(),
          }
          await store.putJob(next)
          return textResult(`已更新 ${job.id}: cron=${next.cron} enabled=${String(next.enabled)}`)
        }
        case 'remove': {
          if (args.id === undefined) throw new Error('cron_job remove: id is required')
          const removed = await store.deleteJobCascade(args.id)
          if (!removed) throw new Error(`cron_job remove: job ${args.id} not found`)
          return textResult(`已删除 ${args.id} 及其历史`)
        }
        case 'pause': {
          if (args.id === undefined) throw new Error('cron_job pause: id is required')
          const job = store.jobs.get(args.id)
          if (job === undefined) throw new Error(`cron_job pause: job ${args.id} not found`)
          await store.putJob({ ...job, enabled: false, updatedAt: Date.now() })
          return textResult(`已暂停 ${args.id}`)
        }
        case 'resume': {
          if (args.id === undefined) throw new Error('cron_job resume: id is required')
          const job = store.jobs.get(args.id)
          if (job === undefined) throw new Error(`cron_job resume: job ${args.id} not found`)
          await store.putJob({ ...job, enabled: true, updatedAt: Date.now() })
          return textResult(`已恢复 ${args.id}`)
        }
        case 'runs': {
          if (args.id === undefined) throw new Error('cron_job runs: id is required')
          const runs = store.listRunsByJob(args.id, 10)
          if (runs.length === 0) return textResult(`${args.id} 暂无执行历史`)
          const lines = runs.map((run) => {
            const at = new Date(run.startedAt).toLocaleString()
            const tail = run.error !== undefined
              ? ` 错误: ${run.error}`
              : (run.summary !== undefined ? ` 摘要: ${run.summary.slice(0, 120)}` : '')
            return `${at} | ${run.status}${tail}`
          })
          return textResult(lines.join('\n'))
        }
      }
    },
  }))
}
