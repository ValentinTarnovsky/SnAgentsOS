/**
 * The phone's Teams screens (app 2.7.0, E10 B8): which team list, board,
 * "Te necesita", Lead chat and task are open, the team list of the Home card,
 * and a per-team change counter that the desktop's `teamChanged` bumps so the
 * open screens refetch what the change names (teamChangeWants). The teams
 * live on the PC (`teamReq` through client.requestTeam); the phone keeps
 * nothing past the pairing (forgetTeams).
 *
 * - Gate: every team item goes only to a desktop >= 2.7.0 (teamsSupported);
 *   with an older one nothing is sent and the store stays empty.
 * - Labs off on the PC (a `disabled` answer or `teamChanged {scopes:
 *   ['disabled']}`) empties the store and closes every screen; Labs on again
 *   comes back as a `list` change, which loads the list again.
 * - Changes coalesce per team over TEAM_CHANGED_MS (scopes merged, one task id
 *   kept only while every change named the same one). A team with no screen
 *   open reacts only to `list`; the list reloads once per burst, never twice
 *   at the same time.
 * - The open flags are module state that survives a reconnect (the screens
 *   stay where they were and refetch, resyncTeams); a revoke, an unpair or
 *   another desktop closes them all.
 */
import { create } from 'zustand'
import { APP_2_7_0, appVersionAtLeast } from '@shared/agentTune'
import { TASK_ID_RE, TEAM_ID_RE, type BoardColumn } from '@shared/teams'
import type { PhoneTeamListItem, TeamReplyFor, TeamScope } from '@shared/team-protocol'
import type { TeamDeepLink } from './deepLink'
import type { PendingOutcome } from './pending'
import { client } from './client'
import { store } from './store'

/** One coalesced change of a team on screen: `seq` goes up by one per burst, `taskId` absent = any task. */
export interface TeamChange {
  rev: number
  seq: number
  scopes: TeamScope[]
  taskId?: string
}

export interface TeamsUi {
  list: PhoneTeamListItem[] | null
  listState: 'idle' | 'loading' | 'ok' | 'noReply' | 'disabled'
  listOpen: boolean
  boardFor: string | null
  needsFor: string | null
  leadFor: string | null
  task: { teamId: string; taskId: string } | null
  column: BoardColumn
  /** Per team on screen, bumped once per TEAM_CHANGED_MS burst of `teamChanged`. */
  changed: Record<string, TeamChange>
  /** Bumped every time a list load settles (a list, `disabled` or no answer). */
  listSeq: number
}

/** How long the changes of one team gather before the screens hear of them. */
export const TEAM_CHANGED_MS = 500

const ALL_SCOPES: readonly TeamScope[] = ['list', 'team', 'board', 'task', 'agents', 'run', 'needs', 'lead', 'notes', 'routines', 'disabled']
/** What a reconnect or a team gone from the list hands the open screens: everything they could show. */
const RESYNC_SCOPES: TeamScope[] = ['team', 'board', 'task', 'agents', 'run', 'needs', 'lead']

const CLOSED = { listOpen: false, boardFor: null, needsFor: null, leadFor: null, task: null } as const

function initial(): TeamsUi {
  return { list: null, listState: 'idle', ...CLOSED, column: 'todo', changed: {}, listSeq: 0 }
}

export const useTeamsUi = create<TeamsUi>(() => initial())

/** The PC can take team requests and ctls (a desktop before 2.7.0 would strike them; 'dev' counts as new). */
export function teamsSupported(appVersion: string | undefined): boolean {
  return appVersionAtLeast(appVersion, APP_2_7_0)
}

// --- the team list (Home card, TeamsScreen, board chips) ---

/** Bumped by forgetTeams / teamsDisabled: the answer of a load started before is dropped. */
let listToken = 0
let listLoading: Promise<void> | null = null
/** A list change landed while a load was out: one more load right after it. */
let listAgain = false
/** openTeamLink without a task: open "Te necesita" over the board once the list says the team needs the user. */
let linkNeedsFor: string | null = null
/** Open teams already reported gone from the list (bumped once, not on every load). */
const missing = new Set<string>()

