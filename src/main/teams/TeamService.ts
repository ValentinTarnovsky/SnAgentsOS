import { randomBytes, randomUUID } from 'crypto'
import { promises as fsp } from 'fs'
import { isAbsolute, join, resolve } from 'path'
import { normalizeLabs } from '@shared/labs'
import { definitionIssues, parseFrontmatter, UNC_PATH_RE } from '@shared/teamDefinition'
import { isPhoneTeamOp, type TeamChangedEvt, type TeamFail, type TeamOp, type TeamReply, type TeamRequest, type TeamScope, type TeamTrustState } from '@shared/team-protocol'
import { REPO_MAIN, type DefError, type ResolvedRepo, type TeamDefinition, type TrustedDefinition } from '@shared/teams'
import type { ConfigFile } from '@shared/types'
import { DeadlineTimer, type DeadlineTimerDeps } from '../DeadlineTimer'
import type { GitRunner } from '../git/gitExec'
import { isSameOrInside, pathKey } from '../migration/pathUtil'
import type { PtySink } from '../pty/PtyManager'
import { TrustStore } from '../repoConfig/TrustStore'
import { dismissSystemCards, openSystemCard, reconcileAgents } from './flow/agents'
import type { FlowCtx, FlowResult, TeamEffect } from './flow/types'
import { currentBranch } from './ops/core'
import { OPS } from './ops/index'
import { fail, type OpHandler, type TeamInternals, type TeamRecord } from './ops/types'
import { TeamDefinitionLoader, type LoadedDefinition, type LoaderFs, type LoadRes } from './TeamDefinitionLoader'
import { resolveMainRoot, TeamRegistry, teamIdOf, type RegistryFs, type TeamIndexEntry } from './TeamRegistry'
import { TeamStore, type SyncFs, type TeamStoreDeps } from './TeamStore'
import { goalHashOf, TeamTrust } from './TeamTrust'

/** fs.watch events of a definition folder are debounced this long (design 3.10 `defwatch:<teamId>`). */
export const DEFWATCH_MS = 300

/**
 * Ops refused with `untrusted` while the cached trust state is not `trusted`
 * (design 3.9): what could start a run or touch git. Reads, edits, comments
 * and decisions keep working so the user can see the diff and tidy the board.
 */
const TRUST_GATED_OPS: ReadonlySet<TeamOp> = new Set<TeamOp>(['runNow', 'kickoff', 'routineRun', 'integrate', 'dispatch'])

/** The problems of a load as one comparable key: the load error, or the parser's errors and warnings. */
function issueKey(loaded: LoadRes): string {
  if ('error' in loaded) return loaded.error
  return JSON.stringify(definitionIssues(loaded.result))
}

export interface TeamServiceDeps {
  dataDir: () => string
  config: () => ConfigFile | null
  platform?: NodeJS.Platform
  now?: () => number
  git: GitRunner
  /** Renderer + RemoteManager.teamChanged (B8). */
  emit: (evt: TeamChangedEvt) => void
  /** The reveal op (main computes and lstats the folder): Electron's shell.openPath, '' when it opened, else its error text. */
  openPath: (path: string) => Promise<string>
  /** teamsLog: codes and ids only, never prompt or reply text. */
  log: (line: string) => void
  /** Test seam (manual clock). */
  timerDeps?: DeadlineTimerDeps
  /** Test seams: a fake trust store, a fake loader, the store's fs, the registry's trash move, the extra repo lookups, strict invariants. */
  trustStore?: Pick<TrustStore, 'get' | 'setChecked' | 'delete'>
  loader?: TeamDefinitionLoader
  storeFs?: SyncFs
  registryFs?: RegistryFs
  repoFs?: Pick<LoaderFs, 'lstat' | 'realpath'>
  strict?: boolean
}

/**
 * Teams facade (app 2.7.0, E10 B, design 3.1): the only owner of team state.
 * With `labs.teams` off it holds no team, arms no timer and every request
 * answers `disabled`. Enabled, it keeps one TeamStore per registered team, the
 * cached trust state of each (decision 69) and one DeadlineTimer for every
 * deadline of the module, built once here and disposed only by dispose()
 * (design 3.0 item 6).
 */
