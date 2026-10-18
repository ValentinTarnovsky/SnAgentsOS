import { spawn, type IPty } from 'node-pty'
import { randomUUID } from 'crypto'
import { delimiter } from 'path'
import type { WebContents } from 'electron'
import { CH } from '@shared/ipc-channels'
import type { HeadlessMetrics, PtyDataEvt, PtyExitEvt, PtyReattachRes, PtyRestartReq, PtyRestartRes, PtySpawnReq, PtySpawnRes, ShellKind, TerminalEngineSettings } from '@shared/ipc-contract'
import type { SetupStep } from '@shared/types'
import { AGENT_ENV } from '@shared/brand'
import { cleanEnv, defaultShell, homeDir } from './shellResolver'
import { resolveShell } from './shellResolve'
import { ModeTracker } from './ModeTracker'
import { sanitizeQueries } from './ansiSanitize'
import { HeadlessMirror } from './HeadlessMirror'
import { DEFAULT_ENGINE, REPLAY_LINES, mirrorScrollback, normalizeEngine } from '@shared/terminalEngine'

interface Entry {
  pty: IPty
  /** Stable renderer-owned id; lets the renderer reattach across remounts. */
  paneId: string
  /** Raw chunks accumulated since the last flush (joined once at flush). */
  buf: string[]
  timer: ReturnType<typeof setTimeout> | null
  /** Bounded recent-output ring, replayed into a fresh terminal on reattach. */
  history: string[]
  historyBytes: number
  /** The ring dropped its oldest chunk at least once (its head may be mid-sequence). */
  historyTruncated: boolean
  /** DEC private modes seen on the full output stream (E6-FR-33). */
  modes: ModeTracker
  /** Family of the launched shell (E6-FR-32). */
  shellKind: ShellKind
  /** The cwd handed to node-pty (E5-FR-05 spawnCwd: where a resume must relaunch). */
  spawnCwd: string
  /** Set by kill() so the exit it causes is not reported as natural (E6-FR-34). */
  killing: boolean
  /** False while the owning workspace is hidden (output is throttled). */
  active: boolean
  /** True while a setup (expect/send) sequence is running for this pty. */
  setupActive: boolean
  /** Set on teardown so an in-flight setup sequence aborts. */
  cancelled: boolean
  /** Rolling tail of recent output the setup runner matches `waitFor` against. */
  scratch: string
  /** Notified (no args) on each new chunk while a setup waiter is pending. */
  onChunk: (() => void) | null
  /** Settles the pending `waitFor` promise (match, timeout, or cancel). */
  setupResolve: (() => void) | null
  /** Pending setup timer (delay or waitFor timeout), cleared on cancel. */
  setupTimer: ReturnType<typeof setTimeout> | null
  /** Outbound bytes still queued for the pty, drained in paced chunks. */
  writeQueue: string
  /** Timer pacing the writeQueue drain (null while idle). */
  writeTimer: ReturnType<typeof setTimeout> | null
  /** Headless emulator fed with every flush (E6-FR-01); null until the snapshot mode creates it. */
  mirror: HeadlessMirror | null
  /** The mirror threw once: this pty stays on ring + ModeTracker replays for good. */
  mirrorFailed: boolean
  /** Output arrived since the last scrollback checkpoint (E6-FR-09 clears it). */
  dirty: boolean
  /** Bumped on every change a snapshot can see (flush with data, resize, unicode, scrollback). */
  gen: number
  /** Last replay snapshot and the gen it was taken at (several phones or a reattach in one tick). */
  snapCache: { gen: number; data: string } | null
}

/** Output is coalesced and flushed at ~120Hz for the visible workspace. */
const FLUSH_MS = 8
/** Hidden workspaces flush far slower, their xterms can't paint anyway. */
const HIDDEN_FLUSH_MS = 250
/** Cap on a single IPC payload (split larger bursts across frames). */
const MAX_CHUNK = 256 * 1024
/**
 * Windows ConPTY silently drops bytes when one write exceeds its small input
 * buffer, so a large paste arrives truncated (only the tail survives). Feed the
 * pty in capped, paced chunks instead. Normal typing (a write at or under the
 * cap with nothing queued) skips the queue, so keystroke latency is unchanged.
 */
const WRITE_CHUNK = 4 * 1024
const WRITE_PACE_MS = 4
/** Replay ring-buffer size per pty. */
const HISTORY_CAP = 256 * 1024
/**
 * A restart seed enters the new ring in pieces this size, so new output pushes
 * out its oldest lines a piece at a time instead of the whole kept output at
 * once (a seed of a full ring sits right at HISTORY_CAP).
 */
const SEED_CHUNK = 16 * 1024
/** Recent-output tail kept for setup `waitFor` matching (bounds memory). */
const SCRATCH_CAP = 16 * 1024
/**
 * How far into a truncated ring trimRingHead looks for a clean start. Past it
 * the head is kept as is rather than dropping a whole ring of CR-only output.
 */
