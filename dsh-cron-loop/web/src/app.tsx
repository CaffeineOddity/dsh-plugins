import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Clock, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@ui/components/ui/badge'
import { Button } from '@ui/components/ui/button'
import { Card, CardContent } from '@ui/components/ui/card'
import { Checkbox } from '@ui/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@ui/components/ui/dialog'
import { Input } from '@ui/components/ui/input'
import { NativeSelect } from '@ui/components/ui/native-select'
import { Switch } from '@ui/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@ui/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@ui/components/ui/tabs'
import { Textarea } from '@ui/components/ui/textarea'
import { Field } from '@ui/components/field'

type Job = {
  id: string
  name: string
  cwd: string
  cron: string
  prompt: string
  enabled: boolean
  permissionMode?: string
  continuous?: boolean
  newSessionPerRun?: boolean
  activateOnSuccess?: string
  lastStatus?: string
  lastRunAt?: number
  nextRunAtView?: string | null
  cronHuman?: string
  runStats?: { ok: number; total: number }
}
type Run = {
  id: string
  jobId: string
  jobName: string
  startedAt: number
  finishedAt?: number
  status: string
  sessionId?: string
  summary?: string
  error?: string
}
type PoolModel = { id: string; provider: string; model: string; priority?: number; quotaReset?: { type: string; value?: number } }
type Catalog = { providers?: { id: string; name: string; models: { id: string; name?: string }[] }[]; defaultModel?: { provider: string; model: string } | null }

const PERM: Record<string, string> = { 'read-only': '仅可查看', 'workspace-write': '工作区内修改', 'danger-full-access': '完全权限' }
const RESET: Record<string, string> = { hours: '每隔', daily: '每天 0 点', weekly: '每周一 0 点', monthly: '每月 1 号 0 点' }
const STATUS: Record<string, 'success' | 'destructive' | 'warning' | 'secondary'> = { ok: 'success', error: 'destructive', running: 'warning', break: 'secondary' }

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, options)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || 'HTTP ' + res.status)
  return data as T
}

function base(path: string) {
  return path.split('/').filter(Boolean).pop() || path
}

