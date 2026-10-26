/**
 * Run silence reducers (app 2.7.0, E10 B7, design 3.8 and 4.5): the one
 * `stalled` system card of a run (Frenar, Seguir esperando), dismissed when
 * the run streams again, when the user ignores its silence and when it ends;
 * and `runSilenceAck`, which ignores the rest of that run. The silence itself
 * (quiet, stalled) lives in TeamService memory, never in the runtime. Pure.
 */
import type { Run, TeamRuntime } from '@shared/teams'
import { dismissSystemCards, openSystemCard } from './agents'
import type { FlowCtx, FlowResult } from './types'

/** One per run (`vars.what` = the run id; openSystemCard dedups an open one), on the run's task when it has one. */
export function openStalledCard(rt: TeamRuntime, run: Pick<Run, 'id' | 'agentId' | 'taskId'>, ctx: Pick<FlowCtx, 'now'>): FlowResult<{ cardId: string | null }> {
  return openSystemCard(rt, { why: 'stalled', actions: ['stopRun', 'keepWaiting'], taskId: run.taskId, runId: run.id, vars: { what: run.id, agentId: run.agentId } }, ctx)
}

/** The run's open `stalled` card dismissed; the same rt without one. */
export function dismissStalledCard(rt: TeamRuntime, runId: string): TeamRuntime {
  const res = dismissSystemCards(rt, 'stalled', runId)
  return res.ok ? res.rt : rt
}

/**
 * Every open `stalled` card whose run is not active dismissed (a load: the reaper ended those runs without the
 * run-end path); the same rt without one.
 */
export function dismissStaleStalledCards(rt: TeamRuntime): TeamRuntime {
  const active = new Set(rt.activeRuns.map((r) => r.id))
  let changed = false
  const cards = rt.cards.map((c) => {
    if (c.state !== 'open' || c.from.kind !== 'system' || c.from.why !== 'stalled' || (c.from.runId !== undefined && active.has(c.from.runId))) return c
    changed = true
    return { ...c, state: 'dismissed' as const }
  })
  return changed ? { ...rt, cards } : rt
}

/**
 * runSilenceAck ("Ignorar el silencio de esta corrida"): the run keeps `silenceAckedAt` (the watch ignores the rest of
 * it) and its open stalled card goes. A run that is over has nothing to ignore: the same rt.
 */
export function ackRunSilence(rt: TeamRuntime, runId: string, ctx: Pick<FlowCtx, 'now'>): FlowResult {
  const run = rt.activeRuns.find((r) => r.id === runId)
  if (!run) return { ok: true, rt, effects: [], result: undefined }
  let out = run.silenceAckedAt !== undefined ? rt : { ...rt, activeRuns: rt.activeRuns.map((r) => (r.id === runId ? { ...r, silenceAckedAt: ctx.now } : r)) }
  out = dismissStalledCard(out, runId)
  return { ok: true, rt: out, effects: [], result: undefined }
}