export class TeamService implements TeamInternals {
  readonly registry: TeamRegistry
  readonly loader: TeamDefinitionLoader
  readonly trust: TeamTrust
  readonly git: GitRunner
  /** B9 binds taken-over panes through it; until then a no-op consumer. */
  readonly sink: PtySink = { id: 'teams', onSpawn: () => undefined, onData: () => undefined, onExit: () => undefined }

  private readonly clock: () => number
  private readonly repoFs: Pick<LoaderFs, 'lstat' | 'realpath'>
  private readonly timer: DeadlineTimer<string>
  private readonly teams = new Map<string, TeamRecord>()
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly checks = new Map<string, Promise<void>>()
  private readonly pendingEmits = new Map<string, { teamId: string; scopes: TeamScope[]; taskId?: string; runId?: string }>()
  private emitQueued = false
  /** labs.teams as last seen. */
  private labOn = false
  /** Teams are loaded and served. */
  private enabled = false
  /** shutdownSync ran (exit hooks); thaw() undoes it unless the app is really quitting. */
  private frozen = false
  private quitting = false
  /** dispose() ran: nothing enables again (the timer is gone). */
  private disposed = false
  private enabling: Promise<void> | null = null
  /** Bumped by every enable and teardown: an enable that lost the race drops what it loaded. */
  private epoch = 0

  constructor(private readonly deps: TeamServiceDeps) {
    this.clock = deps.now ?? Date.now
    this.git = deps.git
    const timerDeps: DeadlineTimerDeps = {
      now: this.clock,
      setTimeout: (fn, ms) => {
        const h = setTimeout(fn, ms)
        h.unref?.()
        return h
      },
      ...deps.timerDeps,
    }
    this.timer = new DeadlineTimer<string>((key) => this.onDue(key), timerDeps)
    const teamsDir = (): string => join(deps.dataDir(), 'teams')
    this.registry = new TeamRegistry({ file: () => join(teamsDir(), 'index.json'), trashDir: () => join(teamsDir(), '.trash'), now: this.clock, log: deps.log, fs: deps.registryFs })
    this.repoFs = deps.repoFs ?? { lstat: (p) => fsp.lstat(p), realpath: (p) => fsp.realpath(p) }
    this.loader = deps.loader ?? new TeamDefinitionLoader()
    const store = deps.trustStore ?? new TrustStore({ file: () => join(deps.dataDir(), 'trusted-teams.json'), now: this.clock, platform: deps.platform })
    this.trust = new TeamTrust(store, (id) => join(teamsDir(), id, 'trusted-def.json'), (id) => this.registry.get(id)?.repoRoot ?? null, this.clock)
  }

  // ---- lifecycle -------------------------------------------------------------------------------

  /** After CLI init: no-op with Labs off; else enable(). */
  async start(cfg: ConfigFile | null): Promise<void> {
    this.labOn = normalizeLabs(cfg?.settings?.labs).teams
    if (!this.labOn || this.frozen) return
    await this.beginEnable()
  }

  /** CONFIG_SAVE: labs.teams off -> disable() (decision 57), on -> enable(); anything else is a no-op while not live. */
  setConfig(cfg: ConfigFile | null): void {
    const on = normalizeLabs(cfg?.settings?.labs).teams
    if (on === this.labOn) return
    this.labOn = on
    if (on) {
      if (!this.frozen) void this.beginEnable()
    } else this.disable()
  }

  /**
   * The exit hook (B2 wires it into snapshotAgentsOnce and adds the run
   * interrupts): every store flushed synchronously, every key cleared, the
   * watchers stopped, frozen. Idempotent; nothing is disposed.
   */
  shutdownSync(_trigger?: string): void {
    if (this.frozen) return
    this.frozen = true
    this.teardown()
  }

