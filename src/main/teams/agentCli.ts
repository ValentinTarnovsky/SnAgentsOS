// Adaptado de paperclipai/paperclip (MIT) - packages/adapter-utils/src/server-utils.ts
/**
 * The `claude` / `codex` executable a team run starts (app 2.7.0, Tanda B,
 * design 3.5, decision 12; spike S5) and how to spawn it without a shell.
 *
 * PATH order with two rules of our own: the app's launcher folders are never
 * used (status-bin holds a `codex.cmd` shim of the app that `where codex`
 * lists first, and dataDir()/bin holds `snaos`), and on Windows an `.exe`
 * anywhere in PATH wins over any `.cmd` (a `.cmd` needs cmd.exe in between,
 * which makes the tree deeper and quoting harder).
 */
import { accessSync, constants, statSync } from 'fs'
import { join, posix, win32 } from 'path'
import type { AgentProvider } from '@shared/types'
import { dataDir } from '../paths'
import { statusBinDirs } from '../pty/shellResolver'

export interface ResolvedCli { file: string; args: string[]; kind: 'exe' | 'cmd' | 'posix' }

/** Two leading separators: a UNC share or a device path, never probed (touching one reaches the network). */
const UNC_RE = /^[\\/]{2}/

function defaultSkipDirs(): string[] {
  return [...statusBinDirs(), join(dataDir(), 'bin')]
}

function defaultIsFile(platform: NodeJS.Platform): (p: string) => boolean {
  return (p) => {
    try {
      if (!statSync(p).isFile()) return false
      if (platform !== 'win32') accessSync(p, constants.X_OK)
      return true
    } catch {
      return false
    }
  }
}

/** Absolute PATH dirs only (never the cwd); skips statusBinDirs() and <dataDir>/bin; per dir `.exe` before `.cmd` on win32 (decision 12). */
export function resolveAgentCli(provider: AgentProvider, env: Record<string, string>, deps: { platform?: NodeJS.Platform; isFile?: (p: string) => boolean; skipDirs?: string[] } = {}): ResolvedCli | null {
  const platform = deps.platform ?? process.platform
  const win = platform === 'win32'
  const p = win ? win32 : posix
  // Folder identity with the rules of `platform`: case-insensitive on Windows, no trailing separator.
  const key = (d: string): string => {
    const abs = p.resolve(d).replace(/[\\/]+$/, '')
    return win ? abs.toLowerCase() : abs
  }
  const skip = new Set((deps.skipDirs ?? defaultSkipDirs()).filter((d) => !!d && p.isAbsolute(d)).map(key))
  const isFile = deps.isFile ?? defaultIsFile(platform)
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
  const dirs = (pathKey ? env[pathKey] ?? '' : '')
    .split(win ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d !== '' && p.isAbsolute(d) && !(win && UNC_RE.test(d)) && !skip.has(key(d)))
  const name = provider === 'codex' ? 'codex' : 'claude'
  if (!win) {
    for (const dir of dirs) {
      const file = p.join(dir, name)
      if (isFile(file)) return { file, args: [], kind: 'posix' }
    }
    return null
  }
  // Decision 12: every folder's .exe before any folder's .cmd.
  for (const ext of ['.exe', '.cmd'] as const) {
    for (const dir of dirs) {
      const file = p.join(dir, name + ext)
      if (isFile(file)) return { file, args: [], kind: ext === '.exe' ? 'exe' : 'cmd' }
    }
  }
  return null
}

/** exe/posix: [file, ...args, ...argv]; cmd: `<SystemRoot>\System32\cmd.exe /d /s /c "<quoted line>"` with windowsVerbatimArguments. argv never carries user text. */
export function spawnTarget(cli: ResolvedCli, argv: string[]): { file: string; args: string[]; verbatim: boolean } {
  if (cli.kind !== 'cmd') return { file: cli.file, args: [...cli.args, ...argv], verbatim: false }
  // Always cmd.exe itself: ComSpec may point at another shell that has no /d /s /c.
  const root = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows'
  const line = [cli.file, ...cli.args, ...argv].map(quoteForCmd).join(' ')
  return { file: win32.join(root, 'System32', 'cmd.exe'), args: ['/d', '/s', '/c', `"${line}"`], verbatim: true }
}

export function quoteForCmd(arg: string): string {
  if (!arg.length) return '""'
  const escaped = arg.replace(/"/g, '""')
  return /[\s"&<>|^()]/.test(escaped) ? `"${escaped}"` : escaped
}
