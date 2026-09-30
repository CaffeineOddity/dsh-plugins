import { admit, assertSlug } from './policy.ts'
import { hashEquals, hashPassphrase, open, randomToken, seal, sha256, verifyPassphrase } from './secrets.ts'
import type { PairedDevice, RemoteState } from './state.ts'
import { assertPrompt, assertSessionId, type ControlApi, type SessionView } from './control.ts'
import { pairDevice, requestDevice, type LookupFn } from './remote.ts'
import { RelayHub } from './relay.ts'
import { tryRelay, type RelayCtx } from './relay-dispatch.ts'
import { listHostDirectory } from './directories.ts'
import { beginTunnelSetup, startTunnel, stopTunnel, tunnelStatus } from './tunnel.ts'

const PAIR_TTL_MS = 5 * 60 * 1000
const HUB_TTL_MS = 12 * 60 * 60 * 1000
const WINDOW_MS = 15 * 60 * 1000
const WINDOW_LIMIT = 8

export interface DispatchInput {
  method: string
  path: string
  host: string
  remoteAddress: string
  authorization: string
  cookie?: string
  search?: string
  body: unknown
  now: number
}

export interface DispatchResult {
  status: number
  body: unknown
}

export interface DispatchDeps {
  state: RemoteState
  save: () => void
  control: ControlApi
  now: number
  lookup?: LookupFn
  pair?: typeof pairDevice
  pairAttempts: number[]
  loginAttempts: number[]
  enrollAttempts?: number[]
  relay?: RelayHub
  startedAt?: number
}

function gate(attempts: number[], now: number): boolean {
  const kept = attempts.filter((t) => now - t < WINDOW_MS)
  attempts.length = 0
  attempts.push(...kept)
  if (attempts.length >= WINDOW_LIMIT) return false
  attempts.push(now)
  return true
}

function bearer(header: string): string {
  const match = /^Bearer\s+(\S+)$/.exec(header.trim())
  return match?.[1] ?? ''
}

function deviceTokenHashes(state: RemoteState): string[] {
  const listed = state.tokenHashes.filter((hash) => hash !== '')
  if (listed.length > 0) return listed
  return state.tokenHash === '' ? [] : [state.tokenHash]
}

function deviceAuthed(state: RemoteState, header: string): boolean {
  const token = bearer(header)
  if (token === '') return false
  return deviceTokenHashes(state).some((hash) => hashEquals(token, hash))
}

export function readHubCookie(header: string): string {
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1 || segment.slice(0, at).trim() !== 'dsh_remote_hub') continue
    return segment.slice(at + 1).trim()
  }
  return ''
}

export function hasHubSession(state: RemoteState, authorization: string, cookieHeader: string, now: number): boolean {
  const token = bearer(authorization) || readHubCookie(cookieHeader)
  if (token === '' || !token.startsWith('hub_')) return false
  state.hubSessions = state.hubSessions.filter((s) => s.expiresAt > now)
  return state.hubSessions.some((s) => hashEquals(token, s.hash))
}

function hubAuthed(state: RemoteState, header: string, cookie: string, now: number): boolean {
  return hasHubSession(state, header, cookie, now)
}

function objectBody(body: unknown): Record<string, unknown> | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined
  return body as Record<string, unknown>
}

function exactKeys(body: Record<string, unknown>, keys: string[]): boolean {
  const got = Object.keys(body)
  return got.length === keys.length && keys.every((key) => got.includes(key))
}

function deviceView(device: PairedDevice): { id: string; name: string; origin: string; pairedAt: number } {
  return { id: device.id, name: device.name, origin: device.origin, pairedAt: device.pairedAt }
}

function activeOrigin(state: RemoteState): PairedDevice | 'this' | undefined {
  if (state.activeDeviceId === 'this') return 'this'
  return state.devices.find((d) => d.id === state.activeDeviceId)
}

async function callActive(deps: DispatchDeps, path: '/api/v1/status' | '/api/v1/sessions' | '/api/v1/prompt', method: string, now: number, body?: unknown): Promise<DispatchResult> {
  const active = activeOrigin(deps.state)
  if (active === undefined) return { status: 404, body: { error: '当前设备已解除绑定，请重新选择' } }
  if (active === 'this') {
    if (path === '/api/v1/status') {
      return { status: 200, body: { deviceId: deps.state.deviceId, name: deps.state.deviceName, uptimeMs: Math.max(0, now - startedAt) } }
    }
    if (path === '/api/v1/sessions') {
      const sessions = await deps.control.listSessions()
      return { status: 200, body: { sessions } }
    }
    const record = objectBody(body)
    if (record === undefined || typeof record.sessionId !== 'string' || typeof record.text !== 'string') {
      return { status: 400, body: { error: '需要 sessionId 和 text' } }
    }
    assertSessionId(record.sessionId)
    const text = assertPrompt(record.text)
    const known = await deps.control.listSessions()
    if (!known.some((s) => s.id === record.sessionId)) return { status: 404, body: { error: '这台设备没有这个会话' } }
    await deps.control.sendPrompt(record.sessionId, text)
    return { status: 200, body: { ok: true } }
  }
  const token = open(active, deps.state.hubKey)
  const result = await requestDevice(active.origin, path, { method, token, body, lookup: deps.lookup })
  return { status: result.status, body: result.json }
}

