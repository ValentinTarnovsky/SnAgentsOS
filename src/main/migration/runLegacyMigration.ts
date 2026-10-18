import { spawn } from 'child_process'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs'
import { homedir, tmpdir, userInfo } from 'os'
import { dirname, join } from 'path'
import { app, dialog, shell, type BrowserWindow, type MessageBoxSyncOptions } from 'electron'
import { BRAND, LEGACY_BRAND } from '@shared/brand'
import { appDataRoot, dataDir, getLegacyDataDir, isPortable, portableDir, portableExeFile } from '../paths'
import { ConfigStore, loadLadder } from '../store/ConfigStore'
import { migrateLegacyHooks } from '../status/HookInstaller'
import { mainTLang, type Lang } from '../i18n'
import { maintainBackup, runPipeline, CrashFault, type PipelineResult } from './legacyBrand'
import { isCommittedPhase, readMarker, writeMarker, BACKUP_FILE, type LegacyMigrationMarker } from './legacyMarker'
import {
  devCleanupSandbox,
  runCleanup,
  type CleanupEnv,
  type LegacyRoots,
  type RegistryAccess,
  type ShortcutAccess,
} from './legacyInventory'
import { createWinRegistry } from './winRegistry'
import { closeLegacyApp, isLegacyRunningAsync, isLegacyRunningSync, isProfileLocked } from './legacyProcess'
import { createLegacyLog, legacyLogPath } from './legacyLog'
import { defaultElevation, type PathGuard } from './safeRemove'
import { isInside } from './pathUtil'

/** os.userInfo() throws when the uid has no passwd entry (some Linux containers). */
function safeUserInfo(): { username: string; homedir: string; uid?: number } {
  try {
    return userInfo()
  } catch {
    return { username: process.env.USER ?? process.env.USERNAME ?? '', homedir: homedir() }
  }
}

/**
 * Electron side of the 1.x migration (E0-FR-07..09, 12, 14, 26..36). Two
 * entry points in index.ts:
 *  - runLegacyMigrationAtBoot(): first thing in bootstrap(), before any IPC,
 *    config or device read. Runs the pipeline (packaged builds, or dev with
 *    SNAOS_FORCE_LEGACY_MIGRATION=1 into the dev userData) and the only
 *    dialog of the flow when 1.x is open (FR-09 a). A failure never blocks the
 *    start: the window opens with whatever the data folder has (FR-35).
 *  - scheduleLegacyCleanup(): after the window shows, plus 3 s; deferred items
 *    are retried at 60 s, then every 5 min, and on every start; the backup
 *    expiry is checked daily.
 * Dev (not packaged) cleanup is a simulation (log only) unless
 * SNAOS_FORCE_LEGACY_CLEANUP=1 AND every path variable points into the system
 * temp folder; even then the registry, the login item and processes are never
 * touched, and every deletion must stay inside those fake roots.
 */

declare const __SNAOS_TEST_FAULTS__: boolean

const RETRY_FIRST_MS = 60 * 1000
const RETRY_EVERY_MS = 5 * 60 * 1000
const DAILY_MS = 24 * 60 * 60 * 1000
const START_DELAY_MS = 3000

type Listener = (marker: LegacyMigrationMarker | null) => void
const listeners = new Set<Listener>()

