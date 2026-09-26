import { useEffect, useState, type ReactNode } from 'react'
import { Bot, Circle } from 'lucide-react'
import { cn } from '@ui/lib/utils'
import { rpc, type Status } from './api'

const NAV = [
  { href: '/agent-bot/skills', label: 'Skills' },
  { href: '/agent-bot/prompts', label: 'Prompts' },
  { href: '/agent-bot/agents', label: 'Agents' },
  { href: '/agent-bot/chat', label: '对话' },
  { href: '/agent-bot/settings', label: '全局设置' },
  { href: '/agent-bot/log', label: '日志' },
]

export function pageKey(): string {
  const rest = location.pathname.replace(/^\/agent-bot\/?/, '')
  return rest || 'skills'
}

export function Shell({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null)
  const key = pageKey()
  useEffect(() => {
    let stop = false
    const tick = async () => {
      const r = await rpc<Status>('status')
      if (!stop && r.ok && r.value) setStatus(r.value)
    }
    void tick()
    const id = setInterval(() => void tick(), 5000)
    return () => {
      stop = true
      clearInterval(id)
    }
  }, [])
  const providers = status?.providers ?? []
  const on = providers.length > 0
  return (
    <div className="flex min-h-screen w-full bg-background">
      <aside className="flex w-56 shrink-0 flex-col gap-1 border-r border-sidebar-border bg-sidebar p-3">
        <div className="mb-2 flex items-center gap-2 px-2 py-1 font-semibold">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Bot className="h-4 w-4" />
          </span>
          AgentBot
        </div>
        <p className="mb-2 flex items-center gap-2 px-2 text-xs text-muted-foreground" title={on ? providers.map((p) => p.label || p.id).join('、') : '无在线 Provider'}>
          <Circle className={cn('h-2.5 w-2.5 fill-current', on ? 'text-emerald-500' : 'text-destructive')} />
          {on ? '在线' : '离线'}
        </p>
        <nav className="flex flex-col gap-1">
          {NAV.map((item) => {
            const active = item.href.endsWith('/' + key) || (key === 'skills' && item.href.endsWith('/skills'))
            return (
              <a
                key={item.href}
                href={item.href}
                className={cn(
                  'flex h-8 items-center rounded-md px-2.5 text-sm',
                  active ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground' : 'text-sidebar-foreground hover:bg-sidebar-accent',
                )}
              >
                {item.label}
              </a>
            )
          })}
        </nav>
      </aside>
      <main className="min-w-0 w-full flex-1 p-6">{children}</main>
    </div>
  )
}
