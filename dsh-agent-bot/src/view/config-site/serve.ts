/**
 * 配置站静态页：GET /agent-bot 前缀，只服务白名单文件。
 * 页面源文件在 dist/config-site/assets/（tsup publicDir 从 src/view 复制）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** dist/config-site/assets：与 host 产物同级。 */
const SITE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'config-site', 'assets')

/** URL 末段 → 文件名（不含路径分隔）。 */
export const FILES: Record<string, string> = {
  '': 'skills.html',
  skills: 'skills.html',
  prompts: 'prompts.html',
  agents: 'agents.html',
  chat: 'chat.html',
  settings: 'settings.html',
  log: 'log.html',
  'site.css': 'site.css',
  'site.js': 'site.js',
}

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
}

/** 从 /agent-bot 或 /agent-bot/foo 取出白名单键；非法返回 null。 */
export function siteKey(pathname: string): string | null {
  if (pathname === '/agent-bot' || pathname === '/agent-bot/') return ''
  if (!pathname.startsWith('/agent-bot/')) return null
  const rest = pathname.slice('/agent-bot/'.length)
  if (rest === '' || rest.includes('/') || rest.includes('\\') || rest.includes('..')) return null
  return rest
}

function contentType(file: string): string {
  const ext = file.includes('.') ? file.slice(file.lastIndexOf('.') + 1) : 'html'
  return MIME[ext] ?? 'application/octet-stream'
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { 'content-type': type })
  res.end(body)
}

/** 注册 GET /agent-bot 前缀。返回取消函数；webServer 不可用时返回 null。 */
export function registerConfigSite(ctx: Context): (() => void) | null {
  const web = ctx.webServer
  if (!web || typeof web.register !== 'function') return null
  return web.register({
    kind: 'prefix',
    path: '/agent-bot',
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if ((req.method ?? 'GET') !== 'GET') {
        send(res, 405, 'text/plain; charset=utf-8', 'method not allowed')
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      const key = siteKey(pathname)
      const file = key === null ? undefined : FILES[key]
      if (file === undefined) {
        send(res, 404, 'text/plain; charset=utf-8', 'not found')
        return
      }
      const full = join(SITE_DIR, file)
      if (!existsSync(full)) {
        send(res, 404, 'text/plain; charset=utf-8', 'not found')
        return
      }
      send(res, 200, contentType(file), readFileSync(full))
    },
  })
}
