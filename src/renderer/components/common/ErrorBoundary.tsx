import { Component, useState, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, ClipboardCopy, Copy, Minus, RotateCw, Square, X } from 'lucide-react'
import { BRAND } from '@shared/brand'
import type { RenderErrorScope } from '@shared/ipc-contract'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'
import { clearDevThrow, useDevThrow, type DevThrowKey } from '@/lib/devHooks'
import { copyDiagnostics, copyText, formatErrorDetail, notePaneFailure, PANE_FAILURE_LIMIT, reportRenderError, toReport } from '@/lib/renderErrors'
import { restartFromButton } from '@/lib/agentLaunch'
import { Logo } from '@/components/ui/Logo'
import { Button } from '@/components/ui/Button'

/**
 * Error boundaries (E4-FR-19, 20). None of them kills a pty: unmounting never
 * does (E4-FR-36), so a fallback only swaps the UI and [Reload console]
 * remounts the terminal, which reattaches to the live pty and replays it.
 *
 * - PaneErrorBoundary: inside PaneCell, around TerminalPane.
 * - PaneCellBoundary: in TilingGrid, around each PaneCell (header failures).
 * - TitleBarBoundary: around TitleBar; leaves a drag strip with the controls.
 * - AppErrorBoundary: around AppBody, inside I18nProvider.
 */

interface FallbackArgs {
  error: unknown
  componentStack: string | null
  reset: () => void
}

interface BoundaryProps {
  scope: RenderErrorScope
  paneId?: string
  /** Changing it while in fallback resets the boundary (a console restart bumps the pane epoch). */
  resetKey?: unknown
  /** Dev flag read in render (devHooks); cleared on reset. */
  devKey?: DevThrowKey
  onCatch?: (error: unknown, componentStack: string | null) => void
  fallback: (args: FallbackArgs) => ReactNode
  children: ReactNode
}

interface BoundaryState {
  hasError: boolean
  error: unknown
  componentStack: string | null
}

/** Throws while its dev flag is set; renders nothing. */
function DevProbe({ devKey }: { devKey: DevThrowKey }) {
  useDevThrow(devKey)
  return null
}

export class SnErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { hasError: false, error: null, componentStack: null }

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { hasError: true, error }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const componentStack = info.componentStack ?? null
    this.setState({ componentStack })
    reportRenderError(toReport(this.props.scope, error, { paneId: this.props.paneId, componentStack }))
    this.props.onCatch?.(error, componentStack)
  }

  componentDidUpdate(prev: BoundaryProps): void {
    if (this.state.hasError && prev.resetKey !== this.props.resetKey) this.reset()
  }

  reset = (): void => {
    if (this.props.devKey) clearDevThrow(this.props.devKey)
    this.setState({ hasError: false, error: null, componentStack: null })
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return this.props.fallback({ error: this.state.error, componentStack: this.state.componentStack, reset: this.reset })
    }
    return (
      <>
        {this.props.devKey && <DevProbe devKey={this.props.devKey} />}
        {this.props.children}
      </>
    )
  }
}

/** True for our boundaries (main.tsx skips them in onCaughtError: they already reported). */
export function isSnBoundary(x: unknown): boolean {
  return x instanceof SnErrorBoundary
}

const smallBtn =
  'inline-flex items-center gap-1.5 rounded-btn border px-2.5 py-1 text-xs font-medium transition-colors'
const primaryBtn = cn(
  smallBtn,
  'border-transparent bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] text-white hover:brightness-110',
)
const ghostBtn = cn(smallBtn, 'border-border text-text-primary hover:bg-bg-secondary')
const dangerGhostBtn = cn(smallBtn, 'border-border text-red-400 hover:border-red-400/40 hover:bg-red-400/10')

// --- Pane (inner) --------------------------------------------------------------

function PaneFallback({ paneId, error, componentStack, failures, reset }: FallbackArgs & { paneId: string; failures: number }) {
  const t = useT()
  const repeated = failures >= PANE_FAILURE_LIMIT
  const reload = (
    <button key="reload" type="button" data-pane-fallback-reload onClick={reset} className={repeated ? ghostBtn : primaryBtn}>
      <RotateCw size={13} />
      {t('crash.pane.reload')}
    </button>
  )
  const restart = (
    <button
      key="restart"
      type="button"
      data-pane-fallback-restart
      onClick={() => {
        restartFromButton(paneId)
        reset()
      }}
      className={repeated ? primaryBtn : dangerGhostBtn}
    >
      <RotateCw size={13} />
      {t('crash.pane.restart')}
    </button>
  )
  const copy = (
    <button key="copy" type="button" onClick={() => copyText(formatErrorDetail(error, componentStack))} className={ghostBtn}>
      <ClipboardCopy size={13} />
      {t('crash.pane.copyDetail')}
    </button>
  )
  return (
    <div
      role="alert"
      data-pane-fallback={paneId}
      data-primary={repeated ? 'restart' : 'reload'}
      className="flex h-full w-full flex-col items-center justify-center gap-3 overflow-auto p-4 text-center"
    >
      <AlertTriangle size={18} className="text-amber-400" />
      <p className="max-w-sm text-sm text-text-primary">{t('crash.pane.message')}</p>
      {repeated && <p className="text-xs text-text-secondary">{t('crash.pane.repeated', { n: failures })}</p>}
      <div className="flex flex-wrap items-center justify-center gap-2">{repeated ? [restart, copy, reload] : [reload, copy, restart]}</div>
    </div>
  )
}

