/** 本机控制动作。只接受查询结果里已有的会话，不接受调用方给的目录。 */

export interface SessionView {
  id: string
  cwd: string
  live: boolean
}

export interface ControlApi {
  listSessions(): Promise<SessionView[]>
  sendPrompt(sessionId: string, text: string): Promise<void>
}

export const PROMPT_MAX = 8000

export function assertSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(sessionId)) throw new Error('会话 id 格式不对')
}

export function assertPrompt(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '') throw new Error('请输入要发送的内容')
  if (trimmed.length > PROMPT_MAX) throw new Error(`内容超过 ${PROMPT_MAX} 字`)
  return trimmed
}
