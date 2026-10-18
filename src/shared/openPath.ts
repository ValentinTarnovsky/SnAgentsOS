/**
 * Comparison key of a folder for "Open in SnAgentsOS" (E4-FR-33): Windows
 * semantics without Node's path module, so main and the renderer share it.
 * Backslashes only, `.`/`..` resolved, duplicate separators collapsed (a UNC
 * `\\` prefix survives), lowercase and no trailing separator (`C:\` -> `c:`).
 * Only for matching: the path that is opened keeps its original spelling.
 */
export function normalizeOpenPath(p: string): string {
  const raw = String(p ?? '').trim().replace(/\//g, '\\')
  if (!raw) return ''
  const unc = raw.startsWith('\\\\')
  const parts = raw.split('\\').filter(Boolean)
  const out: string[] = []
  for (const part of parts) {
    if (part === '.') continue
    if (part === '..') {
      // Never climb above the drive or the UNC \\server\share root.
      if (out.length > (unc ? 2 : 1)) out.pop()
      continue
    }
    out.push(part)
  }
  return ((unc ? '\\\\' : '') + out.join('\\')).toLowerCase()
}
