/**
 * Notice discipline (app 2.7.0, A5): a burst of notices reaches each remote
 * channel (Web Push, Discord, ntfy) as at most NOTICE_BURST messages plus one
 * summary per NOTICE_WINDOW_MS. createNoticeRouter builds one coalescer per
 * channel, after the away gate and after that channel's own filter (its
 * notifyDone / notifyAction; for ntfy also a phone watching the pane), so a
 * notice a channel would drop never takes one of its slots.
 *
 *  - A window opens with the first notice that finds none open and lasts
 *    10 s. Its first 3 notices go out at once; the rest are held and, when
 *    the window closes, go out as ONE summary (summaryNotice:
 *    'status.push.digest' with the count, and the places of the held
 *    notices when they are short).
 *  - An `immediate` notice (the router passes every `action`: an agent
 *    blocked on the user) is never held, does not take one of the 3 and
 *    never opens a window.
 *  - One timer per channel, armed only while something is held: an idle
 *    channel has none, and a window that held nothing just expires on the
 *    next notice's clock read. A clock that moved past the window (or back)
 *    closes it right there, the summary first.
 *  - The summary text is redacted (redactCredentials) like every notice; a
 *    channel that throws never escapes the timer.
 *
 * Teams notices (B8, routeTeam) go through these same coalescers.
 */
import { BRAND } from '@shared/brand'
import { redactCredentials } from '@shared/redact'
import type { AgentProvider, ConfigFile } from '@shared/types'
import type { DeadlineTimerDeps } from '../DeadlineTimer'
import { mainT } from '../i18n'
import { describePlace, type CustomNotice, type StatusNotice } from './events'

/** One window per channel. */
export const NOTICE_WINDOW_MS = 10_000
/** Notices of a window that go out at once. */
export const NOTICE_BURST = 3
/** Longest list of places a summary carries; a longer one is left out. */
export const SUMMARY_PLACES_MAX = 160

export interface NoticeCoalescerOptions<T> {
  /** Sends one notice now (the channel's own send). */
  deliver: (item: T) => void
  /** Sends the one summary of the notices held in a window that closed (always at least one). */
  summarize: (held: T[]) => void
  /** Never held nor counted (the router: an `action` notice). */
  immediate?: (item: T) => boolean
  /** Clock and timers; the real ones by default. */
  timers?: DeadlineTimerDeps
  windowMs?: number
  burst?: number
}

export interface NoticeCoalescer<T> {
  push: (item: T) => void
  /** Notices held right now. */
  heldCount: () => number
  /** True while the window timer is armed (only while something is held). */
  pending: () => boolean
  /** Drops what is held and the timer. */
  dispose: () => void
}

export function createNoticeCoalescer<T>(opts: NoticeCoalescerOptions<T>): NoticeCoalescer<T> {
  const now = opts.timers?.now ?? (() => Date.now())
  const setTimer = opts.timers?.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = opts.timers?.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const windowMs = opts.windowMs ?? NOTICE_WINDOW_MS
  const burst = opts.burst ?? NOTICE_BURST
  /** Start of the open window, null without one. */
  let openedAt: number | null = null
  let sent = 0
  let queue: T[] = []
  let armed = false
  let handle: unknown = null

  const disarm = (): void => {
    if (armed) clearTimer(handle)
    armed = false
    handle = null
  }
  /** Ends the window; what it held goes out as one summary. */
  const close = (): void => {
    disarm()
    openedAt = null
    sent = 0
    const held = queue
    queue = []
    if (!held.length) return
    try { opts.summarize(held) } catch { /* a channel failure never escapes the timer */ }
  }
  const onTimer = (): void => {
    armed = false
    handle = null
    close()
  }

  return {
    push(item) {
      if (opts.immediate?.(item)) { opts.deliver(item); return }
      const at = now()
      if (openedAt !== null && (at - openedAt >= windowMs || at < openedAt)) close()
      if (openedAt === null) openedAt = at
      if (sent < burst) { sent++; opts.deliver(item); return }
      queue.push(item)
      if (!armed) {
        armed = true
        handle = setTimer(onTimer, Math.max(0, openedAt + windowMs - at))
      }
    },
    heldCount: () => queue.length,
    pending: () => armed,
    dispose() {
      disarm()
      queue = []
      openedAt = null
      sent = 0
    },
  }
}

type HeldNotice = StatusNotice | CustomNotice

/** A `snaos notify` (kind custom) rather than an agent notice. */
export function isCustomNotice(n: HeldNotice): n is CustomNotice {
  return (n as CustomNotice).kind === 'custom'
}

/**
 * The one StatusNotice that stands for `held` (paneId '', `summary` set):
 * 'status.push.digest' with the count and the distinct places of the held
 * notices when they fit in SUMMARY_PLACES_MAX, both redacted. Its state is
 * 'error' when any held one was an error, else 'done' (a custom notice
 * counts as done), so the desktop's notifyDone / notifyAction that let the
 * held notices through let it through too (RemoteManager.notifyPush).
 */
export function summaryNotice(held: readonly HeldNotice[], config: ConfigFile | null): StatusNotice {
  const places: string[] = []
  let provider: AgentProvider | undefined
  let error = false
  for (const n of held) {
    const { place } = describePlace(n.paneId, config, '')
    if (place && !places.includes(place)) places.push(place)
    if (isCustomNotice(n)) continue
    provider ??= n.provider
    if (n.state === 'error') error = true
  }
  const joined = places.join(', ')
  return {
    paneId: '',
    provider: provider ?? 'claude',
    state: error ? 'error' : 'done',
    summary: {
      count: held.length,
      text: redactCredentials(mainT(config, 'status.push.digest', { n: held.length, app: BRAND.productName })),
      places: joined.length <= SUMMARY_PLACES_MAX ? redactCredentials(joined) : '',
    },
  }
}
