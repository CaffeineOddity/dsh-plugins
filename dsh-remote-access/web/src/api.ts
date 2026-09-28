import { PLUGIN_ROUTE } from './prefs'

const TOKEN_KEY = 'dsh-remote-access:hub'

export function apiBase(): string {
  return `${PLUGIN_ROUTE}/api`
}

export function hubToken(): string {
  return sessionStorage.getItem(TOKEN_KEY) ?? ''
}

export function setHubToken(token: string): void {
  if (token === '') sessionStorage.removeItem(TOKEN_KEY)
  else sessionStorage.setItem(TOKEN_KEY, token)
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json')
  const token = hubToken()
  if (token !== '') headers.set('authorization', `Bearer ${token}`)
  const res = await fetch(`${apiBase()}${path}`, { ...init, headers })
  const data = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`)
  return data
}
