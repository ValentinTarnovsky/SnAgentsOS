/**
 * Alerts with the page open (E2-FR-43; D9: replaces E1-FR-40's inPageAlerts).
 * A live paneStatus that moves a pane into action or error (or done, with
 * "Alert when a turn ends") produces, while the page is visible:
 *  - in a terminal, for a pane that is not the one on screen: a toast
 *    "<Claude> <workspace / console>: <reason>" with [Go] (action and error
 *    6s, done 4s; ToastStack keeps at most 3) plus the vibration;
 *  - on Home (or Settings): only the vibration, the row already changed;
 *  - for the pane on screen: nothing.
 * Action and error vibrate [60, 40, 60] when "Vibrate" is on. Each pane
 * alerts once per state change (deduplicated by paneId:state:stateSince), and
 * the caller feeds only paneStatus frames: a snapshot (authOk, state) is never
 * a transition. Pure factory with injected deps so the rules run under fakes;
 * client.ts binds the singleton to the store.
 */
import { BRAND } from '@shared/brand'
import type { RemotePaneStatus, RemoteStateSnapshot } from '@shared/remote-protocol'
import { t } from './i18n'
import { reasonText } from './statusText'
import type { LiveScreen, MobileToast } from './store'
import type { PagePrefs } from './prefs'

export const NOTIFY_VIBRATE_PATTERN = [60, 40, 60]
/** How long a state toast stays (ToastStack). */
export const TOAST_URGENT_MS = 6000
export const TOAST_DONE_MS = 4000

export type NotifyKind = 'action' | 'error' | 'done'

export interface PaneNotifierDeps {
  isVisible: () => boolean
  prefs: () => PagePrefs
  screen: () => LiveScreen
  /** The console the terminal shows (only counts while screen is 'terminal'). */
  activePaneId: () => string | null
  /** Workspace name and console title, null when the pane is not in the snapshot. */
  describe: (paneId: string) => { ws: string; pane: string } | null
  show: (toast: Omit<MobileToast, 'id'>) => void
  vibrate: (pattern: number[]) => void
}

export type NotifyOutcome = 'toast' | 'vibrate' | null

export interface PaneNotifier {
  /** Feed one live transition; reports what it did. */
  onPaneStatus: (paneId: string, prev: RemotePaneStatus | undefined, next: RemotePaneStatus | null) => NotifyOutcome
}

/** "Claude Front / Builder: Waiting for permission" (agent omitted when unknown). */
export function notifyText(status: RemotePaneStatus, where: { ws: string; pane: string } | null): string {
  const agent = status.provider === 'claude' ? 'Claude' : status.provider === 'codex' ? 'Codex' : ''
  const reason =
    status.state === 'done' ? t('status.done') : status.state === 'error' ? t('status.error') : (reasonText(status) ?? t('status.action'))
  const place = where ? `${where.ws} / ${where.pane}` : ''
  const head = [agent, place].filter(Boolean).join(' ')
  return head ? `${head}: ${reason}` : reason
}

export function createPaneNotifier(deps: PaneNotifierDeps): PaneNotifier {
  /** paneId -> the state:stateSince it last alerted for. */
  const last = new Map<string, string>()
  return {
    onPaneStatus(paneId, prev, next) {
      if (!next) {
        last.delete(paneId)
        return null
      }
      const state = next.state
      if (state !== 'action' && state !== 'error' && state !== 'done') return null
      if (prev?.state === state) return null
      const key = `${state}:${next.stateSince}`
      if (last.get(paneId) === key) return null
      last.set(paneId, key)
      if (last.size > 500) last.delete(last.keys().next().value as string)
      if (!deps.isVisible()) return null
      const screen = deps.screen()
      const onTerminal = screen === 'terminal'
      if (onTerminal && deps.activePaneId() === paneId) return null
      const prefs = deps.prefs()
      const urgent = state !== 'done'
      const buzz = urgent && prefs.vibrate
      if (onTerminal && prefs.toasts && (urgent || prefs.toastDone)) {
        deps.show({ text: notifyText(next, deps.describe(paneId)), kind: state as NotifyKind, paneId })
        if (buzz) deps.vibrate(NOTIFY_VIBRATE_PATTERN)
        return 'toast'
      }
      if (buzz) {
        deps.vibrate(NOTIFY_VIBRATE_PATTERN)
        return 'vibrate'
      }
      return null
    },
  }
}

/** Consoles in action across the snapshot (the document title badge). */
export function actionTotal(snap: RemoteStateSnapshot | null, statuses: Record<string, RemotePaneStatus>): number {
  if (!snap) return 0
  let n = 0
  for (const ws of snap.workspaces) for (const p of ws.panes) if (statuses[p.id]?.state === 'action') n++
  return n
}

/** "(N) SnAgentsOS Remote" with N consoles in action, the bare title at 0. */
export function remoteTitle(actionCount: number): string {
  return actionCount > 0 ? `(${actionCount}) ${BRAND.mobileTitle}` : BRAND.mobileTitle
}
