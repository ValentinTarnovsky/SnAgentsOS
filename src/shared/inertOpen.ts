/**
 * "Open on the PC" from the phone (E2-FR-29/30). Shared by main (pathOpen.ts
 * decides) and the phone (links.ts only picks the label), so the two can never
 * disagree on which extensions open.
 *
 * Only inert formats: on Windows shell.openPath runs the default association,
 * so `.js` would run in Windows Script Host, `.py` in the launcher and
 * `.html`/`.svg` would run local JS over file://. Everything else is revealed
 * in the file manager instead.
 */
export const INERT_OPEN_EXTENSIONS: readonly string[] = [
  '.txt', '.md', '.json', '.yaml', '.yml', '.toml', '.log', '.csv',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf',
]

/** Errors `shell:openPath` (and the `openPath` ctl ack) can carry. */
export type OpenPathError = 'denied_path' | 'not_found' | 'rate' | 'bad_request'

/** Request of `shell:openPath`: `cwd` is the root ('' = home), `path` raw from the terminal. */
export interface OpenPathReq {
  cwd: string
  path: string
}

export interface OpenPathRes {
  ok: boolean
  error?: OpenPathError
}

/** Max length of `cwd` and `path` (bad_request past it). */
export const OPEN_PATH_MAX = 4096

/** Drop a trailing `:line` or `:line:col` (src/App.tsx:12:3 -> src/App.tsx). */
export function stripLineCol(raw: string): string {
  return raw.replace(/(?::\d+){1,2}$/, '')
}

/** Lowercase extension with the dot ('' without one), separators of both kinds. */
export function extensionOf(p: string): string {
  const base = p.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot).toLowerCase() : ''
}

/** True when the extension is on the inert allowlist. */
export function isInertOpenPath(p: string): boolean {
  return INERT_OPEN_EXTENSIONS.includes(extensionOf(stripLineCol(p)))
}
