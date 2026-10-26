/**
 * Teams (app 2.7.0, E10 B; Labs teams): the renderer core of the module. Main
 * owns every team state; this store mirrors what `teams:req` answers (the
 * sidebar list and the open team's view) plus the overlay's own pieces (which
 * team and tab show, the drawer). Never persisted, never in the app store's
 * workspaces, the config, the phone snapshot or the CLI (the shareGuestStore
 * rule). Area modules (lib/teams/*) keep their own small stores and refetch
 * through onTeamChanged, which applies the one refetch policy (initTeams).
 *
 * The overlay is `agentStore.view === 'teams'`: every existing
 * `setView('grid')` exit (revealPane, a sidebar workspace row, a shared link,
 * the board) closes it too, and the guard below closes it on a workspace
 * switch, a request to focus a local console or a local xterm taking focus.
 */
import { create } from 'zustand'
import type {
  IntegrateProgressEvt,
  TeamChangedEvt,
  TeamFail,
  TeamListItem,
  TeamReplyFor,
  TeamRequest,
  TeamRunAppendEvt,
  TeamTakeoverRef,
  TeamView,
} from '@shared/team-protocol'
import { labOn } from '@shared/labs'
import { useAppStore } from './store'
import { useAgentStore } from './agentStore'
import { focusPane, getFocusedPane, onPaneFocusRequest } from './focus'
import { sharedOverlayActive } from './shareGuestStore'

export type TeamTab = 'board' | 'agents' | 'needs'
export const TEAM_TABS: readonly TeamTab[] = ['board', 'agents', 'needs']

export type TeamDrawer =
  | { kind: 'task'; taskId: string }
  | { kind: 'agent'; agentId: string; runId?: string; view?: 'thread' | 'run' }
  | { kind: 'note'; noteId: string }
  | null

export interface TeamsState {
  /** The first list answered (the sidebar and the picker wait for it). */
  ready: boolean
  /** The last answer was `disabled` (main has the lab off). */
  disabled: boolean
  list: TeamListItem[]
  /** `get` answers by team id. */
  views: Record<string, TeamView>
  /** The team the overlay shows; null = the picker. Kept while the overlay is closed. */
  openTeamId: string | null
  tab: TeamTab
  drawer: TeamDrawer
  /** paneId -> the agent a console took over (from the list). */
  takeovers: Record<string, TeamTakeoverRef & { teamId: string; teamName: string }>
}

const EMPTY: Pick<TeamsState, 'ready' | 'disabled' | 'list' | 'views' | 'drawer' | 'takeovers'> = {
  ready: false,
  disabled: false,
  list: [],
  views: {},
  drawer: null,
  takeovers: {},
}

export const useTeamsStore = create<TeamsState>(() => ({ ...EMPTY, openTeamId: null, tab: 'board' }))

// ---- per-viewer conveniences (localStorage; never required) ---------------------------------------

const LAST_KEY = 'snagentsos.teams.last'
const TAB_PREFIX = 'snagentsos.teams.tab.'

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Storage blocked or full: the choice just is not remembered.
  }
}

function savedTab(teamId: string): TeamTab {
  const v = readStorage(TAB_PREFIX + teamId)
  return TEAM_TABS.includes(v as TeamTab) ? (v as TeamTab) : 'board'
}

// ---- requests --------------------------------------------------------------------------------------

function ioFail(): TeamFail {
  return { ok: false, error: 'io' }
}

/**
 * One Teams request. Never throws: a rejected invoke, a missing `teams` API or
 * an answer that is not a reply is `{ ok: false, error: 'io' }`; `disabled`
 * sets `state.disabled` (and the list is asked again while the lab is on here).
 */
export async function teamReq<R extends TeamRequest>(r: R): Promise<TeamReplyFor<R>> {
  const api = typeof window === 'undefined' ? undefined : window.snApi?.teams
  let res: unknown
  try {
    res = api && typeof api.req === 'function' ? await api.req(r) : undefined
  } catch {
    res = undefined
  }
  if (!res || typeof res !== 'object' || typeof (res as { ok?: unknown }).ok !== 'boolean') return ioFail() as TeamReplyFor<R>
  const reply = res as TeamReplyFor<R>
  if (!reply.ok && reply.error === 'disabled') {
    if (!useTeamsStore.getState().disabled) useTeamsStore.setState({ disabled: true })
    retryWhileDisabled()
  }
  return reply
}