/**
 * Load the team list (one at a time: a call while a load is out runs one more
 * after it). Nothing is sent to an older desktop. A failed load keeps the list
 * it had (listState 'noReply'); `disabled` empties the store.
 */
export function loadTeamList(): Promise<void> {
  if (!teamsSupported(store.getState().appVersion)) return Promise.resolve()
  if (listLoading) {
    listAgain = true
    return listLoading
  }
  const token = listToken
  const run = (async () => {
    try {
      do {
        listAgain = false
        if (useTeamsUi.getState().list === null) useTeamsUi.setState({ listState: 'loading' })
        const out = await client.requestTeam({ op: 'list' })
        if (token !== listToken) return
        applyList(out)
      } while (listAgain && token === listToken)
    } finally {
      if (token === listToken) listLoading = null
    }
  })()
  listLoading = run
  return run
}

function applyList(out: PendingOutcome<TeamReplyFor<{ op: 'list' }>>): void {
  if (out.ok && !out.value.ok && out.value.error === 'disabled') {
    teamsDisabled()
    return
  }
  if (!out.ok || !out.value.ok) {
    // Another load follows this one (a reconnect ends the load the old socket took): it settles instead.
    if (listAgain) return
    // With the socket down the link keeps waiting: goLive loads the list again.
    if (out.ok || out.error !== 'offline') linkNeedsFor = null
    useTeamsUi.setState((s) => ({ listState: 'noReply', listSeq: s.listSeq + 1 }))
    return
  }
  const list: PhoneTeamListItem[] = Array.isArray(out.value.teams) ? out.value.teams : []
  useTeamsUi.setState((s) => ({ list, listState: 'ok', listSeq: s.listSeq + 1 }))
  // A team on screen that the PC no longer lists (removed): its screens refetch once and show it gone.
  const ids = new Set(list.map((t) => t.id))
  for (const id of [...missing]) if (ids.has(id)) missing.delete(id)
  for (const id of openTeamIds(useTeamsUi.getState())) {
    if (ids.has(id) || missing.has(id)) continue
    missing.add(id)
    bump(id, RESYNC_SCOPES)
  }
  if (linkNeedsFor) {
    const id = linkNeedsFor
    linkNeedsFor = null
    const s = useTeamsUi.getState()
    if (s.boardFor === id && !s.task && !s.needsFor && !s.leadFor) openNeedsIfAny(id)
  }
}

// --- changes from the PC ---

