import { existsSync, promises as nodeFsp, realpathSync, type Stats } from 'fs'
import { basename, dirname, join } from 'path'
import { BRAND, INSTALLER_REG, LEGACY_BRAND } from '@shared/brand'
import {
  isCommittedPhase,
  isoStamp,
  isTerminalItem,
  readMarker,
  writeMarker,
  BACKUP_FILE,
  type LegacyItemId,
  type LegacyItemState,
  type LegacyMigrationMarker,
} from './legacyMarker'
import { appendToBackup, listLegacyWhitelist, sha256, CrashFault } from './legacyBrand'
import {
  combineResults,
  expandGuard,
  needsElevation,
  removeTombstones,
  safeRemoveTree,
  tombstoneAndRemove,
  violatesGuard,
  type ElevationContext,
  type PathGuard,
  type RemoveFs,
  type RemoveOptions,
  type RemoveResult,
} from './safeRemove'
import { isInside, samePath } from './pathUtil'
import { readBackupZip, type BackupEntry } from './backupZip'

/**
 * Inventory L01-L21 of what 1.x leaves behind and the cleanup that walks it
 * (E0-FR-30..FR-34, FR-36). Runs only with the marker in committed or later,
 * in the background, one item at a time; after each item its state is
 * persisted (done, absent, skipped with a reason, or deferred with attempts),
 * so a crash or a file in use resumes exactly there on the next pass. Every
 * path is computed here in main from injected roots (no IPC sends paths), and
 * every deletion goes through safeRemove's guards.
 */

export type Hive = 'HKCU' | 'HKLM'

/** Registry access, asynchronous (never blocks the main thread); reads resolve null for an absent value. Errors reject. */
export interface RegistryAccess {
  read(hive: Hive, key: string, name: string): Promise<string | Buffer | null>
  deleteValue(hive: Hive, key: string, name: string): Promise<'done' | 'absent'>
  deleteKey(hive: Hive, key: string): Promise<'done' | 'absent'>
}

/** .lnk access (Electron shell.readShortcutLink / writeShortcutLink on Windows). */
export interface ShortcutAccess {
  /** Null when the file cannot be read as a shortcut. */
  read(lnk: string): { target: string } | null
  update(lnk: string, o: { target: string; icon?: string; iconIndex?: number; appUserModelId?: string }): boolean
}

/** Every root the inventory derives paths from. */
export interface LegacyRoots {
  appData: string
  localAppData: string | null
  temp: string
  home: string
  desktop: string | null
  claudeDir: string
  /** %APPDATA%\Microsoft\Windows\Start Menu\Programs */
  startMenuPrograms: string | null
  /** %APPDATA%\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar */
  taskbarPins: string | null
  /** /Applications and ~/Applications on macOS. */
  macApplications: string[]
}

export interface CleanupEnv {
  targetDir: string
  mode: 'installed' | 'portable'
  platform: NodeJS.Platform
  roots: LegacyRoots
  /** 1.x data folder as detected now (null when gone); falls back to the marker. */
  legacyDataDir: string | null
  /** Folder of the portable exe (PORTABLE_EXECUTABLE_DIR), null when installed. */
  portableDir: string | null
  exe: {
    /** The running executable (installed: SnAgentsOS.exe). */
    execPath: string
    portableExeFile(): string | null
    setPortableExeFile(p: string): void
    appImage?(): string | null
    setAppImage?(p: string): void
    /** Rename or delete a file once this process has exited (detached helper). */
    scheduleExitHelper?(op: { from: string; to?: string }): boolean
  }
  guard: PathGuard
  elevation?: ElevationContext
  /** Null where there is no registry (POSIX) or it must not be touched (dev). */
  registry: RegistryAccess | null
  shortcuts: ShortcutAccess | null
  /** app.setLoginItemSettings({ openAtLogin: true }) for the new app; null where it does not apply. */
  loginItem: { enable(): void } | null
  /** shell.trashItem (macOS bundle). */
  trash?: (p: string) => Promise<void>
  /** CFBundleIdentifier of an .app, null when unreadable. */
  bundleId?: (appPath: string) => string | null
  /** SnMultiCC.exe (or the POSIX process) of the current user is running. */
  isLegacyProcessRunning(): boolean | Promise<boolean>
  /** The Chromium profile in dir is held by a live process (lockfile / SingletonLock). */
  isFolderLocked(dir: string): boolean
  migrateLegacyHooks(): 'rewritten' | 'notNeeded' | 'pending'
  /** Settings of the migrated config (dataDir), read when an item needs them. */
  readMigratedSettings(): { launchOnStartup?: boolean } | null
  now(): number
  log(line: string): void
  fs?: RemoveFs
  retries?: number
  delayMs?: number
  /** Log what would be done and change nothing (dev without SNAOS_FORCE_LEGACY_CLEANUP). */
  simulate: boolean
  /** First pass of this app start: counts towards cleanupStarts when something is deferred. */
  firstPassOfStart?: boolean
  onChange?(marker: LegacyMigrationMarker): void
  /** Test seam: 'crash:item:Lxx' throws after Lxx is persisted, 'crash:tombstone:Lxx' right after its rename. */
  faultAt?: string | null
}

export interface ItemOutcome {
  state: LegacyItemState
  reason?: string
}

interface Run {
  env: CleanupEnv
  marker: LegacyMigrationMarker
  rm: RemoveOptions
  persist(): void
}

interface InventoryItem {
  /** Deferred while 1.x runs (FR-09 b): it touches folders or files 1.x uses. */
  needsLegacyClosed: boolean
  describe(env: CleanupEnv): string[]
  run(r: Run, id: LegacyItemId): Promise<ItemOutcome>
}

export const MAX_UNKNOWN_BYTES = 5 * 1024 * 1024

export const REG = {
  run: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run',
  startupApproved: 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run',
  notifications: `Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\${LEGACY_BRAND.appId}`,
  uninstall: `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${LEGACY_BRAND.nsisGuid}`,
  taskband: 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Taskband',
} as const

/** Order of a pass: login item first (needs the migrated config), hooks, shortcuts and registry, then disk. */
export const CLEANUP_ORDER: LegacyItemId[] = [
  'L10', 'L11', 'L12', 'L17', 'L08', 'L06', 'L07', 'L09', 'L01', 'L02', 'L03', 'L18',
  'L04', 'L13', 'L14', 'L15', 'L16', 'L21', 'L05', 'L19', 'L20',
]

