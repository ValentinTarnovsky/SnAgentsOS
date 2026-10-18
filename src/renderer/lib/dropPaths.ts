// Adaptado de stablyai/orca (MIT) - src/renderer/src/components/terminal-pane/terminal-drop-image-path.ts, terminal-drop-path-writer.ts, pane-helpers.ts y src/shared/image-file-extensions.ts

/**
 * Turns the paths of a file drop into the text that goes to a console (E7-FR-01..02).
 *
 * - `agent`: Claude Code / Codex with bracketed paste. Each path is its own
 *   `term.paste` (an agent only attaches an image when one paste event is
 *   exactly one path). Images go raw (or double quoted when they hold a
 *   shell-unsafe char) so the agent attaches them as `[Image #N]`; two raw
 *   images in a row get no space between them, the format both agents
 *   recognize. Other files use the Windows escape and are followed by a space.
 * - `safe`: any other console with bracketed paste (bash over SSH/WSL,
 *   PSReadLine with mode 2004). Every path uses the Windows escape and is
 *   followed by a space. Sent with `term.paste`.
 * - `plain`: no bracketed paste. The 1.14.1 behavior, byte for byte: every
 *   path double quoted, space separated, trailing space, written to the pty.
 *
 * Never a `cd`, never an Enter. A path with any control byte (C0, DEL, C1)
 * voids the whole drop.
 */
export type DropMode = 'agent' | 'safe' | 'plain'

export interface DropPayload {
  /** `paste` goes through xterm (`pasteToPane`); `write` straight to the pty. */
  kind: 'paste' | 'write'
  /** Everything that reaches the console, in order (`parts` joined). */
  text: string
  /** One entry per `term.paste` / `pty.write` call, in order. */
  parts: string[]
}

/** Image extensions the agents attach, case-insensitive. */
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'] as const

/** Shell-unsafe chars on Windows: whitespace, quotes, ` $ ; & | < > ( ) { } [ ] * ? ! # ^ % */
const WINDOWS_UNSAFE = /[\s"'`$;&|<>(){}[\]*?!#^%]/
/** Chars that never need quoting in a path. */
const WINDOWS_PLAIN = /^[a-zA-Z0-9_./@:\\-]+$/
/** C0 controls, DEL and C1 controls. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/

export function isImagePath(path: string): boolean {
  const lower = path.toLowerCase()
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/** Whether an image path can be pasted to an agent without quotes. */
export function canPasteRaw(path: string): boolean {
  return !WINDOWS_UNSAFE.test(path)
}

/** Windows shell escape: raw when only plain chars, else double quoted. */
export function escapeWindowsPath(path: string): string {
  return WINDOWS_PLAIN.test(path) ? path : `"${path}"`
}

export function hasControlChars(text: string): boolean {
  return CONTROL_CHARS.test(text)
}

/**
 * Build the text for a drop of `paths` in a console of the given mode. Null
 * when nothing should be written: no usable path, or any path carries a
 * control byte.
 */
export function buildDropPayload(paths: readonly string[], mode: DropMode): DropPayload | null {
  const list = paths.filter((p) => typeof p === 'string' && p.length > 0)
  if (list.length === 0) return null
  if (list.some(hasControlChars)) return null

  if (mode === 'plain') {
    const text = `${list.map((p) => `"${p}"`).join(' ')} `
    return { kind: 'write', text, parts: [text] }
  }
  if (mode === 'safe') {
    const text = list.map((p) => `${escapeWindowsPath(p)} `).join('')
    return { kind: 'paste', text, parts: [text] }
  }

  const parts: string[] = []
  let prevRawImage = false
  for (const p of list) {
    const image = isImagePath(p)
    const raw = image && canPasteRaw(p)
    // Separator rule: a space between items unless the previous one already
    // ended in one (files carry their own) or both are raw images. The space
    // is a paste of its own so an image paste stays exactly its path.
    const prev = parts[parts.length - 1]
    if (prev !== undefined && !prev.endsWith(' ') && !(prevRawImage && raw)) parts.push(' ')
    if (image) parts.push(raw ? p : `"${p}"`)
    else parts.push(`${escapeWindowsPath(p)} `)
    prevRawImage = raw
  }
  return { kind: 'paste', text: parts.join(''), parts }
}
