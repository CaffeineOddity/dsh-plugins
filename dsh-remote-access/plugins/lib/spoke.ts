import { assertPrompt, assertSessionId, type ControlApi } from './control.ts'
import { publicHostname, RELAY_PATHS } from './policy.ts'
import { requestFixed, type LookupFn } from './remote.ts'
import { open } from './secrets.ts'
import type { RemoteState } from './state.ts'
import type { RelayJob, RelayOp } from './relay.ts'

async function runJob(state: RemoteState, control: ControlApi, job: RelayJob): Promise<{ status: number; body: unknown }> {
  const op = job.op as RelayOp
  if (op === 'status') {
    return { status: 200, body: { deviceId: state.deviceId, name: state.deviceName, slug: state.spoke?.slug ?? '' } }
  }
  if (op === 'sessions') {
    return { status: 200, body: { sessions: await control.listSessions() } }
  }
  if (op !== 'prompt') return { status: 400, body: { error: '拒绝未允许的动作' } }
  const body = job.body
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { status: 400, body: { error: '需要 sessionId 和 text' } }
  const record = body as { sessionId?: unknown; text?: unknown }
  if (typeof record.sessionId !== 'string' || typeof record.text !== 'string') return { status: 400, body: { error: '需要 sessionId 和 text' } }
  try {
    assertSessionId(record.sessionId)
    const text = assertPrompt(record.text)
    const known = await control.listSessions()
    if (!known.some((session) => session.id === record.sessionId)) return { status: 404, body: { error: '这台设备没有这个会话' } }
    await control.sendPrompt(record.sessionId, text)
    return { status: 200, body: { ok: true } }
  } catch (error) {
    return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } }
  }
}

/** 向中枢领一条动作并交回结果。没配置或领到空时什么都不做。 */
export async function spokeOnce(state: RemoteState, control: ControlApi, lookup?: LookupFn): Promise<'idle' | 'done' | 'empty'> {
  const spoke = state.spoke
  if (spoke === null) return 'idle'
  const own = publicHostname(state.publicOrigin)
  if (own !== '' && new URL(spoke.hubOrigin).hostname.toLowerCase() === own) return 'idle'
  const token = open(spoke, state.hubKey)
  const polled = await requestFixed(spoke.hubOrigin, '/api/relay/poll', RELAY_PATHS, {
    method: 'POST',
    token,
    body: {},
    timeoutMs: 12_000,
    maxBytes: 32 * 1024,
    lookup,
  })
  const job = (polled.json as { job?: RelayJob | null } | null)?.job
  if (polled.status !== 200 || job === null || job === undefined) return 'empty'
  const result = await runJob(state, control, job)
  await requestFixed(spoke.hubOrigin, '/api/relay/result', RELAY_PATHS, {
    method: 'POST',
    token,
    body: { id: job.id, status: result.status, body: result.body },
    timeoutMs: 12_000,
    maxBytes: 8192,
    lookup,
  })
  return 'done'
}
