// Adaptado de stablyai/orca (MIT) - src/main/daemon/headless-emulator.ts
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { screenRowsOf } from '@shared/promptMenu'
import { ModeTracker } from './ModeTracker'

/**
 * A headless xterm.js 5.5 per pty (E6-FR-01..07, FR-35), fed with the exact
 * bytes the renderer and phones receive. A replay is then a serialized screen
 * (scrollback, screen, cursor, alt buffer and modes) instead of the last raw
 * 256 KB, which can start inside an escape sequence and miss modes set long
 * ago, so a reattached or freshly subscribed TUI is right from the first frame.
 *
 * The mirror never answers queries: its onData is not wired to anything, so a
 * DA1 or DSR in the stream gets no reply into the live shell (E6-FR-06).
 */

/** Longest incomplete escape sequence kept as the partial tail (a bigger one is dropped). */
const TAIL_CAP = 4096

export interface MirrorSnapshot {
  data: string
  cols: number
  rows: number
  altScreen: boolean
  /** Buffer rows the snapshot carries (scrollback + screen of the normal buffer). */
  lines: number
}

export interface MirrorOptions {
  cols: number
  rows: number
  scrollback: number
  unicode11: boolean
}

/** Internal write entry point; synchronous parse, present in xterm 5.5 (CoreTerminal.writeSync). */
interface CoreWithWriteSync {
  writeSync?: (data: string) => void
}

/**
 * True when `seq` (starting at ESC) is a whole escape sequence. CSI ends at a
 * final byte (0x40-0x7e); OSC ends at BEL or ST; DCS/APC/PM/SOS end at ST; an
 * ESC with intermediates needs one final byte; anything else is two bytes.
 */
function escapeComplete(seq: string): boolean {
  if (seq.length < 2) return false
  const kind = seq.charCodeAt(1)
  // CAN / SUB abort any sequence back to ground (VT500 parser, as xterm.js).
  const aborted = (from: number): boolean => seq.indexOf('\x18', from) >= 0 || seq.indexOf('\x1a', from) >= 0
  if (kind === 0x18 || kind === 0x1a) return true
  if (kind === 0x5b /* [ */) {
    for (let i = 2; i < seq.length; i++) {
      const c = seq.charCodeAt(i)
      if ((c >= 0x40 && c <= 0x7e) || c === 0x18 || c === 0x1a) return true
    }
    return false
  }
  if (kind === 0x5d /* ] */) return seq.includes('\x07', 2) || aborted(2)
  // DCS, SOS, PM, APC: only ST ends them, and the last ESC would be ST's own.
  if (kind === 0x50 || kind === 0x58 || kind === 0x5e || kind === 0x5f) return aborted(2)
  if (kind >= 0x20 && kind <= 0x2f) {
    for (let i = 2; i < seq.length; i++) {
      const c = seq.charCodeAt(i)
      if ((c >= 0x30 && c <= 0x7e) || c === 0x18 || c === 0x1a) return true
    }
    return false
  }
  return true
}

/**
 * The incomplete escape sequence (or lone high surrogate) at the end of the
 * stream after `data`, given the tail left by the previous write (E6-FR-35).
 * The parser holds those bytes and serialize() drops them, so the replay
 * appends them: the next `out` frame then completes them on the client instead
 * of printing `5;0;0m` as text. A sequence always restarts at an ESC (ESC also
 * cancels a half-read one), so only the last ESC can open the pending one.
 */
export function advancePartialEscapeTail(prev: string, data: string): string {
  if (!data) return prev
  const esc = data.lastIndexOf('\x1b')
  let tail = esc >= 0 ? data.slice(esc) : prev ? prev + data : ''
  if (tail && escapeComplete(tail)) tail = ''
  if (!tail) {
    const last = data.charCodeAt(data.length - 1)
    return last >= 0xd800 && last <= 0xdbff ? data.slice(-1) : ''
  }
  return tail.length > TAIL_CAP ? '' : tail
}

