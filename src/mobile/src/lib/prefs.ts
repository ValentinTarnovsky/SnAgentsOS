/**
 * Per-phone preferences and the per-pane input mode (E1-FR-22, FR-30). They
 * live in this phone's localStorage only: the desktop config is untouched, so
 * there is no CONFIG_VERSION bump.
 *
 * Booleans are stored only when they differ from the default ('1' / '0') and
 * removed otherwise, so a cleared or blocked storage reads back as defaults.
 * inPageAlerts keeps its own format in inPageAlerts.ts (E1-FR-40) and is only
 * re-exposed here so MobilePrefs matches the contract.
 */
import type { PaneType } from '@shared/types'
import { INPUT_MODE_PREFIX, STORAGE_PREFIX, storageGet, storageKeys, storageRemove, storageSet } from './mobileStorage'
import { loadInPageAlerts, saveInPageAlerts } from './inPageAlerts'

/** Where typed text goes: the xterm helper textarea or the docked composer. */
export type InputMode = 'direct' | 'composer'

export interface MobilePrefs {
  /** AI consoles without a saved choice open in Composer. */
  composerDefaultForAgents: boolean
  /** Phone keyboard autocorrect, spell check and capitalization in the composer. */
  composerAutocorrect: boolean
  /** Toast and vibration when another console needs the user (E1-FR-40). */
  inPageAlerts: boolean
}

export type ComposerPref = 'composerDefaultForAgents' | 'composerAutocorrect'

export const PREF_KEYS: Record<ComposerPref, string> = {
  composerDefaultForAgents: `${STORAGE_PREFIX}composer.agentsDefault`,
  composerAutocorrect: `${STORAGE_PREFIX}composer.autocorrect`,
}

export const PREF_DEFAULTS: Record<ComposerPref, boolean> = {
  composerDefaultForAgents: false,
  composerAutocorrect: false,
}

export function loadPref(name: ComposerPref): boolean {
  const raw = storageGet(PREF_KEYS[name])
  if (raw === '1') return true
  if (raw === '0') return false
  return PREF_DEFAULTS[name]
}

export function savePref(name: ComposerPref, on: boolean): void {
  if (on === PREF_DEFAULTS[name]) storageRemove(PREF_KEYS[name])
  else storageSet(PREF_KEYS[name], on ? '1' : '0')
}

export function loadPrefs(): MobilePrefs {
  return {
    composerDefaultForAgents: loadPref('composerDefaultForAgents'),
    composerAutocorrect: loadPref('composerAutocorrect'),
    inPageAlerts: loadInPageAlerts(),
  }
}

export function saveInPageAlertsPref(on: boolean): void {
  saveInPageAlerts(on)
}

// --- input mode per pane ('snagentsos.inputMode.<paneId>') ---

export function inputModeKey(paneId: string): string {
  return `${INPUT_MODE_PREFIX}${paneId}`
}

function isMode(v: string | null): v is InputMode {
  return v === 'direct' || v === 'composer'
}

/** Every saved explicit choice, keyed by paneId (corrupt values are skipped). */
export function loadInputModes(): Record<string, InputMode> {
  const modes: Record<string, InputMode> = {}
  for (const key of storageKeys(INPUT_MODE_PREFIX)) {
    const value = storageGet(key)
    if (isMode(value)) modes[key.slice(INPUT_MODE_PREFIX.length)] = value
  }
  return modes
}

export function saveInputMode(paneId: string, mode: InputMode): void {
  storageSet(inputModeKey(paneId), mode)
}

/**
 * The mode a pane opens in: its saved choice, else Composer for claude, codex
 * and custom panes when composerDefaultForAgents is on, else Direct. The pane
 * type alone decides the default (a shell that happens to run an agent keeps
 * Direct, so the mode never flips with the agent status).
 */
export function resolveInputMode(
  saved: InputMode | undefined,
  paneType: PaneType | undefined,
  agentsDefault: boolean,
): InputMode {
  if (saved) return saved
  if (agentsDefault && (paneType === 'claude' || paneType === 'codex' || paneType === 'custom')) return 'composer'
  return 'direct'
}
