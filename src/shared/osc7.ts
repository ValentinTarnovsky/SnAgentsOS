/**
 * OSC 7 (`ESC ] 7 ; file://host/path BEL`): the shell reports its working
 * folder at every prompt. The PowerShell integration writes it, and most
 * Linux and macOS shell setups already do. It gives each console its own
 * folder, so a console that `cd`s into a repo inside a non-repo workspace
 * shows that repo's git chip.
 */

/** Longest folder accepted from a terminal. */
const MAX_PATH = 4096

/**
 * Folder from an OSC 7 payload, or null. The host part is ignored (a remote
 * shell reports its own machine, and the chip only means something locally:
 * main runs git there and fails quietly on a folder it does not have). On
 * Windows `file:///C:/x` becomes `C:\x`.
 */
export function parseOsc7(data: string, platform: string): string | null {
  const m = /^file:\/\/[^/]*(\/.*)$/i.exec(data.trim())
  if (!m) return null
  let path: string
  try {
    path = decodeURIComponent(m[1])
  } catch {
    path = m[1]
  }
  if (!path || path.length > MAX_PATH || /[\0\r\n]/.test(path)) return null
  if (platform === 'win32') {
    // "/C:/Users/x" -> "C:\Users\x"; a UNC "//server/share" keeps its two slashes.
    if (/^\/[a-z]:/i.test(path)) path = path.slice(1)
    path = path.replace(/\//g, '\\')
    if (/^[a-z]:$/i.test(path)) path += '\\'
    if (!/^(?:[a-z]:\\|\\\\)/i.test(path)) return null
  }
  return path
}

/** Same folder, ignoring trailing separators and, on Windows, case and slash direction. */
export function samePath(a: string, b: string, platform: string): boolean {
  const norm = (p: string): string => {
    let s = platform === 'win32' ? p.replace(/\//g, '\\').toLowerCase() : p
    while (s.length > 1 && /[\\/]$/.test(s) && !/^[a-z]:\\$/i.test(s)) s = s.slice(0, -1)
    return s
  }
  return norm(a) === norm(b)
}