/** Top-level names of a 1.x data folder that are ours or Chromium's (anything else is unknown). */
const KNOWN_ENTRIES = new Set(
  [
    'config.json', 'config.json.bak', 'config.json.tmp', 'remote-devices.json', 'remote-devices.json.tmp', 'backups', 'status-bin',
    'cache', 'code cache', 'gpucache', 'dawncache', 'dawngraphitecache', 'dawnwebgpucache', 'grshadercache', 'graphitedawncache',
    'shadercache', 'local storage', 'session storage', 'indexeddb', 'network', 'shared dictionary', 'sharedstorage', 'blob_storage',
    'crashpad', 'service worker', 'webstorage', 'databases', 'partitions', 'dictionaries', 'videodecodestats', 'shared_proto_db',
    'local state', 'preferences', 'network persistent state', 'transportsecurity', 'cookies', 'trust tokens', 'lockfile',
    'singletonlock', 'singletoncookie', 'singletonsocket', 'dips', 'origin bound certs', 'quotamanager', 'visited links', 'web data',
    'history', 'favicons', 'login data', 'heavy_ad_intervention_opt_out.db', 'first_party_sets.db', 'component_crx_cache',
    'extensions_crx_cache', 'browsermetrics', 'crash reports', 'pending_crashes', 'media device salts', 'webrtcvideostats',
    'extension state', 'extension rules', 'extension scripts', 'sync data', 'segmentation_platform', 'optimization_guide_model_store',
    'hyphen-data', 'spellcheck', 'storage', 'privatenetworkdevicestore', 'reporting and nel', 'commerce_heuristics',
  ].map((n) => n.toLowerCase()),
)

function isKnownEntry(name: string): boolean {
  const n = name.toLowerCase()
  return KNOWN_ENTRIES.has(n) || n.endsWith('-journal') || n.startsWith('.org.chromium.')
}

function errCode(err: unknown): string {
  const c = (err as { code?: unknown })?.code
  return typeof c === 'string' && c ? c : 'error'
}

function outcome(r: RemoveResult): ItemOutcome {
  if (r === 'done' || r === 'absent') return { state: r }
  return 'deferred' in r ? { state: 'deferred', reason: r.deferred } : { state: 'skipped', reason: r.skipped }
}

async function lstatOrNull(r: Run, p: string): Promise<Stats | null> {
  try {
    return await (r.env.fs ?? nodeFsp).lstat(p)
  } catch {
    return null
  }
}

/** Link, elevation and guard checks (realpaths included) before any backup work; the removal repeats them. */
async function precheck(r: Run, target: string, st: Stats): Promise<ItemOutcome | null> {
  if (st.isSymbolicLink()) return { state: 'skipped', reason: 'reparsePoint' }
  if (needsElevation(target, r.rm.elevation)) return { state: 'skipped', reason: 'needsElevation' }
  const fsx = r.env.fs ?? nodeFsp
  const real = await fsx.realpath(target).catch(() => target)
  if (violatesGuard([target, real], await expandGuard(r.env.guard, fsx))) return { state: 'skipped', reason: 'guard' }
  return null
}

/**
 * A 1.x install registered in either hive: its uninstall entry still says
 * SnMultiCC, or Software\<GUID> points at a folder that still holds the 1.x
 * exe (after the 2.x setup that key belongs to 2.x). A registry error counts
 * as registered: the caller then keeps what belongs to that install.
 */
export async function legacyInstallRegistered(env: CleanupEnv): Promise<boolean> {
  const reg = env.registry
  if (!reg) return false
  try {
    for (const hive of ['HKCU', 'HKLM'] as Hive[]) {
      const name = await reg.read(hive, REG.uninstall, 'DisplayName')
      if (typeof name === 'string' && name.startsWith(LEGACY_BRAND.productName)) return true
      const loc = await reg.read(hive, INSTALLER_REG.key, 'InstallLocation')
      if (typeof loc === 'string' && loc && existsSync(join(loc, LEGACY_BRAND.winExe))) return true
    }
    return false
  } catch {
    return true
  }
}

/** Top-level files 1.x keeps its data in (backups/ is the other place). */
const DATA_FILES = ['config.json', 'config.json.bak', 'remote-devices.json']

/**
 * SHA-256 of every entry the live zip really holds (hashed from the
 * decompressed bytes, not taken from its manifest). Empty when there is no
 * live zip (none yet, or expired); throws when the file is unreadable, so the
 * item defers instead of deleting with a broken backup.
 */
function liveZipHashes(r: Run): Set<string> {
  const dest = join(r.env.targetDir, BACKUP_FILE)
  const b = r.marker.backup
  if (!b || b.deletedAt !== undefined || !existsSync(dest)) return new Set()
  return new Set(readBackupZip(dest).entries.map((e) => sha256(e.data)))
}

/**
 * The whitelist files of folder must all be in the zip before it goes.
 * Sources that changed (or appeared) after the commit go to post-commit/<ISO>/
 * (2.x data wins, nothing is migrated again). An unchanged source whose bytes
 * the zip does not hold (the zip expired while the item stayed deferred, or it
 * was lost) goes back in under its own name. sourceBase names the files in the
 * manifest: the folder's own path, also while it already is a tombstone.
 * Returns the relative paths now covered by the zip.
 */
async function backupPostCommit(r: Run, folder: string, sourceBase: string): Promise<Set<string>> {
  const m = r.marker
  const known = new Map(m.from && samePath(m.from, sourceBase) ? m.sources.map((s) => [s.rel, s.sha256]) : [])
  const rels = new Set([...listLegacyWhitelist(folder), ...known.keys()])
  const inZip = liveZipHashes(r)
  const stamp = isoStamp(r.env.now())
  const changed: BackupEntry[] = []
  const missing: BackupEntry[] = []
  const covered = new Set<string>()
  const fsx = r.env.fs ?? nodeFsp
  for (const rel of rels) {
    let data: Buffer
    try {
      const st = await fsx.lstat(join(folder, rel))
      if (!st.isFile()) continue
      data = await fsx.readFile(join(folder, rel))
    } catch {
      continue
    }
    covered.add(rel)
    const h = sha256(data)
    if (known.get(rel) !== h) changed.push({ name: `post-commit/${stamp}/${rel}`, data, source: join(sourceBase, rel) })
    else if (!inZip.has(h)) missing.push({ name: rel, data, source: join(sourceBase, rel) })
  }
  if (missing.length > 0 && appendToBackup(r.env.targetDir, m, missing, r.env.now()) > 0) {
    r.persist()
    r.env.log(`phase=cleaning result=backupRestored entries=${missing.length} path=${sourceBase}`)
  }
  if (changed.length === 0) return covered
  const added = appendToBackup(r.env.targetDir, m, changed, r.env.now())
  if (added > 0) {
    m.postCommitBackup = { at: r.env.now(), entries: (m.postCommitBackup?.entries ?? 0) + added }
    r.persist()
    r.env.log(`phase=cleaning result=postCommitBackup entries=${added} path=${sourceBase}`)
  }
  return covered
}

