import { useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Button } from '@ui/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@ui/components/ui/card'
import { Input } from '@ui/components/ui/input'
import { Label } from '@ui/components/ui/label'
import { Switch } from '@ui/components/ui/switch'
import { rpc } from '../api'

/** 标签固定列宽、右对齐，输入框和说明落在同一列。 */
function SettingRow({ label, htmlFor, hint, children, wide = false }: {
  label: string
  htmlFor?: string
  hint?: string
  children: ReactNode
  wide?: boolean
}) {
  return (
    <div className="grid items-center gap-x-3 gap-y-1 sm:grid-cols-[9rem_14rem_minmax(0,1fr)]">
      <Label htmlFor={htmlFor} className="sm:text-right">{label}</Label>
      <div className={wide ? 'min-w-0 sm:col-span-2' : 'min-w-0'}>{children}</div>
      {!wide && hint ? <p className="text-sm leading-relaxed text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

type Settings = {
  pending_questionnaire_max_days?: number
  patrol_interval_minutes?: number
  use_hub_experts?: boolean
  configDir?: string
  providers?: { id: string; label?: string }[]
}

export function SettingsPage() {
  const [data, setData] = useState<Settings>({})
  const [days, setDays] = useState('7')
  const [patrol, setPatrol] = useState('3')
  const [hub, setHub] = useState(true)
  const [saving, setSaving] = useState(false)

  async function load() {
    const r = await rpc<Settings>('settings')
    if (!r.ok || !r.value) {
      toast.error(r.error || '加载失败')
      return
    }
    setData(r.value)
    setDays(String(r.value.pending_questionnaire_max_days ?? 7))
    setPatrol(String(r.value.patrol_interval_minutes ?? 3))
    setHub(r.value.use_hub_experts !== false)
  }

  useEffect(() => { void load() }, [])

  async function save() {
    setSaving(true)
    const r = await rpc('saveSettings', {
      pending_questionnaire_max_days: days.trim(),
      patrol_interval_minutes: patrol.trim(),
      use_hub_experts: hub,
    })
    setSaving(false)
    if (r.ok) {
      toast.success('已保存')
      void load()
    } else toast.error(r.error || '保存失败')
  }

  const providers = data.providers ?? []
  return (
    <div className="grid w-full gap-6">
      <div>
        <h1 className="text-xl font-semibold">全局设置</h1>
        <p className="mt-1 text-sm text-muted-foreground">问卷寿命、巡检间隔和专家清单。通道 token 不在这里配。</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>运行环境</CardTitle>
          <CardDescription>只读。缺省 ~/.dsh/storages/agentbot，可用 AGENT_BOT_CONFIG_DIR 覆盖。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <SettingRow label="配置目录" wide>
            <p className="break-all rounded-md bg-muted px-3 py-2 font-mono text-sm tabular-nums">{data.configDir || '—'}</p>
          </SettingRow>
          <SettingRow label="在线 Provider" wide>
            <p className="text-sm">{providers.length === 0 ? '无' : providers.map((p) => (p.label || p.id) + ' (' + p.id + ')').join('、')}</p>
          </SettingRow>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>巡检与问卷</CardTitle>
          <CardDescription>标签右对齐，数字用等宽，两行输入框落在同一列。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <SettingRow label="待决问卷最长等待" htmlFor="st-pending-days" hint="天，1–365，默认 7。到点先提醒一次，再一个周期仍未答则关单。">
            <Input id="st-pending-days" className="w-full tabular-nums" type="number" min={1} max={365} step={1} value={days} onChange={(e) => setDays(e.target.value)} />
          </SettingRow>
          <SettingRow label="巡检间隔" htmlFor="st-patrol" hint="分钟，1–60，默认 3。只兜问卷到期、会话没了和投递失败。">
            <Input id="st-patrol" className="w-full tabular-nums" type="number" min={1} max={60} step={1} value={patrol} onChange={(e) => setPatrol(e.target.value)} />
          </SettingRow>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>专家清单</CardTitle>
          <CardDescription>默认开启。开：中枢全集，不依赖群快照。关：本群 Provider listGroupAgents。</CardDescription>
        </CardHeader>
        <CardContent>
          <SettingRow label="专家清单" hint="开：中枢全集。关：只看本群快照。">
            <Switch checked={hub} onCheckedChange={setHub} aria-label="使用中枢全集" />
          </SettingRow>
        </CardContent>
        <CardFooter className="justify-end border-t pt-6">
          <Button onClick={() => void save()} disabled={saving}>{saving ? '保存中' : '保存'}</Button>
        </CardFooter>
      </Card>
    </div>
  )
}