const startedAt = Date.now()

export async function dispatch(input: DispatchInput, deps: DispatchDeps): Promise<DispatchResult> {
  const admission = admit(input.remoteAddress, input.host, deps.state.publicOrigin)
  if (admission === 'reject') return { status: 404, body: { error: 'not found' } }
  const path = input.path.replace(/\/+$/, '') || '/'
  const local = admission === 'local'
  const hub = local || hubAuthed(deps.state, input.authorization, input.cookie ?? '', input.now)

  if (input.method === 'POST' && path === '/api/pair') {
    if (!gate(deps.pairAttempts, input.now)) return { status: 429, body: { error: '配对尝试过多，请稍后再试' } }
    const body = objectBody(input.body)
    if (body === undefined || !exactKeys(body, ['code']) || typeof body.code !== 'string') {
      return { status: 401, body: { error: '配对码无效或已过期' } }
    }
    const pairing = deps.state.pairing
    const ok = pairing !== null && pairing.expiresAt > input.now && hashEquals(body.code, pairing.hash)
    if (!ok) return { status: 401, body: { error: '配对码无效或已过期' } }
    const token = randomToken('dev')
    deps.state.pairing = null
    const hashes = deviceTokenHashes(deps.state)
    hashes.push(sha256(token))
    deps.state.tokenHashes = hashes.slice(-8)
    deps.state.tokenHash = deps.state.tokenHashes.at(-1) ?? ''
    deps.save()
    return { status: 200, body: { deviceId: deps.state.deviceId, name: deps.state.deviceName, token } }
  }

  if (input.method === 'GET' && path === '/api/v1/status' && deviceAuthed(deps.state, input.authorization)) {
    return { status: 200, body: { deviceId: deps.state.deviceId, name: deps.state.deviceName, uptimeMs: Math.max(0, input.now - startedAt) } }
  }
  if (input.method === 'GET' && path === '/api/v1/sessions' && deviceAuthed(deps.state, input.authorization)) {
    return { status: 200, body: { sessions: await deps.control.listSessions() } }
  }
  if (input.method === 'POST' && path === '/api/v1/prompt' && deviceAuthed(deps.state, input.authorization)) {
    const body = objectBody(input.body)
    if (body === undefined || !exactKeys(body, ['sessionId', 'text']) || typeof body.sessionId !== 'string' || typeof body.text !== 'string') {
      return { status: 400, body: { error: '需要 sessionId 和 text' } }
    }
    assertSessionId(body.sessionId)
    const text = assertPrompt(body.text)
    const known = await deps.control.listSessions()
    if (!known.some((s) => s.id === body.sessionId)) return { status: 404, body: { error: '这台设备没有这个会话' } }
    await deps.control.sendPrompt(body.sessionId, text)
    return { status: 200, body: { ok: true } }
  }
  if (path === '/api/v1/status' || path === '/api/v1/sessions' || path === '/api/v1/prompt') {
    return { status: 401, body: { error: '设备令牌无效' } }
  }

  if (input.method === 'POST' && path === '/api/hub/login') {
    if (!gate(deps.loginAttempts, input.now)) return { status: 429, body: { error: '登录尝试过多，请稍后再试' } }
    const body = objectBody(input.body)
    if (deps.state.hubPassHash === '' || body === undefined || typeof body.passphrase !== 'string' || !verifyPassphrase(body.passphrase, deps.state.hubPassHash)) {
      return { status: 401, body: { error: '口令不正确' } }
    }
    const token = randomToken('hub')
    deps.state.hubSessions.push({ hash: sha256(token), expiresAt: input.now + HUB_TTL_MS })
    deps.state.hubSessions = deps.state.hubSessions.slice(-3)
    deps.save()
    return { status: 200, body: { token } }
  }

  if (local && (path === '/api/hub/role' || path.startsWith('/api/hub/tunnel'))) {
    if (input.method === 'GET' && path === '/api/hub/tunnel') return { status: 200, body: tunnelStatus() }
    if (input.method === 'POST' && path === '/api/hub/role') {
      const body = objectBody(input.body)
      const role = body?.role
      if (role !== 'hub' && role !== 'spoke') return { status: 400, body: { error: '角色只能是 hub 或 spoke' } }
      deps.state.role = role
      deps.save()
      return { status: 200, body: { role } }
    }
    if (input.method === 'POST' && path === '/api/hub/tunnel/start') {
      try {
        startTunnel()
        deps.state.tunnelDesired = 'run'
        deps.state.role = 'hub'
        deps.save()
        return { status: 200, body: tunnelStatus() }
      } catch (error) {
        return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } }
      }
    }
    if (input.method === 'POST' && path === '/api/hub/tunnel/stop') {
      stopTunnel()
      deps.state.tunnelDesired = 'stop'
      deps.save()
      return { status: 200, body: tunnelStatus() }
    }
    if (input.method === 'POST' && path === '/api/hub/tunnel/setup') {
      const body = objectBody(input.body)
      if (body === undefined || typeof body.hostname !== 'string') return { status: 400, body: { error: '需要 hostname' } }
      try {
        beginTunnelSetup(body.hostname, (origin) => {
          deps.state.publicOrigin = origin
          if (deps.state.domainSuffix === '') deps.state.domainSuffix = new URL(origin).hostname
          deps.state.role = 'hub'
          deps.state.tunnelDesired = 'run'
          deps.save()
        })
      } catch (error) {
        return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } }
      }
      return { status: 200, body: tunnelStatus() }
    }
    return { status: 404, body: { error: 'not found' } }
  }

  if (deps.enrollAttempts === undefined) deps.enrollAttempts = []
  const relayCtx: RelayCtx = {
    state: deps.state,
    save: deps.save,
    control: deps.control,
    relay: deps.relay ?? new RelayHub(),
    enrollAttempts: deps.enrollAttempts,
    now: input.now,
    startedAt: deps.startedAt ?? startedAt,
    lookup: deps.lookup,
  }
  const relayed = await tryRelay({
    method: input.method,
    path,
    authorization: input.authorization,
    body: input.body,
    now: input.now,
    local,
    hub,
    gate,
  }, relayCtx)
  if (relayed !== null) return relayed

  if (!local && (path === '/api/hub/role' || path.startsWith('/api/hub/tunnel'))) {
    return { status: 404, body: { error: 'not found' } }
  }

  if (!hub) return { status: 401, body: { error: '需要先登录控制台' } }

  if (input.method === 'GET' && path === '/api/hub/directories') {
    const requested = new URL(`http://127.0.0.1${input.search ?? ''}`).searchParams.get('path') ?? undefined
    try {
      return { status: 200, body: await listHostDirectory(requested) }
    } catch (error) {
      return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } }
    }
  }

  if (input.method === 'GET' && path === '/api/hub/bootstrap') {
    return {
      status: 200,
      body: {
        local,
        deviceName: deps.state.deviceName,
        publicOrigin: local ? deps.state.publicOrigin : undefined,
        domainSuffix: local ? deps.state.domainSuffix : undefined,
        listenPort: deps.state.listenPort,
        hasPassphrase: deps.state.hubPassHash !== '',
        activeDeviceId: deps.state.activeDeviceId,
        selfSlug: deps.state.selfSlug,
        role: deps.state.role,
        spoke: deps.state.spoke === null ? null : { hubOrigin: deps.state.spoke.hubOrigin, slug: deps.state.spoke.slug },
      },
    }
  }

  if (local && input.method === 'POST' && path === '/api/hub/pairing') {
    const code = randomToken('pair')
    deps.state.pairing = { hash: sha256(code), expiresAt: input.now + PAIR_TTL_MS }
    deps.save()
    return { status: 200, body: { code, expiresAt: deps.state.pairing.expiresAt } }
  }
  if (local && input.method === 'POST' && path === '/api/hub/passphrase') {
    const body = objectBody(input.body)
    const passphrase = body?.passphrase
    if (typeof passphrase !== 'string' || passphrase.trim().length < 12) {
      return { status: 400, body: { error: '口令至少 12 个字符' } }
    }
    deps.state.hubPassHash = hashPassphrase(passphrase)
    deps.state.hubSessions = []
    deps.save()
    return { status: 200, body: { ok: true } }
  }
  if (local && input.method === 'POST' && path === '/api/hub/settings') {
    const body = objectBody(input.body)
    if (body === undefined) return { status: 400, body: { error: '设置格式不对' } }
    if (typeof body.deviceName === 'string' && body.deviceName.trim() !== '') deps.state.deviceName = body.deviceName.trim().slice(0, 40)
    if (typeof body.domainSuffix === 'string') deps.state.domainSuffix = body.domainSuffix.trim().toLowerCase().replace(/^\.+/, '')
    if (typeof body.publicOrigin === 'string') {
      const origin = body.publicOrigin.trim()
      if (origin !== '' && !origin.startsWith('https://')) return { status: 400, body: { error: '公网地址必须是 https' } }
      deps.state.publicOrigin = origin === '' ? '' : new URL(origin).origin
    }
    if (typeof body.listenPort === 'number' && Number.isInteger(body.listenPort) && body.listenPort >= 1024 && body.listenPort <= 65535) {
      deps.state.listenPort = body.listenPort
    }
    if (typeof body.selfSlug === 'string' && body.selfSlug.trim() !== '') {
      try {
        const slug = assertSlug(body.selfSlug)
        if (deps.state.paths.some((slot) => slot.slug === slug)) return { status: 400, body: { error: '这条路径已经登记给别的电脑' } }
        deps.state.selfSlug = slug
      } catch (error) {
        return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } }
      }
    }
    deps.save()
    return { status: 200, body: { ok: true, listenPort: deps.state.listenPort } }
  }

  if (input.method === 'GET' && path === '/api/hub/devices') {
    return {
      status: 200,
      body: {
        activeDeviceId: deps.state.activeDeviceId,
        devices: [{ id: 'this', name: deps.state.deviceName, origin: 'local', pairedAt: 0 }, ...deps.state.devices.map(deviceView)],
      },
    }
  }
  if (input.method === 'POST' && path === '/api/hub/devices') {
    const body = objectBody(input.body)
    if (body === undefined || !exactKeys(body, ['origin', 'code']) || typeof body.origin !== 'string' || typeof body.code !== 'string') {
      return { status: 400, body: { error: '需要 origin 和 code' } }
    }
    let paired: Awaited<ReturnType<typeof pairDevice>>
    try {
      paired = await (deps.pair ?? pairDevice)(body.origin, body.code, deps.state.domainSuffix, deps.lookup)
    } catch (error) {
      return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } }
    }
    const sealed = seal(paired.token, deps.state.hubKey)
    const row: PairedDevice = { id: paired.deviceId, name: paired.name, origin: paired.origin, ...sealed, pairedAt: input.now }
    deps.state.devices = deps.state.devices.filter((d) => d.origin !== paired.origin && d.id !== paired.deviceId)
    deps.state.devices.push(row)
    deps.state.activeDeviceId = row.id
    deps.save()
    return { status: 200, body: { device: deviceView(row) } }
  }
  if (input.method === 'POST' && path === '/api/hub/active') {
    const body = objectBody(input.body)
    const id = body?.deviceId
    if (typeof id !== 'string') return { status: 400, body: { error: '需要 deviceId' } }
    if (id !== 'this' && !deps.state.devices.some((d) => d.id === id)) return { status: 404, body: { error: '没有这台已绑定的设备' } }
    deps.state.activeDeviceId = id
    deps.save()
    return { status: 200, body: { activeDeviceId: id } }
  }
  if (input.method === 'DELETE' && path.startsWith('/api/hub/devices/')) {
    const id = decodeURIComponent(path.slice('/api/hub/devices/'.length))
    if (id === '' || id.includes('/') || id.includes('\\')) return { status: 404, body: { error: 'not found' } }
    if (id === 'this') return { status: 400, body: { error: '不能解除本机' } }
    deps.state.devices = deps.state.devices.filter((d) => d.id !== id)
    if (deps.state.activeDeviceId === id) deps.state.activeDeviceId = 'this'
    deps.save()
    return { status: 200, body: { ok: true } }
  }
  if (input.method === 'GET' && path === '/api/hub/active/status') return callActive(deps, '/api/v1/status', 'GET', input.now)
  if (input.method === 'GET' && path === '/api/hub/active/sessions') return callActive(deps, '/api/v1/sessions', 'GET', input.now)
  if (input.method === 'POST' && path === '/api/hub/active/prompt') {
    const body = objectBody(input.body)
    if (body === undefined || !exactKeys(body, ['sessionId', 'text'])) return { status: 400, body: { error: '需要 sessionId 和 text' } }
    return callActive(deps, '/api/v1/prompt', 'POST', input.now, { sessionId: body.sessionId, text: body.text })
  }

  return { status: 404, body: { error: 'not found' } }
}

export type { SessionView }