/**
 * Everything in folder that is neither Chromium's nor disposable nor already
 * covered by the zip goes to the zip under prefix when it adds up to 5 MB or
 * less: unknown top-level entries, and our own data files the whitelist left
 * out (backups past the newest 12, anything else under backups/, a whitelist
 * file over 5 MB). Over that the folder is kept: skipped: unknownFiles, with
 * the names logged (never the contents). Links are removed as links, so they
 * hold nothing to keep.
 */
async function backupUnknown(r: Run, folder: string, sourceBase: string, prefix: string, covered: Set<string>): Promise<ItemOutcome | null> {
  const fsx = r.env.fs ?? nodeFsp
  const files: Array<{ rel: string; abs: string }> = []
  const names: string[] = []
  let bytes = 0
  const walk = async (abs: string, rel: string): Promise<void> => {
    if (covered.has(rel)) return
    const st = await fsx.lstat(abs)
    if (st.isSymbolicLink()) return
    if (st.isDirectory()) {
      for (const n of await fsx.readdir(abs)) await walk(join(abs, String(n)), `${rel}/${String(n)}`)
    } else if (st.isFile()) {
      bytes += st.size
      files.push({ rel, abs })
    }
  }
  for (const n of (await fsx.readdir(folder)).map(String)) {
    const ours = DATA_FILES.includes(n) || n.toLowerCase() === 'backups'
    if (isKnownEntry(n) && !ours) continue
    const before = files.length
    await walk(join(folder, n), n)
    if (files.length > before) names.push(n)
  }
  if (files.length === 0) return null
  if (bytes > MAX_UNKNOWN_BYTES) {
    r.env.log(`phase=cleaning result=unknownFiles bytes=${bytes} names=${names.join('|')} path=${sourceBase}`)
    return { state: 'skipped', reason: 'unknownFiles' }
  }
  const entries: BackupEntry[] = []
  for (const f of files) entries.push({ name: `${prefix}${f.rel}`, data: await fsx.readFile(f.abs), source: join(sourceBase, f.rel) })
  if (appendToBackup(r.env.targetDir, r.marker, entries, r.env.now()) > 0) r.persist()
  return null
}

interface SecureOpts {
  /** Compare the whitelist with the migrated sources (L01, L02). */
  postCommit: boolean
  unknownPrefix: string
  /** L18: config.json and remote-devices.json go to the zip under this prefix (dev/). */
  devPrefix?: string
}

/**
 * Puts in the verified zip everything of folder that deleting it would lose
 * (FR-28, FR-30). Null when the folder may go; skipped or deferred otherwise.
 */
async function secureFolder(r: Run, folder: string, sourceBase: string, opts: SecureOpts): Promise<ItemOutcome | null> {
  const covered = opts.postCommit ? await backupPostCommit(r, folder, sourceBase) : new Set<string>()
  if (opts.devPrefix) {
    const extras: BackupEntry[] = []
    for (const name of ['config.json', 'remote-devices.json']) {
      const st = await lstatOrNull(r, join(folder, name))
      const data = st && st.isFile() ? await readFileOrNull(r, join(folder, name)) : null
      if (!data) continue
      extras.push({ name: `${opts.devPrefix}${name}`, data, source: join(sourceBase, name) })
      covered.add(name)
    }
    if (extras.length > 0 && appendToBackup(r.env.targetDir, r.marker, extras, r.env.now()) > 0) r.persist()
  }
  return backupUnknown(r, folder, sourceBase, opts.unknownPrefix, covered)
}

function toRemoveResult(o: ItemOutcome | null): RemoveResult | undefined {
  if (!o) return undefined
  if (o.state === 'skipped') return { skipped: o.reason ?? 'skipped' }
  if (o.state === 'deferred') return { deferred: o.reason ?? 'deferred' }
  return undefined
}

/** secureFolder for a folder already renamed to a tombstone: any error keeps it (deferred). */
async function secureTombstone(r: Run, tomb: string, sourceBase: string, opts: SecureOpts): Promise<RemoveResult | undefined> {
  const st = await lstatOrNull(r, tomb)
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return undefined // safeRemoveTree decides
  try {
    return toRemoveResult(await secureFolder(r, tomb, sourceBase, opts))
  } catch (err) {
    if (err instanceof CrashFault) throw err
    return { deferred: errCode(err) }
  }
}

/**
 * L01, L02, L18: a 1.x data folder. Everything deleting it would lose goes to
 * the verified zip first; then the folder is renamed to a tombstone, checked
 * again (1.x may have written in between) and only then deleted. Tombstones a
 * crash left behind get the same check before they go.
 */
async function cleanDataFolder(r: Run, id: LegacyItemId, target: string, opts: SecureOpts): Promise<ItemOutcome> {
  const tombs = await removeTombstones(target, r.env.guard, r.rm, (t) => secureTombstone(r, t, target, opts))
  if (typeof tombs === 'object' && 'deferred' in tombs) return outcome(tombs)
  const st = await lstatOrNull(r, target)
  if (!st) return outcome(tombs)
  const pre = await precheck(r, target, st)
  if (pre) return pre
  if (r.env.isFolderLocked(target)) return { state: 'deferred', reason: 'legacyRunning' }
  const kept = await secureFolder(r, target, target, opts)
  if (kept) return kept
  const res = await tombstoneAndRemove(target, r.env.guard, {
    ...r.rm,
    afterRename: async (tomb) => {
      if (r.env.faultAt === `crash:tombstone:${id}`) throw new CrashFault(`tombstone:${id}`)
      return secureTombstone(r, tomb, target, opts)
    },
  })
  return outcome(combineResults([res, tombs]))
}

/**
 * The 1.x folder L01 may delete: always <appData>/<legacy name>, computed
 * here. The marker's from (a path read back from a file) is only taken when
 * it is exactly that, in either spelling of the name.
 */
function installedLegacyDir(env: CleanupEnv, m: LegacyMigrationMarker): string {
  const allowed = [join(env.roots.appData, LEGACY_BRAND.packageName), join(env.roots.appData, LEGACY_BRAND.productName)]
  const pick = (p: string | null | undefined): string | undefined => (p ? allowed.find((a) => samePath(a, p)) && p : undefined)
  return pick(env.legacyDataDir) ?? (m.mode === 'installed' ? pick(m.from) : undefined) ?? allowed[0]
}

function portableLegacyDir(env: CleanupEnv): string | null {
  return env.portableDir ? join(env.portableDir, LEGACY_BRAND.portableDataDir) : null
}

const notThisMode: ItemOutcome = { state: 'absent', reason: 'notThisMode' }