/** Every marker change (pipeline result, each cleanup item, expiry, notice ack); registerLegacyIpc relays it as app:legacyStatus. */
export function onLegacyStatus(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emit(marker: LegacyMigrationMarker | null): void {
  for (const l of listeners) {
    try {
      l(marker)
    } catch {
      /* a listener never breaks the migration */
    }
  }
}

/** Current marker, or null when there is none or it is unreadable. */
export function readLegacyMarker(): LegacyMigrationMarker | null {
  const r = readMarker(dataDir())
  return r.kind === 'ok' ? r.marker : null
}

/**
 * The failed result of this start's pipeline. A data folder that cannot be
 * written (a portable on a read-only medium, E0-FR-33) never stores it, and a
 * failed start never changes the marker again, so it stands for the session.
 */
let sessionFailure: LegacyMigrationMarker | null = null

/** What the renderer is told: the stored marker, or this start's failure when the folder could not keep it (FR-35 banner). */
export function currentLegacyMarker(): LegacyMigrationMarker | null {
  const disk = readLegacyMarker()
  return sessionFailure && disk?.phase !== 'failed' ? sessionFailure : disk
}

/**
 * [Got it] on the welcome notice (app:legacyAck). Only a committed marker
 * carries the notice; writeMarker keeps noticeSeen once it is true, so a
 * cleanup pass holding an older copy cannot reopen it.
 */
export function ackLegacyNotice(targetDir: string = dataDir()): LegacyMigrationMarker | null {
  const r = readMarker(targetDir)
  if (r.kind !== 'ok' || !isCommittedPhase(r.marker.phase)) return null
  if (r.marker.noticeSeen) return r.marker
  const marker = { ...r.marker, noticeSeen: true, at: Date.now() }
  try {
    writeMarker(targetDir, marker)
  } catch {
    // A read-only data folder: the notice comes back next start, nothing else breaks.
    return null
  }
  emit(marker)
  return marker
}

export function legacyBackupFile(): string {
  return join(dataDir(), BACKUP_FILE)
}

export function legacyLogFile(): string {
  return legacyLogPath(dataDir())
}

/** SNAOS_TEST_FAULT is honored only in a build defining __SNAOS_TEST_FAULTS__ (never a release). */
function testFault(): string | null {
  return typeof __SNAOS_TEST_FAULTS__ !== 'undefined' && __SNAOS_TEST_FAULTS__ ? (process.env.SNAOS_TEST_FAULT ?? null) : null
}

function pipelineFault(f: string | null): string | null {
  return f && !f.startsWith('cleaning:') ? f : null
}

function cleanupFault(f: string | null): string | null {
  return f?.startsWith('cleaning:') ? `crash:item:${f.slice('cleaning:'.length)}` : null
}

function isCrash(err: unknown): boolean {
  return err instanceof CrashFault || (err instanceof Error && /^crash at /.test(err.message))
}

/** app.getPath can throw (a fake profile in dev leaves Windows unable to resolve known folders). */
function electronPath(name: 'home' | 'appData' | 'desktop' | 'userData'): string | null {
  try {
    return app.getPath(name)
  } catch {
    return null
  }
}

export function shouldRunMigration(): boolean {
  return app.isPackaged || process.env.SNAOS_FORCE_LEGACY_MIGRATION === '1'
}

/** Roots of the inventory. Dev reads them from the environment, so a fake tree redirects all of them. */
export function legacyRoots(): LegacyRoots {
  const env = process.env
  const win = process.platform === 'win32'
  const dev = !app.isPackaged
  const home = (dev ? (win ? env.USERPROFILE : env.HOME) : undefined) || electronPath('home') || homedir()
  const appData = appDataRoot()
  return {
    appData,
    localAppData: win ? env.LOCALAPPDATA || join(home, 'AppData', 'Local') : null,
    temp: (dev ? (win ? env.TEMP || env.TMP : env.TMPDIR) : undefined) || tmpdir(),
    home,
    desktop: (dev ? null : electronPath('desktop')) ?? join(home, 'Desktop'),
    claudeDir: env.CLAUDE_CONFIG_DIR || join(dev ? home : homedir(), '.claude'),
    startMenuPrograms: win ? join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : null,
    taskbarPins: win ? join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar') : null,
    macApplications: process.platform === 'darwin' ? ['/Applications', join(home, 'Applications')] : [],
  }
}

interface Policy {
  simulate: boolean
  /** Dev fake roots: every deletion and shortcut write must stay inside them. */
  sandbox: string[] | null
  reason: string
}

export function cleanupPolicy(): Policy {
  if (app.isPackaged) return { simulate: false, sandbox: null, reason: 'packaged' }
  const r = devCleanupSandbox({ env: process.env, platform: process.platform, realHome: safeUserInfo().homedir })
  return r.ok ? { simulate: false, sandbox: r.roots, reason: 'devSandbox' } : { simulate: true, sandbox: null, reason: r.reason }
}

export function buildGuard(roots: LegacyRoots, sandbox: string[] | null): PathGuard {
  const present = (list: Array<string | null | undefined>): string[] => list.filter((p): p is string => !!p)
  return {
    forbiddenExact: present([
      roots.home, roots.appData, roots.localAppData, roots.temp, roots.claudeDir, roots.desktop,
      roots.localAppData ? join(roots.localAppData, 'Programs') : null, homedir(), electronPath('appData'),
      ...defaultElevation().programFiles,
    ]),
    forbiddenTree: present([dataDir(), electronPath('userData')]),
    forbiddenContain: present([dirname(process.execPath), process.env.PORTABLE_EXECUTABLE_DIR, app.getAppPath()]),
    ...(sandbox ? { allowedRoots: sandbox } : {}),
  }
}

function inSandbox(policy: Policy, ...paths: string[]): boolean {
  return !policy.sandbox || paths.every((p) => policy.sandbox!.some((root) => isInside(p, root)))
}

function legacyLanguage(legacyDir: string | null): Lang {
  const lang = legacyDir ? loadLadder(legacyDir)?.config.settings.language : undefined
  if (lang === 'es' || lang === 'en') return lang
  return app.getLocale().toLowerCase().startsWith('es') ? 'es' : 'en'
}

/** What the boot step needs from the outside world; tests replace any part of it. */
export interface BootDeps {
  isLegacyRunning(legacyDir: string | null): boolean
  closeLegacy(): Promise<boolean>
  showMessageBox(o: MessageBoxSyncOptions): number
  now(): number
}

function defaultBootDeps(): BootDeps {
  const user = safeUserInfo()
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  return {
    isLegacyRunning: (legacyDir) => {
      // Dev never looks at processes: the developer's own 1.x runs there and is no part of a fake tree.
      const byProcess = app.isPackaged && isLegacyRunningSync(process.platform, user.username, uid)
      return byProcess || (legacyDir !== null && isProfileLocked(legacyDir, process.platform))
    },
    closeLegacy: () => closeLegacyApp({ platform: process.platform, username: user.username, uid }),
    showMessageBox: (o) => dialog.showMessageBoxSync(o),
    now: Date.now,
  }
}

/**
 * The boot step. Returns 'quit' only when the user chose [Quit] in the FR-09
 * dialog; then nothing was written (no marker, no log line).
 */
export async function runLegacyMigrationAtBoot(overrides: Partial<BootDeps> = {}): Promise<'continue' | 'quit'> {
  if (!shouldRunMigration()) return 'continue'
  const deps = { ...defaultBootDeps(), ...overrides }
  const target = dataDir()
  const write = createLegacyLog(target, deps.now)
  // Held until the outcome is known: [Quit] must leave no trace.
  const held: string[] = []
  const flush = (): void => {
    for (const line of held.splice(0)) write(line)
  }
  try {
    if (maintainBackup(target, deps.now(), undefined, write)) emit(readLegacyMarker())
  } catch (err) {
    write(`phase=maintenance result=error code=${(err as { code?: string }).code ?? 'error'}`)
  }
  const mode = isPortable() ? 'portable' : 'installed'
  const roots = legacyRoots()
  for (;;) {
    const legacyDir = getLegacyDataDir()
    let result: PipelineResult
    try {
      result = runPipeline({
        legacyDir,
        targetDir: target,
        appVersion: app.getVersion(),
        mode,
        isLegacyRunning: () => deps.isLegacyRunning(legacyDir),
        now: deps.now,
        log: (line) => held.push(line),
        faultAt: pipelineFault(testFault()),
        extras: { claudeBak: join(roots.claudeDir, `settings.json.${LEGACY_BRAND.packageName}.bak`), devDir: join(roots.appData, `${LEGACY_BRAND.packageName}-dev`) },
        loadTargetConfig: () => new ConfigStore().load(),
      })
    } catch (err) {
      flush()
      write(`phase=boot result=error code=${(err as { code?: string }).code ?? (err as Error).message}`)
      // A test build simulating a kill dies here, like a real crash would.
      if (isCrash(err)) app.exit(1)
      return 'continue'
    }
    if (result.status !== 'legacyRunning') {
      flush()
      sessionFailure = result.status === 'failed' ? result.marker : null
      emit(result.marker)
      return 'continue'
    }
    if (!app.isPackaged) {
      flush()
      write('phase=detect result=legacyRunning dev=skipped')
      return 'continue'
    }
    const lang = legacyLanguage(legacyDir)
    const t = (key: Parameters<typeof mainTLang>[1]): string => mainTLang(lang, key, { legacy: LEGACY_BRAND.productName, app: BRAND.productName })
    const choice = deps.showMessageBox({
      type: 'warning',
      title: BRAND.productName,
      message: t('legacy.running.title'),
      detail: t('legacy.running.detail'),
      buttons: [t('legacy.running.close'), t('legacy.running.quit')],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (choice !== 0) return 'quit'
    for (;;) {
      if (await deps.closeLegacy()) break
      const retry = deps.showMessageBox({
        type: 'error',
        title: BRAND.productName,
        message: t('legacy.failed.title'),
        detail: t('legacy.failed.detail'),
        buttons: [t('legacy.failed.retry'), t('legacy.failed.quit')],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      if (retry !== 0) return 'quit'
    }
    held.push('phase=detect result=legacyClosed')
  }
}

// --- Background cleanup -------------------------------------------------------

/** Renames or deletes files once this process has exited (the running portable exe). Windows only. */
const exitOps: Array<{ from: string; to?: string }> = []
let exitHookInstalled = false

/**
 * The rename never overwrites: when the new name already exists by the time
 * the old file is free (an update applied in this session swaps onto the new
 * name, which PORTABLE_EXECUTABLE_FILE already points at), the old file is
 * only deleted, so the newer exe is never replaced by the old one.
 */
export const EXIT_SCRIPT = [
  '@echo off',
  'set /a tries=0',
  ':wait',
  'ping -n 2 127.0.0.1 >nul',
  'if not defined TO goto del',
  'if exist "%TO%" goto del',
  'move "%FROM%" "%TO%" >nul 2>&1',
  'goto check',
  ':del',
  'del /F /Q "%FROM%" >nul 2>&1',
  ':check',
  'if not exist "%FROM%" goto done',
  'set /a tries+=1',
  'if %tries% lss 90 goto wait',
  ':done',
  '(goto) 2>nul & del "%~f0" & rmdir "%~dp0"',
  '',
].join('\r\n')

function runExitOps(): void {
  for (const op of exitOps.splice(0)) {
    try {
      const script = join(mkdtempSync(join(tmpdir(), BRAND.tempPrefix + 'exit-')), 'helper.cmd')
      writeFileSync(script, EXIT_SCRIPT, 'utf8')
      // Paths go through the environment, never into the script text.
      const env: NodeJS.ProcessEnv = { ...process.env, FROM: op.from }
      if (op.to) env.TO = op.to
      else delete env.TO
      const child = spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true, env })
      child.unref()
    } catch {
      /* the next start retries the item */
    }
  }
}

function scheduleExitHelper(policy: Policy, op: { from: string; to?: string }): boolean {
  if (process.platform !== 'win32' || !inSandbox(policy, op.from, ...(op.to ? [op.to] : []))) return false
  exitOps.push(op)
  if (!exitHookInstalled) {
    exitHookInstalled = true
    app.on('will-quit', runExitOps)
  }
  return true
}

function readBundleId(appPath: string): string | null {
  try {
    const plist = readFileSync(join(appPath, 'Contents', 'Info.plist'), 'utf8')
    return /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null
  } catch {
    return null
  }
}

function electronShortcuts(policy: Policy): ShortcutAccess {
  return {
    read: (lnk) => {
      try {
        return { target: shell.readShortcutLink(lnk).target }
      } catch {
        return null
      }
    },
    update: (lnk, o) => {
      if (!inSandbox(policy, lnk)) return false
      try {
        return shell.writeShortcutLink(lnk, 'update', o)
      } catch {
        return false
      }
    },
  }
}

/** Collaborators of a cleanup pass; tests replace any of them. */
export interface CleanupDeps {
  registry: RegistryAccess | null
  shortcuts: ShortcutAccess | null
  isLegacyProcessRunning(): boolean | Promise<boolean>
  loginItem: { enable(): void } | null
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  setInterval(fn: () => void, ms: number): unknown
}

function defaultCleanupDeps(policy: Policy): CleanupDeps {
  const win = process.platform === 'win32'
  const packaged = app.isPackaged
  const user = safeUserInfo()
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  return {
    // Dev never touches the real registry, login items or processes, whatever the paths say.
    registry: win && packaged ? createWinRegistry() : null,
    shortcuts: win ? electronShortcuts(policy) : null,
    isLegacyProcessRunning: () => (packaged ? isLegacyRunningAsync(process.platform, user.username, uid) : false),
    loginItem: packaged && !isPortable() && (win || process.platform === 'darwin') ? { enable: () => app.setLoginItemSettings({ openAtLogin: true }) } : null,
    now: Date.now,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    setInterval: (fn, ms) => setInterval(fn, ms),
  }
}

export function buildCleanupEnv(policy: Policy, deps: CleanupDeps, firstPassOfStart: boolean, log: (line: string) => void): CleanupEnv {
  const roots = legacyRoots()
  const elevation = {
    ...defaultElevation(),
    ownerUid: (p: string): number | null => {
      try {
        return statSync(p).uid
      } catch {
        return null
      }
    },
  }
  return {
    targetDir: dataDir(),
    mode: isPortable() ? 'portable' : 'installed',
    platform: process.platform,
    roots,
    legacyDataDir: getLegacyDataDir(),
    portableDir: portableDir(),
    exe: {
      execPath: process.execPath,
      portableExeFile,
      // The updater swap reads it when applying (E0-FR-33): a stale value would recreate the old name.
      setPortableExeFile: (p) => {
        process.env.PORTABLE_EXECUTABLE_FILE = p
      },
      appImage: () => process.env.APPIMAGE ?? null,
      setAppImage: (p) => {
        process.env.APPIMAGE = p
      },
      scheduleExitHelper: (op) => scheduleExitHelper(policy, op),
    },
    guard: buildGuard(roots, policy.sandbox),
    elevation,
    registry: deps.registry,
    shortcuts: deps.shortcuts,
    loginItem: deps.loginItem,
    trash: process.platform === 'darwin' ? (p) => (inSandbox(policy, p) ? shell.trashItem(p) : Promise.reject(Object.assign(new Error('sandbox'), { code: 'sandbox' }))) : undefined,
    bundleId: process.platform === 'darwin' ? readBundleId : undefined,
    isLegacyProcessRunning: () => deps.isLegacyProcessRunning(),
    isFolderLocked: (dir) => isProfileLocked(dir, process.platform),
    migrateLegacyHooks,
    readMigratedSettings: () => loadLadder(dataDir())?.config.settings ?? null,
    now: deps.now,
    log,
    simulate: policy.simulate,
    firstPassOfStart,
    onChange: emit,
    faultAt: cleanupFault(testFault()),
  }
}

let cleanupScheduled = false

/**
 * Starts the background cleanup 3 s after the window is shown. Returns the
 * pass runner (tests drive it directly).
 */
export function scheduleLegacyCleanup(win: Pick<BrowserWindow, 'isVisible' | 'once'>, overrides: Partial<CleanupDeps> = {}): () => Promise<void> {
  const noop = async (): Promise<void> => {}
  if (!shouldRunMigration() || cleanupScheduled) return noop
  cleanupScheduled = true
  const policy = cleanupPolicy()
  const deps = { ...defaultCleanupDeps(policy), ...overrides }
  const log = createLegacyLog(dataDir(), deps.now)
  if (policy.simulate) log(`phase=cleaning mode=simulation reason=${policy.reason}`)
  let running = false
  let first = true
  let retries = 0
  const pass = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      const res = await runCleanup(buildCleanupEnv(policy, deps, first, log))
      first = false
      emit(res.marker)
      // Only a committed migration has items to retry; a failed one retries on the next start (FR-35).
      const open = res.marker && !res.simulated && isCommittedPhase(res.marker.phase) && res.marker.phase !== 'done'
      if (open) {
        deps.setTimeout(() => void pass(), retries === 0 ? RETRY_FIRST_MS : RETRY_EVERY_MS)
        retries++
      }
    } catch (err) {
      log(`phase=cleaning result=error code=${(err as { code?: string }).code ?? (err as Error).message}`)
      if (isCrash(err)) app.exit(1)
    } finally {
      running = false
    }
  }
  const start = (): void => {
    deps.setTimeout(() => void pass(), START_DELAY_MS)
  }
  if (win.isVisible()) start()
  else win.once('ready-to-show', start)
  // The zip expires with the app open too (committed, cleaning or done).
  deps.setInterval(() => {
    // A pass in flight owns the marker (it rewrites it after every item); try again tomorrow.
    if (running) return
    try {
      if (maintainBackup(dataDir(), deps.now(), undefined, log)) emit(readLegacyMarker())
    } catch {
      /* next day */
    }
  }, DAILY_MS)
  return pass
}
