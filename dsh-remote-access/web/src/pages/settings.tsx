import { useEffect, useState } from 'react'
import { api } from '../api'
import { tunnelLabel, type Tunnel } from '../tunnel'

type Boot = {
  local: boolean
  deviceName?: string
  publicOrigin?: string
}

function hostOf(origin: string): string {
  return origin.replace(/^https:\/\//, '').replace(/\/$/, '')
}

export function SettingsPage() {
  const [error, setError] = useState('')
  const [boot, setBoot] = useState<Boot | null>(null)
  const [tunnel, setTunnel] = useState<Tunnel | null>(null)

  useEffect(() => {
    void api<Boot>('/hub/bootstrap').then(setBoot).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
    const timer = window.setInterval(() => {
      void api<Tunnel>('/hub/tunnel').then(setTunnel).catch(() => undefined)
    }, 3000)
    return () => window.clearInterval(timer)
  }, [])

  if (boot !== null && !boot.local) {
    return <p className="text-sm text-muted-foreground">设备信息只在这台电脑的本机页面查看。</p>
  }

  const host = hostOf(boot?.publicOrigin ?? '')

  return (
    <div className="mx-auto grid w-full max-w-3xl gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">设备</h1>
        <p className="text-sm text-muted-foreground">这台电脑用自己的子域名访问，没有路径前缀。</p>
      </div>
      {error !== '' ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="rounded-md border px-3 py-2 text-sm">
        <span className="font-medium">{boot?.deviceName || '这台 DSH'}</span>
        <span className="ml-2 text-muted-foreground">{host || '还没添加子域名'} · {tunnel ? tunnelLabel(tunnel) : '检测中'}</span>
      </div>
    </div>
  )
}
