import type { ReactNode } from 'react'
import { Label } from './ui/label'

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-sm leading-relaxed text-muted-foreground">{hint}</p> : null}
    </div>
  )
}