const HEAD_SCAN = 8 * 1024
/** Timing samples kept for the headless p95 metrics (E6-FR-07). */
const METRIC_SAMPLES = 512
/** Cadence of the SNAOS_DEBUG_TERMINAL console line. */
const DEBUG_METRICS_MS = 10_000
/** How long the shell is given to print its first prompt before setup begins. */
const SHELL_SETTLE_MS = 350
/** Default cap on waiting for a `waitFor` match before proceeding anyway. */
const DEFAULT_WAIT_MS = 15000

/**
 * Builds a predicate for a `waitFor` pattern. `/body/flags` is treated as a
 * regex (bad patterns fall back to a literal match); everything else is a
 * case-insensitive substring test so "password:" matches "Password:".
 */
function buildMatcher(pattern: string): (text: string) => boolean {
  const re = pattern.match(/^\/(.*)\/([a-z]*)$/is)
  if (re) {
    try {
      const rx = new RegExp(re[1], re[2])
      return (text) => rx.test(text)
    } catch {
      /* malformed regex, fall through to substring */
    }
  }
  const needle = pattern.toLowerCase()
  return (text) => text.toLowerCase().includes(needle)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** An alt-screen DECSET (?47 / ?1047 / ?1049, alone or inside a list). */
const ALT_ENTER_RE = /\x1b\[\?(?:[\d;]*;)?(?:47|1047|1049)(?:;[\d;]*)?h/

/**
 * Start of a replay built from the ring. Once the ring has dropped chunks, its
 * first chunk can begin inside an escape sequence (`;2;255m...` printed as
 * text) or mid-line, so the replay starts after the first line break, or at the
 * first ESC when there is no line break near the head. An untruncated ring is
 * the exact stream start and is returned whole.
 */
export function trimRingHead(ring: string, truncated: boolean): string {
  if (!truncated || !ring) return ring
  const limit = Math.min(ring.length, HEAD_SCAN)
  const nl = ring.indexOf('\n')
  if (nl >= 0 && nl < limit) return ring.slice(nl + 1)
  const esc = ring.indexOf('\x1b')
  if (esc >= 0 && esc < limit) return ring.slice(esc)
  return ring
}

/**
 * Turns off what a dead or replaced program may have left on (E6-FR-18/19):
 * SGR, alt screen, every mouse protocol and encoding, bracketed paste,
 * application cursor keys, focus reports, and shows the cursor. Written after
 * the kept output, so a restarted pane (desktop and phone) starts clean.
 */
export const SOFT_RESET =
  '\x1b[0m\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?2004l\x1b[?1l\x1b[?25h\x1b[?1004l'

/** Last output of a pane whose pty ended on its own (E6-FR-20), kept for phones and restarts. */
export interface ExitedPane {
  /** The dead pty, so a later kill() of that id (pane closed) drops the record. */
  ptyId: string
  /** Clean ring + SOFT_RESET, ready to replay. */
  data: string
  cols: number
  rows: number
  exitCode: number
  at: number
}

/** The restart separator line: gray, control characters stripped from the label. */
export function restartTail(label: string): string {
  return `${SOFT_RESET}\r\n\x1b[2m--- ${label.replace(/[\x00-\x1f\x7f-\x9f]/g, '')} ---\x1b[0m\r\n`
}

/** Bounded timing samples (ms) with a p95 read (E6-FR-07). */
class Samples {
  private readonly buf: number[] = []
  private next = 0
  add(ms: number): void {
    if (this.buf.length < METRIC_SAMPLES) this.buf.push(ms)
    else this.buf[this.next] = ms
    this.next = (this.next + 1) % METRIC_SAMPLES
  }
  p95(): number {
    if (this.buf.length === 0) return 0
    const sorted = [...this.buf].sort((a, b) => a - b)
    return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] * 1000) / 1000
  }
}

const nowMs = (): number => Number(process.hrtime.bigint()) / 1e6

/** How a pty ended, as seen by each sink (E6-FR-34). */
export interface PtyExitInfo {
  /** The pty was still the live one bound to its pane. */
  current: boolean
  /** The process ended on its own (not kill/killAll/restart or a failed spawn). */
  natural: boolean
}

/**
 * An extra consumer of pty lifecycle + output, fed alongside the renderer
 * (remote-control sessions mirror terminals through one of these). Callbacks
 * run synchronously on the pty event path and must never throw or block.
 */
export interface PtySink {
  id: string
  /** A pty was bound to paneId (spawn or restart => NEW ptyId, rebind). */
  onSpawn(ptyId: string, paneId: string): void
  /** Coalesced output, same bytes the renderer receives (unsplit). */
  onData(ptyId: string, paneId: string, data: string): void
  /**
   * The pty exited (or failed to spawn). Fired after the final data flush,
   * before teardown, for every exit; `info` tells natural current exits apart.
   */
  onExit(ptyId: string, paneId: string, exitCode: number, info: PtyExitInfo): void
}

/**
 * Owns every node-pty instance. The renderer never touches native modules;
 * it drives ptys exclusively through this manager via IPC.
 *
 * Beyond raw I/O it maintains, per pane: a replay ring buffer (so a remounted
 * or reloaded renderer can rebind without respawning), an active flag for
 * hidden-workspace output throttling, and flow control for backpressure.
 */
