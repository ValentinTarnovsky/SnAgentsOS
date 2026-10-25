/**
 * Te necesita of a team (app 2.7.0, E10 B4 the queue and the kickoff, B5 the
 * rest): the needs view main answers (`needs`: trust, pause, approvals, cards
 * and the "Por despachar" queue, each item with the reason a dispatch dry run
 * gives for it), the user's answers to that queue (`dispatch`: Despachar one
 * or all, Descartar), the autonomy switch (`settings {autoDispatch}`) and the
 * empty board's kickoff (`kickoff`: the Lead reads the goal and splits it into
 * tasks). Main owns every state and checks every gate (an approved item skips
 * only the autonomy one); this store keeps the last answer per team and
 * refetches through onTeamChanged (the core's policy: only the team on
 * screen). Never persisted.
 */
import { create } from 'zustand'
import type { QueueItemView, TeamError, TeamFail, TeamNeedsView, TeamReply } from '@shared/team-protocol'
import { onTeamChanged, refreshTeamList, setTeamTab, teamReq, useTeamsStore } from '@/lib/teamsStore'

export interface NeedsState {
  /** teamId -> the last needs view main answered. */
  needs: Record<string, TeamNeedsView>
  /** Teams whose last pull did not come, with main's error (`unsupported`: that main has no Te necesita yet). */
  failed: Record<string, TeamError>
  /** busyKey(teamId, queueId | 'all') -> a dispatch on its way to main (its buttons wait). */
  busy: Record<string, true>
  /** One shot: the team whose "Por despachar" section takes the keyboard when it shows (the header's count). */
  focusQueue: string | null
}

const EMPTY: NeedsState = { needs: {}, failed: {}, busy: {}, focusQueue: null }

export const useNeedsStore = create<NeedsState>(() => ({ ...EMPTY }))

export function busyKey(teamId: string, queueId: string): string {
  return `${teamId}/${queueId}`
}

/** The queue items still waiting for the user's OK (the "Te necesita" rank 3 rows, teamNeedsRows). */
export function pendingQueue(needs: TeamNeedsView | undefined): QueueItemView[] {
  return needs ? needs.queue.filter((q) => !q.approved) : []
}

/** Per team, the newest pull: an older answer that lands late is dropped. */
const seq = new Map<string, number>()
/** Teams with a pull in flight (ensureNeeds leaves them alone). */
const inFlight = new Set<string>()
/** Bumped by every initNeedsSync and its teardown: an answer from an older life is dropped. */
let generation = 0

/** Pulls one team's needs view. Null when it did not come (the store keeps the last one it had). */
export async function loadNeeds(teamId: string): Promise<TeamNeedsView | null> {
  const n = (seq.get(teamId) ?? 0) + 1
  seq.set(teamId, n)
  const gen = generation
  inFlight.add(teamId)
  const res = await teamReq({ op: 'needs', teamId })
  if (gen !== generation || seq.get(teamId) !== n) return useNeedsStore.getState().needs[teamId] ?? null
  inFlight.delete(teamId)
  if (!res.ok) {
    useNeedsStore.setState((s) => ({ failed: { ...s.failed, [teamId]: res.error } }))
    return null
  }
  useNeedsStore.setState((s) => {
    const failed = { ...s.failed }
    delete failed[teamId]
    return { needs: { ...s.needs, [teamId]: res.needs }, failed }
  })
  return res.needs
}

/**
 * Pulls the needs view for a surface that shows it from now on (the header's
 * count, the tab), never twice in flight. A view already held is pulled again:
 * no event reaches a team while it is off screen (the core's policy), so the
 * one kept from its last visit may be old. A main without the op is not asked again.
 */
export function ensureNeeds(teamId: string): void {
  if (useNeedsStore.getState().failed[teamId] === 'unsupported' || inFlight.has(teamId)) return
  void loadNeeds(teamId)
}

/** Main's answer to a dispatch, applied at once: approved items stay until they start, dropped ones go. */
function applyDispatch(teamId: string, approved: readonly string[], dropped: readonly string[]): void {
  useNeedsStore.setState((s) => {
    const cur = s.needs[teamId]
    if (!cur) return {}
    const ok = new Set(approved)
    const gone = new Set(dropped)
    const queue = cur.queue.filter((q) => !gone.has(q.id)).map((q) => (ok.has(q.id) && !q.approved ? { ...q, approved: true } : q))
    return { needs: { ...s.needs, [teamId]: { ...cur, queue } } }
  })
}

