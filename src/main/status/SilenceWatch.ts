import type { PaneSilence, SilenceLevel, SilenceSettings } from '@shared/types'
import { DeadlineTimer, type DeadlineTimerDeps } from '../DeadlineTimer'

const MIN_MS = 60_000

/** What the watch asks of its owner (StatusManager). */
export interface SilenceHost {
  /** The pane's last sign of life (epoch ms on the watch's clock), or undefined. */
  signalAt(paneId: string): number | undefined
  /** A level was reached with no signal since `silence.since`: the host shows it and publishes. */
  onSilence(paneId: string, silence: PaneSilence): void
}

interface Watched {
  /** The signalAt the silence counts from. */
  from: number
  /** The level already reported for `from`, or null for none yet. */
  level: SilenceLevel | null
}

/**
 * App 2.7.0 (A3): a working agent with no sign of life for quietMin minutes
 * reads `quiet`, for stalledMin `stalled`. It never kills and never writes to
 * a pty: it only tells its host, which publishes `silence {level, since}`.
 *
 * The host decides which panes are watched (a precise track in `working`
 * whose turn was not acknowledged) and calls `watch` / `unwatch`; the watch
 * keeps one deadline per pane behind a single DeadlineTimer, so with nothing
 * working no timer is pending (the 2.7.0 background-work rule).
 *
 * Signals are lazy: they never touch the timer (a streaming agent sends one
 * per line). When a deadline fires and the pane's signalAt moved past the one
 * it counted from, it re-arms from the new signal; otherwise it reports the
 * level it reached and arms the next one (stalled after quiet, nothing after
 * stalled). A signal that ends an active silence is the host's to clear
 * (`rearm`), once per silence, so the next quiet is never late.
 *
 * Never configured (null) or `enabled: false` arms no deadline at all; the
 * set of watched panes is kept, so turning it back on re-arms them.
 */
export class SilenceWatch {
  private settings: SilenceSettings | null = null
  private readonly panes = new Map<string, Watched>()
  private readonly timer: DeadlineTimer
  private readonly now: () => number

  constructor(private readonly host: SilenceHost, deps: DeadlineTimerDeps = {}) {
    this.now = deps.now ?? (() => Date.now())
    this.timer = new DeadlineTimer((paneId) => this.due(paneId), { ...deps, now: this.now })
  }

  /**
   * Settings already normalized (normalizeSilence). True when they changed:
   * every watched pane is judged again from its `from` with the new minutes
   * (a deadline already past fires on the next tick; the host keeps a level
   * it already shows, and clears one the new minutes no longer reach).
   */
  configure(settings: SilenceSettings | null): boolean {
    const prev = this.settings
    const same = prev === null || settings === null
      ? prev === settings
      : prev.enabled === settings.enabled && prev.quietMin === settings.quietMin && prev.stalledMin === settings.stalledMin
    if (same) return false
    this.settings = settings ? { enabled: settings.enabled, quietMin: settings.quietMin, stalledMin: settings.stalledMin } : null
    for (const [paneId, w] of this.panes) {
      w.level = null
      this.arm(paneId, w)
    }
    return true
  }

  get enabled(): boolean {
    return this.settings?.enabled === true
  }

  /** The level a silence of `ms` reaches with the current settings, or null (none, or the watch is off). */
  levelFor(ms: number): SilenceLevel | null {
    const s = this.settings
    if (!s?.enabled || !Number.isFinite(ms)) return null
    if (ms >= s.stalledMin * MIN_MS) return 'stalled'
    if (ms >= s.quietMin * MIN_MS) return 'quiet'
    return null
  }

  /** Starts watching the pane from its signalAt (now without one). A pane already watched is left as it is. */
  watch(paneId: string): void {
    if (this.panes.has(paneId)) return
    const w: Watched = { from: this.host.signalAt(paneId) ?? this.now(), level: null }
    this.panes.set(paneId, w)
    this.arm(paneId, w)
  }

  /** A signal ended the pane's silence: count again from its signalAt. */
  rearm(paneId: string): void {
    this.panes.delete(paneId)
    this.watch(paneId)
  }

  /** The pane left working, its turn was acknowledged or it went away. */
  unwatch(paneId: string): void {
    if (this.panes.delete(paneId)) this.timer.clear(paneId)
  }

  watching(paneId: string): boolean {
    return this.panes.has(paneId)
  }

  /** The pane's pending deadline (tests), or undefined. */
  deadlineOf(paneId: string): number | undefined {
    return this.timer.at(paneId)
  }

  dispose(): void {
    this.panes.clear()
    this.timer.dispose()
  }

  /** The next deadline of the pane: quiet, then stalled, then none. */
  private arm(paneId: string, w: Watched): void {
    const s = this.settings
    if (!s?.enabled) {
      this.timer.clear(paneId)
      return
    }
    const at = w.level === null ? w.from + s.quietMin * MIN_MS : w.level === 'quiet' ? w.from + s.stalledMin * MIN_MS : NaN
    this.timer.set(paneId, at)
  }

  private due(paneId: string): void {
    const w = this.panes.get(paneId)
    if (!w || !this.enabled) return
    const signal = this.host.signalAt(paneId)
    if (signal !== undefined && signal > w.from) {
      // A sign of life since the deadline was armed: count from it.
      w.from = signal
      w.level = null
      this.arm(paneId, w)
      return
    }
    const level = this.levelFor(this.now() - w.from)
    if (level && level !== w.level) {
      w.level = level
      this.host.onSilence(paneId, { level, since: w.from })
    }
    // The host may have dropped or re-armed the pane meanwhile.
    if (this.panes.get(paneId) === w) this.arm(paneId, w)
  }
}
