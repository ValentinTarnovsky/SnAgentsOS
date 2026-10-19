/**
 * Phone mode logic (E3 M11, FR-13..16): the per-pane mode and its storage,
 * the keyboard rule, how a fitState changes this phone's view, and the
 * debounced scheduler that decides when a fitPane goes out. Pure or
 * env-injected, so scripts/test-mobile-fit.cjs drives it without a browser.
 *
 * Main decides who owns the size; this side only asks (fitPane) and follows
 * (fitState). The phone that sent the last fitPane owns it; fitState never
 * names the device, so each phone remembers what it last sent (lastFitSent)
 * and a phone fitState of another size means another phone took over (FR-16).
 */
import { STORAGE_PREFIX, storageGet, storageKeys, storageSet } from './mobileStorage'
import { PHONE_FONT_DEFAULT, PHONE_FONT_SIZES, type GridSize } from './fit'

export type PaneFitMode = 'phone' | 'desktop'

/** What this phone knows about a pane's size (the last fitState or replay). */
export interface SizeInfo {
  owner: 'phone' | 'desktop'
  cols: number
  rows: number
  /** Phone-owned with a size this phone did not send: another device controls it (FR-16). */
  other: boolean
}

// --- Storage ('snagentsos.remote.*', always behind try/catch in mobileStorage) ---

export const PANE_MODE_PREFIX = `${STORAGE_PREFIX}remote.paneMode.`
const FIT_DEFAULT_KEY = `${STORAGE_PREFIX}remote.phoneFitDefault`
const PHONE_FONT_KEY = `${STORAGE_PREFIX}remote.phoneFontSize`

/** Every saved per-pane choice (FR-13). */
export function loadPaneModes(): Record<string, PaneFitMode> {
  const out: Record<string, PaneFitMode> = {}
  for (const key of storageKeys(PANE_MODE_PREFIX)) {
    const v = storageGet(key)
    if (v === 'phone' || v === 'desktop') out[key.slice(PANE_MODE_PREFIX.length)] = v
  }
  return out
}

export function savePaneMode(paneId: string, mode: PaneFitMode): void {
  storageSet(`${PANE_MODE_PREFIX}${paneId}`, mode)
}

/** "Fit consoles to the phone" (phoneFitDefault): off, so desktop mode, by default. */
export function loadPhoneFitDefault(): boolean {
  return storageGet(FIT_DEFAULT_KEY) === 'true'
}

export function savePhoneFitDefault(on: boolean): void {
  storageSet(FIT_DEFAULT_KEY, on ? 'true' : 'false')
}

/** Phone mode text size: one of 11/12/13/14/16, 13 when missing or unknown. */
export function loadPhoneFontSize(): number {
  const n = Number(storageGet(PHONE_FONT_KEY))
  return (PHONE_FONT_SIZES as readonly number[]).includes(n) ? n : PHONE_FONT_DEFAULT
}

export function savePhoneFontSize(size: number): void {
  storageSet(PHONE_FONT_KEY, String(size))
}

/** The pane's effective mode: its saved choice, else the phoneFitDefault setting. */
export function resolvePaneMode(saved: PaneFitMode | undefined, fitDefault: boolean): PaneFitMode {
  return saved ?? (fitDefault ? 'phone' : 'desktop')
}

// --- Keyboard rule (E3-FR-15) -----------------------------------------------------

/** visualViewport this much shorter than the window = the soft keyboard is up. */
export const KB_FIT_MIN_INSET_PX = 150

/** A field that brings up the soft keyboard (a readOnly one, like the composer-mode helper, does not). */
export function isEditableField(el: unknown): boolean {
  if (!el || typeof el !== 'object') return false
  const node = el as { tagName?: string; readOnly?: boolean; isContentEditable?: boolean; type?: string }
  if (node.isContentEditable) return true
  const tag = typeof node.tagName === 'string' ? node.tagName.toUpperCase() : ''
  if (tag === 'TEXTAREA') return !node.readOnly
  if (tag === 'INPUT') return !node.readOnly && !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'color'].includes(String(node.type || 'text'))
  return false
}

/**
 * No fitPane while the keyboard is open (FR-15): visualViewport is more than
 * 150px shorter than the window, or an editable field holds the focus. The
 * grid then stays taller than the container and the vertical pan follows
 * the cursor.
 */
export function keyboardBlocksFit(innerHeight: number, vvHeight: number | null | undefined, active: unknown): boolean {
  if (typeof vvHeight === 'number' && vvHeight < innerHeight - KB_FIT_MIN_INSET_PX) return true
  return isEditableField(active)
}

// --- fitState (E3-FR-12/16/18) ------------------------------------------------------

/**
 * After a running replay (a respawn, a reconnect, a pane switch) the pane is
 * about to be claimed again, so a desktop fitState inside this window is
 * recorded without leaving phone mode (a restarted pty is born at the
 * desktop size, FR-20, and the phone re-sends its fitPane, FR-15).
 */
export const FIT_REPLAY_GRACE_MS = 1500

