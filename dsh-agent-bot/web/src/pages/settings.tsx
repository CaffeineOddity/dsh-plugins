import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@ui/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@ui/components/ui/card'
import { Input } from '@ui/components/ui/input'
import { Switch } from '@ui/components/ui/switch'
import { Field } from '@ui/components/field'
import { rpc } from '../api'

type Settings = {
  agent_wait_timeout_ms?: number
  expert_liveness_max_renew?: number
  task_round_timeout_ms?: number
  use_hub_experts?: boolean
  configDir?: string
  providers?: { id: string; label?: string }[]
}

export function SettingsPage() {
  const [data, setData] = useState<Settings>({})
  const [timeout, setTimeoutMs] = useState('180000')
  const [renew, setRenew] = useState('3')
  const [round, setRound] = useState('7200000')
  const [hub, setHub] = useState(true)
  const [saving, setSaving] = useState(false)

  async function load() {
    const r = await rpc<Settings>('settings')
    if (!r.ok || !r.value) {
      toast.error(r.error || '加载失败')
      return
    }
    setData(r.value)
    setTimeoutMs(String(r.value.agent_wait_timeout_ms ?? 180000))
    setRenew(String(r.value.expert_liveness_max_renew ?? 3))
    setRound(String(r.value.task_round_timeout_ms ?? 7200000))
    setHub(r.value.use_hub_experts !== false)
  }

  useEffect(() => { void load() }, [])

  async function save() {
    setSaving(true)
    const r = await rpc('saveSettings', {
      agent_wait_timeout_ms: timeout.trim(),
      expert_liveness_max_renew: renew.trim(),
      task_round_timeout_ms: round.trim(),
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
        <p className="mt-1 text-sm text-muted-foreground">只改中枢自己的等待与专家清单。通道 token 不在这里配。</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>运行环境</CardTitle>
          <CardDescription>只读。缺省 ~/.dsh/storages/agentbot，可用 AGENT_BOT_CONFIG_DIR 覆盖。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Field label="配置目录">
            <p className="break-all rounded-md bg-muted px-3 py-2 font-mono text-sm">{data.configDir || '—'}</p>
          </Field>
          <Field label="在线 Provider">
            <p className="text-sm">{providers.length === 0 ? '无' : providers.map((p) => (p.label || p.id) + ' (' + p.id + ')').join('、')}</p>
          </Field>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>等待与超时</CardTitle>
          <CardDescription>数字用等宽对齐，避免保存前后跳动。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <Field label="agent 等待超时" htmlFor="st-timeout" hint="毫秒，1000–1800000，默认 180000（3 分钟）。只用于：通道没有 deliver 时同步等这一轮的上限；以及巡检判断专家是否掉线的宽限。通道有 deliver 时入站立刻回执，此值不参与。">
            <Input id="st-timeout" className="max-w-xs tabular-nums" type="number" min={1000} max={1800000} step={1000} value={timeout} onChange={(e) => setTimeoutMs(e.target.value)} />
          </Field>
          <Field label="专家续期上限" htmlFor="st-renew" hint="正整数，默认 3。专家仍 live 时最多续等这么多次窗口。">
            <Input id="st-renew" className="max-w-xs tabular-nums" type="number" min={1} step={1} value={renew} onChange={(e) => setRenew(e.target.value)} />
          </Field>
          <Field label="任务墙钟" htmlFor="st-round" hint="正整数毫秒，默认 7200000（2 小时）。禁止 0。从任务创建或问卷发出起算，到点收口「处理超时」或只作废待决。">
            <Input id="st-round" className="max-w-xs tabular-nums" type="number" min={1} step={1000} value={round} onChange={(e) => setRound(e.target.value)} />
          </Field>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>专家清单</CardTitle>
          <CardDescription>默认开启。开：中枢全集，不依赖群快照。关：本群 Provider listGroupAgents。</CardDescription>
        </CardHeader>
        <CardContent>
          <label className="flex items-start gap-3 text-sm">
            <Switch className="mt-0.5" checked={hub} onCheckedChange={setHub} />
            <span>使用中枢全集。关闭后只看本群快照。</span>
          </label>
        </CardContent>
        <CardFooter className="justify-end border-t pt-6">
          <Button onClick={() => void save()} disabled={saving}>{saving ? '保存中' : '保存'}</Button>
        </CardFooter>
      </Card>
    </div>
  )
}
