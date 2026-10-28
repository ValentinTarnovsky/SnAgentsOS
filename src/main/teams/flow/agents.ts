/**
 * Agents and team flags (app 2.7.0, E10 B1): the roster follows the trusted
 * definition, and the `settings` op flips autonomy and the user pause. Pure.
 */
import { agentIdOf, agentIndexOf, type AgentState, type CardAction, type CardReason, type TeamCard, type TeamRuntime } from '@shared/teams'
import type { FlowCtx, FlowResult, TeamEffect } from './types'

function newAgent(id: string, role: { id: string; kind: AgentState['roleKind']; provider: AgentState['provider'] }): AgentState {
  return { id, roleId: role.id, roleKind: role.kind, provider: role.provider, status: 'idle', paused: false, sessions: {}, interrupts: 0 }
}

/** Idle and not held by a takeover: nothing references the agent but its sessions. */
function isFree(a: AgentState): boolean {
  return a.status === 'idle' && !a.runId && !a.takeover
}

/**
 * The roster of the trusted definition: `agentIdOf(role, 1..count)` for every
 * role, in definition order (decision 20: raising `count` never renames an
 * agent nor drops its sessions). An agent whose role or index left the
 * definition is removed when free, else marked `retired` until it is. A free
 * agent takes its role's kind and provider; a provider change drops its
 * sessions (a Claude session cannot resume under Codex). The same `rt` comes
 * back when nothing changed, so the commit is skipped.
 */
export function reconcileAgents(rt: TeamRuntime, ctx: FlowCtx): FlowResult {
  const byId = new Map(rt.agents.map((a) => [a.id, a]))
  const wanted = new Set<string>()
  const next: AgentState[] = []
  let changed = false
  for (const role of ctx.def.def.roles) {
    const count = role.kind === 'lead' ? 1 : role.count
    for (let n = 1; n <= count; n++) {
      const id = agentIdOf(role.id, n)
      wanted.add(id)
      const cur = byId.get(id)
      if (!cur || cur.roleId !== role.id) {
        // A missing agent, or an id another role used to own (never reuse its sessions).
        if (cur && !isFree(cur)) {
          // Still busy under its old role: keep it retired and add the new one later.
          wanted.delete(id)
          continue
        }
        next.push(newAgent(id, role))
        changed = true
        continue
      }
      let a = cur
      if (a.retired) {
        a = { ...a }
        delete a.retired
      }
      if (isFree(a) && (a.roleKind !== role.kind || a.provider !== role.provider)) {
        a = { ...a, roleKind: role.kind, ...(a.provider !== role.provider ? { provider: role.provider, sessions: {} } : {}) }
      }
      if (a !== cur) changed = true
      next.push(a)
    }
  }
  for (const a of rt.agents) {
    if (wanted.has(a.id) && next.some((b) => b.id === a.id && b.roleId === a.roleId)) continue
    if (isFree(a)) {
      changed = true
      continue
    }
    if (a.retired) next.push(a)
    else {
      next.push({ ...a, retired: true })
      changed = true
    }
  }
  if (!changed && next.length === rt.agents.length && next.every((a, i) => a === rt.agents[i])) {
    return { ok: true, rt, effects: [], result: undefined }
  }
  return { ok: true, rt: { ...rt, agents: next }, effects: [], result: undefined }
}

/**
 * The B1 `settings` op: autonomy on/off and the user pause. Unpausing lifts any
 * pause (the user always wins); lifting an auth or billing pause dismisses its
 * open auth and billing cards, as the card's own resumeTeam does (B5).
 * Turning autonomy on or lifting a pause pokes the dispatcher. 2.9.0: the
 * Piloto automatico switch; turning it on turns autonomy on too (runs waiting
 * in "Por despachar" would still wait on the user), turning it off leaves
 * autonomy as it is.
 */
