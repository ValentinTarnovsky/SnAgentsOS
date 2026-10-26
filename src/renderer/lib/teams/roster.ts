/**
 * The Agentes tab of a team (app 2.7.0, E10 B2): the roster main answers
 * (`roster`, one AgentView per agent of the trusted definition) and the
 * user's actions on it: "Ejecutar ahora" (`runNow`, the request text goes to
 * main and from there to the child's stdin only: nothing here ever writes to
 * a pty), Frenar (`stop`), the agent pause (`pauseAgent`) and the team pause
 * of the header (`settings`). Main owns every state and checks every gate;
 * this store keeps the last answer per team and refetches through
 * onTeamChanged (the core's refetch policy: only the team on screen).
 * Never persisted.
 */
import { create } from 'zustand'
import type { DeferInfo, RunMode, WakeReason } from '@shared/teams'
import type { Language, PaneUsage } from '@shared/types'
import type { AgentView, TeamError, TeamFail, TeamRequest } from '@shared/team-protocol'
import { onTeamChanged, openAgentDrawer, refreshTeamList, teamReq, useTeamsStore } from '@/lib/teamsStore'
import { clockTime, formatCost, formatTokens, sumUsage } from '@/lib/statusSignals'
import type { MessageKey, TFn } from '@/i18n'

export interface TeamRoster {
  agents: AgentView[]
  rev: number
}

export interface RosterState {
  /** teamId -> the last roster main answered. */
  rosters: Record<string, TeamRoster>
  /** Teams whose last pull did not come (the tab offers Retry). */
  failed: Record<string, true>
  /** One shot: the agent whose composer takes the keyboard when it shows ("Ejecutar ahora" on its card). */
  compose: string | null
}

const EMPTY: RosterState = { rosters: {}, failed: {}, compose: null }

export const useRosterStore = create<RosterState>(() => ({ ...EMPTY }))

/** Per team, the newest pull: an older answer that lands late is dropped. */
const seq = new Map<string, number>()
/** Bumped by every initRosterSync and its teardown: an answer from an older life is dropped. */
let generation = 0

/** Pulls one team's roster. Null when it did not come (the store keeps the last one it had). */
export async function loadRoster(teamId: string): Promise<TeamRoster | null> {
  const n = (seq.get(teamId) ?? 0) + 1
  seq.set(teamId, n)
  const gen = generation
  const res = await teamReq({ op: 'roster', teamId })
  if (gen !== generation || seq.get(teamId) !== n) return useRosterStore.getState().rosters[teamId] ?? null
  if (!res.ok) {
    useRosterStore.setState((s) => ({ failed: { ...s.failed, [teamId]: true } }))
    return null
  }
  const roster: TeamRoster = { agents: Array.isArray(res.agents) ? res.agents : [], rev: res.rev }
  useRosterStore.setState((s) => {
    const failed = { ...s.failed }
    delete failed[teamId]
    return { rosters: { ...s.rosters, [teamId]: roster }, failed }
  })
  return roster
}

/**
 * "Ejecutar ahora": a run of this agent now, with the user's request (free
 * mode, or lead mode for the Lead). Main applies every gate except the
 * autonomy one and answers `deferred` with its reason when one holds; the
 * text goes to the child's stdin only, never to argv nor to a pty. Null once
 * the run was admitted; else the failure. An agent drawer open on this agent
 * moves to the new run.
 */
export async function runNow(teamId: string, agentId: string, prompt?: string, taskId?: string): Promise<TeamFail | null> {
  const req: Extract<TeamRequest, { op: 'runNow' }> = { op: 'runNow', teamId, agentId }
  if (taskId) req.taskId = taskId
  if (prompt) req.prompt = prompt
  const res = await teamReq(req)
  if (!res.ok) return res
  const d = useTeamsStore.getState().drawer
  if (d?.kind === 'agent' && d.agentId === agentId && useTeamsStore.getState().openTeamId === teamId) openAgentDrawer(agentId, res.runId, d.view)
  void loadRoster(teamId)
  return null
}

/** Frenar: main stops the run's whole process tree. Null once main took it. */
export async function stopRun(teamId: string, runId: string): Promise<TeamFail | null> {
  const res = await teamReq({ op: 'stop', teamId, runId })
  if (!res.ok) return res
  void loadRoster(teamId)
  return null
}

