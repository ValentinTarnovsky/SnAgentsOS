/**
 * The exit strip of the viewed console (E6-FR-20): set by an `exit` frame or
 * by a `replay` of a pane whose shell already ended (`exitCode`), cleared by
 * the next replay that brings `running: true` (restart) or by switching panes.
 * Kept apart from the main store: it only feeds the strip and the Home rows.
 */
import { create } from 'zustand'
import type { TermFrame } from './client'

export interface PaneExit {
  paneId: string
  exitCode: number
}

interface ExitStore {
  exit: PaneExit | null
  setExit: (exit: PaneExit | null) => void
}

export const useExitStore = create<ExitStore>((set) => ({
  exit: null,
  setExit: (exit) => set({ exit }),
}))

/** Strip state after `frame` arrives for the viewed `paneId` (pure). */
export function nextExit(current: PaneExit | null, paneId: string | null, frame: TermFrame): PaneExit | null {
  if (!paneId) return null
  if (frame.type === 'exit') return { paneId, exitCode: frame.exitCode }
  if (frame.type === 'replay') {
    // A replay without exitCode and not running is a lazy spawn still pending.
    return !frame.running && frame.exitCode !== undefined ? { paneId, exitCode: frame.exitCode } : null
  }
  return current?.paneId === paneId ? current : null
}
