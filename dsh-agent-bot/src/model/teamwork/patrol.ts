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
import { buildRelay, resolveFenceDir, taskSlotKey, type RelayHost } from './relay.js'
import { marshalText } from './board-tools.js'
import { encodeSessionKey, sessionPartsForEncode, type AgentOutboundMessage } from '../../types.js'
import { summarizeOwnedInterval, toMarkdownMessages, waitIdleOrTimeout } from '../ask.js'
import { loadConfig, type AgentConfig } from '../config.js'
import { hasPendingDownstream, isTerminal, terminalFingerprint, wakeFingerprint, wakeSessionIdFor, wakeText } from './wake.js'
import { ASK_TOOL_NAME, openAskCalls, openApprovals, parseAskQuestions } from './intercept.js'
import { advanceWriteQueue, isWaitingForLock, releaseAndAdvance, resumeWaiting } from './fence.js'
import { agentAlive, ensureLive, followup, restartExpert, reviveDead } from './liveness.js'
import { deliverToSender, hasEventsAfter, notifyApprovalWait, notifyProgress } from './deliver.js'

export interface PatrolHost extends RelayHost {
  /** 路由到对应通道 provider 的 deliver（无则打日志）。 */
  deliver(providerId: string, sessionParts: Record<string, string>, messages: AgentOutboundMessage[]): Promise<void>
}

/** 交给网页 answerer 的宽限期（ms）：过了还挂着就取消回合、改由人在 IM 回答。 */
const DEFAULT_ASK_HANDOFF_GRACE_MS = 10_000

/** 解绑清理的最小间隔（ms）：任务被人挪走后不必每轮查。 */
const RECONCILE_MS = 5_000

export interface PatrolOptions {
  /** 活性探针每轮等待窗口（缺省用专家 agent_wait_timeout_ms，0 fallback 全局）。 */
  windowMs?: number
  /** 专家续期上限（缺省用全局 expert_liveness_max_renew）。 */
  maxRenew?: number
  /** 任务墙钟（缺省用全局 task_round_timeout_ms）。 */
  roundTimeoutMs?: number
  /** ask_user_question 转交人的宽限期（ms）。缺省 10s。 */
  askHandoffGraceMs?: number
  /** 收口投递最多重试几次（缺省 5）；超了就把文本落进 md 正文并停止重投。 */
  deliverMaxAttempts?: number
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
  // 共享 write 栅栏（进程级）：推进队列时要和 board-tools 用同一把锁
  const relay = buildRelay({ ensureAgent: host.ensureAgent, agents: host.agents })
  const notified = new Map<string, string>() // `taskId\0agentId` -> 已叫醒时的完成情况指纹
  const delivering = new Map<string, Promise<void>>() // taskId -> 在跑的收口交付（同任务只跑一次）
  const deciding = new Map<string, Promise<void>>() // taskId -> 在等 taskLead 拍板的 job
  const askTimers = new Map<string, ReturnType<typeof setTimeout>>() // `taskId\0expertId` -> 转交人的宽限定时器
  /** 综合进行中：taskId → 综合轮的起点事件序号。text/attempts 已落盘 `task.deliverText`/`deliverAttempts`。 */
  const synthesizing = new Map<string, number>()
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
    await Promise.allSettled([...delivering.values(), ...deciding.values()])
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
    for (const t of askTimers.values()) clearTimeout(t)
    askTimers.clear()
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

  /** 检测到挂起的 ask_user_question → 宽限期后转交给人（IM 任务才接管）。 */
  function watchAskUserQuestion(task: TaskBoard, a: Assignee, live: AgentLike, open: readonly { callId: string }[]): void {
    const key = `${task.taskId}\0${a.expertId}`
    if (task.providerId === 'local' || open.length === 0) {
      const t = askTimers.get(key)
      if (t !== undefined) {
        clearTimeout(t)
        askTimers.delete(key)
      }
      return
    }
    if (askTimers.has(key)) return
    const grace = options.askHandoffGraceMs ?? DEFAULT_ASK_HANDOFF_GRACE_MS
    const timer = setTimeout(() => {
      askTimers.delete(key)
      void handOffAskToHuman(task.taskId, a.expertId, open.map((o) => o.callId))
    }, grace)
    askTimers.set(key, timer)
  }