async function readFileOrNull(r: Run, p: string): Promise<Buffer | null> {
  try {
    return await (r.env.fs ?? nodeFsp).readFile(p)
  } catch {
    return null
  }
}

// --- Items ------------------------------------------------------------------

const L01: InventoryItem = {
  needsLegacyClosed: true,
  describe: (env) => [join(env.roots.appData, LEGACY_BRAND.packageName)],
  async run(r) {
    if (r.env.mode !== 'installed') return notThisMode
    return cleanDataFolder(r, 'L01', installedLegacyDir(r.env, r.marker), { postCommit: true, unknownPrefix: 'other/' })
  },
}

const L02: InventoryItem = {
  needsLegacyClosed: true,
  describe: (env) => [portableLegacyDir(env) ?? '-'],
  async run(r) {
    const target = portableLegacyDir(r.env)
    if (r.env.mode !== 'portable' || !target) return notThisMode
    // Only the folder right next to the running portable exe, nothing found elsewhere.
    if (!r.env.portableDir || !samePath(dirname(target), r.env.portableDir)) return { state: 'skipped', reason: 'guard' }
    return cleanDataFolder(r, 'L02', target, { postCommit: true, unknownPrefix: 'other/' })
  },
}

const L03: InventoryItem = {
  needsLegacyClosed: true,
  describe: (env) => [join(env.roots.appData, LEGACY_BRAND.packageName)],
  async run(r) {
    if (r.env.mode !== 'portable') return notThisMode
    const target = join(r.env.roots.appData, LEGACY_BRAND.packageName)
    const st = await lstatOrNull(r, target)
    if (!st) return { state: 'absent' }
    const pre = await precheck(r, target, st)
    if (pre) return pre
    // Data in there (any whitelist file, or anything under backups/), or a
    // registered 1.x install: it belongs to that install, never to the portable.
    let hasData = false
    for (const name of DATA_FILES) if (await lstatOrNull(r, join(target, name))) hasData = true
    try {
      if ((await (r.env.fs ?? nodeFsp).readdir(join(target, 'backups'))).length > 0) hasData = true
    } catch {
      /* no backups folder */
    }
    if (hasData || (await legacyInstallRegistered(r.env))) return { state: 'skipped', reason: 'ownedByInstalled' }
    if (r.env.isFolderLocked(target)) return { state: 'deferred', reason: 'legacyRunning' }
    // Whatever is not Chromium's goes to the zip first (or keeps the folder), like L01.
    const kept = await backupUnknown(r, target, target, 'appdata/other/', new Set())
    if (kept) return kept
    return outcome(await safeRemoveTree(target, r.env.guard, r.rm))
  },
}

const L11: InventoryItem = {
  needsLegacyClosed: true,
  describe: (env) => [join(env.roots.claudeDir, 'settings.json')],
  async run(r) {
    if (r.marker.hooksMigration !== 'pending') return { state: 'done' }
    const res = r.env.migrateLegacyHooks()
    if (res === 'pending') return { state: 'deferred', reason: 'hooksPending' }
    r.marker.hooksMigration = res
    return { state: res === 'rewritten' ? 'done' : 'absent' }
  },
}

const L12: InventoryItem = {
  needsLegacyClosed: true,
  describe: (env) => [join(env.roots.claudeDir, 'settings.json.snmulticc.bak')],
  async run(r) {
    if (!isTerminalItem(r.marker.cleanup.L11?.state)) return { state: 'deferred', reason: 'waitingL11' }
    // The only file of ~/.claude ever deleted, by exact path, after it is in the verified zip.
    const target = join(r.env.roots.claudeDir, 'settings.json.snmulticc.bak')
    const st = await lstatOrNull(r, target)
    if (!st) return { state: 'absent' }
    const pre = await precheck(r, target, st)
    if (pre) return pre
    const data = await readFileOrNull(r, target)
    if (!data) return { state: 'deferred', reason: 'unreadable' }
    if (appendToBackup(r.env.targetDir, r.marker, [{ name: 'claude/settings.json.snmulticc.bak', data, source: target }], r.env.now()) > 0) r.persist()
    return outcome(await safeRemoveTree(target, r.env.guard, r.rm))
  },
}

const L13: InventoryItem = {
  needsLegacyClosed: true,
  describe: (env) => [env.roots.localAppData ? join(env.roots.localAppData, LEGACY_BRAND.updaterCacheDir) : '-'],
  async run(r) {
    if (!r.env.roots.localAppData) return notThisMode
    const target = join(r.env.roots.localAppData, LEGACY_BRAND.updaterCacheDir)
    if (!(await lstatOrNull(r, target))) return { state: 'absent' }
    if (await legacyInstallRegistered(r.env)) return { state: 'skipped', reason: 'ownedByInstalled' }
    return outcome(await safeRemoveTree(target, r.env.guard, r.rm))
  },
}

const L14: InventoryItem = {
  needsLegacyClosed: true,
  describe: (env) => [join(env.roots.temp, LEGACY_BRAND.portableUnpackDir)],
  async run(r) {
    if (r.env.platform !== 'win32') return notThisMode
    const target = join(r.env.roots.temp, LEGACY_BRAND.portableUnpackDir)
    const st = await lstatOrNull(r, target)
    if (!st) return { state: 'absent' }
    // Only the unpacked app (the electron-builder layout): a folder of the
    // same name with anything else in it (a clone of the old repo) is not ours.
    if (st.isDirectory() && !st.isSymbolicLink() && (await foreignEntries(r, target)).length > 0) {
      r.env.log(`phase=cleaning item=L14 result=unknownFiles path=${target}`)
      return { state: 'skipped', reason: 'unknownFiles' }
    }
    return outcome(await safeRemoveTree(target, r.env.guard, r.rm))
  },
}

/** L15, L16: direct entries of the temp folder with an exact prefix. */
function tempPrefixItem(prefix: string): InventoryItem {
  return {
    needsLegacyClosed: false,
    describe: (env) => [join(env.roots.temp, `${prefix}*`)],
    async run(r) {
      let names: string[]
      try {
        names = (await (r.env.fs ?? nodeFsp).readdir(r.env.roots.temp)).map(String)
      } catch {
        return { state: 'absent' }
      }
      const hits = names.filter((n) => n.toLowerCase().startsWith(prefix.toLowerCase()))
      const results: RemoveResult[] = []
      for (const n of hits) results.push(await safeRemoveTree(join(r.env.roots.temp, n), r.env.guard, r.rm))
      return outcome(combineResults(results))
    },
  }
}