export function App() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [cwd, setCwd] = useState<string | null>(null)
  const [tab, setTab] = useState('crons')
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Job | null | undefined>(undefined)
  const [poolOpen, setPoolOpen] = useState(false)

  async function refresh() {
    try {
      const [jobsData, runsData] = await Promise.all([
        api<{ jobs: Job[] }>('/cron/api/jobs'),
        api<{ runs: Run[] }>('/cron/api/runs?limit=200'),
      ])
      setJobs(jobsData.jobs)
      setRuns(runsData.runs)
      setError('')
      setCwd((cur) => (cur && !jobsData.jobs.some((j) => j.cwd === cur) ? null : cur))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  useEffect(() => {
    void refresh()
    const id = setInterval(() => void refresh(), 15000)
    return () => clearInterval(id)
  }, [])

  const groups = useMemo(() => {
    const map = new Map<string, Job[]>()
    for (const job of jobs) {
      const list = map.get(job.cwd) || []
      list.push(job)
      map.set(job.cwd, list)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [jobs])

  const projJobs = jobs.filter((j) => j.cwd === cwd)
  const projRuns = runs.filter((r) => projJobs.some((j) => j.id === r.jobId))

  return (
    <div className="min-h-screen bg-background">
      <header className="flex h-16 items-center gap-3 border-b px-5">
        <button type="button" className="text-base font-semibold" onClick={() => setCwd(null)}>cron-loop 任务中心</button>
        <span className="text-sm text-muted-foreground">{jobs.length} 个任务</span>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" onClick={() => setPoolOpen(true)}>模型池</Button>
          <Button onClick={() => setEditing(null)}><Plus className="h-4 w-4" />新建任务</Button>
        </div>
      </header>
      <main className="grid w-full gap-4 px-5 py-6">
        {error ? <p className="rounded-md border border-destructive/40 p-4 text-sm text-destructive" role="alert">加载失败: {error}</p> : null}
        {cwd === null ? (
          groups.length === 0 ? <Empty>暂无任务。点右上角「新建任务」，或在任意会话里用 /cron 命令创建。</Empty> : (
            <section className="grid gap-3">
              <h2 className="text-sm font-medium text-muted-foreground">项目列表</h2>
              {groups.map(([dir, list]) => {
                const related = runs.filter((r) => list.some((j) => j.id === r.jobId))
                const enabled = list.filter((j) => j.enabled).length
                const last = related[0] ? new Date(related[0].startedAt).toLocaleString() : '无'
                return (
                  <button key={dir} type="button" className="rounded-xl border bg-card p-4 text-left hover:bg-accent" onClick={() => { setCwd(dir); setTab('crons') }}>
                    <p className="font-semibold">{base(dir)}</p>
                    <p className="break-all font-mono text-xs text-muted-foreground">{dir}</p>
                    <p className="mt-2 flex flex-wrap gap-4 text-xs text-muted-foreground tabular-nums">
                      <span>{list.length} 个任务（{enabled} 启用）</span>
                      <span>{related.length} 条历史</span>
                      <span>上次: {last}</span>
                    </p>
                  </button>
                )
              })}
            </section>
          )
        ) : (
          <section className="grid gap-4">
            <p className="text-sm text-muted-foreground">
              <button type="button" className="underline" onClick={() => setCwd(null)}>全部项目</button>
              <span className="px-2">/</span>
              <span className="text-foreground">{base(cwd)}</span>
            </p>
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList>
                <TabsTrigger value="crons">定时任务 ({projJobs.length})</TabsTrigger>
                <TabsTrigger value="runs">最近执行历史 ({projRuns.length})</TabsTrigger>
              </TabsList>
            </Tabs>
            {tab === 'crons' ? (
              projJobs.length === 0 ? <Empty>该项目暂无任务。点右上角「新建任务」创建。</Empty> : (
                <Card><CardContent className="p-0"><JobTable jobs={projJobs} onEdit={setEditing} onChanged={() => void refresh()} /></CardContent></Card>
              )
            ) : (
              projRuns.length === 0 ? <Empty>暂无执行历史</Empty> : (
                <Card><CardContent className="grid gap-3 p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground tabular-nums">{projRuns.length} 条记录</span>
                    <Button variant="outline" className="text-destructive" onClick={() => void clearRuns(projJobs, refresh)}>清空所有执行记录</Button>
                  </div>
                  <RunTable runs={projRuns} onChanged={() => void refresh()} />
                </CardContent></Card>
              )
            )}
          </section>
        )}
      </main>
      <JobDialog job={editing} jobs={jobs} cwd={cwd} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); void refresh() }} />
      <PoolDialog open={poolOpen} onClose={() => setPoolOpen(false)} />
    </div>
  )
}

function Empty({ children }: { children: string }) {
  return <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">{children}</p>
}

