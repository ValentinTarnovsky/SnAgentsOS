/**
 * The live layout: a flex column sized to the keyboard-aware --vvh so the
 * KeyBar always docks just above the soft keyboard. TopBar (workspace + console
 * title, connection dot, drawer + actions) / terminal (flex-1, min-h-0) /
 * KeyBar. The drawer, action sheet and paste sheet mount here; the status
 * banner and toast overlay the terminal.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { LayoutGrid, MoreVertical } from 'lucide-react'
import { RemoteTerminal } from './RemoteTerminal'
import { KeyBar } from './KeyBar'
import { ConsoleDrawer } from './ConsoleDrawer'
import { ActionSheet } from './ActionSheet'
import { PasteSheet } from './PasteSheet'
import { StatusBanner } from './StatusBanner'
import { useRemoteStore } from '../lib/store'
import { t } from '../lib/i18n'

function ConnectionDot(): ReactNode {
  const banner = useRemoteStore((s) => s.banner)
  const color = !banner
    ? 'bg-green-400'
    : banner.kind === 'reconnecting'
      ? 'bg-amber-400'
      : 'bg-red-400'
  return <span className={clsx('h-2.5 w-2.5 rounded-full', color)} />
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
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)

  const { workspaceName, paneTitle } = useMemo(() => {
    if (!snapshot) return { workspaceName: '', paneTitle: t('main.noConsole') }
    const ws = snapshot.workspaces.find((w) => w.id === snapshot.activeWorkspaceId)
    const pane = ws?.panes.find((p) => p.id === activePaneId)
    return {
      workspaceName: ws?.name ?? '',
      paneTitle: pane?.title ?? t('main.noConsole'),
    }
  }, [snapshot, activePaneId])

  return (
    <div className="flex flex-col overflow-hidden bg-bg-primary" style={{ height: 'var(--vvh, 100dvh)' }}>
      <header
        className="flex shrink-0 items-center gap-2 border-b border-border bg-bg-secondary px-3 py-2"
        style={{ paddingTop: 'max(env(safe-area-inset-top), 8px)' }}
      >
        <ConnectionDot />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold leading-tight text-text-primary">{paneTitle}</div>
          {workspaceName && <div className="truncate text-[11px] leading-tight text-text-secondary">{workspaceName}</div>}
        </div>
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

      <main className="relative min-h-0 flex-1">
        <RemoteTerminal />
        <StatusBanner />
        <Toast />
      </main>

      <KeyBar onPaste={() => setPasteOpen(true)} />

      <ConsoleDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <ActionSheet open={actionsOpen} onClose={() => setActionsOpen(false)} />
      <PasteSheet open={pasteOpen} onClose={() => setPasteOpen(false)} />
    </div>
  )
}
