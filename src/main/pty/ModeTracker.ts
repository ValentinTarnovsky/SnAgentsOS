/**
 * Tracks the DEC private modes a pty's output has switched on (E6-FR-33), so a
 * replay built from the bounded output ring can re-enable modes whose DECSET
 * already scrolled out of it. Without this a phone that subscribes to a Claude
 * pane after an hour of output never sees `?1000h`/`?1006h`, so its swipe is
 * not reported to the TUI, and a reloaded desktop pane loses bracketed paste.
 *
 * A small hand-written scanner, always on, fed with every raw pty chunk. It
 * only understands `ESC [ ? Pm h|l` (including lists like `?1000;1006h`), the
 * soft reset `ESC [ ! p` and the full reset `ESC c`; everything else is
 * skipped. Its state survives across feed() calls, so a sequence split between
 * two chunks (`\x1b[?10` + `06h`) still registers. Semantics follow xterm.js
 * 5.5 (the emulator on both ends), so rehydrate() replays the exact end state.
 */

/** Longest parameter list kept while waiting for the final byte. */
const MAX_PARAMS = 32

const enum St {
  Ground,
  Esc,
  Csi,
  Private,
  Bang,
}

type MouseProtocol = 0 | 9 | 1000 | 1002 | 1003
type MouseEncoding = 0 | 1006 | 1016

export class ModeTracker {
  private st: St = St.Ground
  private params = ''
  /** ?1 application cursor keys (DECCKM). */
  private appCursor = false
  /** ?25 reset: cursor hidden (DECTCEM default is visible). */
  private cursorHidden = false
  /** ?9 / ?1000 / ?1002 / ?1003: one active mouse protocol at a time. */
  private mouse: MouseProtocol = 0
  /** ?1006 / ?1016: one active report encoding at a time. */
  private encoding: MouseEncoding = 0
  /** ?1015 urxvt encoding (tracked on its own; xterm.js ignores it). */
  private urxvt = false
  /** ?1004 focus in/out reports. */
  private focus = false
  /** ?1049 (also ?47 / ?1047): alternate screen buffer. */
  private alt = false
  /** ?2004 bracketed paste. */
  private bracketed = false

  get altScreen(): boolean {
    return this.alt
  }

  feed(data: string): void {
    const n = data.length
    let i = 0
    while (i < n) {
      if (this.st === St.Ground) {
        // Plain text dominates the stream: jump straight to the next ESC.
        const at = data.indexOf('\x1b', i)
        if (at < 0) return
        this.st = St.Esc
        i = at + 1
        continue
      }
      const ch = data.charCodeAt(i)
      i++
      if (ch === 0x1b) {
        // ESC always restarts a sequence (it also cancels a half-read one).
        this.st = St.Esc
        this.params = ''
        continue
      }
      switch (this.st) {
        case St.Esc:
          if (ch === 0x5b /* [ */) this.st = St.Csi
          else {
            if (ch === 0x63 /* c, RIS */) this.reset()
            this.st = St.Ground
          }
          break
        case St.Csi:
          if (ch === 0x3f /* ? */) {
            this.st = St.Private
            this.params = ''
          } else if (ch === 0x21 /* ! */) this.st = St.Bang
          else this.st = St.Ground
          break
        case St.Bang:
          if (ch === 0x70 /* p, DECSTR */) this.softReset()
          this.st = St.Ground
          break
        case St.Private:
          if ((ch >= 0x30 && ch <= 0x39) || ch === 0x3b /* ; */) {
            if (this.params.length >= MAX_PARAMS) this.st = St.Ground
            else this.params += String.fromCharCode(ch)
          } else {
            if (ch === 0x68 /* h */ || ch === 0x6c /* l */) this.apply(this.params, ch === 0x68)
            this.st = St.Ground
          }
          break
      }
    }
  }

  /** Sequences re-enabling every non-default mode; '\x1b[?1049h' first if alt screen. */
  rehydrate(): string {
    let out = this.alt ? '\x1b[?1049h' : ''
    if (this.appCursor) out += '\x1b[?1h'
    if (this.cursorHidden) out += '\x1b[?25l'
    if (this.mouse) out += `\x1b[?${this.mouse}h`
    if (this.urxvt) out += '\x1b[?1015h'
    if (this.encoding) out += `\x1b[?${this.encoding}h`
    if (this.focus) out += '\x1b[?1004h'
    if (this.bracketed) out += '\x1b[?2004h'
    return out
  }

  private apply(params: string, on: boolean): void {
    for (const part of params.split(';')) {
      if (part === '') continue
      const mode = Number(part)
      switch (mode) {
        case 1: this.appCursor = on; break
        case 25: this.cursorHidden = !on; break
        case 9: case 1000: case 1002: case 1003:
          // xterm.js: setting picks the protocol, resetting ANY of them clears it.
          this.mouse = on ? mode : 0
          break
        case 1006: case 1016:
          this.encoding = on ? mode : 0
          break
        case 1015: this.urxvt = on; break
        case 1004: this.focus = on; break
        case 47: case 1047: case 1049: this.alt = on; break
        case 2004: this.bracketed = on; break
      }
    }
  }

  /** DECSTR: xterm.js shows the cursor and resets its DEC private modes, not mouse or alt. */
  private softReset(): void {
    this.cursorHidden = false
    this.appCursor = false
    this.focus = false
    this.bracketed = false
  }

  /** RIS (ESC c): everything back to default. */
  private reset(): void {
    this.appCursor = false
    this.cursorHidden = false
    this.mouse = 0
    this.encoding = 0
    this.urxvt = false
    this.focus = false
    this.alt = false
    this.bracketed = false
  }
}