function JobTable({ jobs, onEdit, onChanged }: { jobs: Job[]; onEdit: (job: Job) => void; onChanged: () => void }) {
  return (
    <Table>
      <TableHeader><TableRow><TableHead>任务</TableHead><TableHead>状态</TableHead><TableHead>cron</TableHead><TableHead>下次触发</TableHead><TableHead>权限</TableHead><TableHead>操作</TableHead></TableRow></TableHeader>
      <TableBody>
        {jobs.map((job) => (
          <TableRow key={job.id}>
            <TableCell title={job.prompt}><b>{job.name}</b><br /><span className="font-mono text-xs text-muted-foreground">{job.id}{job.runStats ? ` (${job.runStats.ok}/${job.runStats.total})` : ''}</span></TableCell>
            <TableCell>{job.enabled ? <Badge variant={STATUS[job.lastStatus || ''] || 'secondary'}>{job.lastStatus || '待触发'}</Badge> : <Badge variant="secondary">已暂停</Badge>}</TableCell>
            <TableCell><b>{job.cronHuman || job.cron}</b><br /><code className="text-xs">{job.cron}</code></TableCell>
            <TableCell>{job.nextRunAtView ? new Date(job.nextRunAtView).toLocaleString() : '—'}<br /><span className="text-xs text-muted-foreground">上次: {job.lastRunAt ? new Date(job.lastRunAt).toLocaleString() : '—'}</span></TableCell>
            <TableCell className="text-xs text-muted-foreground">
              {PERM[job.permissionMode || ''] || job.permissionMode || '完全权限'}
              {job.continuous ? <><br />连续执行{job.newSessionPerRun ? '（每轮新会话）' : ''}</> : null}
              {job.activateOnSuccess ? <><br />完成后激活 {job.activateOnSuccess}</> : null}
            </TableCell>
            <TableCell>
              <div className="grid grid-cols-2 gap-1">
                <Button variant="outline" size="sm" onClick={() => onEdit(job)}>编辑</Button>
                <Button variant="outline" size="sm" className="text-destructive" onClick={() => void removeJob(job, onChanged)}>删除</Button>
                <Button variant="outline" size="sm" onClick={() => void toggleJob(job, onChanged)}>{job.enabled ? '暂停' : '恢复'}</Button>
                <Button variant="outline" size="sm" onClick={() => void triggerJob(job, onChanged)}>立即跑</Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function RunTable({ runs, onChanged }: { runs: Run[]; onChanged: () => void }) {
  return (
    <Table>
      <TableHeader><TableRow><TableHead>时间 / 耗时</TableHead><TableHead>状态</TableHead><TableHead>任务</TableHead><TableHead>结果</TableHead><TableHead>会话</TableHead><TableHead>操作</TableHead></TableRow></TableHeader>
      <TableBody>
        {runs.map((run) => (
          <TableRow key={run.id}>
            <TableCell>{new Date(run.startedAt).toLocaleString()}<br /><span className="text-xs text-muted-foreground">{run.finishedAt ? Math.round((run.finishedAt - run.startedAt) / 1000) + 's' : '…'}</span></TableCell>
            <TableCell><Badge variant={STATUS[run.status] || 'secondary'}>{run.status}</Badge></TableCell>
            <TableCell><b>{run.jobName}</b><br /><span className="font-mono text-xs text-muted-foreground">{run.jobId}</span></TableCell>
            <TableCell className={run.error ? 'max-w-sm text-destructive' : 'max-w-sm text-muted-foreground'}>{run.error || run.summary || ''}</TableCell>
            <TableCell>{run.sessionId ? <a className="underline" href={'/?session=' + encodeURIComponent(run.sessionId)}>{run.sessionId.slice(0, 12)}…</a> : ''}</TableCell>
            <TableCell><Button variant="outline" size="sm" className="text-destructive" onClick={() => void removeRun(run, onChanged)}>删除</Button></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

async function toggleJob(job: Job, onChanged: () => void) {
  try {
    await api('/cron/api/jobs/' + job.id, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: !job.enabled }) })
    toast.success(job.enabled ? '已暂停' : '已恢复')
    onChanged()
  } catch (err) { toast.error(err instanceof Error ? err.message : String(err)) }
}
async function triggerJob(job: Job, onChanged: () => void) {
  try {
    await api('/cron/api/jobs/' + job.id + '/trigger', { method: 'POST' })
    toast.success('已触发，稍后刷新查看结果')
    setTimeout(onChanged, 3000)
  } catch (err) { toast.error(err instanceof Error ? err.message : String(err)) }
}
async function removeJob(job: Job, onChanged: () => void) {
  if (!confirm('删除任务 ' + job.id + ' 及其全部历史？')) return
  try {
    await api('/cron/api/jobs/' + job.id, { method: 'DELETE' })
    toast.success('已删除')
    onChanged()
  } catch (err) { toast.error(err instanceof Error ? err.message : String(err)) }
}
async function removeRun(run: Run, onChanged: () => void) {
  if (!confirm('删除这条历史记录？')) return
  try {
    await api('/cron/api/runs/' + encodeURIComponent(run.id), { method: 'DELETE' })
    toast.success('已删除')
    onChanged()
  } catch (err) { toast.error('删除失败: ' + (err instanceof Error ? err.message : String(err))) }
}
async function clearRuns(jobs: Job[], refresh: () => Promise<void>) {
  if (!confirm('清空本项目的全部执行记录？')) return
  try {
    await Promise.all(jobs.map((j) => api('/cron/api/runs?jobId=' + encodeURIComponent(j.id), { method: 'DELETE' })))
    toast.success('已清空')
    await refresh()
  } catch (err) { toast.error('清空失败: ' + (err instanceof Error ? err.message : String(err))) }
}

function JobDialog({ job, jobs, cwd, onClose, onSaved }: { job: Job | null | undefined; jobs: Job[]; cwd: string | null; onClose: () => void; onSaved: () => void }) {
  const open = job !== undefined
  const [name, setName] = useState('')
  const [dir, setDir] = useState('')
  const [cron, setCron] = useState('')
  const [prompt, setPrompt] = useState('')
  const [perm, setPerm] = useState('danger-full-access')
  const [continuous, setContinuous] = useState(false)
  const [fresh, setFresh] = useState(false)
  const [activate, setActivate] = useState('')
  useEffect(() => {
    if (job === undefined) return
    setName(job?.name || '')
    setDir(job?.cwd || cwd || '')
    setCron(job?.cron || '')
    setPrompt(job?.prompt || '')
    setPerm(job?.permissionMode || 'danger-full-access')
    setContinuous(!!job?.continuous)
    setFresh(!!job?.newSessionPerRun)
    setActivate(job?.activateOnSuccess || '')
  }, [job, cwd])
  async function save() {
    const body = {
      name: name.trim() || undefined,
      cwd: dir.trim(),
      cron: cron.trim(),
      prompt: prompt.trim(),
      permissionMode: perm,
      continuous,
      newSessionPerRun: fresh,
      activateOnSuccess: activate.trim() || undefined,
    }
    try {
      if (job) await api('/cron/api/jobs/' + job.id, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      else await api('/cron/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      toast.success('已保存')
      onSaved()
    } catch (err) { toast.error('保存失败: ' + (err instanceof Error ? err.message : String(err))) }
  }
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{job ? '编辑 ' + job.id : '新建任务'}</DialogTitle></DialogHeader>
        <Field label="任务名称（可选）" htmlFor="f-name"><Input id="f-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="留空自动取 prompt 前 24 字" /></Field>
        <Field label="项目目录（cwd，绝对路径）" htmlFor="f-cwd"><Input id="f-cwd" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="/Users/you/projects/demo" /></Field>
        <Field label="cron 表达式（5 段：分 时 日 月 周）" htmlFor="f-cron"><Input id="f-cron" className="font-mono" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * 1-5" /></Field>
        <Field label="任务 prompt" htmlFor="f-prompt"><Textarea id="f-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="总结本项目昨天的 git 提交，输出要点列表" /></Field>
        <Field label="权限模式">
          <NativeSelect value={perm} onChange={(e) => setPerm(e.target.value)}>
            <option value="danger-full-access">完全权限（无人值守推荐）</option>
            <option value="workspace-write">工作区内修改</option>
            <option value="read-only">仅可查看</option>
          </NativeSelect>
        </Field>
        <label className="flex min-h-8 items-center gap-2 text-sm"><Checkbox checked={continuous} onCheckedChange={(v) => setContinuous(v === true)} />连续执行（成功后立即续跑下一轮，不等 cron 触发）</label>
        <label className="flex min-h-8 items-center gap-2 text-sm"><Checkbox checked={fresh} onCheckedChange={(v) => setFresh(v === true)} />每轮新会话（缺省沿用同一会话）</label>
        <Field label="成功后激活任务">
          <NativeSelect value={activate} onChange={(e) => setActivate(e.target.value)}>
            <option value="">不激活其它任务</option>
            {jobs.filter((j) => j.id !== job?.id).map((j) => <option key={j.id} value={j.id}>{j.name || j.id}（{j.id}）</option>)}
          </NativeSelect>
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={() => void save()}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PoolDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [enabled, setEnabled] = useState(false)
  const [models, setModels] = useState<PoolModel[]>([])
  const [catalog, setCatalog] = useState<Catalog>({})
  useEffect(() => {
    if (!open) return
    void Promise.all([api<{ enabled?: boolean; models?: PoolModel[] }>('/cron/api/model-pool'), api<Catalog>('/cron/api/models')]).then(([pool, cat]) => {
      setModels((pool.models ?? []).slice().sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99)))
      setCatalog(cat)
      setEnabled(pool.enabled === true)
    }).catch((err) => toast.error('读取失败: ' + (err instanceof Error ? err.message : String(err))))
  }, [open])
  const inPool = new Set(models.map((m) => m.provider + '/' + m.model))
  function move(i: number, dir: -1 | 1) {
    const j = i + dir
    if (j < 0 || j >= models.length) return
    const next = models.slice()
    ;[next[i], next[j]] = [next[j], next[i]]
    setModels(next)
  }
  async function save() {
    const body = models.map((m, i) => ({ id: m.id, provider: m.provider, model: m.model, priority: i + 1, quotaReset: m.quotaReset ?? { type: 'hours', value: 24 } }))
    try {
      await api('/cron/api/model-pool', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled, models: body }) })
      toast.success('模型池已保存')
      onClose()
    } catch (err) { toast.error('保存失败: ' + (err instanceof Error ? err.message : String(err))) }
  }
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle>模型池配置</DialogTitle></DialogHeader>
        <label className="flex min-h-8 items-center gap-2 text-sm"><Switch checked={enabled} onCheckedChange={setEnabled} />启用模型池（关闭时用 DSH 默认模型）</label>
        <p className="text-xs text-muted-foreground">未启用或池为空时，使用 DSH 默认模型：{catalog.defaultModel ? catalog.defaultModel.provider + ' / ' + catalog.defaultModel.model : '（settings.yaml 未配置）'}</p>
        <div className="grid gap-2">
          {models.length === 0 ? <p className="text-sm text-muted-foreground">池为空：任务使用 DSH 默认模型。</p> : models.map((m, i) => {
            const reset = m.quotaReset ?? { type: 'hours', value: 24 }
            return (
              <div key={m.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full border text-xs tabular-nums">{i + 1}</span>
                <div className="min-w-0 flex-1"><b className="text-sm">{m.id}</b><p className="truncate text-xs text-muted-foreground">{m.provider} / {m.model}</p></div>
                <NativeSelect className="w-36" value={reset.type} onChange={(e) => {
                  const type = e.target.value
                  setModels((prev) => prev.map((item, idx) => idx === i ? { ...item, quotaReset: type === 'hours' ? { type, value: item.quotaReset?.value ?? 24 } : { type } } : item))
                }}>
                  {Object.entries(RESET).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </NativeSelect>
                {reset.type === 'hours' ? <Input className="w-20 tabular-nums" type="number" min={1} max={720} value={reset.value ?? 24} title="重置间隔（小时）" onChange={(e) => setModels((prev) => prev.map((item, idx) => idx === i ? { ...item, quotaReset: { type: 'hours', value: Math.max(1, Math.min(720, Number(e.target.value) || 24)) } } : item))} /> : null}
                <Button variant="outline" size="icon" aria-label="上移" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp /></Button>
                <Button variant="outline" size="icon" aria-label="下移" disabled={i === models.length - 1} onClick={() => move(i, 1)}><ArrowDown /></Button>
                <Button variant="outline" size="icon" aria-label="移除" className="text-destructive" onClick={() => setModels((prev) => prev.filter((_, idx) => idx !== i))}><Trash2 /></Button>
              </div>
            )
          })}
        </div>
        <div className="flex flex-wrap gap-2">
          {(catalog.providers ?? []).flatMap((p) => p.models.filter((m) => !inPool.has(p.id + '/' + m.id)).map((m) => (
            <button key={p.id + m.id} type="button" className="rounded-full border border-dashed px-3 py-1 text-xs hover:border-solid hover:bg-accent" onClick={() => setModels((prev) => [...prev, { id: p.id + '/' + m.id, provider: p.id, model: m.id, quotaReset: { type: 'hours', value: 24 } }])}>
              <Plus className="mr-1 inline h-3 w-3" />{m.name || m.id}<span className="text-muted-foreground"> · {p.id}</span>
            </button>
          )))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={() => void save()}><Clock className="h-4 w-4" />保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
