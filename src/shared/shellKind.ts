/**
 * Shell family for the initial prompt of an agent console (E2-FR-11, D1):
 * decides how the prompt variable is referenced on the command line. Pure: no
 * Node or DOM imports, shared by main (revalidation with the resolved shell),
 * the renderer and the phone's executor (prediction).
 */

export type PromptShellKind = 'powershell' | 'posix' | 'cmd' | 'unknown'

const POSIX = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh'])

/**
 * Family of a shell executable from its basename: `powershell(.exe)`, `pwsh`
 * give powershell; bash, zsh, sh, fish (and dash, ksh) give posix; `cmd.exe`
 * gives cmd; anything else (nu, wsl, a custom binary) is unknown. On win32 the
 * `.exe` / `.cmd` / `.bat` extension is ignored and the name is
 * case-insensitive; elsewhere the name must match exactly.
 */
export function shellKind(shellPath: string | undefined, platform: string): PromptShellKind {
  const raw = (shellPath ?? '').trim().replace(/^"(.*)"$/, '$1')
  if (!raw) return 'unknown'
  const win = platform === 'win32'
  let name = raw.replace(/\\/g, '/').split('/').pop() ?? ''
  if (win) name = name.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '')
  if (name === 'powershell' || name === 'pwsh') return 'powershell'
  if (win && name === 'cmd') return 'cmd'
  if (POSIX.has(name)) return 'posix'
  return 'unknown'
}

/**
 * The same family from the `ShellKind` PtyManager already reports
 * ('powershell' | 'cmd' | 'posix' | 'other'): 'other' is unknown.
 */
export function promptShellKindOf(kind: string | null | undefined): PromptShellKind {
  return kind === 'powershell' || kind === 'posix' || kind === 'cmd' ? kind : 'unknown'
}
