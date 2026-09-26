import { useEffect, useState } from 'react'
import { Button } from '@ui/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ui/components/ui/card'
import { PLUGIN_NAME, PLUGIN_ROUTE, PLUGIN_TITLE, readPrefs } from '../prefs'

type Health = { ok: boolean; name: string; version: string }

export function OverviewPage() {
  const prefs = readPrefs()
  const [health, setHealth] = useState<Health | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const ctrl = new AbortController()
    fetch(`${PLUGIN_ROUTE}/api/health`, { signal: ctrl.signal })
      .then(async (res) => {
        let data: { error?: string } = {}
        try {
          data = (await res.json()) as { error?: string }
        } catch (parseError) {
          const message = parseError instanceof Error ? parseError.message : String(parseError)
          throw new Error(`HTTP ${res.status}，响应不是 JSON（${message}）`)
        }
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
        setHealth(data as Health)
        setError('')
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => ctrl.abort()
  }, [])

  return (
    <div className={prefs.value.compact ? 'mx-auto grid w-full max-w-3xl gap-4' : 'mx-auto grid w-full max-w-3xl gap-6'}>
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{prefs.value.displayName || PLUGIN_TITLE}</h1>
        <p className="max-w-[36em] text-base leading-relaxed text-muted-foreground">
          左侧是导航，右侧是当前页面。业务页面加在 web/src/pages，并在侧边栏登记。
        </p>
      </header>
      {prefs.warning ? <p role="alert" className="text-base text-destructive">{prefs.warning}</p> : null}
      <Card>
        <CardHeader>
          <CardTitle>插件状态</CardTitle>
          <CardDescription className="text-base">{PLUGIN_ROUTE}/api/health</CardDescription>
        </CardHeader>
        <CardContent>
          {error ? (
            <p role="alert" className="text-base text-destructive">
              读不到插件状态（{error}）。请确认已执行 ./run.sh {PLUGIN_NAME} -d 并重启 dsh web，然后刷新此页。
            </p>
          ) : health ? (
            <p className="text-base">插件 {health.name} {health.version} 已响应。</p>
          ) : (
            <p className="text-base text-muted-foreground" aria-busy="true">正在读取插件状态…</p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>下一步</CardTitle>
          <CardDescription className="text-base">改完页面后执行 pnpm run build，刷新即可。改 plugins/web.ts 后需要重启 dsh web。</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <a href={`${PLUGIN_ROUTE}/settings`}>打开设置</a>
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
