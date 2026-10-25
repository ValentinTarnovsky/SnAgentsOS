/**
 * Te necesita of a team (app 2.7.0, E10 B4 the queue and the kickoff, B5 the
 * rest): the needs view main answers (`needs`: trust, pause, approvals, cards
 * and the "Por despachar" queue, each item with the reason a dispatch dry run
 * gives for it), the user's answers to that queue (`dispatch`: Despachar one
 * or all, Descartar), the autonomy switch (`settings {autoDispatch}`) and the
 * empty board's kickoff (`kickoff`: the Lead reads the goal and splits it into
 * tasks). B5: the decisions (`decide`: Aprobar, Pedir cambios, Rechazar), the
 * answers to questions and system cards (`answer`) and the new-need toast.
 * Main owns every state and checks every gate (an approved item skips only
 * the autonomy one); this store keeps the last answer per team and refetches
 * through onTeamChanged (the core's policy: only the team on screen). Never
 * persisted.
 */
import { create } from 'zustand'
import type { Language } from '@shared/types'
import type { ApprovalKind, CardAnswer } from '@shared/teams'
import type { QueueItemView, TeamError, TeamFail, TeamNeedsView, TeamReply } from '@shared/team-protocol'
import { teamNeedKey, teamNeedsRows, type TeamNeedRow } from '@shared/teamNeeds'
import { onTeamChanged, openTeams, refreshTeamList, setTeamTab, teamReq, teamsOverlayActive, useTeamsStore } from '@/lib/teamsStore'
import { useAppStore } from '@/lib/store'
import { useAgentStore } from '@/lib/agentStore'
import { toast } from '@/lib/toast'
import { translate, type MessageKey, type TFn } from '@/i18n'

export interface NeedsState {
  /** teamId -> the last needs view main answered. */
  needs: Record<string, TeamNeedsView>
  /** Teams whose last pull did not come, with main's error (`unsupported`: that main has no Te necesita yet). */
  failed: Record<string, TeamError>
  /** busyKey(teamId, queueId | 'all' | approvalId | cardId) -> a request on its way to main (its buttons wait). */
  busy: Record<string, true>
  /** One shot: the team whose "Por despachar" section takes the keyboard when it shows (the header's count). */
  focusQueue: string | null
  /** One shot: the need row that takes the keyboard when Te necesita shows (the new-need toast's Abrir). */
  focusNeed: { teamId: string; rowId: string } | null
}

const EMPTY: NeedsState = { needs: {}, failed: {}, busy: {}, focusQueue: null, focusNeed: null }

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
  noticeNewNeeds(teamId, res.needs)
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

// ---- decisions and answers (B5) ---------------------------------------------------------------------------

function setBusy(key: string, on: boolean): void {
  useNeedsStore.setState((s) => {
    if (on) return { busy: { ...s.busy, [key]: true } }
    if (!s.busy[key]) return {}
    const busy = { ...s.busy }
    delete busy[key]
    return { busy }
  })
}

/**
 * Aprobar, Pedir cambios or Rechazar of one approval (`decide`: a plan, a
 * final OK, a hire, a permission; an integrate approval lands through Integrar
 * alone, B6, so it is never decided here). The note reaches the agent as a
 * review comment; "Pedir cambios" requires one (its editor checks it). The
 * buttons wait for main's answer and for the needs view that follows it, so a
 * row goes when main says so. Null once main applied it.
 */
export async function decide(teamId: string, approvalId: string, decision: 'approve' | 'reject', note?: string): Promise<TeamFail | null> {
  const key = busyKey(teamId, approvalId)
  setBusy(key, true)
  const text = note?.trim()
  const res = await teamReq({ op: 'decide', teamId, approvalId, decision, ...(text ? { note: text } : {}) })
  // A refusal (already decided, gone) or a decision: either way main's needs now are the truth.
  await loadNeeds(teamId)
  setBusy(key, false)
  return res.ok ? null : res
}

/**
 * The answer to a card (`answer`): the options of a question (one, or several
 * when it allows it), a text, Hecho / No puedo, or the action of a system card
 * (Reintentar, Volver a Por hacer, Reanudar el equipo...). Main applies it in
 * one commit and the asking agent gets it in its next run. Null once applied.
 */
export async function answerCard(teamId: string, cardId: string, answer: CardAnswer): Promise<TeamFail | null> {
  const key = busyKey(teamId, cardId)
  setBusy(key, true)
  const res = await teamReq({ op: 'answer', teamId, cardId, answer })
  await loadNeeds(teamId)
  setBusy(key, false)
  return res.ok ? null : res
}

/**
 * A refused decision in the catalog's words (never main's detail). `kind`: the approval's, so a hire proposed against a
 * definition trusted since then (main cancels it; a decide that still races answers conflict stale) says so.
 */
export function decideFailText(f: TeamFail, t: TFn, kind?: ApprovalKind): string {
  switch (f.error) {
    case 'conflict':
      if (f.reason === 'already_decided') return t('teams.err.decided')
      return t(f.reason === 'stale' && kind === 'hire' ? 'teams.err.hireStale' : 'teams.err.gone')
    case 'not_found':
      return t('teams.err.gone')
    case 'forbidden':
      return t('teams.err.forbidden')
    case 'changed':
      return t('teams.err.changed')
    case 'invalid_definition':
      return t('teams.err.invalid')
    case 'untrusted':
      return t('teams.err.untrusted')
    case 'disabled':
      return t('teams.run.fail.disabled')
    case 'busy':
    case 'running':
    case 'stopping':
      return t('teams.err.busy')
    case 'bad_request':
      // A permission approval whose every rule the policy now refuses (an earlier build stored them): main's own code word.
      return t(f.detail === 'nothingToGrant' ? 'teams.err.nothingToGrant' : 'teams.err.decideFailed')
    default:
      return t('teams.err.decideFailed')
  }
}

