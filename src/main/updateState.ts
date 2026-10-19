import type { UpdateInfo, UpdatePhase, UpdateProgress, UpdateState } from '@shared/ipc-contract'

/** Phases where a download/apply is running: close is blocked and checks are ignored. */
export function isUpdateBusy(phase: UpdatePhase): boolean {
  return phase === 'downloading' || phase === 'installing'
}

/**
 * main's self-update state (E4-FR-37). It outlives the renderer, so a window
 * reload mid-download rehydrates the phase and the live percent from here.
 * Listeners fire on every phase change (and on a fresh check result); download
 * progress alone only updates the stored value, it streams on its own channel.
 */
export class UpdateStateStore {
  private state: UpdateState = { phase: 'idle', progress: null, installError: null, info: null }
  private readonly listeners = new Set<(s: UpdateState) => void>()

  get(): UpdateState {
    return this.state
  }

  get busy(): boolean {
    return isUpdateBusy(this.state.phase)
  }

  onChange(cb: (s: UpdateState) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  /**
   * A check finished. Ignored while a download/apply runs (the running install
   * keeps its info). A failed check keeps the phase and the last good info, so
   * 'available' never pairs with an error result that says nothing is
   * available; a good one moves between 'available' and 'idle' and clears a
   * previous install outcome.
   */
  checked(info: UpdateInfo): void {
    if (this.busy) return
    if (info.error) {
      if (!this.state.info) this.set({ ...this.state, info })
      return
    }
    this.set({ phase: info.available ? 'available' : 'idle', progress: null, installError: null, info })
  }

  /** An install started: the download begins at 0%. */
  begin(): void {
    this.set({ ...this.state, phase: 'downloading', progress: { percent: 0, transferred: 0, total: 0 }, installError: null })
  }

  /** Download progress; reaching 100% while still applying is 'installing'. */
  progress(p: UpdateProgress): void {
    if (!this.busy) return
    if (p.percent >= 100 && this.state.phase === 'downloading') {
      this.set({ ...this.state, phase: 'installing', progress: p })
      return
    }
    this.state = { ...this.state, progress: p }
  }

  /** The apply step resolved: relaunching keeps 'installing' (the app quits), else 'opened'. */
  installed(relaunching: boolean): void {
    this.set({ ...this.state, phase: relaunching ? 'installing' : 'opened' })
  }

  /** The download/apply failed with `error` (MISSING_CHECKSUM stays a bare code). */
  failed(error: string): void {
    this.set({ ...this.state, phase: 'failed', installError: error })
  }

  private set(next: UpdateState): void {
    this.state = next
    for (const cb of this.listeners) {
      try {
        cb(next)
      } catch {
        /* a listener must not break the update flow */
      }
    }
  }
}

/** The process-wide update state, shared by updater.ts and the update IPC. */
export const updateState = new UpdateStateStore()
