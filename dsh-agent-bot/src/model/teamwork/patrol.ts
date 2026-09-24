/**
 * 任务看板巡检（specs/12 §超时分层 / §重启 / §活性探针）。
 * 只做「跟着文件走」的状态机收口：
 *  - 扫描 jobs/running/，按 assignees / pendingHuman / deadlineAt 决定要不要叫醒、问人、综合、deliver、超时。
 *  - 不拦截 ask_user_question（决策链路在 service/ask 层）。
 *  - 不负责入站 ask 绑定（入站由 ask 流程调 bindInbound 落 binding）。
 * 依赖注入：agentRuntime（ensureAgent / identityFor / hostAgents）、deliver 通道、taskLead 通道 sessionKey 解析。
 */
import type { AgentLike } from '../runtime.js'
import { getAgent as getAgentConfig } from '../agents.js'
import { listTasksIn, writeTask, moveTask, type TaskBoard, type Assignee } from './task-board.js'
import { boundTaskId, unbindSession } from './binding.js'
import type { RelayHost } from './relay.js'
import { marshalText } from './board-tools.js'
import { encodeSessionKey, sessionPartsForEncode, type AgentOutboundMessage } from '../../types.js'
import { waitIdleOrTimeout } from '../ask.js'
import { loadConfig, type AgentConfig } from '../config.js'

export interface PatrolHost extends RelayHost {
  /** 路由到对应通道 provider 的 deliver（无则打日志）。 */
  deliver(providerId: string, sessionParts: Record<string, string>, messages: AgentOutboundMessage[]): Promise<void>
}

export interface PatrolOptions {
  /** 活性探针每轮等待窗口（缺省用专家 agent_wait_timeout_ms，0 fallback 全局）。 */
  windowMs?: number
  /** 专家续期上限（缺省用全局 expert_liveness_max_renew）。 */
  maxRenew?: number
  /** 任务墙钟（缺省用全局 task_round_timeout_ms）。 */
  roundTimeoutMs?: number
  /** 专家已 idle 但 wake 未消费时的收口等待（超时则按失败处理）。 */
  idleCollectMs?: number
  /** run() 每轮间隔。缺省 200。 */
  intervalMs?: number
}

export interface Patrol {
  /** 常驻循环（service 用）。 */
  run(): Promise<void>
  /** 跑一轮：先扫状态机、再做一轮活性探针。测试用；run() 内部也调它。 */
  tickOnce(): Promise<void>
  stop(): void
}

