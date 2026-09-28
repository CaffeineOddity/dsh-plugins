import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { injectMobileSidebar } from './mobile-sidebar.ts'

const UPSTREAM_HOST = '127.0.0.1'
const UPSTREAM_PORT = 3080
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade', 'host', 'cookie', 'authorization'])

let upstreamCookie = ''

function controlPath(pathname: string): string {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  if (path === '/dsh-remote-access/api' || path.startsWith('/dsh-remote-access/api/')) return path.slice('/dsh-remote-access'.length)
  return path
}

export function isControlApi(pathname: string): boolean {
  const path = controlPath(pathname)
  return path === '/api/hub' || path.startsWith('/api/hub/')
    || path === '/api/relay' || path.startsWith('/api/relay/')
    || path === '/api/pair' || path.startsWith('/api/pair/')
    || path === '/api/v1' || path.startsWith('/api/v1/')
}

/** 只接受本机 3080 的启动地址，避免代理被指到别的主机。 */
export function launchToken(url: string): string {
  const parsed = new URL(url)
  if (parsed.hostname !== UPSTREAM_HOST || parsed.port !== String(UPSTREAM_PORT)) throw new Error('启动地址不是本机界面')
  const token = parsed.searchParams.get('token') ?? ''
  if (token === '' || token.includes('&') || token.includes(' ')) throw new Error('没有启动口令')
  return token
}

export function upstreamRequestHeaders(incoming: Record<string, string | string[] | undefined>, cookie: string): Record<string, string | string[] | undefined> {
  const headers: Record<string, string | string[] | undefined> = {
    host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}`,
    cookie,
  }
  for (const [key, value] of Object.entries(incoming)) {
    const name = key.toLowerCase()
    if (HOP.has(name) || name === 'sec-fetch-site' || name === 'origin' || name === 'referer' || value === undefined) continue
    headers[key] = value
  }
  headers.origin = `http://${UPSTREAM_HOST}:${UPSTREAM_PORT}`
  return headers
}

export function isPlainDocument(method: string, url: string | undefined): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false
  const path = new URL(url ?? '/', 'http://127.0.0.1').pathname
  if (path.startsWith('/api/')) return false
  const last = path.split('/').pop() ?? ''
  return !last.includes('.')
}

function upstreamHeaders(req: IncomingMessage, cookie: string): Record<string, string | string[] | undefined> {
  const headers = upstreamRequestHeaders(req.headers, cookie)
  if (isPlainDocument(req.method ?? 'GET', req.url)) delete headers['accept-encoding']
  return headers
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
}

function canInject(headers: IncomingMessage['headers']): boolean {
  const type = headerValue(headers['content-type'])
  const encoding = headerValue(headers['content-encoding'])
  return type.includes('text/html') && (encoding === '' || encoding === 'identity')
}

function readUpstream(up: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    up.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 16 * 1024 * 1024) {
        reject(new Error('页面过大'))
        up.destroy()
        return
      }
      chunks.push(chunk)
    })
    up.on('end', () => resolve(Buffer.concat(chunks)))
    up.on('error', reject)
  })
}

function exchange(token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      method: 'GET',
      path: `/?token=${encodeURIComponent(token)}`,
      headers: { host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` },
    }, (res) => {
      const raw = res.headers['set-cookie']
      const line = Array.isArray(raw) ? raw[0] : raw
      const pair = line?.split(';')[0] ?? ''
      res.resume()
      if (!pair.startsWith('dsh-auth-')) reject(new Error('本机界面没有签发登录'))
      else resolve(pair)
    })
    req.on('error', () => reject(new Error('本机界面没有连上')))
    req.end()
  })
}

async function ensureCookie(launchUrl: () => string): Promise<string> {
  if (upstreamCookie !== '') return upstreamCookie
  upstreamCookie = await exchange(launchToken(launchUrl()))
  return upstreamCookie
}

function responseHeaders(headers: IncomingMessage['headers']): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue
    const name = key.toLowerCase()
    if (HOP.has(name) || name === 'set-cookie') continue
    out[key] = value
  }
  return out
}

export async function proxyGui(req: IncomingMessage, res: ServerResponse, launchUrl: () => string): Promise<void> {
  const cookie = await ensureCookie(launchUrl)
  await new Promise<void>((resolve, reject) => {
    const upstream = httpRequest({
      hostname: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      method: req.method,
      path: req.url,
      headers: upstreamHeaders(req, cookie),
    }, (up) => {
      if (up.statusCode === 401) upstreamCookie = ''
      const headers = responseHeaders(up.headers)
      if (!canInject(up.headers)) {
        res.writeHead(up.statusCode ?? 502, headers)
        up.pipe(res)
        up.on('end', () => resolve())
        up.on('error', reject)
        return
      }
      void readUpstream(up).then((body) => {
        delete headers['content-length']
        res.writeHead(up.statusCode ?? 502, headers)
        res.end(injectMobileSidebar(body.toString('utf8')))
        resolve()
      }).catch(reject)
    })
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('本机 DSH 界面没有连上\n')
      resolve()
    })
    req.pipe(upstream)
  })
}

export function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, launchUrl: () => string): void {
  void ensureCookie(launchUrl).then((cookie) => {
    const headers = upstreamHeaders(req, cookie)
    headers.connection = 'upgrade'
    headers.upgrade = req.headers.upgrade ?? 'websocket'
    const upstream = httpRequest({
      hostname: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      method: 'GET',
      path: req.url,
      headers,
    })
    upstream.on('upgrade', (res, upSocket, upHead) => {
      const lines = [`HTTP/1.1 101 ${res.statusMessage ?? 'Switching Protocols'}`]
      for (const [key, value] of Object.entries(res.headers)) {
        if (value === undefined || key.toLowerCase() === 'set-cookie') continue
        const listed = Array.isArray(value) ? value : [value]
        for (const item of listed) lines.push(`${key}: ${item}`)
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (upHead.length > 0) socket.write(upHead)
      if (head.length > 0) upSocket.write(head)
      upSocket.pipe(socket)
      socket.pipe(upSocket)
      socket.on('error', () => upSocket.destroy())
      upSocket.on('error', () => socket.destroy())
    })
    upstream.on('error', () => socket.destroy())
    upstream.on('response', (res) => {
      socket.write(`HTTP/1.1 ${res.statusCode ?? 502} ${res.statusMessage ?? 'Bad Gateway'}\r\nConnection: close\r\n\r\n`)
      res.resume()
      socket.end()
    })
    upstream.end()
  }).catch(() => socket.destroy())
}