/** Sequence of list requests: only the newest answer lands. */
let listSeq = 0
/** Sequence of `get` requests per team. */
const viewSeq = new Map<string, number>()
/** Bumped by every initTeams and its teardown: an answer from an older life is dropped. */
let generation = 0

/**
 * Main may still have the lab off for a moment after it is turned on here (the
 * config save is debounced): after a `disabled` answer the list is asked again a few times.
 */
const DISABLED_RETRY_MS = [600, 1500, 4000]
let disabledRetries = 0
let disabledTimer: ReturnType<typeof setTimeout> | null = null

function clearDisabledRetry(): void {
  if (disabledTimer) clearTimeout(disabledTimer)
  disabledTimer = null
}

function retryWhileDisabled(): void {
  if (!wired || disabledTimer || disabledRetries >= DISABLED_RETRY_MS.length) return
  if (!labOn(useAppStore.getState().settings, 'teams')) return
  const gen = generation
  disabledTimer = setTimeout(() => {
    disabledTimer = null
    if (gen !== generation) return
    disabledRetries++
    void refreshTeamList()
  }, DISABLED_RETRY_MS[disabledRetries])
}

function takeoversOf(list: TeamListItem[]): TeamsState['takeovers'] {
  const out: TeamsState['takeovers'] = {}
  for (const team of list) for (const tk of team.takeovers ?? []) out[tk.paneId] = { ...tk, teamId: team.id, teamName: team.name }
  return out
}

/** The newest list pull: an older one that lands late waits for it instead of applying. */
let listLatest: Promise<void> = Promise.resolve()

/**
 * Pulls the team list (sidebar rows, picker, palette entries, takeover chips).
 * Resolves once the newest pull in flight has landed, so a caller that awaits
 * it sees the list main answered last.
 */
export function refreshTeamList(): Promise<void> {
  const p = pullList()
  listLatest = p
  return p
}

async function pullList(): Promise<void> {
  const seq = ++listSeq
  const gen = generation
  const res = await teamReq({ op: 'list' })
  if (gen !== generation) return
  if (seq !== listSeq) return listLatest
  if (!res.ok) {
    // `disabled` (teamReq already set the flag and armed the retry): main has no team to show.
    useTeamsStore.setState(res.error === 'disabled' ? { ready: true, list: [], views: {}, takeovers: {} } : { ready: true })
    return
  }
  disabledRetries = 0
  clearDisabledRetry()
  const list = Array.isArray(res.teams) ? res.teams : []
  const ids = new Set(list.map((team) => team.id))
  for (const key of [...seenRev.keys()]) if (!ids.has(key.slice(0, key.indexOf(':')))) seenRev.delete(key)
  useTeamsStore.setState((s) => {
    const views: Record<string, TeamView> = {}
    for (const [id, v] of Object.entries(s.views)) if (ids.has(id)) views[id] = v
    // A team that left the list (removed here, on the phone or in main) falls back to the picker.
    const gone = s.openTeamId !== null && !ids.has(s.openTeamId)
    return { ready: true, disabled: false, list, views, takeovers: takeoversOf(list), ...(gone ? { openTeamId: null, drawer: null } : {}) }
  })
}

/** The newest `get` per team: an older one that lands late waits for it (no false "could not load"). */
const viewLatest = new Map<string, Promise<TeamView | null>>()

/** Pulls one team's view (the overlay header, banner and B1 tab bodies). Null when it did not come. */
export function loadTeamView(teamId: string): Promise<TeamView | null> {
  const p = pullView(teamId)
  viewLatest.set(teamId, p)
  void p.then(() => {
    if (viewLatest.get(teamId) === p) viewLatest.delete(teamId)
  })
  return p
}