  /** Unfreeze and enable again (a cancelled session end, macOS activate); refused once the app is quitting. */
  thaw(): void {
    if (!this.frozen || this.quitting) return
    this.frozen = false
    if (this.labOn) void this.beginEnable()
  }

  /** before-quit and will-quit: thaw() is refused from here on. */
  markQuitting(): void {
    this.quitting = true
  }

  /** The only place the DeadlineTimer is disposed; a request after it answers `disabled`. */
  dispose(): void {
    this.disposed = true
    this.teardown()
    this.timer.dispose()
  }

  /** Pending deadlines (tests: zero with Labs off). */
  get pendingTimers(): number {
    return this.timer.size
  }

  private live(): boolean {
    return this.enabled && !this.frozen
  }

  private beginEnable(): Promise<void> {
    if (this.enabled || this.disposed) return Promise.resolve()
    if (this.enabling) return this.enabling
    const p = this.enable().finally(() => {
      if (this.enabling === p) this.enabling = null
    })
    this.enabling = p
    return p
  }

  /**
   * Registry, trash purge, then every team: store, definition, trust, roster,
   * watcher; a `list` change at the end (a renderer that got `disabled` meanwhile
   * pulls the list at once). An index.json that cannot be read (logged by the
   * registry) leaves the service not enabled: the next request tries again.
   */
  private async enable(): Promise<void> {
    const epoch = ++this.epoch
    let entries: TeamIndexEntry[]
    try {
      entries = this.registry.list()
    } catch {
      return
    }
    this.registry.purge()
    const loadedTeams: TeamRecord[] = []
    for (const e of entries) {
      let rec: TeamRecord | null = null
      try {
        rec = await this.loadTeam(e, epoch)
      } catch (err) {
        // One team that cannot load never keeps the others down.
        this.teams.get(e.id)?.store.dispose()
        this.teams.delete(e.id)
        this.deps.log(`load ${e.id} failed ${(err as Error).name}`)
      }
      if (epoch !== this.epoch) {
        rec?.store.dispose()
        for (const r of loadedTeams) {
          r.stopWatch?.()
          r.store.dispose()
        }
        return
      }
      if (rec) loadedTeams.push(rec)
    }
    this.enabled = true
    for (const rec of loadedTeams) rec.stopWatch = this.loader.watch(rec.entry.id, rec.entry.repoRoot, () => this.onDefEvent(rec.entry.id))
    this.deps.log(`enabled teams=${loadedTeams.length}`)
    this.emit('', ['list'])
  }

  private async loadTeam(e: TeamIndexEntry, epoch: number): Promise<TeamRecord | null> {
    const loaded = await this.loader.load(e.repoRoot)
    if (epoch !== this.epoch) return null
    this.trust.reload(e.id)
    const trusted = this.trust.trusted(e.id)
    const { store } = TeamStore.load(this.storeDeps(e.id), e.id, trusted)
    const rec: TeamRecord = { entry: e, store, loaded, trust: 'missing', repoIssues: [], repos: new Map(), stopWatch: null }
    this.teams.set(e.id, rec)
    await this.recompute(rec)
    if (epoch !== this.epoch) return rec
    if (this.trust.snapshotState(e.id) === 'bad') {
      // Decision 34: an edited snapshot or a TrustStore entry that does not match it.
      this.commit(e.id, openSystemCard(store.rt, { why: 'stateReset', actions: ['dismiss'], vars: { what: 'trust' } }, { now: this.clock() }), ['needs', 'list'])
    }
    const ctx = this.flowCtx(e.id)
    if (ctx) this.commit(e.id, reconcileAgents(store.rt, ctx), ['agents'])
    return rec
  }

  /** Labs off (decision 57): flush, clear every key, stop the watchers, answer `disabled`. */
  private disable(): void {
    const had = this.enabled || this.enabling !== null
    this.teardown()
    // Changes still queued for this tick name teams that are gone: `disabled` is the last word.
    this.pendingEmits.clear()
    if (had) this.deps.emit({ teamId: '', rev: 0, scopes: ['disabled'] })
  }