export function PaneErrorBoundary({ paneId, epoch, children }: { paneId: string; epoch: number; children: ReactNode }) {
  const [failures, setFailures] = useState(0)
  return (
    <SnErrorBoundary
      scope="pane"
      paneId={paneId}
      resetKey={epoch}
      devKey={`pane:${paneId}`}
      onCatch={() => setFailures(notePaneFailure(paneId))}
      fallback={(args) => <PaneFallback {...args} paneId={paneId} failures={failures} />}
    >
      {children}
    </SnErrorBoundary>
  )
}

// --- Pane cell (outer) ---------------------------------------------------------

function PaneCellFallback({ title, hidden, onClose, reset }: { title: string; hidden: boolean; onClose: () => void; reset: () => void }) {
  const t = useT()
  return (
    <div
      data-pane-cell-fallback
      className={cn('relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-bg-primary', hidden && 'hidden')}
    >
      <header className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border bg-card/50 px-2">
        <AlertTriangle size={13} className="shrink-0 text-amber-400" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-secondary">{title}</span>
        <button
          type="button"
          aria-label={t('pane.close')}
          data-pane-cell-fallback-close
          onClick={onClose}
          className="rounded p-1 text-text-secondary transition-colors hover:bg-red-400/10 hover:text-red-400"
        >
          <X size={13} />
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="max-w-sm text-sm text-text-primary">{t('crash.pane.message')}</p>
        <button type="button" data-pane-cell-fallback-reload onClick={reset} className={primaryBtn}>
          <RotateCw size={13} />
          {t('crash.pane.reload')}
        </button>
      </div>
    </div>
  )
}

/** Closing from the fallback's X removes the pane; the pty lifecycle then kills its pty (FR-36). */
export function PaneCellBoundary({
  paneId,
  title,
  hidden,
  onClose,
  children,
}: {
  paneId: string
  title: string
  hidden: boolean
  onClose: () => void
  children: ReactNode
}) {
  return (
    <SnErrorBoundary
      scope="paneCell"
      paneId={paneId}
      devKey={`paneHeader:${paneId}`}
      fallback={({ reset }) => <PaneCellFallback title={title} hidden={hidden} onClose={onClose} reset={reset} />}
    >
      {children}
    </SnErrorBoundary>
  )
}

// --- Title bar -----------------------------------------------------------------

function TitleBarFallback() {
  const t = useT()
  const ctl = 'flex w-11 items-center justify-center text-text-secondary transition-colors hover:bg-card hover:text-text-primary'
  return (
    <div data-titlebar-fallback className="app-drag flex h-9 shrink-0 select-none items-center justify-between border-b border-border bg-bg-secondary pl-3">
      <span className="text-xs font-medium text-text-secondary">{BRAND.productName}</span>
      <div className="app-no-drag flex h-full items-stretch">
        <button type="button" onClick={() => window.snApi.window.minimize()} aria-label={t('titlebar.minimize')} className={ctl}>
          <Minus size={15} />
        </button>
        <button type="button" onClick={() => window.snApi.window.maximize()} aria-label={t('titlebar.maximize')} className={ctl}>
          <Square size={13} />
        </button>
        <button
          type="button"
          onClick={() => window.snApi.window.close()}
          aria-label={t('titlebar.close')}
          className="flex w-11 items-center justify-center text-text-secondary transition-colors hover:bg-red-500 hover:text-white"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  )
}

export function TitleBarBoundary({ children }: { children: ReactNode }) {
  return (
    <SnErrorBoundary scope="titlebar" devKey="titlebar" fallback={() => <TitleBarFallback />}>
      {children}
    </SnErrorBoundary>
  )
}

// --- App body ------------------------------------------------------------------

function AppFallback() {
  const t = useT()
  return (
    <div data-app-fallback className="flex min-h-0 w-full flex-1 flex-col bg-bg-primary">
      <div className="app-drag h-6 shrink-0" />
      <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
        <Logo size="lg" />
        <p className="max-w-md text-sm text-text-primary">{t('crash.app.message', { app: BRAND.productName })}</p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button size="sm" data-app-fallback-reload onClick={() => window.snApi.app.reload()}>
            <RotateCw size={16} />
            {t('crash.app.reload')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void copyDiagnostics()}>
            <Copy size={16} />
            {t('crash.copyDiagnostics')}
          </Button>
        </div>
      </div>
    </div>
  )
}

export function AppErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <SnErrorBoundary scope="app" devKey="app" fallback={() => <AppFallback />}>
      {children}
    </SnErrorBoundary>
  )
}