export function setTeamFlags(rt: TeamRuntime, f: { autoDispatch?: boolean; paused?: boolean; autopilot?: boolean }, ctx: Pick<FlowCtx, 'now'>): FlowResult {
  let out = rt
  let poke = false
  if (f.autopilot === true && !rt.autopilot) {
    out = { ...out, autopilot: true }
    if (f.autoDispatch === undefined) f = { ...f, autoDispatch: true }
    poke = true
  } else if (f.autopilot === false && rt.autopilot) {
    out = { ...out }
    delete out.autopilot
  }
  if (f.autoDispatch !== undefined && f.autoDispatch !== rt.autoDispatch) {
    out = { ...out, autoDispatch: f.autoDispatch }
    poke ||= f.autoDispatch
  }
  if (f.paused === true && rt.paused === null) out = { ...out, paused: { reason: 'user', at: ctx.now } }
  if (f.paused === false && rt.paused !== null) {
    out = { ...out, paused: null }
    poke = true
    if (rt.paused.reason !== 'user') out = dismissPauseCards(out)
  }
  const effects: TeamEffect[] = poke ? [{ kind: 'dispatch' }] : []
  return { ok: true, rt: out, effects, result: undefined }
}

/**
 * Opens a system card (no agent text: `question` is empty, the renderer shows
 * `teams.cardWhy.<why>` with `vars`). An open card with the same reason, task
 * and `vars.what` already exists -> the same rt (a reason is raised once).
 */
export function openSystemCard(
  rt: TeamRuntime,
  card: { why: CardReason; actions: CardAction[]; taskId?: string; runId?: string; vars?: Record<string, string | number> },
  ctx: Pick<FlowCtx, 'now'>,
): FlowResult<{ cardId: string | null }> {
  const dup = rt.cards.find(
    (c) => c.state === 'open' && c.from.kind === 'system' && c.from.why === card.why && c.taskId === card.taskId && c.from.vars?.what === card.vars?.what,
  )
  if (dup) return { ok: true, rt, effects: [], result: { cardId: null } }
  const id = `k-${rt.nextIds.card}`
  const from: TeamCard['from'] = { kind: 'system', why: card.why, actions: [...card.actions] }
  if (card.runId) from.runId = card.runId
  if (card.vars) from.vars = { ...card.vars }
  const c: TeamCard = { id, kind: 'confirm', question: '', options: [], multi: false, state: 'open', from, createdAt: ctx.now }
  if (card.taskId) c.taskId = card.taskId
  return {
    ok: true,
    rt: { ...rt, cards: [...rt.cards, c], nextIds: { ...rt.nextIds, card: rt.nextIds.card + 1 } },
    effects: [],
    result: { cardId: id },
  }
}

/** A lifted auth or billing pause takes every open auth and billing card with it (the settings op, the card's resumeTeam). */
export function dismissPauseCards(rt: TeamRuntime): TeamRuntime {
  const goes = (c: TeamCard): boolean => c.state === 'open' && c.from.kind === 'system' && (c.from.why === 'auth' || c.from.why === 'billing')
  if (!rt.cards.some(goes)) return rt
  return { ...rt, cards: rt.cards.map((c) => (goes(c) ? { ...c, state: 'dismissed' as const } : c)) }
}

/** Dismisses the open system cards of one reason (and `vars.what`), e.g. a trust stateReset once trusted again. */
export function dismissSystemCards(rt: TeamRuntime, why: CardReason, what: string | undefined): FlowResult {
  let changed = false
  const cards = rt.cards.map((c) => {
    if (c.state !== 'open' || c.from.kind !== 'system' || c.from.why !== why || c.from.vars?.what !== what) return c
    changed = true
    return { ...c, state: 'dismissed' as const }
  })
  return { ok: true, rt: changed ? { ...rt, cards } : rt, effects: [], result: undefined }
}

/** 1-based index of an agent within its role (`dev` 1, `dev-2` 2), 1 when it does not parse. */
export function agentIndex(a: Pick<AgentState, 'id' | 'roleId'>): number {
  return agentIndexOf(a.id, a.roleId) ?? 1
}
