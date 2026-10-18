import { lstatSync, statSync } from 'fs'
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

/**
 * An existing file. On Windows a Store app (pwsh from the Microsoft Store,
 * python, wt) is an App Execution Alias in WindowsApps: a reparse point that
 * stat() rejects with EACCES and lstat() shows as a link, yet CreateProcess
 * (and node-pty's own GetFileAttributes check) launches it fine.
 */
const defaultIsFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    try {
      const l = lstatSync(path)
      return l.isFile() || l.isSymbolicLink()
    } catch {
      return false
    }
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
 * Where `requested` lives, or null when it does not exist: an absolute (or
 * relative with separators) path must exist; a bare name must be found in PATH,
 * trying the PATHEXT extensions on Windows when it has none of them. On Windows
 * the hit is returned absolute, because node-pty's own lookup knows no PATHEXT,
 * no quoted PATH entries and no path relative to the working directory.
 */
export function findShell(requested: string, deps: ResolveShellDeps = {}): string | null {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const isFile = deps.isFile ?? defaultIsFile
  const win = platform === 'win32'
  const p = win ? win32 : posix
  const hasSep = win ? /[\\/]/.test(requested) : requested.includes('/')
  if (p.isAbsolute(requested) || hasSep) {
    if (!isFile(requested)) return null
    return win && !p.isAbsolute(requested) ? p.resolve(requested) : requested
  }
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
    for (const c of candidates) {
      const hit = p.join(d, c)
      if (isFile(hit)) return win ? hit : requested
    }
  }
  return null
}

/** True when `requested` names an executable that exists (see findShell). */
export function shellExists(requested: string, deps: ResolveShellDeps = {}): boolean {
  return findShell(requested, deps) !== null
}

/**
 * Picks the shell for a spawn. An empty request means the OS default. A
 * configured shell that does not exist falls back to the default and reports a
 * warning, so the pane still opens and tells the user why.
 */
export function resolveShell(requested: string | undefined, fallback: string, deps: ResolveShellDeps = {}): ResolvedShell {
  const wanted = (requested ?? '').trim().replace(/^"(.*)"$/, '$1').trim()
  if (!wanted) return { shell: fallback, shellKind: shellKindOf(fallback) }
  const found = findShell(wanted, deps)
  if (found) return { shell: found, shellKind: shellKindOf(found) }
  return {
    shell: fallback,
    shellKind: shellKindOf(fallback),
    warning: { kind: 'shellNotFound', requested: wanted, used: fallback },
  }
}
