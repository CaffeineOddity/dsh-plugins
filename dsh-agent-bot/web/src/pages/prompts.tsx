import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@ui/components/ui/button'
import { Card } from '@ui/components/ui/card'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@ui/components/ui/dialog'
import { Input } from '@ui/components/ui/input'
import { Textarea } from '@ui/components/ui/textarea'
import { Field } from '@ui/components/field'
import { rpc } from '../api'

type Preset = { name: string; system_prompt?: string; tools?: string[] }

export function PromptsPage() {
  const [presets, setPresets] = useState<Record<string, Preset>>({})
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [editKey, setEditKey] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')

  async function load() {
    const r = await rpc<Preset[] | { prompts: Preset[] }>('listPrompts', { query: '' })
    if (!r.ok || !r.value) { toast.error(r.error || '加载失败'); return }
    const items = Array.isArray(r.value) ? r.value : r.value.prompts || []
    const next: Record<string, Preset> = {}
    for (const item of items) next[item.name] = { name: item.name, system_prompt: item.system_prompt || '', tools: item.tools || [] }
    setPresets(next)
  }
  useEffect(() => { void load() }, [])

  const shown = useMemo(() => Object.keys(presets).sort().filter((n) => !query.trim() || n.toLowerCase().includes(query.trim().toLowerCase())), [presets, query])

  function openEdit(key: string | null) {
    setEditKey(key)
    setName(key || '')
    setPrompt(key ? presets[key]?.system_prompt || '' : '')
    setOpen(true)
  }

  async function save() {
    const trimmed = name.trim()
    if (!trimmed) { toast.error('预设名必填'); return }
    const next = { ...presets }
    if (editKey !== null && editKey !== trimmed) delete next[editKey]
    next[trimmed] = { name: trimmed, system_prompt: prompt, tools: [] }
    const payload: Record<string, { system_prompt: string; tools: string[] }> = {}
    for (const [k, v] of Object.entries(next)) payload[k] = { system_prompt: v.system_prompt || '', tools: [] }
    const r = await rpc('savePrompts', { prompts: payload })
    if (r.ok) { toast.success('已保存'); setOpen(false); void load() }
    else toast.error(r.error || '保存失败')
  }

  async function remove(key: string) {
    if (!confirm('确认删除预设「' + key + '」？仍有 agent 引用时会禁止删除。')) return
    const next = { ...presets }
    delete next[key]
    const payload: Record<string, { system_prompt: string; tools: string[] }> = {}
    for (const [k, v] of Object.entries(next)) payload[k] = { system_prompt: v.system_prompt || '', tools: v.tools || [] }
    const r = await rpc('savePrompts', { prompts: payload })
    if (r.ok) { toast.success('已删除'); void load() }
    else toast.error(r.error || '删除失败')
  }

  return (
    <div className="grid w-full gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Prompts</h1>
        <Input className="max-w-xs" placeholder="按名称筛选" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Button className="ml-auto" onClick={() => openEdit(null)}>添加 prompt</Button>
      </div>
      <Card className="divide-y">
        {shown.length === 0 ? <p className="p-6 text-sm text-muted-foreground">{query ? '筛选无结果' : '暂无 prompt。点「添加 prompt」创建。'}</p> : shown.map((n) => (
          <div key={n} className="flex items-center gap-3 px-4 py-3">
            <span className="min-w-0 flex-1 font-medium">{n}</span>
            <Button variant="ghost" onClick={() => openEdit(n)}>编辑</Button>
            <Button variant="ghost" className="text-destructive" onClick={() => void remove(n)}>删除</Button>
          </div>
        ))}
      </Card>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editKey ? '编辑：' + editKey : '添加 prompt'}</DialogTitle></DialogHeader>
          <Field label="预设名" htmlFor="pp-name"><Input id="pp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="必填、唯一，如 default" /></Field>
          <Field label="system prompt" htmlFor="pp-prompt" hint="变量：{{sender}} {{session_key}} {{provider_id}} 及 sessionParts 键。不提供 {{webhook_url}}。推荐工具按绑定该预设的智能体技能组自动展开。">
            <Textarea id="pp-prompt" rows={8} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
            <Button onClick={() => void save()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
