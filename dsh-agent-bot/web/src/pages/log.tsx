import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@ui/components/ui/card'
import { rpc, type Status } from '../api'

export function LogPage() {
  const [status, setStatus] = useState<Status>({})
  useEffect(() => {
    let stop = false
    const tick = async () => {
      const r = await rpc<Status>('status')
      if (!stop && r.ok && r.value) setStatus(r.value)
    }
    void tick()
    const id = setInterval(() => void tick(), 5000)
    return () => { stop = true; clearInterval(id) }
  }, [])
  const blocks = [
    ['启动日志', status.bootLogTail],
    ['ask 日志', status.askLogTail],
    ['扫描日志', status.scanLogTail],
  ] as const
  return (
    <div className="grid w-full gap-4">
      <h1 className="text-xl font-semibold">日志</h1>
      <Card>
        <CardContent className="grid gap-2 pt-6 text-sm">
          <p><span className="text-muted-foreground">配置目录 </span><span className="font-mono">{status.configDir || '—'}</span></p>
          <p><span className="text-muted-foreground">在线 Provider </span>{(status.providers ?? []).map((p) => p.label || p.id).join('、') || '无'}</p>
        </CardContent>
      </Card>
      {blocks.map(([title, text]) => (
        <Card key={title}>
          <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
          <CardContent>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-xs">{text || '—'}</pre>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
