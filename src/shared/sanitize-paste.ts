/**
 * Text that is about to be pasted into a pty (E3-FR-05, E3-FR-55). Pure and
 * import-free: the mobile safePaste helper and the desktop executor of
 * `sendReviewNotes` both run it before wrapping the text in a bracketed paste.
 *
 * It drops ESC and every other C0 control except tab, line feed and carriage
 * return, plus DEL and the C1 range (U+0080..U+009F). Without ESC the text can
 * never close the bracketed paste early (`\x1b[201~`), and without C1 it can
 * never smuggle an 8-bit CSI (U+009B) past the terminal.
 */

/** C0 minus \t \n \r, DEL and C1. Global: callers use it with replace only. */
const PASTE_CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u0080-\u009f]/g

/** The text without ESC, C0 (tab, \n and \r stay), DEL or C1 controls. */
export function sanitizePasteText(text: string): string {
  return text.replace(PASTE_CONTROLS, '')
}
