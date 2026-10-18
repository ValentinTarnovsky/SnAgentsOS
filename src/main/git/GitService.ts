/**
 * Git chip engine in main (E7-FR-05, 06). Main owns the summaries; the
 * renderer owns the targets (`git:setWatch`) and the settings.
 *
 * Targets are grouped by cwd ("units"), so two workspaces on the same folder
 * share one run. A chip refresh is 2 git processes: `status --porcelain=v2`
 * and `diff HEAD --numstat` (skipped when only untracked files changed), plus
 * a bounded untracked line count. A summary is emitted on `git:update` only
 * when it changed by value.
 *
 * When a unit refreshes (FR-06):
 *  (a) a watcher on its gitdir (index, HEAD, ORIG_HEAD, MERGE_HEAD,
 *      CHERRY_PICK_HEAD, rebase-*) and two shared per common dir (packed-refs,
 *      FETCH_HEAD; refs/heads and refs/remotes), debounced 500 ms. For 300 ms
 *      after a run, an `index` event only counts if the index mtime moved
 *      since the run ended (our own run never loops, a quick git add still
 *      refreshes);
 *  (b) window focus: active units now, other units older than 30 s in
 *      batches of 2 every 250 ms;
 *  (c) an agent pane finishing (`refresh(keys, 'agent')`), debounced 1500 ms;
 *  (d) active units every ACTIVE_POLL_MS, focused window only;
 *  (e) the Changes panel target every PANEL_POLL_MS (focused);
 *  (f) a target hot from a phone request: every ACTIVE_POLL_MS for 60 s;
 *  (g) a manual refresh.
 * Single flight per unit and MIN_RUN_GAP_MS between two runs. With
 * settings.gitChip off, (a)..(d) stop; (e)..(g) keep working on demand.
 * At most MAX_WATCHED units hold watchers (active first, then most recent).
 *
 * Clock, timers, fs.watch, file checks and the git runner are injected so the
 * policy runs under fakes in scripts/test-git.cjs.
 */
import { existsSync, statSync, watch as fsWatch } from 'fs'
import { join, resolve as resolvePath } from 'path'
import type { GitError, GitFileEntry, GitSummary, GitTarget, GitUpdateEvt } from '@shared/git-types'
import { GitExecError, gitErrorCode, type GitRunner } from './gitExec'
import { parseNumstatZ, parseStatusV2, sumNumstat } from './porcelain'
import { UntrackedCounter } from './untrackedLines'

export const ACTIVE_POLL_MS = 10000
export const PANEL_POLL_MS = 3000
export const MIN_RUN_GAP_MS = 1500
export const WATCH_DEBOUNCE_MS = 500
export const AGENT_DEBOUNCE_MS = 1500
export const FOCUS_STALE_MS = 30000
export const FOCUS_BATCH = 2
export const FOCUS_BATCH_GAP_MS = 250
export const HOT_MS = 60000
export const SELF_EVENT_MS = 300
export const MAX_WATCHED = 24

