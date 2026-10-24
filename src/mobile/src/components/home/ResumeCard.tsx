/**
 * The Resume card above the sections (E2-FR-03): the last console the phone's
 * terminal showed (snagentsos.lastPane), with its agent icon, title,
 * workspace, status and second line. A tap opens it; a long-press opens its
 * actions. Hidden when that console (or its workspace) is gone.
 */
import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { StatusIndicator } from '../StatusIndicator'
import { useRemoteStore } from '../../lib/store'
import { PaneIcon } from '../../lib/paneIcon'
import { useLongPress } from '../../lib/longPress'
import { agentStatusOf, needsText, rowLine } from '../../lib/statusText'
import { isWorkspaceMounted, workspaceOfPane } from '../../lib/workspace'
import { t } from '../../lib/i18n'

export function ResumeCard({
  now,
  onOpen,
  onActions,
}: {
  now: number
  onOpen: (paneId: string) => void
  onActions: (workspaceId: string, paneId: string) => void
}): ReactNode {
  const lastPane = useRemoteStore((s) => s.lastPane)
  const snapshot = useRemoteStore((s) => s.snapshot)
  const status = useRemoteStore((s) => (s.lastPane ? s.paneStatus[s.lastPane] : undefined))
  const wsId = snapshot && lastPane ? workspaceOfPane(snapshot, lastPane) : null
  const ws = wsId ? snapshot?.workspaces.find((w) => w.id === wsId) : undefined
  const pane = ws?.panes.find((p) => p.id === lastPane)
  const press = useLongPress(() => {
    if (ws && pane) onActions(ws.id, pane.id)
  })
  if (!snapshot || !ws || !pane) return null
  // App 2.7.0: a bare status (a `snaos needs` with no agent) reads as its request.
  const line = status?.bare && status.needs
    ? needsText(status.needs)
    : rowLine({ status, running: pane.running, exitCode: pane.exitCode, mounted: isWorkspaceMounted(snapshot, ws.id) }, now)
  return (
    <section className="mb-4">
      <h2 className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">{t('home.resume')}</h2>
      <div
        data-resume={pane.id}
        role="button"
        tabIndex={0}
        {...press}
        onClick={() => onOpen(pane.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onOpen(pane.id)
          }
        }}
        className="flex min-h-[64px] select-none items-center gap-3 rounded-card border border-accent-violet/40 bg-accent-violet/10 px-3 py-2.5 active:bg-accent-violet/20"
        style={{ WebkitTouchCallout: 'none' }}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-btn bg-bg-secondary text-accent-violet">
          <PaneIcon type={status?.provider ?? pane.type} size={18} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-text-primary">{pane.title}</span>
            <StatusIndicator status={agentStatusOf(status)} size={10} />
          </span>
          <span className="truncate text-[11px] text-text-secondary">
            {ws.name} - {line}
          </span>
        </span>
        <ChevronRight size={18} className="shrink-0 text-text-secondary" />
      </div>
    </section>
  )
}
