import { assertPrompt, assertSessionId, type ControlApi } from './control.ts'
import { assertSlug, publicHostname } from './policy.ts'
import { RelayHub, type RelayOp } from './relay.ts'
import { enrollAtHub, type LookupFn } from './remote.ts'
import { hashEquals, randomToken, seal, sha256 } from './secrets.ts'
import type { PathSlot, RemoteState } from './state.ts'

const ENROLL_TTL_MS = 5 * 60 * 1000
const PATH_CAP = 8

export interface RelayCtx {
  state: RemoteState
  save: () => void
  control: ControlApi
  relay: RelayHub
  enrollAttempts: number[]
  now: number
  startedAt: number
  lookup?: LookupFn
  enrollAtHub?: typeof enrollAtHub
}

export interface RelayCall {
  method: string
  path: string
  authorization: string
  body: unknown
  now: number
  local: boolean
  hub: boolean
  gate: (attempts: number[], now: number) => boolean
}

function bearer(header: string): string {
  const match = /^Bearer\s+(\S+)$/.exec(header.trim())
  return match?.[1] ?? ''
}

function objectBody(body: unknown): Record<string, unknown> | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined
  return body as Record<string, unknown>
}

function exactKeys(body: Record<string, unknown>, keys: string[]): boolean {
  const got = Object.keys(body)
  return got.length === keys.length && keys.every((key) => got.includes(key))
}

function slotByToken(state: RemoteState, header: string): PathSlot | undefined {
  const token = bearer(header)
  if (!token.startsWith('relay_')) return undefined
  return state.paths.find((slot) => slot.tokenHash !== '' && hashEquals(token, slot.tokenHash))
}

function pathView(slot: PathSlot, relay: RelayHub, now: number): { slug: string; name: string; enrolled: boolean; online: boolean } {
  return {
    slug: slot.slug,
    name: slot.name,
    enrolled: slot.tokenHash !== '',
    online: relay.online(slot.slug, now),
  }
}

async function localOp(ctx: RelayCtx, op: RelayOp, body: unknown, now: number): Promise<{ status: number; body: unknown }> {
  if (op === 'status') {
    return { status: 200, body: { deviceId: ctx.state.deviceId, name: ctx.state.deviceName, uptimeMs: Math.max(0, now - ctx.startedAt) } }
  }
  if (op === 'sessions') {
    return { status: 200, body: { sessions: await ctx.control.listSessions() } }
  }
  const record = objectBody(body)
  if (record === undefined || typeof record.sessionId !== 'string' || typeof record.text !== 'string') {
    return { status: 400, body: { error: '需要 sessionId 和 text' } }
  }
  assertSessionId(record.sessionId)
  const text = assertPrompt(record.text)
  const known = await ctx.control.listSessions()
  if (!known.some((session) => session.id === record.sessionId)) return { status: 404, body: { error: '这台设备没有这个会话' } }
  await ctx.control.sendPrompt(record.sessionId, text)
  return { status: 200, body: { ok: true } }
}

async function forward(ctx: RelayCtx, slug: string, op: RelayOp, body: unknown, now: number): Promise<{ status: number; body: unknown }> {
  if (slug === ctx.state.selfSlug) return localOp(ctx, op, body, now)
  const slot = ctx.state.paths.find((item) => item.slug === slug)
  if (slot === undefined) return { status: 404, body: { error: '没有这条路径' } }
  if (slot.tokenHash === '') return { status: 409, body: { error: '这台电脑还没接入' } }
  return ctx.relay.enqueue(slug, op, body, now)
}

