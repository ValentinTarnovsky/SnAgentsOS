/**
 * Per-phone preferences and the per-pane input mode (E1-FR-22, FR-30). They
 * live in this phone's localStorage only: the desktop config is untouched, so
 * there is no CONFIG_VERSION bump.
 *
 * Booleans are stored only when they differ from the default ('1' / '0') and
 * removed otherwise, so a cleared or blocked storage reads back as defaults.
 * The page alert preferences (E2-FR-44) share one JSON object instead,
 * 'snagentsos.prefs', which replaced E1-FR-40's 'snagentsos.alerts.inPage'.
 */
import type { PaneType } from '@shared/types'
import { INPUT_MODE_PREFIX, STORAGE_PREFIX, storageGet, storageKeys, storageRemove, storageSet } from './mobileStorage'

/** Where typed text goes: the xterm helper textarea or the docked composer. */
export type InputMode = 'direct' | 'composer'

export interface MobilePrefs {
  /** AI consoles without a saved choice open in Composer. */
  composerDefaultForAgents: boolean
  /** Phone keyboard autocorrect, spell check and capitalization in the composer. */
  composerAutocorrect: boolean
  /** On-screen alerts: toasts when another console needs the user (E2-FR-43, 44). */
  inPageAlerts: boolean
  /** Answer cards for Claude's permissions and questions (E2-FR-13, 19; default on). */
  promptCards: boolean
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
    inPageAlerts: loadPagePrefs().toasts,
    promptCards: loadPromptCards(),
  }
}

// --- answer cards (E2-FR-13, 19; R22-15) ---

/** 'snagentsos.promptCards': '0' when off; absent (the default) means on. */
export const PROMPT_CARDS_KEY = `${STORAGE_PREFIX}promptCards`

export function loadPromptCards(): boolean {
  return storageGet(PROMPT_CARDS_KEY) !== '0'
}

export function savePromptCards(on: boolean): void {
  if (on) storageRemove(PROMPT_CARDS_KEY)
  else storageSet(PROMPT_CARDS_KEY, '0')
}

export function saveInPageAlertsPref(on: boolean): void {
  savePagePrefs({ toasts: on })
}

// --- Page alerts (E2-FR-43, 44; R22-18) ---

/**
 * 'snagentsos.prefs': { version: 1, toasts, vibrate, toastDone } plus any key
 * another feature keeps there (it is preserved on write). Per origin, like
 * every key here.
 */
export const PAGE_PREFS_KEY = `${STORAGE_PREFIX}prefs`
/** E1-FR-40's single switch; read once as the toasts default, then removed. */
export const LEGACY_IN_PAGE_KEY = `${STORAGE_PREFIX}alerts.inPage`

export interface PagePrefs {
  /** "On-screen alerts": toasts in the terminal for another console (default on). */
  toasts: boolean
  /** Vibrate on action and error (default on; hidden without navigator.vibrate). */
  vibrate: boolean
  /** "Alert when a turn ends": a toast on done too (default off). */
  toastDone: boolean
}

export const PAGE_PREFS_DEFAULTS: PagePrefs = { toasts: true, vibrate: true, toastDone: false }

function readPagePrefsObject(): Record<string, unknown> {
  const v = readJson(PAGE_PREFS_KEY)
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

export function loadPagePrefs(): PagePrefs {
  const stored = readPagePrefsObject()
  const bool = (key: keyof PagePrefs, fallback: boolean): boolean => (typeof stored[key] === 'boolean' ? (stored[key] as boolean) : fallback)
  return {
    toasts: bool('toasts', storageGet(LEGACY_IN_PAGE_KEY) !== '0'),
    vibrate: bool('vibrate', PAGE_PREFS_DEFAULTS.vibrate),
    toastDone: bool('toastDone', PAGE_PREFS_DEFAULTS.toastDone),
  }
}

/** Merge a change into 'snagentsos.prefs' (unknown keys kept) and drop the legacy key. */
export function savePagePrefs(patch: Partial<PagePrefs>): PagePrefs {
  const next = { ...readPagePrefsObject(), ...loadPagePrefs(), ...patch, version: 1 }
  if (storageSet(PAGE_PREFS_KEY, JSON.stringify(next))) storageRemove(LEGACY_IN_PAGE_KEY)
  return { toasts: next.toasts, vibrate: next.vibrate, toastDone: next.toastDone }
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

// --- Home (E2-FR-03, 04, 05; R22-14) ---
// Per origin like everything here: the LAN and the Tailscale address keep
// their own copy. Every read survives a blocked storage (defaults back).

/** The last console the terminal showed ('snagentsos.lastPane'), for the Resume card. */
export const LAST_PANE_KEY = `${STORAGE_PREFIX}lastPane`
/** Collapsed workspace sections ('snagentsos.home.collapsed', array of ids). */
export const COLLAPSED_KEY = `${STORAGE_PREFIX}home.collapsed`
/**
 * The state each console was last seen in on this phone ('snagentsos.lastViewed',
 * paneId -> ms): that state's stateSince, on the desktop clock (E2-FR-05).
 */
export const LAST_VIEWED_KEY = `${STORAGE_PREFIX}lastViewed`
/** Entries lastViewed keeps; the oldest stamps go first. */
export const LAST_VIEWED_MAX = 200

function readJson(key: string): unknown {
  const raw = storageGet(key)
  if (raw == null) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

export function loadLastPane(): string | null {
  const raw = storageGet(LAST_PANE_KEY)
  return raw && raw.length <= 128 ? raw : null
}

export function saveLastPane(paneId: string): void {
  storageSet(LAST_PANE_KEY, paneId)
}

export function loadCollapsed(): string[] {
  const v = readJson(COLLAPSED_KEY)
  return Array.isArray(v) ? v.filter((id): id is string => typeof id === 'string').slice(0, 500) : []
}

export function saveCollapsed(ids: readonly string[]): void {
  if (ids.length === 0) storageRemove(COLLAPSED_KEY)
  else storageSet(COLLAPSED_KEY, JSON.stringify(ids))
}

export function loadLastViewed(): Record<string, number> {
  const v = readJson(LAST_VIEWED_KEY)
  const out: Record<string, number> = {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [id, at] of Object.entries(v as Record<string, unknown>)) {
    if (typeof at === 'number' && Number.isFinite(at)) out[id] = at
  }
  return out
}

/**
 * `map` with paneId stamped at `at`, trimmed to the LAST_VIEWED_MAX most
 * recent entries (LRU by timestamp). Pure; the caller persists the result.
 */
export function withViewed(map: Readonly<Record<string, number>>, paneId: string, at: number): Record<string, number> {
  const next: Record<string, number> = { ...map, [paneId]: at }
  const ids = Object.keys(next)
  if (ids.length <= LAST_VIEWED_MAX) return next
  ids.sort((a, b) => next[b] - next[a])
  const kept: Record<string, number> = {}
  for (const id of ids.slice(0, LAST_VIEWED_MAX)) kept[id] = next[id]
  return kept
}

export function saveLastViewed(map: Readonly<Record<string, number>>): void {
  storageSet(LAST_VIEWED_KEY, JSON.stringify(map))
}
