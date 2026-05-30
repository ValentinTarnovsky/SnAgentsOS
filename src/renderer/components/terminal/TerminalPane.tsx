import { useRef } from 'react'
import { useXterm } from './useXterm'

export interface TerminalPaneProps {
  paneId: string
  cwd?: string
  shell?: string
  initialCommand?: string
  fontSize?: number
  /** Whether this terminal is currently visible (drives refit-on-reveal). */
  isActive?: boolean
}

export function TerminalPane({
  paneId,
  cwd,
  shell,
  initialCommand,
  fontSize,
  isActive,
}: TerminalPaneProps) {
  const ref = useRef<HTMLDivElement>(null)
  useXterm(ref, { paneId, cwd, shell, initialCommand, fontSize, isActive })

  return (
    <div className="h-full w-full overflow-hidden bg-bg-primary p-2">
      <div ref={ref} className="h-full w-full" />
    </div>
  )
}
