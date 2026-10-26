/**
 * Team routines on the TeamService DeadlineTimer (app 2.7.0, E10 B7, design
 * 3.8 and 3.10): one key `routine:<teamId>:<routineId>` per enabled routine,
 * armed at its next cron time (`nextCron`, local wall clock), never a poll.
 * Without an armed team there is no key at all (Labs off, a freeze, a remove).
 *
 * On its deadline a routine fires through the `fire` dep (TeamService:
 * lastScheduledFor first, then the wake or the task) and is armed again at its
 * next time after the one it fired for. A fire that finds the agent's wake slot
 * taken asks for a retry: the key comes back at that time for the same
 * scheduled time, kept across a re-arm while the routine keeps its cron. A
 * wake already fired that later loses its slot to a run-end policy re-wake of
 * the agent gets the same retry (`retry`, TeamService), and TeamService keeps
 * its scheduled time on the routine (`displacedFor`) until it lands.
 *
 * catchUp is enable()'s: what came due while the app (or the lab) was off runs
 * once when its last due time is within ROUTINE_CATCHUP_MS (2 h); an older one
 * is skipped and logged, and the caller records it (`skippedFor`). A displaced
 * wake whose retry never landed (a quit, Labs off, an install, a crash) is one
 * of those due times: its `displacedFor`, when nothing newer came due.
 */
import { nextCron, parseCron, type CronSpec } from '@shared/cron'
import { ROUTINE_CATCHUP_MS, type RoutineDef, type RoutineState } from '@shared/teams'
import type { DeadlineTimer } from '../DeadlineTimer'

export const ROUTINE_KEY_PREFIX = 'routine:'
/** A fire whose agent holds another wake tries again this much later (until ROUTINE_CATCHUP_MS past its due time). */
export const ROUTINE_SLOT_RETRY_MS = 5 * 60_000

export function routineKey(teamId: string, routineId: string): string {
  return `${ROUTINE_KEY_PREFIX}${teamId}:${routineId}`
}

/** What a fire asks of the ticker: nothing (armed at the next cron time), or the same fire again at `retryAt`. */
export type RoutineFireOutcome = undefined | { retryAt: number }

export interface RoutineTickerDeps {
  timer: DeadlineTimer<string>
  now: () => number
  fire: (teamId: string, r: RoutineDef, scheduledAt: number) => RoutineFireOutcome
  log: (line: string) => void
}

/** A missed due time catchUp found: to run now, or skipped (older than ROUTINE_CATCHUP_MS). */
export interface MissedRoutine { routine: RoutineDef; scheduledAt: number; skipped?: true }

/** The latest due time of `spec` in `(after, until]`, or null: windows grow back from `until`, so a dense rule reads a few runs. */
export function lastDue(spec: CronSpec | string, after: number, until: number): number | null {
  const s = typeof spec === 'string' ? parseCron(spec) : spec
  if (!s || !Number.isFinite(after) || !Number.isFinite(until) || after >= until) return null
  const first = nextCron(s, after)
  if (first === null || first > until) return null
  for (let span = ROUTINE_CATCHUP_MS; ; span *= 4) {
    const from = Math.max(after, until - span)
    let last: number | null = null
    for (let t = nextCron(s, from); t !== null && t <= until; t = nextCron(s, t)) last = t
    if (last !== null) return last
    if (from === after) return first
  }
}

export class RoutineTicker {
  /** The routines of every armed team (a re-arm replaces them). */
  private readonly teams = new Map<string, readonly RoutineDef[]>()
  /** key -> the scheduled time its deadline fires for; `retry` while it waits for a free wake slot. */
  private readonly due = new Map<string, { teamId: string; routineId: string; scheduledAt: number; retry?: true }>()

  constructor(private readonly deps: RoutineTickerDeps) {}

  /**
   * Key `routine:<teamId>:<id>` at nextCron(cron, now) for every enabled routine (after its lastScheduledFor when the
   * clock went back); disabled and removed routines arm nothing (their keys go). A routine waiting on a retry keeps
   * it while its cron is the same.
   */
  arm(teamId: string, routines: readonly RoutineDef[], state: Readonly<Record<string, RoutineState>>): void {
    const prev = this.teams.get(teamId) ?? []
    this.teams.set(teamId, routines)
    const keep = new Set<string>()
    for (const r of routines) {
      if (!r.enabled) continue
      const key = routineKey(teamId, r.id)
      keep.add(key)
      const cur = this.due.get(key)
      if (cur?.retry && prev.find((x) => x.id === r.id)?.cron === r.cron && this.deps.timer.has(key)) continue
      this.armNext(teamId, r, state[r.id]?.lastScheduledFor)
    }
    for (const [key, d] of [...this.due]) if (d.teamId === teamId && !keep.has(key)) this.clear(key)
  }

  /** Every key of the team cleared (Labs off, shutdownSync, a remove). */
  disarm(teamId: string): void {
    this.teams.delete(teamId)
    for (const [key, d] of [...this.due]) if (d.teamId === teamId) this.clear(key)
  }

