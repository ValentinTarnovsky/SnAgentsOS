/**
 * Keeps the PC awake while agents work (E5-FR-23). Main decides; the renderer
 * only persists `settings.awakeMode` / `settings.agents.awakeDisplay`.
 *
 * Modes:
 *  - `always`: hold the block with no agents at all,
 *  - `never`: never request it,
 *  - `auto` (default): hold it while at least one pane is `working` with an
 *    update younger than 2 h, or a pane waits in `action` with a phone
 *    connected. When that stops being true the block survives a 120 s grace.
 *
 * Electron's powerSaveBlocker, powerMonitor and the timers are injected so the
 * whole policy runs under fakes in scripts/test-agents.cjs. Re-evaluation is
 * O(panes) per status change.
 */
import type { PowerState } from '@shared/ipc-contract'
import type { AwakeMode, ClaudePaneState, PaneStatusEvt } from '@shared/types'

/** How long the block survives once Auto stops needing it. */
export const AWAKE_GRACE_MS = 120 * 1000
/** A `working` pane with no update for this long no longer keeps the PC awake. */
export const AWAKE_STALE_MS = 2 * 60 * 60 * 1000

export type AwakeBlockerType = 'prevent-app-suspension' | 'prevent-display-sleep'

/** The slice of Electron's powerSaveBlocker the service uses. */
export interface AwakeBlocker {
  start(type: AwakeBlockerType): number
  stop(id: number): void
  isStarted(id: number): boolean
}

/** The slice of Electron's powerMonitor the service uses. */
export interface AwakeResumeSource {
  on(event: 'resume', listener: () => void): unknown
  removeListener(event: 'resume', listener: () => void): unknown
}

export interface AwakeDeps {
  blocker: AwakeBlocker
  power?: AwakeResumeSource
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

const MODES: readonly AwakeMode[] = ['auto', 'always', 'never']

export function isAwakeMode(v: unknown): v is AwakeMode {
  return typeof v === 'string' && (MODES as readonly string[]).includes(v)
}

interface PaneMark {
  state: ClaudePaneState
  updatedAt: number
}

export class AwakeService {
  private mode: AwakeMode = 'auto'
  private display = false
  private phone = false
  private readonly panes = new Map<string, PaneMark>()
  private blockerId: number | null = null
  private blockerType: AwakeBlockerType | null = null
  private reason: 'agents' | 'always' | null = null
  private workingCount = 0
  private releaseAt: number | null = null
  private graceTimer: unknown = null
  private staleTimer: unknown = null
  private staleAt = Infinity
  private lastEmitted = ''
  private disposed = false
  private readonly listeners = new Set<(state: PowerState) => void>()
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly deps: AwakeDeps) {
    this.now = deps.now ?? Date.now
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
    this.lastEmitted = JSON.stringify(this.getState())
    deps.power?.on('resume', this.onResume)
  }

  setMode(mode: AwakeMode): void {
    if (!isAwakeMode(mode) || mode === this.mode) return
    this.mode = mode
    this.evaluate()
  }

  /** `awakeDisplay`: swap the held block for the display-sleep one (stop, then start). */
  setDisplay(display: boolean): void {
    const next = display === true
    if (next === this.display) return
    this.display = next
    if (this.blockerId !== null && this.blockerType !== this.wantedType()) {
      this.stopBlocker()
      this.startBlocker()
    }
    this.evaluate()
  }

  /** At least one authenticated phone session is connected. */
  setPhoneConnected(connected: boolean): void {
    if (connected === this.phone) return
    this.phone = connected
    this.evaluate()
  }

  /** Every StatusManager emit, including `state: null` when a pane clears. */
  onPaneStatus(evt: PaneStatusEvt): void {
    this.track(evt)
    this.evaluate()
  }

  /** Initial statuses (StatusManager.snapshot()). */
  seed(evts: PaneStatusEvt[]): void {
    for (const evt of evts) this.track(evt)
    this.evaluate()
  }

  getState(): PowerState {
    const blocking = this.blockerId !== null
    const state: PowerState = {
      blocking,
      reason: blocking ? this.reason : null,
      mode: this.mode,
      display: this.display,
      workingCount: this.workingCount,
    }
    if (blocking && this.releaseAt !== null) state.releaseAt = this.releaseAt
    return state
  }

