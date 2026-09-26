import { OverviewPage } from './pages/overview'
import { SettingsPage } from './pages/settings'
import { PLUGIN_ROUTE } from './prefs'
import { pageKey, Shell } from './shell'

function NotFound() {
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">没有这个页面</h1>
      <p className="max-w-[36em] text-base leading-relaxed text-muted-foreground">地址不在侧边栏里。回到概览继续。</p>
      <a className="inline-flex h-8 w-fit items-center text-sm underline" href={PLUGIN_ROUTE}>回到概览</a>
    </div>
  )
}

export function App() {
  const key = pageKey()
  const page = key === 'settings' ? <SettingsPage /> : key === 'overview' ? <OverviewPage /> : <NotFound />
  return <Shell>{page}</Shell>
}