  private teardown(): void {
    this.epoch++
    this.enabled = false
    this.enabling = null
    for (const [id, rec] of this.teams) {
      rec.stopWatch?.()
      rec.stopWatch = null
      this.timer.clear(`defwatch:${id}`)
      rec.store.dispose()
    }
    this.teams.clear()
  }

  private storeDeps(teamId: string): TeamStoreDeps {
    return {
      dir: () => join(this.deps.dataDir(), 'teams', teamId),
      emit: (scopes, hint) => this.emit(teamId, scopes, hint),
      timer: this.timer,
      live: () => this.live(),
      now: this.clock,
      log: this.deps.log,
      fs: this.deps.storeFs,
      strict: this.deps.strict,
    }
  }

  // ---- deadlines -------------------------------------------------------------------------------

  private onDue(key: string): void {
    const colon = key.indexOf(':')
    const kind = colon < 0 ? key : key.slice(0, colon)
    const rest = colon < 0 ? '' : key.slice(colon + 1)
    switch (kind) {
      case 'flush':
        this.teams.get(rest)?.store.flushSync()
        return
      case 'defwatch':
        void this.defCheck(rest)
        return
      default:
        this.deps.log(`deadline ${kind} not handled`)
    }
  }

  private onDefEvent(teamId: string): void {
    if (!this.live() || !this.teams.has(teamId)) return
    this.timer.set(`defwatch:${teamId}`, this.clock() + DEFWATCH_MS)
  }

  /** One definition check per team at a time: a check asked while one runs waits for it, then looks again. */
  private defCheck(teamId: string): Promise<void> {
    const prev = this.checks.get(teamId) ?? Promise.resolve()
    const next = prev.then(() => this.defCheckNow(teamId)).catch((err) => this.deps.log(`defcheck ${teamId} failed ${(err as Error).name}`))
    this.checks.set(teamId, next)
    void next.then(() => {
      if (this.checks.get(teamId) === next) this.checks.delete(teamId)
    })
    return next
  }

  /** The definition moved on disk: re-load, re-resolve, re-derive the cached trust state; emit when it changed anything. */
  private async defCheckNow(teamId: string): Promise<void> {
    const rec = this.teams.get(teamId)
    if (!rec || !this.live()) return
    const epoch = this.epoch
    // load() is the stamp walk and returns its cached result while nothing moved; compared with
    // this record's own load, so a load made by another op (a probe) never hides a change.
    const loaded = await this.loader.load(rec.entry.repoRoot)
    if (epoch !== this.epoch || this.teams.get(teamId) !== rec) return
    const prev = rec.loaded
    if (loaded === prev || ('error' in loaded && 'error' in prev && loaded.error === prev.error)) return
    const before = rec.trust
    const sha = 'error' in rec.loaded ? null : rec.loaded.sha256
    const issues = issueKey(rec.loaded)
    rec.loaded = loaded
    await this.recompute(rec)
    const shaNow = 'error' in loaded ? null : loaded.sha256
    // The problems too: a misnamed file comes and goes without moving the sha, and an invalid team stays invalid.
    if (before !== rec.trust || sha !== shaNow || issues !== issueKey(loaded)) {
      this.deps.log(`defcheck ${teamId} ${before}->${rec.trust}`)
      this.emit(teamId, ['team', 'list', 'needs'])
    }
  }

  async refreshTrust(teamId: string): Promise<void> {
    await this.defCheck(teamId)
  }

