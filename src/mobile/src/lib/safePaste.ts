/**
 * Safe paste over the existing `input` frame (E3-FR-05). Everything the phone
 * pastes into a console (the composer, the Paste key's one-shot composer per
 * D11, and later image paths and the Chat view) is built here instead of going
 * through term.paste:
 *
 *  1. sanitizePasteText drops ESC, C0 (tab, \n and \r stay), DEL and C1, so
 *     the text can never close the bracketed paste or inject a sequence.
 *  2. Line breaks become `\r`, what a terminal sends for Enter.
 *  3. The text is wrapped in `\x1b[200~ ... \x1b[201~` when the pane has
 *     bracketed paste: the last mode the phone's xterm saw, or always for a
 *     claude/codex status (both CLIs turn it on), so a multi-line prompt
 *     arrives as one prompt.
 *  4. The result goes in frames of PASTE_FRAME_MAX or less that never split a
 *     surrogate pair or the opening and closing sequences.
 *  5. With `enter`, a `\r` frame follows the closing sequence after
 *     PASTE_ENTER_DELAY_MS (the composer's E1-FR-24 gap), marked `submit`
 *     (app 2.5.0): the PC writes it SUBMIT_DELAY_MS after the pty's last
 *     write, because Codex on Windows reads a paste as fast keys and takes
 *     an Enter within about 60 ms of them as a newline inside the paste,
 *     and the network can bring the two frames closer than this gap.
 *
 * Free of React, the DOM and the socket: callers pass a SafePasteIo, so the
 * rules run under Node in the tests.
 */
import type { RemotePaneStatus } from '@shared/remote-protocol'
import { sanitizePasteText } from '@shared/sanitize-paste'

export { sanitizePasteText }

export const PASTE_START = '\x1b[200~'
export const PASTE_END = '\x1b[201~'
/** Frame size for pasted text: under the schema's 8192 with margin. */
export const PASTE_FRAME_MAX = 8000
/** Gap between the pasted text and its Enter frame. */
export const PASTE_ENTER_DELAY_MS = 50

/** Shortest frame the splitter accepts (fits either marker plus a pair). */
const MIN_FRAME = 8

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

/** `\r\n` and `\n` become `\r`; a lone `\r` stays. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n|\n/g, '\r')
}

/**
 * Whether a paste into this pane goes bracketed: always for a claude/codex
 * status, else the last bracketedPasteMode the phone's xterm saw. Undefined
 * means unknown (no terminal mounted yet), which the composer does not treat
 * as "off" for its multi-line confirm.
 */
export function pasteBracketed(termMode: boolean | undefined, status?: RemotePaneStatus | null): boolean | undefined {
  if (status?.provider === 'claude' || status?.provider === 'codex') return true
  return termMode
}

/** Sanitized, normalized and (when bracketed) wrapped; '' when nothing is left. */
export function preparePaste(text: string, bracketed: boolean | undefined): string {
  const body = normalizeNewlines(sanitizePasteText(text))
  if (!body) return ''
  return bracketed ? PASTE_START + body + PASTE_END : body
}

/**
 * Split a prepared payload into frames of at most max UTF-16 units, in order.
 * A cut never lands between the halves of a surrogate pair or inside an
 * escape sequence: the sanitized body has no ESC, so the only ones are the
 * paste markers, and a cut that would split one moves before its ESC.
 */
export function splitPasteFrames(payload: string, max: number = PASTE_FRAME_MAX): string[] {
  const size = Math.max(MIN_FRAME, Math.floor(max))
  if (payload.length <= size) return payload.length ? [payload] : []
  const out: string[] = []
  let i = 0
  while (i < payload.length) {
    let end = Math.min(i + size, payload.length)
    if (end < payload.length) {
      if (isHighSurrogate(payload.charCodeAt(end - 1))) end--
      const esc = payload.lastIndexOf('\x1b', end - 1)
      if (esc > i && esc >= end - (PASTE_END.length - 1)) end = esc
    }
    out.push(payload.slice(i, end))
    i = end
  }
  return out
}

/** The `input` frames for text, before any Enter. */
export function buildPasteFrames(text: string, bracketed: boolean | undefined, max: number = PASTE_FRAME_MAX): string[] {
  return splitPasteFrames(preparePaste(text, bracketed), max)
}

/** What safePaste needs from the WS client. */
export interface SafePasteIo {
  /** One raw `input` frame to the pane; false when the socket is not open. `submit` marks the Enter. */
  sendInput(data: string, opts?: { submit?: boolean }): boolean
  /** Resolves after ms, or settles early when signal aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>
}

export interface SafePasteOpts {
  /** pasteBracketed() of the target pane. */
  bracketed: boolean | undefined
  /** Follow the paste with Enter. */
  enter: boolean
  signal: AbortSignal
  /** The send may still go on (socket open, same pane); checked before the Enter too. */
  live?: () => boolean
}

/**
 * Send text as a safe paste. False when nothing went out (not live, nothing
 * left after sanitizing, or the first frame failed), so the caller keeps the
 * text. The frames go back to back in one task, so the socket cannot change
 * under them; the Enter is dropped when the pane changed during the gap.
 */
export async function safePaste(text: string, opts: SafePasteOpts, io: SafePasteIo): Promise<boolean> {
  const live = (): boolean => !opts.signal.aborted && (opts.live ? opts.live() : true)
  if (!live()) return false
  const frames = buildPasteFrames(text, opts.bracketed)
  if (!frames.length) return false
  for (let i = 0; i < frames.length; i++) {
    if (!io.sendInput(frames[i])) return i > 0
  }
  if (!opts.enter) return true
  try {
    await io.sleep(PASTE_ENTER_DELAY_MS, opts.signal)
  } catch {
    /* aborted: live() below says so */
  }
  if (live()) io.sendInput('\r', { submit: true })
  return true
}
