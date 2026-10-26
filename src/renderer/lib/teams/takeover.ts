/**
 * Tomar el control (app 2.7.0, E10 B9): an agent's conversation opened in a
 * real console of the user, and "Devolver al Equipo". Main owns the takeover
 * (4.4): `takeover` stops a live run (tree kill, waits for its end) and grants
 * the session (provider, id, the run's cwd, the workspace it picked); the
 * console is made here the way the phone's resume makes one
 * (runCreatePaneResume: `lastSession`, `setupId: ''`, the resume target, the
 * run's cwd so a Claude session keeps its folder slug), saved to main at once,
 * bound with `takeoverBound`, then mounted alone and brought on screen; any
 * failure on the way leaves no console behind and sends `takeoverAbort`. A
 * conversation another console already holds is never opened twice: that
 * console comes on screen.
 * `release` has main kill the console and wait for it; the pane then goes
 * with removePane (never closePane: the closed stack would offer it again),
 * and so does a workspace a takeover made for its console once no console is
 * left in it (never a workspace the user had); the same workspace goes when
 * the user closes that console by hand (K7: main gives the agent back).
 * Nothing here writes to a pty: the console resumes on its own first spawn.
 * Never persisted, but for the ids of the workspaces a takeover made
 * (localStorage, a per-viewer convenience: without it such a workspace stays).
 */
import { create } from 'zustand'
import { displayStatus } from '@shared/status'
import type { AgentProvider, Pane } from '@shared/types'
import type { ReleaseStaleDetail, TakeoverBusyDetail, TakeoverGrant, TeamError, TeamFail } from '@shared/team-protocol'
import { onTeamChanged, refreshTeamList, teamReq, useTeamsStore } from '@/lib/teamsStore'
import { useAppStore, type AppState } from '@/lib/store'
import { useAgentStore } from '@/lib/agentStore'
import { snapshotConfig } from '@/lib/persist'
import { paneHoldingSession, resumePreset } from '@/lib/remoteResume'
import { revealPane } from '@/lib/revealPane'
import { MAX_PANES } from '@/lib/worktrees'
import { toast } from '@/lib/toast'
import { translate, type MessageKey, type TFn } from '@/i18n'
import { loadRoster } from './roster'

export interface TakeoverState {
  /** `<teamId>/<agentId>` whose takeover is on its way (its button waits). */
  taking: Record<string, true>
  /** Pane ids whose release main is doing. */
  releasing: Record<string, true>
  /** The pane whose "Devolver al Equipo" confirm is open (TakeoverChip shows it). */
  confirm: string | null
}

const EMPTY: TakeoverState = { taking: {}, releasing: {}, confirm: null }

export const useTakeoverStore = create<TakeoverState>(() => ({ ...EMPTY }))

export function takeoverKey(teamId: string, agentId: string): string {
  return `${teamId}/${agentId}`
}

function mark(field: 'taking' | 'releasing', key: string, on: boolean): void {
  useTakeoverStore.setState((s) => {
    const next: Record<string, true> = { ...s[field] }
    if (on) next[key] = true
    else delete next[key]
    return field === 'taking' ? { taking: next } : { releasing: next }
  })
}

/** Look of a console without a preset of that provider (the default presets' own, as remoteResume's). */
const BARE: Record<AgentProvider, Pick<Pane, 'color' | 'icon'>> = {
  claude: { color: '#d97757', icon: 'claude' },
  codex: { color: '#10a37f', icon: 'openai' },
}

/** The console of a grant: the provider's first preset look, the run's cwd and title, resuming that session. */
function grantPane(grant: TakeoverGrant): Partial<Pane> {
  const preset = resumePreset(useAppStore.getState().presets, grant.provider, undefined)
  const look = preset ? { presetId: preset.id, color: preset.color, icon: preset.icon } : BARE[grant.provider]
  return {
    type: grant.provider,
    ...look,
    title: grant.title,
    cwd: grant.cwd,
    // '' (not undefined): the workspace's Connection Profile does not apply (`??` only skips nullish).
    setupId: '',
    lastSession: { provider: grant.provider, sessionId: grant.sessionId, cwd: grant.cwd, at: Date.now() },
  }
}

/**
 * The config to main now instead of 400 ms later (persist.ts): main checks
 * `takeoverBound` against the saved consoles, and config:save is a send that
 * lands before the invoke that follows it.
 */
function saveConfigNow(): void {
  if (!useAppStore.getState().hydrated) return
  try {
    window.snApi.config.save(snapshotConfig())
  } catch {
    /* the debounced save still goes; main's reconcile binds it then */
  }
}

