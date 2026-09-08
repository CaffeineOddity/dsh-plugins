// cron-loop 调度器：30s tick 扫描到期任务，创建/续接会话执行任务 prompt。
// 同时注册模型工具 `cron_job`（add/list/update/remove/pause/resume/runs）。
//
// 会话模型：每个 job 首次执行时生成随机 session id 并存入 job 记录，
// 之后每次执行都在该固定会话里 resume；进程重启后靠 persistence 恢复。
//   whenIdle -> followup(prompt) -> whenIdle -> flush -> 取本轮最后一条 assistant 文本。

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import '@deepseek-ai/cordis-plugin-timer' // 激活 Context.timer 类型扩展
import '@deepseek-ai/dsh-agent-presets' // 激活 Context.agentPresets 类型扩展
import '@deepseek-ai/dsh-agent-default-model' // 激活 Context.agentDefaultModel 类型扩展
import '@deepseek-ai/dsh-system-prompt' // 激活 Context.systemPrompt 类型扩展
import '@deepseek-ai/dsh-sandbox-policy' // 激活 setSandboxMode / SessionEventMap 扩展
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { computeNextRun, matches, parseCron } from './lib/cron-core.ts'
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
  list(): Promise<Array<{ id: string; cwd?: string }>>
}

/** 判断会话是否已被归档（web UI 从分组视图隐藏）。无 workspaceRegistry 时保守视为未归档。 */
function isArchived(ctx: Context, sessionId: string): boolean {
  const registry = ctx.get('workspaceRegistry') as { archivedSessionIds?: readonly string[] } | undefined
  if (registry?.archivedSessionIds === undefined) return false
  return registry.archivedSessionIds.includes(sessionId)
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
  // cron 任务无人值守，给 danger-full-access 让 agent 能自由执行 bash/fs 操作。
  // sandbox 策略靠 session.header.cwd 定 workspace root，cwd 正确即项目级隔离。
  const agent = agentCtx.agent
  if (agent !== undefined) {
    setSandboxMode(agent.session, 'danger-full-access')
  }
  agentCtx.systemPrompt.section({
    name: 'cron-loop:job',
    order: 1,
    text: '你是一次定时任务（cron-loop）的执行会话。按用户消息里的任务说明完成工作，产出尽量精炼的结论。',
  })
}

/** 确保目标会话有 live agent：已 live 直接取，否则按磁盘状态 resume/create。
 * 对齐 ruliu-bridge 的 ensureAgent 模式（照搬 lifecycle 判定 + 自愈）。
 * 返回值含最终使用的 sessionId（可能因归档/损坏而变化）。 */
async function ensureAgent(ctx: Context, sid: SessionId, jobId: string, cwd: string): Promise<{ agent: Agent; sessionId: string }> {
  const live = ctx.agents.get(sid)
  const persisted = await isPersisted(ctx, sid)
  // lifecycle: live 已在内存；resume 磁盘有但内存无；create 都无。
  const lifecycle = live !== undefined ? 'live' : persisted ? 'resume' : 'create'
  ctx.logger?.info?.(`cron-scheduler: ensureAgent job=${jobId} sid=${String(sid)} lifecycle=${lifecycle} cwd=${cwd}`)
  if (lifecycle === 'live') {
    if (live === undefined) throw new Error(`cron-scheduler: session ${sid} resolved live but agents.get returned undefined`)
    return { agent: live, sessionId: String(sid) }
  }
  const selection = ctx.agentDefaultModel.currentSelection()
  if (selection.provider === '' || selection.model === '') {
    throw new Error(`cron-scheduler: no default model for job ${jobId} - set agent-default-model in ~/.dsh/settings.yaml`)
  }
  const opts = {
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: async (agentCtx: Context): Promise<void> => {
      await setupAgent(ctx, agentCtx, jobId)
    },
  }
  let handle: AgentHandle
  let finalSid: string = String(sid)
  if (lifecycle === 'resume') {
    try {
      handle = await ctx.agents.resume({ resumeSessionId: sid, ...opts })
    } catch (error: unknown) {
      // 会话损坏（seq gap、corrupt log 等）-> 生成新 UUID 重建会话。
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('corrupt') || msg.includes('seq gap') || msg.includes('collision') || msg.includes('does not match')) {
        ctx.logger?.warn?.(`cron-scheduler: session ${sid} unusable (${msg.slice(0, 80)}), creating new session for job ${jobId}`)
        finalSid = randomUUID()
        handle = await ctx.agents.create({ sessionId: SessionId(finalSid), meta: { cwd }, ...opts })
      } else {
        throw error
      }
    }
  } else {
    // create：首次执行或会话被归档后重建。
    try {
      handle = await ctx.agents.create({ sessionId: sid, meta: { cwd }, ...opts })
      // 注册 workspace 让 webUI 侧边栏把会话归到正确分组（否则会落"未分组"）。
      const registry = ctx.get('workspaceRegistry') as { create(path: string): Promise<unknown> } | undefined
      if (registry !== undefined) {
        await registry.create(cwd).catch((e: unknown) => {
          ctx.logger?.warn?.(`cron-scheduler: workspaceRegistry.create(${cwd}) failed: ${e instanceof Error ? e.message : String(e)}`)
        })
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('collision') || msg.includes('already has a persisted')) {
        handle = await ctx.agents.resume({ resumeSessionId: sid, ...opts })
      } else {
        throw error
      }
    }
  }
  const key = finalSid
  const previous = handles.get(key)
  handles.set(key, handle)
  if (previous !== undefined && previous !== handle) {
    void previous.dispose()
  }
  return { agent: handle.agent, sessionId: finalSid }
}

