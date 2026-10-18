/**
 * Alert with the page open (E1-FR-40): when a live paneStatus moves a pane
 * other than the viewed one into 'action' while the page is visible, show the
 * toast "{ws} / {pane}: Waiting for permission" and vibrate 80ms. At most one
 * alert per 3s window: more panes inside the window only update the text to
 * "{n} consoles are waiting for you", without vibrating again.
 *
 * The caller compares previous and new status only in the paneStatus handler,
 * never on authOk or state (a snapshot is not a transition). Pure factory with
 * injected deps so the rules run under a fake clock; client.ts binds the
 * singleton to the store. The preference lives in localStorage and defaults on.
 */
import { BRAND } from '@shared/brand'
import type { RemotePaneStatus } from '@shared/remote-protocol'
import { t } from './i18n'
import { reasonText } from './statusText'

export const IN_PAGE_ALERTS_KEY = `${BRAND.mobileStoragePrefix}alerts.inPage`
/** Alerts inside this window collapse into a single one. */
export const ALERT_WINDOW_MS = 3000
export const ALERT_VIBRATE_MS = 80

/** The stored preference (default true; storage may be blocked). */
export function loadInPageAlerts(): boolean {
  try {
    return localStorage.getItem(IN_PAGE_ALERTS_KEY) !== '0'
  } catch {
    return true
  }
}

export function saveInPageAlerts(on: boolean): void {
  try {
    if (on) localStorage.removeItem(IN_PAGE_ALERTS_KEY)
    else localStorage.setItem(IN_PAGE_ALERTS_KEY, '0')
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
}

export interface InPageAlertDeps {
  now: () => number
  isVisible: () => boolean
  enabled: () => boolean
  activePaneId: () => string | null
  /** Workspace name and pane title for the toast, null when unknown. */
  describe: (paneId: string) => { ws: string; pane: string } | null
  show: (text: string) => void
  vibrate: (ms: number) => void
}

export interface InPageAlerts {
  /** Feed one live transition; returns true when it produced or updated an alert. */
  onPaneStatus: (paneId: string, prev: RemotePaneStatus | undefined, next: RemotePaneStatus | null) => boolean
}

export function createInPageAlerts(deps: InPageAlertDeps): InPageAlerts {
  let windowStart = -Infinity
  let windowPanes = new Set<string>()
  return {
    onPaneStatus(paneId, prev, next) {
      if (next?.state !== 'action' || prev?.state === 'action') return false
      if (paneId === deps.activePaneId() || !deps.isVisible() || !deps.enabled()) return false
      const now = deps.now()
      if (now - windowStart < ALERT_WINDOW_MS) {
        if (windowPanes.has(paneId)) return false
        windowPanes.add(paneId)
        deps.show(t('alerts.many', { n: windowPanes.size }))
        return true
      }
      windowStart = now
      windowPanes = new Set([paneId])
      const reason = reasonText(next) ?? t('status.action')
      const where = deps.describe(paneId)
      deps.show(where ? `${where.ws} / ${where.pane}: ${reason}` : reason)
      deps.vibrate(ALERT_VIBRATE_MS)
      return true
    },
  }
}
