import * as nodeFs from 'fs'
import { createHash } from 'crypto'
import { basename, dirname, join, resolve } from 'path'
import { CONFIG_VERSION } from '@shared/types'
import { loadLadder, type LadderResult } from '../store/ConfigStore'
import { fileSchema as devicesFileSchema } from '../remote/DeviceRegistry'
import {
  isCommittedPhase,
  isoStamp,
  newMarker,
  pendingCleanup,
  quarantineMarker,
  readMarker,
  writeMarker,
  BACKUP_FILE,
  BACKUP_TTL_MS,
  PRE_IMPORT_DIR,
  STAGING_DIR,
  type LegacyMigrationMarker,
  type LegacyPhase,
  type LegacySource,
} from './legacyMarker'
import { overlaps } from './pathUtil'
import { buildManifest, decodeZip, readBackupZip, verifyBackupZip, writeBackupZip, type BackupEntry } from './backupZip'

/**
 * Detect -> migrate -> verify -> backup -> mark (E0-FR-07, 08, 27, 28, 29). The
 * synchronous part of the 1.x migration: it runs at the start of bootstrap(),
 * before configStore.load() and before any window exists, because the renderer
 * persists the whole store on a 400 ms debounce and no copy over config.json
 * may race a live window. It NEVER writes or deletes anything in the legacy
 * folder: the copy goes through .legacy-staging/, is verified by hash and by
 * schema, moved into place with rename, verified again in place, and only then
 * is phase 'committed' written, which is what allows the cleanup to delete.
 * Every failure rolls the destination back and leaves the legacy data as it was.
 */

export type PipelineFs = Pick<
  typeof nodeFs,
  | 'existsSync' | 'readFileSync' | 'writeFileSync' | 'renameSync' | 'rmSync' | 'mkdirSync'
  | 'readdirSync' | 'lstatSync' | 'copyFileSync' | 'unlinkSync'
>

export interface MigrateOptions {
  legacyDir: string | null
  /** dataDir(). */
  targetDir: string
  appVersion: string
  mode: 'installed' | 'portable'
  isLegacyRunning: () => boolean
  now?: () => number
  fs?: PipelineFs
  log?: (line: string) => void
  /**
   * Test seam: 'copy:N' / 'move:N' fail at the Nth file, 'verify' fails the
   * verification, 'crash:<phase>' throws past the failure handling right after
   * that transition is written (a killed process).
   */
  faultAt?: string | null
  /** Real load of the destination (configStore.load()); the ladder by default. */
  loadTargetConfig?: () => unknown
  /** Synchronous wait between file retries; Atomics.wait by default. */
  sleep?: (ms: number) => void
  /**
   * Legacy files with no data to migrate that still go to the backup zip:
   * ~/.claude/settings.json.snmulticc.bak and the 1.x dev profile folder.
   */
  extras?: { claudeBak?: string | null; devDir?: string | null }
}

export type PipelineResult =
  | { status: 'committed'; marker: LegacyMigrationMarker }
  | { status: 'alreadyCommitted'; marker: LegacyMigrationMarker }
  | { status: 'legacyRunning' }
  | { status: 'failed'; marker: LegacyMigrationMarker }

/** Most recent backups/config-*.json copied (the destination's own ladder keeps 12 too). */
export const MAX_COPIED_BACKUPS = 12
/** A whitelist file over this size is not ours to copy (configs are a few KB). */
export const MAX_SOURCE_BYTES = 5 * 1024 * 1024
/** Re-copies within one start when the sources change between copy and commit. */
export const MAX_ROUNDS = 3

const CONFIG_FILES = new Set(['config.json', 'config.json.bak'])
const DEVICES_FILE = 'remote-devices.json'
const BACKUP_NAME = /^config-.*\.json$/

/** A handled failure: the pipeline rolls back and writes phase 'failed' with this code. */
export class MigrationError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

/** Simulated process death (tests): skips every rollback, like a real kill would. */
export class CrashFault extends Error {
  constructor(readonly point: string) {
    super(`crash at ${point}`)
  }
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** JSON with keys sorted at every level, so two equal configs compare equal as text. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]))
    }
    return v
  }
  return JSON.stringify(sort(value))
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function errCode(err: unknown): string {
  if (err instanceof MigrationError) return err.code
  const code = (err as { code?: unknown })?.code
  return typeof code === 'string' && code ? code : 'error'
}

const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])

interface Copied extends LegacySource {
  data: Buffer
}

interface Ctx {
  o: MigrateOptions
  fsx: PipelineFs
  now: () => number
  log: (line: string) => void
  sleep: (ms: number) => void
  counters: Map<string, number>
  /** Decided once per run, before any rename: the destination already had paired devices. */
  keepTargetDevices?: boolean
}

function fault(ctx: Ctx, point: string): void {
  const f = ctx.o.faultAt
  if (!f) return
  if (f === `crash:${point}`) throw new CrashFault(point)
  if (f === point) throw new MigrationError(`fault:${point}`)
}