async function pullView(teamId: string): Promise<TeamView | null> {
  const seq = (viewSeq.get(teamId) ?? 0) + 1
  viewSeq.set(teamId, seq)
  const gen = generation
  const res = await teamReq({ op: 'get', teamId })
  if (gen !== generation) return useTeamsStore.getState().views[teamId] ?? null
  if (seq !== viewSeq.get(teamId)) return viewLatest.get(teamId) ?? useTeamsStore.getState().views[teamId] ?? null
  if (!res.ok) {
    // Gone in main: the list drops it and the overlay goes to the picker.
    if (res.error === 'not_found') void refreshTeamList()
    return null
  }
  useTeamsStore.setState((s) => ({ views: { ...s.views, [teamId]: res.team } }))
  return res.team
}

/** Removes a team (repo files stay; main moves its state to the trash). False when main refused. */
export async function removeTeam(teamId: string): Promise<boolean> {
  const res = await teamReq({ op: 'remove', teamId })
  if (!res.ok) return false
  useTeamsStore.setState((s) => (s.openTeamId === teamId ? { openTeamId: null, drawer: null } : {}))
  void refreshTeamList()
  return true
}

/**
 * Opens the team definition folder or the team data folder (main computes the
 * path and opens it only when it is a real directory). Null once it opened;
 * else the failure: `not_found` (missing, a link or a file), `io` with the
 * system's reason in `detail`.
 */
export async function revealTeam(teamId: string, what: 'definition' | 'data'): Promise<TeamFail | null> {
  const res = await teamReq({ op: 'reveal', teamId, what })
  return res.ok ? null : res
}

// ---- overlay -----------------------------------------------------------------------------------------

/** True while the Teams overlay covers the workspace area (useGlobalKeys, WorkspaceHost, useStatusEvents). */
export function teamsOverlayActive(): boolean {
  return useAgentStore.getState().view === 'teams'
}

/** Drop the DOM focus a local console may still hold, so no key lands in it unseen. */
function blurLocalTerminal(): void {
  if (typeof document === 'undefined') return
  const a = document.activeElement
  if (a instanceof HTMLElement && a.closest('.xterm') && !a.closest('[data-team-host]')) a.blur()
}

/**
 * Opens the overlay on a team (null = the picker). With no id: the team open
 * last, else the only team, else the picker. Remembers the team and its tab.
 */
export function openTeams(teamId?: string | null, tab?: TeamTab): void {
  // With the lab off nothing of Teams shows (and the grid must keep its panes).
  if (!labOn(useAppStore.getState().settings, 'teams')) return
  const s = useTeamsStore.getState()
  let id: string | null
  if (teamId !== undefined) id = teamId
  else {
    const last = s.openTeamId ?? readStorage(LAST_KEY)
    if (last && (!s.ready || s.list.some((team) => team.id === last))) id = last
    else id = s.list.length === 1 ? s.list[0].id : null
  }
  if (id !== null && s.ready && !s.list.some((team) => team.id === id)) id = null
  const nextTab = tab ?? (id === null ? 'board' : id === s.openTeamId ? s.tab : savedTab(id))
  useTeamsStore.setState({ openTeamId: id, tab: nextTab, ...(id !== s.openTeamId ? { drawer: null } : {}) })
  if (id) {
    writeStorage(LAST_KEY, id)
    if (tab) writeStorage(TAB_PREFIX + id, tab)
  }
  blurLocalTerminal()
  useAgentStore.getState().setView('teams')
}

/**
 * Closes the overlay. With refocus (the default) the console that had the
 * keyboard gets it back after the view switch (AgentsBoard's closeBoard);
 * the guard's own closes pass refocus false (a focus is already on its way).
 */
export function closeTeams(o?: { refocus?: boolean }): void {
  if (!teamsOverlayActive()) return
  useAgentStore.getState().setView('grid')
  if (useTeamsStore.getState().drawer) useTeamsStore.setState({ drawer: null })
  if (o?.refocus === false) return
  // Teams was over a shared view: that view comes back, and a local focus request would make it leave too.
  if (sharedOverlayActive()) return
  const paneId = getFocusedPane()
  const app = useAppStore.getState()
  const ws = app.workspaces.find((w) => w.id === app.activeWorkspaceId)
  // Only a console of the workspace on screen; WorkspaceHost focuses that workspace's console anyway.
  if (paneId && ws?.panes.some((p) => p.id === paneId)) setTimeout(() => focusPane(paneId), 0)
}