  /**
   * 把内置问卷转交给人（specs/12 §决策链路）：
   *  1. **取消那一轮** —— 否则会话被这个 tool call 占着，人的 IM 回复永远排队进不来（死锁）
   *  2. 写 `pendingHuman{toHuman:true}` + 该 assignee 标 `need_decision`
   *  3. `deliver` 问卷 @sender 并顺延墙钟；人下次来消息时 LLM 认待决 → 答复并复活，或开新单
   * local（Web）任务不接管：网页 answerer 正常处理。
   */
  async function handOffAskToHuman(taskId: string, expertId: string, callIds: readonly string[]): Promise<void> {
    if (stopped) return
    const task = readTask('running', taskId)
    if (task === undefined || task.providerId === 'local') return
    const a = task.assignees.find((x) => x.expertId === expertId)
    if (a === undefined || isTerminal(a)) return
    const live = host.agents()?.get(a.sessionId) as (AgentLike & { cancel?: (cause: unknown, options?: unknown) => void }) | undefined
    if (live === undefined) return
    const stillOpen = openAskCalls(live).filter((o) => callIds.includes(o.callId))
    if (stillOpen.length === 0) return // 已经被网页答掉了，别多事
    const questions = stillOpen.flatMap((o) => o.questions)
    live.cancel?.({ kind: 'hook', reason: 'agent-bot: ask_user_question 改由人在 IM 回答' }, { keepInbox: true })
    a.status = 'need_decision'
    task.pendingHuman = {
      questions: questions.length > 0 ? questions : ['（模型想问你一个问题）'],
      askedBy: expertId,
      askedAt: Date.now(),
      toHuman: true,
    }
    writeTask('running', task)
    await sendQuestionnaire(task, task.pendingHuman.questions, '需要你确认')
    syncDeadline(task.taskId)
  }

  /**
   * 重读 → 改 → 写（同步小段）。
   * 巡检经常"读快照 → await（等 idle / deliver）→ 写回"，直接写会把这段期间
   * 别人（专家 update_task / 人的回填）写进 md 的内容覆盖掉。所有写入都走这里。
   */
  function patchTask(taskId: string, mutate: (t: TaskBoard) => void): void {
    const fresh = readTask('running', taskId)
    if (fresh === undefined) return
    mutate(fresh)
    writeTask('running', fresh)
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
    // 会话不在线也能叫醒：followup 内部 ensureAgent 会重建。lead 不在 assignees 里，
    // 没有活性探针兜底，这里若因「不在线」就 return，重启恢复 / lead 被回收后通知就永远丢了。
    const ok = await followup(cfg, sessionId, text, host)
    if (!ok) return false
    notified.set(key, fingerprint)
    return true
  }

