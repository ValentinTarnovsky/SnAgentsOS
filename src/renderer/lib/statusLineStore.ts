import { create } from 'zustand'

/**
 * `snaos status "<text>"` lines (E8-FR-19): transient, never persisted, one
 * per console. Main clears a line when the console's pty is replaced
 * (restart) or ends (closed), so this store only mirrors what main asked for.
 */
interface StatusLineState {
  lines: Record<string, string>
  setLine: (paneId: string, text: string | null) => void
}

export const useStatusLines = create<StatusLineState>((set) => ({
  lines: {},
  setLine: (paneId, text) =>
    set((s) => {
      if (text === null) {
        if (!(paneId in s.lines)) return {}
        const lines = { ...s.lines }
        delete lines[paneId]
        return { lines }
      }
      if (s.lines[paneId] === text) return {}
      return { lines: { ...s.lines, [paneId]: text } }
    }),
}))
