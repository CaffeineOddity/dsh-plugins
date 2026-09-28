import { useEffect, useState } from 'react'
import { Button } from '@ui/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ui/components/ui/card'
import { Input } from '@ui/components/ui/input'
import { api, setHubToken } from '../api'
import { routeSlug } from '../shell'
import { ChannelsPage } from '../channels'

type Device = { id: string; name: string; origin: string }
type Session = { id: string; cwd: string; live: boolean }

export function OverviewPage() {
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [login, setLogin] = useState('')
  const [needLogin, setNeedLogin] = useState(false)
  const [devices, setDevices] = useState<Device[]>([])
  const [active, setActive] = useState('this')
  const [origin, setOrigin] = useState('')
  const [code, setCode] = useState('')
  const [sessions, setSessions] = useState<Session[]>([])
  const [sessionId, setSessionId] = useState('')
  const [text, setText] = useState('')
  const [localAdmin, setLocalAdmin] = useState(false)

  const slug = routeSlug()

  async function load(): Promise<void> {
    if (slug !== null) {
      const sessionList = await api<{ sessions: Session[] }>(`/hub/route/${slug}/sessions`)
      setSessions(sessionList.sessions)
      setSessionId((current) => current || sessionList.sessions[0]?.id || '')
      setNeedLogin(false)
      return
    }
    const listed = await api<{ devices: Device[]; activeDeviceId: string }>('/hub/devices')
    setDevices(listed.devices)
    setActive(listed.activeDeviceId)
    setNeedLogin(false)
    const sessionList = await api<{ sessions: Session[] }>('/hub/active/sessions')
    setSessions(sessionList.sessions)
    setSessionId((current) => current || sessionList.sessions[0]?.id || '')
  }

  useEffect(() => {
    void api<{ local: boolean }>('/hub/bootstrap').then((data) => setLocalAdmin(data.local)).catch(() => setLocalAdmin(false))
    void load().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('登录')) setNeedLogin(true)
      else setError(message)
    })
  }, [])

  async function onLogin(): Promise<void> {
    setError('')
    const result = await api<{ token: string }>('/hub/login', { method: 'POST', body: JSON.stringify({ passphrase: login }) })
    setHubToken(result.token)
    setLogin('')
    if (location.hostname !== '127.0.0.1' && location.hostname !== 'localhost') {
      location.assign('/')
      return
    }
    await load()
  }

  async function bind(): Promise<void> {
    setError('')
    await api('/hub/devices', { method: 'POST', body: JSON.stringify({ origin, code }) })
    setOrigin('')
    setCode('')
    setNotice('已绑定。设备令牌只留在这台控制台，不会出现在浏览器里。')
    await load()
  }

  async function unbind(id: string): Promise<void> {
    setError('')
    await api(`/hub/devices/${encodeURIComponent(id)}`, { method: 'DELETE' })
    setNotice('已解除这一台，其他绑定还在。')
    await load()
  }

  async function useDevice(id: string): Promise<void> {
    setError('')
    await api('/hub/active', { method: 'POST', body: JSON.stringify({ deviceId: id }) })
    await load()
  }

  async function send(): Promise<void> {
    setError('')
    await api(slug !== null ? `/hub/route/${slug}/prompt` : '/hub/active/prompt', { method: 'POST', body: JSON.stringify({ sessionId, text }) })
    setText('')
    setNotice('已送到当前设备的会话。')
  }

  if (localAdmin && slug === null) return <ChannelsPage />

  if (needLogin) {
    return (
      <Card className="mx-auto w-full max-w-md">
        <CardHeader>
          <CardTitle>登录控制台</CardTitle>
          <CardDescription>登录后进入这台电脑自己的 DSH，不是一个只能发一句话的页面。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Input type="password" value={login} onChange={(e) => setLogin(e.target.value)} placeholder="控制台口令" />
          <Button type="button" onClick={() => void onLogin().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))}>登录</Button>
          {error !== '' ? <p className="text-sm text-destructive">{error}</p> : null}
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="mx-auto grid w-full max-w-3xl gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{slug !== null ? `/${slug}` : '通道'}</h1>
        <p className="text-sm text-muted-foreground">{slug !== null ? '这条路径对应一台已登录中枢的电脑。没连上时发送会失败，不会改去打它的内网。' : '通道在本机页面添加。'}</p>
      </div>
      {error !== '' ? <p className="text-sm text-destructive">{error}</p> : null}
      {notice !== '' ? <p className="text-sm text-muted-foreground">{notice}</p> : null}
      {slug !== null || localAdmin ? null : <><div className="grid gap-2">
        {devices.map((device) => (
          <button key={device.id} type="button" className="flex items-center justify-between rounded-md border px-3 py-2 text-left" onClick={() => void useDevice(device.id).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))}>
            <span>
              <span className="block text-sm font-medium">{device.name}</span>
              <span className="block text-xs text-muted-foreground">{device.origin}</span>
            </span>
            <span className="flex items-center gap-2 text-xs">
              <span>{device.id === active ? '当前' : '切换'}</span>
              {device.id === 'this' ? null : (
                <span className="underline" onClick={(event) => { event.stopPropagation(); void unbind(device.id).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))) }}>解除</span>
              )}
            </span>
          </button>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>绑定另一台</CardTitle>
          <CardDescription>地址必须是已设置后缀下的 https 主机名。配对码在那台设备的本机设置页生成。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Input value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="https://mac.dsh.example.com" />
          <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="配对码" />
          <Button type="button" onClick={() => void bind().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))}>绑定</Button>
        </CardContent>
      </Card></>}
      {localAdmin && slug === null ? (
        <p className="text-sm text-muted-foreground">这台电脑的完整功能就在当前 DSH 里。公网打开域名并登录后，也是同一套界面，不是一个发送框。</p>
      ) : null}
      {localAdmin && slug === null ? null : (<Card>
        <CardHeader>
          <CardTitle>{slug !== null ? `发送到 /${slug}` : '发送到当前设备'}</CardTitle>
          <CardDescription>只能选择这台设备已经有的会话，不能指定新的目录。公司电脑的完整界面还不能经出站轮询打开。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <select className="h-8 rounded-md border bg-background px-2 text-sm" value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
            {sessions.length === 0 ? <option value="">没有会话</option> : null}
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>{session.live ? '运行中' : '未运行'} {session.cwd || session.id}</option>
            ))}
          </select>
          <textarea className="min-h-24 rounded-md border bg-background px-2 py-1 text-sm" value={text} onChange={(e) => setText(e.target.value)} placeholder="要发给这个会话的内容" />
          <Button type="button" disabled={sessionId === '' || text.trim() === ''} onClick={() => void send().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))}>发送</Button>
        </CardContent>
      </Card>)}
    </div>
  )
}
