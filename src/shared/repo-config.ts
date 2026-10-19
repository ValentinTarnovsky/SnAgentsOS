/**
 * Per-repo `.snagentsos.json` (E8-FR-23..27): the file shape, the IPC shapes
 * and the pure rules both processes share. Must stay free of Node/DOM imports
 * (renderer bundle); main repeats the cwd check with `path` and `realpath`.
 */
import type { GridPreset } from './types'

export const REPO_CONFIG_FILE = '.snagentsos.json'
/** A bigger file is not read (status `too_large`). */
export const REPO_CONFIG_MAX_BYTES = 64 * 1024
export const REPO_CONFIG_MAX_CONSOLES = 12
/** Quick Commands one file may carry (and register in `Workspace.repoConfig`). */
export const REPO_CONFIG_MAX_QUICK = 20

export interface RepoConfigConsole {
  /** <= 60 */
  title?: string
  /** 'claude' | 'codex' | 'shell' | a preset name; default 'shell'. */
  agent?: string
  /** <= 4096; replaces the preset's command (no argv prompt then). */
  command?: string
  /** <= 16384; delivered once through E8-FR-02. */
  prompt?: string
  /** Relative to the repo, never escaping it. */
  cwd?: string
  color?: string
  icon?: string
}

export type RepoConfigQuick =
  | { label: string; action: 'send'; text: string; enter?: boolean }
  | { label: string; action: 'agent'; agent: string; prompt: string }

export interface RepoConfigSetup {
  /** <= 4096 */
  command: string
  title?: string
  waitForSetup?: boolean
}

export interface RepoConfigFile {
  $schema?: string
  version: 1
  /** <= 80 */
  name?: string
  grid?: GridPreset
  /** Name of a local ConnectionProfile; executable for trust purposes. */
  connectionProfile?: string
  setup?: RepoConfigSetup
  /** 1..12 (11 with a setup, which adds its own console). */
  consoles: RepoConfigConsole[]
  /** <= 20 */
  quickCommands?: RepoConfigQuick[]
}

/** Why a file is not usable. `at` is the JSON path of the first problem. */
export type RepoConfigErrorCode = 'json' | 'schema' | 'cwd_escape' | 'too_large' | 'read_failed'

/** Non-blocking findings of main (the renderer adds preset/profile ones). */
export interface RepoConfigWarning {
  code: 'cwd_missing'
  /** JSON path, e.g. `consoles[1].cwd`. */
  at: string
}

/** `repoConfig:read` (dir -> RepoConfigReadRes). */
export interface RepoConfigReadRes {
  status: 'none' | 'ok' | 'invalid' | 'too_large'
  config?: RepoConfigFile
  /** sha256 hex of the normalized text (no BOM, CRLF -> LF). */
  sha256?: string
  /** The same hash is approved in trusted-repos.json. */
  trusted?: boolean
  /** An approval exists for this repo, with another hash. */
  changedSinceTrust?: boolean
  /** True with setup, a command, a prompt, quick commands or a connectionProfile. */
  needsTrust: boolean
  warnings: RepoConfigWarning[]
  /** First validation problem, `<at>: <detail>` (technical, shown as is). */
  error?: string
  errorCode?: RepoConfigErrorCode
  /**
   * Per console: the absolute folder it starts in (checked with realpath to
   * stay inside the repo), or null for the repo folder (no cwd, or a missing one).
   */
  consoleCwds?: Array<string | null>
}

/** `repoConfig:trust` ({ dir, sha256 }). `changed`: the file moved on since the read. */
export type RepoConfigTrustRes = { ok: true } | { ok: false; changed: true } | { ok: false; changed?: false; error: string }

/** `repoConfig:previewExport` ({ dir, file }). */
export type RepoConfigPreviewRes =
  | { ok: true; json: string; exists: boolean; path: string }
  | { ok: false; error: string }

/** `repoConfig:export` ({ dir, file, overwrite }). The written content is trusted. */
export type RepoConfigExportRes =
  | { ok: true; path: string; sha256: string }
  | { ok: false; error: 'exists' | 'invalid' | 'write_failed'; detail?: string }

/**
 * E8-FR-24: only a file with nothing executable (grid, titles and shells
 * without `command`) opens without the trust dialog. An agent console alone
 * runs the user's own local preset, so it does not ask.
 */
export function repoConfigNeedsTrust(cfg: RepoConfigFile): boolean {
  if (cfg.setup) return true
  if (cfg.connectionProfile) return true
  if (cfg.quickCommands && cfg.quickCommands.length > 0) return true
  return cfg.consoles.some((c) => !!c.command || !!c.prompt)
}

/**
 * Lexical containment of a console `cwd` (E8-FR-23): no drive (`C:foo`), no
 * root or UNC (`/x`, `\\srv`), and no `..` walking above the repo. Returns
 * null when it stays inside. Main repeats it with `path` and `realpath`.
 */
export function repoCwdProblem(cwd: string): string | null {
  if (cwd.includes(':')) return 'drive or stream syntax is not allowed'
  if (cwd.startsWith('\\') || cwd.startsWith('/')) return 'absolute or UNC paths are not allowed'
  if (cwd.includes('\0')) return 'NUL is not allowed'
  let depth = 0
  for (const seg of cwd.split(/[\\/]+/)) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') depth--
    else depth++
    if (depth < 0) return 'escapes the repo'
  }
  return null
}
