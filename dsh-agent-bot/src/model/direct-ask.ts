/**
 * `/agent` 与 `agent_ask` 的工作目录。
 * 勾了 needs_target_workspace 时，调用方项目只是产出目录；会话仍开在专家技能仓。
 */
import { createHash } from 'node:crypto'
import type { AgentConfig } from './config.js'
import { resolveTargetWorkspace } from './teamwork/board-tools.js'

export interface DirectAskPlacement {
  /** ensureAgent 使用的 cwd。始终是专家 workspace。 */
  cwd: string
  /** 空 = 不注入目标。 */
  targetWorkspace: string
  /** 拼在 sessionKey 后，按目标分槽，且不续接 cwd 曾是目标目录的旧槽。 */
  sessionKeySuffix: string
  /** 追加到用户上下文；空 = 不追加。 */
  notice: string
}

export function directAskPlacement(agent: Pick<AgentConfig, 'name' | 'workspace' | 'needs_target_workspace'>, callerCwd: string | undefined): DirectAskPlacement {
  if (agent.needs_target_workspace !== true) {
    return { cwd: agent.workspace, targetWorkspace: '', sessionKeySuffix: '', notice: '' }
  }
  const resolved = resolveTargetWorkspace(agent as AgentConfig, callerCwd)
  if (!resolved.ok) throw new Error(resolved.reason)
  const digest = createHash('sha1').update(resolved.path).digest('hex').slice(0, 12)
  return {
    cwd: agent.workspace,
    targetWorkspace: resolved.path,
    // __ag_ 与旧 __tw_（cwd=目标目录）错开，避免续接已经开在调用方项目里的会话。
    sessionKeySuffix: `__ag_${digest}`,
    notice: `产出写到目标目录 ${resolved.path}，不要写到自己的 cwd（技能仓 ${agent.workspace}）。做完正常收口，运行时会把本轮结果抛回调用方会话。`,
  }
}
