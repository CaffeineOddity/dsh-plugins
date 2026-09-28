import { useState } from 'react'
import { Button } from '@ui/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ui/components/ui/card'
import { Input } from '@ui/components/ui/input'
import { api, setHubToken } from './api'

export function isPublicSite(): boolean {
  return location.hostname !== '127.0.0.1' && location.hostname !== 'localhost'
}

export function PublicLogin() {
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState('')

  async function onLogin(): Promise<void> {
    setError('')
    const result = await api<{ token: string }>('/hub/login', { method: 'POST', body: JSON.stringify({ passphrase }) })
    setHubToken(result.token)
    location.assign('/')
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>登录</CardTitle>
          <CardDescription>先输入访问口令。未登录不显示设备。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="访问口令" />
          <Button type="button" onClick={() => void onLogin().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))}>登录</Button>
          {error !== '' ? <p className="text-sm text-destructive">{error}</p> : null}
        </CardContent>
      </Card>
    </div>
  )
}
