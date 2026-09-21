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
import { isCollabSessionKey, type RelayHost } from './relay.js'
import { marshalText } from './board-tools.js'
import type { AgentOutboundMessage } from '../../types.js'
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
  run(): Promise<void>
  stop(): void
}

/** 纯函数：taskLead 的通道 sessionKey 在该 agent 的 sessions 槽里取（通道 key 永不带 task: 前缀）。 */
export function channelSessionKeyOf(agent: AgentConfig): string | undefined {
  if (agent.sessions === undefined) return undefined
  for (const [key] of Object.entries(agent.sessions)) {
    if (!isCollabSessionKey(key)) return key
  }
  return undefined
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
  let stopped = false

  async function run(): Promise<void> {
    stopped = false
    // run() 常驻循环：先扫描状态机，再做一轮活性探针；间隔由调用方停/起。
    while (!stopped) {
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

  async function patrolTask(task: TaskBoard): Promise<void> {
    const now = Date.now()
    const leadCfg = getAgentConfig(task.taskLead)
    const leadSession = leadCfg === undefined ? undefined : channelSessionKeyOf(leadCfg)
    const allDone = task.assignees.length > 0 && task.assignees.every((a) => a.status === 'idle' || a.status === 'failed')
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
        moveTask('running', 'done', task.taskId)
        return
      }
      // 已齐且无待决：不超时，继续综合
    }

    // 待决：叫醒 taskLead（若还 live）。wake 留给那路 FIFO。
    if (task.pendingHuman !== undefined) {
      if (leadCfg !== undefined && leadSession !== undefined) {
        const leadLive = host.agents()?.get(leadSession)
        if (leadLive !== undefined) await followup(leadCfg, leadSession, marshalText(task))
      }
      return
    }

    // 全终态且无待决：叫醒 taskLead 综合
    if (allDone) {
      if (leadCfg !== undefined && leadSession !== undefined) {
        const leadLive = host.agents()?.get(leadSession)
        if (leadLive !== undefined) {
          await followup(leadCfg, leadSession, marshalText(task))
          // 综合这轮若再派→文件保持 running；没再派→下次扫描 allDone 仍未变，
          // 由综合收口（ask 同 FIFO 那路 idle 后）把「已综合待 deliver」转 done。
          // 这里不做二次 followup，避免抢在综合 turn 前面重复叫醒。
        }
      }
      return
    }

    // 未全终态：按 wake 叫醒上游（同一被叫醒方合并）
    if (hadAssignees) {
      const wakers = new Map<string, string[]>()
      for (const a of task.assignees) {
        if (a.status === 'idle' && a.wake && a.dispatchedBy !== '') {
          const list = wakers.get(a.dispatchedBy) ?? []
          list.push(a.expertId)
          wakers.set(a.dispatchedBy, list)
        }
      }
      for (const [by] of wakers) {
        const byCfg = getAgentConfig(by)
        const bySession = byCfg === undefined ? undefined : channelSessionKeyOf(byCfg)
        if (byCfg === undefined || bySession === undefined) continue
        const live = host.agents()?.get(bySession)
        if (live === undefined) continue
        await followup(byCfg, bySession, marshalText(task))
      }
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
    const sessionKey = channelSessionKeyOf(leadCfg)
    if (sessionKey === undefined) return
    const sessionParts = { provider_id: task.providerId, ...task.sessionParts }
    try {
      await host.deliver(task.providerId, sessionParts, messages)
    } catch (err) {
      console.warn(`agent-bot: deliver 失败（文件留在 running/）: ${(err as Error).message}`)
    }
  }

  return { run, stop }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
