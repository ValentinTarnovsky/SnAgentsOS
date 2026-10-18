/**
 * The live layout: a flex column sized to the keyboard-aware --vvh so the
 * KeyBar always docks just above the soft keyboard. TopBar (workspace + console
 * title of the viewed pane with its agent status, the "N waiting" pill,
 * connection dot, drawer + actions) / pane tabs (E1-FR-32) / terminal
 * (flex-1, min-h-0) / composer or "Direct input" strip (E1-FR-22..31, 38) /
 * KeyBar. The drawer, action sheet, per-pane actions (long-press on a tab or
 * drawer row, E1-FR-33/39) and Quick Commands sheet mount here; the status banner
 * and toast overlay the terminal. The Paste key opens the composer (PasteSheet
 * is gone, D11). BackStackHost gives every sheet and pushed screen its history
 * entry (E1-FR-36).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { LayoutGrid, MoreVertical } from 'lucide-react'
import { RemoteTerminal } from './RemoteTerminal'
import { KeyBar } from './KeyBar'
import { ConsoleDrawer } from './ConsoleDrawer'
import { ActionSheet } from './ActionSheet'
import { PaneTabs } from './PaneTabs'
import { PaneActionSheet } from './PaneActionSheet'
import { QuickCommandsSheet } from './QuickCommandsSheet'
import { Composer, openComposerForPaste, toggleInputMode } from './Composer'
import { DirectInputStrip } from './DirectInputStrip'
import { ExitStrip } from './ExitStrip'
import { DOT_COLOR, StatusBanner, useConnectionHealth } from './StatusBanner'
import { StatusIndicator } from './StatusIndicator'
import { WaitingPill } from './WaitingPill'
import { selectInputMode, store, useRemoteStore } from '../lib/store'
import { paneById, viewedWorkspaceId, type PaneRef } from '../lib/workspace'
import { BackStackHost } from '../lib/useBackClaim'
import { t } from '../lib/i18n'

/** Header dot colored by the connection tier (E1-FR-13). */
function ConnectionDot(): ReactNode {
  const { tier } = useConnectionHealth()
  return <span data-tier={tier} className={clsx('h-2.5 w-2.5 shrink-0 rounded-full', DOT_COLOR[tier])} />
}

function Toast(): ReactNode {
  const toast = useRemoteStore((s) => s.toast)
  const setToast = useRemoteStore((s) => s.setToast)
  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(null), 2500)
    return () => clearTimeout(id)
  }, [toast, setToast])
  if (!toast) return null
  return (
    <div className="fade-in pointer-events-none absolute bottom-3 left-1/2 z-30 -translate-x-1/2 rounded-full bg-card/95 px-4 py-2 text-xs font-medium text-text-primary shadow-lg ring-1 ring-border">
      {toast}
    </div>
  )
}

export function MainScreen(): ReactNode {
  const snapshot = useRemoteStore((s) => s.snapshot)
  const activePaneId = useRemoteStore((s) => s.activePaneId)
  const activeStatus = useRemoteStore((s) => (s.activePaneId ? s.paneStatus[s.activePaneId] : undefined))
  const connected = useRemoteStore((s) => s.connected)
  const inputMode = useRemoteStore(selectInputMode)
  const kbOpen = useRemoteStore((s) => s.kbOpen)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)

  // A Paste one-shot belongs to the pane it was opened on: leaving it ends it.
  useEffect(() => {
    const s = store.getState()
    if (s.composerOneShot && s.composerOneShot !== activePaneId) s.update({ composerOneShot: null })
  }, [activePaneId])
  const [quickOpen, setQuickOpen] = useState(false)
  const [paneActions, setPaneActions] = useState<PaneRef | null>(null)

  const { workspaceName, paneTitle } = useMemo(() => {
    if (!snapshot) return { workspaceName: '', paneTitle: t('main.noConsole') }
    // The viewed pane's own workspace (E1-FR-07), which may not be the desktop's.
    const wsId = viewedWorkspaceId(snapshot, activePaneId)
    const ws = snapshot.workspaces.find((w) => w.id === wsId)
    const pane = paneById(snapshot, activePaneId)
    return {
      workspaceName: ws?.name ?? '',
      paneTitle: pane?.title ?? t('main.noConsole'),
    }
  }, [snapshot, activePaneId])

  return (
    <BackStackHost>
    <div className="flex flex-col overflow-hidden bg-bg-primary" style={{ height: 'var(--vvh, 100dvh)' }}>
      <header
        className="flex shrink-0 items-center gap-2 border-b border-border bg-bg-secondary px-3 py-2"
        style={{ paddingTop: 'max(env(safe-area-inset-top), 8px)' }}
      >
        <ConnectionDot />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span data-pane-title className="truncate text-sm font-semibold leading-tight text-text-primary">{paneTitle}</span>
            <StatusIndicator status={activeStatus} />
          </div>
          {workspaceName && <div data-ws-name className="truncate text-[11px] leading-tight text-text-secondary">{workspaceName}</div>}
        </div>
        <WaitingPill />
        <button
          onClick={() => setDrawerOpen(true)}
          className="flex h-10 w-10 items-center justify-center rounded-btn text-text-secondary active:bg-card"
          aria-label={t('main.consoles')}
        >
          <LayoutGrid size={20} />
        </button>
        <button
          onClick={() => setActionsOpen(true)}
          className="flex h-10 w-10 items-center justify-center rounded-btn text-text-secondary active:bg-card"
          aria-label={t('main.actions')}
        >
          <MoreVertical size={20} />
        </button>
      </header>

      <PaneTabs onPaneActions={setPaneActions} />

      <main className="relative min-h-0 flex-1">
        <RemoteTerminal />
        <StatusBanner />
        <Toast />
      </main>

      <ExitStrip />

      {/* Composer mode docks the composer here; Direct mode shows the strip
          only while the keyboard is down (E1-FR-38). Both stay usable offline:
          the draft is kept and Send is disabled (E1-FR-14). */}
      {activePaneId && (inputMode === 'composer' ? <Composer /> : !kbOpen && <DirectInputStrip />)}

      {/* Offline: the keys are dimmed and inert (E1-FR-14); sendInput refuses too. */}
      <div
        className={clsx('shrink-0 transition-opacity', !connected && 'pointer-events-none opacity-40')}
        aria-disabled={!connected}
        data-connected={connected}
      >
        <KeyBar
          onPaste={openComposerForPaste}
          onQuickCommands={() => setQuickOpen(true)}
          inputMode={inputMode}
          onToggleMode={activePaneId ? toggleInputMode : undefined}
        />
      </div>

      <ConsoleDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} onPaneActions={setPaneActions} />
      <ActionSheet open={actionsOpen} onClose={() => setActionsOpen(false)} />
      <QuickCommandsSheet open={quickOpen} onClose={() => setQuickOpen(false)} />
      <PaneActionSheet target={paneActions} onClose={() => setPaneActions(null)} />
    </div>
    </BackStackHost>
  )
}
