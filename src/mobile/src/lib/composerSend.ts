/**
 * Composer delivery (E1-FR-24..27). No new WS message: text travels as
 * ordinary `input` frames, chunked under the 8192-char limit of
 * remoteClientMsgSchema, Enter goes as its own `\r` frame ENTER_DELAY_MS
 * later, and Stop is an `input` frame with ESC. Pasted text goes through
 * safePaste.ts (E3-FR-05): sanitized, `\r` line breaks, bracketed when the
 * pane has it, never through term.paste.
 *
 * Kept free of React, the DOM and the socket: the caller passes a ComposerIo
 * bound to the WS client and the live xterm, so every rule (open-socket check,
 * latch release, slash typing, aborts) runs under Node in the tests.
 */
import type { PaneType } from '@shared/types'
import type { RemotePaneStatus } from '@shared/remote-protocol'
import { PASTE_ENTER_DELAY_MS, PASTE_FRAME_MAX, safePaste } from './safePaste'

/** Chunk size for `input` frames: under the schema's 8192 with margin. */
export const INPUT_CHUNK = PASTE_FRAME_MAX
/** One typed character per frame this often for slash commands. */
export const SLASH_KEY_MS = 16
/** Longest text still typed as a slash command (longer goes by paste). */
export const SLASH_MAX = 200
/** Gap between the pasted text and its Enter frame. */
export const ENTER_DELAY_MS = PASTE_ENTER_DELAY_MS
/** Composer field limit. */
export const COMPOSER_MAX = 16384
/** The character counter shows from this length. */
export const COMPOSER_COUNTER_FROM = 14000
/** Hold on Send this long to Insert without Enter (E1-FR-26). Same value as
 * the tabs/Home rows long-press of E1-FR-33. */
export const LONG_PRESS_MS = 450
/** Haptic tick when the long-press fires. */
export const INSERT_VIBRATE_MS = 10
/** Interrupt the agent (E1-FR-27). */
export const STOP_SEQ = '\x1b'

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

/**
 * Split data into frames of at most max UTF-16 units, in order, never
 * between the two halves of a surrogate pair. Empty data yields no frame.
 */
export function chunkInput(data: string, max: number = INPUT_CHUNK): string[] {
  if (data.length <= max) return data.length ? [data] : []
  const size = Math.max(2, Math.floor(max))
  const out: string[] = []
  let i = 0
  while (i < data.length) {
    let end = Math.min(i + size, data.length)
    if (end < data.length && isHighSurrogate(data.charCodeAt(end - 1))) end--
    out.push(data.slice(i, end))
    i = end
  }
  return out
}

/** claude, codex and custom panes, or any pane whose status names a provider. */
export function isAgentPane(type: PaneType | undefined, status?: RemotePaneStatus | null): boolean {
  return type === 'claude' || type === 'codex' || type === 'custom' || !!status?.provider
}

/** A one-line "/command" of at most SLASH_MAX characters (edges trimmed). */
export function isSlashCommand(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.startsWith('/') && trimmed.length <= SLASH_MAX && !/[\r\n]/.test(trimmed)
}

/** FR-25: slash commands are typed key by key only in agent panes. */
export function shouldTypeSlash(text: string, type: PaneType | undefined, status?: RemotePaneStatus | null): boolean {
  return isSlashCommand(text) && isAgentPane(type, status)
}

/** Text with a newline into an app without bracketed paste runs line by line. */
export function needsMultilineConfirm(text: string, bracketedPaste: boolean | undefined): boolean {
  return bracketedPaste === false && /[\r\n]/.test(text)
}

