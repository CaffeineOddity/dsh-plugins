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
import { listTasksIn, readTask, writeTask, moveTask, type TaskBoard, type Assignee } from './task-board.js'
import { boundTaskId, listBindings, unbindSession } from './binding.js'
import type { RelayHost } from './relay.js'
import { marshalText } from './board-tools.js'
import { encodeSessionKey, sessionPartsForEncode, type AgentOutboundMessage } from '../../types.js'
import { summarizeOwnedInterval, toMarkdownMessages, waitIdleOrTimeout } from '../ask.js'
import { loadConfig, type AgentConfig } from '../config.js'

export interface PatrolHost extends RelayHost {
  /** 路由到对应通道 provider 的 deliver（无则打日志）。 */
  deliver(providerId: string, sessionParts: Record<string, string>, messages: AgentOutboundMessage[]): Promise<void>
}

/** 解绑清理的最小间隔（ms）：任务被人挪走后不必每轮查。 */
const RECONCILE_MS = 5_000

export interface PatrolOptions {
  /** 活性探针每轮等待窗口（缺省用专家 agent_wait_timeout_ms，0 fallback 全局）。 */
  windowMs?: number
  /** 专家续期上限（缺省用全局 expert_liveness_max_renew）。 */
  maxRenew?: number
  /** 任务墙钟（缺省用全局 task_round_timeout_ms）。 */
  roundTimeoutMs?: number
  /** 专家已 idle 但 wake 未消费时的收口等待（超时则按失败处理）。 */
  idleCollectMs?: number
}

export interface Patrol {
  /**
   * 启动：**一次性**扫一遍 `running/`（补上报 + 重建墙钟定时器）。不再有周期轮询。
   */
  start(): Promise<void>
  /** 跑一轮：先扫状态机、再做一轮活性探针。测试用；run() 内部也调它。 */
  tickOnce(): Promise<void>
  /** 等所有在跑的收口交付落地（测试用）。 */
  flush(): Promise<void>
  /**
   * 事件入口：某个会话刚变为 idle（或外部要求复核）→ 转态并立即处理这一单。
   * 这是「专家做完就通知」的快路径；低频轮询只做兜底。
   */
  reconcile(sessionId: string): Promise<void>
  /** 事件入口：会话被销毁（`agent/disposed`）→ 重启或判死那一路。 */
  handleDisposed(sessionId: string): Promise<void>
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
  /** 首次发现该会话不在线的时间（0=在线）。用来「挂够一个窗口」才算一次续期。 */
  missingSince: number
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
  const probeRenew = new Map<string, ProbeState>() // `taskId\0expertId` -> 续期状态
  const notified = new Map<string, string>() // `taskId\0agentId` -> 已叫醒时的完成情况指纹
  const delivering = new Map<string, Promise<void>>() // taskId -> 在跑的收口交付（同任务只跑一次）
  const deadlineTimers = new Map<string, ReturnType<typeof setTimeout>>() // taskId -> 墙钟定时器
  const lastScheduledDeadline = new Map<string, number>() // taskId -> 已排的 deadlineAt（避免重复排）
  let lastReconcileAt = 0
  let stopped = false

  /**
   * 收口清理：任务文件被人挪走（进了 done/ 或手工 cancel/）后，把还指向它的会话解绑，
   * 否则那些会话之后调看板工具会报「已绑的任务不在 running/」。低频做，不必每轮。
   */
  function reconcileBindings(): void {
    const now = Date.now()
    if (now - lastReconcileAt < RECONCILE_MS) return
    lastReconcileAt = now
    try {
      for (const { sessionId, taskId } of listBindings()) {
        if (readTask('running', taskId) === undefined) unbindSession(sessionId)
      }
    } catch (err) {
      console.warn(`agent-bot: 解绑清理失败: ${(err as Error).message}`)
    }
  }

