import { useEffect, useRef, useState } from 'react'
import { History, Plus, X } from 'lucide-react'
import type { ShellKind } from '@shared/ipc-contract'
import { useAppStore } from '@/lib/store'
import { AGENT_END_READY_MS, agentEndCommands } from '@/lib/agentEnd'
import { type AgentEndMode, registerAgentEndShell, runAgentEnd } from '@/lib/agentEndRun'
import { useT } from '@/i18n'

export interface AgentEndChipProps {
  paneId: string
  /** The pane's launch command (resolveLaunch), for [New]. */
  initialCommand?: string
  /** Family of the live shell, read when a button is pressed. */
  shellKind: () => ShellKind | null
  /** Give the terminal its focus back after an action. */
  onDone: () => void
}

/**
 * "Claude exited [Resume] [New] [x]" under a console whose Claude session
 * ended with /exit (E6-FR-22), from main's status:sessionEnd. Resume types the
 * cd prefix + `claude ... --resume <id>`, New the pane's Claude command, each
 * with Enter. The buttons enable once the shell had time to print its prompt.
 * Hidden by any key in the pane, a new session, the pty exit, [x] or an
 * action; never shown with the setting off.
 */
export function AgentEndChip({ paneId, initialCommand, shellKind, onDone }: AgentEndChipProps) {
  const t = useT()
  const evt = useAppStore((s) => s.agentEnded[paneId])
  const enabled = useAppStore((s) => s.settings.terminalAgentEndChip !== false)
  const pane = useAppStore((s) => {
    for (const ws of s.workspaces) {
      const p = ws.panes.find((x) => x.id === paneId)
      if (p) return p
    }
    return undefined
  })
  const preset = useAppStore((s) => (pane?.presetId ? s.presets.find((p) => p.id === pane.presetId) : undefined))
  const clear = useAppStore((s) => s.clearAgentEnded)
  const [readyAt, setReadyAt] = useState<number | null>(null)

  // The phone's agentResume (E6-FR-24) builds its cd prefix from this shell too.
  const shellKindRef = useRef(shellKind)
  shellKindRef.current = shellKind
  useEffect(() => registerAgentEndShell(paneId, () => shellKindRef.current()), [paneId])

  useEffect(() => {
    if (!evt) return
    const timer = setTimeout(() => setReadyAt(evt.at), Math.max(0, AGENT_END_READY_MS - (Date.now() - evt.at)))
    return () => clearTimeout(timer)
  }, [evt])

  if (!evt || !enabled) return null
  const ready = readyAt === evt.at
  const cmds = agentEndCommands({ evt, shellKind: shellKind(), preset, paneCommand: pane?.command, initialCommand })

  // Same path as the phone's agentResume, so both type the same text. A
  // refusal (no live pty) still hides the chip, as before.
  const take = (mode: AgentEndMode): void => {
    if (!runAgentEnd(paneId, mode).ok) clear(paneId)
    onDone()
  }

  const btn =
    'flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-text-primary transition-colors hover:bg-bg-secondary disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent'

  return (
    <div className="pointer-events-none absolute inset-x-2 bottom-2 z-10 flex justify-center">
      <div
        role="status"
        data-agent-end-chip={ready ? 'ready' : 'waiting'}
        className="pointer-events-auto flex min-w-0 max-w-full flex-wrap items-center justify-center gap-2 rounded-lg border border-border bg-card/95 px-3 py-1 text-xs text-text-primary shadow-lg backdrop-blur"
      >
        <History size={13} className="shrink-0 text-accent-violet" />
        <span className="min-w-0 break-words">{t('agentEnd.title')}</span>
        {cmds.resume && (
          <button type="button" data-agent-end="resume" disabled={!ready} onClick={() => take('resume')} className={btn}>
            <History size={11} />
            {t('agentEnd.resume')}
          </button>
        )}
        <button type="button" data-agent-end="new" disabled={!ready} onClick={() => take('new')} className={btn}>
          <Plus size={11} />
          {t('agentEnd.new')}
        </button>
        <button
          type="button"
          aria-label={t('common.close')}
          onClick={() => {
            clear(paneId)
            onDone()
          }}
          className="shrink-0 rounded p-0.5 text-text-secondary transition-colors hover:text-text-primary"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  )
}
