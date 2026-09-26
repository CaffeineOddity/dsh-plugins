import * as React from 'react'
import { cn } from '../../lib/utils'

const NativeSelect = React.forwardRef<HTMLSelectElement, React.ComponentProps<'select'>>(({ className, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      'control control-field disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  />
))
NativeSelect.displayName = 'NativeSelect'

export { NativeSelect }
