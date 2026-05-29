import { useRef } from 'react'
import { useXterm } from './useXterm'

export interface TerminalPaneProps {
  paneId: string
  cwd?: string
  shell?: string
  fontSize?: number
}

export function TerminalPane({ paneId, cwd, shell, fontSize }: TerminalPaneProps) {
  const ref = useRef<HTMLDivElement>(null)
  useXterm(ref, { paneId, cwd, shell, fontSize })

  return (
    <div className="h-full w-full overflow-hidden bg-bg-primary p-2">
      <div ref={ref} className="h-full w-full" />
    </div>
  )
}