  /** Extra repos and the cached trust state of a team from its latest load. */
  private async recompute(rec: TeamRecord): Promise<void> {
    const id = rec.entry.id
    const loaded = rec.loaded
    let repoIssues: DefError[] = []
    let loadedRepos: Map<string, ResolvedRepo | DefError> | null = null
    if (!('error' in loaded) && loaded.result.ok) {
      const r = await this.resolveRepos(rec.entry.repoRoot, loaded.result.def, loaded.files)
      repoIssues = r.issues
      loadedRepos = r.repos
    }
    const trusted = this.trust.trusted(id)
    let repos = new Map<string, ResolvedRepo | DefError>()
    if (trusted) {
      repos = loadedRepos && !('error' in loaded) && loaded.sha256 === trusted.sha256 ? loadedRepos : (await this.resolveRepos(rec.entry.repoRoot, trusted.def, trusted.files)).repos
    }
    // A trust op replaced the load while the repos resolved: its state stands (a later check
    // compares against that load by identity and would never repair a stale `changed`).
    if (rec.loaded !== loaded || this.trust.trusted(id) !== trusted) return
    rec.repos = repos
    rec.repoIssues = repoIssues
    let state = this.trust.state(rec.entry.repoRoot, loaded, id)
    if (repoIssues.length > 0 && state !== 'missing') state = 'invalid'
    this.setTrust(rec, state)
  }

  private setTrust(rec: TeamRecord, state: TeamTrustState): void {
    if (state === rec.trust && (state === 'trusted' || rec.trustSince !== undefined)) return
    if (state === 'trusted') delete rec.trustSince
    else if (rec.trust === 'trusted' || rec.trustSince === undefined) rec.trustSince = this.clock()
    rec.trust = state
  }

  // ---- requests --------------------------------------------------------------------------------

  /**
   * registerTeamsIpc and the phone entry. Frozen and not quitting -> thaw()
   * first; Labs on but a failed enable (index.json unreadable) -> enable again,
   * io while it still fails; Labs off -> disabled; a phone asking a
   * desktop-only op -> bad_request; unknown team -> not_found; the trust gate;
   * then the op. Never throws (io).
   */
  async request(req: TeamRequest, origin: 'desktop' | 'phone'): Promise<TeamReply> {
    try {
      if (this.frozen && !this.quitting) this.thaw()
      const retry = this.labOn && !this.frozen && !this.quitting && !this.disposed
      if (retry && !this.enabled && !this.enabling) void this.beginEnable()
      if (this.enabling) await this.enabling
      if (!this.live()) return fail(retry && this.labOn && !this.frozen ? 'io' : 'disabled')
      if (origin === 'phone' && !isPhoneTeamOp(req.op)) return fail('bad_request')
      if ('teamId' in req) {
        const rec = this.teams.get(req.teamId)
        if (!rec) return fail('not_found')
        const gated = TRUST_GATED_OPS.has(req.op) && !(req.op === 'dispatch' && !req.go)
        if (gated && rec.trust !== 'trusted') return fail('untrusted')
      }
      const handler = OPS[req.op] as OpHandler<TeamOp>
      return await handler(req as never, { origin, actor: { kind: 'user', via: origin }, svc: this, now: this.clock() })
    } catch (err) {
      this.deps.log(`request ${req.op} failed ${(err as Error).name}`)
      return fail('io')
    }
  }

  // ---- TeamInternals ---------------------------------------------------------------------------

  dataDir(): string {
    return this.deps.dataDir()
  }

  config(): ConfigFile | null {
    return this.deps.config()
  }

  now(): number {
    return this.clock()
  }

  log(line: string): void {
    this.deps.log(line)
  }

  openPath(path: string): Promise<string> {
    return this.deps.openPath(path)
  }

  idOf(repoRoot: string): string {
    return teamIdOf(repoRoot, this.deps.platform)
  }

  team(teamId: string): TeamRecord | null {
    return this.teams.get(teamId) ?? null
  }

  trusted(teamId: string): TrustedDefinition | null {
    return this.trust.trusted(teamId)
  }

  shownDef(rec: TeamRecord): TeamDefinition | null {
    const trusted = this.trust.trusted(rec.entry.id)
    if (trusted) return trusted.def
    return 'error' in rec.loaded || !rec.loaded.result.ok ? null : rec.loaded.result.def
  }

