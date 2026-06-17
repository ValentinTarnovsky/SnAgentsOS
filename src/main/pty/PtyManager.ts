import { spawn, type IPty } from 'node-pty'
import type { WebContents } from 'electron'
import { CH } from '@shared/ipc-channels'
import type { PtyDataEvt, PtyExitEvt, PtyReattachRes, PtySpawnReq } from '@shared/ipc-contract'
import type { SetupStep } from '@shared/types'
import { cleanEnv, defaultShell, homeDir } from './shellResolver'

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
/** Recent-output tail kept for setup `waitFor` matching (bounds memory). */
const SCRATCH_CAP = 16 * 1024
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

  constructor(private readonly getSender: () => WebContents | null) {}

  /** Number of live ptys. */
  get count(): number {
    return this.entries.size
  }

  spawn(req: PtySpawnReq): string {
    const ptyId = `pty-${++this.seq}`
    const shell = req.shell || defaultShell()
    const proc = spawn(shell, req.args ?? [], {
      name: 'xterm-256color',
      cols: req.cols > 0 ? req.cols : 80,
      rows: req.rows > 0 ? req.rows : 24,
      cwd: req.cwd || homeDir(),
      env: cleanEnv(req.env),
    })

    const entry: Entry = {
      pty: proc,
      paneId: req.paneId,
      buf: [],
      timer: null,
      history: [],
      historyBytes: 0,
      active: true,
      setupActive: false,
      cancelled: false,
      scratch: '',
      onChunk: null,
      setupResolve: null,
      setupTimer: null,
      writeQueue: '',
      writeTimer: null,
    }
    this.entries.set(ptyId, entry)
    this.byPane.set(req.paneId, ptyId)

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
      if (entry.setupActive) {
        // Feed the setup runner the same bytes the renderer sees, in order.
        entry.scratch += data
        if (entry.scratch.length > SCRATCH_CAP) entry.scratch = entry.scratch.slice(-SCRATCH_CAP)
        entry.onChunk?.()
      }
      if (entry.timer === null) {
        entry.timer = setTimeout(() => this.flush(ptyId), entry.active ? FLUSH_MS : HIDDEN_FLUSH_MS)
      }
    })

    proc.onExit(({ exitCode, signal }) => {
      this.flush(ptyId)
      this.send(CH.PTY_EXIT, { ptyId, exitCode, signal } satisfies PtyExitEvt)
      this.dispose(ptyId)
    })

    return ptyId
  }

  /** Rebind to a live pty for paneId, returning its id + replay history. */
  reattach(paneId: string): PtyReattachRes | null {
    const ptyId = this.byPane.get(paneId)
    if (!ptyId) return null
    const entry = this.entries.get(ptyId)
    if (!entry) return null
    // Drain anything pending so post-subscribe output isn't a duplicate of replay.
    this.flush(ptyId)
    return { ptyId, replay: entry.history.join('') }
  }

  write(ptyId: string, data: string): void {
    const entry = this.entries.get(ptyId)
    if (!entry || !data) return
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
    }
  }

  kill(ptyId: string): void {
    const entry = this.entries.get(ptyId)
    if (!entry) return
    try {
      entry.pty.kill()
    } catch {
      /* already gone */
    }
    this.dispose(ptyId)
  }

  killAll(): void {
    // Drain buffered output before tearing down so the last bytes aren't lost.
    for (const id of [...this.entries.keys()]) {
      this.flush(id)
      this.kill(id)
    }
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
      if (pause) entry.pty.pause()
      else entry.pty.resume()
    } catch {
      /* pty may have exited */
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
    if (data.length <= MAX_CHUNK) {
      this.send(CH.PTY_DATA, { ptyId, data } satisfies PtyDataEvt)
      return
    }
    // Oversized burst: split into renderer-digestible frames.
    for (let i = 0; i < data.length; i += MAX_CHUNK) {
      this.send(CH.PTY_DATA, { ptyId, data: data.slice(i, i + MAX_CHUNK) } satisfies PtyDataEvt)
    }
  }

  private dispose(ptyId: string): void {
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
    if (this.byPane.get(entry.paneId) === ptyId) this.byPane.delete(entry.paneId)
    this.entries.delete(ptyId)
  }

  private send(channel: string, payload: PtyDataEvt | PtyExitEvt): void {
    const wc = this.getSender()
    if (wc && !wc.isDestroyed()) wc.send(channel, payload)
  }
}
