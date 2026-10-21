/**
 * Per-pane access to xterm's paste path, so features outside the terminal
 * component (dropping files, review notes) can insert text the same way a
 * Ctrl+V does: `term.paste` normalizes LF to CR and only adds the
 * ESC[200~ / ESC[201~ markers when the inner app enabled bracketed-paste mode
 * (2004). Follows the pattern of `focus.ts`; useXterm registers on mount.
 */
/** v2.3: `auto` marks text nobody typed (it reaches main as `origin: 'auto'`). */
export interface PasteOpts {
  auto?: boolean
}

export interface Paster {
  /** Paste text through xterm (never appends Enter). */
  paste: (text: string, opts?: PasteOpts) => void
  /** Whether the inner app currently has bracketed-paste mode on. */
  bracketed: () => boolean
}

const pasters = new Map<string, Paster>()

export function registerPaster(paneId: string, paster: Paster): void {
  pasters.set(paneId, paster)
}

/**
 * Drop a pane's paster. With `paster` given, only that exact registration is
 * removed, so a late cleanup of a remounted terminal never drops the new one.
 */
export function unregisterPaster(paneId: string, paster?: Paster): void {
  if (paster && pasters.get(paneId) !== paster) return
  pasters.delete(paneId)
}

/** Paste into a pane's terminal. False when no xterm is mounted for it. */
export function pasteToPane(paneId: string, text: string, opts?: PasteOpts): boolean {
  const paster = pasters.get(paneId)
  if (!paster || !text) return false
  if (opts?.auto) paster.paste(text, opts)
  else paster.paste(text)
  return true
}

/** Bracketed-paste state of a pane; null when no xterm is mounted for it. */
export function isBracketedPaste(paneId: string): boolean | null {
  const paster = pasters.get(paneId)
  return paster ? paster.bracketed() : null
}
