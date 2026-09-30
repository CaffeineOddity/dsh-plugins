import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dispatch, hasHubSession, type DispatchDeps } from './lib/dispatch.ts'
import { isControlApi, proxyGui, proxyUpgrade } from './lib/gui-proxy.ts'
import { admit } from './lib/policy.ts'

const PAGE = join(dirname(fileURLToPath(import.meta.url)), 'assets', 'index.html')
const MAX_BODY = 32 * 1024

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'cache-control': 'no-store',
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体超过 32KB'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
      } catch {
        reject(new Error('请求体不是 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  if (res.headersSent || res.writableEnded) return
  res.writeHead(status, { 'content-type': type, ...SECURITY_HEADERS })
  res.end(body)
}

export function apiPath(pathname: string): string {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  if (path === '/dsh-remote-access/api' || path.startsWith('/dsh-remote-access/api/')) {
    return path.slice('/dsh-remote-access'.length)
  }
  return path
}

export async function handleHttp(req: IncomingMessage, res: ServerResponse, deps: DispatchDeps, page: boolean): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = apiPath(url.pathname)
  const method = req.method ?? 'GET'
  if (page && method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
    res.writeHead(302, { location: '/dsh-remote-access', 'cache-control': 'no-store' })
    res.end()
    return
  }
  if (page && method === 'GET' && !path.startsWith('/api')) {
    try {
      send(res, 200, 'text/html; charset=utf-8', readFileSync(PAGE, 'utf8'))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      send(res, 500, 'text/plain; charset=utf-8', `页面还没构建（${message}）。请在插件目录执行 pnpm run build，然后刷新。\n`)
    }
    return
  }
  if (!path.startsWith('/api')) {
    send(res, 404, 'application/json; charset=utf-8', JSON.stringify({ error: 'not found' }))
    return
  }
  try {
    const body = method === 'GET' || method === 'DELETE' ? undefined : await readBody(req)
    const result = await dispatch({
      method,
      path,
      host: req.headers.host ?? '',
      remoteAddress: req.socket.remoteAddress ?? '',
      authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : '',
      cookie: typeof req.headers.cookie === 'string' ? req.headers.cookie : '',
      search: url.search,
      body,
      now: Date.now(),
    }, deps)
    const token = path === '/api/hub/login' && result.status === 200 && result.body !== null && typeof result.body === 'object' && 'token' in result.body
      ? String((result.body as { token: unknown }).token)
      : ''
    if (token.startsWith('hub_') && !token.includes(';')) {
      res.setHeader('set-cookie', `dsh_remote_hub=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200`)
    }
    send(res, result.status, 'application/json; charset=utf-8', JSON.stringify(result.body))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ error: message }))
  }
}

function servePage(res: ServerResponse): void {
  try {
    send(res, 200, 'text/html; charset=utf-8', readFileSync(PAGE, 'utf8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    send(res, 500, 'text/plain; charset=utf-8', `页面还没构建（${message}）。请在插件目录执行 pnpm run build，然后刷新。\n`)
  }
}

async function handlePublic(req: IncomingMessage, res: ServerResponse, deps: DispatchDeps, launchUrl: () => string): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname
  const decision = admit(req.socket.remoteAddress, req.headers.host, deps.state.publicOrigin)
  if (decision === 'reject') {
    send(res, 404, 'text/plain; charset=utf-8', 'not found\n')
    return
  }
  const authed = hasHubSession(deps.state, typeof req.headers.authorization === 'string' ? req.headers.authorization : '', typeof req.headers.cookie === 'string' ? req.headers.cookie : '', Date.now())
  if (decision === 'public' && authed && !isControlApi(path)) {
    if (path === '/dsh-remote-access' || path.startsWith('/dsh-remote-access/')) {
      res.writeHead(302, { location: '/', 'cache-control': 'no-store' })
      res.end()
      return
    }
    await proxyGui(req, res, launchUrl)
    return
  }
  if (decision === 'public' && !authed && !isControlApi(path)) {
    if ((req.method === 'GET' || req.method === 'HEAD') && !path.startsWith('/api')) {
      servePage(res)
      return
    }
    send(res, 401, 'text/plain; charset=utf-8', '需要先登录\n')
    return
  }
  await handleHttp(req, res, deps, decision !== 'public')
}

function rejectUpgrade(socket: Duplex, status: number): void {
  socket.write(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Not Found'}\r\nConnection: close\r\n\r\n`)
  socket.end()
}

/** 只绑定 loopback。调用方传入的 host 一律忽略。 */
export function listenLoopback(port: number, deps: DispatchDeps, launchUrl: () => string): Promise<Server> {
  const server = createServer((req, res) => {
    void handlePublic(req, res, deps, launchUrl).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      send(res, 500, 'application/json; charset=utf-8', JSON.stringify({ error: message }))
    })
  })
  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const decision = admit(req.socket.remoteAddress, req.headers.host, deps.state.publicOrigin)
    const authed = hasHubSession(deps.state, typeof req.headers.authorization === 'string' ? req.headers.authorization : '', typeof req.headers.cookie === 'string' ? req.headers.cookie : '', Date.now())
    if (decision !== 'public' || !authed || isControlApi(path)) {
      rejectUpgrade(socket, decision === 'public' ? 401 : 404)
      return
    }
    proxyUpgrade(req, socket, head, launchUrl)
  })
  server.requestTimeout = 0
  server.headersTimeout = 10_000
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}
