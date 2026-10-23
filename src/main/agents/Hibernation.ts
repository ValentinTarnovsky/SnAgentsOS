/**
 * Agent hibernation (E5-FR-25, D3): opt-in, puts idle Claude/Codex consoles
 * to sleep to give their memory back. The chat stays in the agent's own
 * transcript and the console resumes it on wake (E5-FR-26).
 *
 * Two parts:
 * - planHibernation(): the pure planner. A console is eligible when it runs
 *   Claude or Codex, sits in idle/done for at least N minutes, got no input
 *   (desktop or phone) for N minutes, is not visible, has no phone
 *   subscribed, has no schedule coming up, has no open `snaos needs` (App
 *   2.7.0) and its session record is available. It must look exactly the
 *   same on two consecutive ticks (same state, stateSince and lastInputAt),
 *   and at most 3 go per tick.
 * - HibernationCoordinator: the 60 s tick over main's live sources. The
 *   interval exists only while hibernation is on. Putting a console to sleep
 *   is explicit (D3): the registry marks hibernatedAt first, so the end that
 *   follows the kill never closes the chat, then the renderer hears about it
 *   and the pty is killed. Nothing here depends on an unmount.
 *
 * Clock, timers and every source are injected (scripts/test-hibernation.cjs).
 */
import type { AgentProvider, ClaudePaneState, ConfigFile, PaneSchedule, PaneStatusEvt } from '@shared/types'
import { HIBERNATE_MAX_PER_TICK, HIBERNATE_TICK_MS, normalizeIdleMinutes, type AgentsHibernateEvt, type HibernationConfig } from '@shared/hibernation'
import { isScheduleEnabled } from '@shared/schedule'

const MIN_MS = 60_000

/** One console as the planner sees it. */
export interface HibernationCandidate {
  paneId: string
  provider?: AgentProvider
  state: ClaudePaneState | null
  /** Epoch ms of the last change of the effective state. */
  stateSince?: number
  /** Epoch ms of the last input written to the pane (desktop or phone). */
  lastInputAt?: number
  /** A live pty to kill. */
  live: boolean
  /** On screen (or held by a scheduled run in flight). */
  visible: boolean
  /** A phone is subscribed to it. */
  subscribed: boolean
  /** Its schedule runs soon or is waiting for the agent. */
  schedulePending: boolean
  /**
   * App 2.7.0 (A3): its agent asked the user something (`snaos needs`), muted
   * or not. That includes the minimal idle status of a pane with no track,
   * which exists only while the request is open.
   */
  needs?: boolean
}

export interface PlanInput {
  candidates: readonly HibernationCandidate[]
  idleMinutes: number
  now: number
  /** Signatures seen on the previous tick (paneId -> signature). */
  previous: ReadonlyMap<string, string>
  /** Session record available === true. Asked last, only for consoles that passed every other rule. */
  isAvailable: (paneId: string) => boolean
  maxPerTick?: number
}

export interface PlanResult {
  /** Consoles to put to sleep now, oldest idle first. */
  sleep: string[]
  /** Signatures of every eligible console this tick (the next tick's `previous`). */
  next: Map<string, string>
}

/** Confirmation signature between ticks: any change of state, its start or an input restarts the count. */
export function hibernationSignature(c: Pick<HibernationCandidate, 'state' | 'stateSince' | 'lastInputAt'>): string {
  return `${c.state}:${c.stateSince ?? ''}:${c.lastInputAt ?? ''}`
}

/** Every rule except the two-tick confirmation and the cap (exported for tests). */
export function isEligible(c: HibernationCandidate, idleMinutes: number, now: number): boolean {
  const idleMs = idleMinutes * MIN_MS
  if (idleMs <= 0 || !c.live || c.needs) return false
  if (c.provider !== 'claude' && c.provider !== 'codex') return false
  if (c.state !== 'idle' && c.state !== 'done') return false
  if (typeof c.stateSince !== 'number' || now - c.stateSince < idleMs) return false
  if (typeof c.lastInputAt === 'number' && now - c.lastInputAt < idleMs) return false
  return !c.visible && !c.subscribed && !c.schedulePending
}

/** The pure planner (E5-FR-25). */
export function planHibernation(input: PlanInput): PlanResult {
  const idle = normalizeIdleMinutes(input.idleMinutes)
  const next = new Map<string, string>()
  const confirmed: HibernationCandidate[] = []
  if (idle === 0) return { sleep: [], next }
  for (const c of input.candidates) {
    if (!isEligible(c, idle, input.now)) continue
    if (!input.isAvailable(c.paneId)) continue
    const sig = hibernationSignature(c)
    next.set(c.paneId, sig)
    if (input.previous.get(c.paneId) === sig) confirmed.push(c)
  }
  confirmed.sort((a, b) => (a.stateSince ?? 0) - (b.stateSince ?? 0) || (a.paneId < b.paneId ? -1 : a.paneId > b.paneId ? 1 : 0))
  const max = Math.max(0, input.maxPerTick ?? HIBERNATE_MAX_PER_TICK)
  return { sleep: confirmed.slice(0, max).map((c) => c.paneId), next }
}