/** A refused answer in the catalog's words. */
export function answerFailText(f: TeamFail, t: TFn): string {
  if (f.error === 'conflict') return t(f.reason === 'already_decided' ? 'teams.err.answered' : 'teams.err.gone')
  if (f.error === 'bad_request') return t('teams.err.badAnswer')
  if (f.error === 'not_found' || f.error === 'forbidden' || f.error === 'untrusted' || f.error === 'disabled' || f.error === 'busy' || f.error === 'running' || f.error === 'stopping') return decideFailText(f, t)
  return t('teams.err.answerFailed')
}

/** Te necesita of a team, with the keyboard on one of its rows (the new-need toast's Abrir). */
export function openNeed(teamId: string, rowId: string): void {
  useNeedsStore.setState({ focusNeed: { teamId, rowId } })
  openTeams(teamId, 'needs')
}

/** The row took the keyboard (or is gone): the one shot is spent. */
export function needFocused(): void {
  if (useNeedsStore.getState().focusNeed) useNeedsStore.setState({ focusNeed: null })
}

// ---- the new-need toast (B5) ------------------------------------------------------------------------------

/** How long the toast stays (it carries an action). */
const NEED_TOAST_MS = 8000

/**
 * The need rows already seen of the team on screen. The first pull after the
 * team comes on screen is the baseline (main's own notices cover the time it
 * was not: a pending approval or an open card that was there is never
 * announced again), and each later pull announces the rows main pushes
 * (rank 1 and 2: trust, an auth or billing pause, approvals, cards) that were
 * not there. Off screen, or on another team, it starts over.
 */
let seen: { teamId: string; ids: Set<string> } | null = null

function onScreen(teamId: string): boolean {
  return teamsOverlayActive() && useTeamsStore.getState().openTeamId === teamId
}

/** "Plan para aprobar · t-3": what one row is, in the user's language. */
function rowLine(row: TeamNeedRow, needs: TeamNeedsView, lang: Language): string {
  const system = row.kind === 'card' && !!needs.cards.find((c) => c.id === row.id)?.system
  const what = translate(lang, system ? 'teams.need.cardSystem' : (teamNeedKey(row) as MessageKey))
  return row.taskId ? `${what} · ${row.taskId}` : what
}

function noticeNewNeeds(teamId: string, needs: TeamNeedsView): void {
  if (!onScreen(teamId)) {
    if (seen?.teamId === teamId) seen = null
    return
  }
  const rows = teamNeedsRows(needs)
  const prev = seen?.teamId === teamId ? seen.ids : null
  seen = { teamId, ids: new Set(rows.map((r) => r.id)) }
  if (!prev) return
  const fresh = rows.filter((r) => r.push && !prev.has(r.id))
  // On Te necesita itself the new rows show right there.
  if (fresh.length === 0 || useTeamsStore.getState().tab === 'needs') return
  const lang = useAppStore.getState().settings.language
  const team = useTeamsStore.getState().list.find((x) => x.id === teamId)?.name ?? ''
  const key = `teams.need:${teamId}`
  const first = fresh[0]
  toast.warning(translate(lang, 'teams.toast.title', { team }), {
    body: fresh.length === 1 ? rowLine(first, needs, lang) : translate(lang, 'teams.toast.many', { count: fresh.length }),
    dedupeKey: key,
    durationMs: NEED_TOAST_MS,
    actions: [
      {
        label: translate(lang, 'teams.toast.open'),
        run: () => {
          toast.dismissByKey(key)
          openNeed(teamId, first.id)
        },
      },
    ],
  })
}

// ---- sync ------------------------------------------------------------------------------------------------

/** One `teams:changed` hands its scopes over one by one (the core's debounce): a pull waits this long to fold them. */
const SCOPE_FOLD_MS = 16

/**
 * Keeps the loaded needs views current while the lab is on (startTeams): a
 * change of the team's needs (the queue, approvals, cards), its agents or runs
 * (a run that starts or ends moves every defer reason: caps, sessions,
 * folders) or the team (trust, pause) pulls that team's view again, once
 * however many scopes came; `disabled` clears everything. A pull that brings
 * a new row that needs the user raises the new-need toast (B5); the overlay
 * closing or switching teams starts its baseline over.
 */
export function initNeedsSync(): () => void {
  generation++
  const gen = generation
  seen = null
  const due = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  const offView = useAgentStore.subscribe((s, p) => {
    if (s.view !== p.view && s.view !== 'teams') seen = null
  })
  const offTeam = useTeamsStore.subscribe((s, p) => {
    if (s.openTeamId !== p.openTeamId) seen = null
  })
  const off = onTeamChanged((e) => {
    if (e.scopes.includes('disabled')) {
      inFlight.clear()
      seen = null
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
    offView()
    offTeam()
    if (timer) clearTimeout(timer)
    generation++
    seen = null
    seq.clear()
    inFlight.clear()
    useNeedsStore.setState({ ...EMPTY })
  }
}