  serial<T>(teamId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(teamId) ?? Promise.resolve()
    const next = prev.catch(() => undefined).then(fn)
    const tail = next.catch(() => undefined)
    this.chains.set(teamId, tail)
    void tail.then(() => {
      if (this.chains.get(teamId) === tail) this.chains.delete(teamId)
    })
    return next
  }

  flowCtx(teamId: string): FlowCtx | null {
    const def = this.trust.trusted(teamId)
    if (!def) return null
    return {
      now: this.clock(),
      def,
      newRunId: () => `r-${randomBytes(6).toString('hex')}`,
      newSessionId: () => randomUUID(),
    }
  }

  commit<R>(teamId: string, res: FlowResult<R>, scopes: TeamScope[], hint?: { taskId?: string; runId?: string }): FlowResult<R> {
    const rec = this.teams.get(teamId)
    if (!rec) return res
    const out = rec.store.commit(res, scopes, hint)
    if (out.ok) this.runEffects(teamId, out.effects)
    return out
  }

  /** Effects of a committed result (design 3.0 item 3); each later milestone handles its own kinds. */
  private runEffects(teamId: string, effects: readonly TeamEffect[]): void {
    for (const e of effects) {
      switch (e.kind) {
        case 'dispatch':
          this.poke()
          break
        case 'deadline':
          if (e.at === null) this.timer.clear(e.key)
          else if (this.live()) this.timer.set(e.key, e.at)
          break
        default:
          this.deps.log(`effect ${e.kind} ${teamId} not handled`)
      }
    }
  }

  /** B4: wakes the Dispatcher; nothing dispatches before it. */
  private poke(): void {
    /* no dispatcher yet */
  }

  /**
   * Coalesced per team (and task/run hint) per tick; `rev` is the runtime rev
   * when the event leaves. The trust state and the definition live outside the
   * runtime, so their changes (defCheckNow, approveTrust, addTeam) may leave at
   * an unchanged rev: the renderer drops only an older rev and refetches an equal one.
   */
  emit(teamId: string, scopes: TeamScope[], hint?: { taskId?: string; runId?: string }): void {
    const all = new Set<TeamScope>(scopes)
    if (all.has('team') || all.has('needs') || all.has('agents') || all.has('run')) all.add('list')
    const key = `${teamId}|${hint?.taskId ?? ''}|${hint?.runId ?? ''}`
    const cur = this.pendingEmits.get(key)
    if (cur) {
      for (const s of all) if (!cur.scopes.includes(s)) cur.scopes.push(s)
    } else {
      const evt: { teamId: string; scopes: TeamScope[]; taskId?: string; runId?: string } = { teamId, scopes: [...all] }
      if (hint?.taskId) evt.taskId = hint.taskId
      if (hint?.runId) evt.runId = hint.runId
      this.pendingEmits.set(key, evt)
    }
    if (this.emitQueued) return
    this.emitQueued = true
    void Promise.resolve().then(() => this.flushEmits())
  }

  private flushEmits(): void {
    this.emitQueued = false
    const list = [...this.pendingEmits.values()]
    this.pendingEmits.clear()
    for (const e of list) {
      const evt: TeamChangedEvt = { teamId: e.teamId, rev: this.teams.get(e.teamId)?.store.rt.rev ?? 0, scopes: e.scopes }
      if (e.taskId) evt.taskId = e.taskId
      if (e.runId) evt.runId = e.runId
      try {
        this.deps.emit(evt)
      } catch (err) {
        this.deps.log(`emit failed ${(err as Error).name}`)
      }
    }
  }

  /**
   * Decision 62: the resolved repo of a team, or why it does not resolve.
   * `main` is the registry root with the trusted base branch; extra repos come
   * from the cache filled at load and at every trust.
   */
  repoOf(teamId: string, repoId: string): ResolvedRepo | DefError {
    const missing: DefError = { file: 'team.md', line: 0, key: `repo.${repoId}.path`, code: 'repo', detail: 'missing', severity: 'error' }
    const rec = this.teams.get(teamId)
    if (!rec) return missing
    const def = this.trust.trusted(teamId)?.def
    if (repoId === REPO_MAIN) {
      const r: ResolvedRepo = { repoId, repoRoot: rec.entry.repoRoot, baseBranch: def?.baseBranch ?? rec.entry.baseBranch }
      if (def?.verify) r.verify = def.verify
      return r
    }
    return rec.repos.get(repoId) ?? missing
  }