/**
 * A schedule that keeps its console awake: active and either waiting for the
 * agent or due within `windowMs` (or overdue). A console that would wake for
 * it within the idle window is not worth putting to sleep.
 */
export function schedulePending(schedule: PaneSchedule | undefined, now: number, windowMs: number): boolean {
  if (!schedule || !isScheduleEnabled(schedule)) return false
  if (schedule.waitingSince !== undefined) return true
  return typeof schedule.dueAt === 'number' && schedule.dueAt - now <= windowMs
}

/** paneId -> schedule from a persisted config. */
export function schedulesOf(cfg: ConfigFile | null): Map<string, PaneSchedule> {
  const out = new Map<string, PaneSchedule>()
  for (const ws of cfg?.workspaces ?? []) {
    if (!Array.isArray(ws.panes)) continue
    for (const pane of ws.panes) if (pane.schedule) out.set(pane.id, pane.schedule)
  }
  return out
}

export interface HibernationDeps {
  /** Live agent status of every tracked console. */
  statuses: () => PaneStatusEvt[]
  lastInputAt: (paneId: string) => number | undefined
  hasPty: (paneId: string) => boolean
  /** Consoles a phone is subscribed to (a sub never wakes, and a subscribed console never sleeps). */
  subscribedPaneIds: () => Set<string>
  /** The session registry says the chat can be resumed (available === true). */
  isAvailable: (paneId: string) => boolean
  /** Persisted config, read only on ticks with a console that passed the cheap rules. */
  getConfig: () => ConfigFile | null
  /** Puts one console to sleep: mark the record, tell the renderer, kill the pty. */
  hibernate: (evt: AgentsHibernateEvt) => void
  now?: () => number
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
}

export class HibernationCoordinator {
  private idleMinutes = 0
  private keep = new Set<string>()
  /** False until the renderer pushed its view, and again after it reloads. */
  private rendererReady = false
  private previous = new Map<string, string>()
  private timer: unknown = null
  private readonly now: () => number
  private readonly setTick: (fn: () => void, ms: number) => unknown
  private readonly clearTick: (handle: unknown) => void

  constructor(private readonly deps: HibernationDeps) {
    this.now = deps.now ?? Date.now
    this.setTick = deps.setInterval ?? ((fn, ms) => {
      const id = setInterval(fn, ms)
      id.unref?.()
      return id
    })
    this.clearTick = deps.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>))
  }

  /** Renderer push (`agents:setHibernation`): the setting and the consoles to keep awake. */
  setConfig(cfg: Partial<HibernationConfig> | null | undefined): void {
    if (!cfg || typeof cfg !== 'object') return
    const idle = normalizeIdleMinutes(cfg.idleMinutes)
    if (idle !== this.idleMinutes) this.previous.clear()
    this.idleMinutes = idle
    this.keep = new Set(Array.isArray(cfg.keep) ? cfg.keep.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128).slice(0, 1000) : [])
    this.rendererReady = true
    this.sync()
  }

  /** The renderer reloaded or died: nothing sleeps until it pushes its view again. */
  rendererGone(): void {
    this.rendererReady = false
    this.previous.clear()
    this.sync()
  }

  get running(): boolean {
    return this.timer !== null
  }

  get minutes(): number {
    return this.idleMinutes
  }

  /** One planner pass (the interval calls it; exported for tests). Returns the consoles put to sleep. */
  tick(): string[] {
    if (!this.rendererReady || this.idleMinutes === 0) return []
    const now = this.now()
    const subscribed = this.deps.subscribedPaneIds()
    const idleMs = this.idleMinutes * MIN_MS
    let schedules: Map<string, PaneSchedule> | null = null
    const candidates: HibernationCandidate[] = []
    for (const s of this.deps.statuses()) {
      const c: HibernationCandidate = {
        paneId: s.paneId,
        provider: s.provider,
        state: s.state,
        stateSince: s.stateSince,
        lastInputAt: this.deps.lastInputAt(s.paneId),
        live: this.deps.hasPty(s.paneId),
        visible: this.keep.has(s.paneId),
        subscribed: subscribed.has(s.paneId),
        schedulePending: false,
        needs: !!s.needs,
      }
      if (!isEligible(c, this.idleMinutes, now)) continue
      schedules ??= schedulesOf(this.deps.getConfig())
      c.schedulePending = schedulePending(schedules.get(s.paneId), now, idleMs)
      candidates.push(c)
    }
    const plan = planHibernation({ candidates, idleMinutes: this.idleMinutes, now, previous: this.previous, isAvailable: this.deps.isAvailable })
    this.previous = plan.next
    for (const paneId of plan.sleep) {
      this.previous.delete(paneId)
      this.deps.hibernate({ paneId, at: now, idleMinutes: this.idleMinutes })
    }
    return plan.sleep
  }

  dispose(): void {
    if (this.timer !== null) this.clearTick(this.timer)
    this.timer = null
  }

  /** The interval runs only while hibernation is on and the renderer is there. */
  private sync(): void {
    const want = this.rendererReady && this.idleMinutes > 0
    if (want && this.timer === null) this.timer = this.setTick(() => this.tick(), HIBERNATE_TICK_MS)
    else if (!want && this.timer !== null) this.dispose()
  }
}
