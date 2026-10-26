/**
 * B9 ops (app 2.7.0, E10 B9, design 4.4 and 6.1): Tomar el control and
 * Devolver al Equipo. Main is authoritative: the renderer names an agent and,
 * once, the console it opened; main checks that console (it is in the saved
 * config under that workspace and holds the agent's session, K4) before
 * binding it, and checks it again, by its id wherever it sits now, before it
 * ever kills it (K6). The grant is what an ordinary console of the user needs
 * to resume the session (provider, session id, cwd, the workspace main
 * picked, the names): no token, no team env, never SNAOS_TEAM_RUN.
 */
import { existsSync } from 'fs'
import type { ReleaseStaleDetail, TakeoverBusyDetail, TakeoverGrant, TeamFail, TeamReply, TeamScope } from '@shared/team-protocol'
import { isTeamPaneId, TASK_ID_RE, type AgentSession, type Takeover, type TeamRuntime } from '@shared/teams'
import type { AgentProvider, ConfigFile, Pane } from '@shared/types'
import { pathKey, samePath } from '../../migration/pathUtil'
import { changedScopes } from '../flow/tasks'
import { abortTakeover, beginRelease, beginTakeover, bindTakeover, dropTakeover, finishRelease, type TakeoverOpts } from '../flow/takeover'
import type { FlowResult } from '../flow/types'
import { agentName } from '../views'
import { fail, type OpTable, type TeamInternals, type TeamRecord } from './types'

type Waiting = Extract<Takeover, { phase: 'bindPending' }>

function flowFail(res: Extract<FlowResult<unknown>, { ok: false }>): TeamFail {
  return fail(res.error, res.reason ? { reason: res.reason } : {})
}

/** A takeover or release `busy` that names its case, so the renderer words each one. */
function busy(detail: TakeoverBusyDetail): TeamFail {
  return fail('busy', { detail })
}

/** A takeover commit's scopes: the roster, the sidebar row (its takeovers), and whatever else it moved (a task given back, a run). */
function scopesOf(before: Readonly<TeamRuntime>, res: FlowResult<unknown>): TeamScope[] {
  return [...new Set<TeamScope>(['agents', 'list', ...(res.ok ? changedScopes(before, res.rt) : [])])]
}

/** A takeover reducer's result committed with its scopes. */
function commitTakeover<R>(svc: TeamInternals, teamId: string, before: Readonly<TeamRuntime>, res: FlowResult<R>, hint?: { runId?: string }): FlowResult<R> {
  return svc.commit(teamId, res, scopesOf(before, res), hint)
}

/** K3: a console can resume a session only in its own folder (a Claude session lives in its cwd slug, S3): a removed task worktree's cannot. */
function cwdExists(cwd: string): boolean {
  try {
    return cwd !== '' && existsSync(cwd)
  } catch {
    return false
  }
}

/** When each session was last used: the end of its lastRunId in the runs ring (K3 picks the most recent). */
function lastUsedOf(rec: TeamRecord): (s: AgentSession) => number | undefined {
  const at = new Map<string, number>()
  for (const r of rec.store.recentRuns()) at.set(r.id, r.endedAt ?? r.startedAt ?? r.queuedAt)
  return (s) => (s.lastRunId ? at.get(s.lastRunId) : undefined)
}

/**
 * Plan 3.10.2: the team's workspace while it still exists in the config, else the first workspace whose folder is
 * the session's (the task worktree, an extra repo root), else the first whose folder is the team's repo root; absent
 * -> the renderer creates "Equipo <nombre>".
 */
export function grantWorkspaceOf(cfg: ConfigFile | null, teamWorkspace: string | undefined, cwd: string, repoRoot: string): string | undefined {
  const list = cfg?.workspaces ?? []
  if (teamWorkspace && list.some((w) => w.id === teamWorkspace)) return teamWorkspace
  const key = (p: unknown): string | null => (typeof p === 'string' && p.trim() !== '' ? pathKey(p) : null)
  for (const want of [key(cwd), key(repoRoot)]) {
    if (want === null) continue
    const hit = list.find((w) => key(w.cwd) === want)
    if (hit) return hit.id
  }
  return undefined
}

