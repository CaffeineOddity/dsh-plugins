// cron-loop 斜杠命令：/cron（Claude Code 风格）与 /loop 别名。
// 全局注册（纯 ctx 层），任意会话可用；任务归属按 agent 会话的 cwd（项目级）。

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import '@deepseek-ai/dsh-commands' // 激活 Context.commands 类型扩展
import { createJob } from './cron-scheduler.ts'
import { normalizeCwd } from './cron-store.ts'

/** 成功结果。 */
function ok(text: string): CommandResult {
  return { kind: 'success', text }
}

/** 失败结果。 */
function fail(text: string): CommandResult {
  return { kind: 'error', text }
}

/** 任务行（列表渲染）。 */
function jobLine(job: { id: string; enabled: boolean; cron: string; name: string; cwd: string; nextRunAt?: number }): string {
  const next = job.nextRunAt !== undefined ? new Date(job.nextRunAt).toLocaleString() : '—'
  return `${job.id} | ${job.enabled ? '✅' : '⏸'} | ${job.cron} | 下次: ${next} | ${job.name} | ${job.cwd}`
}

/** 解析 `/cron <expr> <prompt>` 的首段表达式与剩余 prompt。 */
function splitExprAndPrompt(raw: string): { expr: string; prompt: string } | undefined {
  const trimmed = raw.trim()
  const spaceAt = trimmed.search(/\s/)
  if (spaceAt < 0) return undefined
  return { expr: trimmed.slice(0, spaceAt), prompt: trimmed.slice(spaceAt).trim() }
}

/** /cron 子命令处理（rawInput 为命令名后的原文）。 */
async function handleCron(ctx: Context, agentCwd: string | undefined, raw: string): Promise<CommandResult> {
  const store = ctx.cronLoopStore
  const input = raw.trim()

  // 无参数 / help：用法 + 当前列表
  if (input === '' || input === 'help' || input === 'ls' || input === 'list') {
    const jobs = agentCwd !== undefined
      ? store.listJobsByCwd(normalizeCwd(agentCwd))
      : store.listJobs()
    const scope = agentCwd !== undefined ? `当前项目 ${normalizeCwd(agentCwd)}` : '全部项目'
    const lines = jobs.length === 0
      ? [`（${scope}暂无定时任务）`]
      : jobs.map(jobLine)
    return ok([
      '用法: /cron <cron表达式> <任务prompt> ｜ /cron list ｜ /cron rm <id> ｜ /cron on <id> ｜ /cron off <id>',
      `定时任务（${scope}）:`,
      ...lines,
    ].join('\n'))
  }

  // rm/on/off 子命令
  const sub = input.split(/\s+/)
  const head = sub[0] ?? ''
  const arg = sub.slice(1).join(' ').trim()
  if (head === 'rm' || head === 'remove' || head === 'del') {
    if (arg === '') return fail('用法: /cron rm <id>')
    const removed = await store.deleteJobCascade(arg)
    return removed ? ok(`已删除 ${arg} 及其历史`) : fail(`任务 ${arg} 不存在`)
  }
  if (head === 'on' || head === 'off') {
    if (arg === '') return fail(`用法: /cron ${head} <id>`)
    const job = store.jobs.get(arg)
    if (job === undefined) return fail(`任务 ${arg} 不存在`)
    const enabled = head === 'on'
    await store.putJob({ ...job, enabled, updatedAt: Date.now() })
    return ok(`${enabled ? '已恢复' : '已暂停'} ${arg}`)
  }

  // 新建：/cron <expr> <prompt>
  if (agentCwd === undefined || agentCwd === '') {
    return fail('当前会话没有项目目录（cwd），无法确定任务归属；请先在项目会话里使用 /cron')
  }
  const parts = splitExprAndPrompt(input)
  if (parts === undefined || parts.prompt === '') {
    return fail('用法: /cron <cron表达式> <任务prompt>，例如 /cron "0 9 * * 1-5" 总结项目状态')
  }
  try {
    const cwd = normalizeCwd(agentCwd)
    const job = await createJob(ctx, { cwd, cron: parts.expr, prompt: parts.prompt })
    return ok(`已创建定时任务 ${job.id}「${job.name}」\ncron: ${job.cron}\n目录: ${job.cwd}\n管理: http://127.0.0.1:3080/cron`)
  } catch (error: unknown) {
    return fail(`创建失败: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export const name = 'cron-commands'
export const inject = ['commands', 'cronLoopStore']

export function apply(ctx: Context): void {
  // /cron：Claude Code 风格全局命令
  ctx.commands.register({
    name: 'cron',
    description: '管理当前项目的 cron 定时任务（/cron <expr> <prompt> ｜ list ｜ rm/on/off）',
    async handler(invocation) {
      const cwd = invocation.agent.session.header.cwd
      return handleCron(ctx, cwd, invocation.rawInput)
    },
  })

  // /loop：/cron 新建的别名；无参数 = 列表
  ctx.commands.register({
    name: 'loop',
    description: '为当前项目创建循环定时任务（/loop <cron表达式> <prompt>）；无参数列出已有任务',
    async handler(invocation) {
      const cwd = invocation.agent.session.header.cwd
      const raw = invocation.rawInput.trim()
      if (raw === '') {
        return handleCron(ctx, cwd, 'list')
      }
      return handleCron(ctx, cwd, raw)
    },
  })
}
