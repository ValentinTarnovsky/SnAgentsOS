// Adaptado de stablyai/orca (MIT) - src/renderer/src/components/maintenance/update-card/update-card-visibility.ts

import type { InstallKind, UpdatePhase } from '@shared/ipc-contract'

/**
 * Pure rules for the update card and the title bar chip (E4-FR-12..18), kept
 * apart from React so scripts/test-update.cjs covers them as a table.
 */

/** "v1.2.3" / "1.2.3-beta" -> [1, 2, 3]. */
function parts(v: string): number[] {
  return v.replace(/^v/i, '').split('-')[0].split('+')[0].split('.').map((n) => parseInt(n, 10) || 0)
}

/** True when `a` is a strictly higher version than `b`. */
export function isVersionNewer(a: string, b: string): boolean {
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? 0
    const q = y[i] ?? 0
    if (p !== q) return p > q
  }
  return false
}

export interface CardVisibilityInput {
  phase: UpdatePhase
  /** Offered version (UpdateInfo.latestVersion). */
  latest: string | null
  /** settings.updateDismissedVersion ('' = none). */
  dismissed: string
  /** A non-installable version closed in this session (not persisted). */
  sessionDismissed: string | null
  /** The user collapsed or closed the card past the offer. */
  collapsed: boolean
  /** The user asked for the card (title bar chip): dismissals do not apply. */
  userInitiated: boolean
  installable: boolean
}

/**
 * Whether the card is in the toast stack.
 * - idle: never.
 * - available: hidden once dismissed, until a strictly higher version shows
 *   up (a persisted dismissal) or for the rest of the session (a
 *   non-installable one), unless the user asked for it.
 * - downloading / installing / failed / opened: shown unless collapsed (the
 *   chip takes over for the first three).
 */
export function isUpdateCardVisible(i: CardVisibilityInput): boolean {
  if (i.phase === 'idle') return false
  if (i.phase === 'available') {
    if (!i.latest) return false
    if (i.userInitiated) return true
    if (i.collapsed) return false
    if (i.sessionDismissed === i.latest) return false
    if (i.dismissed && !isVersionNewer(i.latest, i.dismissed)) return false
    return true
  }
  return !i.collapsed
}

/** Only an installable version persists its dismissal (E4-FR-13). */
export function shouldPersistDismiss(i: { installable: boolean }): boolean {
  return i.installable
}

/** Phases the chip reports: download percent, installing, failed. */
export function isChipPhase(phase: UpdatePhase): boolean {
  return phase === 'downloading' || phase === 'installing' || phase === 'failed'
}

/** The chip shows while the card is collapsed or hidden in a chip phase (E4-FR-16). */
export function isUpdateChipVisible(i: { phase: UpdatePhase; cardVisible: boolean }): boolean {
  return !i.cardVisible && isChipPhase(i.phase)
}

/** The 6 h re-check only runs while nothing is being installed (E4-FR-18). */
export function shouldRecheck(i: { phase: UpdatePhase }): boolean {
  return i.phase === 'idle' || i.phase === 'available'
}

/** Install kinds that close the app (and its consoles) to update (E4-FR-15). */
export function closesConsoles(kind: InstallKind): boolean {
  return kind === 'win-portable' || kind === 'win-installer' || kind === 'linux-appimage'
}

/**
 * Whether [Update] needs the second "close N consoles" click: only when the
 * update closes the app and an agent is working or waiting.
 */
export function needsDoubleConfirm(i: { kind: InstallKind; busyAgents: number }): boolean {
  return closesConsoles(i.kind) && i.busyAgents > 0
}

/** "+N versions" label value: null below 2, "30+" at the page cap (E4-FR-14). */
export function newerLabel(count: number): { count: number; more: boolean } | null {
  if (count < 2) return null
  return { count: Math.min(count, 30), more: count >= 30 }
}
