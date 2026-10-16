/**
 * 生命周期 / 活性（docs/specs/12 §活性探针）。
 * 会话拉起、叫醒、重启、救活。运行时依赖 host（ensureAgent / agents）显式传入。
 * 续期计数（renew / missingSince）已落盘在 assignee，由 patrol 的 probeTask 读/写，本模块不持有。
 */
import type { AgentConfig } from '../config.js'
import type { AgentLike } from '../runtime.js'
import { getAgent as getAgentConfig } from '../agents.js'
import { marshalText } from './board-tools.js'
import { writeTask, type Assignee, type TaskBoard } from './task-board.js'
import type { RelayHost } from './relay.js'

/** 该 assignee 的会话是否还活着（在跑）。 */
export function agentAlive(a: Assignee, host: RelayHost): boolean {
  return a.sessionId !== '' && host.agents()?.get(a.sessionId) !== undefined
}

/** 拉起（或复用）某 agent 的会话，返回 live；重建失败返回 undefined。 */
export async function ensureLive(agent: AgentConfig, sessionId: string, host: RelayHost): Promise<AgentLike | undefined> {
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
  } catch (err) {
    console.warn(`agent-bot: 拉起会话 ${sessionId}（agent ${agent.id}）失败: ${(err as Error).message}`)
    return undefined
  }
  return host.agents()?.get(sessionId) as AgentLike | undefined
}

/** 叫醒某 agent：确保 live 后 followup。返回是否真的投进去了。 */
export async function followup(agent: AgentConfig, sessionId: string, text: string, host: RelayHost): Promise<boolean> {
  const live = await ensureLive(agent, sessionId, host)
  if (live === undefined) return false
  live.followup({
    id: `agent-bot-patrol-${Date.now()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
  return true
}

/** 重启某专家：对其会话 followup 一份最新 md 全文。 */
export async function restartExpert(task: TaskBoard, cfg: AgentConfig, a: Assignee, host: RelayHost): Promise<void> {
  await followup(cfg, a.sessionId, marshalText(task), host)
}

/** 救活：对没终态又没会话的 assignee 重新 ensureAgent + 重发 md。返回是否救活了至少一个。 */
export async function reviveDead(task: TaskBoard, unfinished: readonly Assignee[], host: RelayHost): Promise<boolean> {
  let revived = false
  for (const a of unfinished) {
    if (a.status === 'failed') continue // 已判死：不反复救，交给交回给人那一支
    if (agentAlive(a, host)) continue
    const cfg = getAgentConfig(a.expertId)
    if (cfg === undefined) continue
    await restartExpert(task, cfg, a, host)
    if (a.status === 'waiting') {
      a.status = 'running' // 重新投入
      writeTask('running', task)
    }
    revived = true
  }
  return revived
}