/** The grant of a waiting takeover: the session, its cwd, the workspace main picked and the names for the console's title. */
export function grantOf(svc: Pick<TeamInternals, 'config' | 'shownDef'>, rec: TeamRecord, agentId: string, tk: Waiting): TakeoverGrant {
  const rt = rec.store.rt
  const def = svc.shownDef(rec)
  const name = agentName(rt, def, agentId)
  const teamName = def?.name ?? rec.entry.name
  const taskId = TASK_ID_RE.test(tk.sessionKey) ? tk.sessionKey : undefined
  const grant: TakeoverGrant = { provider: tk.provider, sessionId: tk.sessionId, cwd: tk.cwd, agentName: name, teamName, title: `${name} (${taskId ?? teamName})` }
  if (taskId) grant.taskId = taskId
  const ws = grantWorkspaceOf(svc.config(), rt.workspaceId, tk.cwd, rec.entry.repoRoot)
  if (ws) grant.workspaceId = ws
  return grant
}

/** The workspace a console with this id sits under in the saved config, with its saved form; null when it is in none. */
function paneAt(cfg: ConfigFile | null, paneId: string): { workspaceId: string; pane: Pane } | null {
  for (const w of cfg?.workspaces ?? []) {
    const pane = (w?.panes ?? []).find((p) => p?.id === paneId)
    if (pane) return { workspaceId: w.id, pane }
  }
  return null
}

/**
 * K4 (and the K6 re-check): the console is in the saved config (K4: under the workspace the renderer named; K6,
 * `workspaceId` null: under any, since main's own record goes stale when the user moves the console and deletes its
 * home) and holds the session: the console a live status, a session record or the config says holds it is this one;
 * with none holding it, its lastSession is the session or (`spawnCwd`, K4 only) its pty was spawned in the session's
 * cwd. A console another one beats to the session never holds it, nor does a team run's synthetic pane, nor one whose
 * own live status names another conversation (a /clear: its saved lastSession catches up only with the renderer's
 * debounced save), nor one a notHeld release left in place for this session (consoleLeft) unless its own live status
 * names the session again.
 */
export function paneHoldsSession(
  svc: Pick<TeamInternals, 'config' | 'paneHolder' | 'paneSpawnCwd' | 'paneState' | 'consoleLeft'>,
  tk: { provider: AgentProvider; sessionId: string; cwd: string },
  paneId: string,
  workspaceId: string | null,
  o: { spawnCwd: boolean },
): boolean {
  if (isTeamPaneId(paneId)) return false
  const cfg = svc.config()
  const pane = workspaceId === null ? paneAt(cfg, paneId)?.pane : cfg?.workspaces?.find((w) => w.id === workspaceId)?.panes?.find((p) => p.id === paneId)
  if (!pane) return false
  const own = svc.paneState(paneId)?.sessionId
  if (own && own !== tk.sessionId) return false
  if (own !== tk.sessionId && svc.consoleLeft(tk.sessionId, paneId)) return false
  const holder = svc.paneHolder(tk.provider, tk.sessionId)
  if (holder !== null) return holder === paneId
  const ls = pane.lastSession
  if (ls && ls.provider === tk.provider && ls.sessionId === tk.sessionId) return true
  if (!o.spawnCwd) return false
  const cwd = svc.paneSpawnCwd(paneId)
  return typeof cwd === 'string' && cwd !== '' && samePath(cwd, tk.cwd)
}

/**
 * The reply of a takeover op once the session is held: the grant of the waiting takeover (marked as delivered, so a
 * second click answers busy); a run that has not closed yet -> `busy` (retry once it is over: that retry gets the
 * grant); a takeover that went without a session -> `no_session`.
 */
function grantReply(svc: TeamInternals, teamId: string, agentId: string): TeamReply<'takeover'> {
  const rec = svc.team(teamId)
  const a = rec?.store.rt.agents.find((x) => x.id === agentId)
  if (!rec || !a) return fail('not_found')
  const tk = a.takeover
  if (!tk) return fail('no_session')
  if (tk.phase !== 'bindPending') return fail('busy')
  // Decision 64 on every grant: a takeover that was stopping when the app died holds the session of a reaped run whose
  // process may still write it (the retry after a restart hands that grant out); it stays waiting, nothing marked.
  if (svc.orphanSession(teamId, tk.sessionId)) return busy('orphan')
  svc.takeoverGranted(teamId, agentId, tk.at, true)
  svc.log(`takeover ${teamId} ${agentId} granted ${tk.provider} ${tk.sessionKey}`)
  return { ok: true, grant: grantOf(svc, rec, agentId, tk) }
}

