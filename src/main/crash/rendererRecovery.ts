import type { RecoveryInfo, RenderErrorReport } from '@shared/ipc-contract'
import { RenderErrorThrottle, renderErrorKey } from '@shared/renderErrorThrottle'
import type { MainKey } from '../i18n'
import type { CrashStore } from './crashStore'
import { parseRenderErrorReport } from './crashStore'
import { AUTO_RELOAD_DELAY_MS, decideRecovery, RecoveryBreaker, shouldAutoReload } from './RecoveryBreaker'

/** The slice of a BrowserWindow the recovery needs (a fake in the suite). */
export interface RecoveryWindow {
  isDestroyed(): boolean
  isVisible(): boolean
  webContents: {
    reload(): void
    forcefullyCrashRenderer(): void
    isCrashed(): boolean
  }
}

export interface MessageBoxOpts {
  type: 'error' | 'warning'
  message: string
  detail?: string
  buttons: string[]
  defaultId: number
  cancelId: number
  signal?: AbortSignal
}

export interface RecoveryDeps {
  isQuitting(): boolean
  bypassCloseGuards(): boolean
  updateRelaunchPending(): boolean
  /** Live ptys (ptyManager.count). */
  consoles(): number
  crashes: Pick<CrashStore, 'write'>
  t(key: MainKey, vars?: Record<string, string | number>): string
  productName: string
  /** `win` is null when the dialog must not be parented to a hidden window. */
  showMessageBox(win: RecoveryWindow | null, opts: MessageBoxOpts): Promise<{ response: number }>
  /** Build the diagnostics without a renderer and put them on the clipboard. */
  copyDiagnostics(): void
  /** [Leave in background]: hide the window (phones keep the data plane). */
  hideToBackground(win: RecoveryWindow): void
  /** [Close]: quit through quitApp() with the close guards skipped. */
  quitSkippingGuards(): void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  breaker?: RecoveryBreaker
}

const MAIN_ERRORS_MAX = 10

/**
 * Renderer crash recovery (E4-FR-21..23, 25). main owns the breaker,
 * `lastRecovery` (in memory), the crash records and the ptys; nothing here
 * kills a pty. Wired to the window by index.ts; Electron-free so the suite
 * drives it with fake windows and timers.
 */
export class RendererRecovery {
  readonly breaker: RecoveryBreaker
  private lastRecovery: Omit<RecoveryInfo, 'consoles'> | null = null
  private breakerOpen = false
  private hangAbort: AbortController | null = null
  /** The next render-process-gone is our own kill of a hung renderer. */
  private suppressGone = false
  private readonly throttle = new RenderErrorThrottle()
  private readonly mainErrors: RenderErrorReport[] = []
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown

  constructor(private readonly deps: RecoveryDeps) {
    this.breaker = deps.breaker ?? new RecoveryBreaker()
    this.now = deps.now ?? Date.now
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  }

  private guards(win: RecoveryWindow, reason: string | null): boolean {
    return shouldAutoReload({
      reason,
      isQuitting: this.deps.isQuitting(),
      bypassCloseGuards: this.deps.bypassCloseGuards(),
      destroyed: win.isDestroyed(),
      updateRelaunchPending: this.deps.updateRelaunchPending(),
    })
  }

  /** webContents 'render-process-gone' (FR-21). */
  onGone(win: RecoveryWindow, details: { reason: string; exitCode: number }): void {
    if (this.suppressGone) {
      this.suppressGone = false
      return
    }
    // A hung renderer that died on its own: its [Wait] / [Reload] dialog is moot.
    this.onResponsive()
    if (details.reason === 'clean-exit' || this.deps.isQuitting() || this.deps.bypassCloseGuards()) return
    const now = this.now()
    this.deps.crashes.write({ kind: 'render-process-gone', at: now, reason: details.reason, exitCode: details.exitCode })
    const decision = decideRecovery(
      {
        reason: details.reason,
        isQuitting: this.deps.isQuitting(),
        bypassCloseGuards: this.deps.bypassCloseGuards(),
        destroyed: win.isDestroyed(),
        updateRelaunchPending: this.deps.updateRelaunchPending(),
      },
      this.breaker,
      now,
    )
    if (decision === 'reload') {
      this.breaker.record(now)
      this.lastRecovery = { at: now, reason: details.reason, exitCode: details.exitCode, autoReloadsInWindow: this.breaker.countInWindow(now) }
      this.setTimer(() => {
        // Re-check: a quit or an update may have started during the delay.
        if (this.guards(win, details.reason)) win.webContents.reload()
      }, AUTO_RELOAD_DELAY_MS)
    } else if (decision === 'dialog') {
      void this.breakerDialog(win)
    }
  }