interface Pending {
  rev: number
  scopes: Set<TeamScope>
  taskId?: string
  anyTask: boolean
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, Pending>()
/** One list reload for every `list` change of every team within TEAM_CHANGED_MS. */
let listTimer: ReturnType<typeof setTimeout> | null = null

function clearPending(): void {
  for (const p of pending.values()) clearTimeout(p.timer)
  pending.clear()
  if (listTimer) clearTimeout(listTimer)
  listTimer = null
}

/** A `list` change: the list reloads at the end of the window the first one opened. */
function reloadListSoon(): void {
  if (listTimer || !teamsSupported(store.getState().appVersion)) return
  listTimer = setTimeout(() => {
    listTimer = null
    void loadTeamList()
  }, TEAM_CHANGED_MS)
}

function scopesOf(raw: unknown): TeamScope[] {
  // No scopes on the wire (they are optional) = anything may have changed.
  if (raw === undefined) return ALL_SCOPES.filter((s) => s !== 'disabled')
  if (!Array.isArray(raw)) return []
  return raw.filter((s): s is TeamScope => typeof s === 'string' && (ALL_SCOPES as readonly string[]).includes(s))
}

function openTeamIds(s: TeamsUi): string[] {
  const ids = new Set<string>()
  if (s.boardFor) ids.add(s.boardFor)
  if (s.needsFor) ids.add(s.needsFor)
  if (s.leadFor) ids.add(s.leadFor)
  if (s.task) ids.add(s.task.teamId)
  return [...ids]
}

function bump(teamId: string, scopes: TeamScope[], rev?: number, taskId?: string): void {
  useTeamsUi.setState((s) => {
    const prev = s.changed[teamId]
    const next: TeamChange = { rev: rev ?? prev?.rev ?? 0, seq: (prev?.seq ?? 0) + 1, scopes }
    if (taskId) next.taskId = taskId
    return { changed: { ...s.changed, [teamId]: next } }
  })
}

function flush(teamId: string): void {
  const p = pending.get(teamId)
  if (!p) return
  pending.delete(teamId)
  // Teams with no screen open react only to `list` (reloaded on its own timer).
  if (!openTeamIds(useTeamsUi.getState()).includes(teamId)) return
  if ([...p.scopes].every((s) => s === 'list')) return
  bump(teamId, [...p.scopes], p.rev, p.anyTask ? undefined : p.taskId)
}

/** `teamChanged` from the PC: `disabled` empties the store at once; the rest gathers per team for TEAM_CHANGED_MS. */
export function teamChanged(evt: { teamId: string; rev: number; scopes?: TeamScope[]; taskId?: string }): void {
  if (!evt || typeof evt.teamId !== 'string') return
  const scopes = scopesOf(evt.scopes)
  if (scopes.includes('disabled')) {
    teamsDisabled()
    // The PC's throttle can merge Labs off and on again into one change: the list answer says which one holds.
    if (scopes.includes('list')) reloadListSoon()
    return
  }
  if (scopes.length === 0 || !teamsSupported(store.getState().appVersion)) return
  if (scopes.includes('list')) reloadListSoon()
  // teamId '' is a change of the whole set (Labs on): the list is all it names.
  if (!evt.teamId) return
  const rev = typeof evt.rev === 'number' && Number.isFinite(evt.rev) ? evt.rev : 0
  let p = pending.get(evt.teamId)
  if (!p) {
    const teamId = evt.teamId
    p = { rev, scopes: new Set(), anyTask: false, timer: setTimeout(() => flush(teamId), TEAM_CHANGED_MS) }
    pending.set(teamId, p)
  }
  p.rev = Math.max(p.rev, rev)
  for (const s of scopes) p.scopes.add(s)
  if (scopes.includes('task')) {
    const id = typeof evt.taskId === 'string' && TASK_ID_RE.test(evt.taskId) ? evt.taskId : undefined
    if (!id || (p.taskId !== undefined && p.taskId !== id)) p.anyTask = true
    else p.taskId = id
  }
}

/** What a screen shows; teamChangeWants says whether a change touches it. */
export type TeamChangeTarget = 'board' | 'needs' | 'lead' | 'task' | 'run'

/**
 * Whether a change names what a screen shows, so it refetches only that: the
 * board its pages (`board`; `needs` moves the need dot of a row), "Te
 * necesita" `needs`, the Lead chat `lead` (and `agents` / `run`: whether the
 * Lead is working), a task its detail (`task` of that task or of any, and
 * `needs` for its approvals and cards), a run log `run`.
 */
export function teamChangeWants(change: TeamChange | undefined, what: TeamChangeTarget, taskId?: string): boolean {
  if (!change) return false
  const has = (s: TeamScope): boolean => change.scopes.includes(s)
  switch (what) {
    case 'board':
      return has('board') || has('needs')
    case 'needs':
      return has('needs')
    case 'lead':
      return has('lead') || has('agents') || has('run')
    case 'task':
      return (has('task') && (!change.taskId || !taskId || change.taskId === taskId)) || has('needs')
    case 'run':
      return has('run')
  }
}

/** After a reconnect: changes may have been missed while the socket was down, so every open screen refetches. */
export function resyncTeams(): void {
  for (const id of openTeamIds(useTeamsUi.getState())) bump(id, RESYNC_SCOPES)
}

/** Labs off on the PC: nothing to show, every screen closed; a `list` change brings the list back. */
export function teamsDisabled(): void {
  clearPending()
  listToken++
  listLoading = null
  listAgain = false
  linkNeedsFor = null
  missing.clear()
  useTeamsUi.setState((s) => ({ ...CLOSED, list: null, listState: 'disabled', changed: {}, listSeq: s.listSeq + 1 }))
}

/** Revoke, unpair, another desktop (or one without Teams): everything closed, the list null. */
export function forgetTeams(): void {
  clearPending()
  listToken++
  listLoading = null
  listAgain = false
  linkNeedsFor = null
  missing.clear()
  useTeamsUi.setState(initial())
}

// --- navigation (each screen is open while its field is set) ---

/** Opening a screen of one team closes the screens of any other (the list stays). */
function onlyTeam(s: TeamsUi, teamId: string): Pick<TeamsUi, 'boardFor' | 'needsFor' | 'leadFor' | 'task'> {
  return {
    boardFor: s.boardFor === teamId ? s.boardFor : null,
    needsFor: s.needsFor === teamId ? s.needsFor : null,
    leadFor: s.leadFor === teamId ? s.leadFor : null,
    task: s.task?.teamId === teamId ? s.task : null,
  }
}

export function openTeamsList(): void {
  linkNeedsFor = null
  useTeamsUi.setState({ listOpen: true })
}

export function closeTeamsList(): void {
  linkNeedsFor = null
  useTeamsUi.setState({ listOpen: false })
}

/** The board of a team; the column defaults to the one already shown for that team, else `todo`. */
export function openTeamBoard(teamId: string, column?: BoardColumn): void {
  linkNeedsFor = null
  const s = useTeamsUi.getState()
  useTeamsUi.setState({ ...onlyTeam(s, teamId), boardFor: teamId, column: column ?? (s.boardFor === teamId ? s.column : 'todo') })
}

export function closeTeamBoard(): void {
  linkNeedsFor = null
  useTeamsUi.setState({ boardFor: null })
}

/** The board's column tab. */
export function setTeamColumn(column: BoardColumn): void {
  useTeamsUi.setState({ column })
}

export function openTeamNeeds(teamId: string): void {
  linkNeedsFor = null
  useTeamsUi.setState((s) => ({ ...onlyTeam(s, teamId), needsFor: teamId }))
}

export function closeTeamNeeds(): void {
  linkNeedsFor = null
  useTeamsUi.setState({ needsFor: null })
}

export function openLeadChat(teamId: string): void {
  linkNeedsFor = null
  useTeamsUi.setState((s) => ({ ...onlyTeam(s, teamId), leadFor: teamId }))
}

export function closeLeadChat(): void {
  linkNeedsFor = null
  useTeamsUi.setState({ leadFor: null })
}

export function openTeamTask(teamId: string, taskId: string): void {
  linkNeedsFor = null
  useTeamsUi.setState((s) => ({ ...onlyTeam(s, teamId), task: { teamId, taskId } }))
}

export function closeTeamTask(): void {
  linkNeedsFor = null
  useTeamsUi.setState({ task: null })
}

/** A console push opens its terminal: every Teams screen closes (the list and the change counters stay). */
export function closeTeamScreens(): void {
  linkNeedsFor = null
  useTeamsUi.setState(CLOSED)
}

/** "Te necesita" of a team over its board when the list says the team needs the user; whether it opened. */
function openNeedsIfAny(teamId: string): boolean {
  const item = useTeamsUi.getState().list?.find((t) => t.id === teamId)
  if (!item || item.needsCount <= 0) return false
  useTeamsUi.setState({ needsFor: teamId })
  return true
}

/**
 * A team push (deep link): the team's board, then the task over it when the
 * link names one, else "Te necesita" over it when the team needs the user:
 * at once when the list already says so, else once a list load lands (the
 * list may be older than the push: a socket that slept never heard of the
 * new need). Screens of other teams close. It only picks what to show:
 * never an action.
 */
export function openTeamLink(link: TeamDeepLink): void {
  if (!link || typeof link.team !== 'string' || !TEAM_ID_RE.test(link.team)) return
  const team = link.team
  const taskId = typeof link.task === 'string' && TASK_ID_RE.test(link.task) ? link.task : undefined
  const s = useTeamsUi.getState()
  linkNeedsFor = null
  useTeamsUi.setState({
    boardFor: team,
    column: s.boardFor === team ? s.column : 'todo',
    needsFor: null,
    leadFor: null,
    task: taskId ? { teamId: team, taskId } : null,
  })
  if (taskId || openNeedsIfAny(team)) return
  linkNeedsFor = team
  if (!listLoading) void loadTeamList()
}
