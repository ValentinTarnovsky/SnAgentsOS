/**
 * The dispatch passes of every team (app 2.7.0, E10 B4, design 3.6 and 3.0
 * items 4 and 6). One pass at a time, globally: each team gets its facts (from
 * memory only, never a disk read) and one step (the reconcile commit,
 * planDispatch, the queue and admission commits and their effects). Teams are
 * visited least recently served first, so the global cap is shared fairly.
 *
 * Event driven: a poke arms the `dispatch` deadline at now (bursts coalesce on
 * the next tick); a pass re-arms it at the nearest `until` it deferred on
 * (cooldown, provider block, retry). Nothing polls: without a deferred `until`
 * and without a poke the key is gone. While the service is not live, a poke
 * arms nothing (Labs off, frozen).
 */
import type { DeferInfo, DispatchFacts, DispatchPlan, RunRequest } from '@shared/teams'
import type { DeadlineTimer } from '../DeadlineTimer'

/** The DeadlineTimer key of the passes (design 3.10). */
export const DISPATCH_KEY = 'dispatch'

export type ManualRequest = DispatchFacts['manual'][number]

/** What one team's step did: its plan and the runs it admitted (the request each came from). */
export interface StepResult {
  plan: DispatchPlan
  started: Array<{ request: RunRequest; runId: string }>
}

export interface DispatcherDeps {
  teams: () => string[]
  /** Facts of one team for this pass; null skips it (not loaded, removed meanwhile). */
  facts: (teamId: string, pass: { globalActive: number; writers: Set<string> }, manual: readonly ManualRequest[]) => DispatchFacts | null
  /** reconcileTasks commit, planDispatch, enqueue and admission commits, effects. */
  step: (teamId: string, facts: DispatchFacts) => StepResult
  /** planDispatch on the current runtime with no commit (AgentView.waiting, QueueItemView.defer). */
  plan: (teamId: string, facts: DispatchFacts) => DispatchPlan
  /** The answer for a manual request no candidate came from (a busy agent: running, stopping, taken over). */
  unplanned: (teamId: string, m: ManualRequest) => DeferInfo
  timer: DeadlineTimer<string>
  now: () => number
  /** TeamService enabled && !frozen. */
  live: () => boolean
  log: (line: string) => void
}

export class Dispatcher {
  private running = false
  private again = false
  /** When each team last admitted a run (fair order of the global cap). */
  private readonly served = new Map<string, number>()

  constructor(private readonly deps: DispatcherDeps) {}

  /** One pass on the next tick; bursts coalesce. No-op while not live (3.0 item 6). */
  poke(): void {
    if (!this.deps.live()) return
    if (this.running) {
      this.again = true
      return
    }
    this.armAt(this.deps.now())
  }

  /** Clears the key (disable, shutdownSync); the next poke after an enable arms it again. */
  stop(): void {
    this.again = false
    this.deps.timer.clear(DISPATCH_KEY)
  }

  /** The `dispatch` deadline: one pass over every team, then the key at the nearest deferred `until`. */
  onDue(): void {
    if (!this.deps.live()) return
    if (this.running) {
      this.again = true
      return
    }
    const nextAt = this.pass(null)
    if (nextAt !== null) this.armAt(nextAt)
  }

  /**
   * "Ejecutar ahora" and kickoff (decision 44): an immediate pass with the
   * manual request (approved, past the autonomy gate and the cooldown; every
   * other gate still applies). Its start or its defer.
   */
  manual(teamId: string, m: ManualRequest): { runId: string } | { defer: DeferInfo } {
    if (!this.deps.live()) return { defer: { reason: 'disabled' } }
    if (this.running) return { defer: { reason: 'running' } }
    let out: { runId: string } | { defer: DeferInfo } | null = null
    const nextAt = this.pass({ teamId, m, found: (r) => (out = r) })
    if (nextAt !== null) this.armAt(nextAt)
    return out ?? { defer: this.deps.unplanned(teamId, m) }
  }

  /** planDispatch of one team now, without committing anything (null when the team has no facts). */
  dryRun(teamId: string): DispatchPlan | null {
    if (!this.deps.live()) return null
    const facts = this.deps.facts(teamId, { globalActive: 0, writers: new Set() }, [])
    return facts ? this.deps.plan(teamId, facts) : null
  }

  /** Teams in fair order: never served first, then least recently served, then id. */
  private order(): string[] {
    const ids = this.deps.teams()
    for (const id of [...this.served.keys()]) if (!ids.includes(id)) this.served.delete(id)
    return [...ids].sort((a, b) => (this.served.get(a) ?? 0) - (this.served.get(b) ?? 0) || (a < b ? -1 : a > b ? 1 : 0))
  }

  /**
   * One pass; with `target` the manual request rides in its team's facts and
   * that team goes first (the user is waiting on it). The nearest `until` of
   * every deferred request, or null.
   */
  private pass(target: { teamId: string; m: ManualRequest; found: (r: { runId: string } | { defer: DeferInfo }) => void } | null): number | null {
    this.running = true
    let nextAt: number | null = null
    try {
      const writers = new Set<string>()
      let globalActive = 0
      let ids = this.order()
      if (target) ids = [target.teamId, ...ids.filter((id) => id !== target.teamId)]
      for (const teamId of ids) {
        const manual = target && target.teamId === teamId ? [target.m] : []
        let res: StepResult
        try {
          const facts = this.deps.facts(teamId, { globalActive, writers }, manual)
          if (!facts) continue
          res = this.deps.step(teamId, facts)
          globalActive = facts.globalActive + res.started.length
        } catch (err) {
          this.deps.log(`dispatch ${teamId} failed ${(err as Error).name}: ${(err as Error).message}`.slice(0, 300))
          continue
        }
        if (res.started.length > 0) this.served.set(teamId, this.deps.now())
        for (const d of res.plan.deferred) if (d.until !== undefined && (nextAt === null || d.until < nextAt)) nextAt = d.until
        if (res.plan.nextAt !== null && (nextAt === null || res.plan.nextAt < nextAt)) nextAt = res.plan.nextAt
        if (target && target.teamId === teamId) {
          const mine = res.started.find((s) => s.request.agentId === target.m.agentId)
          if (mine) target.found({ runId: mine.runId })
          else {
            const d = res.plan.deferred.find((x) => x.request.agentId === target.m.agentId)
            if (d) {
              const defer: DeferInfo = { reason: d.reason }
              if (d.until !== undefined) defer.until = d.until
              if (d.request.taskId) defer.taskId = d.request.taskId
              target.found({ defer })
            }
          }
        }
      }
    } finally {
      this.running = false
    }
    if (this.again) {
      this.again = false
      const now = this.deps.now()
      nextAt = nextAt === null ? now : Math.min(nextAt, now)
    }
    return nextAt
  }

  /** The key at `at`, never later than a poke already armed (a pass never pushes a pending one back). */
  private armAt(at: number): void {
    if (!this.deps.live()) return
    const cur = this.deps.timer.at(DISPATCH_KEY)
    this.deps.timer.set(DISPATCH_KEY, cur === undefined ? at : Math.min(cur, at))
  }
}