  /** The third crash inside the window: native dialog, [Copy] loops back to it. */
  async breakerDialog(win: RecoveryWindow): Promise<void> {
    if (this.breakerOpen) return
    this.breakerOpen = true
    const { t, productName: app } = this.deps
    try {
      for (;;) {
        const n = this.deps.consoles()
        const { response } = await this.deps.showMessageBox(win.isVisible() ? win : null, {
          type: 'error',
          message: t('crash.breaker.message', { app }),
          detail: t(n === 0 ? 'crash.breaker.detailNone' : n === 1 ? 'crash.breaker.detailOne' : 'crash.breaker.detailMany', { n }),
          buttons: [
            t('crash.retry'),
            t('crash.copy'),
            t('crash.background'),
            t(n === 0 ? 'crash.closeNone' : n === 1 ? 'crash.closeOne' : 'crash.closeMany', { app, n }),
          ],
          defaultId: 0,
          cancelId: 2,
        })
        if (response === 1) {
          this.deps.copyDiagnostics()
          continue
        }
        if (win.isDestroyed()) return
        if (response === 0) this.manualReload(win)
        else if (response === 3) this.deps.quitSkippingGuards()
        else this.deps.hideToBackground(win)
        return
      }
    } finally {
      this.breakerOpen = false
    }
  }

  /** BrowserWindow 'unresponsive' (FR-25). Chromium fires it after 15 s of an unanswered input. */
  onUnresponsive(win: RecoveryWindow): void {
    if (!this.guards(win, null) || this.hangAbort || this.breakerOpen) return
    this.deps.crashes.write({ kind: 'unresponsive', at: this.now() })
    const ac = new AbortController()
    this.hangAbort = ac
    const { t, productName: app } = this.deps
    void this.deps
      .showMessageBox(win.isVisible() ? win : null, {
        type: 'warning',
        message: t('crash.hang.message', { app }),
        detail: t('crash.hang.detail'),
        buttons: [t('crash.wait'), t('crash.reload')],
        defaultId: 0,
        cancelId: 0,
        signal: ac.signal,
      })
      .then(({ response }) => {
        if (!ac.signal.aborted && response === 1) this.reloadHung(win)
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.hangAbort === ac) this.hangAbort = null
      })
  }

  /** BrowserWindow 'responsive': the hang ended, close the dialog. */
  onResponsive(): void {
    this.hangAbort?.abort()
    this.hangAbort = null
  }

  /** [Reload window] on a hung renderer: kill it, then reload. Counts for the breaker. */
  private reloadHung(win: RecoveryWindow): void {
    if (!this.guards(win, null)) return
    const now = this.now()
    this.suppressGone = true
    // If the kill never surfaces as render-process-gone, do not swallow a later real crash.
    this.setTimer(() => {
      this.suppressGone = false
    }, 5000)
    win.webContents.forcefullyCrashRenderer()
    if (!this.breaker.canRecover(now)) {
      void this.breakerDialog(win)
      return
    }
    this.breaker.record(now)
    this.lastRecovery = { at: now, reason: 'unresponsive', exitCode: 0, autoReloadsInWindow: this.breaker.countInWindow(now) }
    win.webContents.reload()
  }

  /** `app:reload`, [Retry], or showing a window whose renderer is dead: resets the breaker, no card. */
  manualReload(win: RecoveryWindow): void {
    this.breaker.reset()
    this.lastRecovery = null
    if (!win.isDestroyed()) win.webContents.reload()
  }

  /** The tray brings back a window left in background: reload a dead renderer. */
  ensureAlive(win: RecoveryWindow): void {
    if (!win.isDestroyed() && win.webContents.isCrashed() && !this.breakerOpen) this.manualReload(win)
  }

  /** `app:takeRecovery`: the pending card, once. N is counted now (after the renderer's reconcile). */
  takeRecovery(): RecoveryInfo | null {
    const r = this.lastRecovery
    this.lastRecovery = null
    return r ? { ...r, consoles: this.deps.consoles() } : null
  }

  /** `app:reportRenderError`: validated, throttled, then written as a crash record. */
  reportRenderError(input: unknown): boolean {
    const report = parseRenderErrorReport(input)
    if (!report) return false
    const now = this.now()
    if (!this.throttle.allow(renderErrorKey(report.scope, report.message), now)) return false
    this.mainErrors.push(report)
    if (this.mainErrors.length > MAIN_ERRORS_MAX) this.mainErrors.splice(0, this.mainErrors.length - MAIN_ERRORS_MAX)
    this.deps.crashes.write({
      kind: 'render-error',
      at: now,
      scope: report.scope,
      ...(report.paneId ? { paneId: report.paneId } : {}),
      message: report.message,
      ...(report.stack ? { stack: report.stack } : {}),
      ...(report.componentStack ? { componentStack: report.componentStack } : {}),
    })
    return true
  }

  /** Render errors main accepted, for diagnostics built without a renderer. */
  recentRenderErrors(): RenderErrorReport[] {
    return [...this.mainErrors]
  }
}
