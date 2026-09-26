import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Button } from '@ui/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@ui/components/ui/dialog'
import { rpc } from './api'

type Dir = { path: string; parent: string | null; home: string; entries: { name: string; path: string }[] }

function isMobileBrowse() {
  return matchMedia('(pointer: coarse)').matches || matchMedia('(max-width: 720px)').matches
}

function Browse({ title, startPath, onPick, onClose }: { title: string; startPath: string; onPick: (path: string) => void; onClose: () => void }) {
  const [dir, setDir] = useState<Dir>({ path: '', parent: null, home: '', entries: [] })
  async function load(path: string) {
    const r = await rpc<Dir>('listDirectories', { path: path || '' })
    if (!r.ok || !r.value) return
    setDir(r.value)
  }
  useEffect(() => { void load(startPath) }, [startPath])
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <p className="break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">{dir.path || '—'}</p>
        <div className="flex gap-2">
          <Button variant="outline" disabled={!dir.parent} onClick={() => dir.parent && void load(dir.parent)}>上一级</Button>
          <Button variant="outline" onClick={() => void load(dir.home || '')}>家目录</Button>
        </div>
        <div className="max-h-72 overflow-auto rounded-md border">
          {dir.entries.length === 0 ? <p className="p-3 text-sm text-muted-foreground">此目录没有可见子目录。</p> : dir.entries.map((e) => (
            <button key={e.path} type="button" className="flex min-h-8 w-full flex-col items-start border-b px-2.5 py-1.5 text-left text-sm last:border-0 hover:bg-accent" onClick={() => void load(e.path)}>
              <span>{e.name}</span><span className="text-xs text-muted-foreground">{e.path}</span>
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={() => { if (!dir.path) return; onPick(dir.path); onClose() }}>选择此目录</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export async function pickDirectory(opts: { title: string; startPath?: string; onPick: (path: string) => void }) {
  if (!isMobileBrowse()) {
    const r = await rpc<{ path?: string | null }>('pickDirectory')
    if (!r.ok) return
    if (r.value?.path) opts.onPick(r.value.path)
    return
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const close = () => { root.unmount(); host.remove() }
  root.render(<Browse title={opts.title} startPath={opts.startPath || ''} onPick={opts.onPick} onClose={close} />)
}
