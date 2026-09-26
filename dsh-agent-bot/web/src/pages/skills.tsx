import { useEffect, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@ui/components/ui/badge'
import { Button } from '@ui/components/ui/button'
import { Card } from '@ui/components/ui/card'
import { Checkbox } from '@ui/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@ui/components/ui/dialog'
import { Input } from '@ui/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ui/components/ui/tabs'
import { Field } from '@ui/components/field'
import { rpc } from '../api'
import { pickDirectory } from '../directory'

type Skill = { id: string; name: string; description?: string; path: string }
type Group = { id: string; name: string; skill_ids?: string[] }

function underRoot(skills: Skill[], root: string) {
  const r = String(root || '').replace(/\\/g, '/').replace(/\/+$/, '')
  return skills.filter((s) => {
    const p = String(s.path).replace(/\\/g, '/')
    if (!r) return true
    return p === r || p.startsWith(r + '/')
  })
}

function titleOf(root: string) {
  const parts = String(root || '').replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : root
}

function relPath(p: string) {
  const parts = String(p || '').replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.slice(Math.max(0, parts.length - 2)).join('/') + '/'
}

function slugGroupId(name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug || 'g' + Date.now()
}

function globalTools(apply: Record<string, Record<string, string>>) {
  const preferred = ['dsh', 'openclaw', 'claudecode']
  const names = Object.keys(apply || {})
  const ordered = preferred.filter((t) => names.includes(t)).concat(names.filter((t) => !preferred.includes(t)).sort())
  const opts: { tool: string; path: string }[] = []
  for (const tool of ordered) {
    const path = apply[tool]?.global
    if (typeof path === 'string' && path) opts.push({ tool, path })
  }
  return opts
}

export function SkillsPage() {
  const [tab, setTab] = useState(location.hash === '#groups' ? 'groups' : 'warehouse')
  const [roots, setRoots] = useState<string[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const [groups, setGroups] = useState<Record<string, Group>>({})
  const [apply, setApply] = useState<Record<string, Record<string, string>>>({})
  const [openRoot, setOpenRoot] = useState<Record<string, boolean>>({})
  const [scannedAt, setScannedAt] = useState('')
  const [groupOpen, setGroupOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [gName, setGName] = useState('')
  const [filter, setFilter] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [applyOpen, setApplyOpen] = useState(false)
  const [tool, setTool] = useState('')
  const [applyGroups, setApplyGroups] = useState<string[]>([])

  async function load() {
    const r = await rpc<{ skill_roots?: string[]; skills?: Skill[]; skill_groups?: Record<string, Group>; skill_apply?: Record<string, Record<string, string>>; scanned_at?: string }>('list')
    if (!r.ok || !r.value) { toast.error(r.error || '加载失败'); return }
    setRoots(Array.isArray(r.value.skill_roots) ? r.value.skill_roots : [])
    setSkills(r.value.skills || [])
    setGroups(r.value.skill_groups || {})
    setApply(r.value.skill_apply || {})
    setScannedAt(r.value.scanned_at ? new Date(r.value.scanned_at).toLocaleString() : '')
  }
  useEffect(() => { void load() }, [])

  const groupList = useMemo(() => Object.values(groups).sort((a, b) => a.name < b.name ? -1 : 1), [groups])
  const tools = globalTools(apply)
  const filtered = skills.filter((s) => {
    const q = filter.trim().toLowerCase()
    return !q || s.id.toLowerCase().includes(q) || (s.name || '').toLowerCase().includes(q)
  })

  function openGroup(g: Group | null) {
    setEditId(g ? g.id : null)
    setGName(g ? g.name : '')
    setFilter('')
    setPicked(new Set(g?.skill_ids || []))
    setGroupOpen(true)
  }

  async function saveGroup() {
    const name = gName.trim()
    if (!name) { toast.error('组名称必填'); return }
    const next = { ...groups }
    const id = editId || slugGroupId(name)
    next[id] = { id, name, skill_ids: [...picked] }
    const r = await rpc<{ droppedSkillIds?: string[] }>('saveSkillGroups', { groups: next })
    if (!r.ok) { toast.error(r.error || '保存失败'); return }
    const dropped = r.value?.droppedSkillIds || []
    toast.success(dropped.length ? '已保存组，剔除未知技能：' + dropped.join(', ') : '已保存组')
    setGroupOpen(false)
    void load()
  }

  async function removeGroup(id: string) {
    const g = groups[id]
    if (!confirm('确认删除技能组「' + (g?.name || id) + '」？会从所有 agent 上摘掉该组。')) return
    const next = { ...groups }
    delete next[id]
    const r = await rpc('saveSkillGroups', { groups: next })
    if (r.ok) { toast.success('已删除组'); void load() } else toast.error(r.error || '删除失败')
  }

  async function addRoot() {
    await pickDirectory({
      title: '添加技能仓扫描目录',
      startPath: roots[roots.length - 1] || '',
      onPick: async (path) => {
        if (roots.includes(path)) { toast.error('该目录已在列表中'); return }
        const r = await rpc('saveSkillRoots', { skill_roots: [...roots, path] })
        if (r.ok) { toast.success('已添加扫描目录'); void load() } else toast.error(r.error || '保存失败')
      },
    })
  }

  async function scan(root: string) {
    const r = await rpc<{ skills?: Skill[]; groupCount?: number; droppedSkillIds?: string[]; ambiguousSkillIds?: string[] }>('scanSkills', { root })
    if (!r.ok || !r.value) { toast.error(r.error || '扫描失败'); return }
    const bits = ['扫描到 ' + (r.value.skills || []).length + ' 个技能，' + (r.value.groupCount ?? Object.keys(groups).length) + ' 个分组']
    if (r.value.droppedSkillIds?.length) bits.push('未知：' + r.value.droppedSkillIds.join(', '))
    if (r.value.ambiguousSkillIds?.length) bits.push('末段冲突：' + r.value.ambiguousSkillIds.join(', '))
    toast.success(bits.join('；'))
    void load()
  }

  async function removeRoot(i: number) {
    const root = roots[i]
    if (!confirm('删除扫描目录「' + root + '」？已扫描的分组不受影响。')) return
    const r = await rpc('saveSkillRoots', { skill_roots: roots.filter((_, idx) => idx !== i) })
    if (r.ok) { toast.success('已删除扫描目录'); void load() } else toast.error(r.error || '保存失败')
  }

  function openApply() {
    setTool(tools[0]?.tool || '')
    setApplyGroups([])
    setApplyOpen(true)
  }

  async function saveApply() {
    if (!tool) { toast.error('没有 global 落点'); return }
    if (!applyGroups.length) { toast.error('请先选择技能组'); return }
    const r = await rpc('applyGlobalSkillGroups', { tool, slot: 'global', groupIds: applyGroups })
    if (r.ok) { toast.success('已应用到 ' + tool + ' · global'); setApplyOpen(false) }
    else toast.error(r.error || '应用失败')
  }

  return (
    <div className="grid w-full gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Skills</h1>
          <p className="text-sm text-muted-foreground">{scannedAt ? '上次扫描 ' + scannedAt : '扫描含 SKILL.md 的目录'}</p>
        </div>
        {tab === 'warehouse' ? <Button onClick={() => void addRoot()}>添加目录</Button> : (
          <div className="flex gap-2">
            <Button variant="outline" onClick={openApply}>应用全局</Button>
            <Button onClick={() => openGroup(null)}>添加组</Button>
          </div>
        )}
      </div>
      <Tabs value={tab} onValueChange={(v) => { setTab(v); history.replaceState(null, '', v === 'groups' ? '#groups' : '#warehouse') }}>
        <TabsList>
          <TabsTrigger value="warehouse">技能仓</TabsTrigger>
          <TabsTrigger value="groups">skills组</TabsTrigger>
        </TabsList>
        <TabsContent value="warehouse">
          <p className="mb-3 text-sm text-muted-foreground">桌面用系统选目录；触控或窄屏用页内列表逐层浏览。</p>
          <Card className="divide-y">
            {roots.length === 0 ? <p className="p-6 text-sm text-muted-foreground">暂无扫描目录。点「添加目录」把含 SKILL.md 的目录加进来。</p> : roots.map((root, i) => {
              const list = underRoot(skills, root)
              const open = !!openRoot[root]
              return (
                <div key={root}>
                  <div className="flex items-start gap-3 px-4 py-3">
                    <button type="button" className="mt-1" aria-expanded={open} onClick={() => setOpenRoot((s) => ({ ...s, [root]: !s[root] }))}>
                      <ChevronRight className={'h-4 w-4 transition-transform ' + (open ? 'rotate-90' : '')} />
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2"><b>{titleOf(root)}</b><Badge variant="secondary">{list.length} 个技能</Badge></div>
                      <p className="break-all font-mono text-xs text-muted-foreground">{root}</p>
                    </div>
                    <Button variant="outline" onClick={() => void scan(root)}>扫描</Button>
                    <Button variant="outline" className="text-destructive" onClick={() => void removeRoot(i)}>删除</Button>
                  </div>
                  {open ? (
                    <div className="border-t bg-muted/40 px-4 py-2">
                      {list.length === 0 ? <p className="py-2 text-sm text-muted-foreground">该目录尚无可展开的技能（扫描后填充）。</p> : list.map((s) => (
                        <div key={s.id} className="flex items-start justify-between gap-3 border-b py-2 last:border-0">
                          <div><b className="text-sm">{s.name}</b> <Badge variant="outline">{s.id}</Badge><p className="text-xs text-muted-foreground">{s.description}</p></div>
                          <span className="font-mono text-xs text-muted-foreground">{relPath(s.path)}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </Card>
        </TabsContent>
        <TabsContent value="groups">
          <Card className="divide-y">
            {groupList.length === 0 ? <p className="p-6 text-sm text-muted-foreground">暂无技能组。可先扫技能，或扫描时经 linkmap.json 自动建组。</p> : groupList.map((g) => (
              <div key={g.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1"><b>{g.name}</b> <Badge variant="secondary">{(g.skill_ids || []).join('、') || '无技能'}</Badge></div>
                <Button variant="ghost" onClick={() => openGroup(g)}>编辑</Button>
                <Button variant="ghost" className="text-destructive" onClick={() => void removeGroup(g.id)}>删除</Button>
              </div>
            ))}
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={groupOpen} onOpenChange={setGroupOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editId ? '编辑：' + (groups[editId]?.name || '') : '添加技能组'}</DialogTitle></DialogHeader>
          <Field label="名称" htmlFor="g-name"><Input id="g-name" value={gName} onChange={(e) => setGName(e.target.value)} placeholder="如：研发" /></Field>
          <Field label="搜索技能" htmlFor="g-filter"><Input id="g-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="按名称或 id 过滤" /></Field>
          <p className="text-sm text-muted-foreground">已选 {picked.size} 个</p>
          <div className="max-h-64 overflow-auto rounded-md border p-2">
            {filtered.length === 0 ? <p className="p-2 text-sm text-muted-foreground">没有匹配的技能。</p> : filtered.map((s) => (
              <label key={s.id} className="flex min-h-8 items-center gap-2 rounded-md px-2 text-sm hover:bg-accent">
                <Checkbox checked={picked.has(s.id)} onCheckedChange={(v) => setPicked((prev) => { const n = new Set(prev); if (v) n.add(s.id); else n.delete(s.id); return n })} />
                {s.name} <span className="text-muted-foreground">{s.id}</span>
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGroupOpen(false)}>取消</Button>
            <Button onClick={() => void saveGroup()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={applyOpen} onOpenChange={setApplyOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>应用全局</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">把选中技能组软链到本机 agent-ide 全局目录，与某个智能体 workspace 无关。</p>
          <Field label="工具">
            {tools.length === 0 ? <p className="text-sm text-muted-foreground">没有 global 落点。</p> : tools.map((o) => (
              <label key={o.tool} className="mr-4 inline-flex min-h-8 items-center gap-2 text-sm">
                <input type="radio" name="ag-tool" checked={tool === o.tool} onChange={() => setTool(o.tool)} />{o.tool}
              </label>
            ))}
          </Field>
          <p className="break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">{tools.find((o) => o.tool === tool)?.path || '（无 global 落点）'}</p>
          <Field label="技能组">
            <div className="max-h-48 overflow-auto rounded-md border p-2">
              {groupList.length === 0 ? <p className="text-sm text-muted-foreground">暂无技能组。</p> : groupList.map((g) => (
                <label key={g.id} className="flex min-h-8 items-center gap-2 px-2 text-sm">
                  <Checkbox checked={applyGroups.includes(g.id)} onCheckedChange={(v) => setApplyGroups((prev) => v ? [...prev, g.id] : prev.filter((id) => id !== g.id))} />
                  {g.name} <span className="text-muted-foreground">{g.id}</span>
                </label>
              ))}
            </div>
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApplyOpen(false)}>取消</Button>
            <Button disabled={!tools.length} onClick={() => void saveApply()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