export interface FitStateDecision {
  /** The pane's mode after the frame. */
  mode: PaneFitMode
  /** True = save the mode (the PC took the size back: FR-18 stores 'desktop'). */
  persist: boolean
  info: SizeInfo
  /** Toast to show: the PC recovered the size. */
  toast: 'reclaimed' | null
}

/**
 * How one fitState changes this phone's view of a pane. While a fitPane of
 * this phone waits for its ack, a desktop or foreign size is only recorded:
 * this phone's own resize is about to arrive (and a refusal comes with the ack).
 */
export function decideFitState(
  mode: PaneFitMode,
  lastSent: GridSize | null,
  pending: boolean,
  msg: { owner: 'phone' | 'desktop'; cols: number; rows: number },
): FitStateDecision {
  if (msg.owner === 'desktop') {
    const info: SizeInfo = { owner: 'desktop', cols: msg.cols, rows: msg.rows, other: false }
    if (mode === 'phone' && !pending) return { mode: 'desktop', persist: true, info, toast: 'reclaimed' }
    return { mode, persist: false, info, toast: null }
  }
  const mine = !!lastSent && lastSent.cols === msg.cols && lastSent.rows === msg.rows
  const other = mode === 'phone' && !pending && !mine
  return { mode, persist: false, info: { owner: 'phone', cols: msg.cols, rows: msg.rows, other }, toast: null }
}

// --- Scheduler (E3-FR-15) -------------------------------------------------------------

/** fitPane debounce per pane: at most one every 150ms. */
export const FIT_DEBOUNCE_MS = 150

/**
 * Why a fitPane may go out. enter / font / replay / take always send (the
 * owner must be (re)claimed: a respawned or reconnected pty, a new size);
 * rotate / foreground / resize / kbClose only when the grid differs from the
 * size the pty has as this phone's.
 */
export type FitReason = 'enter' | 'rotate' | 'font' | 'replay' | 'foreground' | 'resize' | 'kbClose' | 'take'

const FORCED: ReadonlySet<FitReason> = new Set(['enter', 'font', 'replay', 'take'])

export interface FitSchedulerState {
  mode: PaneFitMode
  /** The last fitState / replay of the pane, null before any. */
  info: SizeInfo | null
  lastSent: GridSize | null
}

export interface FitSchedulerEnv {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  keyboardOpen: () => boolean
  /** The phone-mode grid of the container right now, or null under 20 columns. */
  measure: () => GridSize | null
  state: () => FitSchedulerState
  send: (grid: GridSize) => void
  /** Under 20 columns: the toast, and the pane stays in desktop mode (FR-14). */
  narrow: () => void
}

/**
 * Debounces fitPane requests for the viewed pane (FR-15). Nothing goes out
 * while the keyboard is open; the first check after it closes recalculates
 * once (and sends only if the grid really changed, or a forced reason was
 * waiting). A pane another device controls is left alone unless the user
 * tapped the chip ('take', FR-16).
 */
export class PhoneFitScheduler {
  private timer: unknown = null
  private forced = false
  private take = false
  private deferred = false

  constructor(private readonly env: FitSchedulerEnv) {}

  request(reason: FitReason): void {
    if (FORCED.has(reason)) this.forced = true
    if (reason === 'take') this.take = true
    if (this.timer != null) this.env.clearTimeout(this.timer)
    this.timer = this.env.setTimeout(() => this.run(), FIT_DEBOUNCE_MS)
  }

  /** The keyboard closed (FR-15): one recalculation if a request waited for it. */
  keyboardClosed(): void {
    if (!this.deferred) return
    this.deferred = false
    this.request('kbClose')
  }

  /** The viewed pane changed: whatever was queued belonged to the old one. */
  reset(): void {
    if (this.timer != null) this.env.clearTimeout(this.timer)
    this.timer = null
    this.forced = false
    this.take = false
    this.deferred = false
  }

  get waitingForKeyboard(): boolean {
    return this.deferred
  }

  private run(): void {
    this.timer = null
    const st = this.env.state()
    if (st.mode !== 'phone' || (st.info?.other && !this.take)) {
      this.forced = false
      this.take = false
      return
    }
    if (this.env.keyboardOpen()) {
      this.deferred = true
      return
    }
    const grid = this.env.measure()
    const forced = this.forced || this.take
    this.forced = false
    this.take = false
    if (!grid) {
      this.env.narrow()
      return
    }
    const info = st.info
    const settled =
      !!info &&
      info.owner === 'phone' &&
      !info.other &&
      info.cols === grid.cols &&
      info.rows === grid.rows &&
      !!st.lastSent &&
      st.lastSent.cols === grid.cols &&
      st.lastSent.rows === grid.rows
    if (forced || !settled) this.env.send(grid)
  }
}

// --- Requests from outside the terminal (the header chip) ------------------------------

let requester: ((reason: FitReason) => void) | null = null

/** RemoteTerminal registers its scheduler here while mounted. */
export function setPhoneFitRequester(fn: ((reason: FitReason) => void) | null): void {
  requester = fn
}

/** Ask the mounted terminal for a fitPane (the chip's "take control"). */
export function requestPhoneFit(reason: FitReason): void {
  requester?.(reason)
}