export class HeadlessMirror {
  private readonly term: Terminal
  private readonly serializer = new SerializeAddon()
  /** Modes addon-serialize 0.13 does not emit (?25, ?1006, ?1015, ?1016): rehydrated from here. */
  private readonly modes = new ModeTracker()
  private tail = ''
  private readonly writeSync: ((data: string) => void) | null

  constructor(opts: MirrorOptions) {
    this.term = new Terminal({
      cols: opts.cols,
      rows: opts.rows,
      scrollback: opts.scrollback,
      allowProposedApi: true,
      logLevel: 'off',
    })
    // The addons are typed against @xterm/xterm; the headless Terminal has the same addon API.
    this.term.loadAddon(this.serializer as unknown as Parameters<Terminal['loadAddon']>[0])
    this.term.loadAddon(new Unicode11Addon() as unknown as Parameters<Terminal['loadAddon']>[0])
    this.setUnicode(opts.unicode11)
    const core = (this.term as unknown as { _core?: CoreWithWriteSync })._core
    this.writeSync = core && typeof core.writeSync === 'function' ? core.writeSync.bind(core) : null
  }

  /** True when the synchronous parse path exists (a snapshot is then never behind). */
  get synchronous(): boolean {
    return this.writeSync !== null
  }

  get cols(): number {
    return this.term.cols
  }

  get rows(): number {
    return this.term.rows
  }

  /** Parses `data` now (writeSync); falls back to the async write if xterm dropped it. */
  write(data: string): void {
    if (!data) return
    this.modes.feed(data)
    this.tail = advancePartialEscapeTail(this.tail, data)
    if (this.writeSync) this.writeSync(data)
    else this.term.write(data)
  }

  resize(cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0 || (cols === this.term.cols && rows === this.term.rows)) return
    this.term.resize(cols, rows)
  }

  setUnicode(v11: boolean): void {
    const version = v11 ? '11' : '6'
    if (this.term.unicode.activeVersion !== version) this.term.unicode.activeVersion = version
  }

  setScrollback(lines: number): void {
    if (lines > 0 && this.term.options.scrollback !== lines) this.term.options.scrollback = lines
  }

  /**
   * replay: scrollback + screen + cursor + alt buffer + modes + the partial
   * tail, last. persist: the normal buffer only, no modes, no alt buffer.
   */
  snapshot(opts: { scrollback: number; purpose: 'replay' | 'persist' }): MirrorSnapshot {
    const replay = opts.purpose === 'replay'
    let data = this.serializer.serialize({ scrollback: opts.scrollback, excludeModes: true, excludeAltBuffer: !replay })
    if (replay) data += this.extraModes() + this.tail
    const normal = this.term.buffer.normal
    return {
      data,
      cols: this.term.cols,
      rows: this.term.rows,
      altScreen: this.term.buffer.active.type === 'alternate',
      lines: Math.min(normal.length, opts.scrollback + this.term.rows),
    }
  }

  /**
   * v2.4: the pty screen rows (baseY .. baseY + rows, soft wraps joined), the
   * same read the phone does on its live xterm. Main parses Claude's answer
   * menu off it for the Chat view's cards (PromptMenuWatcher, answerMenu).
   */
  screenRows(): string[] {
    return screenRowsOf(this.term)
  }

  dispose(): void {
    this.term.dispose()
  }

  /**
   * The tracker's modes (the alt switch is already in the serialized text),
   * plus the few xterm modes the tracker does not follow. DECOM is left out on
   * purpose: setting it homes the cursor, and the scroll region it is relative
   * to is not serialized either.
   */
  private extraModes(): string {
    const m = this.term.modes
    let out = this.modes.rehydrate(false)
    if (m.applicationKeypadMode) out += '\x1b[?66h'
    if (m.insertMode) out += '\x1b[4h'
    if (m.reverseWraparoundMode) out += '\x1b[?45h'
    if (!m.wraparoundMode) out += '\x1b[?7l'
    return out
  }
}