const L18: InventoryItem = {
  needsLegacyClosed: true,
  describe: (env) => [join(env.roots.appData, `${LEGACY_BRAND.packageName}-dev`)],
  async run(r) {
    const target = join(r.env.roots.appData, `${LEGACY_BRAND.packageName}-dev`)
    // Its config and devices go to the zip first (dev/...), whatever the pipeline
    // saw; its .bak, backups/ and unknown entries under dev/other/.
    return cleanDataFolder(r, 'L18', target, { postCommit: false, unknownPrefix: 'dev/other/', devPrefix: 'dev/' })
  },
}

const L19: InventoryItem = {
  needsLegacyClosed: false,
  describe: () => ['Windows Firewall rules for the 1.x exe (kept: they need elevation and are inert)'],
  async run() {
    return { state: 'absent', reason: 'firewallRulesInert' }
  },
}

const L20: InventoryItem = {
  needsLegacyClosed: false,
  describe: () => ['phone localStorage (migrated by the mobile client)'],
  async run() {
    return { state: 'absent', reason: 'mobileClient' }
  },
}

// --- Windows: install residue, registry, shortcuts and the portable exe ------

/** Top-level names electron-builder puts in an install folder (E0-FR-34). */
function isInstallLayoutEntry(name: string, isDir: boolean): boolean {
  const n = name.toLowerCase()
  if (isDir) return n === 'resources' || n === 'locales' || n === 'swiftshader'
  return (
    n === LEGACY_BRAND.winExe.toLowerCase() ||
    n === `uninstall ${LEGACY_BRAND.winExe.toLowerCase()}` ||
    /\.(dll|pak|bin|dat|json)$/.test(n) ||
    n.startsWith('license')
  )
}

/** Top-level entries of dir outside the electron-builder layout (links count as foreign). */
async function foreignEntries(r: Run, dir: string): Promise<string[]> {
  const fsx = r.env.fs ?? nodeFsp
  const out: string[] = []
  for (const n of (await fsx.readdir(dir)).map(String)) {
    const est = await fsx.lstat(join(dir, n))
    if (est.isSymbolicLink() || !isInstallLayoutEntry(n, est.isDirectory())) out.push(n)
  }
  return out
}

async function readString(r: Run, hive: Hive, key: string, name: string): Promise<string | null> {
  const v = await r.env.registry?.read(hive, key, name)
  return typeof v === 'string' ? v : null
}

const L04: InventoryItem = {
  needsLegacyClosed: true,
  describe: () => [`HKCU|HKLM\\${INSTALLER_REG.key}\\${INSTALLER_REG.legacyInstallLocation}`],
  async run(r) {
    if (r.env.platform !== 'win32' || r.env.mode !== 'installed') return notThisMode
    if (!r.env.registry) return { state: 'absent', reason: 'noRegistry' }
    const results: ItemOutcome[] = []
    for (const hive of ['HKCU', 'HKLM'] as Hive[]) {
      const loc = await readString(r, hive, INSTALLER_REG.key, INSTALLER_REG.legacyInstallLocation)
      if (!loc) continue
      const st = await lstatOrNull(r, loc)
      if (!st) {
        results.push({ state: 'absent' })
        continue
      }
      if (st.isSymbolicLink()) {
        results.push({ state: 'skipped', reason: 'reparsePoint' })
        continue
      }
      // An HKLM install or a Program Files folder needs admin: reported, never a UAC prompt.
      if (hive === 'HKLM' || needsElevation(loc, r.rm.elevation)) {
        results.push({ state: 'skipped', reason: 'needsElevation' })
        continue
      }
      // The current app nested in the old folder (custom path): keep it.
      if (violatesGuard([loc], r.env.guard) || isInside(r.env.exe.execPath, loc)) {
        results.push({ state: 'skipped', reason: 'guard' })
        continue
      }
      if ((await foreignEntries(r, loc)).length > 0) {
        r.env.log(`phase=cleaning item=L04 result=unknownFiles path=${loc}`)
        results.push({ state: 'skipped', reason: 'unknownFiles' })
        continue
      }
      results.push(outcome(await safeRemoveTree(loc, r.env.guard, r.rm)))
    }
    return combineOutcomes(results)
  },
}

/** Same precedence as combineResults, over item outcomes. */
function combineOutcomes(list: ItemOutcome[]): ItemOutcome {
  return (
    list.find((o) => o.state === 'deferred') ??
    list.find((o) => o.state === 'skipped') ??
    (list.some((o) => o.state === 'done') ? { state: 'done' } : { state: 'absent' })
  )
}

const L05: InventoryItem = {
  needsLegacyClosed: false,
  describe: () => [`HKCU|HKLM\\${REG.uninstall}`, `HKCU|HKLM\\${INSTALLER_REG.key}\\Legacy*`],
  async run(r) {
    if (r.env.platform !== 'win32' || r.env.mode !== 'installed') return notThisMode
    const reg = r.env.registry
    if (!reg) return { state: 'absent', reason: 'noRegistry' }
    // The installer values feed L04 and L08: kept until both are final (done, absent or skipped).
    if (!isTerminalItem(r.marker.cleanup.L04?.state) || !isTerminalItem(r.marker.cleanup.L08?.state)) return { state: 'deferred', reason: 'waitingL04L08' }
    const names: Record<Hive, string | null> = {
      HKCU: await readString(r, 'HKCU', REG.uninstall, 'DisplayName'),
      HKLM: await readString(r, 'HKLM', REG.uninstall, 'DisplayName'),
    }
    const ours = (['HKCU', 'HKLM'] as Hive[]).find((h) => names[h]?.startsWith(BRAND.productName))
    if (!ours) {
      // The GUID entry is 2.x's and is never deleted; anything else there is unexpected: touch nothing.
      r.env.log(`phase=cleaning item=L05 result=unexpectedUninstallEntry`)
      return { state: 'skipped', reason: 'unexpectedUninstallEntry' }
    }
    let deleted = false
    for (const hive of ['HKCU', 'HKLM'] as Hive[]) {
      for (const name of [INSTALLER_REG.legacyInstallLocation, INSTALLER_REG.legacyTaskbarPinned]) {
        try {
          if ((await reg.deleteValue(hive, INSTALLER_REG.key, name)) === 'done') deleted = true
        } catch {
          // HKLM values of a per-machine install need admin: inert, left as they are.
          r.env.log(`phase=cleaning item=L05 result=keptValue hive=${hive} name=${name}`)
        }
      }
    }
    const other: Hive = ours === 'HKCU' ? 'HKLM' : 'HKCU'
    if (names[other]?.startsWith(LEGACY_BRAND.productName)) {
      // A 1.x still registered in the other hive (per-machine 1.x under a per-user 2.x): the user uninstalls it.
      return other === 'HKLM' ? { state: 'skipped', reason: 'needsElevation' } : { state: 'skipped', reason: 'unexpectedUninstallEntry' }
    }
    return { state: deleted ? 'done' : 'absent' }
  },
}