/** 终态：不再需要等它（idle=干完了 / failed=废了）。 */
function isTerminal(a: Assignee): boolean {
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
  try {
    const parts = sessionPartsForEncode(task.sessionParts, task.sender, cfg.session_by_sender)
    const slot = cfg.sessions[encodeSessionKey(parts)]
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

interface ProbeState {
  renew: number
  sessionId: string
  waiting: boolean
}

/**
 * 创建巡检器。run() 循环扫描 + 活性探针；stop() 中断循环。
 * 每份 running 文件独立处理：失败只打日志不中断其它文件。
 *
 * 状态迁移（每份文件）：
 *  - 墙钟超时（见 §超时分层）
 *  - 待决 → 叫醒 taskLead
 *  - 未齐 → 按 wake 叫醒上游 + 跑活性探针
 *  - 全终态且无待决 → 叫醒 taskLead 综合
 */
export function createPatrol(host: PatrolHost, options: PatrolOptions = {}): Patrol {
  const intervalMs = options.intervalMs ?? 200
  const probeRenew = new Map<string, ProbeState>() // `taskId\0expertId` -> 续期状态
  const notified = new Map<string, string>() // `taskId\0agentId` -> 已叫醒时的完成情况指纹
  let stopped = false

  /** 跑一轮：先扫状态机，再做一轮活性探针。run() 与测试共用。 */
  async function tickOnce(): Promise<void> {
    const running = listTasksIn('running')
    for (const task of running) {
      try {
        await patrolTask(task)
      } catch (err) {
        console.warn(`agent-bot: 巡检任务 ${task.taskId} 失败: ${(err as Error).message}`)
      }
    }
    for (const task of running) {
      try {
        await probeTask(task)
      } catch (err) {
        console.warn(`agent-bot: 活性探针任务 ${task.taskId} 失败: ${(err as Error).message}`)
      }
    }
  }

  async function run(): Promise<void> {
    stopped = false
    // run() 常驻循环：一轮一轮跑 tickOnce；间隔由调用方停/起。
    while (!stopped) {
      await tickOnce()
      if (stopped) return
      await delay(intervalMs)
    }
  }

  function stop(): void {
    stopped = true
  }

  function windowFor(agent: AgentConfig): number {
    if (options.windowMs !== undefined && options.windowMs > 0) return options.windowMs
    // 专家 agent_wait_timeout_ms；`0` fallback 全局
    const a = agent.agent_wait_timeout_ms
    if (a === undefined) return loadConfig().agent_wait_timeout_ms
    if (a === 0) return loadConfig().agent_wait_timeout_ms
    return a
  }

  function maxRenew(): number {
    return options.maxRenew ?? loadConfig().expert_liveness_max_renew
  }

  /** 任务墙钟。 */
  function roundTimeoutMs(): number {
    return options.roundTimeoutMs ?? loadConfig().task_round_timeout_ms
  }

  /**
   * 去重叫醒：同一「完成情况指纹」只叫一次。返回是否真的叫到了。
   * 巡检每轮都扫同一份文件，没有这层就会对同一个人反复灌 followup。
   * 指纹存内存：进程重启后按 §重启 补叫一次，正是想要的恢复行为。
   */
  async function wakeOnce(task: TaskBoard, agentId: string, fingerprint: string, text: string): Promise<boolean> {
    const key = `${task.taskId}\0${agentId}`
    if (notified.get(key) === fingerprint) return false
    const cfg = getAgentConfig(agentId)
    if (cfg === undefined) return false
    const sessionId = wakeSessionIdFor(task, agentId)
    if (sessionId === undefined) return false // 定位不到会话：跳过，等下一轮/下次 @
    if (host.agents()?.get(sessionId) === undefined) return false // 不在线：等活性探针拉起
    await followup(cfg, sessionId, text)
    notified.set(key, fingerprint)
    return true
  }

  /** 终态 assignees 的 `expertId:status` 指纹（排序后稳定）。 */
  function terminalFingerprint(list: readonly Assignee[]): string {
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
  function wakeFingerprint(task: TaskBoard, agentId: string): string {
    if (agentId === task.taskLead) return `done:${terminalFingerprint(task.assignees)}`
    return `kids:${terminalFingerprint(task.assignees.filter((a) => a.dispatchedBy === agentId))}`
  }

  async function patrolTask(task: TaskBoard): Promise<void> {
    const now = Date.now()
    const allDone = task.assignees.length > 0 && task.assignees.every(isTerminal)
    const hadAssignees = task.assignees.length > 0

    // 墙钟到点：只动这一份文件
    if (task.deadlineAt > 0 && now >= task.deadlineAt) {
      const pending = task.pendingHuman !== undefined
      const stillRunning = task.assignees.some((a) => a.status === 'running' || a.status === 'waiting')
      if (stillRunning && pending) {
        // 问卷超时未答且还在跑：只作废待决，不整单超时
        task.pendingHuman = undefined
        writeTask('running', task)
      } else if (stillRunning || pending) {
        // 整单超时（还在跑无人待决 / 待决但无人在跑）
        await deliverWithLead(task, [{ kind: 'markdown', text: '处理超时', url: '', atUserIds: [], atAll: false }])
        unbindDone(task)
        moveTask('running', 'done', task.taskId)
        return
      }
      // 已齐且无待决：不超时，继续综合
    }

    // 待决：叫醒 taskLead 拍板（只叫一次；人回填后 pendingHuman 清掉、指纹变了才会再叫）
    if (task.pendingHuman !== undefined) {
      await wakeOnce(task, task.taskLead, `pending:${task.pendingHuman.askedAt}`, marshalText(task))
      return
    }

    // 未上报的终态：先逐层上报给 dispatchedBy（一轮只上报一层，且上报后消费 wake）
    if (hadAssignees) {
      const pending = task.assignees.filter(
        (a) => a.wake && isTerminal(a) && a.dispatchedBy !== '' && !hasPendingDownstream(task, a.expertId),
      )
      if (pending.length > 0) {
        const wakers = new Map<string, Assignee[]>()
        for (const a of pending) {
          const list = wakers.get(a.dispatchedBy) ?? []
          list.push(a)
          wakers.set(a.dispatchedBy, list)
        }
        const consumed: Assignee[] = []
        for (const [by, kids] of wakers) {
          const done = await wakeOnce(task, by, wakeFingerprint(task, by), wakeText(task, kids))
          if (done) consumed.push(...kids)
        }
        // 上报成功才消费 wake；目标不在线则留着，下一轮重试
        if (consumed.length > 0) {
          for (const a of consumed) a.wake = false
          writeTask('running', task)
        }
        return
      }
    }

    // 全终态且无待上报：叫醒 taskLead 综合（与上一分支共用同一指纹，天然去重）
    if (allDone) {
      await wakeOnce(task, task.taskLead, wakeFingerprint(task, task.taskLead), marshalText(task))
    }
  }

  /**
   * 活性探针：对 running/waiting 的 assignee 做一轮 waitIdleOrTimeout(W)。
   * 一轮一次 wait，避免 run() 循环被单份卡死；续期计数在内存里跨轮累积。
   * ——写进 md（status/收口文本）这一层交回普通巡逻（下轮 scan 收敛），本函数只管「该不该重启」。
   */
  async function probeTask(task: TaskBoard): Promise<void> {
    for (const a of task.assignees) {
      if (a.status !== 'running') continue
      const cfg = getAgentConfig(a.expertId)
      if (cfg === undefined) continue
      const key = `${task.taskId}\0${a.expertId}`
      let st = probeRenew.get(key)
      if (st === undefined || st.sessionId !== a.sessionId) {
        st = { renew: 0, sessionId: a.sessionId, waiting: false }
        probeRenew.set(key, st)
      }
      if (st.waiting) continue // 已在等，下一轮再看
      const live = host.agents()?.get(a.sessionId) as AgentLike | undefined
      if (live === undefined) {
        // 挂/没拉起：算一次续期来重启。这里交给下次 scan：把 status 先回转 running，
        // 由 scan 判定未齐逻辑；真正重启在 ensureAgent+followup（下走 followup 帮助函数）。
        st.waiting = true
        continue // 避免本轮 rush（重启由 scan 的 idle/wake 分支触发）
      }
      st.waiting = true
      const W = windowFor(cfg)
      const wait = await waitIdleOrTimeout(live.whenIdle(), W)
      st.waiting = false
      if (wait === 'idle') {
        // idle：记 status=idle（收口文本已在吧；这里只转态，下一轮 scan 做 wake 叫醒/综合）
        if (a.status === 'running') {
          a.status = 'idle'
          writeTask('running', task)
        }
        probeRenew.delete(key)
        continue
      }
      // 超时（窗口内没 idle）：还 live → renew++；否则重启再跑
      st.renew++
      if (host.agents()?.get(a.sessionId) === undefined) {
        // 已挂：重启（ensureAgent + followup 上次未完成 + 原 instruction + md）
        if (st.renew >= maxRenew()) {
          a.status = 'failed'
          writeTask('running', task)
          probeRenew.delete(key)
          continue
        }
        await restartExpert(task, cfg, a)
        st.sessionId = a.sessionId // restartExpert 可能换 session（ensureAgent 兜底是同一 sessionId）
        continue
      }
      if (st.renew >= maxRenew()) {
        a.status = 'failed'
        writeTask('running', task)
        probeRenew.delete(key)
        continue
      }
      // 还 live 且未耗尽：重新等（留待下轮）
    }
  }

  async function restartExpert(task: TaskBoard, cfg: AgentConfig, a: Assignee): Promise<void> {
    try {
      await host.ensureAgent({
        sessionId: a.sessionId,
        cwd: cfg.workspace,
        agentId: cfg.id,
        agentName: cfg.name,
        promptText: '',
        variables: {},
        permissionMode: cfg.permission_mode,
      })
      const live = host.agents()?.get(a.sessionId) as AgentLike | undefined
      if (live === undefined) return
      live.followup({
        id: `agent-bot-livenew-${Date.now()}`,
        role: 'user',
        content: [{ type: 'text', text: marshalText(task) }],
        source: { kind: 'user' },
      })
    } catch (err) {
      console.warn(`agent-bot: 重启专家 ${a.expertId} 失败: ${(err as Error).message}`)
    }
  }

  async function followup(agent: AgentConfig, sessionId: string, text: string): Promise<void> {
    try {
      await host.ensureAgent({
        sessionId,
        cwd: agent.workspace,
        agentId: agent.id,
        agentName: agent.name,
        promptText: '',
        variables: {},
        permissionMode: agent.permission_mode,
      })
      const live = host.agents()?.get(sessionId) as AgentLike | undefined
      if (live === undefined) return
      live.followup({
        id: `agent-bot-patrol-${Date.now()}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      })
    } catch (err) {
      console.warn(`agent-bot: 巡检叫醒 ${agent.id} 失败: ${(err as Error).message}`)
    }
  }

  async function deliverWithLead(task: TaskBoard, messages: AgentOutboundMessage[]): Promise<void> {
    const leadCfg = getAgentConfig(task.taskLead)
    if (leadCfg === undefined) return
    // 没有可定位的通道槽（人没 @ 过这个 lead）→ 收了也没处发
    if (wakeSessionIdFor(task, task.taskLead) === undefined) return
    const sessionParts = { provider_id: task.providerId, ...task.sessionParts }
    try {
      await host.deliver(task.providerId, sessionParts, messages)
    } catch (err) {
      console.warn(`agent-bot: deliver 失败（文件留在 running/）: ${(err as Error).message}`)
    }
  }

  /** 任务收口（移进 done/）时解绑本单各路的会话，避免之后调工具报「已绑的任务不在 running/」。 */
  function unbindDone(task: TaskBoard): void {
    for (const a of task.assignees) {
      if (a.sessionId !== '' && boundTaskId(a.sessionId) === task.taskId) unbindSession(a.sessionId)
    }
    const leadSessionId = wakeSessionIdFor(task, task.taskLead)
    if (leadSessionId !== undefined && boundTaskId(leadSessionId) === task.taskId) unbindSession(leadSessionId)
  }

  return { run, tickOnce, stop }
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
