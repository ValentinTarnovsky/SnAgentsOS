/**
 * Font-size solver for the phone terminal.
 *
 * In desktop mode the phone never resizes the pty: the desktop owns the real
 * cols/rows and the phone renders that fixed grid. Instead of an xterm FitAddon
 * we pick a fontSize so `cols` columns fit the viewport width, and if even the
 * minimum size overflows we let the terminal container pan horizontally.
 *
 * JetBrains Mono's advance-width ratio (glyph advance / fontSize) is measured
 * once via canvas measureText and cached, so the solver is a cheap arithmetic
 * clamp we can re-run on every visualViewport resize or replay.
 *
 * Phone mode (E3 M11, FR-14) reverses that per pane: phoneGrid() turns the
 * container and the phone-mode text size into the cols/rows the phone asks
 * the pty for with the fitPane ctl.
 */

import { STORAGE_PREFIX, storageGet, storageSet } from './mobileStorage'

const MIN_FONT = 8
const MAX_FONT = 20
const REF_SIZE = 100
const FONT_FAMILY = "'JetBrains Mono', ui-monospace, monospace"

let cachedRatio = 0

/**
 * Measure the monospace advance-width ratio (advance px per 1px of fontSize).
 * Returns a sane fallback (~0.6, typical for JetBrains Mono) if canvas 2D is
 * unavailable. Re-measure once fonts.ready fires by calling resetRatio().
 */
function advanceRatio(): number {
  if (cachedRatio > 0) return cachedRatio
  try {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return 0.6
    ctx.font = `${REF_SIZE}px ${FONT_FAMILY}`
    // Average over a run of glyphs to smooth any single-glyph rounding.
    const sample = 'MMMMMMMMMMWWWWWWWWWW00000000000mmmmmmmmmm'
    const width = ctx.measureText(sample).width / sample.length
    const ratio = width / REF_SIZE
    if (ratio > 0.3 && ratio < 1.2) cachedRatio = ratio
    return cachedRatio || 0.6
  } catch {
    return 0.6
  }
}

/** Drop the cached ratio so the next solve re-measures (after fonts load). */
export function resetRatio(): void {
  cachedRatio = 0
}

export interface FontSolve {
  /** Chosen font size in px, clamped to [SCALED_MIN_FONT, SCALED_MAX_FONT]. */
  fontSize: number
  /** True when the grid is wider than the viewport => container should pan. */
  overflow: boolean
}

/** Text size presets of the pinch and of Settings (E2-FR-34). */
export const FONT_SCALE_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const
/** Bounds of the final size once the scale applies. */
export const SCALED_MIN_FONT = 6
export const SCALED_MAX_FONT = 32
const FONT_SCALE_KEY = `${STORAGE_PREFIX}fontScale`

/** Nearest preset to a free scale (a pinch release). */
export function snapFontScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1
  let best: number = FONT_SCALE_PRESETS[0]
  for (const p of FONT_SCALE_PRESETS) if (Math.abs(p - scale) < Math.abs(best - scale)) best = p
  return best
}

/** The saved scale ('snagentsos.fontScale'), 1 when missing or not a preset. */
export function loadFontScale(): number {
  const n = Number(storageGet(FONT_SCALE_KEY))
  return (FONT_SCALE_PRESETS as readonly number[]).includes(n) ? n : 1
}

export function saveFontScale(scale: number): void {
  storageSet(FONT_SCALE_KEY, String(scale))
}

/**
 * Solve the font size for `cols` columns across `viewportWidth` px: the
 * fitting size (MIN_FONT..MAX_FONT, the auto-fit range it always had) times
 * the user's scale, rounded and clamped to [6, 32]. Overflow still reports so the pan fallback stays right.
 */
export function solveFont(cols: number, viewportWidth: number, scale = 1): FontSolve {
  const ratio = advanceRatio()
  const cellsWidth = Math.max(1, cols) * ratio
  const ideal = Math.floor(viewportWidth / cellsWidth)
  const base = Math.max(MIN_FONT, Math.min(MAX_FONT, ideal))
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1
  const fontSize = Math.max(SCALED_MIN_FONT, Math.min(SCALED_MAX_FONT, Math.round(base * s)))
  const overflow = fontSize * cellsWidth > viewportWidth + 0.5
  return { fontSize, overflow }
}

export { MIN_FONT, MAX_FONT }

// --- Phone mode grid (E3-FR-14) ------------------------------------------------
// MIN_COLS / MIN_ROWS are the constants Orca's terminal grid fit uses; no code
// was ported. The desktop refuses anything outside [20, 500] x [8, 300].

export const PHONE_MIN_COLS = 20
export const PHONE_MIN_ROWS = 8
export const PHONE_MAX_COLS = 500
export const PHONE_MAX_ROWS = 300
/** Text sizes of phone mode ('snagentsos.remote.phoneFontSize'), 13 by default. */
export const PHONE_FONT_SIZES = [11, 12, 13, 14, 16] as const
export const PHONE_FONT_DEFAULT = 13

export interface GridSize {
  cols: number
  rows: number
}

/**
 * The grid of a phone-mode pane (E3-FR-14): cols = floor(width / cellW) and
 * rows = floor(height / cellH) at `fontSize`, with rows clamped to [8, 300]
 * and cols to 500 at most. Null under 20 columns ("turn the phone"). `cell`
 * is the measured cell when there is one; otherwise the advance ratio gives
 * the width and ceil(fontSize * 1.17) the row height.
 */
export function phoneGrid(width: number, height: number, fontSize: number, cell?: { w?: number; h?: number } | null): GridSize | null {
  if (!(width > 0) || !(height > 0) || !(fontSize > 0)) return null
  const cw = cell?.w && cell.w > 0 ? cell.w : fontSize * advanceRatio()
  const ch = cell?.h && cell.h > 0 ? cell.h : Math.ceil(fontSize * 1.17)
  const cols = Math.floor(width / cw)
  if (cols < PHONE_MIN_COLS) return null
  const rows = Math.max(PHONE_MIN_ROWS, Math.min(PHONE_MAX_ROWS, Math.floor(height / ch)))
  return { cols: Math.min(PHONE_MAX_COLS, cols), rows }
}
