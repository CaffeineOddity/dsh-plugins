import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@ui/components/ui/badge'
import { Button } from '@ui/components/ui/button'
import { Card } from '@ui/components/ui/card'
import { Checkbox } from '@ui/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@ui/components/ui/dialog'
import { Input } from '@ui/components/ui/input'
import { NativeSelect } from '@ui/components/ui/native-select'
import { Textarea } from '@ui/components/ui/textarea'
import { Field } from '@ui/components/field'
import { rpc } from '../api'
import { pickDirectory } from '../directory'

type Agent = {
  id: string
  name: string
  slug?: string
  description?: string
  workspace?: string
  prompt?: string
  prompt_placement?: string
  skill_groups?: string[]
  prompt_append_skills?: boolean
  reuse_session?: boolean
  session_by_sender?: boolean
  session_timeout_minutes?: number
  permission_mode?: string
  concurrency?: string
  needs_target_workspace?: boolean
  agent_wait_timeout_ms?: number
}
type Prompt = { name: string }
type Group = { id: string; name: string }
type Apply = Record<string, Record<string, string>>

const PERM: Record<string, string> = {
  'danger-full-access': '完全访问',
  'workspace-write': '工作区可写',
  'read-only': '只读',
}

function unique(ids: string[]) {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

function workspaceTargets(apply: Apply) {
  const preferred = ['dsh', 'openclaw', 'claudecode']
  const names = Object.keys(apply || {})
  const ordered = preferred.filter((t) => names.includes(t)).concat(names.filter((t) => !preferred.includes(t)).sort())
  const opts: { tool: string; slot: string; template: string }[] = []
  for (const tool of ordered) {
    const slots = apply[tool]
    if (!slots) continue
    const slotNames = Object.keys(slots).filter((slot) => slot !== 'global' && typeof slots[slot] === 'string' && slots[slot])
    const slot = slotNames.includes('workspace') ? 'workspace' : slotNames.sort()[0]
    if (slot) opts.push({ tool, slot, template: slots[slot] })
  }
  return opts
}

const empty = {
  name: '', slug: '', description: '', workspace: '', prompt: '', placement: 'system', groups: [] as string[],
  append: true, reuse: true, bySender: false, timeout: '30', permission: 'danger-full-access',
  concurrency: 'serial', needsTarget: false, wait: '',
}

export function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [prompts, setPrompts] = useState<Prompt[]>([])
  const [groups, setGroups] = useState<Record<string, Group>>({})
  const [apply, setApply] = useState<Apply>({})
  const [open, setOpen] = useState(false)
  const [editId, setEditId] = useState('')
  const [form, setForm] = useState(empty)
  const [toolKey, setToolKey] = useState('')
  const [pickOpen, setPickOpen] = useState(false)
  const [draftGroups, setDraftGroups] = useState<string[]>([])

  async function load() {
    const [la, lp, ls] = await Promise.all([
      rpc<Agent[] | { agents: Agent[] }>('listAgents'),
      rpc<Prompt[] | { prompts: Prompt[] }>('listPrompts', { query: '' }),
      rpc<{ skill_groups?: Record<string, Group>; skill_apply?: Apply }>('list'),
    ])
    if (la.ok && la.value) setAgents(Array.isArray(la.value) ? la.value : la.value.agents || [])
    if (lp.ok && lp.value) setPrompts(Array.isArray(lp.value) ? lp.value : lp.value.prompts || [])
    if (ls.ok && ls.value) {
      setGroups(ls.value.skill_groups || {})
      setApply(ls.value.skill_apply || {})
    }
  }
  useEffect(() => { void load() }, [])

  const targets = workspaceTargets(apply)
  function set<K extends keyof typeof empty>(key: K, value: (typeof empty)[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  function openEditor(agent: Agent | null) {
    setEditId(agent?.id || '')
    setForm(agent ? {
      name: agent.name, slug: agent.slug || '', description: agent.description || '', workspace: agent.workspace || '',
      prompt: agent.prompt || '', placement: agent.prompt_placement === 'user' ? 'user' : 'system',
      groups: unique(agent.skill_groups || []), append: agent.prompt_append_skills !== false,
      reuse: agent.reuse_session !== false, bySender: !!agent.session_by_sender,
      timeout: String(agent.session_timeout_minutes ?? 30),
      permission: agent.permission_mode || 'danger-full-access',
      concurrency: agent.concurrency === 'concurrent' ? 'concurrent' : 'serial',
      needsTarget: !!agent.needs_target_workspace,
      wait: typeof agent.agent_wait_timeout_ms === 'number' ? String(agent.agent_wait_timeout_ms) : '',
    } : empty)
    const opts = workspaceTargets(apply)
    setToolKey(opts[0] ? opts[0].tool + '\t' + opts[0].slot : '')
    setOpen(true)
  }

  async function save() {
    if (!form.name.trim()) { toast.error('名称必填'); return }
    if (!form.workspace.trim()) { toast.error('workspace 必填，请选择目录'); return }
    const r = await rpc<{ droppedSkillGroupIds?: string[] }>('saveAgent', {
      id: editId, name: form.name.trim(), slug: form.slug.trim(), description: form.description,
      workspace: form.workspace.trim(), prompt: form.prompt, prompt_placement: form.placement,
      skill_groups: form.groups, prompt_append_skills: form.append, reuse_session: form.reuse,
      session_by_sender: form.bySender, permission_mode: form.permission,
      session_timeout_minutes: Number(form.timeout), concurrency: form.concurrency,
      needs_target_workspace: form.needsTarget,
      agent_wait_timeout_ms: form.wait.trim() === '' ? undefined : Number(form.wait),
    })
    if (!r.ok) { toast.error(r.error || '保存失败'); return }
    const dropped = r.value?.droppedSkillGroupIds || []
    toast.success(dropped.length ? '已保存，剔除未知组：' + dropped.join(', ') : '已保存')
    setOpen(false)
    void load()
  }

  async function applyGroups() {
    if (!editId) { toast.error('请先保存智能体'); return }
    if (!form.workspace.trim()) { toast.error('workspace 必填，请选择目录'); return }
    const tab = toolKey.indexOf('\t')
    if (tab < 0) { toast.error('没有可应用的落点'); return }
    if (!form.groups.length) { toast.error('请先选择技能组'); return }
    const tool = toolKey.slice(0, tab)
    const slot = toolKey.slice(tab + 1)
    const r = await rpc('applySkillGroups', { id: editId, tool, slot, groupIds: form.groups })
    if (r.ok) toast.success('已应用到 ' + tool + ' · ' + slot)
    else toast.error(r.error || '应用失败')
  }

  async function remove(a: Agent) {
    if (!confirm('确认删除智能体「' + a.name + '」？会话槽会一并删除。')) return
    const r = await rpc('deleteAgent', { id: a.id })
    if (r.ok) { toast.success('已删除'); setOpen(false); void load() }
    else toast.error(r.error || '删除失败')
  }

  const selected = targets.find((o) => o.tool + '\t' + o.slot === toolKey)
  const applyPath = selected ? selected.template.split('{workspace}').join(form.workspace.trim() || '{workspace}') : '没有工作区落点'

  return (
    <div className="grid w-full gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">智能体</h1>
        <Button onClick={() => openEditor(null)}>添加智能体</Button>
      </div>
      <Card className="divide-y">
        {agents.length === 0 ? <p className="p-6 text-sm text-muted-foreground">暂无智能体。点「添加智能体」创建。</p> : agents.map((a) => (
          <div key={a.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <b>{a.name}</b>
              {a.description ? <p className="text-sm text-muted-foreground">{a.description}</p> : null}
              <div className="mt-1 flex flex-wrap gap-1">{(a.skill_groups || []).map((id) => <Badge key={id} variant="secondary">{groups[id]?.name || id}</Badge>)}</div>
              <p className="mt-1 font-mono text-xs text-muted-foreground">workspace: {a.workspace || '—'} · prompt: {(a.prompt || '').trim() ? a.prompt + '(system)' : 'default(system)'} · {PERM[a.permission_mode || ''] || a.permission_mode} · 会话: {a.reuse_session !== false ? '续接' : '不复用'}{a.session_by_sender ? '/按人' : ''}{a.reuse_session !== false && a.session_timeout_minutes ? '/' + a.session_timeout_minutes + 'min' : ''}{a.concurrency === 'concurrent' ? ' · 并发' : ''}{a.needs_target_workspace ? ' · 需目标目录' : ''}</p>
            </div>
            <Button variant="ghost" onClick={() => openEditor(a)}>编辑</Button>
            <Button variant="ghost" className="text-destructive" onClick={() => void remove(a)}>删除</Button>
            <Button variant="ghost" onClick={() => { location.href = '/agent-bot/chat?agent=' + encodeURIComponent(a.id) }}>去对话</Button>
          </div>
        ))}
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editId ? '编辑：' + form.name : '添加智能体'}</DialogTitle>
            <p className="text-xs text-muted-foreground">{editId ? 'id：' + editId + '（创建后不可改）' : '保存时生成 id，之后不可改。'}</p>
          </DialogHeader>
          <div className="grid gap-4">
            <Field label="名称" htmlFor="a-name"><Input id="a-name" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="必填，如 联运助手" /></Field>
            <Field label="命令别名" htmlFor="a-slug"><Input id="a-slug" value={form.slug} onChange={(e) => set('slug', e.target.value)} placeholder="英文，如 designer" /></Field>
            <Field label="功能说明" htmlFor="a-desc"><Textarea id="a-desc" rows={3} value={form.description} onChange={(e) => set('description', e.target.value)} /></Field>
            <Field label="workspace">
              <div className="flex gap-2">
                <p className="min-w-0 flex-1 break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">{form.workspace || '（未选择）'}</p>
                <Button variant="outline" onClick={() => void pickDirectory({ title: '选择 workspace', startPath: form.workspace, onPick: (path) => set('workspace', path) })}>选择目录</Button>
              </div>
            </Field>
            <Field label="预设">
              <NativeSelect value={form.prompt} onChange={(e) => set('prompt', e.target.value)}>
                <option value="">（不绑定）</option>
                {prompts.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
              </NativeSelect>
            </Field>
            <Field label="注入位置">
              <NativeSelect value={form.placement} disabled={!form.prompt} onChange={(e) => set('placement', e.target.value)}>
                <option value="system">系统提示词</option>
                <option value="user">追加到用户对话</option>
              </NativeSelect>
            </Field>
            <div className="grid gap-2 rounded-lg border p-3">
              <div className="flex items-center gap-3">
                <span className="w-16 shrink-0 text-right text-sm text-muted-foreground">已选组</span>
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                  {form.groups.length === 0 ? <span className="text-sm text-muted-foreground">尚未添加技能组。</span> : form.groups.map((id) => (
                    <Badge key={id} variant="secondary" className="gap-1">{groups[id]?.name || id}<button type="button" aria-label="移除" className="ml-1" onClick={() => set('groups', form.groups.filter((x) => x !== id))}>×</button></Badge>
                  ))}
                </div>
                <Button variant="ghost" className="shrink-0" onClick={() => { setDraftGroups(form.groups); setPickOpen(true) }}>添加技能组</Button>
              </div>
              <label className="flex min-h-8 items-center gap-2 pl-[4.75rem] text-sm"><Checkbox checked={form.append} onCheckedChange={(v) => set('append', v === true)} />追加到 prompt</label>
              <div className="flex items-center gap-3">
                <span className="w-16 shrink-0 text-right text-sm text-muted-foreground">用到</span>
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4">
                  {targets.length === 0 ? <p className="text-sm text-muted-foreground">没有工作区落点。</p> : targets.map((o) => (
                    <label key={o.tool + o.slot} className="inline-flex h-8 items-center gap-2 text-sm">
                      <input type="radio" name="aw" checked={toolKey === o.tool + '\t' + o.slot} onChange={() => setToolKey(o.tool + '\t' + o.slot)} />{o.tool}
                    </label>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="w-16 shrink-0 text-right text-sm text-muted-foreground">落点</span>
                <p className="min-w-0 flex-1 break-all font-mono text-xs text-muted-foreground">{applyPath}</p>
                <Button variant="outline" className="shrink-0" disabled={!editId || !targets.length} onClick={() => void applyGroups()}>应用到工作区</Button>
              </div>
            </div>
            <div className="flex flex-wrap gap-4">
              <label className="flex min-h-8 items-center gap-2 text-sm"><Checkbox checked={form.reuse} onCheckedChange={(v) => set('reuse', v === true)} />续接会话</label>
              <label className="flex min-h-8 items-center gap-2 text-sm"><Checkbox checked={form.bySender} onCheckedChange={(v) => set('bySender', v === true)} />按人隔离</label>
            </div>
            <Field label="空闲超时" hint="分钟，0=不拆。关续接时禁用。">
              <Input className="max-w-xs tabular-nums" type="number" min={0} disabled={!form.reuse} value={form.timeout} onChange={(e) => set('timeout', e.target.value)} />
            </Field>
            <Field label="权限" hint="改权限对已打开会话不生效。">
              <NativeSelect value={form.permission} onChange={(e) => set('permission', e.target.value)}>
                <option value="danger-full-access">完全访问（默认）</option>
                <option value="workspace-write">工作区可写</option>
                <option value="read-only">只读</option>
              </NativeSelect>
            </Field>
            <Field label="磁盘并发" hint="并发时不同目标目录的 write 可并行。">
              <NativeSelect value={form.concurrency} onChange={(e) => set('concurrency', e.target.value)}>
                <option value="serial">串行（默认）</option>
                <option value="concurrent">并发</option>
              </NativeSelect>
            </Field>
            <label className="flex min-h-8 items-center gap-2 text-sm"><Checkbox checked={form.needsTarget} onCheckedChange={(v) => set('needsTarget', v === true)} />需要目标项目目录</label>
            <Field label="本轮等待" hint="毫秒，空=用全局，0=回退全局。">
              <Input className="max-w-xs tabular-nums" type="number" min={0} value={form.wait} onChange={(e) => set('wait', e.target.value)} placeholder="全局" />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
            <Button onClick={() => void save()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pickOpen} onOpenChange={setPickOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>添加技能组</DialogTitle></DialogHeader>
          <div className="max-h-72 overflow-auto rounded-md border p-2">
            {Object.values(groups).length === 0 ? <p className="text-sm text-muted-foreground">没有技能组。</p> : Object.values(groups).sort((a, b) => a.name < b.name ? -1 : 1).map((g) => (
              <label key={g.id} className="flex min-h-8 items-center gap-2 px-2 text-sm">
                <Checkbox checked={draftGroups.includes(g.id)} onCheckedChange={(v) => setDraftGroups((prev) => v ? unique([...prev, g.id]) : prev.filter((id) => id !== g.id))} />
                {g.name} <span className="text-muted-foreground">{g.id}</span>
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPickOpen(false)}>取消</Button>
            <Button onClick={() => { set('groups', unique(draftGroups)); setPickOpen(false) }}>确认</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
