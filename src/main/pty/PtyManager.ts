import { spawn, type IPty } from 'node-pty'
import type { WebContents } from 'electron'
import { CH } from '@shared/ipc-channels'
import type { PtyDataEvt, PtyExitEvt, PtyReattachRes, PtySpawnReq } from '@shared/ipc-contract'
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
}

/** Output is coalesced and flushed at ~120Hz for the visible workspace. */
const FLUSH_MS = 8
/** Hidden workspaces flush far slower — their xterms can't paint anyway. */
const HIDDEN_FLUSH_MS = 250
/** Cap on a single IPC payload (split larger bursts across frames). */
const MAX_CHUNK = 256 * 1024
/** Replay ring-buffer size per pty. */
const HISTORY_CAP = 256 * 1024

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
    }
    this.entries.set(ptyId, entry)
    this.byPane.set(req.paneId, ptyId)

    if (req.initialCommand && req.initialCommand.trim()) {
      // Terminate with a bare CR — exactly what pressing Enter sends in a
      // terminal. CRLF makes PowerShell emit a spurious ">>" continuation.
      // Small delay so the shell finishes initializing before we feed input.
      setTimeout(() => {
        try {
          proc.write(req.initialCommand!.trim() + '\r')
        } catch {
          /* pty may have exited */
        }
      }, 350)
    }

    proc.onData((data) => {
      entry.buf.push(data)
      this.pushHistory(entry, data)
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
    this.entries.get(ptyId)?.pty.write(data)
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
    if (entry.timer) clearTimeout(entry.timer)
    if (this.byPane.get(entry.paneId) === ptyId) this.byPane.delete(entry.paneId)
    this.entries.delete(ptyId)
  }

  private send(channel: string, payload: PtyDataEvt | PtyExitEvt): void {
    const wc = this.getSender()
    if (wc && !wc.isDestroyed()) wc.send(channel, payload)
  }
}
