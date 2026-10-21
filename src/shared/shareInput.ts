/**
 * The byte rules of a Share guest's keystrokes (app 2.4.0, item 8), and the
 * "type without send" permission in particular: the guest may type, edit the
 * line and press Esc, but nothing that runs, submits, interrupts or answers.
 *
 * One `ShareInputGate` per (pane, guest session). It is stateful on purpose:
 *  - a lone Esc opens a 1 s window (SHARE_ESC_WINDOW_MS) in which the next
 *    write is gated joined to that Esc, so `\x1b` + `[13u` (CSI-u Enter),
 *    `\x1b` + `[Z` (Shift+Tab), `\x1b` + `OM` (keypad Enter) or `\x1b` + `b`
 *    (Meta+b) sent as two frames fail exactly like the joined sequence. On a
 *    non-agent pane (a shell, whose line editor keeps Esc as a Meta prefix with
 *    no timeout) the next write also joins whenever the pane's last byte is Esc;
 *  - it follows the bracketed paste markers it admitted, so the host can
 *    close a paste a guest left open (`cutPaste`).
 *
 * The host's arbiter is authoritative (`check` before the leases, `commit`
 * once written); the guest renderer runs its own gate as a pre-check. A paste
 * travels as one unit: the guest gates it whole before `splitSharePaste`, and
 * the host joins its parts (`SharePasteAssembler`) and gates the whole again
 * before writing any of it. Pure: no Node, no DOM.
 */
import { REPORTS_ONLY_RE } from './inputReports'
import type { ClaudePaneState, SharePerm } from './types'
import { SHARE_ESC_WINDOW_MS, SHARE_LIMITS, type ShareDenyReason } from './share-protocol'

/** What the host knows about the pane when a guest write arrives. */
export interface ShareInputCtx {
  /**
   * The pane runs an agent: saved type claude/codex, a hand-typed agent in a
   * shell (status.hosted), or a status with a provider.
   */
  agent: boolean
  /** The agent's status state; null/undefined = no status at all. */
  state?: ClaudePaneState | null
  /** false = the status is inferred from the OSC title; absent = precise. */
  precise?: boolean
  /** Last character written to the pane by anyone ('' = nothing yet), for the SSH `~` rule. */
  lastByte: string
  /**
   * app 2.5.0: whether the pane's screen shows a numbered menu (parseMenu),
   * read only while the agent state is not precise (an agent over SSH has no
   * hooks): true blocks like `action`, false lets `type` through, absent
   * (the screen could not be read) fails closed.
   */
  screenMenu?: boolean
}

/** The agent's state cannot be trusted (no status, `unknown`, or a title guess): the screen decides. */
export function shareStateImprecise(ctx: Pick<ShareInputCtx, 'agent' | 'state' | 'precise'>): boolean {
  return ctx.agent && (!ctx.state || ctx.state === 'unknown' || ctx.precise === false)
}

export type ShareGateVerdict =
  | { ok: true }
  /** Terminal reports the host's own xterm already answers: dropped silently. */
  | { ok: false; drop: true }
  | { ok: false; drop: false; reason: ShareDenyReason }

const OK: ShareGateVerdict = { ok: true }
const DROP: ShareGateVerdict = { ok: false, drop: true }
const deny = (reason: ShareDenyReason): ShareGateVerdict => ({ ok: false, drop: false, reason })

/** SGR and X10 mouse reports only (allowed for `full`, dropped for the rest). */
// eslint-disable-next-line no-control-regex
const MOUSE_ONLY_RE = /^(?:\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3})+$/
/** One or two Esc presses: always allowed in `type`, even while the agent waits on a request. */
// eslint-disable-next-line no-control-regex
const ESC_ONLY_RE = /^\x1b{1,2}$/
// eslint-disable-next-line no-control-regex
const SEND_RE = /[\r\n]/
// eslint-disable-next-line no-control-regex
const INTERRUPT_RE = /[\x03\x04\x1a\x1c]/
/**
 * The ESC sequences `type` lets through: arrows and Home/End with an
 * optional modifier (CSI and SS3), Insert/Delete/Home/End/PgUp/PgDn `~`
 * keys, and the bracketed paste markers. Everything else (CSI-u,
 * modifyOtherKeys, Shift+Tab, F keys, Meta+key) is a blocked key.
 */