/** Pauses (or resumes) one agent: a paused agent takes no new run. Null once main applied it. */
export async function pauseAgent(teamId: string, agentId: string, on: boolean): Promise<TeamFail | null> {
  const res = await teamReq({ op: 'pauseAgent', teamId, agentId, on })
  if (!res.ok) return res
  void loadRoster(teamId)
  return null
}

/** The header's Pausar / Reanudar of the whole team (the `settings` op). Null once main applied it. */
export async function setTeamPaused(teamId: string, on: boolean): Promise<TeamFail | null> {
  const res = await teamReq({ op: 'settings', teamId, patch: { paused: on } })
  if (!res.ok) return res
  useTeamsStore.setState((s) => ({ views: { ...s.views, [teamId]: res.team } }))
  void refreshTeamList()
  return null
}

/** "Ejecutar ahora" on a card: the drawer opens on the agent and its composer takes the keyboard. */
export function openRunNow(agentId: string): void {
  useRosterStore.setState({ compose: agentId })
  const d = useTeamsStore.getState().drawer
  openAgentDrawer(agentId, d?.kind === 'agent' && d.agentId === agentId ? d.runId : undefined, 'run')
}

/** The composer took the keyboard: the one shot is spent. */
export function composeTaken(agentId: string): void {
  if (useRosterStore.getState().compose === agentId) useRosterStore.setState({ compose: null })
}

// ---- words (pure over the values handed in) ----------------------------------------------------------

/** "Dev" for the first agent of a role, "Dev 2" for the next ones (main's agentName). */
export function agentLabel(a: Pick<AgentView, 'roleName' | 'index'>): string {
  return a.index > 1 ? `${a.roleName} ${a.index}` : a.roleName
}

export const MODE_KEY: Record<RunMode, MessageKey> = {
  plan: 'teams.mode.plan',
  exec: 'teams.mode.exec',
  qa: 'teams.mode.qa',
  lead: 'teams.mode.lead',
  free: 'teams.mode.free',
}

export const TRIGGER_KEY: Record<WakeReason, MessageKey> = {
  assigned: 'teams.trigger.assigned',
  comment: 'teams.trigger.comment',
  planApproved: 'teams.trigger.planApproved',
  planRejected: 'teams.trigger.planRejected',
  review: 'teams.trigger.review',
  changes: 'teams.trigger.changes',
  finalRejected: 'teams.trigger.finalRejected',
  rebase: 'teams.trigger.rebase',
  answer: 'teams.trigger.answer',
  grant: 'teams.trigger.grant',
  unblocked: 'teams.trigger.unblocked',
  continuation: 'teams.trigger.continuation',
  retry: 'teams.trigger.retry',
  interrupted: 'teams.trigger.interrupted',
  context: 'teams.trigger.context',
  routine: 'teams.trigger.routine',
  userMessage: 'teams.trigger.userMessage',
  kickoff: 'teams.trigger.kickoff',
  triage: 'teams.trigger.triage',
  leadApproval: 'teams.trigger.leadApproval',
  manual: 'teams.trigger.manual',
}

export const DEFER_KEY: Record<DeferInfo['reason'], MessageKey> = {
  disabled: 'teams.defer.disabled',
  untrusted: 'teams.defer.untrusted',
  cliOff: 'teams.defer.cliOff',
  paused: 'teams.defer.paused',
  agentPaused: 'teams.defer.agentPaused',
  autonomyOff: 'teams.defer.autonomyOff',
  teamCap: 'teams.defer.teamCap',
  globalCap: 'teams.defer.globalCap',
  quota: 'teams.defer.quota',
  cooldown: 'teams.defer.cooldown',
  sessionBusy: 'teams.defer.sessionBusy',
  takenOver: 'teams.defer.takenOver',
  treeBusy: 'teams.defer.treeBusy',
  consoleBusy: 'teams.defer.consoleBusy',
  running: 'teams.defer.running',
  stopping: 'teams.defer.stopping',
}