/** Insert text into value at the selection, capped at max (the caret follows). */
export function insertAt(
  value: string,
  text: string,
  start: number,
  end: number = start,
  max: number = COMPOSER_MAX,
): { value: string; caret: number } {
  const a = Math.max(0, Math.min(start, value.length))
  const b = Math.max(a, Math.min(end, value.length))
  const room = Math.max(0, max - (value.length - (b - a)))
  let piece = text.slice(0, room)
  // Never leave half a surrogate pair at the cut.
  if (piece.length < text.length && piece.length > 0 && isHighSurrogate(piece.charCodeAt(piece.length - 1))) {
    piece = piece.slice(0, -1)
  }
  return { value: value.slice(0, a) + piece + value.slice(b), caret: a + piece.length }
}

/** What the composer needs from the client, the terminal and the store. */
export interface ComposerIo {
  /** An authenticated socket is OPEN (client.isOpen). */
  isOpen(): boolean
  /** The pane input frames currently go to (subscribedPaneId). */
  currentPaneId(): string | null
  /**
   * Whether the viewed pane takes a bracketed paste (safePaste's
   * pasteBracketed: a claude/codex status, else the xterm's last mode).
   */
  bracketed(): boolean | undefined
  /** Raw input frames (client.sendInput, which chunks). */
  sendInput(data: string): boolean
  /** Turn the Ctrl latch off before a paste (it only acts on 1-char data). */
  releaseLatch(): void
  /** Resolves after ms, or rejects/settles early when signal aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>
}

export interface SendOpts {
  /** Follow with Enter (Send) or not (Insert). */
  enter: boolean
  /** The pane the text was written for. */
  paneId: string
  signal: AbortSignal
  /** Type the text key by key (FR-25) instead of pasting it. */
  slash?: boolean
  /** Slash typing progress. */
  onProgress?: (done: number, total: number) => void
}

/** The send can still go on: not aborted, socket open, same pane. */
function live(io: ComposerIo, paneId: string, signal: AbortSignal): boolean {
  return !signal.aborted && io.isOpen() && io.currentPaneId() === paneId
}

async function pause(io: ComposerIo, ms: number, signal: AbortSignal): Promise<void> {
  try {
    await io.sleep(ms, signal)
  } catch {
    /* aborted: the caller re-checks live() */
  }
}

/**
 * FR-25: type a slash command one character per frame every SLASH_KEY_MS, then
 * Enter. Aborts (false) when the signal fires, the socket drops or the pane
 * changes; characters already typed stay in the agent's prompt.
 */
export async function typeSlash(
  text: string,
  paneId: string,
  io: ComposerIo,
  signal: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<boolean> {
  const chars = Array.from(text.trim())
  io.releaseLatch()
  for (let i = 0; i < chars.length; i++) {
    if (!live(io, paneId, signal)) return false
    if (!io.sendInput(chars[i])) return false
    onProgress?.(i + 1, chars.length)
    await pause(io, SLASH_KEY_MS, signal)
  }
  if (!live(io, paneId, signal)) return false
  return io.sendInput('\r')
}

/**
 * FR-24 Send / FR-26 Insert. Offline (or another pane subscribed) nothing is
 * pasted and false keeps the draft. Otherwise the latch is released, the text
 * goes through safePaste (E3-FR-05: sanitized, `\r` line breaks, bracketed
 * when the pane has it, frames that never split a marker) and, for Send, a
 * separate `\r` frame follows ENTER_DELAY_MS later unless the pane changed or
 * the send was aborted meanwhile. True means the text was delivered, so the
 * caller clears the field and the draft.
 */
export async function sendComposer(text: string, opts: SendOpts, io: ComposerIo): Promise<boolean> {
  const { enter, paneId, signal } = opts
  if (!text || !live(io, paneId, signal)) return false
  if (opts.slash && enter) return typeSlash(text, paneId, io, signal, opts.onProgress)
  io.releaseLatch()
  return safePaste(text, { bracketed: io.bracketed(), enter, signal, live: () => live(io, paneId, signal) }, io)
}

/** Abortable sleep for the default ComposerIo. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const id = setTimeout(done, ms)
    function done(): void {
      clearTimeout(id)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done)
  })
}