/** L06, L07: SnMultiCC.lnk in the Start Menu or on the desktop, when its target is the 1.x exe or gone. */
function shortcutItem(dir: (env: CleanupEnv) => string | null): InventoryItem {
  return {
    needsLegacyClosed: false,
    describe: (env) => [join(dir(env) ?? '-', `${LEGACY_BRAND.productName}.lnk`)],
    async run(r) {
      if (r.env.platform !== 'win32' || r.env.mode !== 'installed') return notThisMode
      const base = dir(r.env)
      if (!base || !r.env.shortcuts) return { state: 'absent', reason: 'noShell' }
      const lnk = join(base, `${LEGACY_BRAND.productName}.lnk`)
      if (!(await lstatOrNull(r, lnk))) return { state: 'absent' }
      const info = r.env.shortcuts.read(lnk)
      const ours = info !== null && (basename(info.target).toLowerCase() === LEGACY_BRAND.winExe.toLowerCase() || !existsSync(info.target))
      if (!ours) return { state: 'skipped', reason: 'guard' }
      return outcome(await safeRemoveTree(lnk, r.env.guard, r.rm))
    },
  }
}

/** Searches the Taskband Favorites blob for a pin file name (UTF-16, either byte alignment). Unknown means alive. */
async function pinIsAlive(r: Run, lnkName: string): Promise<boolean> {
  try {
    const blob = await r.env.registry?.read('HKCU', REG.taskband, 'Favorites')
    if (!Buffer.isBuffer(blob)) return true
    const needle = lnkName.toLowerCase()
    return [blob, blob.subarray(1)].some((b) => b.toString('utf16le').toLowerCase().includes(needle))
  } catch {
    return true
  }
}

async function legacyPinnedFlag(r: Run): Promise<boolean> {
  for (const hive of ['HKCU', 'HKLM'] as Hive[]) {
    try {
      if ((await readString(r, hive, INSTALLER_REG.key, INSTALLER_REG.legacyTaskbarPinned)) === '1') return true
    } catch {
      /* unknown: no claim */
    }
  }
  return false
}

/** The exe a retargeted shortcut opens: the installed exe, or the (renamed) portable exe. */
function currentExe(env: CleanupEnv): string {
  return env.mode === 'portable' ? env.exe.portableExeFile() ?? env.exe.execPath : env.exe.execPath
}

const L08: InventoryItem = {
  needsLegacyClosed: false,
  describe: (env) => [join(env.roots.taskbarPins ?? '-', '*.lnk')],
  async run(r) {
    const dir = r.env.roots.taskbarPins
    if (r.env.platform !== 'win32') return notThisMode
    if (!dir || !r.env.shortcuts) return { state: 'absent', reason: 'noShell' }
    let names: string[]
    try {
      names = (await (r.env.fs ?? nodeFsp).readdir(dir)).map(String).filter((n) => n.toLowerCase().endsWith('.lnk'))
    } catch {
      names = []
    }
    const target = currentExe(r.env)
    let retargeted = 0
    let failed = false
    const results: ItemOutcome[] = []
    for (const n of names) {
      const lnk = join(dir, n)
      const info = r.env.shortcuts.read(lnk)
      // Only pins of the 1.x exe (installed or its temp extraction); anything else is the user's.
      if (!info || basename(info.target).toLowerCase() !== LEGACY_BRAND.winExe.toLowerCase()) continue
      if (await pinIsAlive(r, n)) {
        // Retargeted in place, same file name: renaming the .lnk would unpin it.
        if (existsSync(target) && r.env.shortcuts.update(lnk, { target, icon: target, iconIndex: 0, appUserModelId: BRAND.appId })) {
          retargeted++
          results.push({ state: 'done' })
          r.env.log(`phase=cleaning item=L08 result=retargeted path=${lnk}`)
          continue
        }
        failed = true
      }
      results.push(outcome(await safeRemoveTree(lnk, r.env.guard, r.rm)))
    }
    if (failed || (retargeted === 0 && (await legacyPinnedFlag(r)))) r.marker.pinRetargeted = false
    else if (retargeted > 0) r.marker.pinRetargeted = true
    return combineOutcomes(results)
  },
}

const L09: InventoryItem = {
  needsLegacyClosed: false,
  describe: () => [`HKCU\\${REG.notifications}`],
  async run(r) {
    if (r.env.platform !== 'win32') return notThisMode
    if (!r.env.registry) return { state: 'absent', reason: 'noRegistry' }
    return { state: await r.env.registry.deleteKey('HKCU', REG.notifications) }
  },
}

const L10: InventoryItem = {
  needsLegacyClosed: false,
  describe: () => [`HKCU\\${REG.run}\\${LEGACY_BRAND.appId}`, `HKCU\\${REG.startupApproved}\\${LEGACY_BRAND.appId}`],
  async run(r) {
    if (r.env.platform === 'darwin' && r.env.mode === 'installed') return macLoginItem(r)
    if (r.env.platform !== 'win32' || r.env.mode !== 'installed') return notThisMode
    if (!r.env.registry || !r.env.loginItem) return { state: 'absent', reason: 'noRegistry' }
    // New value first, then the legacy ones: StartupSection reads the OS state and must stay ON.
    let enabled = false
    if (r.env.readMigratedSettings()?.launchOnStartup) {
      r.env.loginItem.enable()
      enabled = true
    }
    const run = await r.env.registry.deleteValue('HKCU', REG.run, LEGACY_BRAND.appId)
    const approved = await r.env.registry.deleteValue('HKCU', REG.startupApproved, LEGACY_BRAND.appId)
    r.marker.loginItemMigrated = true
    return { state: enabled || run === 'done' || approved === 'done' ? 'done' : 'absent' }
  },
}

/** Retargets .lnk files that open exactly oldExe (desktop, Start Menu first level, taskbar pins) to newExe. */
async function retargetShortcuts(r: Run, oldExe: string, newExe: string): Promise<void> {
  const sh = r.env.shortcuts
  if (!sh) return
  const dirs = [r.env.roots.desktop, r.env.roots.startMenuPrograms, r.env.roots.taskbarPins].filter((d): d is string => !!d)
  for (const dir of dirs) {
    let names: string[]
    try {
      names = (await (r.env.fs ?? nodeFsp).readdir(dir)).map(String).filter((n) => n.toLowerCase().endsWith('.lnk'))
    } catch {
      continue
    }
    for (const n of names) {
      const lnk = join(dir, n)
      const info = sh.read(lnk)
      if (!info || !samePath(info.target, oldExe)) continue
      const pin = dir === r.env.roots.taskbarPins
      const ok = sh.update(lnk, pin ? { target: newExe, icon: newExe, iconIndex: 0, appUserModelId: BRAND.appId } : { target: newExe })
      r.env.log(`phase=cleaning item=L17 result=${ok ? 'retargeted' : 'retargetFailed'} path=${lnk}`)
    }
  }
}

