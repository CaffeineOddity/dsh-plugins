// 远程接入：本机页面只对 loopback 开放；公网控制面是另一个 127.0.0.1 端口。
// cloudflared 只能指向那个端口，不能指向 DSH 的 3080。

import type { Context } from '@deepseek-ai/cordis'
import type { Server } from 'node:http'
import '@deepseek-ai/dsh-host-webserver'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ControlApi, SessionView } from './lib/control.ts'
import { isLocalAdmin } from './lib/policy.ts'
import { loadState, saveState, type RemoteState } from './lib/state.ts'
import { RelayHub } from './lib/relay.ts'
import { spokeOnce } from './lib/spoke.ts'
import { startTunnel } from './lib/tunnel.ts'
import { handleHttp, listenLoopback } from './server.ts'

export const name = 'dsh-remote-access'
export const inject = ['webServer']

interface AgentsApi {
  get(id: string): { followup(message: unknown): void } | undefined
  resume(options: { resumeSessionId: string }): Promise<{ agent: { followup(message: unknown): void } }>
}

interface SessionQueryApi {
  listSessions(): Promise<Array<{ header: { id: string; cwd?: string }; live: boolean }>>
}

function controlFor(ctx: Context): ControlApi {
  return {
    async listSessions(): Promise<SessionView[]> {
      const query = ctx.get('sessionQuery') as SessionQueryApi | undefined
      if (query === undefined) return []
      const rows = await query.listSessions()
      return rows.slice(0, 50).map((row) => ({
        id: String(row.header.id),
        cwd: row.header.cwd ?? '',
        live: row.live === true,
      }))
    },
    async sendPrompt(sessionId, text): Promise<void> {
      const agents = ctx.get('agents') as AgentsApi | undefined
      if (agents === undefined) throw new Error('宿主没有 agents 服务，不能发送')
      let agent = agents.get(sessionId)
      if (agent === undefined) {
        const handle = await agents.resume({ resumeSessionId: sessionId })
        agent = handle.agent
      }
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    },
  }
}

export function apply(ctx: Context): void {
  const web = ctx.webServer
  if (typeof web?.register !== 'function') throw new Error('webServer.register 不可用，插件无法挂页面')
  const state = loadState()
  const deps = {
    state,
    save: () => saveState(state),
    control: controlFor(ctx),
    now: Date.now(),
    pairAttempts: [] as number[],
    loginAttempts: [] as number[],
    enrollAttempts: [] as number[],
    relay: new RelayHub(),
  }
  let server: Server | undefined
  let spokeBusy = false

  async function restart(next: RemoteState): Promise<void> {
    server?.close()
    server = undefined
    try {
      server = await listenLoopback(next.listenPort, { ...deps, now: Date.now() }, () => {
        const connection = ctx.get('connection') as { authenticatedUrl?(base: string): string } | undefined
        if (typeof connection?.authenticatedUrl !== 'function') throw new Error('宿主没有 connection 服务，不能打开完整界面')
        return connection.authenticatedUrl('http://127.0.0.1:3080')
      })
      ctx.logger?.info?.(`dsh-remote-access: 控制面监听 127.0.0.1:${next.listenPort}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.error?.(`dsh-remote-access: 控制面监听失败: ${message}`)
    }
  }

  void restart(state)
  if (state.tunnelDesired === 'run') {
    try {
      startTunnel()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.error?.(`dsh-remote-access: 隧道未启动: ${message}`)
    }
  }

  const spokeTimer = setInterval(() => {
    if (spokeBusy || state.spoke === null) return
    spokeBusy = true
    void spokeOnce(state, deps.control).then(
      () => undefined,
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger?.error?.(`dsh-remote-access: 出站连中枢失败: ${message}`)
      },
    ).finally(() => {
      spokeBusy = false
    })
  }, 2000)
  spokeTimer.unref()

  web.register({
    kind: 'prefix',
    path: '/dsh-remote-access',
    handler(req, res) {
      if (!isLocalAdmin(req.socket.remoteAddress, req.headers.host)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end('not found')
        return
      }
      deps.now = Date.now()
      const before = state.listenPort
      void handleHttp(req, res, deps, true).then(() => {
        if (state.listenPort !== before) void restart(state)
      })
    },
  })

  ctx.effect(() => () => {
    clearInterval(spokeTimer)
    server?.close()
  })
}