export function setTeamTab(tab: TeamTab): void {
  const { openTeamId, tab: current } = useTeamsStore.getState()
  if (tab !== current) useTeamsStore.setState({ tab })
  if (openTeamId) writeStorage(TAB_PREFIX + openTeamId, tab)
}

export function openTaskDrawer(taskId: string): void {
  useTeamsStore.setState({ drawer: { kind: 'task', taskId } })
}

export function openAgentDrawer(agentId: string, runId?: string, view?: 'thread' | 'run'): void {
  useTeamsStore.setState({ drawer: { kind: 'agent', agentId, ...(runId ? { runId } : {}), ...(view ? { view } : {}) } })
}

export function closeTeamDrawer(): void {
  if (useTeamsStore.getState().drawer) useTeamsStore.setState({ drawer: null })
}

/**
 * The single place that closes the overlay on its own (copy of the shared
 * view's guard): a workspace switch, a request to focus a local console, or a
 * local xterm outside the overlay taking the DOM focus.
 */
function initOverlayGuard(): () => void {
  const leave = (): void => closeTeams({ refocus: false })
  const offApp = useAppStore.subscribe((s, prev) => {
    if (s.activeWorkspaceId !== prev.activeWorkspaceId) leave()
  })
  const offFocus = onPaneFocusRequest(leave)
  const onFocusIn = (e: FocusEvent): void => {
    if (!teamsOverlayActive()) return
    const el = e.target
    if (el instanceof HTMLElement && el.classList.contains('xterm-helper-textarea') && !el.closest('[data-team-host]')) leave()
  }
  document.addEventListener('focusin', onFocusIn, true)
  return () => {
    offApp()
    offFocus()
    document.removeEventListener('focusin', onFocusIn, true)
  }
}

// ---- events: fan-out and the one refetch policy --------------------------------------------------------

const changedListeners = new Set<(e: TeamChangedEvt) => void>()
const appendListeners = new Set<(e: TeamRunAppendEvt) => void>()
const integrateListeners = new Set<(e: IntegrateProgressEvt) => void>()

/** Area modules: the team changes that passed the refetch policy (debounced, rev filtered). */
export function onTeamChanged(fn: (e: TeamChangedEvt) => void): () => void {
  changedListeners.add(fn)
  return () => changedListeners.delete(fn)
}

/** Area modules: lines of the watched run, as main sends them. */
export function onRunAppend(fn: (e: TeamRunAppendEvt) => void): () => void {
  appendListeners.add(fn)
  return () => appendListeners.delete(fn)
}

/** Area modules: Integrar steps, as main sends them. */
export function onIntegrateProgress(fn: (e: IntegrateProgressEvt) => void): () => void {
  integrateListeners.add(fn)
  return () => integrateListeners.delete(fn)
}

function fanOut<E>(listeners: Set<(e: E) => void>, e: E): void {
  for (const fn of [...listeners]) {
    try {
      fn(e)
    } catch (err) {
      console.error('teams listener failed', err)
    }
  }
}

/** Trailing debounce of a refetch per (team, scope). */
const REFETCH_DEBOUNCE_MS = 150
const pending = new Map<string, ReturnType<typeof setTimeout>>()
/** Newest rev let through per `<teamId>:<scope>` (task and run scopes carry ids and skip it); an older one is dropped. */
const seenRev = new Map<string, number>()

function debounce(key: string, fn: () => void): void {
  const prev = pending.get(key)
  if (prev) clearTimeout(prev)
  pending.set(
    key,
    setTimeout(() => {
      pending.delete(key)
      fn()
    }, REFETCH_DEBOUNCE_MS),
  )
}

function clearPending(): void {
  for (const timer of pending.values()) clearTimeout(timer)
  pending.clear()
  seenRev.clear()
}