  /** Called with the new state whenever any field of it changes. */
  onChange(cb: (state: PowerState) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** Releases the block and stops listening. Runs on the way out of the app. */
  dispose(): void {
    if (this.disposed) return
    this.release()
    this.disarmStale()
    this.disposed = true
    this.deps.power?.removeListener('resume', this.onResume)
    this.listeners.clear()
  }

  // --- internals --------------------------------------------------------------

  private track(evt: PaneStatusEvt): void {
    if (!evt || typeof evt.paneId !== 'string') return
    if (evt.state === null || evt.state === undefined) this.panes.delete(evt.paneId)
    else this.panes.set(evt.paneId, { state: evt.state, updatedAt: evt.updatedAt ?? this.now() })
  }

  /**
   * After a suspend the old request may no longer be honored (and the grace or
   * the 2 h lease may have run out while asleep): request it again, then
   * re-evaluate with the wall clock.
   */
  private readonly onResume = (): void => {
    if (this.disposed) return
    if (this.blockerId !== null) {
      this.stopBlocker()
      this.startBlocker()
    }
    this.evaluate()
  }

  private evaluate(): void {
    if (this.disposed) return
    const now = this.now()
    let working = 0
    let waiting = false
    let nextStale = Infinity
    for (const pane of this.panes.values()) {
      if (pane.state === 'working') {
        const staleAt = pane.updatedAt + AWAKE_STALE_MS
        if (staleAt > now) {
          working += 1
          if (staleAt < nextStale) nextStale = staleAt
        }
      } else if (pane.state === 'action') waiting = true
    }
    this.workingCount = working
    this.armStale(nextStale, now)

    if (this.mode === 'never') {
      this.release()
    } else if (this.mode === 'always') {
      this.cancelGrace()
      this.reason = 'always'
      this.acquire()
    } else if (working > 0 || (waiting && this.phone)) {
      this.cancelGrace()
      this.reason = 'agents'
      this.acquire()
    } else if (this.blockerId !== null && this.reason === 'agents') {
      // Auto stopped needing it: keep it for the grace, then let go.
      if (this.releaseAt === null) this.releaseAt = now + AWAKE_GRACE_MS
      if (now >= this.releaseAt) this.release()
      else if (this.graceTimer === null) {
        this.graceTimer = this.setTimer(() => {
          this.graceTimer = null
          this.evaluate()
        }, this.releaseAt - now)
      }
    } else {
      // Held for `always` and switched to Auto with nothing to do: an explicit
      // choice, so no grace.
      this.release()
    }
    this.emit()
  }

  private wantedType(): AwakeBlockerType {
    return this.display ? 'prevent-display-sleep' : 'prevent-app-suspension'
  }

  private acquire(): void {
    const id = this.blockerId
    if (id !== null && this.blockerType === this.wantedType() && this.deps.blocker.isStarted(id)) return
    if (id !== null) this.stopBlocker()
    this.startBlocker()
  }

  private startBlocker(): void {
    const type = this.wantedType()
    try {
      this.blockerId = this.deps.blocker.start(type)
      this.blockerType = type
    } catch (error) {
      console.warn('[awake] powerSaveBlocker.start failed:', error)
      this.blockerId = null
      this.blockerType = null
    }
  }

  private stopBlocker(): void {
    const id = this.blockerId
    this.blockerId = null
    this.blockerType = null
    if (id === null) return
    try {
      if (this.deps.blocker.isStarted(id)) this.deps.blocker.stop(id)
    } catch {
      /* already gone */
    }
  }

  private release(): void {
    this.cancelGrace()
    this.stopBlocker()
    this.reason = null
  }

  private cancelGrace(): void {
    this.releaseAt = null
    if (this.graceTimer !== null) {
      this.clearTimer(this.graceTimer)
      this.graceTimer = null
    }
  }

  /** One timer for the earliest moment a counted `working` pane goes stale. */
  private armStale(at: number, now: number): void {
    if (at === this.staleAt) return
    this.disarmStale()
    if (!Number.isFinite(at)) return
    this.staleAt = at
    this.staleTimer = this.setTimer(() => {
      this.staleTimer = null
      this.staleAt = Infinity
      this.evaluate()
    }, Math.max(0, at - now) + 1)
  }

  private disarmStale(): void {
    if (this.staleTimer !== null) this.clearTimer(this.staleTimer)
    this.staleTimer = null
    this.staleAt = Infinity
  }

  private emit(): void {
    const state = this.getState()
    const key = JSON.stringify(state)
    if (key === this.lastEmitted) return
    this.lastEmitted = key
    for (const cb of this.listeners) {
      try {
        cb(state)
      } catch (error) {
        console.warn('[awake] state listener failed:', error)
      }
    }
  }
}