/**
 * Despachar (`go`) or Descartar one queued run, or every one that waits for
 * the user (`'all'`, Despachar todo). An approved run skips only the autonomy
 * gate: it still waits for the team caps, its session, its folder (its row
 * says why). Main's reply, applied to the store before the refetch lands.
 */
export async function dispatchQueued(teamId: string, queueId: string | 'all', go: boolean): Promise<TeamReply<'dispatch'>> {
  const key = busyKey(teamId, queueId)
  useNeedsStore.setState((s) => ({ busy: { ...s.busy, [key]: true } }))
  const res = await teamReq({ op: 'dispatch', teamId, queueId, go })
  useNeedsStore.setState((s) => {
    const busy = { ...s.busy }
    delete busy[key]
    return { busy }
  })
  if (res.ok) applyDispatch(teamId, Array.isArray(res.approved) ? res.approved : [], Array.isArray(res.dropped) ? res.dropped : [])
  // A refusal (gone, untrusted) or a reply: either way main's queue now is the truth.
  void loadNeeds(teamId)
  return res
}

/**
 * The empty board's "Pedile al Líder que arme las tareas": a Lead run now
 * (reason kickoff). Main applies every gate but the autonomy one and answers
 * `deferred` with its reason when one holds. The run id once admitted.
 */
export async function kickoff(teamId: string): Promise<TeamReply<'kickoff'>> {
  return teamReq({ op: 'kickoff', teamId })
}

/** The autonomy switch (header and sidebar kebab): the `settings` op. Null once main applied it. */
export async function setAutoDispatch(teamId: string, on: boolean): Promise<TeamFail | null> {
  const res = await teamReq({ op: 'settings', teamId, patch: { autoDispatch: on } })
  if (!res.ok) return res
  useTeamsStore.setState((s) => ({ views: { ...s.views, [teamId]: res.team } }))
  void refreshTeamList()
  return null
}

/** The header's "N por despachar": Te necesita opens and its "Por despachar" section takes the keyboard. */
export function openDispatchQueue(teamId: string): void {
  useNeedsStore.setState({ focusQueue: teamId })
  setTeamTab('needs')
}

/** The section took the keyboard: the one shot is spent. */
export function queueFocused(teamId: string): void {
  if (useNeedsStore.getState().focusQueue === teamId) useNeedsStore.setState({ focusQueue: null })
}

// ---- sync ------------------------------------------------------------------------------------------------

/** One `teams:changed` hands its scopes over one by one (the core's debounce): a pull waits this long to fold them. */
const SCOPE_FOLD_MS = 16

/**
 * Keeps the loaded needs views current while the lab is on (startTeams): a
 * change of the team's needs (the queue, approvals, cards), its agents or runs
 * (a run that starts or ends moves every defer reason: caps, sessions,
 * folders) or the team (trust, pause) pulls that team's view again, once
 * however many scopes came; `disabled` clears everything.
 */
export function initNeedsSync(): () => void {
  generation++
  const gen = generation
  const due = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  const off = onTeamChanged((e) => {
    if (e.scopes.includes('disabled')) {
      inFlight.clear()
      useNeedsStore.setState({ ...EMPTY })
      return
    }
    const st = useNeedsStore.getState()
    // A main without the `needs` op keeps answering unsupported: no pull per event for it.
    const failed = st.failed[e.teamId]
    const loaded = !!st.needs[e.teamId] || (failed !== undefined && failed !== 'unsupported')
    if (loaded && e.scopes.some((s) => s === 'needs' || s === 'agents' || s === 'run' || s === 'team')) due.add(e.teamId)
    if (due.size === 0 || timer) return
    timer = setTimeout(() => {
      timer = null
      if (gen !== generation) return
      const ids = [...due]
      due.clear()
      for (const id of ids) void loadNeeds(id)
    }, SCOPE_FOLD_MS)
  })
  return () => {
    off()
    if (timer) clearTimeout(timer)
    generation++
    seq.clear()
    inFlight.clear()
    useNeedsStore.setState({ ...EMPTY })
  }
}
