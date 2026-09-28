import { useEffect, useState } from 'react'
import { Button } from '@ui/components/ui/button'
import { api } from './api'

export type Tunnel = {
  installed: boolean
  authorized: boolean
  configured: boolean
  hostname: string
  running: boolean
  connected: boolean
  phase: 'idle' | 'installing' | 'authorizing' | 'configuring' | 'error'
  message: string
  loginUrl: string
}

export function tunnelLabel(tunnel: Tunnel): string {
  if (tunnel.phase === 'installing') return '正在安装'
  if (tunnel.phase === 'authorizing') return '等待授权'
  if (tunnel.phase === 'configuring') return '正在配置'
  if (tunnel.phase === 'error') return '出错'
  if (!tunnel.installed) return '未安装'
  if (!tunnel.authorized) return '未授权'
  if (!tunnel.configured) return '未配置'
  if (tunnel.connected) return '已连接'
  if (tunnel.running) return '启动中'
  return '已暂停'
}

export function TunnelControls() {
  const [tunnel, setTunnel] = useState<Tunnel | null>(null)
  const [error, setError] = useState('')

  async function refresh(): Promise<void> {
    const next = await api<Tunnel>('/hub/tunnel')
    setTunnel(next)
  }

  useEffect(() => {
    void refresh().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
    const timer = window.setInterval(() => {
      void refresh().catch(() => undefined)
    }, 3000)
    return () => window.clearInterval(timer)
  }, [])

  if (tunnel === null) return <p className="text-sm text-muted-foreground">正在检测通道…</p>

  return (
    <div className="grid gap-3">
      <p className="text-sm">通道状态：<span className="font-medium">{tunnelLabel(tunnel)}</span>{tunnel.hostname !== '' ? ` · ${tunnel.hostname}` : ''}</p>
      {tunnel.message !== '' ? <p className="text-sm text-muted-foreground">{tunnel.message}</p> : null}
      {tunnel.loginUrl !== '' ? <a className="text-sm underline" href={tunnel.loginUrl}>打开授权页</a> : null}
      {error !== '' ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="flex gap-2">
        <Button type="button" disabled={tunnel.connected || tunnel.running} onClick={() => void api('/hub/tunnel/start', { method: 'POST' }).then(refresh).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))}>启动</Button>
        <Button type="button" variant="outline" disabled={!tunnel.running && !tunnel.connected} onClick={() => void api('/hub/tunnel/stop', { method: 'POST' }).then(refresh).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))}>暂停</Button>
      </div>
    </div>
  )
}
