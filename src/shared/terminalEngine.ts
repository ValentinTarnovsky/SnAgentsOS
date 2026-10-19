import type { TerminalEngineSettings } from './ipc-contract'
import type { Settings, TerminalSnapshotMode } from './types'

/**
 * Main-side terminal engine settings (E6-FR-01/06/08/14), shared by the
 * renderer (which pushes them on `pty:setEngine`) and main (which validates
 * whatever arrives before applying it to the headless mirrors).
 */

/** Lines of scrollback a replay snapshot carries (desktop reattach and phone). */
export const REPLAY_LINES = 2000
/** Bounds of `persistScrollbackLines` (same as the schema 12 clamp). */
export const PERSIST_LINES_MIN = 200
export const PERSIST_LINES_MAX = 5000

export const DEFAULT_ENGINE: TerminalEngineSettings = {
  snapshotMode: 'auto',
  unicode11: true,
  persist: true,
  persistLines: 2000,
}

const MODES: readonly TerminalSnapshotMode[] = ['auto', 'lazy', 'off']

/** Any payload -> valid settings: unknown fields are dropped, junk falls back to the defaults. */
export function normalizeEngine(raw: unknown): TerminalEngineSettings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const lines = typeof r.persistLines === 'number' && Number.isFinite(r.persistLines) ? Math.round(r.persistLines) : DEFAULT_ENGINE.persistLines
  const out: TerminalEngineSettings = {
    snapshotMode: MODES.includes(r.snapshotMode as TerminalSnapshotMode) ? (r.snapshotMode as TerminalSnapshotMode) : DEFAULT_ENGINE.snapshotMode,
    unicode11: typeof r.unicode11 === 'boolean' ? r.unicode11 : DEFAULT_ENGINE.unicode11,
    persist: typeof r.persist === 'boolean' ? r.persist : DEFAULT_ENGINE.persist,
    persistLines: Math.min(PERSIST_LINES_MAX, Math.max(PERSIST_LINES_MIN, lines)),
  }
  if (typeof r.shellIntegration === 'boolean') out.shellIntegration = r.shellIntegration
  return out
}

type EngineKeys = 'terminalSnapshotMode' | 'terminalUnicode11' | 'persistScrollback' | 'persistScrollbackLines' | 'terminalShellIntegration'

/**
 * The engine settings a config's `settings` describe (missing keys take the
 * defaults). `shellIntegration` is always present here (schema 14, default on);
 * a payload without it (an older sender) leaves the integration off in main.
 */
export function engineFromSettings(s: Partial<Pick<Settings, EngineKeys>> | null | undefined): TerminalEngineSettings {
  return normalizeEngine({
    snapshotMode: s?.terminalSnapshotMode,
    unicode11: s?.terminalUnicode11,
    persist: s?.persistScrollback,
    persistLines: s?.persistScrollbackLines,
    shellIntegration: s?.terminalShellIntegration !== false,
  })
}

/** Rows the mirror keeps: enough for a replay and for what persistence saves (E6-FR-08). */
export function mirrorScrollback(engine: TerminalEngineSettings): number {
  return Math.max(REPLAY_LINES, engine.persistLines)
}
