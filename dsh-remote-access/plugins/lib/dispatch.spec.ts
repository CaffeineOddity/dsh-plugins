import { describe, expect, it } from 'vitest'
import { dispatch, type DispatchDeps } from './dispatch.ts'
import { RelayHub } from './relay.ts'
import { hashPassphrase, randomToken, sha256 } from './secrets.ts'
import { defaultState, type RemoteState } from './state.ts'
import type { SessionView } from './control.ts'

function deps(patch: Partial<RemoteState> = {}): DispatchDeps & { sessions: SessionView[]; prompts: string[] } {
  const state = { ...defaultState(), publicOrigin: 'https://hub.dsh.example.com', domainSuffix: 'dsh.example.com', ...patch }
  const sessions: SessionView[] = [{ id: 'session-aaaaaaaa', cwd: '/tmp/proj', live: true }]
  const prompts: string[] = []
  return {
    state,
    save: () => undefined,
    now: 1_000_000,
    pairAttempts: [],
    loginAttempts: [],
    sessions,
    prompts,
    control: {
      async listSessions() { return sessions },
      async sendPrompt(sessionId, text) { prompts.push(`${sessionId}:${text}`) },
    },
  }
}

function local(path: string, method = 'GET', body?: unknown) {
  return { method, path, host: '127.0.0.1:3921', remoteAddress: '127.0.0.1', authorization: '', body, now: 1_000_000 }
}

function pub(path: string, method = 'GET', body?: unknown, authorization = '') {
  return { method, path, host: 'hub.dsh.example.com', remoteAddress: '127.0.0.1', authorization, body, now: 1_000_000 }
}