/** 'copy:N' and 'move:N' count calls within one run. */
function countedFault(ctx: Ctx, kind: string): void {
  const n = (ctx.counters.get(kind) ?? 0) + 1
  ctx.counters.set(kind, n)
  fault(ctx, `${kind}:${n}`)
}

function isRegularFile(fsx: PipelineFs, p: string): boolean {
  try {
    const st = fsx.lstatSync(p)
    return st.isFile() && !st.isSymbolicLink()
  } catch {
    return false
  }
}

function isRealDir(fsx: PipelineFs, p: string): boolean {
  try {
    const st = fsx.lstatSync(p)
    return st.isDirectory() && !st.isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * The whitelist, as relative paths: config.json, config.json.bak,
 * remote-devices.json and the newest backups/config-*.json (at most 12).
 * Symlinks and junctions (Node reports both as links) and oversized files are
 * left out. status-bin/, lockfile and the Chromium profile are never copied.
 */
export function listLegacyWhitelist(legacyDir: string, fsx: PipelineFs = nodeFs, log: (l: string) => void = () => {}): string[] {
  const rels: string[] = []
  const take = (rel: string): void => {
    const p = join(legacyDir, rel)
    try {
      const st = fsx.lstatSync(p)
      if (st.isSymbolicLink()) return log(`detect skip=link path=${rel}`)
      if (!st.isFile()) return
      if (st.size > MAX_SOURCE_BYTES) return log(`detect skip=tooLarge path=${rel}`)
      rels.push(rel)
    } catch {
      /* absent */
    }
  }
  take('config.json')
  take('config.json.bak')
  take(DEVICES_FILE)
  const backups = join(legacyDir, 'backups')
  if (isRealDir(fsx, backups)) {
    const names = fsx
      .readdirSync(backups)
      .map(String)
      .filter((n) => BACKUP_NAME.test(n))
      .sort()
      .reverse()
    let kept = 0
    for (const n of names) {
      if (kept >= MAX_COPIED_BACKUPS) break
      const before = rels.length
      take(`backups/${n}`)
      if (rels.length > before) kept++
    }
  }
  return rels
}

function readWithRetry(ctx: Ctx, p: string): Buffer {
  for (let i = 0; ; i++) {
    try {
      return ctx.fsx.readFileSync(p) as Buffer
    } catch (err) {
      if (i >= 3 || !RETRY_CODES.has(errCode(err))) throw err
      ctx.sleep(100)
    }
  }
}

function writeWithRetry(ctx: Ctx, p: string, data: Buffer): void {
  ctx.fsx.mkdirSync(dirname(p), { recursive: true })
  for (let i = 0; ; i++) {
    try {
      ctx.fsx.writeFileSync(p, data)
      return
    } catch (err) {
      if (i >= 3 || !RETRY_CODES.has(errCode(err))) throw err
      ctx.sleep(100)
    }
  }
}

function stagingFiles(targetDir: string): string {
  return join(targetDir, STAGING_DIR, 'files')
}

/**
 * Journal of the files a run moved over the destination, so a failure or a
 * crash puts the destination back as it was before the run. A destination
 * file is first renamed aside into .legacy-staging/undo/ (the entry is
 * recorded before the rename), then the staged copy takes its place.
 */
class UndoJournal {
  private readonly dir: string
  private readonly file: string
  private entries: Array<{ rel: string; existed: boolean }> = []

  constructor(private readonly targetDir: string, private readonly fsx: PipelineFs) {
    this.dir = join(targetDir, STAGING_DIR, 'undo')
    this.file = join(this.dir, 'journal.json')
  }

  /** tmp + rename: a torn journal would hide what was moved aside. */
  private save(): void {
    this.fsx.mkdirSync(this.dir, { recursive: true })
    this.fsx.writeFileSync(`${this.file}.tmp`, JSON.stringify({ entries: this.entries }), 'utf8')
    this.fsx.renameSync(`${this.file}.tmp`, this.file)
  }

  /** Moves the destination file aside the first time this run touches rel. */
  record(rel: string): void {
    if (this.entries.some((e) => e.rel === rel)) return
    const live = join(this.targetDir, rel)
    const existed = this.fsx.existsSync(live)
    this.entries.push({ rel, existed })
    this.save()
    if (existed) {
      const aside = join(this.dir, 'files', rel)
      this.fsx.mkdirSync(dirname(aside), { recursive: true })
      this.fsx.renameSync(live, aside)
    }
  }

  /**
   * Loads the journal a crashed run left behind, if any. An unreadable one
   * still has its originals in undo/files: they are all put back (an original
   * of the destination always wins over a staged legacy copy, which the next
   * run copies again), so nothing moved aside is lost with the staging folder.
   */
  load(): boolean {
    if (!this.fsx.existsSync(this.file) && !this.fsx.existsSync(join(this.dir, 'files'))) return false
    try {
      const parsed = JSON.parse(String(this.fsx.readFileSync(this.file, 'utf8'))) as { entries?: Array<{ rel: string; existed: boolean }> }
      this.entries = Array.isArray(parsed.entries) ? parsed.entries.filter((e) => typeof e?.rel === 'string') : []
    } catch {
      this.entries = this.scanAside('').map((rel) => ({ rel, existed: true }))
    }
    return true
  }

  /** Relative paths of every file under undo/files. */
  private scanAside(rel: string): string[] {
    const abs = join(this.dir, 'files', rel)
    try {
      const st = this.fsx.lstatSync(abs)
      if (st.isSymbolicLink()) return []
      if (!st.isDirectory()) return rel ? [rel] : []
    } catch {
      return []
    }
    return this.fsx
      .readdirSync(abs)
      .map(String)
      .flatMap((n) => this.scanAside(rel ? `${rel}/${n}` : n))
  }

  rollback(): void {
    for (const { rel, existed } of [...this.entries].reverse()) {
      const live = join(this.targetDir, rel)
      const aside = join(this.dir, 'files', rel)
      if (existed) {
        // Entry written but the rename aside never happened: live is still the original.
        if (!this.fsx.existsSync(aside)) continue
        this.fsx.rmSync(live, { force: true })
        this.fsx.renameSync(aside, live)
      } else {
        this.fsx.rmSync(live, { force: true })
      }
    }
    this.entries = []
  }
}

function clearStaging(ctx: Ctx, all: boolean): void {
  const target = all ? join(ctx.o.targetDir, STAGING_DIR) : stagingFiles(ctx.o.targetDir)
  ctx.fsx.rmSync(target, { recursive: true, force: true })
}

function copySources(ctx: Ctx, legacyDir: string, rels: string[]): Copied[] {
  const out: Copied[] = []
  for (const rel of rels) {
    countedFault(ctx, 'copy')
    const src = join(legacyDir, rel)
    const st = ctx.fsx.lstatSync(src)
    if (st.isSymbolicLink() || !st.isFile()) throw new MigrationError('sourceChangedType')
    const data = readWithRetry(ctx, src)
    if (data.length > MAX_SOURCE_BYTES) throw new MigrationError('sourceTooLarge')
    writeWithRetry(ctx, join(stagingFiles(ctx.o.targetDir), rel), data)
    out.push({ rel, bytes: data.length, sha256: sha256(data), mtimeMs: Math.round(st.mtimeMs), data })
  }
  return out
}

interface DevicesVerdict {
  loadable: boolean
  count: number
  fingerprint: string | null
}

/** Sorted id + secret pairs, hashed: compared, never logged. */
function devicesFingerprint(data: Buffer | null): DevicesVerdict {
  if (!data) return { loadable: false, count: 0, fingerprint: null }
  try {
    const parsed = devicesFileSchema.parse(JSON.parse(data.toString('utf8')))
    const pairs = parsed.devices.map((d) => `${d.id}\u0000${d.secret}`).sort()
    return { loadable: true, count: parsed.devices.length, fingerprint: sha256(pairs.join('\n')) }
  } catch {
    return { loadable: false, count: 0, fingerprint: null }
  }
}

function sameEffective(a: LadderResult | null, b: LadderResult | null): boolean {
  if (!a || !b) return a === b
  return (
    canonicalJson(a.config) === canonicalJson(b.config) &&
    a.config.workspaces.length === b.config.workspaces.length &&
    a.config.presets.length === b.config.presets.length
  )
}

interface StagingVerdict {
  legacyEff: LadderResult | null
  devices: DevicesVerdict
}

/** FR-27 points 1 to 3 on the staging copy against the legacy folder. */
function verifyStaging(ctx: Ctx, legacyDir: string, copied: Copied[]): StagingVerdict {
  const staging = stagingFiles(ctx.o.targetDir)
  for (const c of copied) {
    const again = ctx.fsx.readFileSync(join(staging, c.rel)) as Buffer
    if (sha256(again) !== c.sha256) throw new MigrationError('stagingHash')
  }
  const legacyEff = loadLadder(legacyDir)
  const stagingEff = loadLadder(staging)
  if (legacyEff && legacyEff.rawVersion > CONFIG_VERSION) throw new MigrationError('configVersion')
  if (!sameEffective(legacyEff, stagingEff)) throw new MigrationError('configMismatch')
  const devSrc = copied.find((c) => c.rel === DEVICES_FILE)
  const devices = devicesFingerprint(devSrc?.data ?? null)
  if (devices.loadable) {
    const staged = devicesFingerprint(ctx.fsx.readFileSync(join(staging, DEVICES_FILE)) as Buffer)
    if (staged.fingerprint !== devices.fingerprint) throw new MigrationError('devicesMismatch')
  }
  fault(ctx, 'verify')
  return { legacyEff, devices }
}

/** Which staged files go into dataDir() (FR-07 and the FR-27 no-fault cases). */
function filesToMove(ctx: Ctx, copied: Copied[], verdict: StagingVerdict): Copied[] {
  // A destination registry with devices is kept: legacy ones must not resurrect revoked phones.
  ctx.keepTargetDevices ??= devicesFingerprint(readIfFile(ctx, join(ctx.o.targetDir, DEVICES_FILE))).count > 0
  return copied.filter((c) => {
    if (c.rel === DEVICES_FILE) return verdict.devices.loadable && !ctx.keepTargetDevices
    // No ladder rung of the legacy folder loads: 1.x would start empty too, so no config is copied.
    return verdict.legacyEff !== null && (CONFIG_FILES.has(c.rel) || c.rel.startsWith('backups/'))
  })
}

function readIfFile(ctx: Ctx, p: string): Buffer | null {
  try {
    return isRegularFile(ctx.fsx, p) ? (ctx.fsx.readFileSync(p) as Buffer) : null
  } catch {
    return null
  }
}

/**
 * The legacy config wins (FR-07) even when it loads from a lower rung than
 * config.json: a destination config.json (or .bak) above that rung would
 * shadow it, so it is moved aside through the journal (rolled back on a
 * failure). config.json is already in pre-import/; a .bak without a
 * config.json next to it is copied there first.
 */
function displaceShadowingConfigs(ctx: Ctx, verdict: StagingVerdict, moving: Copied[], journal: UndoJournal, seenHashes: string[]): void {
  const source = verdict.legacyEff?.source
  if (!source || source === 'config.json') return
  const shadowing = source === 'config.json.bak' ? ['config.json'] : ['config.json', 'config.json.bak']
  for (const rel of shadowing) {
    if (moving.some((c) => c.rel === rel)) continue
    const live = join(ctx.o.targetDir, rel)
    if (!isRegularFile(ctx.fsx, live)) continue
    if (rel === 'config.json.bak' && !isRegularFile(ctx.fsx, join(ctx.o.targetDir, 'config.json'))) keepLoneBak(ctx, live, seenHashes)
    journal.record(rel)
    ctx.log(`phase=migrating result=displaced path=${rel}`)
  }
}

function keepLoneBak(ctx: Ctx, live: string, seenHashes: string[]): void {
  const data = ctx.fsx.readFileSync(live) as Buffer
  const hash = sha256(data)
  if (seenHashes.includes(hash)) return
  const dir = join(ctx.o.targetDir, PRE_IMPORT_DIR)
  if (ctx.fsx.existsSync(dir) && ctx.fsx.readdirSync(dir).map(String).some((n) => sha256(ctx.fsx.readFileSync(join(dir, n)) as Buffer) === hash)) return
  ctx.fsx.mkdirSync(dir, { recursive: true })
  let stampMs = ctx.now()
  while (ctx.fsx.existsSync(join(dir, `config-${isoStamp(stampMs)}.json.bak`))) stampMs++
  ctx.fsx.writeFileSync(join(dir, `config-${isoStamp(stampMs)}.json.bak`), data)
}

function moveIntoPlace(ctx: Ctx, moving: Copied[], journal: UndoJournal): void {
  const staging = stagingFiles(ctx.o.targetDir)
  for (const c of moving) {
    countedFault(ctx, 'move')
    journal.record(c.rel)
    const dest = join(ctx.o.targetDir, c.rel)
    ctx.fsx.mkdirSync(dirname(dest), { recursive: true })
    ctx.fsx.renameSync(join(staging, c.rel), dest)
  }
}

/** FR-27 points 1 to 3 again, on dataDir() after the renames, plus the real load. */
function verifyTarget(ctx: Ctx, verdict: StagingVerdict, moved: Copied[]): NonNullable<LegacyMigrationMarker['verified']> {
  const target = ctx.o.targetDir
  for (const c of moved) {
    const live = ctx.fsx.readFileSync(join(target, c.rel)) as Buffer
    if (sha256(live) !== c.sha256) throw new MigrationError('targetHash')
  }
  const movedDevices = moved.some((c) => c.rel === DEVICES_FILE)
  if (movedDevices) {
    const live = devicesFingerprint(ctx.fsx.readFileSync(join(target, DEVICES_FILE)) as Buffer)
    if (live.fingerprint !== verdict.devices.fingerprint) throw new MigrationError('devicesMismatch')
  }
  let effectiveConfigSha256: string | null = null
  if (verdict.legacyEff) {
    const targetEff = loadLadder(target)
    if (!sameEffective(verdict.legacyEff, targetEff)) throw new MigrationError('configMismatch')
    const real = ctx.o.loadTargetConfig ? ctx.o.loadTargetConfig() : targetEff?.config
    if (!real) throw new MigrationError('configLoad')
    effectiveConfigSha256 = sha256(canonicalJson(verdict.legacyEff.config))
  }
  return {
    at: ctx.now(),
    legacyConfigLoadable: verdict.legacyEff !== null,
    effectiveConfigSha256,
    workspaces: verdict.legacyEff?.config.workspaces.length ?? 0,
    presets: verdict.legacyEff?.config.presets.length ?? 0,
    devices: movedDevices ? verdict.devices.count : 0,
    backups: moved.filter((c) => c.rel.startsWith('backups/')).length,
  }
}

/** FR-27 point 4: the whitelist and every hash are still what was copied. */
function sourcesUnchanged(ctx: Ctx, legacyDir: string, copied: Copied[]): boolean {
  const now = listLegacyWhitelist(legacyDir, ctx.fsx)
  if (now.length !== copied.length || now.some((rel, i) => rel !== copied[i].rel)) return false
  return copied.every((c) => {
    try {
      return sha256(readWithRetry(ctx, join(legacyDir, c.rel))) === c.sha256
    } catch {
      return false
    }
  })
}

/**
 * Saves the destination's own config.json (and .bak) to pre-import/ before the
 * legacy one wins. Returns the relative path, or null when there is no config
 * or its hash matches a source or an earlier snapshot (a retry over data that
 * was already migrated adds no copy). Rotation keeps the FIRST snapshot (the
 * destination's original config never rotates out) and the 2 newest.
 */
export function snapshotCurrentConfig(targetDir: string, sourceHashes: string[], now: number = Date.now(), fsx: PipelineFs = nodeFs): string | null {
  const live = join(targetDir, 'config.json')
  if (!isRegularFile(fsx, live)) return null
  const data = fsx.readFileSync(live) as Buffer
  const hash = sha256(data)
  if (sourceHashes.includes(hash)) return null
  const dir = join(targetDir, PRE_IMPORT_DIR)
  const list = (): string[] =>
    fsx.existsSync(dir)
      ? fsx.readdirSync(dir).map(String).filter((n) => BACKUP_NAME.test(n)).sort()
      : []
  for (const n of list()) {
    if (sha256(fsx.readFileSync(join(dir, n)) as Buffer) === hash) return null
  }
  fsx.mkdirSync(dir, { recursive: true })
  // Same-millisecond collision: step the stamp forward so names keep sorting by time.
  let stampMs = now
  while (fsx.existsSync(join(dir, `config-${isoStamp(stampMs)}.json`))) stampMs++
  const name = `config-${isoStamp(stampMs)}.json`
  fsx.writeFileSync(join(dir, name), data)
  const bak = join(targetDir, 'config.json.bak')
  if (isRegularFile(fsx, bak)) fsx.copyFileSync(bak, join(dir, `${name}.bak`))
  const all = list()
  const keep = new Set([all[0], ...all.slice(-2)])
  for (const n of all) {
    if (keep.has(n)) continue
    fsx.rmSync(join(dir, n), { force: true })
    fsx.rmSync(join(dir, `${n}.bak`), { force: true })
  }
  return `${PRE_IMPORT_DIR}/${name}`
}

/** realpath of p, or of its nearest existing ancestor with the rest appended (dataDir() may not exist yet). */
export function realPathDeep(p: string): string {
  const rest: string[] = []
  let cur = resolve(p)
  for (;;) {
    try {
      return join(nodeFs.realpathSync.native(cur), ...rest.reverse())
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return resolve(p)
      rest.push(basename(cur))
      cur = parent
    }
  }
}

function usableLegacyDir(ctx: Ctx): string | null {
  const dir = ctx.o.legacyDir
  if (!dir || !isRealDir(ctx.fsx, dir)) return null
  // Also through a junction, a symlink, a subst drive or an 8.3 name of either.
  if (overlaps(dir, ctx.o.targetDir) || overlaps(realPathDeep(dir), realPathDeep(ctx.o.targetDir))) {
    // --user-data-dir on the 1.x folder (or nested in it): nothing to copy, the
    // cleanup guard keeps the folder too.
    ctx.log(`detect skip=overlap path=${dir}`)
    return null
  }
  return dir
}

function hasDestinationData(ctx: Ctx): boolean {
  return ctx.fsx.existsSync(join(ctx.o.targetDir, 'config.json')) || ctx.fsx.existsSync(join(ctx.o.targetDir, BACKUP_FILE))
}

function commitNoLegacy(ctx: Ctx, legacyDir: string | null, attempts: number): PipelineResult {
  const at = ctx.now()
  const m: LegacyMigrationMarker = {
    ...newMarker({ phase: 'committed', mode: ctx.o.mode, from: legacyDir, to: ctx.o.targetDir, appVersion: ctx.o.appVersion, now: at, attempts }),
    outcome: 'noLegacy',
    committedAt: at,
    cleanup: pendingCleanup(),
  }
  const existing = adoptBackup(ctx)
  const extras = collectExtras(ctx)
  if (existing) {
    // A zip from before a lost marker keeps its own dates; extras join it.
    m.backup = existing
    if (extras.length > 0) appendToBackup(ctx.o.targetDir, m, extras, at, ctx.fsx)
  } else if (extras.length > 0) {
    // Only no-data items to back up: the zip holds just those (FR-28).
    m.backup = writePipelineBackup(ctx, extras, at)
  }
  writeMarker(ctx.o.targetDir, m, ctx.fsx)
  ctx.log(`phase=committed outcome=noLegacy path=${legacyDir ?? '-'}`)
  return { status: 'committed', marker: m }
}

function backupPath(targetDir: string): string {
  return join(targetDir, BACKUP_FILE)
}

/** The extras that exist, read once (they are never migrated, only backed up). */
function collectExtras(ctx: Ctx): BackupEntry[] {
  const out: BackupEntry[] = []
  const add = (name: string, p: string | null | undefined): void => {
    if (!p) return
    const data = readIfFile(ctx, p)
    if (data && data.length <= MAX_SOURCE_BYTES) out.push({ name, data, source: p })
  }
  add('claude/settings.json.snmulticc.bak', ctx.o.extras?.claudeBak)
  const dev = ctx.o.extras?.devDir
  if (dev && isRealDir(ctx.fsx, dev)) {
    add('dev/config.json', join(dev, 'config.json'))
    add('dev/remote-devices.json', join(dev, DEVICES_FILE))
  }
  return out
}

/** Writes the zip, reopens it and checks every entry (FR-28) before the phase may advance. */
function writePipelineBackup(ctx: Ctx, entries: BackupEntry[], createdAt: number): NonNullable<LegacyMigrationMarker['backup']> {
  const expiresAt = createdAt + BACKUP_TTL_MS
  const manifest = buildManifest(entries, ctx.o.appVersion, createdAt, expiresAt)
  const dest = backupPath(ctx.o.targetDir)
  let written: { bytes: number; sha256: string }
  try {
    ctx.fsx.mkdirSync(ctx.o.targetDir, { recursive: true })
    written = writeBackupZip(dest, entries, manifest, ctx.fsx)
  } catch (err) {
    throw new MigrationError(errCode(err))
  }
  if (!verifyBackupZip(dest, manifest, ctx.fsx)) throw new MigrationError('backupVerify')
  return { file: BACKUP_FILE, bytes: written.bytes, sha256: written.sha256, entries: entries.length, createdAt, expiresAt }
}

/**
 * What a new pipeline zip must carry from the zip already in dataDir(): all
 * of it (raw, readable or not) when the marker does not account for it, or
 * the previous/ entry an interrupted earlier run had carried. raw is the file
 * as it is now, put back if this run fails.
 */
function readInheritedZip(ctx: Ctx, prior: LegacyMigrationMarker | null): { raw: Buffer; entry: Buffer } | null {
  const dest = backupPath(ctx.o.targetDir)
  if (!isRegularFile(ctx.fsx, dest)) return null
  const raw = ctx.fsx.readFileSync(dest) as Buffer
  if (!prior?.backup) return { raw, entry: raw }
  try {
    const carried = decodeZip(raw).entries.find((e) => e.name === `previous/${BACKUP_FILE}`)
    return carried ? { raw, entry: carried.data } : null
  } catch {
    return null
  }
}

/** Puts an inherited zip back after a failed run (tmp + rename). */
function restoreInheritedZip(ctx: Ctx, raw: Buffer): void {
  const dest = backupPath(ctx.o.targetDir)
  try {
    ctx.fsx.writeFileSync(`${dest}.tmp`, raw)
    ctx.fsx.renameSync(`${dest}.tmp`, dest)
  } catch (err) {
    ctx.log(`phase=failed result=inheritedBackupRestoreError code=${errCode(err)}`)
  }
}

/** A readable zip already in dataDir() (marker lost or rebuilt): adopted with its original dates. */
function adoptBackup(ctx: Ctx): LegacyMigrationMarker['backup'] {
  const dest = backupPath(ctx.o.targetDir)
  if (!isRegularFile(ctx.fsx, dest)) return undefined
  try {
    const { manifest } = readBackupZip(dest, ctx.fsx)
    const data = ctx.fsx.readFileSync(dest) as Buffer
    return { file: BACKUP_FILE, bytes: data.length, sha256: sha256(data), entries: manifest.entries.length, createdAt: manifest.createdAt, expiresAt: manifest.expiresAt }
  } catch {
    return undefined
  }
}

/**
 * Adds entries to the committed backup (post-commit/<ISO>/ copies of sources
 * that changed after the commit, other/ unknown entries, late extras). Keeps
 * createdAt and expiresAt; skips an entry whose source and SHA-256 are already
 * in the manifest, so a retried cleanup item adds nothing twice. When the zip
 * no longer exists (expired, or there never was one) a new one is started.
 * Mutates marker.backup and returns how many entries were added; throws with
 * a code (backupTooLarge, backupVerify, backupFormat...) without touching the
 * existing zip, which is only replaced by a verified rename.
 */
export function appendToBackup(
  targetDir: string,
  marker: LegacyMigrationMarker,
  entries: BackupEntry[],
  now: number,
  fsx: PipelineFs = nodeFs,
): number {
  const dest = backupPath(targetDir)
  const live = marker.backup && marker.backup.deletedAt === undefined && fsx.existsSync(dest)
  const current = live ? readBackupZip(dest, fsx) : null
  const createdAt = current ? current.manifest.createdAt : now
  const expiresAt = current ? current.manifest.expiresAt : now + BACKUP_TTL_MS
  const key = (source: string, hash: string): string => `${source}|${hash}`
  const known = new Set((current?.manifest.entries ?? []).map((e) => key(e.source, e.sha256)))
  const fresh = entries.filter((e) => !known.has(key(e.source, sha256(e.data))))
  if (fresh.length === 0) return 0
  const all = [...(current?.entries ?? []), ...fresh]
  fsx.mkdirSync(targetDir, { recursive: true })
  const manifest = buildManifest(all, current?.manifest.appVersion ?? marker.appVersion, createdAt, expiresAt)
  const written = writeBackupZip(dest, all, manifest, fsx)
  if (!verifyBackupZip(dest, manifest, fsx)) throw Object.assign(new Error('backupVerify'), { code: 'backupVerify' })
  marker.backup = { file: BACKUP_FILE, bytes: written.bytes, sha256: written.sha256, entries: all.length, createdAt, expiresAt }
  return fresh.length
}

/**
 * Deletes the zip on the first check after expiresAt (createdAt + 30 days),
 * with the marker in committed, cleaning or done: a forever-deferred item must
 * not keep the zip forever. A clock running behind deletes nothing early.
 * Returns true when the marker changed (deletedAt written).
 */
export function maintainBackup(targetDir: string, now: number, fsx: PipelineFs = nodeFs, log: (line: string) => void = () => {}): boolean {
  const read = readMarker(targetDir, fsx)
  if (read.kind !== 'ok') return false
  const m = read.marker
  if (!isCommittedPhase(m.phase) || !m.backup || m.backup.deletedAt !== undefined || now <= m.backup.expiresAt) return false
  fsx.rmSync(backupPath(targetDir), { force: true })
  m.backup = { ...m.backup, deletedAt: now }
  m.at = now
  writeMarker(targetDir, m, fsx)
  log(`phase=${m.phase} item=backup result=expired path=${BACKUP_FILE}`)
  return true
}

export function runPipeline(o: MigrateOptions): PipelineResult {
  const ctx: Ctx = {
    o,
    fsx: o.fs ?? nodeFs,
    now: o.now ?? Date.now,
    log: o.log ?? (() => {}),
    sleep: o.sleep ?? sleepSync,
    counters: new Map(),
  }
  const { fsx } = ctx
  const target = o.targetDir
  const legacyDir = usableLegacyDir(ctx)
  const read = readMarker(target, fsx)
  let prior: LegacyMigrationMarker | null = null

  if (read.kind === 'ok') {
    if (isCommittedPhase(read.marker.phase)) {
      // A crash right after the commit may leave a stale staging folder: discard it, never roll it back.
      if (fsx.existsSync(join(target, STAGING_DIR))) fsx.rmSync(join(target, STAGING_DIR), { recursive: true, force: true })
      return { status: 'alreadyCommitted', marker: read.marker }
    }
    prior = read.marker
    // markerCorrupt is sticky while the legacy folder exists: no safe way to know what the destination holds.
    if (prior.phase === 'failed' && prior.lastError?.code === 'markerCorrupt' && legacyDir) return { status: 'failed', marker: prior }
  } else if (read.kind === 'corrupt') {
    const moved = quarantineMarker(target, ctx.now(), fsx)
    ctx.log(`phase=detect result=markerCorrupt path=${moved ?? '-'}`)
    if (legacyDir && hasDestinationData(ctx)) {
      const at = ctx.now()
      const m: LegacyMigrationMarker = {
        ...newMarker({ phase: 'failed', mode: o.mode, from: legacyDir, to: target, appVersion: o.appVersion, now: at }),
        lastError: { phase: 'migrating', code: 'markerCorrupt', at },
      }
      writeMarker(target, m, fsx)
      ctx.log('phase=failed code=markerCorrupt')
      return { status: 'failed', marker: m }
    }
  }

  // A run killed after moving files leaves its journal: put the destination back first.
  const journal = new UndoJournal(target, fsx)
  if (journal.load()) {
    journal.rollback()
    ctx.log('phase=migrating result=rolledBackInterruptedRun')
  }
  clearStaging(ctx, true)

  const rels = legacyDir ? listLegacyWhitelist(legacyDir, fsx, ctx.log) : []
  if (!legacyDir || rels.length === 0) {
    try {
      return commitNoLegacy(ctx, legacyDir, prior?.attempts ?? 0)
    } catch (err) {
      // Read-only data folder or a failed zip: not committed, so nothing gets cleaned.
      const at = ctx.now()
      const failed: LegacyMigrationMarker = {
        ...newMarker({ phase: 'failed', mode: o.mode, from: legacyDir, to: target, appVersion: o.appVersion, now: at, attempts: (prior?.attempts ?? 0) + 1 }),
        lastError: { phase: 'backedUp', code: errCode(err), at },
      }
      try {
        writeMarker(target, failed, fsx)
      } catch {
        /* the folder itself is not writable; the log says why */
      }
      ctx.log(`phase=failed during=noLegacy code=${errCode(err)}`)
      return { status: 'failed', marker: failed }
    }
  }
  if (o.isLegacyRunning()) {
    ctx.log('phase=detect result=legacyRunning')
    return { status: 'legacyRunning' }
  }

  const seenHashes: string[] = (prior?.sources ?? []).map((s) => s.sha256)
  let m: LegacyMigrationMarker = {
    ...newMarker({ phase: 'migrating', mode: o.mode, from: legacyDir, to: target, appVersion: o.appVersion, now: ctx.now(), attempts: (prior?.attempts ?? 0) + 1 }),
    ...(prior?.preImportSnapshot ? { preImportSnapshot: prior.preImportSnapshot } : {}),
  }
  let phase: LegacyPhase = 'migrating'
  // Every rewrite within this run keeps the first createdAt (and so the expiry).
  let createdAt: number | undefined
  let wroteBackup = false
  const extras = collectExtras(ctx)
  // A zip this marker does not account for (the marker was lost after an
  // earlier commit) may hold the only copy of items already cleaned: it rides
  // inside the new zip, and a failed run puts it back as it was.
  const inherited = readInheritedZip(ctx, prior)
  if (inherited) {
    extras.push({ name: `previous/${BACKUP_FILE}`, data: inherited.entry, source: backupPath(target) })
    ctx.log(`phase=migrating result=inheritedBackup bytes=${inherited.entry.length}`)
  }
  try {
    for (let round = 1; ; round++) {
      phase = 'migrating'
      m = { ...m, phase, sources: [], at: ctx.now() }
      writeMarker(target, m, fsx)
      ctx.log(`phase=migrating attempt=${m.attempts} round=${round} path=${legacyDir}`)
      fault(ctx, 'migrating')
      clearStaging(ctx, false)
      const current = round === 1 ? rels : listLegacyWhitelist(legacyDir, fsx, ctx.log)
      const copied = copySources(ctx, legacyDir, current)
      m.sources = copied.map(({ rel, bytes, sha256: h, mtimeMs }) => ({ rel, bytes, sha256: h, mtimeMs }))
      seenHashes.push(...copied.map((c) => c.sha256))

      const verdict = verifyStaging(ctx, legacyDir, copied)
      const moving = filesToMove(ctx, copied, verdict)
      if (verdict.legacyEff) {
        const snap = snapshotCurrentConfig(target, seenHashes, ctx.now(), fsx)
        if (snap) {
          m.preImportSnapshot = snap
          ctx.log(`phase=migrating result=preImportSnapshot path=${snap}`)
        }
        displaceShadowingConfigs(ctx, verdict, moving, journal, seenHashes)
      }
      moveIntoPlace(ctx, moving, journal)
      const verified = verifyTarget(ctx, verdict, moving)
      phase = 'verified'
      m = { ...m, phase, verified, at: ctx.now() }
      writeMarker(target, m, fsx)
      ctx.log(`phase=verified legacyConfigLoadable=${verified.legacyConfigLoadable} workspaces=${verified.workspaces} devices=${verified.devices} backups=${verified.backups}`)
      fault(ctx, 'verified')

      phase = 'backedUp'
      createdAt ??= ctx.now()
      const entries = [...copied.map((c) => ({ name: c.rel, data: c.data, source: join(legacyDir, c.rel) })), ...extras]
      wroteBackup = true
      const backup = writePipelineBackup(ctx, entries, createdAt)
      m = { ...m, phase, backup, at: ctx.now() }
      writeMarker(target, m, fsx)
      ctx.log(`phase=backedUp entries=${backup.entries} bytes=${backup.bytes}`)
      fault(ctx, 'backedUp')

      if (!sourcesUnchanged(ctx, legacyDir, copied)) {
        if (round >= MAX_ROUNDS) throw new MigrationError('sourcesChanged')
        ctx.log(`phase=backedUp result=sourcesChanged round=${round}`)
        continue
      }
      const at = ctx.now()
      const committed: LegacyMigrationMarker = {
        ...m,
        phase: 'committed',
        outcome: 'migrated',
        committedAt: at,
        hooksMigration: 'pending',
        loginItemMigrated: false,
        noticeSeen: false,
        cleanup: pendingCleanup(),
        cleanupStarts: 0,
        at,
      }
      delete committed.lastError
      writeMarker(target, committed, fsx)
      clearStaging(ctx, true)
      ctx.log(`phase=committed outcome=migrated sources=${copied.length}`)
      fault(ctx, 'committed')
      return { status: 'committed', marker: committed }
    }
  } catch (err) {
    if (err instanceof CrashFault) throw err
    const code = errCode(err)
    let rolledBack = true
    try {
      journal.rollback()
    } catch (rollbackErr) {
      rolledBack = false
      ctx.log(`phase=failed result=rollbackError code=${errCode(rollbackErr)}`)
    }
    // A rollback that did not finish keeps undo/ (the destination's originals)
    // for the next start, which rolls back again before anything else.
    clearStaging(ctx, rolledBack)
    // Not committed, so the zip this run wrote protects nothing yet: drop it
    // with the rest, or put back the one that was there before the run.
    if (wroteBackup) {
      fsx.rmSync(`${backupPath(target)}.tmp`, { force: true })
      if (inherited) restoreInheritedZip(ctx, inherited.raw)
      else fsx.rmSync(backupPath(target), { force: true })
    }
    const at = ctx.now()
    const failed: LegacyMigrationMarker = { ...m, phase: 'failed', lastError: { phase, code, at }, at }
    delete failed.backup
    try {
      writeMarker(target, failed, fsx)
    } catch (writeErr) {
      ctx.log(`phase=failed result=markerWriteError code=${errCode(writeErr)}`)
    }
    ctx.log(`phase=failed during=${phase} code=${code} attempt=${failed.attempts}`)
    return { status: 'failed', marker: failed }
  }
}
