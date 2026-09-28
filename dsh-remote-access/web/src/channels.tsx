import { useEffect, useState } from 'react'
import { Button } from '@ui/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@ui/components/ui/dialog'
import { Input } from '@ui/components/ui/input'
import { api } from './api'
import { tunnelLabel, type Tunnel } from './tunnel'

type Boot = {
  deviceName?: string
  publicOrigin?: string
  hasPassphrase: boolean
}

function hostOf(origin: string): string {
  return origin.replace(/^https:\/\//, '').replace(/\/$/, '')
}

export function ChannelsPage() {
  const [error, setError] = useState('')
  const [boot, setBoot] = useState<Boot | null>(null)
  const [tunnel, setTunnel] = useState<Tunnel | null>(null)
  const [open, setOpen] = useState(false)
  const [hostname, setHostname] = useState('')
  const [passphrase, setPassphrase] = useState('')

  async function load(): Promise<void> {
    const data = await api<Boot>('/hub/bootstrap')
    setBoot(data)
    setTunnel(await api<Tunnel>('/hub/tunnel'))
  }

  useEffect(() => {
    void load().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
    const timer = window.setInterval(() => {
      void api<Tunnel>('/hub/tunnel').then(setTunnel).catch(() => undefined)
    }, 3000)
    return () => window.clearInterval(timer)
  }, [])

  async function save(): Promise<void> {
    const host = hostOf(hostname.trim())
    if (host === '' || host.includes('/') || host.includes(':')) throw new Error('只填子域名，例如 mac.dsh.example.com')
    if (passphrase.trim().length < 12) throw new Error('访问口令至少 12 个字符')
    await api('/hub/settings', {
      method: 'POST',
      body: JSON.stringify({
        deviceName: boot?.deviceName || '这台 DSH',
        publicOrigin: `https://${host}`,
        domainSuffix: host,
        listenPort: 3921,
        selfSlug: 'home',
      }),
    })
    await api('/hub/passphrase', { method: 'POST', body: JSON.stringify({ passphrase }) })
    setPassphrase('')
    setOpen(false)
    await load()
  }

  async function install(host: string): Promise<void> {
    await api('/hub/tunnel/setup', { method: 'POST', body: JSON.stringify({ hostname: host }) })
    await load()
  }

  const host = hostOf(boot?.publicOrigin ?? tunnel?.hostname ?? '')
  const busy = tunnel?.phase === 'installing' || tunnel?.phase === 'authorizing' || tunnel?.phase === 'configuring'

  return (
    <div className="mx-auto grid w-full max-w-3xl gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">通道</h1>
          <p className="text-sm text-muted-foreground">一台设备一个子域名。添加后出现在下面，打开这个域名就是这台 DSH。</p>
        </div>
        <Button type="button" onClick={() => { setError(''); setOpen(true) }}>添加</Button>
      </div>
      {error !== '' ? <p className="text-sm text-destructive">{error}</p> : null}
      {host !== '' || boot?.hasPassphrase ? (
        <div className="flex items-center justify-between gap-3 rounded-md border p-3">
          <div>
            <p className="text-sm font-medium">{host || '未填域名'}</p>
            <p className="text-sm text-muted-foreground">{tunnel ? tunnelLabel(tunnel) : '检测中'}</p>
          </div>
          <div className="flex gap-2">
            <Button type="button" disabled={host === '' || busy} onClick={() => void install(host).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))}>安装+连接</Button>
            <Button type="button" variant="outline" disabled={!tunnel?.running && !tunnel?.connected} onClick={() => void api('/hub/tunnel/stop', { method: 'POST' }).then(load).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))}>暂停</Button>
          </div>
        </div>
      ) : <p className="text-sm text-muted-foreground">还没有通道。点添加。</p>}
      {tunnel?.message !== '' && host !== '' ? <p className="text-sm text-muted-foreground">{tunnel?.message}</p> : null}
      {tunnel?.loginUrl ? <a className="text-sm underline" href={tunnel.loginUrl}>打开授权页</a> : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加设备</DialogTitle>
            <DialogDescription>填这台电脑的子域名和访问口令。保存后点安装+连接。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Input value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="mac.dsh.example.com" />
            <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="访问口令，至少 12 个字符" />
            <Button type="button" onClick={() => void save().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))}>保存</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
