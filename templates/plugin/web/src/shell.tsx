import { useState, type ReactNode } from 'react'
import { LayoutDashboard, Menu, Settings } from 'lucide-react'
import { Button } from '@ui/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@ui/components/ui/dialog'
import { cn } from '@ui/lib/utils'
import { PLUGIN_NAME, PLUGIN_ROUTE, PLUGIN_TITLE } from './prefs'

const NAV = [
  { key: 'overview', href: PLUGIN_ROUTE, label: '概览', icon: LayoutDashboard },
  { key: 'settings', href: `${PLUGIN_ROUTE}/settings`, label: '设置', icon: Settings },
]

export function pageKey(): string {
  const path = location.pathname.length > 1 ? location.pathname.replace(/\/+$/, '') : location.pathname
  if (path === PLUGIN_ROUTE) return 'overview'
  if (!path.startsWith(`${PLUGIN_ROUTE}/`)) return 'missing'
  const rest = path.slice(PLUGIN_ROUTE.length + 1).split('/')[0]
  return rest || 'overview'
}

function Brand() {
  return (
    <div className="mb-3 flex items-center gap-2 px-2">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-primary text-base font-semibold text-primary-foreground">
        {PLUGIN_TITLE.slice(0, 1)}
      </span>
      <div className="min-w-0">
        <p className="truncate text-base font-semibold">{PLUGIN_TITLE}</p>
        <p className="truncate text-base text-muted-foreground">{PLUGIN_NAME}</p>
      </div>
    </div>
  )
}

function NavLinks({ current, onNavigate }: { current: string; onNavigate?: () => void }) {
  return (
    <nav aria-label="插件页面" className="flex flex-col gap-1">
      {NAV.map((item) => {
        const Icon = item.icon
        const active = current === item.key
        return (
          <a
            key={item.key}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            onClick={onNavigate}
            className={cn(
              'flex h-11 items-center gap-2 rounded-md px-3 text-base',
              active
                ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                : 'text-sidebar-foreground hover:bg-sidebar-accent',
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {item.label}
          </a>
        )
      })}
    </nav>
  )
}

export function Shell({ children }: { children: ReactNode }) {
  const current = pageKey()
  const [open, setOpen] = useState(false)
  return (
    <div className="flex min-h-screen w-full bg-background">
      <aside className="hidden w-56 shrink-0 flex-col gap-1 border-r border-sidebar-border bg-sidebar p-3 min-[641px]:flex">
        <Brand />
        <NavLinks current={current} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 items-center gap-3 border-b px-4 min-[641px]:hidden">
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button variant="outline">
                <Menu className="h-4 w-4" aria-hidden="true" />
                打开导航
              </Button>
            </DialogTrigger>
            <DialogContent className="left-0 top-0 flex h-full max-h-none w-72 max-w-none translate-x-0 translate-y-0 flex-col gap-4 rounded-none p-3 [&>button]:flex [&>button]:h-11 [&>button]:w-11 [&>button]:items-center [&>button]:justify-center">
              <DialogHeader>
                <DialogTitle>{PLUGIN_TITLE}</DialogTitle>
                <DialogDescription>选择要打开的页面。</DialogDescription>
              </DialogHeader>
              <NavLinks current={current} onNavigate={() => setOpen(false)} />
            </DialogContent>
          </Dialog>
          <p className="truncate text-base font-semibold">{PLUGIN_TITLE}</p>
        </header>
        <main className="min-w-0 flex-1 p-4 min-[641px]:p-6">{children}</main>
      </div>
    </div>
  )
}
