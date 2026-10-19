/**
 * Plain text from raw terminal output, for the `snaos read` fallback when a
 * pane has no mounted xterm (E8-FR-17): main's 256 KB ring without escape
 * sequences, with carriage returns honored (a spinner redrawing its line
 * keeps only its last frame). Pure; cursor-addressed TUI screens cannot be
 * rebuilt from the stream, which is why the xterm buffer is the first choice.
 */

/* eslint-disable no-control-regex */
// OSC (BEL or ST terminated), DCS / SOS / PM / APC strings (ST terminated),
// CSI with its parameters, then any other two-byte ESC sequence (charset
// designations take one more byte). An unterminated string at the end of the
// chunk is dropped too.
const ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)|\x1b[PX^_][\s\S]*?(?:\x1b\\|$)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()*+,\-./][\s\S]?|\x1b[\s\S]?|\x9b[0-?]*[ -/]*[@-~]/g
/** C0 / C1 controls that never print (tab, CR, LF and backspace are handled apart). */
const CONTROLS = /[\x00-\x07\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/g
/* eslint-enable no-control-regex */

/** Private-use stand-ins for "erase to end of line" and "erase whole line" (CSI K), applied by renderLine. */
const ERASE_EOL = ''
const ERASE_LINE = ''

/** Removes escape sequences and non-printing controls; keeps \n, \r, \t and \b. */
export function stripEscapes(text: string): string {
  return text.replace(ESCAPES, '').replace(CONTROLS, '')
}

/**
 * One physical line with `\r`, `\b` and erase-in-line applied: a bare
 * carriage return moves back to column 0 and what follows overwrites, a
 * backspace moves back one, an erase drops the rest of the line.
 */
function renderLine(line: string): string {
  const out: string[] = []
  let col = 0
  for (const ch of line) {
    if (ch === '\r') col = 0
    else if (ch === '\b') col = Math.max(0, col - 1)
    else if (ch === ERASE_EOL) out.length = Math.min(out.length, col)
    else if (ch === ERASE_LINE) out.length = 0
    else {
      while (out.length < col) out.push(' ')
      out[col] = ch
      col++
    }
  }
  return out.join('').replace(/\s+$/, '')
}

/** Raw output -> readable text: escapes gone, CR/LF normalized, overwrites applied. */
export function stripAnsi(text: string): string {
  return stripEscapes(text.replace(/\x1b\[0?K/g, ERASE_EOL).replace(/\x1b\[2K/g, ERASE_LINE))
    .replace(/\r+\n/g, '\n')
    .split('\n')
    .map(renderLine)
    .join('\n')
}

/** The last `n` lines of `text`, trailing blank lines dropped first. */
export function tailLines(text: string, n: number): string[] {
  const lines = text.split('\n')
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  return n > 0 ? lines.slice(-n) : []
}