// eslint-disable-next-line no-control-regex
const CSI_ALLOWED_RE = /^\x1b\[(?:(?:1;[2-8])?[ABCDHF]|[1-6](?:;[2-8])?~|20[01]~)$/
const SS3_FINALS = 'ABCDHF'
/**
 * C0 bytes `type` allows: Ctrl+E/F/H/K/L/N/P/R/T/U/W/Y/_ and DEL (line
 * editing and history). Tab (0x09) is conditional; Ctrl+A/B (tmux and screen
 * prefixes), Ctrl+O (bash operate-and-get-next), Ctrl+G/X (editor), Ctrl+V
 * (image paste from the host clipboard), Ctrl+S/Q, Ctrl+] and NUL are not.
 */
const TYPE_C0 = new Set([0x05, 0x06, 0x08, 0x0b, 0x0c, 0x0e, 0x10, 0x12, 0x14, 0x15, 0x17, 0x19, 0x1f, 0x7f])
// eslint-disable-next-line no-control-regex
const PASTE_MARK_RE = /\x1b\[20([01])~/g
export const PASTE_START = '\x1b[200~'
export const PASTE_END = '\x1b[201~'

/** Length of the allowed ESC token at `i`, or -1 when it is blocked or incomplete. */
function escToken(s: string, i: number): number {
  if (i + 1 >= s.length) return 1 // a lone Esc at the end of the write
  const next = s[i + 1]
  if (next === '\x1b') return 1 // a lone Esc, another sequence follows
  if (next === 'O') {
    const f = s[i + 2]
    return f !== undefined && SS3_FINALS.includes(f) ? 3 : -1
  }
  if (next !== '[') return -1 // ESC + key: a Meta shortcut
  let j = i + 2
  while (j < s.length && s.charCodeAt(j) >= 0x30 && s.charCodeAt(j) <= 0x3f) j++
  while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f) j++
  if (j >= s.length) return -1
  const final = s.charCodeAt(j)
  if (final < 0x40 || final > 0x7e) return -1
  return CSI_ALLOWED_RE.test(s.slice(i, j + 1)) ? j + 1 - i : -1
}

/** The first `type` violation of a write (already free of CR/LF and interrupts), or null. */
function scanTyped(s: string, tabAllowed: boolean): ShareDenyReason | null {
  for (let i = 0; i < s.length; ) {
    const c = s.charCodeAt(i)
    if (c === 0x1b) {
      const n = escToken(s, i)
      if (n < 0) return 'blocked_key'
      i += n
      continue
    }
    if (c === 0x09) {
      if (!tabAllowed) return 'agent_busy'
    } else if (c < 0x20 || c === 0x7f) {
      if (!TYPE_C0.has(c)) return 'blocked_key'
    } else if (c >= 0x80 && c <= 0x9f) {
      return 'blocked_key' // C1 controls (U+009B is CSI to some parsers)
    }
    i++
  }
  return null
}

/** Per (pane, guest session) gate; `now` is injectable for tests. */
export class ShareInputGate {
  private escAt: number | null = null
  private pasteIsOpen = false

  constructor(private readonly now: () => number = Date.now) {}

  /** True while a lone Esc this gate admitted still joins the next write. */
  get escPending(): boolean {
    return this.escAt !== null && this.now() - this.escAt <= SHARE_ESC_WINDOW_MS
  }

  /** True after an admitted `\x1b[200~` with no `\x1b[201~` yet. */
  get pasteOpen(): boolean {
    return this.pasteIsOpen
  }

  /** Judge a write without changing the gate's state. */
  check(data: string, perm: SharePerm, ctx: ShareInputCtx): ShareGateVerdict {
    if (!data) return DROP
    if (REPORTS_ONLY_RE.test(data)) return perm === 'full' && MOUSE_ONLY_RE.test(data) ? OK : DROP
    if (perm === 'view') return deny('view_only')
    if (perm === 'full') return OK
    if (ESC_ONLY_RE.test(data)) return OK
    if (ctx.agent && ctx.state === 'action') return deny('awaiting_host')
    if (shareStateImprecise(ctx)) {
      // A numbered menu on screen would take a typed digit as its answer.
      if (ctx.screenMenu === true) return deny('awaiting_host')
      if (ctx.screenMenu !== false) return deny('not_precise')
    }
    if (SEND_RE.test(data)) return deny('no_send')
    if (INTERRUPT_RE.test(data)) return deny('interrupt')
    // Shells (readline emacs mode, zsh ZLE) keep a bare Esc as a Meta prefix
    // with no timeout: on a non-agent pane the next write joins the pane's last
    // byte, whoever wrote it. Agent TUIs time Esc out, so there the 1 s window holds.
    const joined = this.escPending || (!ctx.agent && ctx.lastByte === '\x1b')
    const bad = scanTyped(joined ? '\x1b' + data : data, !ctx.agent || (ctx.state === 'idle' && ctx.precise !== false))
    if (bad) return deny(bad)
    if (!joined && data[0] === '~' && (ctx.lastByte === '' || ctx.lastByte === '\r' || ctx.lastByte === '\n')) {
      return deny('ssh_escape')
    }
    return OK
  }

  /** Record a write the host actually sent to the pty (after `check` and the leases). */
  commit(data: string): void {
    if (!data) return
    this.escAt = data.endsWith('\x1b') ? this.now() : null
    PASTE_MARK_RE.lastIndex = 0
    for (let m = PASTE_MARK_RE.exec(data); m; m = PASTE_MARK_RE.exec(data)) this.pasteIsOpen = m[1] === '0'
  }

  /**
   * The bytes that close a paste this guest left open ('' when none), and the
   * gate forgets it. The host writes them when an admitted paste is cut off
   * (session end, revoke, a denied follow-up), so the host's next Enter is
   * never swallowed into a paste.
   */
  cutPaste(): string {
    if (!this.pasteIsOpen) return ''
    this.pasteIsOpen = false
    return PASTE_END
  }

  reset(): void {
    this.escAt = null
    this.pasteIsOpen = false
  }
}

/** Atomic units of a write: an ESC sequence, a surrogate pair or one UTF-16 unit. */
function unitEnd(s: string, i: number): number {
  const c = s.charCodeAt(i)
  if (c === 0x1b && i + 1 < s.length) {
    const next = s[i + 1]
    if (next === 'O') return Math.min(s.length, i + 3)
    if (next === '[') {
      let j = i + 2
      while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x3f) j++
      return Math.min(s.length, j + 1)
    }
    return i + 2
  }
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
    const lo = s.charCodeAt(i + 1)
    if (lo >= 0xdc00 && lo <= 0xdfff) return i + 2
  }
  return i + 1
}

