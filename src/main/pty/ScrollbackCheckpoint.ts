import type { PersistSnapshot, ScrollbackStore } from './ScrollbackStore'

/** Checkpoint cadence (E6-FR-09). */
export const CHECKPOINT_MS = 60_000
/** One pane per tick inside a checkpoint, so main never blocks on all of them at once. */
export const STAGGER_MS = 250
/** Hard budget of the synchronous exit save (E6-FR-10). */
export const EXIT_BUDGET_MS = 1500

/** What the checkpoint reads from PtyManager. */
export interface PersistSource {
  /** Persistence on and the snapshot mode not 'off'. */
  persistEnabled(): boolean
  /** Drains every pty's pending output (the exit save must include the last 8-250 ms). */
  flushAll(): void
  /** Panes (live or exited) with output since their last save. */
  dirtyPaneIds(): string[]
  /** The pane's persist snapshot, clearing its dirty flag; null when there is nothing to save. */
  takePersist(paneId: string): PersistSnapshot | null
  /** A save failed: try again at the next checkpoint. */
  markDirty(paneId: string): void
}

export interface CheckpointTimers {
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
  now: () => number
}

const realTimers: CheckpointTimers = {
  setInterval: (fn, ms) => {
    const t = setInterval(fn, ms)
    t.unref?.()
    return t
  },
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  now: () => Date.now(),
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Drives the saved scrollback: a checkpoint every 60 s (dirty panes only, one
 * per 250 ms tick, async writes) and the synchronous exit save that every
 * exit path calls before the ptys die (X, tray, NSIS installer, Windows
 * session end, macOS/Linux shutdown).
 */
export class ScrollbackCheckpoint {
  private timer: unknown = null
  private running: Promise<void> | null = null
  /** Set by persistOnExit, reset after killAll so the next exit saves again (E6-FR-10). */
  private exitPersisted = false

  constructor(
    private readonly store: ScrollbackStore,
    private readonly source: PersistSource,
    private readonly opts: { intervalMs?: number; staggerMs?: number; budgetMs?: number; timers?: CheckpointTimers; log?: (msg: string) => void } = {},
  ) {}

  private get timers(): CheckpointTimers {
    return this.opts.timers ?? realTimers
  }

  start(): void {
    if (this.timer !== null) return
    this.timer = this.timers.setInterval(() => void this.runOnce(), this.opts.intervalMs ?? CHECKPOINT_MS)
  }

  stop(): void {
    if (this.timer === null) return
    this.timers.clearInterval(this.timer)
    this.timer = null
  }

  /** One checkpoint: every dirty pane, staggered. A checkpoint still running is joined. */
  runOnce(): Promise<void> {
    if (this.running) return this.running
    const run = (async () => {
      if (!this.source.persistEnabled()) return
      const stagger = this.opts.staggerMs ?? STAGGER_MS
      const ids = this.source.dirtyPaneIds()
      for (let i = 0; i < ids.length; i++) {
        if (i > 0 && stagger > 0) await wait(stagger)
        if (!this.source.persistEnabled()) return
        const paneId = ids[i]
        let snap: PersistSnapshot | null = null
        try {
          snap = this.source.takePersist(paneId)
        } catch (error) {
          this.opts.log?.(`[scrollback] snapshot failed for ${paneId}: ${String(error)}`)
        }
        if (!snap) continue
        if (!(await this.store.save(paneId, snap, this.timers.now()))) this.source.markDirty(paneId)
      }
    })()
    this.running = run
    void run.finally(() => {
      this.running = null
    })
    return run
  }

  /**
   * Exit save (E6-FR-10): flush every pty, then write the dirty panes (live
   * and exited) synchronously until the 1500 ms budget runs out; the panes
   * left keep their last checkpoint. Does not touch the exit flag, so the
   * installer path can call it and a cancelled wizard still saves on quit.
   */
  persistAllSync(): { saved: number; skipped: number; ms: number } {
    const t0 = this.timers.now()
    if (!this.source.persistEnabled()) return { saved: 0, skipped: 0, ms: 0 }
    const budget = this.opts.budgetMs ?? EXIT_BUDGET_MS
    try {
      this.source.flushAll()
    } catch {
      /* a broken pty must not cost the others their save */
    }
    const ids = this.source.dirtyPaneIds()
    let saved = 0
    let i = 0
    for (; i < ids.length; i++) {
      if (this.timers.now() - t0 >= budget) break
      try {
        const snap = this.source.takePersist(ids[i])
        if (snap && this.store.saveSync(ids[i], snap, this.timers.now())) saved++
        else if (snap) this.source.markDirty(ids[i])
      } catch (error) {
        this.opts.log?.(`[scrollback] exit save failed for ${ids[i]}: ${String(error)}`)
      }
    }
    const ms = this.timers.now() - t0
    if (i < ids.length) this.opts.log?.(`[scrollback] exit save hit its ${budget} ms budget, ${ids.length - i} pane(s) keep their last checkpoint`)
    return { saved, skipped: ids.length - i, ms }
  }

  /** The exit paths' entry: saves once per exit, until resetExit(). */
  persistOnExit(): boolean {
    if (this.exitPersisted) return false
    this.exitPersisted = true
    this.persistAllSync()
    return true
  }

  /** After killAll(): the next exit (a new macOS window, a cancelled shutdown) saves again. */
  resetExit(): void {
    this.exitPersisted = false
  }
}