  /**
   * Extra repos on disk (decision 62): a relative path against the main root;
   * no link or junction at any level (the realpath equals the lexical path);
   * a git main root (not a linked worktree, not bare); not inside the main
   * root, dataDir() or the worktree root; not twice. A UNC or device path
   * (as written, or resolved on win32: a team on a share) is refused before
   * any lstat, realpath or git call: on Windows that lookup alone reaches the
   * network and hands the user's NTLM hash to the host (`unc`).
   */
  async resolveRepos(mainRoot: string, def: TeamDefinition, files: readonly { rel: string; text: string }[]): Promise<{ repos: Map<string, ResolvedRepo | DefError>; issues: DefError[] }> {
    const repos = new Map<string, ResolvedRepo | DefError>()
    const issues: DefError[] = []
    if (def.extraRepos.length === 0) return { repos, issues }
    const team = files.find((f) => f.rel === 'team.md')
    const fm = team ? parseFrontmatter('team.md', team.text) : null
    const lineOf = (key: string): number => (fm && fm.ok ? fm.fields.find((f) => f.key === key)?.line ?? 0 : 0)
    const cfgRoot = this.deps.config()?.settings?.worktreesRoot?.trim()
    const fenced = [mainRoot, this.deps.dataDir(), ...(cfgRoot && isAbsolute(cfgRoot) ? [cfgRoot] : [])]
    const win = (this.deps.platform ?? process.platform) === 'win32'
    const seen: string[] = []
    for (const x of def.extraRepos) {
      const key = `repo.${x.id}.path`
      const bad = (detail: 'unc' | 'missing' | 'link' | 'not_git' | 'not_main_root' | 'inside' | 'duplicate'): void => {
        const e: DefError = { file: 'team.md', line: lineOf(key), key, code: 'repo', detail, severity: 'error' }
        repos.set(x.id, e)
        issues.push(e)
      }
      if (UNC_PATH_RE.test(x.path)) {
        bad('unc')
        continue
      }
      const abs = isAbsolute(x.path) ? resolve(x.path) : resolve(mainRoot, x.path)
      if (win && UNC_PATH_RE.test(abs)) {
        bad('unc')
        continue
      }
      let real: string
      try {
        const st = await this.repoFs.lstat(abs)
        if (st.isSymbolicLink()) {
          bad('link')
          continue
        }
        if (!st.isDirectory()) {
          bad('missing')
          continue
        }
        real = await this.repoFs.realpath(abs)
      } catch {
        bad('missing')
        continue
      }
      if (pathKey(real) !== pathKey(abs)) {
        bad('link')
        continue
      }
      if (fenced.some((f) => isSameOrInside(real, f))) {
        bad('inside')
        continue
      }
      const main = await resolveMainRoot(this.git, real)
      if (main === null) {
        bad('not_git')
        continue
      }
      if (pathKey(main) !== pathKey(real)) {
        bad('not_main_root')
        continue
      }
      if (seen.some((s) => pathKey(s) === pathKey(main))) {
        bad('duplicate')
        continue
      }
      seen.push(main)
      const r: ResolvedRepo = { repoId: x.id, repoRoot: main, baseBranch: x.baseBranch ?? (await currentBranch(this.git, main)) ?? 'main' }
      if (x.verify) r.verify = x.verify
      repos.set(x.id, r)
    }
    return { repos, issues }
  }

