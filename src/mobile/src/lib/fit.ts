/**
 * Font-size solver for the phone terminal.
 *
 * The phone NEVER resizes the pty (v1 decision): the desktop owns the real
 * cols/rows and the phone renders that fixed grid. Instead of an xterm FitAddon
 * we pick a fontSize so `cols` columns fit the viewport width, and if even the
 * minimum size overflows we let the terminal container pan horizontally.
 *
 * JetBrains Mono's advance-width ratio (glyph advance / fontSize) is measured
 * once via canvas measureText and cached, so the solver is a cheap arithmetic
 * clamp we can re-run on every visualViewport resize or replay.
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