const PORTABLE_LEGACY_EXE = /^snmulticc.*\.exe$/i
const PORTABLE_LEGACY_SIBLING = /^SnMultiCC-\d+\.\d+\.\d+-portable\.exe$/i
export const PORTABLE_EXE_NAME = `${BRAND.productName}-portable.exe`

async function hashFile(r: Run, p: string): Promise<string | null> {
  const data = await readFileOrNull(r, p)
  return data ? sha256(data) : null
}

/** E0-FR-33 (1) and (2): rename the running portable exe, delete the old versioned siblings. */
async function cleanWindowsPortableExe(r: Run): Promise<ItemOutcome> {
  const exe = r.env.exe.portableExeFile()
  if (!exe) return { state: 'absent' }
  const dir = dirname(exe)
  const results: ItemOutcome[] = []
  if (PORTABLE_LEGACY_EXE.test(basename(exe))) {
    const dest = join(dir, PORTABLE_EXE_NAME)
    // Same guards as a deletion (and the dev sandbox): a rename is a change too.
    if (violatesGuard([exe, dest], r.env.guard)) return { state: 'skipped', reason: 'guard' }
    const adopt = async (): Promise<void> => {
      r.env.exe.setPortableExeFile(dest)
      r.marker.portableExeRenamedTo = dest
      r.persist()
      await retargetShortcuts(r, exe, dest)
    }
    if (await lstatOrNull(r, dest)) {
      if ((await hashFile(r, dest)) !== (await hashFile(r, exe))) return { state: 'skipped', reason: 'nameConflict' }
      // Same bytes under the new name: the running old file can only go once this process exits.
      if (!r.env.exe.scheduleExitHelper?.({ from: exe })) return { state: 'deferred', reason: 'exitHelper' }
      await adopt()
      results.push({ state: 'done' })
    } else {
      try {
        // Windows allows renaming a running image (the loader opens it with FILE_SHARE_DELETE).
        await (r.env.fs ?? nodeFsp).rename(exe, dest)
        await adopt()
        results.push({ state: 'done' })
      } catch (err) {
        const code = errCode(err)
        if (code === 'EROFS' || code === 'EACCES') return { state: 'skipped', reason: 'readOnly' }
        if (!r.env.exe.scheduleExitHelper?.({ from: exe, to: dest })) return { state: 'deferred', reason: code }
        await adopt()
        results.push({ state: 'deferred', reason: 'renameAtExit' })
      }
    }
  }
  let names: string[] = []
  try {
    names = (await (r.env.fs ?? nodeFsp).readdir(dir)).map(String)
  } catch {
    /* unreadable folder: nothing to delete */
  }
  for (const n of names) {
    const p = join(dir, n)
    if (!PORTABLE_LEGACY_SIBLING.test(n) || samePath(p, exe)) continue
    results.push(outcome(await safeRemoveTree(p, r.env.guard, r.rm)))
  }
  return combineOutcomes(results)
}

const L17: InventoryItem = {
  needsLegacyClosed: true,
  describe: (env) => [(env.platform === 'linux' ? env.exe.appImage?.() : env.exe.portableExeFile()) ?? '-'],
  async run(r) {
    if (r.env.platform === 'linux') return renameLinuxAppImage(r)
    if (r.env.mode !== 'portable' || r.env.platform !== 'win32') return notThisMode
    return cleanWindowsPortableExe(r)
  },
}

// --- macOS and Linux ---------------------------------------------------------

/**
 * macOS (FR-12): with launchOnStartup migrated, the new login item is
 * registered, or StartupSection would silently turn off. The 1.x one cannot
 * be removed from another app (SMAppService registers per bundle); macOS
 * drops it with the bundle (L21).
 */
async function macLoginItem(r: Run): Promise<ItemOutcome> {
  r.marker.loginItemMigrated = true
  if (!r.env.loginItem || !r.env.readMigratedSettings()?.launchOnStartup) return { state: 'absent' }
  r.env.loginItem.enable()
  return { state: 'done' }
}

export const APPIMAGE_NAME = `${BRAND.productName}.AppImage`

/** FR-36: an AppImage still named after 1.x is renamed like FR-33 (1), and APPIMAGE follows it (the swap uses it). */
async function renameLinuxAppImage(r: Run): Promise<ItemOutcome> {
  const file = r.env.exe.appImage?.() ?? null
  if (!file || !/snmulticc/i.test(basename(file))) return { state: 'absent' }
  const dest = join(dirname(file), APPIMAGE_NAME)
  if (violatesGuard([file, dest], r.env.guard)) return { state: 'skipped', reason: 'guard' }
  const fsx = r.env.fs ?? nodeFsp
  const adopt = (): void => {
    r.env.exe.setAppImage?.(dest)
    r.marker.portableExeRenamedTo = dest
    r.persist()
  }
  if (await lstatOrNull(r, dest)) {
    if ((await hashFile(r, dest)) !== (await hashFile(r, file))) return { state: 'skipped', reason: 'nameConflict' }
    // POSIX unlinks a running file fine: the new name already holds the same bytes.
    adopt()
    return outcome(await safeRemoveTree(file, r.env.guard, r.rm))
  }
  try {
    await fsx.rename(file, dest)
  } catch (err) {
    const code = errCode(err)
    return code === 'EROFS' || code === 'EACCES' ? { state: 'skipped', reason: 'readOnly' } : { state: 'deferred', reason: code }
  }
  adopt()
  return { state: 'done' }
}

/**
 * L21. macOS: SnMultiCC.app in /Applications or ~/Applications whose
 * CFBundleIdentifier is the 1.x appId goes to the Trash (never deleted);
 * without permission it is needsElevation (the notice asks to move it by
 * hand). Linux: the old .deb needs root and is documented (README).
 */