/** Why a run does not start now, as a phrase ("el equipo está en pausa"); an unknown reason reads as none. */
export function deferReason(d: DeferInfo, t: TFn): string {
  const key = DEFER_KEY[d.reason]
  return key ? t(key) : ''
}

/** "Ahora no: el equipo está en pausa." with the time it lifts when main gave one. */
export function deferText(d: DeferInfo, t: TFn, lang: Language, now: number): string {
  const reason = deferReason(d, t) || t('teams.run.fail.other')
  return d.until && d.until > now ? t('teams.run.composer.deferredUntil', { reason, time: clockTime(d.until, lang, now) }) : t('teams.run.composer.deferred', { reason })
}

const FAIL_KEY: Partial<Record<TeamError, MessageKey>> = {
  untrusted: 'teams.run.fail.untrusted',
  running: 'teams.run.fail.running',
  stopping: 'teams.run.fail.stopping',
  not_found: 'teams.run.fail.not_found',
  unsupported: 'teams.run.fail.unsupported',
  busy: 'teams.run.fail.busy',
  disabled: 'teams.run.fail.disabled',
  // A task run (runNow with a taskId, B4): the task has no phase to run now, or another agent runs its phase.
  conflict: 'teams.run.fail.conflict',
  bad_request: 'teams.run.fail.bad_request',
}

/**
 * What a refused "Ejecutar ahora" says: the defer reason, or the failure in the catalog's words (never main's detail).
 * A CLI that is off comes back as `deferred` {cliOff}: it says how to turn it on, not "Ahora no" (as routineFailText).
 */
export function runFailText(f: TeamFail, agent: string, t: TFn, lang: Language, now: number): string {
  if (f.error === 'deferred' && f.defer?.reason === 'cliOff') return t('teams.run.fail.cli_off')
  if (f.error === 'deferred' && f.defer) return deferText(f.defer, t, lang, now)
  const key = FAIL_KEY[f.error]
  return key ? t(key, { agent }) : t('teams.run.fail.other')
}

/** "84 mil tokens · 0,40 US$ (estimado)": what a run spent, always an estimate. Null without usage. */
export function runUsageText(usage: PaneUsage | undefined, t: TFn, lang: Language): string | null {
  const total = sumUsage([usage])
  if (!total) return null
  const tokens = formatTokens(total.tokens, lang)
  if (total.costUSD === undefined) return t('teams.run.usageNoCost', { tokens })
  return t(total.unknownCost ? 'teams.run.usageAtLeast' : 'teams.run.usage', { tokens, cost: formatCost(total.costUSD, lang) })
}

// ---- sync ------------------------------------------------------------------------------------------------

/**
 * The core hands each scope of one `teams:changed` to its listeners from its
 * own debounce timer, and a zero-delay timeout runs between them: a pull
 * waits this long so the scopes of one event (a run start is `agents`, `run`
 * and `team`) fold into one request.
 */
const SCOPE_FOLD_MS = 16

/**
 * Keeps the loaded rosters current while the lab is on (startTeams): a team
 * change of its agents, its runs or the team (`agents`, `run`, `team`) pulls
 * that team's roster again, once however many scopes came (SCOPE_FOLD_MS);
 * `disabled` clears everything. Only rosters some view loaded are refetched.
 * The header's view is not pulled here: a commit that moves it (a run that
 * starts or ends, the usage today, a provider limit, a pause) also carries
 * `team` from main, and the core pulls the view on that.
 */
export function initRosterSync(): () => void {
  generation++
  const gen = generation
  const due = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  const off = onTeamChanged((e) => {
    if (e.scopes.includes('disabled')) {
      useRosterStore.setState({ ...EMPTY })
      return
    }
    if (e.scopes.some((s) => s === 'agents' || s === 'run' || s === 'team') && useRosterStore.getState().rosters[e.teamId]) due.add(e.teamId)
    if (due.size === 0 || timer) return
    timer = setTimeout(() => {
      timer = null
      if (gen !== generation) return
      const ids = [...due]
      due.clear()
      for (const id of ids) void loadRoster(id)
    }, SCOPE_FOLD_MS)
  })
  return () => {
    off()
    if (timer) clearTimeout(timer)
    generation++
    seq.clear()
    useRosterStore.setState({ ...EMPTY })
  }
}
