// __PLUGIN_NAME__ 页面与健康检查。
// 页面是 Vite 打出的单文件 HTML，每次请求重读，改完 build 后刷新即可。
// /api 必须单独注册为更长的 prefix：webServer 最长前缀优先，否则会被页面路由吞掉。

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import '@deepseek-ai/dsh-host-webserver'

export const name = '__PLUGIN_NAME__'
export const inject = ['webServer']

const ROUTE = '__PLUGIN_ROUTE__'
const API_ROUTE = `${ROUTE}/api`
const PAGE = join(dirname(fileURLToPath(import.meta.url)), 'assets', 'index.html')

function pathnameOf(req: IncomingMessage): string {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) return url.pathname.replace(/\/+$/, '')
  return url.pathname
}

function send(res: ServerResponse, status: number, type: string, body: string, extra?: Record<string, string>): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-cache', ...extra })
  res.end(body)
}

function servePage(res: ServerResponse): void {
  try {
    send(res, 200, 'text/html; charset=utf-8', readFileSync(PAGE, 'utf8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    send(res, 500, 'text/plain; charset=utf-8', `页面还没构建（${message}）。请在插件目录执行 pnpm run build，然后刷新。\n`)
  }
}

export function apply(ctx: Context): void {
  const web = ctx.webServer
  if (typeof web?.register !== 'function') {
    throw new Error('webServer.register 不可用，插件无法挂页面')
  }

  web.register({
    kind: 'prefix',
    path: API_ROUTE,
    handler(req, res) {
      const method = req.method ?? 'GET'
      const pathname = pathnameOf(req)
      if (method !== 'GET') {
        send(res, 405, 'application/json; charset=utf-8', JSON.stringify({ error: 'method not allowed' }), { allow: 'GET' })
        return
      }
      if (pathname !== `${API_ROUTE}/health`) {
        send(res, 404, 'application/json; charset=utf-8', JSON.stringify({ error: 'not found' }))
        return
      }
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify({
        ok: true,
        name: '__PLUGIN_NAME__',
        version: '__PLUGIN_VERSION__',
      }))
    },
  })

  web.register({
    kind: 'prefix',
    path: ROUTE,
    handler(req, res) {
      if ((req.method ?? 'GET') !== 'GET') {
        send(res, 405, 'text/plain; charset=utf-8', 'method not allowed', { allow: 'GET' })
        return
      }
      servePage(res)
    },
  })
}
