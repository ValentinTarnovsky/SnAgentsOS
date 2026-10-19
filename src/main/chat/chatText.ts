/**
 * Text hygiene shared by the transcript decoders (E3 M12): ANSI escapes and
 * control characters out (tabs and line breaks stay, since markdown and tool
 * output need them), bounded cuts that never split a surrogate pair. The
 * phone renders every string as text nodes, so this is about legibility and
 * the frame budget, not about HTML safety.
 */

// CSI / OSC / DCS-style escapes and lone ESC pairs.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[@-Z\\-_])/g
// C0 except \t and \n, DEL and C1.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g

/** Strips escapes and control characters; `\r\n` and lone `\r` become `\n`. */
export function cleanText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(ANSI_RE, '').replace(CONTROL_RE, '')
}

/** One line: whitespace runs collapsed, edges trimmed. */
export function oneLine(text: string): string {
  return cleanText(text).replace(/\s+/g, ' ').trim()
}

/** At most `max` UTF-16 units, never ending on half a surrogate pair. */
export function cutAt(text: string, max: number): string {
  if (text.length <= max) return text
  let end = Math.max(0, max)
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end--
  return text.slice(0, end)
}

/** cleanText, then cut to `max` with the flag the block carries. */
export function boundedText(text: string, max: number): { text: string; truncated?: true } {
  const clean = cleanText(text)
  if (clean.length <= max) return { text: clean }
  return { text: cutAt(clean, max), truncated: true }
}

/** One line cut to `max` with a trailing ellipsis inside the limit. */
export function clipLine(text: string, max: number): string {
  const line = oneLine(text)
  if (line.length <= max) return line
  return cutAt(line, max - 1).trimEnd() + '…'
}

/** Epoch ms of an ISO timestamp (or a number), null when unusable. */
export function tsOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** Last path segment, for either separator. */
export function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}