  /** 等所有在跑的收口交付落地（测试用；也让调用方能确定性收尾）。 */
  async function flush(): Promise<void> {
    await Promise.allSettled([...delivering.values()])
  }

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
    reconcileBindings()
  }

  /**
   * 启动补扫（替代原周期轮询）：扫一遍 `running/` 处理「订阅生效前已完成的工作」，
   * 并为每份任务重建墙钟定时器。之后完全由事件驱动（agent/status / agent/disposed）。
   */
  async function start(): Promise<void> {
    stopped = false
    await tickOnce()
    for (const task of listTasksIn('running')) scheduleDeadline(task)
  }

  /** 墙钟定时器：每份任务一个，到点触发一次（不再靠轮询比较 deadlineAt）。 */
  function scheduleDeadline(task: TaskBoard): void {
    clearDeadline(task.taskId)
    if (task.deadlineAt <= 0 || stopped) return
    const ms = Math.max(0, task.deadlineAt - Date.now())
    const timer = setTimeout(() => {
      deadlineTimers.delete(task.taskId)
      void onDeadline(task.taskId)
    }, ms)
    deadlineTimers.set(task.taskId, timer)
    lastScheduledDeadline.set(task.taskId, task.deadlineAt)
  }

  function clearDeadline(taskId: string): void {
    const timer = deadlineTimers.get(taskId)
    if (timer !== undefined) {
      clearTimeout(timer)
      deadlineTimers.delete(taskId)
    }
    lastScheduledDeadline.delete(taskId)
  }

  /** 到点：处理这一单；若顺延了墙钟，重排定时器。 */
  async function onDeadline(taskId: string): Promise<void> {
    if (stopped) return
    const task = readTask('running', taskId)
    if (task === undefined) {
      clearDeadline(taskId)
      return
    }
    try {
      await patrolTask(task)
      await probeTask(task)
    } catch (err) {
      console.warn(`agent-bot: 墙钟到点处理 ${taskId} 失败: ${(err as Error).message}`)
    }
    const after = readTask('running', taskId)
    if (after === undefined) clearDeadline(taskId)
    else scheduleDeadline(after)
  }

  /** 任务状态变过之后同步定时器：还在 running 就重排，否则清掉。 */
  function syncDeadline(taskId: string): void {
    const task = readTask('running', taskId)
    if (task === undefined) clearDeadline(taskId)
    else if (task.deadlineAt !== lastScheduledDeadline.get(taskId)) scheduleDeadline(task)
  }

  function stop(): void {
    stopped = true
    for (const taskId of [...deadlineTimers.keys()]) clearDeadline(taskId)
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

  /** 该 assignee 的会话是否还活着（在跑）。 */
  function agentAlive(a: Assignee): boolean {
    return a.sessionId !== '' && host.agents()?.get(a.sessionId) !== undefined
  }

  /** 顺延墙钟：deadlineAt 推到「现在 + 一个墙钟」。 */
  function deferDeadline(task: TaskBoard): void {
    task.deadlineAt = Date.now() + roundTimeoutMs()
    writeTask('running', task)
    scheduleDeadline(task)
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

    // 墙钟到点：不一律判死，先分析各专家会话状态（specs/12 §超时分层）
    if (task.deadlineAt > 0 && now >= task.deadlineAt) {
      const pending = task.pendingHuman !== undefined
      const unfinished = task.assignees.filter((a) => !isTerminal(a))
      const someoneAlive = unfinished.some(agentAlive)

      if (allDone && !pending) {
        // ① 都做完了没综合 → 就走下面的正常收口（不是超时）
      } else if (someoneAlive) {
        // ② 还有人活着在做 → 顺延，只给进度反馈（同一 deadlineAt 指纹去重，不刷屏）
        await notifyProgress(task, unfinished)
        deferDeadline(task)
        return
      } else if (pending) {
        // ⑥ 有问卷但没人在跑 → 交回给人拍板，留在 running/ 等人
        await askHumanToDecide(task, '还有问题等你确认')
        deferDeadline(task)
        return
      } else if (unfinished.length > 0) {
        // ③ 没人在跑也没终态：先尝试救活（超时/网络一类）
        const revived = await reviveDead(task, unfinished)
        if (revived) {
          await notifyProgress(task, unfinished)
          deferDeadline(task)
          return
        }
        // ④ 救不动（含权限/审批/需拍板）→ 交回给人，留在 running/
        await askHumanToDecide(task, '有专家卡住、需要你确认后才能继续')
        deferDeadline(task)
        return
      }
      // ⑤ 无 assignee 也无待决：无事可做，继续走收口判定
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
      // 全终态时，报给 taskLead 的那一路本身就是「综合」——不能走普通上报，
      // 否则综合那次会被同一指纹去重掉（上报已记过），结果永远不交付。
      const toLead = allDone ? pending.filter((a) => a.dispatchedBy === task.taskLead) : []
      const plain = allDone ? pending.filter((a) => a.dispatchedBy !== task.taskLead) : pending
      if (toLead.length > 0 && plain.length === 0) {
        if (!delivering.has(task.taskId)) {
          const job = summarizeAndDeliver(task, toLead).finally(() => delivering.delete(task.taskId))
          delivering.set(task.taskId, job)
        }
        return
      }
      if (plain.length > 0) {
        const wakers = new Map<string, Assignee[]>()
        for (const a of plain) {
          const list = wakers.get(a.dispatchedBy) ?? []
          list.push(a)
          wakers.set(a.dispatchedBy, list)
        }
        const consumed: Assignee[] = []
        for (const [by, kids] of wakers) {
          // 被叫醒的中间层若正 `waiting`（在等下游）→ 恢复 `running`：它要接着做自己的活
          const resumed = resumeWaiting(task, by)
          const done = await wakeOnce(task, by, wakeFingerprint(task, by), wakeText(task, kids))
          if (done) consumed.push(...kids)
          if (resumed && !done) writeTask('running', task)
        }
        // 上报成功才消费 wake；目标不在线则留着，下一轮重试
        if (consumed.length > 0) {
          for (const a of consumed) a.wake = false
          writeTask('running', task)
        }
        return
      }
    }

    // 全终态且无待上报：叫醒 taskLead 综合 → 取它这一轮的产出交付回群 → done/
    if (allDone && !delivering.has(task.taskId)) {
      const running = summarizeAndDeliver(task).finally(() => delivering.delete(task.taskId))
      delivering.set(task.taskId, running)
    }
  }

  /** 把等待下游的中间层恢复成 running（它被叫醒、开始干活了）。返回是否改了。 */
  function resumeWaiting(task: TaskBoard, agentId: string): boolean {
    const self = task.assignees.find((a) => a.expertId === agentId)
    if (self === undefined || self.status !== 'waiting') return false
    self.status = 'running'
    return true
  }

  /**
   * 收口交付（specs/12 §谁改状态）：叫醒 taskLead 综合 → 等它这一轮结束 → 取产出 `deliver` @sender
   * → 若没再派活、也没待决 → 移 `done/` + 解绑。
   *
   * 后台跑（不阻塞巡检循环）；同一任务同一时刻只跑一次（delivering 集合）。
   */
  async function summarizeAndDeliver(task: TaskBoard, leadBound: readonly Assignee[] = []): Promise<void> {
    const cfg = getAgentConfig(task.taskLead)
    const sessionId = wakeSessionIdFor(task, task.taskLead)
    if (cfg === undefined || sessionId === undefined) return
    const live = host.agents()?.get(sessionId) as (AgentLike & { session: { seq: number; snapshotEvents(): Array<{ seq: number; type: string; data?: unknown }> } }) | undefined
    if (live === undefined) return
    try {
      const firstSeq = live.session.seq
      const ok = await wakeOnce(task, task.taskLead, wakeFingerprint(task, task.taskLead), marshalText(task))
      if (!ok) return
      // 综合已开始：消费报给 lead 的 wake，后续要靠新的终态变化才会再触发
      if (leadBound.length > 0) {
        for (const a of leadBound) a.wake = false
        const cur = readTask('running', task.taskId)
        if (cur !== undefined) {
          for (const a of cur.assignees) if (leadBound.some((x) => x.expertId === a.expertId)) a.wake = false
          writeTask('running', cur)
        }
      }
      const wait = await waitIdleOrTimeout(live.whenIdle(), windowFor(cfg))
      if (wait !== 'idle') return // 综合还没完：下轮再来
      const text = summarizeOwnedInterval(live.session.snapshotEvents(), firstSeq)
      // 重新读盘：综合这一轮里它可能又派了活 / 写了正文
      const fresh = readTask('running', task.taskId)
      if (fresh === undefined) return // 人已挪走（done/ 或 cancel/）
      await deliverToSender(fresh, toMarkdownMessages(text).map((m) => m.text).join('\n\n') || '（综合无输出）')
      const stillOpen = fresh.assignees.some((a) => !isTerminal(a)) || fresh.pendingHuman !== undefined
      if (stillOpen) return // 又派了活 / 又问了人：保持 running
      unbindDone(fresh)
      // 期间可能已被人挪走（cancel/ 或 done/）：那就别再 move
      if (readTask('running', fresh.taskId) !== undefined) moveTask('running', 'done', fresh.taskId)
      clearDeadline(fresh.taskId)
    } catch (err) {
      console.warn(`agent-bot: 收口交付 ${task.taskId} 失败（文件留在 running/）: ${(err as Error).message}`)
    }
  }

  /** 进度反馈：给原发送者发一条「还在做」，同一 deadlineAt 只发一次（不刷屏）。 */
  async function notifyProgress(task: TaskBoard, unfinished: readonly Assignee[]): Promise<void> {
    const names = unfinished.map((a) => (a.expertName === '' ? a.expertId : a.expertName))
    const fingerprint = `progress:${task.deadlineAt}:${names.join(',')}`
    const key = `${task.taskId}\0__human__`
    if (notified.get(key) === fingerprint) return
    const ok = await deliverToSender(task, `还在做：${names.join('、')}。做完我会回来答复。`)
    if (ok) notified.set(key, fingerprint)
  }

  /** 交回给人拍板：deliver 一条「需要你确认」，任务留在 running/ 等人（可答、可挪 cancel/）。 */
  async function askHumanToDecide(task: TaskBoard, reason: string): Promise<void> {
    const fingerprint = `decide:${task.deadlineAt}`
    const key = `${task.taskId}\0__human__`
    if (notified.get(key) === fingerprint) return
    const tail = task.body.trim() === '' ? '' : `\n\n当前进展：\n${task.body.trim().slice(-300)}`
    const ok = await deliverToSender(task, `需要你确认后才能继续：${reason}。${tail}\n\n（回一句 @${task.taskLead} 或直接答复即可；不想做了可把任务文件挪到 jobs/cancel/）`)
    if (ok) notified.set(key, fingerprint)
  }

  /** 救活：对没终态又没会话的 assignee 重新 ensureAgent + 重发 md。返回是否救活了至少一个。 */
  async function reviveDead(task: TaskBoard, unfinished: readonly Assignee[]): Promise<boolean> {
    let revived = false
    for (const a of unfinished) {
      if (a.status === 'failed') continue // 已判死：不反复救，交给交回给人那一支
      if (agentAlive(a)) continue
      const cfg = getAgentConfig(a.expertId)
      if (cfg === undefined) continue
      await restartExpert(task, cfg, a)
      if (a.status === 'waiting') {
        a.status = 'running' // 重新投入
        writeTask('running', task)
      }
      revived = true
    }
    return revived
  }

  /** 发一条给人（原发送者所在的会话/群）。返回是否真发出去了。 */
  async function deliverToSender(task: TaskBoard, text: string): Promise<boolean> {
    const sessionParts = { provider_id: task.providerId, ...task.sessionParts }
    try {
      await host.deliver(task.providerId, sessionParts, [
        { kind: 'markdown', text, url: '', atUserIds: task.sender === '' ? [] : [task.sender], atAll: false },
      ])
      return true
    } catch (err) {
      console.warn(`agent-bot: deliver 失败（文件留在 running/）: ${(err as Error).message}`)
      return false
    }
  }

  /**
   * 活性探针：对 running/waiting 的 assignee 做一轮 waitIdleOrTimeout(W)。
   * 一轮一次 wait，避免 run() 循环被单份卡死；续期计数在内存里跨轮累积。
   * ——写进 md（status/收口文本）这一层交回普通巡逻（下轮 scan 收敛），本函数只管「该不该重启」。
   */
  /**
   * 活性探针（非阻塞）：不再 await whenIdle。
   *  - 会话已 idle（读到 agent.status，或事件已转态）→ 转 status=idle，交给上报链
   *  - 会话没了 → 续期计数；耗尽判 failed，否则重启重发
   *  - 还在跑 → 什么都不做（做完会有 agent/status 事件通知）
   */
  async function probeTask(task: TaskBoard): Promise<void> {
    // 同一轮里前面可能已把这份任务收口移走（done/ 或人手工挪走）→ 别再用旧快照写回去复活它
    if (readTask('running', task.taskId) === undefined) return
    for (const a of task.assignees) {
      if (a.status !== 'running') continue
      const cfg = getAgentConfig(a.expertId)
      if (cfg === undefined) continue
      const key = `${task.taskId}\0${a.expertId}`
      let st = probeRenew.get(key)
      if (st === undefined || st.sessionId !== a.sessionId) {
        st = { renew: 0, sessionId: a.sessionId, missingSince: 0 }
        probeRenew.set(key, st)
      }
      const live = host.agents()?.get(a.sessionId) as AgentLike | undefined
      if (live === undefined) {
        // 非阻塞版：挂够一个窗口（W）才算一次续期，避免轮询变快后几秒内就把专家判死
        const nowMs = Date.now()
        if (st.missingSince === 0) {
          st.missingSince = nowMs
          continue
        }
        if (nowMs - st.missingSince < windowFor(cfg)) continue
        st.missingSince = nowMs
        st.renew++
        if (st.renew >= maxRenew()) {
          a.status = 'failed'
          if (readTask('running', task.taskId) !== undefined) writeTask('running', task)
          probeRenew.delete(key)
          continue
        }
        await restartExpert(task, cfg, a)
        continue
      }
      st.missingSince = 0
      // 会话在且已 idle → 转态（漏掉事件时的兜底；快路径由 reconcile 处理）
      if (live.status === 'idle') {
        st.renew = 0
        a.status = 'idle'
        if (readTask('running', task.taskId) !== undefined) writeTask('running', task)
        continue
      }
      // 还在跑：不阻塞、不计数
      st.renew = 0
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


  /** 任务收口（移进 done/）时解绑本单各路的会话，避免之后调工具报「已绑的任务不在 running/」。 */
  function unbindDone(task: TaskBoard): void {
    for (const a of task.assignees) {
      if (a.sessionId !== '' && boundTaskId(a.sessionId) === task.taskId) unbindSession(a.sessionId)
    }
    const leadSessionId = wakeSessionIdFor(task, task.taskLead)
    if (leadSessionId !== undefined && boundTaskId(leadSessionId) === task.taskId) unbindSession(leadSessionId)
  }

  /**
   * 事件入口：某会话被销毁（`agent/disposed`）→ 它那一路要么重启、要么判死。
   * 替代原来轮询里的「会话缺失」分支。
   */
  async function handleDisposed(sessionId: string): Promise<void> {
    if (sessionId === '' || stopped) return
    for (const task of listTasksIn('running')) {
      const a = task.assignees.find((x) => x.sessionId === sessionId && x.status === 'running')
      if (a === undefined) continue
      const cfg = getAgentConfig(a.expertId)
      if (cfg === undefined) continue
      const key = `${task.taskId}\0${a.expertId}`
      const st = probeRenew.get(key) ?? { renew: 0, sessionId, missingSince: 0 }
      st.renew++
      if (st.renew >= maxRenew()) {
        a.status = 'failed'
        probeRenew.delete(key)
      } else {
        probeRenew.set(key, st)
        await restartExpert(task, cfg, a)
        continue
      }
      if (readTask('running', task.taskId) !== undefined) writeTask('running', task)
      await patrolTask(task)
    }
  }

  /** 事件入口：把该会话对应的 assignee 转 idle，并立刻处理这一单。 */
  async function reconcile(sessionId: string): Promise<void> {
    if (sessionId === '') return
    const taskId = boundTaskId(sessionId)
    const targets = taskId === undefined
      ? listTasksIn('running').filter((t) => t.assignees.some((a) => a.sessionId === sessionId))
      : listTasksIn('running').filter((t) => t.taskId === taskId)
    for (const task of targets) {
      try {
        let changed = false
        for (const a of task.assignees) {
          if (a.sessionId === sessionId && a.status === 'running') {
            a.status = 'idle'
            changed = true
          }
        }
        if (changed && readTask('running', task.taskId) !== undefined) writeTask('running', task)
        await patrolTask(task)
        await probeTask(task)
        syncDeadline(task.taskId)
      } catch (err) {
        console.warn(`agent-bot: 事件复核 ${task.taskId} 失败: ${(err as Error).message}`)
      }
    }
    reconcileBindings()
  }

  return { start, tickOnce, flush, reconcile, handleDisposed, stop }
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

