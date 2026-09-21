/**
 * 中继驱动（specs/12 §中继驱动）。
 * 区别于通道 `ask`：不走 prepareAsk / 通道 sessionKey / 通道 pending。
 * 复用 createAgentRuntime.ensureAgent + followup。
 *
 * 职责：
 *  - 协作会话槽 `task:{taskId}:{expertId}`（与通道 encodeSessionKey 隔离）。
 *  - 启动一次专家 turn：解析槽 → ensureAgent → followup(包装指令 + md 全文)。
 *  - read 并行、write 同 target FIFO（进程内栅栏；跨进程序列不在本项目处理）。
 *
 * 读写 md（assignees[] 落槽）交 board-tools / patrol，本模块只负责「拉起并叫醒」。
 */
import { randomUUID } from 'node:crypto'
import type { AgentConfig } from '../config.js'
import { touchSession } from '../agents.js'
import type { EnsureAgentInput, AgentLike } from '../runtime.js'

export const COLLAB_SESSION_PREFIX = 'task:'

/** 协作槽 key。`task:{taskId}:{expertId}`，禁止撞通道 encodeSessionKey。 */
export function taskSlotKey(taskId: string, expertId: string): string {
  return `task:${taskId}:${expertId}`
}

export function isCollabSessionKey(key: string): boolean {
  return key.startsWith(COLLAB_SESSION_PREFIX)
}

/**
 * 解析协作槽 session：`session=reuse` 槽在则续、否则新 uuid；`session=new` 直接新 uuid。
 * 一律写回该专家 agents[].sessions[task:...]（可带 title 由调用方另改会话标题）。
 */
export function resolveCollabSlotSession(
  agent: AgentConfig,
  taskId: string,
  expertId: string,
  session: 'reuse' | 'new',
  nowMs: number,
): string {
  const key = taskSlotKey(taskId, expertId)
  if (session === 'reuse') {
    const existing = agent.sessions[key]?.sessionId
    if (existing !== undefined && existing !== '') return existing
  }
  const sessionId = randomUUID()
  touchSession(agent.id, key, sessionId, nowMs, '')
  return sessionId
}

/** 同 target write 的 FIFO 归组键：target_workspace ?? 任务 target ?? 该专家 cwd。 */
export function writeFenceKey(access: 'read' | 'write', targetWorkspace?: string, taskTarget?: string, expertWorkspace?: string): string {
  const key = targetWorkspace ?? taskTarget ?? expertWorkspace ?? ''
  return `${access}:${key}`
}

/**
 * 进程内 write FIFO 栅栏。真实并发只有本进程驱动，进程内判定足够；
 * 重启后栅栏清空，占位会话以 `agents.get(sessionId)` 判活性。
 */
export interface WriteFence {
  begin(access: 'read' | 'write', key: string, sessionId: string): void
  /** 该读写槽当前是否被一个活会话占着。 */
  occupied(key: string): boolean
  release(key: string, sessionId: string): void
}

export function createWriteFence(agents: () => { get(sessionId: string): unknown } | undefined): WriteFence {
  const holders = new Map<string, string>() // key -> sessionId
  return {
    begin(_access, key, sessionId) {
      holders.set(key, sessionId)
    },
    occupied(key) {
      const sessionId = holders.get(key)
      if (sessionId === undefined) return false
      return agents()?.get(sessionId) !== undefined
    },
    release(key, sessionId) {
      if (holders.get(key) === sessionId) holders.delete(key)
    },
  }
}

/** 中继所需宿主（只读面向运行时的最小面）。 */
export interface RelayHost {
  ensureAgent(input: EnsureAgentInput): Promise<AgentLike>
  agents(): { get(sessionId: string): unknown } | undefined
}

export interface Relay {
  /** 解析该专家在这份任务下应使用的真实 sessionId（槽或新 uuid），并落槽。 */
  resolveSession(agent: AgentConfig, taskId: string, expertId: string, session: 'reuse' | 'new', nowMs: number): string
  /**
   * 启动一次专家 turn：resolveSession → ensureAgent → followup(包装文本)。
   * 返回实际使用的 { sessionId, kind: 'running' }。不等待 idle。
   */
  startTurn(input: {
    agent: AgentConfig
    taskId: string
    expertId: string
    instruction: string
    mdText: string
    access: 'read' | 'write'
    session: 'reuse' | 'new'
    nowMs: number
    variables: Record<string, string>
    promptText: string
    permissionMode: AgentConfig['permission_mode']
    targetWorkspace?: string
  }): Promise<{ kind: 'running'; sessionId: string }>
  writeFence: WriteFence
}

/** 包装 followup：被派做共享任务板上的一单，不是对群友说话；注入 md 全文。 */
export function wrapDispatchFollowup(input: {
  instruction: string
  mdText: string
  access: 'read' | 'write'
  targetWorkspace?: string
}): string {
  const lines: string[] = [
    '你是被派做共享任务板上的一单，不是在对群友说话；本任务 access 见 md。',
    '缺信息时：你不是任务 lead 就调 ask_task_lead 把问题上抛，或把问题写进结果摘要后收口；不要在正文里只提问。',
    '做完把进展写回 md（update_task）后收口。',
  ]
  if (input.access === 'write' && input.targetWorkspace !== undefined && input.targetWorkspace !== '') {
    lines.push(`产出写到目标目录 ${input.targetWorkspace}，不要写到自己的 cwd。`)
  }
  lines.push('本次指令：', input.instruction, '')
  lines.push('——以下为任务文件全文——')
  lines.push(input.mdText)
  return lines.join('\n')
}

/**
 * 启动一个专家 turn 并写入协作槽。重复启动同 (taskId, expertId) 幂等换 sessionId。
 */
export function buildRelay(host: RelayHost): Relay {
  const writeFence = createWriteFence(host.agents)
  return {
    resolveSession(agent, taskId, expertId, session, nowMs) {
      return resolveCollabSlotSession(agent, taskId, expertId, session, nowMs)
    },
    async startTurn(input) {
      const sessionId = this.resolveSession(input.agent, input.taskId, input.expertId, input.session, input.nowMs)
      const followupText = wrapDispatchFollowup({
        instruction: input.instruction,
        mdText: input.mdText,
        access: input.access,
        targetWorkspace: input.targetWorkspace,
      })
      const ensureInput: EnsureAgentInput = {
        sessionId,
        cwd: input.agent.workspace, // 专家 cwd = 自己的 workspace，永不改目标项目
        agentId: input.agent.id,
        agentName: input.agent.name,
        promptText: input.promptText,
        variables: {
          sender: input.variables.sender ?? '',
          session_key: taskSlotKey(input.taskId, input.expertId),
          provider_id: input.variables.provider_id ?? '',
          target_workspace: input.targetWorkspace ?? '',
          ...input.variables,
        },
        permissionMode: input.permissionMode,
      }
      await host.ensureAgent(ensureInput)
      const agent = host.agents()?.get(sessionId) as AgentLike | undefined
      if (agent === undefined) throw new Error(`agent-bot: 启动专家 ${input.expertId} 后未拿到 live agent`)
      agent.followup({
        id: `agent-bot-${Date.now()}`,
        role: 'user',
        content: [{ type: 'text', text: followupText }],
        source: { kind: 'user' },
      })
      return { kind: 'running', sessionId }
    },
    writeFence,
  }
}