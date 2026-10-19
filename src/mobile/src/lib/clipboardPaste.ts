/**
 * The Paste key with the Clipboard API (E3-FR-48). In a secure context with
 * `navigator.clipboard.readText`, a tap reads the clipboard and the text goes
 * through the safe paste of E3-FR-05 straight into the console (or, in
 * Composer mode, into the composer at its caret). Without the API, or when
 * the read is refused, empty or fails, it falls back to the one-shot composer
 * of D11 (the PasteSheet no longer exists).
 *
 * The flow is pure over a ClipboardPasteIo, so it runs under Node in the tests.
 */

export interface ClipboardPasteIo {
  /** Secure context and navigator.clipboard.readText exist. */
  canRead(): boolean
  readText(): Promise<string>
  /** The viewed console takes input in Composer mode. */
  composerMode(): boolean
  /** Insert at the composer's caret. */
  insertComposer(text: string): void
  /** Safe paste into the viewed console; false when nothing went out. */
  pasteDirect(text: string): Promise<boolean>
  /** D11 fallback: the composer as a one-shot. */
  openComposer(): void
}

export type ClipboardPasteResult = 'pasted' | 'composer' | 'fallback'

/**
 * The fallback runs synchronously when the API is missing, so the composer
 * still gets the focus inside the tap (the iOS keyboard needs the gesture).
 */
export async function pasteFromClipboard(io: ClipboardPasteIo): Promise<ClipboardPasteResult> {
  if (!io.canRead()) {
    io.openComposer()
    return 'fallback'
  }
  let text = ''
  try {
    text = await io.readText()
  } catch {
    io.openComposer()
    return 'fallback'
  }
  if (!text) {
    io.openComposer()
    return 'fallback'
  }
  if (io.composerMode()) {
    io.insertComposer(text)
    return 'composer'
  }
  if (await io.pasteDirect(text)) return 'pasted'
  io.openComposer()
  return 'fallback'
}

/** Secure context with the async clipboard read (https or localhost). */
export function canReadClipboard(): boolean {
  try {
    return typeof window !== 'undefined' && window.isSecureContext === true && typeof navigator.clipboard?.readText === 'function'
  } catch {
    return false
  }
}