export class PtyManager {
  private readonly entries = new Map<string, Entry>()
  private readonly byPane = new Map<string, string>()
  private seq = 0
  /** Extra output listeners (remote-control sessions) fed alongside the renderer. */
  private readonly sinks = new Map<string, PtySink>()
  /** Panes that flush at the fast cadence even while hidden (remote viewers). */
  private readonly forcedFast = new Set<string>()
  /** Ptys paused via renderer backpressure; auto-resumed if the renderer dies. */
  private readonly pausedByRenderer = new Set<string>()
  /** Fired after byPane changes (spawn/dispose) so remote can refresh `running`. */
  private onRunningChange: (() => void) | null = null
  /** paneId -> epoch ms of the last input written (desktop or phone), for hibernation (E5-FR-25). */
  private readonly lastInput = new Map<string, number>()
  /** paneId -> last output of a pty that ended on its own (E6-FR-20); one per pane. */
  private readonly exited = new Map<string, ExitedPane>()
  /** Headless mirror policy, Unicode and persistence lines (E6-FR-01/06/08), set by setEngine. */
  private engine: TerminalEngineSettings = { ...DEFAULT_ENGINE }
  private readonly parseMs = new Samples()
  private readonly snapshotMs = new Samples()
  private bytesParsed = 0
  private snapshotCacheHits = 0
  private debugTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly getSender: () => WebContents | null,
    private readonly statusEnv: (ptyId: string, paneId: string, cwd: string) => Record<string, string> = () => ({}),
  ) {}

  /** Number of live ptys. */
  get count(): number {
    return this.entries.size
  }

  spawn(req: PtySpawnReq): PtySpawnRes {
    return this.spawnSeeded(req, '')
  }

  /**
   * spawn() with `seed` pre-loaded into the new ring, before any sink hears of
   * the pty, so a phone's replay already carries it (E6-FR-19). The seed never
   * feeds the ModeTracker: the new program starts with default modes.
   */
  private spawnSeeded(req: PtySpawnReq, seed: string): PtySpawnRes {
    const ptyId = `pty-${++this.seq}-${randomUUID()}`
    // A configured shell that does not exist falls back to the OS default (E6-FR-32).
    const resolved = resolveShell(req.shell, defaultShell())
    if (resolved.warning) console.warn(`[pty] shell not found: ${resolved.warning.requested}, using ${resolved.shell}`)
    const shell = resolved.shell
    const env = cleanEnv({ ...req.env, ...this.statusEnv(ptyId, req.paneId, req.cwd || homeDir()), [AGENT_ENV.consoleId]: req.paneId, [AGENT_ENV.ptyId]: ptyId })
    const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH'
    if (env[AGENT_ENV.codexShim]) env[pathKey] = env[AGENT_ENV.codexShim] + delimiter + (env[pathKey] ?? '')
    let proc: IPty
    try { proc = spawn(shell, req.args ?? [], {
      name: 'xterm-256color',
      cols: req.cols > 0 ? req.cols : 80,
      rows: req.rows > 0 ? req.rows : 24,
      cwd: req.cwd || homeDir(),
      // Reserved IDs bind hooks to this exact terminal generation.
      env,
    }) } catch (error) {
      for (const sink of this.sinks.values()) {
        try { sink.onExit(ptyId, req.paneId, -1, { current: false, natural: false }) } catch { /* release prepared integrations */ }
      }
      throw error
    }

    const entry: Entry = {
      pty: proc,
      paneId: req.paneId,
      buf: [],
      timer: null,
      history: [],
      historyBytes: 0,
      historyTruncated: false,
      modes: new ModeTracker(),
      shellKind: resolved.shellKind,
      spawnCwd: req.cwd || homeDir(),
      killing: false,
      active: true,
      setupActive: false,
      cancelled: false,
      scratch: '',
      onChunk: null,
      setupResolve: null,
      setupTimer: null,
      writeQueue: '',
      writeTimer: null,
      mirror: null,
      mirrorFailed: false,
      dirty: false,
      gen: 0,
      snapCache: null,
    }
    for (let i = 0; i < seed.length; i += SEED_CHUNK) this.pushHistory(entry, seed.slice(i, i + SEED_CHUNK))
    this.entries.set(ptyId, entry)
    this.byPane.set(req.paneId, ptyId)
    // 'auto' with persistence keeps a mirror from the spawn (E6-FR-01), and so
    // does any spawn with a seed outside 'off' (E6-FR-11/19): it takes the
    // whole seed, which the 256 KB ring may already have cut. Before the sinks
    // hear of the pty, so a phone's replay already comes from it.
    if (this.mirrorAtSpawn() || (seed && this.engine.snapshotMode !== 'off')) this.ensureMirror(ptyId, entry, seed)
    // A respawn supersedes whatever the previous pty left (E6-FR-20).
    this.exited.delete(req.paneId)
    for (const sink of this.sinks.values()) {
      try {
        sink.onSpawn(ptyId, req.paneId)
      } catch {
        /* a sink must never break a spawn */
      }
    }
    // byPane gained a pane: let remote re-broadcast so its `running` dot flips.
    this.onRunningChange?.()

    const initial = req.initialCommand?.trim()
    if (req.setup && req.setup.length > 0) {
      // Drive the expect/send sequence (e.g. SSH login), then type the model.
      void this.runSetup(entry, req.setup, initial)
    } else if (initial) {
      // No setup: original behavior, type the model command once the shell has
      // settled. A bare CR is exactly what pressing Enter sends; CRLF makes
      // PowerShell emit a spurious ">>" continuation.
      entry.setupTimer = setTimeout(() => {
        entry.setupTimer = null
        if (entry.cancelled) return
        try {
          proc.write(initial + '\r')
        } catch {
          /* pty may have exited */
        }
      }, SHELL_SETTLE_MS)
    }

    proc.onData((data) => {
      entry.buf.push(data)
      this.pushHistory(entry, data)
      entry.modes.feed(data)
      if (entry.setupActive) {
        // Feed the setup runner the same bytes the renderer sees, in order.
        entry.scratch += data
        if (entry.scratch.length > SCRATCH_CAP) entry.scratch = entry.scratch.slice(-SCRATCH_CAP)
        entry.onChunk?.()
      }
      if (entry.timer === null) {
        const fast = entry.active || this.forcedFast.has(entry.paneId)
        entry.timer = setTimeout(() => this.flush(ptyId), fast ? FLUSH_MS : HIDDEN_FLUSH_MS)
      }
    })

    proc.onExit(({ exitCode, signal }) => {
      this.flush(ptyId)
      this.send(CH.PTY_EXIT, { ptyId, exitCode, signal, natural: !entry.killing } satisfies PtyExitEvt)
      // An exit that kill() caused is not natural, even when node-pty fires it
      // synchronously from inside kill().
      this.dispose(ptyId, exitCode, !entry.killing)
    })

    const res: PtySpawnRes = { ptyId, shellKind: resolved.shellKind }
    if (resolved.warning) res.warning = resolved.warning
    return res
  }

  /** Rebind to a live pty for paneId, returning its id + replay history. */
  reattach(paneId: string): PtyReattachRes | null {
    const ptyId = this.byPane.get(paneId)
    if (!ptyId) return null
    const entry = this.entries.get(ptyId)
    if (!entry) return null
    // Drain anything pending so post-subscribe output isn't a duplicate of replay.
    this.flush(ptyId)
    const replay = this.snapshotReplay(ptyId, entry)
    return { ptyId, replay, cols: entry.pty.cols, rows: entry.pty.rows, shellKind: entry.shellKind }
  }

  /**
   * In-place restart (E6-FR-18/19). The kept output is the dead pty's
   * `exited` record, or the live pty's clean ring; the live one is killed as
   * not natural (phones get no `exit`). The new pty's ring is seeded with
   * output + tail, and the renderer writes only `tail` over what it already
   * shows, so desktop and phone end up identical. Throws when the spawn fails;
   * the output then stays in `exited` for phones.
   */
  restart(req: PtyRestartReq, label: string): PtyRestartRes {
    const { fallbackDefaultShell, ...spawnReq } = req
    if (fallbackDefaultShell) delete spawnReq.shell
    const oldId = this.byPane.get(req.paneId)
    const old = oldId ? this.entries.get(oldId) : undefined
    let content = this.exited.get(req.paneId)?.data ?? ''
    let cols = req.cols, rows = req.rows, exitCode = this.exited.get(req.paneId)?.exitCode ?? -1
    if (oldId && old) {
      this.flush(oldId)
      content = this.keptOutput(old)
      cols = old.pty.cols
      rows = old.pty.rows
      old.killing = true
      try {
        old.pty.kill()
      } catch {
        /* already gone */
      }
      this.dispose(oldId, 0, false)
    }
    const tail = restartTail(label)
    try {
      const res = this.spawnSeeded(spawnReq, content + tail)
      const out: PtyRestartRes = { ptyId: res.ptyId, tail, shellKind: res.shellKind }
      if (res.warning) out.warning = res.warning
      return out
    } catch (error) {
      // Nothing is bound to the pane now: keep its output visible to phones.
      if (content && !this.exited.has(req.paneId)) {
        this.exited.set(req.paneId, { ptyId: oldId ?? '', data: content, cols, rows, exitCode, at: Date.now() })
        this.onRunningChange?.()
      }
      throw error
    }
  }

  /**
   * What a restart or an exited replay shows, + SOFT_RESET: the mirror's normal
   * buffer when there is one (E6-FR-19), else the clean ring (head trimmed,
   * queries removed).
   */
  private keptOutput(entry: Entry): string {
    if (entry.mirror) {
      try {
        const t0 = nowMs()
        const snap = entry.mirror.snapshot({ scrollback: mirrorScrollback(this.engine), purpose: 'persist' })
        this.snapshotMs.add(nowMs() - t0)
        return snap.data + SOFT_RESET
      } catch (error) {
        this.dropMirror(entry, error)
      }
    }
    return sanitizeQueries(trimRingHead(entry.history.join(''), entry.historyTruncated)) + SOFT_RESET
  }

  /** Last output of a pane whose pty ended on its own, or null (E6-FR-20). */
  getExited(paneId: string): ExitedPane | null {
    return this.exited.get(paneId) ?? null
  }

  /** paneId -> exit code of every pane whose pty ended on its own (E6-FR-38). */
  exitedPaneCodes(): Map<string, number> {
    return new Map([...this.exited].map(([paneId, rec]) => [paneId, rec.exitCode]))
  }

  /**
   * Replay text for a fresh terminal (E6-FR-33): the modes still active that may
   * have scrolled out of the ring, then the ring with a clean head and without
   * the queries a receiving xterm would answer into the live shell.
   */
  private replayOf(entry: Entry): string {
    const body = sanitizeQueries(trimRingHead(entry.history.join(''), entry.historyTruncated))
    // The body is a suffix of the stream: when it enters the alt screen itself,
    // that is the last alt transition, so the prefix must not do it earlier.
    return entry.modes.rehydrate(!ALT_ENTER_RE.test(body)) + body
  }

  write(ptyId: string, data: string): void {
    const entry = this.entries.get(ptyId)
    if (!entry || !data) return
    this.lastInput.set(entry.paneId, Date.now())
    // Fast path: a small write with nothing queued goes straight to the pty so
    // interactive typing keeps zero added latency.
    if (entry.writeQueue.length === 0 && data.length <= WRITE_CHUNK) {
      try {
        entry.pty.write(data)
      } catch {
        /* pty may have exited */
      }
      return
    }
    // Large input, or input arriving behind a backlog: queue it and drain in
    // capped, paced chunks. Appending preserves byte order against whatever is
    // already queued.
    entry.writeQueue += data
    this.drainWrites(ptyId)
  }

  /** Drain an entry's writeQueue to its pty, one capped chunk per pace tick. */
  private drainWrites(ptyId: string): void {
    const entry = this.entries.get(ptyId)
    if (!entry || entry.writeTimer) return
    const pump = (): void => {
      const e = this.entries.get(ptyId)
      if (!e) return
      e.writeTimer = null
      if (e.writeQueue.length === 0) return
      let end = Math.min(WRITE_CHUNK, e.writeQueue.length)
      // Never split a surrogate pair across two writes: node-pty would encode
      // each half on its own, corrupting that character.
      const lead = e.writeQueue.charCodeAt(end - 1)
      if (end > 1 && end < e.writeQueue.length && lead >= 0xd800 && lead <= 0xdbff) end--
      const chunk = e.writeQueue.slice(0, end)
      e.writeQueue = e.writeQueue.slice(end)
      try {
        e.pty.write(chunk)
      } catch {
        e.writeQueue = '' // pty exited: drop the rest
        return
      }
      if (e.writeQueue.length > 0) e.writeTimer = setTimeout(pump, WRITE_PACE_MS)
    }
    pump()
  }

  resize(ptyId: string, cols: number, rows: number): void {
    const entry = this.entries.get(ptyId)
    if (entry && cols > 0 && rows > 0) {
      try {
        entry.pty.resize(cols, rows)
      } catch {
        /* pty may have already exited */
      }
      // The mirror follows every resize, phone-fit included (E6-FR-06).
      if (entry.mirror) {
        try {
          entry.mirror.resize(cols, rows)
        } catch (error) {
          this.dropMirror(entry, error)
        }
        entry.gen++
      }
    }
  }

  kill(ptyId: string): void {
    const entry = this.entries.get(ptyId)
    if (!entry) {
      // The renderer kills a dead pty's id when its pane goes away: drop the
      // output kept for that pane (E6-FR-20), unless a newer exit replaced it.
      for (const [paneId, rec] of this.exited) {
        if (rec.ptyId !== ptyId) continue
        this.exited.delete(paneId)
        this.onRunningChange?.()
      }
      return
    }
    entry.killing = true
    try {
      entry.pty.kill()
    } catch {
      /* already gone */
    }
    this.dispose(ptyId, 0, false)
  }

  killAll(): void {
    // Drain buffered output before tearing down so the last bytes aren't lost.
    for (const id of [...this.entries.keys()]) {
      this.flush(id)
      this.kill(id)
    }
  }

  /**
   * Kill the ptys of these panes by paneId (E4-FR-36): the renderer's
   * registry can be empty after a reload, main's byPane never is. A pane that
   * goes away also drops the output kept for its natural exit (E6-FR-20).
   * Returns how many live ptys were killed; unknown panes are a no-op. Every
   * live pty of the pane goes, not only the byPane one: an unmount never
   * kills, so a superseded pty would otherwise outlive its pane.
   */
  killPanes(paneIds: string[]): number {
    const gone = new Set(paneIds)
    let killed = 0
    for (const [ptyId, entry] of [...this.entries]) {
      if (!gone.has(entry.paneId)) continue
      this.kill(ptyId)
      killed++
    }
    for (const paneId of gone) if (this.exited.delete(paneId)) this.onRunningChange?.()
    return killed
  }

  /**
   * After the renderer hydrates (E4-FR-36): kill every pty whose pane is no
   * longer in the store (deleted while the UI was gone, or a config that lost
   * it), and forget exit records of panes that no longer exist.
   */
  reconcile(livePaneIds: string[]): number {
    const live = new Set(livePaneIds)
    const known = new Set(this.exited.keys())
    for (const entry of this.entries.values()) known.add(entry.paneId)
    const gone = [...known].filter((id) => !live.has(id))
    return this.killPanes(gone)
  }

  /** Mark which panes are in the visible workspace; others throttle output. */
  setActive(paneIds: string[]): void {
    const activeSet = new Set(paneIds)
    for (const [ptyId, entry] of this.entries) {
      const nowActive = activeSet.has(entry.paneId)
      const wasActive = entry.active
      entry.active = nowActive
      // On reveal, paint whatever was buffered while hidden, immediately.
      if (nowActive && !wasActive) this.flush(ptyId)
    }
  }

  /** Backpressure: pause/resume a pty when the renderer can't keep up. */
  setFlow(ptyId: string, pause: boolean): void {
    const entry = this.entries.get(ptyId)
    if (!entry) return
    try {
      if (pause) {
        entry.pty.pause()
        this.pausedByRenderer.add(ptyId)
      } else {
        entry.pty.resume()
        this.pausedByRenderer.delete(ptyId)
      }
    } catch {
      /* pty may have exited */
    }
  }

  /**
   * Resume every pty paused by renderer backpressure. Called when the renderer
   * goes away (reload / crash) so remote viewers aren't starved forever by a
   * pause that will never be lifted.
   */
  resumeRendererPaused(): void {
    for (const ptyId of [...this.pausedByRenderer]) this.setFlow(ptyId, false)
  }

  /** Register an extra output listener (remote-control sessions). */
  addSink(sink: PtySink): void {
    this.sinks.set(sink.id, sink)
  }

  removeSink(id: string): void {
    this.sinks.delete(id)
  }

  /**
   * Replace the set of panes remote viewers are watching. Those panes flush at
   * the fast cadence even when their desktop pane is hidden; panes that just
   * became fast flush immediately (mirror of the reveal flush in setActive).
   */
  setForcedFast(paneIds: Iterable<string>): void {
    const next = new Set(paneIds)
    const newlyFast = [...next].filter((paneId) => !this.forcedFast.has(paneId))
    this.forcedFast.clear()
    for (const paneId of next) this.forcedFast.add(paneId)
    for (const paneId of newlyFast) {
      const ptyId = this.byPane.get(paneId)
      if (ptyId) this.flush(ptyId)
    }
  }

  /** cwd node-pty got for the pane's live pty (E5 spawnCwd), or undefined. */
  getSpawnCwd(paneId: string): string | undefined {
    const ptyId = this.byPane.get(paneId)
    return ptyId ? this.entries.get(ptyId)?.spawnCwd : undefined
  }

  /** Epoch ms of the last input written to the pane (desktop or phone), or undefined. */
  lastInputAt(paneId: string): number | undefined {
    return this.lastInput.get(paneId)
  }

  /** Live pty id bound to a pane, or null. */
  ptyIdForPane(paneId: string): string | null {
    return this.byPane.get(paneId) ?? null
  }

  /** Pane ids that currently have a live pty (drives snapshot `running`). */
  runningPaneIds(): string[] {
    return [...this.byPane.keys()]
  }

  /**
   * Initial screen for a new remote subscriber: drain pending output to the
   * current listeners first (so the ring is the exact prefix of what follows),
   * then return the replay (replayOf) + live size. Callers must add their subscription in
   * the same synchronous block to avoid a gap or overlap with live `out` data.
   */
  getReplay(paneId: string): { ptyId: string; replay: string; cols: number; rows: number } | null {
    const ptyId = this.byPane.get(paneId)
    if (!ptyId) return null
    const entry = this.entries.get(ptyId)
    if (!entry) return null
    this.flush(ptyId)
    const replay = this.snapshotReplay(ptyId, entry)
    return { ptyId, replay, cols: entry.pty.cols, rows: entry.pty.rows }
  }

  // --- Headless mirror (E6-FR-01..07, FR-35) ---------------------------------

  /**
   * Applies the engine settings pushed by the renderer (and read from the
   * config at startup). 'off' drops every mirror; 'auto' with persistence gives
   * every live pty one; Unicode and the scrollback size reach the live mirrors.
   */
  setEngine(raw: unknown): void {
    const next = normalizeEngine(raw)
    this.engine = next
    for (const [ptyId, entry] of this.entries) {
      if (next.snapshotMode === 'off') {
        if (entry.mirror) this.disposeMirror(entry)
        continue
      }
      if (!entry.mirror && this.mirrorAtSpawn()) this.ensureMirror(ptyId, entry)
      if (!entry.mirror) continue
      try {
        entry.mirror.setUnicode(next.unicode11)
        entry.mirror.setScrollback(mirrorScrollback(next))
        entry.gen++
      } catch (error) {
        this.dropMirror(entry, error)
      }
    }
    this.syncDebugTimer()
  }

  /** The engine settings in force (normalized). */
  getEngine(): TerminalEngineSettings {
    return { ...this.engine }
  }

  /** Instrumentation for AppMetrics.headless (E6-FR-07). */
  headlessMetrics(): HeadlessMetrics {
    let panes = 0
    for (const entry of this.entries.values()) if (entry.mirror) panes++
    return {
      panes,
      parseMsP95: this.parseMs.p95(),
      snapshotMsP95: this.snapshotMs.p95(),
      bytesParsed: this.bytesParsed,
      snapshotCacheHits: this.snapshotCacheHits,
    }
  }

  /** 'auto' creates the mirror at spawn while persistence is on; otherwise on the first replay. */
  private mirrorAtSpawn(): boolean {
    return this.engine.snapshotMode === 'auto' && this.engine.persist
  }

  /**
   * Creates the pty's mirror if the mode allows it, seeded with `seed` when
   * given, else with what a ring replay would show (mode rehydration first,
   * then the clean ring, E6-FR-02/33). Pending output is flushed first so the
   * ring and the mirror never both get the same bytes.
   */
  private ensureMirror(ptyId: string, entry: Entry, seed?: string): HeadlessMirror | null {
    if (entry.mirror || entry.mirrorFailed || this.engine.snapshotMode === 'off') return entry.mirror
    if (seed === undefined) this.flush(ptyId)
    try {
      const mirror = new HeadlessMirror({
        cols: entry.pty.cols > 0 ? entry.pty.cols : 80,
        rows: entry.pty.rows > 0 ? entry.pty.rows : 24,
        scrollback: mirrorScrollback(this.engine),
        unicode11: this.engine.unicode11,
      })
      entry.mirror = mirror
      const initial = seed ?? this.replayOf(entry)
      if (initial) this.writeMirror(entry, initial)
      entry.gen++
      entry.snapCache = null
    } catch (error) {
      this.dropMirror(entry, error)
    }
    return entry.mirror
  }

  /** Feeds the mirror, timing the parse (writeSync is synchronous). */
  private writeMirror(entry: Entry, data: string): void {
    const mirror = entry.mirror
    if (!mirror) return
    const t0 = nowMs()
    mirror.write(data)
    this.parseMs.add(nowMs() - t0)
    this.bytesParsed += data.length
  }

  /**
   * The replay for a fresh terminal: the mirror's snapshot (cached while no
   * output arrived), or the ring replay in 'off' and after a mirror failure.
   */
  private snapshotReplay(ptyId: string, entry: Entry): string {
    const mirror = this.ensureMirror(ptyId, entry)
    if (mirror) {
      if (entry.snapCache && entry.snapCache.gen === entry.gen) {
        this.snapshotCacheHits++
        return entry.snapCache.data
      }
      try {
        const t0 = nowMs()
        const { data } = mirror.snapshot({ scrollback: REPLAY_LINES, purpose: 'replay' })
        this.snapshotMs.add(nowMs() - t0)
        entry.snapCache = { gen: entry.gen, data }
        return data
      } catch (error) {
        this.dropMirror(entry, error)
      }
    }
    return this.replayOf(entry)
  }

  private disposeMirror(entry: Entry): void {
    const mirror = entry.mirror
    entry.mirror = null
    entry.snapCache = null
    try {
      mirror?.dispose()
    } catch {
      /* already torn down */
    }
  }

  /** A mirror that threw: back to ring + ModeTracker for this pty, logged once. */
  private dropMirror(entry: Entry, error: unknown): void {
    this.disposeMirror(entry)
    if (!entry.mirrorFailed) console.warn(`[pty] headless mirror failed for pane ${entry.paneId}, using the raw ring: ${String(error)}`)
    entry.mirrorFailed = true
  }

  /** SNAOS_DEBUG_TERMINAL=1 prints the headless metrics to main's console while mirrors are on. */
  private syncDebugTimer(): void {
    const want = process.env.SNAOS_DEBUG_TERMINAL === '1' && this.engine.snapshotMode !== 'off'
    if (want && !this.debugTimer) {
      this.debugTimer = setInterval(() => console.log('[pty] headless', JSON.stringify(this.headlessMetrics())), DEBUG_METRICS_MS)
      this.debugTimer.unref?.()
    } else if (!want && this.debugTimer) {
      clearInterval(this.debugTimer)
      this.debugTimer = null
    }
  }

  /**
   * Runs an expect/send sequence on a freshly spawned pty, then types the model
   * command. Each step optionally waits for the terminal to print `waitFor`
   * (with a timeout fallback) before sending its text, so an interactive
   * prompt like "password:" is answered automatically. Lives in main so it
   * survives renderer remounts and reads the same byte stream as the terminal.
   */
  private async runSetup(entry: Entry, steps: SetupStep[], initialCommand?: string): Promise<void> {
    entry.setupActive = true
    try {
      // Let the shell print its first prompt before we touch it.
      await sleep(SHELL_SETTLE_MS)
      for (const step of steps) {
        if (entry.cancelled) return
        if (step.waitFor && step.waitFor.trim()) {
          await this.waitForOutput(entry, step.waitFor.trim(), step.timeoutMs ?? DEFAULT_WAIT_MS)
        }
        if (entry.cancelled) return
        await sleep(step.delayMs ?? 120)
        if (entry.cancelled) return
        try {
          entry.pty.write(step.noEnter ? step.send : step.send + '\r')
        } catch {
          return // pty exited mid-sequence
        }
        // Only match the response to THIS step against the next waitFor.
        entry.scratch = ''
      }
      if (initialCommand) {
        if (entry.cancelled) return
        // Give the post-setup shell (often a remote one) a beat to be ready.
        await sleep(steps.length ? 400 : SHELL_SETTLE_MS)
        if (entry.cancelled) return
        try {
          entry.pty.write(initialCommand + '\r')
        } catch {
          /* pty exited */
        }
      }
    } finally {
      entry.setupActive = false
      entry.onChunk = null
      entry.scratch = ''
    }
  }

  /** Resolves when `entry.scratch` matches `pattern`, or after `timeoutMs`. */
  private waitForOutput(entry: Entry, pattern: string, timeoutMs: number): Promise<void> {
    const matches = buildMatcher(pattern)
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        if (entry.setupTimer) {
          clearTimeout(entry.setupTimer)
          entry.setupTimer = null
        }
        entry.onChunk = null
        entry.setupResolve = null
        resolve()
      }
      if (entry.cancelled || matches(entry.scratch)) {
        finish()
        return
      }
      entry.setupResolve = finish
      entry.setupTimer = setTimeout(finish, timeoutMs)
      entry.onChunk = () => {
        if (matches(entry.scratch)) finish()
      }
    })
  }

  private pushHistory(entry: Entry, data: string): void {
    entry.history.push(data)
    entry.historyBytes += data.length
    while (entry.historyBytes > HISTORY_CAP && entry.history.length > 1) {
      const dropped = entry.history.shift()
      if (dropped) entry.historyBytes -= dropped.length
      entry.historyTruncated = true
    }
  }

  private flush(ptyId: string): void {
    const entry = this.entries.get(ptyId)
    if (!entry) return
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    if (entry.buf.length === 0) return
    const data = entry.buf.join('')
    entry.buf = []
    entry.dirty = true
    entry.gen++
    // The mirror parses the burst before any sink sees it (E6-FR-02), so a
    // snapshot taken right after a flush is the exact prefix of what follows.
    if (entry.mirror) {
      try {
        this.writeMirror(entry, data)
      } catch (error) {
        this.dropMirror(entry, error)
      }
    }
    // Sinks get the unsplit burst; MAX_CHUNK framing is an IPC-only concern.
    for (const sink of this.sinks.values()) {
      try {
        sink.onData(ptyId, entry.paneId, data)
      } catch {
        /* a sink must never break renderer delivery */
      }
    }
    if (data.length <= MAX_CHUNK) {
      this.send(CH.PTY_DATA, { ptyId, data } satisfies PtyDataEvt)
      return
    }
    // Oversized burst: split into renderer-digestible frames.
    for (let i = 0; i < data.length; i += MAX_CHUNK) {
      this.send(CH.PTY_DATA, { ptyId, data: data.slice(i, i + MAX_CHUNK) } satisfies PtyDataEvt)
    }
  }

  private dispose(ptyId: string, exitCode: number, natural: boolean): void {
    const entry = this.entries.get(ptyId)
    if (!entry) return
    // Abort any in-flight setup sequence: unblock a pending waiter so its async
    // runner wakes, sees `cancelled`, and returns without writing to a dead pty.
    entry.cancelled = true
    entry.setupActive = false
    entry.onChunk = null
    const resolveWait = entry.setupResolve
    entry.setupResolve = null
    if (resolveWait) resolveWait()
    if (entry.setupTimer) clearTimeout(entry.setupTimer)
    entry.setupTimer = null
    if (entry.timer) clearTimeout(entry.timer)
    if (entry.writeTimer) clearTimeout(entry.writeTimer)
    entry.writeTimer = null
    entry.writeQueue = ''
    this.pausedByRenderer.delete(ptyId)
    const removed = this.byPane.get(entry.paneId) === ptyId
    if (removed) this.byPane.delete(entry.paneId)
    // Keep the last output of a shell that ended on its own (E6-FR-20): phones
    // that subscribe later see it instead of a spinner, and a restart reuses it.
    if (removed && natural) {
      this.exited.set(entry.paneId, { ptyId, data: this.keptOutput(entry), cols: entry.pty.cols, rows: entry.pty.rows, exitCode, at: Date.now() })
    }
    for (const sink of this.sinks.values()) {
      try { sink.onExit(ptyId, entry.paneId, exitCode, { current: removed, natural }) } catch { /* sink teardown must not block PTY cleanup */ }
    }
    this.entries.delete(ptyId)
    // The mirror lives until the pty is gone (E6-FR-01); keptOutput above used it last.
    this.disposeMirror(entry)
    // byPane lost a pane: let remote re-broadcast so its `running` dot clears
    // even on a natural shell exit (which never triggers a renderer state push).
    if (removed) this.onRunningChange?.()
  }

  /**
   * Register a callback fired whenever the live pane->pty table changes (a pty
   * spawns or exits). Remote-control uses it to re-broadcast pane `running`
   * state to phones without waiting on a renderer-driven snapshot push.
   */
  setRunningChangeListener(cb: (() => void) | null): void {
    this.onRunningChange = cb
  }

  private send(channel: string, payload: PtyDataEvt | PtyExitEvt): void {
    const wc = this.getSender()
    if (wc && !wc.isDestroyed()) wc.send(channel, payload)
  }
}