  async addTeam(repoRoot: string, loaded: LoadedDefinition & { result: { ok: true } }, baseBranch: string): Promise<{ teamId: string } | TeamFail> {
    const teamId = this.idOf(repoRoot)
    if (this.registry.get(teamId) || this.teams.has(teamId)) return fail('exists')
    const def = loaded.result.def
    const r = await this.resolveRepos(repoRoot, def, loaded.files)
    if (r.issues.length > 0) return fail('invalid_definition', { issues: r.issues })
    if (!this.live()) return fail('disabled')
    const entry: TeamIndexEntry = { id: teamId, repoRoot, name: def.name, baseBranch, createdAt: this.clock() }
    this.registry.put(entry)
    this.trust.reload(teamId)
    const { store } = TeamStore.load(this.storeDeps(teamId), teamId, null)
    const rec: TeamRecord = { entry, store, loaded, trust: 'untrusted', repoIssues: [], repos: new Map(), stopWatch: null }
    this.teams.set(teamId, rec)
    rec.stopWatch = this.loader.watch(teamId, repoRoot, () => this.onDefEvent(teamId))
    const approved = this.trust.approve(teamId, repoRoot, loaded, goalHashOf(def.goal))
    if ('error' in approved) {
      await this.recompute(rec)
      this.emit(teamId, ['list'])
      return fail('io')
    }
    rec.repos = r.repos
    store.setDef(approved)
    this.setTrust(rec, 'trusted')
    const ctx = this.flowCtx(teamId)
    if (ctx) this.commit(teamId, reconcileAgents(store.rt, ctx), ['agents'])
    this.emit(teamId, ['list', 'team', 'needs'])
    return { teamId }
  }

  async approveTrust(teamId: string, loaded: LoadedDefinition & { result: { ok: true } }): Promise<TeamFail | null> {
    const rec = this.teams.get(teamId)
    if (!rec) return fail('not_found')
    const def = loaded.result.def
    const r = await this.resolveRepos(rec.entry.repoRoot, def, loaded.files)
    if (this.teams.get(teamId) !== rec) return fail('not_found')
    if (r.issues.length > 0) {
      rec.loaded = loaded
      rec.repoIssues = r.issues
      this.setTrust(rec, 'invalid')
      this.emit(teamId, ['team', 'needs'])
      return fail('invalid_definition', { issues: r.issues })
    }
    const approved = this.trust.approve(teamId, rec.entry.repoRoot, loaded, goalHashOf(def.goal))
    if ('error' in approved) return fail('io')
    rec.loaded = loaded
    rec.repoIssues = []
    rec.repos = r.repos
    rec.store.setDef(approved)
    this.setTrust(rec, 'trusted')
    if (rec.entry.name !== def.name) {
      rec.entry = { ...rec.entry, name: def.name }
      this.registry.put(rec.entry)
    }
    this.commit(teamId, dismissSystemCards(rec.store.rt, 'stateReset', 'trust'), ['needs'])
    const ctx = this.flowCtx(teamId)
    if (ctx) this.commit(teamId, reconcileAgents(rec.store.rt, ctx), ['agents'])
    this.emit(teamId, ['team', 'needs', 'agents'])
    this.poke()
    return null
  }

  async removeTeam(teamId: string): Promise<TeamFail | null> {
    const rec = this.teams.get(teamId)
    if (!rec) return fail('not_found')
    // B2 stops every run and awaits its close first; B4 disowns the task worktrees; B6 refuses while an integrate runs.
    // Written now, so the folder that moves holds the last state (dispose only flushes: the store stays usable).
    rec.store.dispose()
    if (!this.registry.trash(teamId)) {
      // The folder did not move (EPERM, EBUSY): the team stays whole, entry, trust, watcher and a pending
      // definition check included, or re-adding the repo (same id) would pick the old state up. The user can try again.
      return fail('io', { detail: 'busy' })
    }
    // Only once the folder moved: until then an edit of the definition is still seen.
    rec.stopWatch?.()
    rec.stopWatch = null
    this.timer.clear(`defwatch:${teamId}`)
    this.teams.delete(teamId)
    this.trust.forget(rec.entry.repoRoot, teamId)
    this.loader.forget(rec.entry.repoRoot)
    this.emit(teamId, ['list'])
    return null
  }
}