/** 执行一个到期任务：写 running run → agent 回合 → 收口写结果 run。 */
async function runJob(ctx: Context, job: CronJobRecord): Promise<void> {
  const store = ctx.cronLoopStore
  // 每个任务绑定一个固定会话：首次执行生成随机 UUID 并存入 job.sessionId，之后复用。
  // 会话被归档（web UI 隐藏）后，生成新 UUID 重建，对齐 ruliu-bridge 的 resolveSessionId 模式。
  let sessionStr = job.sessionId ?? randomUUID()
  if (job.sessionId !== undefined && isArchived(ctx, job.sessionId)) {
    ctx.logger?.info?.(`cron-scheduler: job ${job.id} 会话 ${job.sessionId} 已归档，新建会话`)
    sessionStr = randomUUID()
  }
  const sid = SessionId(sessionStr)
  const jobWithSession = job
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
  await store.jobs.put(job.id, { ...jobWithSession, lastRunAt: startedAt, lastStatus: 'running' })
  ctx.logger?.info?.(`cron-scheduler: job ${job.id} (${job.name}) fired`)
  try {
    const { agent, sessionId: actualSid } = await ensureAgent(ctx, sid, job.id, job.cwd)
    // 首次执行把会话身份回写到 job 记录，之后每次复用该 id resume。
    await store.putJob({ ...jobWithSession, sessionId: actualSid })
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
    await store.jobs.put(job.id, { ...jobWithSession, sessionId: String(sid), lastRunAt: startedAt, lastStatus: 'ok', updatedAt: finishedAt })
    ctx.logger?.info?.(`cron-scheduler: job ${job.id} finished ok in ${finishedAt - startedAt}ms`)
  } catch (error: unknown) {
    const finishedAt = Date.now()
    const message = error instanceof Error ? error.message : String(error)
    await store.putRun({ ...running, finishedAt, status: 'error', sessionId: String(sid) !== '' ? String(sid) : undefined, error: message })
    await store.jobs.put(job.id, { ...jobWithSession, lastRunAt: startedAt, lastStatus: 'error', updatedAt: finishedAt })
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
    // nextRunAt 仅用于展示「下次触发时间」，取严格晚于当前时刻的下次匹配。
    const next = computeNextRun(plan, new Date(now))
    if (job.nextRunAt !== next.getTime()) {
      await store.jobs.put(job.id, { ...job, nextRunAt: next.getTime() })
    }
    // 触发判定：当前分钟是否命中 cron 计划。tick 每 30s 扫一次，同一分钟内
    // 可能命中两次，但 inFlight 标记保证一个 job 同时至多一个在途执行。
    if (matches(plan, new Date(now)) && !inFlight.has(job.id)) {
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
  action: 'add' | 'list' | 'update' | 'remove' | 'pause' | 'resume' | 'runs' | 'clear_runs'
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
export const inject = ['tools', 'timer', 'agents', 'sessions', 'agentPresets', 'agentDefaultModel', 'systemPrompt', 'cronLoopStore', 'sessionPersistence', 'workspaceRegistry']

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
      '- clear_runs: 删除任务执行历史（id 必填；不指定 id 则删除全部历史）',
    ].join('\n'),
    parameters: {
      action: { type: 'string', enum: ['add', 'list', 'update', 'remove', 'pause', 'resume', 'runs', 'clear_runs'], required: true, description: '要执行的动作' },
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
        case 'clear_runs': {
          if (args.id === undefined || args.id === '') {
            const count = await store.deleteAllRuns()
            return textResult(`已删除全部执行历史（${count} 条）`)
          }
          const job = store.jobs.get(args.id)
          if (job === undefined) throw new Error(`cron_job clear_runs: job ${args.id} not found`)
          const count = await store.deleteRunsByJob(args.id)
          return textResult(`已删除 ${args.id} 的执行历史（${count} 条）`)
        }
      }
    },
  }))
}
