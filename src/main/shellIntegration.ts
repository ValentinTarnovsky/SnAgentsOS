import { execFile } from 'child_process'
import { app } from 'electron'
import { BRAND } from '@shared/brand'
import type { ExplorerMenuResult } from '@shared/ipc-contract'
import { portableExeFile } from './paths'
import { mainTLang, type Lang } from './i18n'

/**
 * "Open in SnAgentsOS" in the classic folder context menu (E4-FR-34). Two
 * HKCU keys, no admin: `Directory\shell\SnAgentsOS` (right click on a folder)
 * and `Directory\Background\shell\SnAgentsOS` (right click inside one), each
 * with a localized label, the exe as icon and `"<exe>" --open "%V"`. Every
 * registry access is `reg.exe` through execFile: no shell, 5 s timeout.
 * The NSIS uninstaller removes the keys (build/installer.nsh, E4-FR-35).
 */

export const EXPLORER_ROOT = 'HKCU\\Software\\Classes'
export const EXPLORER_VERB = BRAND.productName
/** Dev runs can only target a throwaway key with this prefix (tests, P-DESK). */
export const EXPLORER_TEST_ROOT_PREFIX = 'HKCU\\Software\\SnAgentsOSTest-'
const REG_TIMEOUT_MS = 5000

export function explorerKeys(root = EXPLORER_ROOT): { folder: string; background: string } {
  return {
    folder: `${root}\\Directory\\shell\\${EXPLORER_VERB}`,
    background: `${root}\\Directory\\Background\\shell\\${EXPLORER_VERB}`,
  }
}

export function explorerCommand(exe: string): string {
  return `"${exe}" --open "%V"`
}

/** reg.exe argument lists that write both keys (4 keys, 6 values). Pure. */
export function buildExplorerRegOps(exe: string, label: string, root = EXPLORER_ROOT): string[][] {
  const ops: string[][] = []
  for (const key of Object.values(explorerKeys(root))) {
    ops.push(['add', key, '/ve', '/t', 'REG_SZ', '/d', label, '/f'])
    ops.push(['add', key, '/v', 'Icon', '/t', 'REG_SZ', '/d', `"${exe}",0`, '/f'])
    ops.push(['add', `${key}\\command`, '/ve', '/t', 'REG_SZ', '/d', explorerCommand(exe), '/f'])
  }
  return ops
}

/** reg.exe argument lists that remove both keys (with their command subkeys). Pure. */
export function buildExplorerDeleteOps(root = EXPLORER_ROOT): string[][] {
  return Object.values(explorerKeys(root)).map((key) => ['delete', key, '/f'])
}

/**
 * The default value of a `reg query <key> /ve` output. The "(Default)" name is
 * localized by Windows, so the line is found by its type instead.
 */
export function parseRegDefault(stdout: string): string | null {
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const m = /^\s+\S.*?\s{2,}REG_(?:EXPAND_)?SZ(?:\s{2,}|\s*$)(.*)$/.exec(line)
    if (m) return m[1].trimEnd()
  }
  return null
}

/** The exe of a registered `"<exe>" --open "%V"` command, or null. */
export function exeFromCommand(command: string | null): string | null {
  const m = /^\s*"([^"]+)"/.exec(command ?? '')
  return m ? m[1] : null
}

export const sameExe = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase()

export interface RegResult {
  ok: boolean
  stdout: string
  stderr: string
}

export type RegRunner = (args: string[]) => Promise<RegResult>

export const runReg: RegRunner = (args) =>
  new Promise((resolve) => {
    execFile('reg.exe', args, { timeout: REG_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (error ? error.message : '') })
    })
  })

export interface ShellEnv {
  platform: NodeJS.Platform
  /** False in dev: nothing is registered unless `root` is a test root. */
  packaged: boolean
  /** Exe the menu launches: the portable .exe the user ran, else process.execPath. */
  exe: string
  root: string
  run: RegRunner
}

/**
 * Real environment. A dev run registers nothing, except under a throwaway
 * `HKCU\Software\SnAgentsOSTest-*` root named by SNAOS_TEST_EXPLORER_ROOT.
 */