describe('dispatch 安全边界', () => {
  it('错误 Host 不暴露接口', async () => {
    const result = await dispatch({ ...pub('/api/v1/status'), host: 'evil.example' }, deps())
    expect(result.status).toBe(404)
  })

  it('公网不能生成配对码，本机可以，配对码只能用一次', async () => {
    const bag = deps()
    expect((await dispatch({ ...pub('/api/hub/pairing'), method: 'POST' }, bag)).status).toBe(401)
    const minted = await dispatch({ ...local('/api/hub/pairing'), method: 'POST' }, bag)
    expect(minted.status).toBe(200)
    const code = (minted.body as { code: string }).code
    const paired = await dispatch({ ...pub('/api/pair'), method: 'POST', body: { code } }, bag)
    expect(paired.status).toBe(200)
    expect(typeof (paired.body as { token: string }).token).toBe('string')
    expect((await dispatch({ ...pub('/api/pair'), method: 'POST', body: { code } }, bag)).status).toBe(401)
    expect(JSON.stringify(paired.body)).not.toContain(bag.state.hubKey)
  })

  it('没有设备令牌不能列会话或发送', async () => {
    const bag = deps()
    expect((await dispatch(pub('/api/v1/sessions'), bag)).status).toBe(401)
    expect((await dispatch({ ...pub('/api/v1/prompt'), method: 'POST', body: { sessionId: 'session-aaaaaaaa', text: 'hi' } }, bag)).status).toBe(401)
    expect(bag.prompts).toEqual([])
  })

  it('设备令牌只能打已有会话，多余字段被拒绝', async () => {
    const token = randomToken('dev')
    const bag = deps({ tokenHash: sha256(token) })
    const ok = await dispatch({
      ...pub('/api/v1/prompt'),
      method: 'POST',
      authorization: `Bearer ${token}`,
      body: { sessionId: 'session-aaaaaaaa', text: '继续' },
    }, bag)
    expect(ok.status).toBe(200)
    const extra = await dispatch({
      ...pub('/api/v1/prompt'),
      method: 'POST',
      authorization: `Bearer ${token}`,
      body: { sessionId: 'session-aaaaaaaa', text: '继续', url: 'http://127.0.0.1' },
    }, bag)
    expect(extra.status).toBe(400)
    const missing = await dispatch({
      ...pub('/api/v1/prompt'),
      method: 'POST',
      authorization: `Bearer ${token}`,
      body: { sessionId: 'not-a-session', text: '继续' },
    }, bag)
    expect(missing.status).toBe(404)
  })

  it('两台不同设备可以同时留下，第二台不顶掉第一台', async () => {
    const bag = deps()
    bag.pair = async (origin) => ({
      origin,
      deviceId: origin.includes('mac') ? 'device-mac' : 'device-mini',
      name: origin.includes('mac') ? 'Mac' : 'Mini',
      token: origin.includes('mac') ? 'dev_mac' : 'dev_mini',
    })
    const first = await dispatch({
      ...local('/api/hub/devices'),
      method: 'POST',
      body: { origin: 'https://mac.dsh.example.com', code: 'pair_a' },
    }, bag)
    const second = await dispatch({
      ...local('/api/hub/devices'),
      method: 'POST',
      body: { origin: 'https://mini.dsh.example.com', code: 'pair_b' },
    }, bag)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(bag.state.devices.map((d) => d.id)).toEqual(['device-mac', 'device-mini'])
    expect(bag.state.activeDeviceId).toBe('device-mini')
    const listed = await dispatch(local('/api/hub/devices'), bag)
    const ids = (listed.body as { devices: Array<{ id: string }> }).devices.map((d) => d.id)
    expect(ids).toEqual(['this', 'device-mac', 'device-mini'])
  })

  it('绑定不接受后缀外的地址，且不会发起请求', async () => {
    const bag = deps({ hubPassHash: hashPassphrase('correct horse battery') })
    bag.lookup = async () => { throw new Error('不应解析') }
    const result = await dispatch({
      ...local('/api/hub/devices'),
      method: 'POST',
      body: { origin: 'https://evil.example.com', code: 'pair_x' },
    }, bag)
    expect(result.status).toBe(400)
    expect(String((result.body as { error: string }).error)).toMatch(/dsh\.example\.com/)
  })

  it('公网不能看或启停隧道', async () => {
    const bag = deps()
    expect((await dispatch(pub('/api/hub/tunnel'), bag)).status).toBe(404)
    expect((await dispatch({ ...pub('/api/hub/tunnel/stop'), method: 'POST' }, bag)).status).toBe(404)
    const seen = await dispatch(local('/api/hub/tunnel'), bag)
    expect(seen.status).toBe(200)
    expect(typeof (seen.body as { connected: boolean }).connected).toBe('boolean')
  })

  it('路径槽接入码只用一次，未登录不能走 /inc，在线后才转发', async () => {
    const relay = new RelayHub()
    const bag = deps()
    bag.relay = relay
    expect((await dispatch({ ...pub('/api/hub/paths'), method: 'POST', body: { slug: 'inc', name: '公司' } }, bag)).status).toBe(401)
    const minted = await dispatch({ ...local('/api/hub/paths'), method: 'POST', body: { slug: 'inc', name: '公司' } }, bag)
    expect(minted.status).toBe(200)
    const code = (minted.body as { code: string }).code
    const enrolled = await dispatch({ ...pub('/api/relay/enroll'), method: 'POST', body: { slug: 'inc', code } }, bag)
    expect(enrolled.status).toBe(200)
    const token = (enrolled.body as { token: string }).token
    expect(token.startsWith('relay_')).toBe(true)
    expect(JSON.stringify(enrolled.body)).not.toContain(code)
    expect((await dispatch({ ...pub('/api/relay/enroll'), method: 'POST', body: { slug: 'inc', code } }, bag)).status).toBe(401)
    expect((await dispatch(pub('/api/hub/route/inc/sessions'), bag)).status).toBe(401)

    const offline = await dispatch(local('/api/hub/route/inc/sessions'), bag)
    expect(offline.status).toBe(503)

    const home = await dispatch(local('/api/hub/route/home/sessions'), bag)
    expect(home.status).toBe(200)
    expect((home.body as { sessions: Array<{ id: string }> }).sessions[0]?.id).toBe('session-aaaaaaaa')

    await dispatch({ ...pub('/api/relay/poll'), method: 'POST', authorization: `Bearer ${token}` }, bag)
    const pending = dispatch(local('/api/hub/route/inc/sessions'), bag)
    const polled = await dispatch({ ...pub('/api/relay/poll'), method: 'POST', authorization: `Bearer ${token}` }, bag)
    const job = (polled.body as { job: { id: string; op: string } | null }).job
    expect(job?.op).toBe('sessions')
    const done = await dispatch({
      ...pub('/api/relay/result'),
      method: 'POST',
      authorization: `Bearer ${token}`,
      body: { id: job?.id, status: 200, body: { sessions: [{ id: 'session-bbbbbbbb', cwd: '/work', live: false }] } },
    }, bag)
    expect(done.status).toBe(200)
    const routed = await pending
    expect(routed.status).toBe(200)
    expect((routed.body as { sessions: Array<{ id: string }> }).sessions[0]?.id).toBe('session-bbbbbbbb')
  })
})