/**
 * Main already has the agent bound to this console: the config save before
 * `takeoverBound` lets its reconcile find the console's lastSession first, so
 * a refused `takeoverBound` may only mean it came second. Main's roster says,
 * read here (loadRoster hands back the stored one when a newer load overtakes it).
 */
async function boundTo(teamId: string, agentId: string, paneId: string): Promise<boolean> {
  const res = await teamReq({ op: 'roster', teamId })
  const agents = res.ok && Array.isArray(res.agents) ? res.agents : []
  const tk = agents.find((a) => a.id === agentId)?.takeover
  return tk?.phase === 'bound' && tk.paneId === paneId
}

// ---- the workspaces a takeover made (localStorage; never required) --------------------------------------

/**
 * Ids of the "Equipo <nombre>" workspaces a takeover made for its console (createWorkspaceWith), so a release
 * removes one once it is left with no console; a workspace the user had is never listed. Storage blocked or
 * cleared only leaves such a workspace in place.
 */
const MADE_KEY = 'snagentsos.teams.takeoverWorkspaces'
const MADE_MAX = 50

function madeWorkspaces(): string[] {
  try {
    const list = JSON.parse(window.localStorage.getItem(MADE_KEY) ?? '[]') as unknown
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function saveMade(ids: string[]): void {
  try {
    if (ids.length === 0) window.localStorage.removeItem(MADE_KEY)
    else window.localStorage.setItem(MADE_KEY, JSON.stringify(ids.slice(-MADE_MAX)))
  } catch {
    // Storage blocked or full: that workspace just stays after the release.
  }
}

/** Records a workspace made for a bound console; ids of workspaces that are gone drop out on the way. */
function rememberMade(workspaceId: string): void {
  const live = new Set(useAppStore.getState().workspaces.map((w) => w.id))
  saveMade([...madeWorkspaces().filter((id) => id !== workspaceId && live.has(id)), workspaceId])
}

/**
 * After a release, or its console closed by hand: each of these workspaces that a takeover made and that holds no
 * console any more (none shown there, none of its own shown elsewhere) is deleted, and its id forgotten. Any other
 * workspace is left alone.
 */
function dropEmptyMadeWorkspaces(ids: ReadonlyArray<string | undefined>): void {
  const made = madeWorkspaces()
  if (made.length === 0) return
  const gone = new Set<string>()
  for (const id of new Set(ids)) {
    if (!id || !made.includes(id)) continue
    const app = useAppStore.getState()
    const ws = app.workspaces.find((w) => w.id === id)
    if (ws && (ws.panes.length > 0 || Object.values(app.paneHome).some((h) => h.workspaceId === id))) continue
    if (ws) app.deleteWorkspace(id)
    gone.add(id)
  }
  if (gone.size > 0) saveMade(made.filter((id) => !gone.has(id)))
}

/** A console made for a takeover that did not bind: it goes, and so does the workspace made for it. */
function undoPane(workspaceId: string, paneId: string, madeWorkspace: boolean): void {
  useAgentStore.getState().takeResumeTarget(paneId)
  const app = useAppStore.getState()
  if (madeWorkspace) app.deleteWorkspace(workspaceId)
  else app.removePane(workspaceId, paneId)
}

/**
 * "Tomar el control" of one agent (its card or its drawer; a running one asks
 * first there). Null once its console is on screen (or the console that
 * already had this conversation is); else main's refusal (`stopping`,
 * `busy`, `no_session`...) or a failure binding the console, after which the
 * agent is back with the team and no console is left. Workspace: the one main
 * picked when it is still here and has room, else a new "Equipo <nombre>" on
 * the repo with only this console.
 */
export async function takeOverAgent(teamId: string, agentId: string): Promise<TeamFail | null> {
  const key = takeoverKey(teamId, agentId)
  if (useTakeoverStore.getState().taking[key]) return null
  mark('taking', key, true)
  try {
    const res = await teamReq({ op: 'takeover', teamId, agentId })
    if (!res.ok) return res
    const grant = res.grant
    // The agent goes back to the team (main: bindPending -> idle).
    const giveBack = async (): Promise<void> => {
      await teamReq({ op: 'takeoverAbort', teamId, agentId })
      void loadRoster(teamId)
    }
    const abort = async (fail: TeamFail): Promise<TeamFail> => {
      await giveBack()
      return fail
    }
    // Two consoles on one transcript would corrupt it: the one that has it comes on screen instead.
    const holder = paneHoldingSession(useAppStore.getState(), useAgentStore.getState().sessions, grant.provider, grant.sessionId)
    if (holder) {
      await giveBack()
      if (revealPane(holder)) toast.info(translate(useAppStore.getState().settings.language, 'teams.takeover.held'))
      return null
    }
    const app = useAppStore.getState()
    const picked = grant.workspaceId ? app.workspaces.find((w) => w.id === grant.workspaceId) : undefined
    const pane = grantPane(grant)
    let workspaceId: string
    let paneId: string
    const made = !picked || picked.panes.length >= MAX_PANES
    if (!made) {
      workspaceId = picked.id
      paneId = app.addPane(picked.id, pane)
    } else {
      const team = useTeamsStore.getState().list.find((x) => x.id === teamId)
      const name = translate(app.settings.language, 'teams.takeover.wsName', { name: grant.teamName })
      ;({ workspaceId, paneId } = app.createWorkspaceWith(name, team?.repoRoot || grant.cwd, pane))
    }
    if (!paneId) return abort({ ok: false, error: 'not_found' })
    // Consumed by the console's first spawn (prepareAgentLaunch): it starts resuming this session in the run's cwd.
    useAgentStore.getState().setResumeTarget(paneId, { provider: grant.provider, sessionId: grant.sessionId, cwd: grant.cwd, updatedAt: Date.now() })
    saveConfigNow()
    const bound = await teamReq({ op: 'takeoverBound', teamId, agentId, paneId, workspaceId })
    if (!bound.ok && !(await boundTo(teamId, agentId, paneId))) {
      undoPane(workspaceId, paneId, made)
      return abort(bound)
    }
    // Its release removes the workspace made for it once no console is left there.
    if (made) rememberMade(workspaceId)
    // Mounted once bound: a console that would go again never starts a terminal in a hidden workspace.
    useAppStore.getState().ensureMounted(workspaceId, { only: [paneId] })
    revealPane(paneId)
    void refreshTeamList()
    void loadRoster(teamId)
    return null
  } finally {
    mark('taking', key, false)
  }
}

/** The console is in the middle of a turn (working, or a request the agent waits on): it is not given back now. */
export function paneMidTurn(paneId: string): boolean {
  const st = useAppStore.getState().paneStatus[paneId]
  if (!st || st.bare) return false
  const state = displayStatus(st).state
  return state === 'working' || state === 'action'
}

/**
 * "Devolver al Equipo" asked (the chip or the pane menu): `busy` while the
 * console is mid turn (nothing is sent), `gone` when the team no longer holds
 * it, else the confirm opens.
 */
export function askRelease(paneId: string): 'busy' | 'gone' | 'confirm' {
  if (!useTeamsStore.getState().takeovers[paneId]) return 'gone'
  if (paneMidTurn(paneId)) return 'busy'
  useTakeoverStore.setState({ confirm: paneId })
  return 'confirm'
}

export function closeReleaseConfirm(): void {
  if (useTakeoverStore.getState().confirm !== null) useTakeoverStore.setState({ confirm: null })
}

/**
 * Gives the console's agent back to its team: main checks the console still
 * holds the session and is not mid turn (`busy`), kills it and waits for its
 * end; the pane then goes with removePane, from the workspace it shows in
 * (a console moved this session is saved at home), and a workspace a takeover
 * made goes too once it holds no console. Null once it is back.
 */
export async function releaseToTeam(paneId: string): Promise<TeamFail | null> {
  const ref = useTeamsStore.getState().takeovers[paneId]
  if (!ref) return { ok: false, error: 'not_found' }
  if (paneMidTurn(paneId)) return { ok: false, error: 'busy', detail: 'turn' satisfies TakeoverBusyDetail }
  if (useTakeoverStore.getState().releasing[paneId]) return null
  mark('releasing', paneId, true)
  try {
    const res = await teamReq({ op: 'release', teamId: ref.teamId, agentId: ref.agentId })
    if (!res.ok) {
      // conflict: the team no longer holds it (the console left the session, or it was given back already); it stays.
      if (res.error === 'conflict') void refreshTeamList()
      return res
    }
    const app = useAppStore.getState()
    const ws = app.workspaces.find((w) => w.panes.some((p) => p.id === res.paneId)) ?? app.workspaces.find((w) => w.id === res.workspaceId)
    // Its home, read before removePane forgets it (a console moved this session shows away from it).
    const home = app.paneHome[res.paneId]?.workspaceId
    if (ws) app.removePane(ws.id, res.paneId)
    dropEmptyMadeWorkspaces([ws?.id, home, res.workspaceId])
    void refreshTeamList()
    void loadRoster(ref.teamId)
    return null
  } finally {
    mark('releasing', paneId, false)
  }
}

// ---- words (pure over the values handed in) ----------------------------------------------------------

const TAKE_FAIL_KEY: Partial<Record<TeamError, MessageKey>> = {
  stopping: 'teams.takeover.fail.stopping',
  busy: 'teams.takeover.fail.busy',
  no_session: 'teams.takeover.fail.no_session',
  not_found: 'teams.takeover.fail.not_found',
  disabled: 'teams.takeover.fail.disabled',
}

/** The case main named for a `busy` (none from an older answer or the renderer's own check). */
function busyDetail(f: TeamFail): TakeoverBusyDetail | undefined {
  return f.error === 'busy' ? (f.detail as TakeoverBusyDetail | undefined) : undefined
}

/**
 * What a refused "Tomar el control" says, in the catalog's words (never main's text). `busy {detail:'orphan'}`: a
 * process of the team from before the app restarted still writes that session (its card in Te necesita ends it).
 */
export function takeoverFailText(f: TeamFail, agent: string, t: TFn): string {
  if (busyDetail(f) === 'orphan') return t('teams.takeover.fail.orphan', { agent })
  const key = TAKE_FAIL_KEY[f.error]
  return t(key ?? 'teams.takeover.fail.other', { agent })
}

export type TakeoverTone = 'info' | 'warning' | 'error'

/** How a refused "Tomar el control" shows: a wait that passes by itself warns; the rest (an orphan included) is an error. */
export function takeoverFailTone(f: TeamFail): TakeoverTone {
  return f.error === 'stopping' || (f.error === 'busy' && busyDetail(f) !== 'orphan') ? 'warning' : 'error'
}

/**
 * What a refused "Devolver al Equipo" says and how it shows. `busy` by main's detail: `turn` (the console is mid
 * turn; also the renderer's own check and a busy without one), `kill` (main could not close the console: it stays
 * taken over), `releasing` (a release of it is already on its way). `conflict {detail:'notHeld'}`: the console no
 * longer had the agent's conversation, so the agent went back to the team and the console stays, the user's; any
 * other conflict, or not_found: the team no longer holds it.
 */
export function releaseFailNotice(f: TeamFail, agent: string, t: TFn): { tone: TakeoverTone; text: string } {
  if (f.error === 'busy') {
    const detail = busyDetail(f)
    if (detail === 'kill') return { tone: 'error', text: t('teams.takeover.releaseKill', { agent }) }
    if (detail === 'releasing') return { tone: 'info', text: t('teams.takeover.releasing', { agent }) }
    return { tone: 'warning', text: t('teams.takeover.releaseBusy') }
  }
  if (f.error === 'conflict' && f.detail === ('notHeld' satisfies ReleaseStaleDetail)) return { tone: 'info', text: t('teams.takeover.releaseNotHeld', { agent }) }
  if (f.error === 'not_found' || f.error === 'conflict') return { tone: 'error', text: t('teams.takeover.releaseGone') }
  return { tone: 'error', text: t('teams.takeover.releaseFailed') }
}

// ---- sync ------------------------------------------------------------------------------------------------

/**
 * K7 on this side: a console the list still names as taken over that left every workspace (closed by hand, or its
 * workspace deleted) takes with it the workspace a takeover made for it (where it showed, or its home) once no
 * console is left there, as a release does; main gives the agent back on its own (the pty exit, its config
 * reconcile). A console moved to another workspace never left. Run after the store's change, outside its notify loop.
 */
function dropClosedTakeoverWorkspaces(s: AppState, prev: AppState): void {
  if (s.workspaces === prev.workspaces) return
  const takeovers = useTeamsStore.getState().takeovers
  if (Object.keys(takeovers).length === 0) return
  const live = new Set(s.workspaces.flatMap((w) => w.panes.map((p) => p.id)))
  const left: string[] = []
  for (const w of prev.workspaces) {
    for (const p of w.panes) {
      if (!takeovers[p.id] || live.has(p.id)) continue
      left.push(w.id)
      const home = prev.paneHome[p.id]?.workspaceId
      if (home) left.push(home)
    }
  }
  if (left.length > 0) queueMicrotask(() => dropEmptyMadeWorkspaces(left))
}

/**
 * For as long as the lab is on (startTeams): the takeovers themselves come
 * with the core's list (`useTeamsStore.takeovers`, the chips); main turning
 * the lab off clears what waits here. A taken-over console closed by hand
 * takes the workspace made for it (dropClosedTakeoverWorkspaces).
 */
export function initTakeoverSync(): () => void {
  const off = onTeamChanged((e) => {
    if (e.scopes.includes('disabled')) useTakeoverStore.setState({ ...EMPTY })
  })
  const offApp = useAppStore.subscribe(dropClosedTakeoverWorkspaces)
  return () => {
    off()
    offApp()
    useTakeoverStore.setState({ ...EMPTY })
  }
}