  disarmAll(): void {
    for (const id of [...this.teams.keys()]) this.disarm(id)
    for (const key of [...this.due.keys()]) this.clear(key)
  }

  /** A `routine:` deadline (true: the key is this ticker's, fired or stale). */
  onDue(key: string): boolean {
    if (!key.startsWith(ROUTINE_KEY_PREFIX)) return false
    const d = this.due.get(key)
    if (!d) return true
    this.due.delete(key)
    this.fire(d.teamId, d.routineId, d.scheduledAt)
    return true
  }

  /**
   * Fires a routine of an armed team for `scheduledAt` (its deadline, or a catch-up), then arms it again: at the
   * retry it asks for, else at its next cron time after `scheduledAt`. A routine no longer armed (removed, disabled)
   * fires nothing; a team disarmed during the fire is not armed again.
   */
  fire(teamId: string, routineId: string, scheduledAt: number): void {
    const key = routineKey(teamId, routineId)
    const r = this.teams.get(teamId)?.find((x) => x.id === routineId && x.enabled)
    if (!r) {
      this.clear(key)
      return
    }
    let out: RoutineFireOutcome = undefined
    try {
      out = this.deps.fire(teamId, r, scheduledAt)
    } catch (err) {
      this.deps.log(`routine ${teamId} ${routineId} fire failed ${(err as Error).name}`)
    }
    if (!this.teams.has(teamId)) return
    if (out && Number.isFinite(out.retryAt)) {
      this.due.set(key, { teamId, routineId, scheduledAt, retry: true })
      this.deps.timer.set(key, out.retryAt)
      return
    }
    this.armNext(teamId, r, scheduledAt)
  }

  /**
   * The wake a routine already fired lost its agent's slot (TeamService: a run-end policy wrote its own re-wake over
   * it): the same fire again at `retryAt` for `scheduledAt`, so its prompt still runs once. A key that comes due
   * sooner is kept (that fire places the wake, or asks for its own retry); a team or a routine no longer armed gets none.
   * True only when this armed the retry.
   */
  retry(teamId: string, routineId: string, scheduledAt: number, retryAt: number): boolean {
    if (!Number.isFinite(retryAt) || !this.teams.get(teamId)?.some((x) => x.id === routineId && x.enabled)) return false
    const key = routineKey(teamId, routineId)
    const at = this.deps.timer.at(key)
    if (at !== undefined && at <= retryAt) return false
    this.due.set(key, { teamId, routineId, scheduledAt, retry: true })
    this.deps.timer.set(key, retryAt)
    return true
  }

  /**
   * enable(): for every enabled routine, the last due time after its last fire, skip or manual run (else `since`, the
   * trust time, for one that never fired) and up to now; else the `displacedFor` of a wake that lost its agent's slot
   * and never landed. Within ROUTINE_CATCHUP_MS it runs once (an older due time before it, or a displaced wake, is
   * covered by that one run); beyond, it is skipped and logged. Nothing missed -> nothing.
   */
  catchUp(teamId: string, routines: readonly RoutineDef[], state: Readonly<Record<string, RoutineState>>, since?: number): MissedRoutine[] {
    const now = this.deps.now()
    const out: MissedRoutine[] = []
    for (const r of routines) {
      if (!r.enabled) continue
      const s = state[r.id]
      const marks = [s?.lastScheduledFor, s?.skippedFor, s?.lastFiredAt].filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
      const base = marks.length ? Math.max(...marks) : since
      const displaced = typeof s?.displacedFor === 'number' && Number.isFinite(s.displacedFor) ? s.displacedFor : null
      const last = (base === undefined ? null : lastDue(r.cron, base, now)) ?? displaced
      if (last === null) continue
      if (now - last <= ROUTINE_CATCHUP_MS) {
        out.push({ routine: r, scheduledAt: last })
        continue
      }
      this.deps.log(`routine ${teamId} ${r.id} skipped: due ${new Date(last).toISOString()} missed by ${Math.round((now - last) / 60_000)} min`)
      out.push({ routine: r, scheduledAt: last, skipped: true })
    }
    return out
  }

  /** The deadline of a routine's key (the views' `nextAt`), or null when it is not armed. */
  nextAt(teamId: string, routineId: string): number | null {
    return this.deps.timer.at(routineKey(teamId, routineId)) ?? null
  }

  /** Keys this ticker holds (tests: none with Labs off). */
  get size(): number {
    return this.due.size
  }

  private armNext(teamId: string, r: RoutineDef, after: number | undefined): void {
    const key = routineKey(teamId, r.id)
    const now = this.deps.now()
    const at = nextCron(r.cron, after !== undefined && after > now ? after : now)
    if (at === null) {
      this.deps.log(`routine ${teamId} ${r.id} has no next time`)
      this.clear(key)
      return
    }
    this.due.set(key, { teamId, routineId: r.id, scheduledAt: at })
    this.deps.timer.set(key, at)
  }

  private clear(key: string): void {
    this.due.delete(key)
    this.deps.timer.clear(key)
  }
}
