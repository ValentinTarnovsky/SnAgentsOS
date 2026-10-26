import { BRAND, LEGACY_BRAND } from './brand'
import { INITIAL_PROMPT_ENV } from './initialPrompt'
import { findPaneInConfig, presetById, presetOfPane } from './paneConfig'
import type { ConfigFile } from './types'

/**
 * Environment variables of an AgentPreset (`preset.env`). Main resolves them
 * at spawn time from its own copy of the config (the renderer never sends
 * them) and merges them over the inherited environment and under the app's
 * own variables, so a preset can never set a reserved key.
 */

/** A portable variable name: letters, digits and `_`, not starting with a digit. */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Keys a preset never sets: every SNAOS_ (and 1.x) variable, the prompt and mark handoffs included. */
export function isReservedEnvKey(key: string): boolean {
  const upper = key.toUpperCase()
  return upper.startsWith(BRAND.envPrefix) || upper.startsWith(LEGACY_BRAND.envPrefix) || upper === INITIAL_PROMPT_ENV
}

function usableEntry(key: string, value: unknown): value is string {
  return KEY_RE.test(key) && !isReservedEnvKey(key) && typeof value === 'string' && !value.includes('\0')
}

/**
 * The editor's text ("KEY=VALUE", one per line) as a record. Blank lines,
 * `#` comments, lines without `=` or with an invalid or reserved key are
 * skipped; the value is everything after the first `=` (trimmed, may be
 * empty, may contain `=`). A repeated key keeps its last value. An empty value
 * is stored but has no effect at spawn (see `applyPresetEnv`).
 */
export function parsePresetEnvText(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (usableEntry(key, value)) out[key] = value
  }
  return Object.keys(out).length ? out : undefined
}

export function presetEnvToText(env?: Record<string, string>): string {
  if (!env) return ''
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
}

/** A stored preset env with the unusable entries dropped (an older or hand edited config). */
export function sanitizePresetEnv(env: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!env || typeof env !== 'object' || Array.isArray(env)) return out
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (usableEntry(key, value)) out[key] = value
  }
  return out
}

/**
 * The env of the preset behind `paneId` in the saved config. A pane not saved
 * yet (the renderer persists with a debounce, a new pane spawns first) falls
 * back to `presetHint`, a preset id that must exist in the same config.
 */
export function resolvePresetEnv(cfg: ConfigFile | null | undefined, paneId: string, presetHint?: string): Record<string, string> {
  const found = findPaneInConfig(cfg, paneId)
  const preset = found ? presetOfPane(cfg, found.pane) : presetById(cfg, typeof presetHint === 'string' ? presetHint : undefined)
  return sanitizePresetEnv(preset?.env)
}

/**
 * Merges a preset env into `target` in place. With `caseInsensitive` (Windows)
 * a preset `Path` replaces an inherited `PATH` instead of sitting next to it.
 * An empty value means "not set": the key is skipped and the inherited value
 * (any case variant included) stays. That is what an imported export carries
 * (`sanitizeExport` blanks every value), so it never spawns an empty PATH.
 */
export function applyPresetEnv(target: Record<string, string>, presetEnv: Record<string, string>, caseInsensitive: boolean): Record<string, string> {
  for (const [key, value] of Object.entries(presetEnv)) {
    if (value === '') continue
    if (caseInsensitive) {
      const upper = key.toUpperCase()
      for (const existing of Object.keys(target)) if (existing !== key && existing.toUpperCase() === upper) delete target[existing]
    }
    target[key] = value
  }
  return target
}