export const takeoverOps: Pick<OpTable, 'takeover' | 'takeoverBound' | 'takeoverAbort' | 'release'> = {
  /**
   * K1 / K2 / K3: the agent's session for a console. A live run stops and this answers once it ended (K2: its end
   * hands the session over), within the stop wait; an idle agent's session is held at once. A waiting takeover whose
   * grant never left main (the stop outlived the wait, a restart) is handed out by this retry.
   */
  async takeover(req, { svc }) {
    const rec = svc.team(req.teamId)
    const agent = rec?.store.rt.agents.find((a) => a.id === req.agentId)
    if (!rec || !agent) return fail('not_found')
    const waiting = agent.takeover
    if (waiting?.phase === 'bindPending' && !svc.takeoverGranted(req.teamId, agent.id, waiting.at)) return grantReply(svc, req.teamId, agent.id)
    const opts: TakeoverOpts = { lastUsed: lastUsedOf(rec), usable: (s) => cwdExists(s.cwd), policyOf: (f) => svc.runEndPolicy(f) }
    let before: Readonly<TeamRuntime>
    let begun: ReturnType<typeof beginTakeover>
    do {
      before = rec.store.rt
      begun = beginTakeover(before, agent.id, { now: svc.now() }, opts)
      if (!begun.ok) return flowFail(begun)
      // Decision 64: a process of an earlier app life still writes that session; a console beside it would corrupt it.
      const held = begun.rt.agents.find((a) => a.id === agent.id)?.takeover
      if (held && held.phase === 'bindPending' && svc.orphanSession(req.teamId, held.sessionId)) return busy('orphan')
      // That check commits when an orphan died (its card dismissed): the takeover is reduced again from the runtime it
      // left, or its commit (no CAS) would put the card back. Each such commit drops a lingering entry, so this ends.
    } while (rec.store.rt !== before)
    const runId = begun.result.runId
    const res = commitTakeover(svc, req.teamId, before, begun, runId ? { runId } : undefined)
    if (!res.ok) return flowFail(res)
    svc.log(`takeover ${req.teamId} ${agent.id} ${res.result.immediate ? 'held' : `stopping ${runId ?? ''}`}`)
    if (!res.result.immediate) await svc.takeoverSettled(req.teamId, agent.id)
    return grantReply(svc, req.teamId, agent.id)
  },

  /**
   * K4: the console the renderer opened for the grant. Validated here (paneHoldsSession) before the bind; a console
   * the saved config does not list yet (the renderer saves through a debounce) or that has not spawned is looked at
   * again at every config save, console status and spawn until TAKEOVER_CONFIRM_MS: still not it -> `bad_request`
   * and the takeover keeps waiting (its `bind:` deadline, a later config reconcile).
   */
  async takeoverBound(req, { svc }) {
    if (!svc.team(req.teamId)?.store.rt.agents.some((a) => a.id === req.agentId)) return fail('not_found')
    if (isTeamPaneId(req.paneId)) return fail('bad_request')
    const out: { reply: TeamReply<'takeoverBound'> | null } = { reply: null }
    const attempt = (): boolean => {
      const rec = svc.team(req.teamId)
      const a = rec?.store.rt.agents.find((x) => x.id === req.agentId)
      if (!rec || !a) {
        out.reply = fail('not_found')
        return true
      }
      const tk = a.takeover
      if (tk && (tk.phase === 'bound' || tk.phase === 'releasing')) {
        // The config reconcile may have bound this very console first.
        out.reply = tk.paneId === req.paneId && tk.workspaceId === req.workspaceId ? { ok: true } : fail('conflict', { reason: 'stale' })
        return true
      }
      if (tk?.phase !== 'bindPending') {
        out.reply = fail('conflict', { reason: 'stale' })
        return true
      }
      if (!paneHoldsSession(svc, tk, req.paneId, req.workspaceId, { spawnCwd: true })) return false
      const before = rec.store.rt
      const res = commitTakeover(svc, req.teamId, before, bindTakeover(before, a.id, req.paneId, req.workspaceId, { now: svc.now() }))
      out.reply = res.ok ? { ok: true } : flowFail(res)
      if (res.ok) svc.log(`takeover ${req.teamId} ${a.id} bound`)
      return true
    }
    if (attempt() || (await svc.awaitPane(attempt))) return out.reply ?? fail('bad_request')
    svc.log(`takeover ${req.teamId} ${req.agentId} bind refused: the console does not hold the session`)
    return fail('bad_request')
  },

  /** K5: the renderer could not open the console; the agent goes back (a run still stopping answers `stopping`). */
  async takeoverAbort(req, { svc }) {
    const rec = svc.team(req.teamId)
    if (!rec) return fail('not_found')
    const before = rec.store.rt
    const res = commitTakeover(svc, req.teamId, before, abortTakeover(before, req.agentId, { now: svc.now() }))
    if (!res.ok) return flowFail(res)
    if (res.rt !== before) svc.log(`takeover ${req.teamId} ${req.agentId} aborted`)
    return { ok: true }
  },

  /**
   * K6: Devolver al Equipo. The bound console is checked again first, found by its id under whatever workspace of the
   * saved config it sits now (a console the user moved and whose home they deleted is saved under its new workspace;
   * the workspace is K4's check of the renderer's ids): one that no longer holds the session is never killed, the
   * agent goes back at once (the K7 path; a console still in the config answers `conflict {stale}` with detail
   * `notHeld`, so the renderer keeps it, and main never binds that session to it again unless its live status names
   * it, consoleLeft). A console working or asking -> `busy`. Else killPaneAndWait, and the agent goes back only once
   * its pty is gone (else it stays bound, `busy`); the reply names the console and the workspace it is in now (the
   * bound one once it left the config), which the renderer then removes (removePane, never closePane). Every `busy`
   * names its case (TakeoverBusyDetail): `releasing` a release already running, `turn` the console mid turn, `kill` a
   * pty that outlived the kill.
   */
  async release(req, { svc }) {
    const rec = svc.team(req.teamId)
    const a = rec?.store.rt.agents.find((x) => x.id === req.agentId)
    if (!rec || !a) return fail('not_found')
    const tk = a.takeover
    if (!tk || (tk.phase !== 'bound' && tk.phase !== 'releasing')) return fail('conflict', { reason: 'stale' })
    if (tk.phase === 'releasing') return busy('releasing')
    const { paneId } = tk
    const kept = paneAt(svc.config(), paneId)
    const workspaceId = kept?.workspaceId ?? tk.workspaceId
    if (!paneHoldsSession(svc, tk, paneId, null, { spawnCwd: false })) {
      const before = rec.store.rt
      const res = commitTakeover(svc, req.teamId, before, dropTakeover(before, a.id, { now: svc.now() }))
      if (!res.ok) return flowFail(res)
      if (kept) svc.consoleLeft(tk.sessionId, paneId, true)
      svc.log(`takeover ${req.teamId} ${a.id} released without a kill: the console ${kept ? 'no longer holds the session' : 'is gone'}`)
      return kept ? fail('conflict', { reason: 'stale', detail: 'notHeld' satisfies ReleaseStaleDetail }) : { ok: true, paneId, workspaceId }
    }
    const state = svc.paneState(paneId)?.state
    const midTurn = state === 'working' || state === 'action'
    const before = rec.store.rt
    const begun = commitTakeover(svc, req.teamId, before, beginRelease(before, a.id, midTurn, { now: svc.now() }))
    if (!begun.ok) return begun.error === 'busy' ? busy(midTurn ? 'turn' : 'releasing') : flowFail(begun)
    let killed = false
    try {
      await svc.killPane(paneId)
      killed = svc.panePty(paneId) === null
    } catch {
      killed = false
    }
    const after = svc.team(req.teamId)
    if (!after) return fail('not_found')
    const mid = after.store.rt
    const fin = commitTakeover(svc, req.teamId, mid, finishRelease(mid, a.id, killed, { now: svc.now() }))
    if (!fin.ok) return flowFail(fin)
    svc.log(`takeover ${req.teamId} ${a.id} ${killed ? 'released' : 'release failed: the console is still alive'}`)
    return killed ? { ok: true, paneId, workspaceId } : busy('kill')
  },
}
