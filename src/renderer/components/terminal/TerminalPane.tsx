import { useRef } from 'react'
import { useXterm } from './useXterm'

export interface TerminalPaneProps {
  paneId: string
  cwd?: string
  shell?: string
  initialCommand?: string
  fontSize?: number
}

export function TerminalPane({ paneId, cwd, shell, initialCommand, fontSize }: TerminalPaneProps) {
  const ref = useRef<HTMLDivElement>(null)
  useXterm(ref, { paneId, cwd, shell, initialCommand, fontSize })

  return (
    <div className="h-full w-full overflow-hidden bg-bg-primary p-2">
      <div ref={ref} className="h-full w-full" />
    </div>
  )
}