/** The overlay shows this team: only then do its non-list scopes refetch. */
function isOpenTeam(teamId: string): boolean {
  return teamsOverlayActive() && useTeamsStore.getState().openTeamId === teamId
}

/** Main turned the lab off: everything goes, and so does the overlay. */
function applyDisabled(): void {
  clearPending()
  clearDisabledRetry()
  useTeamsStore.setState({ ...EMPTY, ready: true, disabled: true })
  closeTeams({ refocus: false })
  // The lab is still on here: main may only be between a config save and its enable().
  retryWhileDisabled()
}

/**
 * The refetch policy, once for every area: per (team, scope) a 150 ms trailing
 * debounce; an event whose rev is older than the one held is ignored (equal
 * still refetches, see below), except `task` and `run` (they carry ids); `list` always refetches the list;
 * teams not on screen react only to `list`; `disabled` clears the store and
 * closes the overlay.
 */
function onRawChanged(e: TeamChangedEvt): void {
  if (!e || typeof e.teamId !== 'string' || !Array.isArray(e.scopes)) return
  if (e.scopes.includes('disabled')) {
    applyDisabled()
    fanOut(changedListeners, { teamId: e.teamId, rev: e.rev, scopes: ['disabled'] })
    return
  }
  const gen = generation
  for (const scope of e.scopes) {
    if (scope === 'list') {
      debounce('*:list', () => {
        if (gen === generation) void refreshTeamList()
      })
      debounce(`${e.teamId}:list`, () => {
        if (gen === generation) fanOut(changedListeners, { teamId: e.teamId, rev: e.rev, scopes: ['list'] })
      })
      continue
    }
    if (!isOpenTeam(e.teamId)) continue
    const id = scope === 'task' ? e.taskId : scope === 'run' ? e.runId : undefined
    if (scope !== 'task' && scope !== 'run') {
      // Only an older rev is stale: main also emits at the same rev for state outside the
      // runtime (the cached trust state of a definition edit or a trust, the view's definition
      // fields), so an equal rev still refetches (the debounce folds the repeats).
      const key = `${e.teamId}:${scope}`
      const held = Math.max(seenRev.get(key) ?? -1, scope === 'team' ? (useTeamsStore.getState().views[e.teamId]?.rev ?? -1) : -1)
      if (typeof e.rev === 'number' && e.rev < held) continue
      if (typeof e.rev === 'number') seenRev.set(key, e.rev)
    }
    const evt: TeamChangedEvt = { teamId: e.teamId, rev: e.rev, scopes: [scope], ...(e.taskId && scope === 'task' ? { taskId: e.taskId } : {}), ...(e.runId && scope === 'run' ? { runId: e.runId } : {}) }
    debounce(id ? `${e.teamId}:${scope}:${id}` : `${e.teamId}:${scope}`, () => {
      if (gen !== generation || !isOpenTeam(e.teamId)) return
      if (scope === 'team') void loadTeamView(e.teamId)
      fanOut(changedListeners, evt)
    })
  }
}

let wired = false

/**
 * Wires main's three Teams streams, the overlay guard and pulls the list, for
 * as long as the lab is on (startTeams). Idempotent like initAccountsEvents;
 * the teardown closes the overlay without refocus and clears the store.
 */
export function initTeams(): () => void {
  if (wired) return () => undefined
  wired = true
  generation++
  disabledRetries = 0
  const api = window.snApi?.teams
  const offs: Array<() => void> = []
  const keep = (off: unknown): void => {
    if (typeof off === 'function') offs.push(off as () => void)
  }
  if (api) {
    keep(api.onChanged(onRawChanged))
    keep(api.onRunAppend((e) => fanOut(appendListeners, e)))
    keep(api.onIntegrateProgress((e) => fanOut(integrateListeners, e)))
  }
  offs.push(initOverlayGuard())
  void refreshTeamList()
  return () => {
    wired = false
    generation++
    for (const off of offs) off()
    clearPending()
    clearDisabledRetry()
    closeTeams({ refocus: false })
    useTeamsStore.setState({ ...EMPTY, openTeamId: null, tab: 'board' })
  }
}
