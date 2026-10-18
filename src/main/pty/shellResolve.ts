import { existsSync, statSync } from 'fs'
import { basename, posix, win32 } from 'path'
import type { PtySpawnRes, ShellKind } from '@shared/ipc-contract'

/** What spawn() launches for a requested shell (E6-FR-32). */
export interface ResolvedShell {
  /** Executable handed to node-pty. */
  shell: string
  shellKind: ShellKind
  /** Set when the requested shell was not found and the default was used. */
  warning?: PtySpawnRes['warning']
}

export interface ResolveShellDeps {
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  /** True when the path names an existing file (injected by tests). */
  isFile?: (path: string) => boolean
}

const defaultIsFile = (path: string): boolean => {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

/** Case-insensitive env lookup (Windows keeps `Path`, POSIX keeps `PATH`). */
function envValue(env: Record<string, string | undefined>, key: string): string {
  const hit = Object.keys(env).find((k) => k.toUpperCase() === key)
  return (hit && env[hit]) || ''
}

/** Family of a shell executable, derived from its file name. */
export function shellKindOf(shell: string): ShellKind {
  const name = basename(shell.replace(/\\/g, '/')).toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '')
  if (name === 'powershell' || name === 'pwsh') return 'powershell'
  if (name === 'cmd') return 'cmd'
  if (['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'ash', 'tcsh', 'csh', 'nu', 'wsl', 'busybox'].includes(name)) return 'posix'
  return 'other'
}

/**
 * True when `requested` names an executable that exists: an absolute (or
 * relative with separators) path must exist; a bare name must be found in PATH,
 * trying the PATHEXT extensions on Windows when it has none of them.
 */
export function shellExists(requested: string, deps: ResolveShellDeps = {}): boolean {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const isFile = deps.isFile ?? defaultIsFile
  const win = platform === 'win32'
  const p = win ? win32 : posix
  const hasSep = win ? /[\\/]/.test(requested) : requested.includes('/')
  if (p.isAbsolute(requested) || hasSep) return isFile(requested)
  const exts = win
    ? (envValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : []
  const ownExt = p.extname(requested).toLowerCase()
  const candidates = win && !exts.some((e) => e.toLowerCase() === ownExt)
    ? [requested, ...exts.map((e) => requested + e.toLowerCase())]
    : [requested]
  for (const dir of envValue(env, 'PATH').split(p.delimiter)) {
    const d = dir.trim().replace(/^"|"$/g, '')
    if (!d) continue
    for (const c of candidates) if (isFile(p.join(d, c))) return true
  }
  return false
}

/**
 * Picks the shell for a spawn. An empty request means the OS default. A
 * configured shell that does not exist falls back to the default and reports a
 * warning, so the pane still opens and tells the user why.
 */
export function resolveShell(requested: string | undefined, fallback: string, deps: ResolveShellDeps = {}): ResolvedShell {
  const wanted = (requested ?? '').trim().replace(/^"(.*)"$/, '$1').trim()
  if (!wanted) return { shell: fallback, shellKind: shellKindOf(fallback) }
  if (shellExists(wanted, deps)) return { shell: wanted, shellKind: shellKindOf(wanted) }
  return {
    shell: fallback,
    shellKind: shellKindOf(fallback),
    warning: { kind: 'shellNotFound', requested: wanted, used: fallback },
  }
}