/** 中继入口与路径槽。不是这些路径时返回 null，交给原来的调度。 */
export async function tryRelay(call: RelayCall, ctx: RelayCtx): Promise<{ status: number; body: unknown } | null> {
  const path = call.path
  if (call.method === 'POST' && path === '/api/relay/enroll') {
    if (!call.gate(ctx.enrollAttempts, call.now)) return { status: 429, body: { error: '接入尝试过多，请稍后再试' } }
    const body = objectBody(call.body)
    if (body === undefined || !exactKeys(body, ['slug', 'code']) || typeof body.slug !== 'string' || typeof body.code !== 'string') {
      return { status: 401, body: { error: '接入码无效或已过期' } }
    }
    let slug = ''
    try {
      slug = assertSlug(body.slug)
    } catch {
      return { status: 401, body: { error: '接入码无效或已过期' } }
    }
    const slot = ctx.state.paths.find((item) => item.slug === slug)
    const enroll = slot?.enroll
    const ok = slot !== undefined && enroll !== null && enroll !== undefined && enroll.expiresAt > call.now && hashEquals(body.code, enroll.hash)
    if (!ok || slot === undefined) return { status: 401, body: { error: '接入码无效或已过期' } }
    const token = randomToken('relay')
    slot.enroll = null
    slot.tokenHash = sha256(token)
    ctx.save()
    return { status: 200, body: { slug, token } }
  }

  if (call.method === 'POST' && path === '/api/relay/poll') {
    const slot = slotByToken(ctx.state, call.authorization)
    if (slot === undefined) return { status: 401, body: { error: '中继令牌无效' } }
    const job = ctx.relay.poll(slot.slug, call.now)
    return { status: 200, body: { job } }
  }

  if (call.method === 'POST' && path === '/api/relay/result') {
    const slot = slotByToken(ctx.state, call.authorization)
    if (slot === undefined) return { status: 401, body: { error: '中继令牌无效' } }
    const body = objectBody(call.body)
    if (body === undefined || !exactKeys(body, ['id', 'status', 'body']) || typeof body.id !== 'string') {
      return { status: 400, body: { error: '结果格式不对' } }
    }
    const status = body.status
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 599) {
      return { status: 400, body: { error: '结果格式不对' } }
    }
    const payload = body.body === null || (typeof body.body === 'object' && !Array.isArray(body.body)) ? body.body : undefined
    if (payload === undefined) return { status: 400, body: { error: '结果格式不对' } }
    const done = ctx.relay.complete(slot.slug, body.id, { status, body: payload })
    if (!done) return { status: 404, body: { error: '没有这条待回应的请求' } }
    return { status: 200, body: { ok: true } }
  }

  if (!call.hub) return null

  if (call.method === 'GET' && path === '/api/hub/paths') {
    return {
      status: 200,
      body: {
        selfSlug: ctx.state.selfSlug,
        paths: ctx.state.paths.map((slot) => pathView(slot, ctx.relay, call.now)),
      },
    }
  }

  if (call.local && call.method === 'POST' && path === '/api/hub/paths') {
    const body = objectBody(call.body)
    if (body === undefined || !exactKeys(body, ['slug', 'name']) || typeof body.slug !== 'string' || typeof body.name !== 'string') {
      return { status: 400, body: { error: '需要 slug 和 name' } }
    }
    let slug = ''
    try {
      slug = assertSlug(body.slug)
    } catch (error) {
      return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } }
    }
    if (slug === ctx.state.selfSlug) return { status: 400, body: { error: '这条路径是中枢自己，不用登记' } }
    const name = body.name.trim().slice(0, 40)
    if (name === '') return { status: 400, body: { error: '需要设备名称' } }
    const code = randomToken('enroll')
    const existing = ctx.state.paths.find((slot) => slot.slug === slug)
    if (existing === undefined && ctx.state.paths.length >= PATH_CAP) return { status: 400, body: { error: '路径槽已满' } }
    const slot: PathSlot = existing ?? { slug, name, tokenHash: '', enroll: null, createdAt: call.now }
    slot.name = name
    slot.tokenHash = ''
    slot.enroll = { hash: sha256(code), expiresAt: call.now + ENROLL_TTL_MS }
    if (existing === undefined) ctx.state.paths.push(slot)
    ctx.save()
    return { status: 200, body: { slug, code, expiresAt: slot.enroll.expiresAt } }
  }

  if (call.local && call.method === 'DELETE' && path.startsWith('/api/hub/paths/')) {
    const slug = decodeURIComponent(path.slice('/api/hub/paths/'.length))
    if (slug === '' || slug.includes('/') || slug.includes('\\')) return { status: 404, body: { error: 'not found' } }
    ctx.state.paths = ctx.state.paths.filter((slot) => slot.slug !== slug)
    ctx.save()
    return { status: 200, body: { ok: true } }
  }

  if (call.local && call.method === 'POST' && path === '/api/hub/spoke') {
    const body = objectBody(call.body)
    if (body === undefined || !exactKeys(body, ['hubOrigin', 'slug', 'code']) || typeof body.hubOrigin !== 'string' || typeof body.slug !== 'string' || typeof body.code !== 'string') {
      return { status: 400, body: { error: '需要 hubOrigin、slug 和 code' } }
    }
    let slug = ''
    try {
      slug = assertSlug(body.slug)
    } catch (error) {
      return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } }
    }
    const own = publicHostname(ctx.state.publicOrigin)
    let origin = ''
    try {
      origin = new URL(body.hubOrigin).hostname.toLowerCase()
    } catch {
      return { status: 400, body: { error: '中枢地址不是合法 URL' } }
    }
    if (own !== '' && origin === own) return { status: 400, body: { error: '不能把中枢连到自己' } }
    try {
      const enrolled = await (ctx.enrollAtHub ?? enrollAtHub)(body.hubOrigin, slug, body.code, ctx.lookup)
      const sealed = seal(enrolled.token, ctx.state.hubKey)
      ctx.state.spoke = { hubOrigin: enrolled.origin, slug, ...sealed }
      ctx.save()
      return { status: 200, body: { hubOrigin: enrolled.origin, slug } }
    } catch (error) {
      return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } }
    }
  }

  const route = /^\/api\/hub\/route\/([a-z][a-z0-9-]{0,31})\/(status|sessions|prompt)$/.exec(path)
  if (route !== null) {
    const slug = route[1] ?? ''
    const op = route[2] as RelayOp
    if (call.method === 'GET' && (op === 'status' || op === 'sessions')) return forward(ctx, slug, op, undefined, call.now)
    if (call.method === 'POST' && op === 'prompt') return forward(ctx, slug, op, call.body, call.now)
    return { status: 405, body: { error: 'method not allowed' } }
  }

  if (path.startsWith('/api/hub/paths') || path.startsWith('/api/relay/')) {
    return { status: call.local ? 404 : 403, body: { error: call.local ? 'not found' : '只能在中枢本机登记路径' } }
  }
  return null
}
