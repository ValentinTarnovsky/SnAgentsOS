/**
 * Phone-fit state of the desktop panes (E3 M11, FR-17/18/23). Main's
 * FitController decides the owner; the executor (remoteCommands) mirrors it
 * here, so a terminal that mounts later (another workspace, a remount, a
 * reload) reads the owner before its first fit instead of fighting it.
 *
 * - `owners`: panes a phone sizes (cols/rows of the phone grid; `chat` = the
 *   owner reads it as Chat, FR-21). Reactive: the strip and useXterm follow it.
 * - baselines: the size each pane would have on the desktop, refreshed by
 *   every fit (and measured, not applied, while a phone owns it). A plain map,
 *   never reactive: a window drag would otherwise re-render on every frame.
 */
import { create } from 'zustand'

export interface FitSize {
  cols: number
  rows: number
}

export interface FitOwnerEntry extends FitSize {
  chat: boolean
}

interface FitStoreState {
  owners: Record<string, FitOwnerEntry>
  setOwner: (paneId: string, entry: FitOwnerEntry) => void
  clearOwner: (paneId: string) => void
  clearAll: () => void
}

export const useFitStore = create<FitStoreState>((set) => ({
  owners: {},
  setOwner: (paneId, entry) =>
    set((s) => {
      const cur = s.owners[paneId]
      if (cur && cur.cols === entry.cols && cur.rows === entry.rows && cur.chat === entry.chat) return s
      return { owners: { ...s.owners, [paneId]: { cols: entry.cols, rows: entry.rows, chat: entry.chat } } }
    }),
  clearOwner: (paneId) =>
    set((s) => {
      if (!s.owners[paneId]) return s
      const owners = { ...s.owners }
      delete owners[paneId]
      return { owners }
    }),
  clearAll: () => set((s) => (Object.keys(s.owners).length ? { owners: {} } : s)),
}))

/** The phone grid of a pane, or null when the desktop owns its size. */
export function fitOwnerOf(paneId: string): FitOwnerEntry | null {
  return useFitStore.getState().owners[paneId] ?? null
}

const baselines = new Map<string, FitSize>()

export function setFitBaseline(paneId: string, size: FitSize): void {
  if (size.cols > 0 && size.rows > 0) baselines.set(paneId, { cols: size.cols, rows: size.rows })
}

export function fitBaselineOf(paneId: string): FitSize | null {
  return baselines.get(paneId) ?? null
}

/** A real key or paste asks at most this often per pane and owner (E3 M11). */
export const FIT_RELEASE_THROTTLE_MS = 500
const lastAsk = new Map<string, { at: number; owner: FitOwnerEntry }>()

/**
 * Give a phone-sized pane back to the desktop from the desktop itself: the
 * strip's [Recover], a real keydown or a paste (E3-FR-17/19). Main hears it
 * first (so the resize that follows is reported as the desktop's), then the
 * local owner clears and the terminal refits synchronously, before the key is
 * written. Main's releaseFit coming back is idempotent here. False when no
 * phone owned the pane. The throttle only skips a repeat for the same owner:
 * a phone that claimed the pane again inside 500ms must reach main too, or
 * main would keep an owner the desktop already dropped.
 */
export function releaseFitFromDesktop(paneId: string, now: number = Date.now()): boolean {
  const owner = fitOwnerOf(paneId)
  if (!owner) return false
  const last = lastAsk.get(paneId)
  if (!last || last.owner !== owner || now - last.at >= FIT_RELEASE_THROTTLE_MS) {
    lastAsk.set(paneId, { at: now, owner })
    window.snApi.remote.fitRelease({ paneId })
  }
  useFitStore.getState().clearOwner(paneId)
  return true
}

/** [Restore all] on the strip: every phone-sized pane, here and in main. */
export function releaseAllFitsFromDesktop(): void {
  window.snApi.remote.fitRelease({ all: true })
  useFitStore.getState().clearAll()
}

/** The desktop font never goes below this to fit a phone grid (E3-FR-17). */
export const FIT_MIN_FONT = 6

export interface FitGeometry {
  /** Font for the phone grid: the largest that fits, never above normal nor below 6. */
  fontSize: number
  /** The grid fits at that font; false = the terminal area scrolls. */
  fits: boolean
  /** Cols/rows the pane would have at its normal font (the desktop baseline). */
  baseline: FitSize
}

/**
 * Pure geometry of a phone-sized pane (E3-FR-17/18): with `cell` measured at
 * `normalFont` (a cell scales linearly with the font), the font that fits
 * `grid` into `avail`, and the baseline the pane would take back. Exported
 * for tests.
 */
export function fitGeometry(grid: FitSize, avail: { w: number; h: number }, cell: { w: number; h: number }, normalFont: number): FitGeometry {
  const baseline = {
    cols: Math.max(2, Math.floor(avail.w / cell.w)),
    rows: Math.max(1, Math.floor(avail.h / cell.h)),
  }
  const ratio = Math.min(avail.w / (grid.cols * cell.w), avail.h / (grid.rows * cell.h))
  const fontSize = Math.max(FIT_MIN_FONT, Math.min(normalFont, Math.floor(normalFont * ratio)))
  const scale = fontSize / normalFont
  const fits = grid.cols * cell.w * scale <= avail.w + 0.5 && grid.rows * cell.h * scale <= avail.h + 0.5
  return { fontSize, fits, baseline }
}
