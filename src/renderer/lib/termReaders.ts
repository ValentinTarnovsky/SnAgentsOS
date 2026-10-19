/**
 * Per-pane terminal readers for `snaos read` (E8-FR-17): what the xterm shows,
 * scrollback + screen, as plain lines. Same pattern as redrawRegistry: useXterm
 * registers on mount and unregisters on unmount; a pane without a mounted
 * terminal has no reader and main falls back to its own ring.
 */

/** The slice of xterm's IBuffer the reader needs (kept structural for tests). */
export interface BufferLike {
  length: number
  getLine(y: number): { isWrapped: boolean; translateToString(trimRight?: boolean): string } | undefined
}

export type TermReader = (lines: number) => string[]

const readers = new Map<string, TermReader>()

export function registerTermReader(paneId: string, reader: TermReader): void {
  readers.set(paneId, reader)
}

/** Drops the pane's reader (only `reader` when given: a newer mount keeps its own). */
export function unregisterTermReader(paneId: string, reader?: TermReader): void {
  if (!reader || readers.get(paneId) === reader) readers.delete(paneId)
}

/** The last `lines` lines of the pane's terminal, or null without a mounted xterm. */
export function readTerm(paneId: string, lines: number): string[] | null {
  const reader = readers.get(paneId)
  return reader ? reader(lines) : null
}

/**
 * The last `n` logical lines of a buffer: rows soft-wrapped by the terminal
 * are joined back into one line, blank rows under the last output are
 * skipped. Walks from the bottom, so 2000 lines cost 2000 rows at most.
 */
export function readBufferLines(buf: BufferLike, n: number): string[] {
  let end = buf.length
  while (end > 0 && !(buf.getLine(end - 1)?.translateToString(true) ?? '').trim()) end--
  const out: string[] = []
  let y = end - 1
  while (y >= 0 && out.length < n) {
    let text = buf.getLine(y)?.translateToString(true) ?? ''
    // A wrapped row continues the one above it: the earlier rows keep their trailing spaces.
    while (y > 0 && buf.getLine(y)?.isWrapped) {
      y--
      text = (buf.getLine(y)?.translateToString(false) ?? '') + text
    }
    out.push(text)
    y--
  }
  return out.reverse()
}
