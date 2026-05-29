import { spawn, type IPty } from 'node-pty'
import type { WebContents } from 'electron'
import { CH } from '@shared/ipc-channels'
import type { PtyDataEvt, PtyExitEvt, PtySpawnReq } from '@shared/ipc-contract'
import { cleanEnv, defaultShell, homeDir } from './shellResolver'

interface Entry {
  pty: IPty
  /** Coalescing buffer for output before it is flushed over IPC. */
  buf: string
  timer: ReturnType<typeof setTimeout> | null
}

/** Output is coalesced and flushed at ~120Hz to collapse IPC chatter. */
const FLUSH_MS = 8

/**
 * Owns every node-pty instance. The renderer never touches native modules;
 * it drives ptys exclusively through this manager via IPC.
 */
export class PtyManager {
  private readonly entries = new Map<string, Entry>()
  private seq = 0

  constructor(private readonly getSender: () => WebContents | null) {}

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

    const entry: Entry = { pty: proc, buf: '', timer: null }
    this.entries.set(ptyId, entry)

    proc.onData((data) => {
      entry.buf += data
      if (entry.timer === null) {
        entry.timer = setTimeout(() => this.flush(ptyId), FLUSH_MS)
      }
    })

    proc.onExit(({ exitCode, signal }) => {
      this.flush(ptyId)
      this.send(CH.PTY_EXIT, { ptyId, exitCode, signal } satisfies PtyExitEvt)
      this.dispose(ptyId)
    })

    return ptyId
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
    for (const id of [...this.entries.keys()]) this.kill(id)
  }

  private flush(ptyId: string): void {
    const entry = this.entries.get(ptyId)
    if (!entry) return
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    if (entry.buf.length === 0) return
    const data = entry.buf
    entry.buf = ''
    this.send(CH.PTY_DATA, { ptyId, data } satisfies PtyDataEvt)
  }

  private dispose(ptyId: string): void {
    const entry = this.entries.get(ptyId)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    this.entries.delete(ptyId)
  }

  private send(channel: string, payload: PtyDataEvt | PtyExitEvt): void {
    const wc = this.getSender()
    if (wc && !wc.isDestroyed()) wc.send(channel, payload)
  }
}
