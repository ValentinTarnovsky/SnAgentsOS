/**
 * Delay of the remote notices (app 2.8.0): with `settings.notifications.remoteDelaySec`
 * above 0, a console notice and a team notice wait that long before they reach
 * the router (the away gate, Web Push, Discord and ntfy), so an answer given at
 * the PC within seconds never buzzes the phone (and the watch it mirrors to).
 *
 *  - One pending notice per console (`pane:<id>`) and per team row
 *    (`team:<tag>`): a newer one replaces it and restarts its wait.
 *  - Dropped at once when a device sees the console (StatusManager's seen
 *    listener: a focused desktop view, the window gaining focus, a phone
 *    opening it), an `action` included.
 *  - At its deadline a console notice is dropped when it no longer stands
 *    (`isCurrent`: the pane moved to another state, or it was answered, seen
 *    or muted), and any notice is dropped while a phone has the app visible
 *    (the page alerts on its own).
 *  - Still there and the PC was used during the wait (OS idle time shorter
 *    than the delay): it waits again until the PC has been still for the
 *    whole delay. An unknown idle time sends.
 *  - `snaos notify` (routeCustom) is never delayed: the caller asked for it.
 *
 * One DeadlineTimer for every pending notice: no timer at all while nothing
 * waits. The desktop's own notifications never pass through here.
 */
import type { ConfigFile } from '@shared/types'
import { normalizeNoticeDelay } from '@shared/noticeDelay'
import { DeadlineTimer, type DeadlineTimerDeps } from '../DeadlineTimer'
import type { StatusNotice, TeamNotice } from './events'

export interface NoticeDelayDeps {
  loadConfig: () => ConfigFile | null
  /** noticeRouter.route / routeTeam. */
  route: (notice: StatusNotice) => void
  routeTeam: (notice: TeamNotice) => void
  /** StatusManager.noticeCurrent. */
  isCurrent: (paneId: string, seq: number | undefined) => boolean
  /** A phone has the app visible right now (SessionManager.isAnyDeviceVisible). */
  isPhoneVisible: () => boolean
  /** Seconds since the last keyboard or mouse input on the PC (powerMonitor.getSystemIdleTime), undefined unknown. */
  idleSec: () => number | undefined
  /** Clock and timers (tests); the real ones by default. */
  timers?: DeadlineTimerDeps
}

export interface NoticeDelay {
  route: (notice: StatusNotice) => void
  routeTeam: (notice: TeamNotice) => void
  /** A device saw the console: its pending notice goes. */
  seen: (paneId: string) => void
  /** Notices waiting right now. */
  pendingCount: () => number
  dispose: () => void
}

type Key = `pane:${string}` | `team:${string}`
type Pending = { kind: 'pane'; notice: StatusNotice; delayMs: number } | { kind: 'team'; notice: TeamNotice; delayMs: number }

/** Most notices that wait at once; past it a new one goes out without waiting. */
const PENDING_MAX = 256

export function createNoticeDelay(deps: NoticeDelayDeps): NoticeDelay {
  const pending = new Map<Key, Pending>()
  const now = deps.timers?.now ?? (() => Date.now())
  const timer = new DeadlineTimer<Key>((key) => due(key), deps.timers)

  const delayMs = (): number => {
    let config: ConfigFile | null = null
    try { config = deps.loadConfig() } catch { config = null }
    return normalizeNoticeDelay(config?.settings?.notifications?.remoteDelaySec) * 1000
  }
  const send = (p: Pending): void => {
    try {
      if (p.kind === 'pane') deps.route(p.notice)
      else deps.routeTeam(p.notice)
    } catch { /* a channel never escapes the timer */ }
  }
  const safe = (fn: () => boolean): boolean => {
    try { return fn() } catch { return false }
  }
  function due(key: Key): void {
    const p = pending.get(key)
    if (!p) return
    if (p.kind === 'pane' && !safe(() => deps.isCurrent(p.notice.paneId, p.notice.seq))) { pending.delete(key); return }
    if (safe(deps.isPhoneVisible)) { pending.delete(key); return }
    let idle: number | undefined
    try { idle = deps.idleSec() } catch { idle = undefined }
    if (typeof idle === 'number' && Number.isFinite(idle) && idle * 1000 < p.delayMs) {
      timer.set(key, now() + p.delayMs - Math.max(0, idle) * 1000)
      return
    }
    pending.delete(key)
    send(p)
  }
  const hold = (key: Key, p: Pending): void => {
    if (p.delayMs <= 0 || (!pending.has(key) && pending.size >= PENDING_MAX)) { send(p); return }
    pending.set(key, p)
    timer.set(key, now() + p.delayMs)
  }

  return {
    route(notice) {
      hold(`pane:${notice.paneId}`, { kind: 'pane', notice, delayMs: delayMs() })
    },
    routeTeam(notice) {
      // A push: false row reaches no remote channel anyway (the router drops it).
      if (!notice.push) { send({ kind: 'team', notice, delayMs: 0 }); return }
      hold(`team:${notice.tag}`, { kind: 'team', notice, delayMs: delayMs() })
    },
    seen(paneId) {
      const key: Key = `pane:${paneId}`
      if (!pending.delete(key)) return
      timer.clear(key)
    },
    pendingCount: () => pending.size,
    dispose() {
      pending.clear()
      timer.dispose()
    },
  }
}
