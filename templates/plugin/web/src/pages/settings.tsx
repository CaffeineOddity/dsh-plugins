import { useState } from 'react'
import { Button } from '@ui/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ui/components/ui/card'
import { Input } from '@ui/components/ui/input'
import { Switch } from '@ui/components/ui/switch'
import { Field } from '@ui/components/field'
import { defaultPrefs, readPrefs, writePrefs, type Prefs } from '../prefs'

export function SettingsPage() {
  const initial = readPrefs()
  const [prefs, setPrefs] = useState<Prefs>(initial.value)
  const [warning, setWarning] = useState(initial.warning)
  const [status, setStatus] = useState('')

  function save() {
    const next = { displayName: prefs.displayName.trim() || defaultPrefs().displayName, compact: prefs.compact }
    try {
      writePrefs(next)
      setPrefs(next)
      setWarning('')
      setStatus('已保存在这台浏览器。回到概览即可看到名称和间距变化。')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setStatus('')
      setWarning(`没能保存设置（${message}）。请清理本站存储后重试。`)
    }
  }

  return (
    <div className="mx-auto grid w-full max-w-3xl gap-6">
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">设置</h1>
        <p className="max-w-[36em] text-base leading-relaxed text-muted-foreground">这些值只存在这台浏览器，用来演示侧边栏之外的主窗口。</p>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>显示</CardTitle>
          <CardDescription className="text-base">保存后概览页会使用这里的名称和间距。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {warning ? <p role="alert" className="text-base text-destructive">{warning}</p> : null}
          <Field label="显示名称" htmlFor="display-name" hint="留空保存时会回到插件标题。">
            <Input id="display-name" value={prefs.displayName} onChange={(event) => setPrefs((prev) => ({ ...prev, displayName: event.target.value }))} />
          </Field>
          <label className="flex min-h-8 items-center gap-2 text-sm">
            <Switch checked={prefs.compact} onCheckedChange={(checked) => setPrefs((prev) => ({ ...prev, compact: checked === true }))} />
            紧凑间距
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={save}>保存设置</Button>
            {status ? <p role="status" className="text-base text-muted-foreground">{status}</p> : null}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