const GITDIR_NAMES = new Set(['index', 'HEAD', 'ORIG_HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'rebase-merge', 'rebase-apply'])
const COMMON_NAMES = new Set(['packed-refs', 'FETCH_HEAD'])

type Handle = unknown
export interface GitTimers {
  setTimeout(fn: () => void, ms: number): Handle
  clearTimeout(h: Handle): void
}
export interface WatchHandle {
  close(): void
}
/** Watch a directory; `onEvent` gets the changed name (relative, may be null). Null when it can't watch. */
export type GitWatchFn = (dir: string, recursive: boolean, onEvent: (name: string | null) => void, onError: () => void) => WatchHandle | null

export type RefreshReason = 'manual' | 'agent'

export interface GitServiceDeps {
  runner: Pick<GitRunner, 'run' | 'info'>
  emit: (evt: GitUpdateEvt) => void
  now?: () => number
  timers?: GitTimers
  watch?: GitWatchFn
  exists?: (p: string) => boolean
  /** mtime of a file, or null (tells our own index events from a real git add). */
  mtimeOf?: (p: string) => number | null
  untracked?: UntrackedCounter
  platform?: NodeJS.Platform
}

interface Resolved {
  repoRoot: string
  gitDir: string
  commonDir: string
}

interface Waiter {
  after: number
  resolve: () => void
}

interface Unit {
  id: string
  cwd: string
  keys: Set<string>
  active: boolean
  mru: number
  resolved: Resolved | null
  summary: GitSummary | null
  error?: GitError
  /** Value signature of the last emitted result ('' = nothing yet). */
  sig: string
  files: GitFileEntry[]
  lastRunAt: number
  inflight: Promise<void> | null
  rerun: boolean
  gapTimer: Handle | null
  watchTimer: Handle | null
  agentTimer: Handle | null
  ignoreIndexUntil: number
  /** gitdir/index mtime when the last run ended. */
  indexMtime: number | null
  gitDirWatch: WatchHandle | null
  hotUntil: number
  waiters: Waiter[]
}

interface CommonWatch {
  handles: WatchHandle[]
}

export interface GitEntryView {
  summary: GitSummary | null
  error?: GitError
  files: GitFileEntry[]
}

const defaultTimers: GitTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

const defaultWatch: GitWatchFn = (dir, recursive, onEvent, onError) => {
  try {
    const w = fsWatch(dir, { recursive, persistent: false }, (_ev, name) => onEvent(name == null ? null : String(name)))
    w.on('error', onError)
    return w
  } catch {
    return null
  }
}

const MAX_TARGETS = 200
const KEY_RE = /^(ws|pane):[A-Za-z0-9_-]{1,128}$/

/** `git:setWatch` payload from the renderer: keep only well formed targets with an absolute cwd. */
export function sanitizeTargets(raw: unknown, isAbsolute: (p: string) => boolean): GitTarget[] {
  if (!Array.isArray(raw)) return []
  const out: GitTarget[] = []
  const seen = new Set<string>()
  for (const t of raw.slice(0, MAX_TARGETS)) {
    if (!t || typeof t !== 'object') continue
    const { key, cwd, workspaceId, paneId, active } = t as Record<string, unknown>
    if (typeof key !== 'string' || !KEY_RE.test(key) || seen.has(key)) continue
    if (typeof cwd !== 'string' || !cwd || cwd.length > 4096 || /[\0\r\n]/.test(cwd) || !isAbsolute(cwd)) continue
    if (typeof workspaceId !== 'string' || workspaceId.length > 128) continue
    if (paneId !== undefined && (typeof paneId !== 'string' || paneId.length > 128)) continue
    seen.add(key)
    out.push({ key, cwd, workspaceId, ...(typeof paneId === 'string' ? { paneId } : {}), active: active === true })
  }
  return out
}

/** Stable value signature of a summary, without `updatedAt`. */
function summarySig(s: GitSummary): string {
  const { updatedAt: _ignored, ...rest } = s
  return JSON.stringify(rest)
}

export class GitService {
  private units = new Map<string, Unit>()
  private keyToUnit = new Map<string, string>()
  private commons = new Map<string, CommonWatch>()
  private enabled = true
  private focused = false
  private panelUnit: string | null = null
  private pollTimer: Handle | null = null
  private focusTimer: Handle | null = null
  private disposed = false
  private readonly now: () => number
  private readonly timers: GitTimers
  private readonly watchFn: GitWatchFn
  private readonly exists: (p: string) => boolean
  private readonly mtimeOf: (p: string) => number | null
  private readonly untracked: UntrackedCounter
  private readonly caseless: boolean
  readonly stats = { runs: 0, watchEvents: 0 }

  constructor(private deps: GitServiceDeps) {
    this.now = deps.now ?? Date.now
    this.timers = deps.timers ?? defaultTimers
    this.watchFn = deps.watch ?? defaultWatch
    this.exists = deps.exists ?? existsSync
    this.mtimeOf =
      deps.mtimeOf ??
      ((p) => {
        try {
          return statSync(p).mtimeMs
        } catch {
          return null
        }
      })
    this.untracked = deps.untracked ?? new UntrackedCounter()
    this.caseless = (deps.platform ?? process.platform) === 'win32'
  }

  // ---- public surface -------------------------------------------------

  /** Replace the watched targets (`git:setWatch`). Re-emits cached results so a reloaded renderer catches up. */
  setTargets(targets: GitTarget[]): void {
    const next = new Map<string, { cwd: string; keys: Set<string>; active: boolean }>()
    this.keyToUnit.clear()
    for (const t of targets) {
      const id = this.norm(t.cwd)
      const slot = next.get(id) ?? { cwd: t.cwd, keys: new Set<string>(), active: false }
      slot.keys.add(t.key)
      slot.active ||= t.active
      next.set(id, slot)
      this.keyToUnit.set(t.key, id)
    }
    for (const [id, u] of this.units) if (!next.has(id)) this.drop(u)
    const t = this.now()
    for (const [id, slot] of next) {
      let u = this.units.get(id)
      const isNew = !u
      if (!u) {
        u = this.newUnit(id, slot.cwd)
        this.units.set(id, u)
      }
      u.keys = slot.keys
      u.active = slot.active
      if (slot.active) u.mru = t
      if (isNew) {
        u.mru = Math.max(u.mru, t)
        if (this.enabled) this.request(u)
      } else if (u.sig) {
        for (const key of u.keys) this.deps.emit(this.evt(u, key))
      }
    }
    if (this.panelUnit && !this.units.has(this.panelUnit)) this.panelUnit = null
    this.rebalanceWatchers()
    this.reschedule()
  }

  /** settings.gitChip: off stops watchers, focus, agent and active polls. */
  setEnabled(on: boolean): void {
    if (this.enabled === on) return
    this.enabled = on
    if (!on) {
      this.cancelFocusBatches()
      for (const u of this.units.values()) {
        this.clear(u, 'watchTimer')
        this.clear(u, 'agentTimer')
      }
    } else {
      for (const u of this.units.values()) this.request(u)
    }
    this.rebalanceWatchers()
    this.reschedule()
  }

  setFocused(focused: boolean): void {
    if (this.focused === focused) return
    this.focused = focused
    if (focused && this.enabled) this.onFocus()
    if (!focused) this.cancelFocusBatches()
    this.reschedule()
  }

  /** Manual refresh (any keys, or every unit) or an agent finishing (debounced). */
  refresh(keys: string[] | undefined, reason: RefreshReason): void {
    const list = keys ? this.unitsOf(keys) : [...this.units.values()]
    for (const u of list) {
      if (reason === 'manual') this.request(u)
      else if (this.enabled) {
        this.clear(u, 'agentTimer')
        u.agentTimer = this.timers.setTimeout(() => {
          u.agentTimer = null
          this.request(u)
        }, AGENT_DEBOUNCE_MS)
      }
    }
  }

  /** The Changes panel target (polled every PANEL_POLL_MS while focused), or null. */
  setPanelTarget(key: string | null): void {
    this.panelUnit = key ? (this.keyToUnit.get(key) ?? null) : null
    if (this.panelUnit) {
      const u = this.units.get(this.panelUnit)
      if (u) this.request(u)
    }
    this.reschedule()
  }

  /** A phone asked about this target: poll it for HOT_MS even unfocused (FR-06f). */
  markHot(key: string): void {
    const u = this.unitOf(key)
    if (!u) return
    u.hotUntil = this.now() + HOT_MS
    this.reschedule()
  }

  /**
   * Resolve once the target has a result no older than `maxAgeMs`, refreshing
   * if needed (single flight and the minimum gap still apply).
   */
  ensureFresh(key: string, maxAgeMs: number): Promise<GitEntryView | null> {
    const u = this.unitOf(key)
    if (!u) return Promise.resolve(null)
    const t = this.now()
    if (u.sig && !u.inflight && u.lastRunAt && t - u.lastRunAt <= maxAgeMs) return Promise.resolve(this.view(u))
    return new Promise((resolve) => {
      u.waiters.push({ after: t, resolve: () => resolve(this.units.get(u.id) === u ? this.view(u) : null) })
      this.request(u)
    })
  }

  /** Last result of a target (summary, error, file list). */
  get(key: string): GitEntryView | null {
    const u = this.unitOf(key)
    return u && u.sig ? this.view(u) : null
  }

  /** Units holding a gitdir watcher (tests and the debug log). */
  watchedCount(): number {
    let n = 0
    for (const u of this.units.values()) if (u.gitDirWatch) n++
    return n
  }

  /** Resolve when no run is in flight (tests). */
  async idle(): Promise<void> {
    for (;;) {
      const busy = [...this.units.values()].map((u) => u.inflight).filter(Boolean)
      if (!busy.length) return
      await Promise.all(busy)
    }
  }

  dispose(): void {
    this.disposed = true
    this.cancelFocusBatches()
    if (this.pollTimer) this.timers.clearTimeout(this.pollTimer)
    this.pollTimer = null
    for (const u of [...this.units.values()]) this.drop(u)
    for (const c of this.commons.values()) for (const h of c.handles) h.close()
    this.commons.clear()
  }

  // ---- scheduling -----------------------------------------------------

  private request(u: Unit): void {
    if (this.disposed || this.units.get(u.id) !== u) return
    if (u.inflight) {
      u.rerun = true
      return
    }
    if (u.gapTimer) return
    const wait = u.lastRunAt ? u.lastRunAt + MIN_RUN_GAP_MS - this.now() : 0
    if (wait > 0) {
      u.gapTimer = this.timers.setTimeout(() => {
        u.gapTimer = null
        this.request(u)
      }, wait)
      return
    }
    const startedAt = this.now()
    u.lastRunAt = startedAt
    this.stats.runs++
    u.inflight = this.run(u).finally(() => {
      u.inflight = null
      u.ignoreIndexUntil = this.now() + SELF_EVENT_MS
      u.indexMtime = u.resolved ? this.mtimeOf(join(u.resolved.gitDir, 'index')) : null
      const ready = u.waiters.filter((w) => w.after <= startedAt)
      u.waiters = u.waiters.filter((w) => w.after > startedAt)
      for (const w of ready) w.resolve()
      if (u.rerun) {
        u.rerun = false
        this.request(u)
      }
      this.reschedule()
    })
  }

  /** Next time a unit is due for a poll, or Infinity. */
  private dueAt(u: Unit, t: number): number {
    if (u.inflight || u.gapTimer) return Infinity
    let every = Infinity
    if (this.enabled && this.focused && u.active) every = ACTIVE_POLL_MS
    if (this.focused && this.panelUnit === u.id) every = Math.min(every, PANEL_POLL_MS)
    if (u.hotUntil > t) every = Math.min(every, ACTIVE_POLL_MS)
    return every === Infinity ? Infinity : u.lastRunAt + every
  }

  private reschedule(): void {
    if (this.pollTimer) this.timers.clearTimeout(this.pollTimer)
    this.pollTimer = null
    if (this.disposed) return
    const t = this.now()
    let due = Infinity
    for (const u of this.units.values()) due = Math.min(due, this.dueAt(u, t))
    if (due === Infinity) return
    this.pollTimer = this.timers.setTimeout(() => {
      this.pollTimer = null
      const at = this.now()
      for (const u of this.units.values()) if (this.dueAt(u, at) <= at) this.request(u)
      this.reschedule()
    }, Math.max(0, due - t))
  }

  private onFocus(): void {
    this.cancelFocusBatches()
    const t = this.now()
    const rest: Unit[] = []
    for (const u of this.units.values()) {
      if (u.active) this.request(u)
      else if (!u.lastRunAt || t - u.lastRunAt > FOCUS_STALE_MS) rest.push(u)
    }
    rest.sort((a, b) => b.mru - a.mru)
    const batch = (): void => {
      this.focusTimer = null
      for (const u of rest.splice(0, FOCUS_BATCH)) this.request(u)
      if (rest.length) this.focusTimer = this.timers.setTimeout(batch, FOCUS_BATCH_GAP_MS)
    }
    if (rest.length) this.focusTimer = this.timers.setTimeout(batch, FOCUS_BATCH_GAP_MS)
  }

  private cancelFocusBatches(): void {
    if (this.focusTimer) this.timers.clearTimeout(this.focusTimer)
    this.focusTimer = null
  }

  // ---- the run --------------------------------------------------------

  private async run(u: Unit): Promise<void> {
    const opts = { cwd: u.cwd }
    try {
      const info = await this.deps.runner.info()
      if (!info.available) throw new GitExecError('git_missing', 'git not found')
      if (info.tooOld) throw new GitExecError('git_old', `git ${info.version ?? ''} is older than 2.20`)
      if (!u.resolved) {
        const out = await this.deps.runner.run(['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], opts)
        const [top, gitDir, common] = out.split(/\r?\n/)
        if (!top || !gitDir || !common) throw new GitExecError('git_error', 'unexpected rev-parse output')
        u.resolved = { repoRoot: resolvePath(top), gitDir: resolvePath(gitDir), commonDir: resolvePath(u.cwd, common) }
        this.rebalanceWatchers()
      }
      const repo = u.resolved
      const st = parseStatusV2(await this.deps.runner.run(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], opts))
      const unborn = st.branch.oid === null
      const tracked = st.staged + st.unstaged + st.conflicts > 0
      const numstat = ['--no-ext-diff', '--no-textconv', '-z', '--numstat']
      let lines = { added: 0, removed: 0 }
      if (tracked && unborn) {
        const cached = sumNumstat(parseNumstatZ(await this.deps.runner.run(['diff', '--cached', ...numstat], opts)))
        const work = sumNumstat(parseNumstatZ(await this.deps.runner.run(['diff', ...numstat], opts)))
        lines = { added: cached.added + work.added, removed: cached.removed + work.removed }
      } else if (tracked) {
        lines = sumNumstat(parseNumstatZ(await this.deps.runner.run(['diff', 'HEAD', ...numstat, '-M'], opts)))
      }
      const untrackedPaths = st.entries.filter((e) => e.area === 'untracked').map((e) => e.path)
      const ut = await this.untracked.count(repo.repoRoot, untrackedPaths)
      const summary: GitSummary = {
        repoRoot: repo.repoRoot,
        branch: st.branch.head,
        detached: st.branch.head === null,
        unborn,
        headShort: st.branch.oid ? st.branch.oid.slice(0, 7) : '',
        upstream: st.branch.upstream,
        ahead: st.branch.upstream ? st.branch.ahead : 0,
        behind: st.branch.upstream ? st.branch.behind : 0,
        files: st.files,
        added: lines.added + ut.lines,
        removed: lines.removed,
        approx: ut.approx || (st.truncated && st.untracked > untrackedPaths.length),
        staged: st.staged,
        unstaged: st.unstaged,
        untracked: st.untracked,
        conflicts: st.conflicts,
        op: this.opOf(repo.gitDir),
        truncated: st.truncated,
        updatedAt: 0,
      }
      this.settle(u, summary, undefined, st.entries)
    } catch (e) {
      const code = gitErrorCode(e)
      if (code === 'not_repo' && u.resolved) {
        this.untracked.forget(u.resolved.repoRoot)
        u.resolved = null
        this.rebalanceWatchers()
      }
      this.settle(u, null, code, [])
    }
  }

  private opOf(gitDir: string): GitSummary['op'] {
    if (this.exists(join(gitDir, 'rebase-merge')) || this.exists(join(gitDir, 'rebase-apply'))) return 'rebase'
    if (this.exists(join(gitDir, 'MERGE_HEAD'))) return 'merge'
    if (this.exists(join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick'
    return null
  }

  /** Store a result; emit it to every key of the unit only when it changed by value. */
  private settle(u: Unit, summary: GitSummary | null, error: GitError | undefined, files: GitFileEntry[]): void {
    if (this.units.get(u.id) !== u) return
    u.files = files
    const sig = summary ? summarySig(summary) : `error:${error}`
    if (sig === u.sig) return
    u.sig = sig
    u.summary = summary ? { ...summary, updatedAt: this.now() } : null
    u.error = summary ? undefined : error
    for (const key of u.keys) this.deps.emit(this.evt(u, key))
  }

  // ---- watchers -------------------------------------------------------

  private rebalanceWatchers(): void {
    const chosen = new Set<Unit>()
    if (this.enabled && !this.disposed) {
      const ranked = [...this.units.values()].filter((u) => u.resolved).sort((a, b) => Number(b.active) - Number(a.active) || b.mru - a.mru)
      for (const u of ranked.slice(0, MAX_WATCHED)) chosen.add(u)
    }
    const commons = new Map<string, string>()
    for (const u of this.units.values()) {
      if (!chosen.has(u)) {
        u.gitDirWatch?.close()
        u.gitDirWatch = null
        continue
      }
      const r = u.resolved as Resolved
      commons.set(this.norm(r.commonDir), r.commonDir)
      if (!u.gitDirWatch) {
        u.gitDirWatch = this.watchFn(
          r.gitDir,
          false,
          (name) => this.onGitDirEvent(u, name),
          () => {
            u.gitDirWatch?.close()
            u.gitDirWatch = null
          },
        )
      }
    }
    for (const [id, c] of this.commons) {
      if (commons.has(id)) continue
      for (const h of c.handles) h.close()
      this.commons.delete(id)
    }
    for (const [id, dir] of commons) {
      if (this.commons.has(id)) continue
      const handles: WatchHandle[] = []
      const top = this.watchFn(dir, false, (name) => name && COMMON_NAMES.has(name) && this.onCommonEvent(id), () => undefined)
      if (top) handles.push(top)
      const refs = this.watchFn(
        join(dir, 'refs'),
        true,
        (name) => {
          const n = (name ?? '').replace(/\\/g, '/')
          if (/^(heads|remotes)(\/|$)/.test(n)) this.onCommonEvent(id)
        },
        () => undefined,
      )
      if (refs) handles.push(refs)
      this.commons.set(id, { handles })
    }
  }

  private onGitDirEvent(u: Unit, name: string | null): void {
    if (!name || !GITDIR_NAMES.has(name.split(/[\\/]/)[0])) return
    this.stats.watchEvents++
    if (name === 'index') {
      if (u.inflight) {
        u.rerun = this.indexChanged(u) || u.rerun
        return
      }
      // Right after our run, an index event is ours unless the file changed since the run ended.
      if (this.now() < u.ignoreIndexUntil && !this.indexChanged(u)) return
    }
    this.debounceWatch(u)
  }

  private onCommonEvent(commonId: string): void {
    this.stats.watchEvents++
    for (const u of this.units.values()) {
      if (u.gitDirWatch && u.resolved && this.norm(u.resolved.commonDir) === commonId) this.debounceWatch(u)
    }
  }

  private indexChanged(u: Unit): boolean {
    if (!u.resolved || u.indexMtime === null) return false
    const m = this.mtimeOf(join(u.resolved.gitDir, 'index'))
    return m !== null && m !== u.indexMtime
  }

  private debounceWatch(u: Unit): void {
    if (!this.enabled) return
    this.clear(u, 'watchTimer')
    u.watchTimer = this.timers.setTimeout(() => {
      u.watchTimer = null
      this.request(u)
    }, WATCH_DEBOUNCE_MS)
  }

  // ---- helpers --------------------------------------------------------

  private norm(p: string): string {
    const abs = resolvePath(p)
    return this.caseless ? abs.toLowerCase() : abs
  }

  private newUnit(id: string, cwd: string): Unit {
    return {
      id,
      cwd,
      keys: new Set(),
      active: false,
      mru: 0,
      resolved: null,
      summary: null,
      sig: '',
      files: [],
      lastRunAt: 0,
      inflight: null,
      rerun: false,
      gapTimer: null,
      watchTimer: null,
      agentTimer: null,
      ignoreIndexUntil: 0,
      indexMtime: null,
      gitDirWatch: null,
      hotUntil: 0,
      waiters: [],
    }
  }

  private drop(u: Unit): void {
    this.clear(u, 'gapTimer')
    this.clear(u, 'watchTimer')
    this.clear(u, 'agentTimer')
    u.gitDirWatch?.close()
    u.gitDirWatch = null
    if (u.resolved) this.untracked.forget(u.resolved.repoRoot)
    this.units.delete(u.id)
    for (const w of u.waiters) w.resolve()
    u.waiters = []
  }

  private clear(u: Unit, field: 'gapTimer' | 'watchTimer' | 'agentTimer'): void {
    const h = u[field]
    if (h) this.timers.clearTimeout(h)
    u[field] = null
  }

  private unitOf(key: string): Unit | null {
    const id = this.keyToUnit.get(key)
    return id ? (this.units.get(id) ?? null) : null
  }

  private unitsOf(keys: string[]): Unit[] {
    const set = new Set<Unit>()
    for (const k of keys) {
      const u = this.unitOf(k)
      if (u) set.add(u)
    }
    return [...set]
  }

  private view(u: Unit): GitEntryView {
    return { summary: u.summary, ...(u.error ? { error: u.error } : {}), files: u.files }
  }

  private evt(u: Unit, key: string): GitUpdateEvt {
    return { key, cwd: u.cwd, summary: u.summary, ...(u.error ? { error: u.error } : {}) }
  }
}