export function defaultShellEnv(): ShellEnv {
  const testRoot = process.env[`${BRAND.envPrefix}TEST_EXPLORER_ROOT`]
  const useTestRoot = !app.isPackaged && !!testRoot && testRoot.startsWith(EXPLORER_TEST_ROOT_PREFIX)
  return {
    platform: process.platform,
    packaged: app.isPackaged || useTestRoot,
    exe: portableExeFile() ?? process.execPath,
    root: useTestRoot ? (testRoot as string) : EXPLORER_ROOT,
    run: runReg,
  }
}

function skipped(env: ShellEnv): ExplorerMenuResult | null {
  if (env.platform !== 'win32') return { ok: true, registered: false, skipped: 'not-windows' }
  if (!env.packaged) return { ok: true, registered: false, currentExe: env.exe, skipped: 'dev' }
  return null
}

export function explorerLabel(lang: Lang): string {
  return mainTLang(lang, 'explorer.menuLabel', { app: BRAND.productName })
}

interface RegisteredState {
  registered: boolean
  exe: string | null
  label: string | null
  backgroundCommand: string | null
}

async function readState(env: ShellEnv): Promise<RegisteredState> {
  const keys = explorerKeys(env.root)
  const [cmd, label, bg] = await Promise.all([
    env.run(['query', `${keys.folder}\\command`, '/ve']),
    env.run(['query', keys.folder, '/ve']),
    env.run(['query', `${keys.background}\\command`, '/ve']),
  ])
  const command = cmd.ok ? parseRegDefault(cmd.stdout) : null
  return {
    registered: command !== null,
    exe: exeFromCommand(command),
    label: label.ok ? parseRegDefault(label.stdout) : null,
    backgroundCommand: bg.ok ? parseRegDefault(bg.stdout) : null,
  }
}

function resultOf(env: ShellEnv, state: RegisteredState, error?: string): ExplorerMenuResult {
  const res: ExplorerMenuResult = { ok: !error, registered: state.registered, currentExe: env.exe }
  if (state.exe) res.exe = state.exe
  if (state.registered) res.mismatch = !sameExe(state.exe, env.exe)
  if (error) res.error = error
  return res
}

const firstLine = (s: string): string => s.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? 'reg.exe failed'

/** What is registered now, and whether it points at this exe. */
export async function readExplorerMenu(env: ShellEnv = defaultShellEnv()): Promise<ExplorerMenuResult> {
  const skip = skipped(env)
  if (skip) return skip
  return resultOf(env, await readState(env))
}

/** Writes (enabled) or removes (disabled) both keys. `lang` comes from the renderer: the config on disk can lag the debounce. */
export async function applyExplorerMenu(enabled: boolean, lang: Lang, env: ShellEnv = defaultShellEnv()): Promise<ExplorerMenuResult> {
  const skip = skipped(env)
  if (skip) return skip
  let error: string | undefined
  const ops = enabled ? buildExplorerRegOps(env.exe, explorerLabel(lang), env.root) : buildExplorerDeleteOps(env.root)
  for (const args of ops) {
    const r = await env.run(args)
    // A missing key on delete is the goal, not an error: the read below decides.
    if (!r.ok && enabled) {
      error = firstLine(r.stderr)
      break
    }
  }
  const state = await readState(env)
  if (!enabled && state.registered && !error) error = 'the menu keys could not be removed'
  return resultOf(env, state, error)
}

/**
 * Startup refresh with the toggle on: rewrites the keys when the exe (a moved
 * portable, another install that ran last) or the label (language) differs.
 * With a portable and an installed copy both enabled, the last one started wins.
 */
export async function refreshExplorerMenuOnStartup(
  enabled: boolean,
  lang: Lang,
  env: ShellEnv = defaultShellEnv(),
): Promise<ExplorerMenuResult | null> {
  if (!enabled || skipped(env)) return null
  const state = await readState(env)
  const label = explorerLabel(lang)
  const fresh =
    state.registered &&
    sameExe(state.exe, env.exe) &&
    state.label === label &&
    state.backgroundCommand === explorerCommand(env.exe)
  if (fresh) return resultOf(env, state)
  return applyExplorerMenu(true, lang, env)
}