/**
 * Split a write into chunks of at most `max` UTF-16 units that never cut an
 * ESC sequence (so a paste marker stays whole) nor a surrogate pair. A unit
 * longer than `max` (never a real keystroke) is cut hard.
 */
export function chunkShareInput(data: string, max: number = SHARE_LIMITS.inputMax): string[] {
  const out: string[] = []
  let start = 0
  let i = 0
  while (i < data.length) {
    const end = unitEnd(data, i)
    if (end - start > max) {
      if (i > start) {
        out.push(data.slice(start, i))
        start = i
      }
      while (end - start > max) {
        out.push(data.slice(start, start + max))
        start += max
      }
    }
    i = end
  }
  if (start < data.length) out.push(data.slice(start))
  return out
}

export interface SharePasteFrame {
  data: string
  paste: { id: number; part: number; last: boolean }
}

/** A paste as the input frames of one unit, or null past SHARE_LIMITS.pasteMax / pasteParts. */
export function splitSharePaste(data: string, id: number): SharePasteFrame[] | null {
  if (!data || data.length > SHARE_LIMITS.pasteMax) return null
  const parts = chunkShareInput(data, SHARE_LIMITS.inputMax)
  if (parts.length > SHARE_LIMITS.pasteParts) return null
  return parts.map((part, i) => ({ data: part, paste: { id, part: i, last: i === parts.length - 1 } }))
}

export type SharePastePush =
  | { kind: 'wait' }
  | { kind: 'done'; paneId: string; data: string }
  | { kind: 'error'; paneId: string; reason: 'paste_too_large' | 'paste_incomplete' }

/**
 * Host side: joins the parts of a guest paste (one per session) so the gate
 * judges the whole paste before any of it is written. Parts arrive in order
 * over one socket; a gap, another pane, another paste id or a plain input in
 * between discards the unfinished paste.
 */
export class SharePasteAssembler {
  private cur: { paneId: string; id: number; next: number; parts: string[]; size: number } | null = null

  get pending(): boolean {
    return this.cur !== null
  }

  push(paneId: string, data: string, paste: { id: number; part: number; last: boolean }): SharePastePush {
    if (paste.part === 0) this.cur = { paneId, id: paste.id, next: 0, parts: [], size: 0 }
    const cur = this.cur
    if (!cur || cur.paneId !== paneId || cur.id !== paste.id || cur.next !== paste.part) {
      this.cur = null
      return { kind: 'error', paneId, reason: 'paste_incomplete' }
    }
    cur.parts.push(data)
    cur.size += data.length
    cur.next++
    if (cur.size > SHARE_LIMITS.pasteMax || (!paste.last && cur.next >= SHARE_LIMITS.pasteParts)) {
      this.cur = null
      return { kind: 'error', paneId, reason: 'paste_too_large' }
    }
    if (!paste.last) return { kind: 'wait' }
    this.cur = null
    return { kind: 'done', paneId, data: cur.parts.join('') }
  }

  /** A plain input or the session's end: the unfinished paste is dropped (nothing of it was written). */
  reset(): boolean {
    const had = this.cur !== null
    this.cur = null
    return had
  }
}