const L21: InventoryItem = {
  needsLegacyClosed: true,
  describe: (env) => env.roots.macApplications.map((d) => join(d, `${LEGACY_BRAND.productName}.app`)),
  async run(r) {
    if (r.env.platform === 'linux') return { state: 'absent', reason: 'debNeedsRoot' }
    if (r.env.platform !== 'darwin') return notThisMode
    // SingletonLock of the 1.x profile: the bundle is still open.
    const profile = r.env.legacyDataDir ?? join(r.env.roots.appData, LEGACY_BRAND.packageName)
    if (r.env.isFolderLocked(profile)) return { state: 'deferred', reason: 'legacyRunning' }
    const results: ItemOutcome[] = []
    for (const dir of r.env.roots.macApplications) {
      const app = join(dir, `${LEGACY_BRAND.productName}.app`)
      const st = await lstatOrNull(r, app)
      if (!st) continue
      if (st.isSymbolicLink()) {
        results.push({ state: 'skipped', reason: 'reparsePoint' })
        continue
      }
      if (r.env.bundleId?.(app) !== LEGACY_BRAND.appId) {
        results.push({ state: 'skipped', reason: 'guard' })
        continue
      }
      if (!r.env.trash) {
        results.push({ state: 'deferred', reason: 'noTrash' })
        continue
      }
      try {
        await r.env.trash(app)
        results.push({ state: 'done' })
      } catch (err) {
        const code = errCode(err)
        results.push(code === 'EACCES' || code === 'EPERM' || /permission|not permitted/i.test(String((err as Error)?.message)) ? { state: 'skipped', reason: 'needsElevation' } : { state: 'deferred', reason: code })
      }
    }
    return combineOutcomes(results)
  },
}

export const INVENTORY: Record<LegacyItemId, InventoryItem> = {
  L01, L02, L03, L04, L05, L06: shortcutItem((env) => env.roots.startMenuPrograms), L07: shortcutItem((env) => env.roots.desktop),
  L08, L09, L10, L11, L12, L13, L14, L15: tempPrefixItem(`${LEGACY_BRAND.tempPrefix}update-`),
  L16: tempPrefixItem(`${LEGACY_BRAND.tempPrefix}swap-`), L17, L18, L19, L20, L21,
}

// --- Runner -----------------------------------------------------------------

export interface CleanupResult {
  marker: LegacyMigrationMarker | null
  simulated: boolean
}

/**
 * One cleanup pass. Needs the marker in committed or cleaning (done only gets
 * maintenance, elsewhere). Simulation logs every target and changes nothing,
 * not even the marker. Otherwise: committed -> cleaning, then each open item
 * in CLEANUP_ORDER, persisted one by one, and done once every item is done,
 * absent or skipped.
 */
export async function runCleanup(env: CleanupEnv): Promise<CleanupResult> {
  const read = readMarker(env.targetDir)
  if (read.kind !== 'ok' || !isCommittedPhase(read.marker.phase) || read.marker.phase === 'done') return { marker: read.kind === 'ok' ? read.marker : null, simulated: false }
  const marker = read.marker
  if (env.simulate) {
    for (const id of CLEANUP_ORDER) {
      if (isTerminalItem(marker.cleanup[id]?.state)) continue
      for (const p of INVENTORY[id].describe(env)) env.log(`simulate item=${id} path=${p}`)
    }
    return { marker, simulated: true }
  }
  const persist = (): void => {
    marker.at = env.now()
    writeMarker(env.targetDir, marker)
    env.onChange?.(marker)
  }
  if (marker.phase === 'committed') {
    marker.phase = 'cleaning'
    persist()
    env.log('phase=cleaning result=started')
  }
  if (env.firstPassOfStart && Object.values(marker.cleanup).some((s) => s?.state === 'deferred')) {
    marker.cleanupStarts += 1
    persist()
  }
  const run: Run = {
    env,
    marker,
    rm: { fs: env.fs, elevation: env.elevation, retries: env.retries, delayMs: env.delayMs, now: env.now },
    persist,
  }
  let legacyRunning: boolean | null = null
  for (const id of CLEANUP_ORDER) {
    const current = marker.cleanup[id]
    if (isTerminalItem(current?.state)) continue
    const item = INVENTORY[id]
    let result: ItemOutcome
    if (item.needsLegacyClosed && (legacyRunning ??= await env.isLegacyProcessRunning())) {
      result = { state: 'deferred', reason: 'legacyRunning' }
    } else {
      try {
        result = await item.run(run, id)
      } catch (err) {
        if (err instanceof CrashFault) throw err
        result = { state: 'deferred', reason: errCode(err) }
      }
    }
    marker.cleanup[id] = { state: result.state, attempts: (current?.attempts ?? 0) + 1, ...(result.reason ? { reason: result.reason } : {}), at: env.now() }
    persist()
    env.log(`phase=cleaning item=${id} result=${result.state}${result.reason ? ` reason=${result.reason}` : ''}`)
    if (env.faultAt === `crash:item:${id}`) throw new CrashFault(`item:${id}`)
  }
  if (CLEANUP_ORDER.every((id) => isTerminalItem(marker.cleanup[id]?.state))) {
    marker.phase = 'done'
    persist()
    env.log('phase=done')
  }
  return { marker, simulated: false }
}

/**
 * Dev cleanup really deletes only on a fake tree: SNAOS_FORCE_LEGACY_CLEANUP=1
 * AND every path variable set and strictly inside the system temp folder
 * (derived from the real profile, not from %TEMP%, which the fake tree
 * redirects too). Returns the fake roots, which then become the guard's
 * allowedRoots, or why the run stays a simulation.
 */
export function devCleanupSandbox(input: {
  env: Record<string, string | undefined>
  platform: NodeJS.Platform
  realHome: string
  /** Long-name, link-free form (8.3 names on Windows CI, /var -> /private/var on macOS). */
  realpath?: (p: string) => string
}): { ok: true; roots: string[] } | { ok: false; reason: string } {
  const { env, platform } = input
  const real = (p: string): string => {
    try {
      return (input.realpath ?? realpathSync.native)(p)
    } catch {
      return p
    }
  }
  if (env.SNAOS_FORCE_LEGACY_CLEANUP !== '1') return { ok: false, reason: 'notForced' }
  const required = platform === 'win32' ? ['APPDATA', 'LOCALAPPDATA', 'TEMP', 'USERPROFILE', 'CLAUDE_CONFIG_DIR'] : ['HOME', 'CLAUDE_CONFIG_DIR']
  const optional = platform === 'win32' ? ['TMP'] : ['TMPDIR', 'XDG_CONFIG_HOME']
  const bases =
    platform === 'win32'
      ? [join(input.realHome, 'AppData', 'Local', 'Temp')]
      : ['/tmp', '/var/tmp', '/private/tmp', '/var/folders', '/private/var/folders']
  const roots: string[] = []
  for (const name of [...required, ...optional]) {
    const value = env[name]
    if (!value) {
      if (required.includes(name)) return { ok: false, reason: `missing:${name}` }
      continue
    }
    if (!bases.some((b) => isInside(real(value), real(b)))) return { ok: false, reason: `outsideTemp:${name}` }
    roots.push(value)
  }
  return { ok: true, roots }
}
