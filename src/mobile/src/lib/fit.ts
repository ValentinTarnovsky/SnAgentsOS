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
  /** Chosen font size in px, clamped to [MIN_FONT, MAX_FONT]. */
  fontSize: number
  /** True when even MIN_FONT overflows the width => container should pan. */
  overflow: boolean
}

/**
 * Solve the font size for `cols` columns across `viewportWidth` px. An optional
 * manual override (user's +/- in settings) wins but is still clamped and still
 * reports overflow so the pan fallback stays correct.
 */
export function solveFont(cols: number, viewportWidth: number, override?: number | null): FontSolve {
  const ratio = advanceRatio()
  const cellsWidth = Math.max(1, cols) * ratio
  const ideal = Math.floor(viewportWidth / cellsWidth)
  const base = override != null ? override : ideal
  const fontSize = Math.max(MIN_FONT, Math.min(MAX_FONT, base))
  const overflow = fontSize * cellsWidth > viewportWidth + 0.5
  return { fontSize, overflow }
}

export { MIN_FONT, MAX_FONT }