  async function patrolTask(task: TaskBoard): Promise<void> {
    const now = Date.now()
    const allDone = task.assignees.length > 0 && task.assignees.every(isTerminal)
    const hadAssignees = task.assignees.length > 0

    // 墙钟到点：不一律判死，先分析各专家会话状态（specs/12 §超时分层）
    if (task.deadlineAt > 0 && now >= task.deadlineAt) {
      const pending = task.pendingHuman !== undefined
      const unfinished = task.assignees.filter((a) => !isTerminal(a))
      // need_decision = 卡在等人批准：不算「还在跑」，否则会被无限顺延
      const someoneAlive = unfinished.some((a) => a.status !== 'need_decision' && agentAlive(a, host))

      if (allDone && !pending) {
        // ① 都做完了没综合 → 就走下面的正常收口（不是超时）
      } else if (someoneAlive) {
        // ② 还有人活着在做 → 顺延，只给进度反馈（同一 deadlineAt 指纹去重，不刷屏）
        await notifyProgress(task, unfinished, host, notified)
        deferDeadline(task)
        return
      } else if (pending) {
        // ⑥ 有问卷但没人在跑 → 交回给人拍板，留在 running/ 等人
        await askHumanToDecide(task, '还有问题等你确认')
        deferDeadline(task)
        return
      } else if (unfinished.length > 0) {
        // ③ 没人在跑也没终态：先尝试救活（超时/网络一类）
        const revived = await reviveDead(task, unfinished, host)
        if (revived) {
          await notifyProgress(task, unfinished, host, notified)
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

    // 待决：给人发的问卷 → deliver 问卷 + 顺延墙钟；上抛给 lead 的 → 叫醒 taskLead 拍板
    if (task.pendingHuman !== undefined) {
      if (task.pendingHuman.toHuman === true) {
        await askHumanToDecide(task, '有人提了问题')
      } else if (!deciding.has(task.taskId)) {
        const job = decidePendingAndClear(task).finally(() => deciding.delete(task.taskId))
        deciding.set(task.taskId, job)
      }
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
        const resumedIds = new Set<string>()
        for (const [by, kids] of wakers) {
          // 被叫醒的中间层若正 `waiting`（在等下游）→ 尝试恢复 `running`：它要接着做自己的活。
          // 恢复不了（目标锁被别人占着）→ 继续等：**不要**叫醒它，等锁那一路推进队列时再启动。
          const wasWaiting = task.assignees.find((a) => a.expertId === by)?.status === 'waiting'
          const resumed = resumeWaiting(task, by, relay)
          if (resumed) resumedIds.add(by)
          else if (wasWaiting || isWaitingForLock(task, by, relay)) continue
          const done = await wakeOnce(task, by, wakeFingerprint(task, by), wakeText(task, kids))
          if (done) consumed.push(...kids)
        }
        // 上报成功才消费 wake；目标不在线则留着，下一轮重试。恢复 waiting 也一并落盘。
        const consumedIds = new Set(consumed.map((a) => a.expertId))
        if (consumedIds.size > 0 || resumedIds.size > 0) {
          patchTask(task.taskId, (t) => {
            for (const a of t.assignees) {
              if (consumedIds.has(a.expertId)) a.wake = false
              else if (resumedIds.has(a.expertId) && a.status === 'waiting') a.status = 'running'
            }
          })
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

  /**
   * 收口交付（specs/12 §谁改状态）：
   *   1. 全终态 → 叫醒 taskLead 综合（记下当时的 seq 作为"这段产出"的起点）
   *   2. 等它这一轮结束 → 取产出 `deliver` @sender
   *   3. deliver 成功、且没再派活/没待决 → 移 `done/` + 解绑
   *
   * 跨多轮的状态放内存 `collecting`：**叫醒只做一次**（指纹去重），但等它结束、交付可以重试。
   * 原实现写成"`wakeOnce` 返回 false 就直接 return"，于是 lead 综合一旦超过一次等待窗口，
   * 重试就被指纹挡住 → **永远不交付 / 待决永不清**。现在重试会继续等。
   * deliver 失败**不**移 `done/`（spec：留在 running/ 待重试），产出的文本也留着下次再发。
   */
  async function summarizeAndDeliver(task: TaskBoard, leadBound: readonly Assignee[] = []): Promise<void> {
    const cfg = getAgentConfig(task.taskLead)
    const sessionId = wakeSessionIdFor(task, task.taskLead)
    if (cfg === undefined || sessionId === undefined) return
    const key = task.taskId
    try {
      // 上次产出已落盘（deliverText）但 deliver 失败：只重试投递，不再打扰 lead
      if (task.deliverText !== undefined) {
        await retryDeliver(task, task.deliverText)
        return
      }
      // lead 会话不在线（进程重启 / 被回收）→ 先重建，否则「叫醒 lead 综合」直接断掉
      let live = host.agents()?.get(sessionId) as AgentLike | undefined
      if (live === undefined) live = await ensureLive(cfg, sessionId, host)
      if (live === undefined) return
      if (!synthesizing.has(key)) {
        // 第一次：叫醒 lead，并记下这一轮的起点（后续重试仍用这个起点取产出）
        synthesizing.set(key, live.session.seq)
        await wakeOnce(task, task.taskLead, wakeFingerprint(task, task.taskLead), marshalText(task))
        // 综合已开始：消费报给 lead 的 wake，后续要靠新的终态变化才会再触发
        if (leadBound.length > 0) {
          for (const a of leadBound) a.wake = false
          patchTask(task.taskId, (t) => {
            for (const a of t.assignees) if (leadBound.some((x) => x.expertId === a.expertId)) a.wake = false
          })
        }
      }
      const firstSeq = synthesizing.get(key) as number
      // 等它综合完——**不设人为窗口**。但必须先确认"这一轮真的开始了"：
      // followup 之后 agent 可能还没开跑，此时 whenIdle() 会立刻 resolve，
      // 取到空文本就会发出「（综合无输出）」并移 done（假成功）。
      if (live.status === 'running') {
        await live.whenIdle()
      } else if (!hasEventsAfter(live, firstSeq)) {
        return // 还没开跑：本轮不动，等下次触发（synthesizing 留着）
      }
      const text = summarizeOwnedInterval(live.session.snapshotEvents(), firstSeq)
      if (text === '') return // 这一轮没有产出：不发明假答案，下次再来
      // 产出落盘，避免进程重启丢失「已综合、未投出」的文本
      patchTask(task.taskId, (t) => { t.deliverText = text })
      await retryDeliver(task, text)
    } catch (err) {
      console.warn(`agent-bot: 收口交付 ${task.taskId} 失败（文件留在 running/）: ${(err as Error).message}`)
    }
  }

  /** 投递收口文本；成功且没有新活 → 移 done/ + 解绑；失败留着下次重试。 */
  async function retryDeliver(task: TaskBoard, text: string): Promise<void> {
    const fresh = readTask('running', task.taskId)
    if (fresh === undefined) {
      synthesizing.delete(task.taskId) // 人已挪走（done/ 或 cancel/）
      return
    }
    const ok = await deliverToSender(fresh, text, host)
    if (!ok) {
      // 留在 running/，下次触发再投（spec：deliver 失败不移动文件）。
      // 但要有上限：通道一直挂着时不能每轮空转 —— 超了就把文本落进 md 正文（消息不丢），停止重投。
      const attempts = (fresh.deliverAttempts ?? 0) + 1
      const max = options.deliverMaxAttempts ?? 5
      if (attempts >= max) {
        console.warn(`agent-bot: 收口投递 ${task.taskId} 连续失败 ${attempts} 次，改写入 md 正文`)
        patchTask(task.taskId, (t) => {
          t.body = `${t.body}\n\n- ⚠️ 最终答复（未能发到群）：${text.replace(/\n+/g, ' ')}`
          t.deliverText = undefined
          t.deliverAttempts = undefined
        })
        synthesizing.delete(task.taskId)
        return
      }
      // 重试次数落盘（deliverText 已在 summarizeAndDeliver 落盘），进程重启后仍按次数续投
      patchTask(task.taskId, (t) => { t.deliverAttempts = attempts })
      return
    }
    // 投出成功：清掉落盘的收口进度
    patchTask(task.taskId, (t) => { t.deliverText = undefined; t.deliverAttempts = undefined })
    synthesizing.delete(task.taskId)
    const stillOpen = fresh.assignees.some((a) => !isTerminal(a)) || fresh.pendingHuman !== undefined
    if (stillOpen) return // 又派了活 / 又问了人：保持 running
    unbindDone(fresh)
    // 期间可能已被人挪走（cancel/ 或 done/）：那就别再 move
    if (readTask('running', fresh.taskId) !== undefined) moveTask('running', 'done', fresh.taskId)
    clearDeadline(fresh.taskId)
  }

  /**
   * 上抛给 taskLead 的待决：叫醒它、**等它这一轮结束**，然后自动清掉待决。
   * 理由：待决原来只写不清（靠模型记得调 clear_pending），忘了就永久卡住。
   * 安全点：这轮里 lead 若又问了新问题（如 `ask_human`，askedAt 变了），保留新的那份。
   */
  async function decidePendingAndClear(task: TaskBoard): Promise<void> {
    const askedAt = task.pendingHuman?.askedAt
    if (askedAt === undefined) return
    const cfg = getAgentConfig(task.taskLead)
    const sessionId = wakeSessionIdFor(task, task.taskLead)
    if (cfg === undefined || sessionId === undefined) return
    const live = host.agents()?.get(sessionId) as
      | (AgentLike & { session: { seq: number; snapshotEvents(): Array<{ seq: number }> } })
      | undefined
    if (live === undefined) return
    try {
      const firstSeq = live.session.seq // 叫醒前的起点（判断这一轮跑没跑过）
      // 叫醒只做一次（指纹去重）；即使"已叫醒过"也要继续等它这一轮——
      // 否则上一次等超时后，重试会被指纹挡住，待决永远清不掉。
      await wakeOnce(task, task.taskLead, `pending:${askedAt}`, marshalText(task))
      // 不设窗口，但要先确认它真的开跑了，否则"刚叫醒仍 idle"会被当成答完、把待决误清
      if (live.status === 'running') {
        await live.whenIdle()
      } else if (!hasEventsAfter(live, firstSeq)) {
        return // 还没开跑：等下次触发
      }
      const fresh = readTask('running', task.taskId)
      if (fresh?.pendingHuman === undefined) return
      if (fresh.pendingHuman.askedAt !== askedAt) return // 这轮又问了新问题 → 留新的
      fresh.pendingHuman = undefined
      writeTask('running', fresh)
      // 拍板完继续推进：可能已派新活，或全终态该收口
      await patrolTask(fresh)
      syncDeadline(fresh.taskId)
    } catch (err) {
      console.warn(`agent-bot: 等 taskLead 拍板 ${task.taskId} 失败: ${(err as Error).message}`)
    }
  }

  /**
   * 发问卷给人（specs/12 §决策链路）：
   *  - `deliver` 一条 markdown @sender（题干 + 当前摘要 + 怎么回）
   *  - **把墙钟顺延成「发出时刻 + 一个墙钟」**（人还没答，不该算任务超时）
   *  - 按 askedAt 指纹去重（同一次问卷只发一条）
   */
  async function sendQuestionnaire(task: TaskBoard, questions: readonly string[], reason: string): Promise<boolean> {
    // 指纹只认「这一次问卷」本身（askedAt + 问题），不认触发它的分支用词：
    // 否则「待决分支」与「到点分支」措辞不同，会把同一份问卷发两遍
    const askedAt = task.pendingHuman?.askedAt ?? 0
    const fingerprint = `ask:${askedAt}:${questions.join('|')}`
    const key = `${task.taskId}\0__human__`
    if (notified.get(key) === fingerprint) return false
    const body = questions.length === 0
      ? reason
      : `${reason}\n\n${questions.map((q, i) => (questions.length > 1 ? `${i + 1}. ${q}` : q)).join('\n')}`
    const tail = task.body.trim() === '' ? '' : `\n\n当前进展：\n${task.body.trim().slice(-300)}`
    const ok = await deliverToSender(task, `${body}${tail}\n\n（回一句 @${task.leadName} 即可；不想做了可把任务文件挪到 jobs/cancel/）`, host)
    if (!ok) return false
    notified.set(key, fingerprint)
    // 问卷发出 → 墙钟顺延（spec：发出时刻 + task_round_timeout_ms）
    const nextDeadline = Date.now() + roundTimeoutMs()
    patchTask(task.taskId, (t) => { t.deadlineAt = nextDeadline })
    scheduleDeadline({ ...task, deadlineAt: nextDeadline })
    return true
  }

  /** 到点但没人在跑 / 待决无人答：交回给人拍板，任务留在 running/ 等人。 */
  async function askHumanToDecide(task: TaskBoard, reason: string): Promise<void> {
    await sendQuestionnaire(task, task.pendingHuman?.questions ?? [], `需要你确认后才能继续：${reason}`)
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
    // 本轮探针是否把某路转成了终态（idle/failed）：是则要补一趟 patrolTask 立即上报。
    // 事件驱动下没有下一轮循环来兜底，不补就得到墙钟（默认 2h）或下次互动才通知 lead。
    let terminalChanged = false
    for (const a of task.assignees) {
      if (isTerminal(a)) continue
      const cfg = getAgentConfig(a.expertId)
      if (cfg === undefined) continue
      // 等审批：标记 need_decision + 通知人去网页批准；批准/拒绝后回到 running
      const waitLive = host.agents()?.get(a.sessionId) as AgentLike | undefined
      if (waitLive !== undefined) {
        watchAskUserQuestion(task, a, waitLive, openAskCalls(waitLive))
        const open = openApprovals(waitLive)
        if (open.length > 0 && a.status !== 'need_decision') {
          a.status = 'need_decision'
          patchTask(task.taskId, (t) => {
            const x = t.assignees.find((y) => y.expertId === a.expertId)
            if (x !== undefined) x.status = 'need_decision'
          })
          await notifyApprovalWait(task, a, open, host, notified)
        } else if (open.length === 0 && a.status === 'need_decision') {
          a.status = 'running'
          patchTask(task.taskId, (t) => {
            const x = t.assignees.find((y) => y.expertId === a.expertId)
            if (x !== undefined) x.status = 'running'
          })
        }
      }
      if (a.status !== 'running') continue
      const live = host.agents()?.get(a.sessionId) as AgentLike | undefined
      if (live === undefined) {
        // 非阻塞版：挂够一个窗口（W）才算一次续期，避免轮询变快后几秒内就把专家判死
        const nowMs = Date.now()
        const missingSince = a.missingSince ?? 0
        if (missingSince === 0) {
          // 首次发现缺失：记时间戳（落盘，进程重启后仍按此窗口判）
          patchTask(task.taskId, (t) => {
            const x = t.assignees.find((y) => y.expertId === a.expertId)
            if (x !== undefined) x.missingSince = nowMs
          })
          continue
        }
        if (nowMs - missingSince < windowFor(cfg)) continue
        const renew = (a.renew ?? 0) + 1
        if (renew >= maxRenew()) {
          a.status = 'failed'
          patchTask(task.taskId, (t) => {
            const x = t.assignees.find((y) => y.expertId === a.expertId)
            if (x !== undefined) {
              x.status = 'failed'
              x.renew = undefined
              x.missingSince = undefined
            }
          })
          await releaseAndAdvance(task, a, cfg, relay)
          terminalChanged = true
          continue
        }
        // 续期计数 + 时间戳落盘（进程重启后仍按此续期，不重置）
        patchTask(task.taskId, (t) => {
          const x = t.assignees.find((y) => y.expertId === a.expertId)
          if (x !== undefined) {
            x.renew = renew
            x.missingSince = nowMs
          }
        })
        await restartExpert(task, cfg, a, host)
        continue
      }
      // 会话在：清掉续期计数（若有残留），避免重启后误判
      if (a.missingSince !== undefined || a.renew !== undefined) {
        patchTask(task.taskId, (t) => {
          const x = t.assignees.find((y) => y.expertId === a.expertId)
          if (x !== undefined) {
            x.missingSince = undefined
            x.renew = undefined
          }
        })
      }
      // 会话在且已 idle → 转态（漏掉事件时的兜底；快路径由 reconcile 处理）
      if (live.status === 'idle') {
        a.status = 'idle'
        patchTask(task.taskId, (t) => {
          const x = t.assignees.find((y) => y.expertId === a.expertId)
          if (x !== undefined && x.status === 'running') x.status = 'idle'
        })
        await releaseAndAdvance(task, a, cfg, relay) // 这一轮 write 结束 → 让出目标锁，叫醒排队的下一个
        terminalChanged = true
        continue
      }
    }
    // 判 idle / failed 都是终态迁移：立刻把上报/综合/交付跑一遍，别等下一个触发点。
    if (terminalChanged) await patrolTask(task)
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
      const a = task.assignees.find((x) => x.sessionId === sessionId && (x.status === 'running' || x.status === 'need_decision'))
      if (a === undefined) continue
      const cfg = getAgentConfig(a.expertId)
      if (cfg === undefined) continue
      // need_decision（卡在等审批）的会话被回收 = 审批窗口消失、重启也接不回那个审批：直接判 failed 走状态机
      if (a.status === 'need_decision') {
        a.status = 'failed'
        a.renew = undefined
        a.missingSince = undefined
        if (readTask('running', task.taskId) !== undefined) writeTask('running', task)
        await patrolTask(task)
        continue
      }
      const renew = (a.renew ?? 0) + 1
      if (renew >= maxRenew()) {
        a.status = 'failed'
        a.renew = undefined
        a.missingSince = undefined
      } else {
        a.renew = renew
        if (readTask('running', task.taskId) !== undefined) writeTask('running', task)
        await restartExpert(task, cfg, a, host)
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

export { assigneeOf, hasPendingDownstream, shouldDeliver, wakeSessionIdFor, wakeText } from './wake.js'

