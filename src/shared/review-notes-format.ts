// Adaptado de stablyai/orca (MIT) - src/shared/diff-comments-format.ts y sanitizeBracketedPasteText

/**
 * The text a batch of review notes becomes in the agent's input (E7-FR-19,
 * Design D). Same format as Orca, which Claude Code and Codex already read:
 *
 *   File: src/main/Foo.ts
 *   Lines: 40-52
 *   User comment: "use a Map here\ncheck for null"
 *
 * Each note carries `Line: N`, `Lines: a-b` or `Scope: file`; the comment is
 * one line (backslash, quote, CR and LF escaped). Notes are sorted by file,
 * then by line, and separated by a blank line. The desktop, the phone ctl
 * (inline notes) and the tests all go through `buildReviewNotesText`, so the
 * format has a single owner. No imports.
 */

/** The shape shared with the `sendReviewNotes` ctl: `lines` is '40', '40-52' or ''. */
export interface ReviewNotePayload {
  file: string
  lines: string
  comment: string
}

const LINES_RE = /^(\d{1,9})(?:-(\d{1,9}))?$/

/** Range of a `lines` value, or null for a file note (also for a malformed value). */
export function parseLines(lines: string): { start: number; end: number } | null {
  const m = LINES_RE.exec(lines)
  if (!m) return null
  const start = Number(m[1])
  const end = m[2] === undefined ? start : Number(m[2])
  if (start < 1 || end < start) return null
  return { start, end }
}

/** `Line: 40`, `Lines: 40-52` or `Scope: file`. */
export function linesLabel(lines: string): string {
  const r = parseLines(lines)
  if (!r) return 'Scope: file'
  return r.start === r.end ? `Line: ${r.start}` : `Lines: ${r.start}-${r.end}`
}

/** The comment as one quoted line: `\` -> `\\`, `"` -> `\"`, CR -> `\r`, LF -> `\n`. */
export function escapeComment(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')
}

/** Batch order: by file, then by line; a file note goes first. */
export function compareNotes(a: ReviewNotePayload, b: ReviewNotePayload): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1
  const ra = parseLines(a.lines)
  const rb = parseLines(b.lines)
  const sa = ra ? ra.start : 0
  const sb = rb ? rb.start : 0
  if (sa !== sb) return sa - sb
  return (ra ? ra.end : 0) - (rb ? rb.end : 0)
}

/** The batch text before sanitizing (stable sort: equal notes keep their order). */
export function formatReviewNotes(notes: readonly ReviewNotePayload[]): string {
  return [...notes]
    .sort(compareNotes)
    .map((n) => `File: ${n.file}\n${linesLabel(n.lines)}\nUser comment: "${escapeComment(n.comment)}"`)
    .join('\n\n')
}

/**
 * Makes text safe inside a bracketed paste frame: ESC becomes U+241B (a
 * `ESC[201~` in a comment can never close the frame early), every other C0
 * control but tab and LF, DEL and the C1 range become U+FFFD.
 */
export function sanitizeForPaste(text: string): string {
  let out = ''
  for (const ch of text) {
    const c = ch.codePointAt(0) as number
    if (c === 0x1b) out += '␛'
    else if (c === 0x09 || c === 0x0a) out += ch
    else if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) out += '�'
    else out += ch
  }
  return out
}

/** Formatted and sanitized: exactly what is pasted. */
export function buildReviewNotesText(notes: readonly ReviewNotePayload[]): string {
  return sanitizeForPaste(formatReviewNotes(notes))
}

/** UTF-8 size of a string (the batch limit counts bytes). */
export function utf8Bytes(text: string): number {
  let n = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) as number
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
  }
  return n
}
