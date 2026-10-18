import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'

/**
 * State of the 1.x migration and cleanup (E0-FR-29). Lives in
 * dataDir()/legacy-migration.json, never in config.json, so CONFIG_VERSION
 * stays at 10. Main is its only writer: one atomic write (tmp + rename, UTF-8
 * without BOM) per phase transition and per cleanup item, and the previous
 * version is copied to legacy-migration.prev.json first, so a torn or corrupt
 * marker can fall back one step. Writing phase 'committed' with committedAt is
 * the ONLY condition that allows deleting anything that belongs to 1.x.
 */

export const MARKER_FILE = 'legacy-migration.json'
export const MARKER_PREV_FILE = 'legacy-migration.prev.json'
export const MARKER_CORRUPT_PREFIX = 'legacy-migration.json.corrupt-'
export const STAGING_DIR = '.legacy-staging'
export const PRE_IMPORT_DIR = 'pre-import'
export const BACKUP_FILE = 'migration-backup-v1.zip'
export const LOG_DIR = 'logs'
export const LOG_FILE = 'legacy-migration.log'
export const BACKUP_TTL_MS = 30 * 24 * 60 * 60 * 1000

export const LEGACY_PHASES = ['migrating', 'verified', 'backedUp', 'committed', 'cleaning', 'done', 'failed'] as const
export type LegacyPhase = (typeof LEGACY_PHASES)[number]

export const LEGACY_ITEM_IDS = [
  'L01', 'L02', 'L03', 'L04', 'L05', 'L06', 'L07', 'L08', 'L09', 'L10', 'L11',
  'L12', 'L13', 'L14', 'L15', 'L16', 'L17', 'L18', 'L19', 'L20', 'L21',
] as const
export type LegacyItemId = (typeof LEGACY_ITEM_IDS)[number]

export const LEGACY_ITEM_STATES = ['pending', 'done', 'absent', 'skipped', 'deferred'] as const
export type LegacyItemState = (typeof LEGACY_ITEM_STATES)[number]

export interface LegacySource {
  rel: string
  bytes: number
  sha256: string
  mtimeMs: number
}

export interface LegacyItemStatus {
  state: LegacyItemState
  attempts: number
  reason?: string
  at?: number
}

export interface LegacyMigrationMarker {
  v: 2
  phase: LegacyPhase
  outcome?: 'migrated' | 'noLegacy'
  mode: 'installed' | 'portable'
  from: string | null
  to: string
  attempts: number
  sources: LegacySource[]
  verified?: {
    at: number
    legacyConfigLoadable: boolean
    effectiveConfigSha256: string | null
    workspaces: number
    presets: number
    devices: number
    backups: number
  }
  preImportSnapshot?: string
  backup?: {
    file: typeof BACKUP_FILE
    bytes: number
    sha256: string
    entries: number
    createdAt: number
    expiresAt: number
    deletedAt?: number
  }
  committedAt?: number
  postCommitBackup?: { at: number; entries: number }
  hooksMigration: 'pending' | 'rewritten' | 'notNeeded'
  loginItemMigrated: boolean
  pinRetargeted?: boolean
  portableExeRenamedTo?: string
  cleanup: Partial<Record<LegacyItemId, LegacyItemStatus>>
  cleanupStarts: number
  noticeSeen: boolean
  lastError?: { phase: LegacyPhase; code: string; at: number }
  appVersion: string
  at: number
}

export type ReadMarkerResult =
  | { kind: 'absent' }
  | { kind: 'ok'; marker: LegacyMigrationMarker; from: 'main' | 'prev' }
  | { kind: 'corrupt' }

const phaseSchema = z.enum(LEGACY_PHASES)
const itemSchema = z.object({
  state: z.enum(LEGACY_ITEM_STATES),
  attempts: z.number().int().nonnegative(),
  reason: z.string().optional(),
  at: z.number().optional(),
})

const markerSchema = z.object({
  v: z.literal(2),
  phase: phaseSchema,
  outcome: z.enum(['migrated', 'noLegacy']).optional(),
  mode: z.enum(['installed', 'portable']),
  from: z.string().nullable(),
  to: z.string(),
  attempts: z.number().int().nonnegative(),
  sources: z.array(z.object({ rel: z.string(), bytes: z.number(), sha256: z.string(), mtimeMs: z.number() })),
  verified: z
    .object({
      at: z.number(),
      legacyConfigLoadable: z.boolean(),
      effectiveConfigSha256: z.string().nullable(),
      workspaces: z.number(),
      presets: z.number(),
      devices: z.number(),
      backups: z.number(),
    })
    .optional(),
  preImportSnapshot: z.string().optional(),
  backup: z
    .object({
      file: z.literal(BACKUP_FILE),
      bytes: z.number(),
      sha256: z.string(),
      entries: z.number(),
      createdAt: z.number(),
      expiresAt: z.number(),
      deletedAt: z.number().optional(),
    })
    .optional(),
  committedAt: z.number().optional(),
  postCommitBackup: z.object({ at: z.number(), entries: z.number() }).optional(),
  hooksMigration: z.enum(['pending', 'rewritten', 'notNeeded']),
  loginItemMigrated: z.boolean(),
  pinRetargeted: z.boolean().optional(),
  portableExeRenamedTo: z.string().optional(),
  cleanup: z.record(z.enum(LEGACY_ITEM_IDS), itemSchema),
  cleanupStarts: z.number().int().nonnegative(),
  noticeSeen: z.boolean(),
  lastError: z.object({ phase: phaseSchema, code: z.string(), at: z.number() }).optional(),
  appVersion: z.string(),
  at: z.number(),
})

/** Phases after which nothing is copied again and the cleanup may run. */
export function isCommittedPhase(phase: LegacyPhase | undefined): boolean {
  return phase === 'committed' || phase === 'cleaning' || phase === 'done'
}

/** done, absent and skipped end an item; pending and deferred keep it open. */
export function isTerminalItem(state: LegacyItemState | undefined): boolean {
  return state === 'done' || state === 'absent' || state === 'skipped'
}

/** Every inventory item in pending, as the commit leaves them. */
export function pendingCleanup(): Partial<Record<LegacyItemId, LegacyItemStatus>> {
  const cleanup: Partial<Record<LegacyItemId, LegacyItemStatus>> = {}
  for (const id of LEGACY_ITEM_IDS) cleanup[id] = { state: 'pending', attempts: 0 }
  return cleanup
}

/** Filesystem-safe ISO stamp (no ':' or '.', both invalid or awkward in Windows names). */
export function isoStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[:.]/g, '-')
}

type MarkerFs = Pick<typeof import('fs'), 'existsSync' | 'readFileSync' | 'writeFileSync' | 'renameSync' | 'copyFileSync' | 'mkdirSync'>
const realFs: MarkerFs = { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, mkdirSync }

type Parsed = { kind: 'ok'; marker: LegacyMigrationMarker } | { kind: 'oldVersion' } | { kind: 'invalid' }

function parseMarkerFile(path: string, fsx: MarkerFs): Parsed {
  try {
    const raw: unknown = JSON.parse(String(fsx.readFileSync(path, 'utf8')).replace(/^﻿/, ''))
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw) && (raw as { v?: unknown }).v !== 2) {
      return { kind: 'oldVersion' }
    }
    const parsed = markerSchema.safeParse(raw)
    return parsed.success ? { kind: 'ok', marker: parsed.data as LegacyMigrationMarker } : { kind: 'invalid' }
  } catch {
    return { kind: 'invalid' }
  }
}

/**
 * Absent and unreadable are different answers: a missing marker (or a v1 one,
 * which only test builds wrote) means "never migrated"; an unreadable one
 * falls back to the prev copy and, when that is unreadable too, is 'corrupt'
 * and the caller must not migrate over the destination.
 */
export function readMarker(targetDir: string, fsx: MarkerFs = realFs): ReadMarkerResult {
  const main = join(targetDir, MARKER_FILE)
  if (!fsx.existsSync(main)) return { kind: 'absent' }
  const parsed = parseMarkerFile(main, fsx)
  if (parsed.kind === 'ok') return { kind: 'ok', marker: parsed.marker, from: 'main' }
  if (parsed.kind === 'oldVersion') return { kind: 'absent' }
  const prev = join(targetDir, MARKER_PREV_FILE)
  if (fsx.existsSync(prev)) {
    const fallback = parseMarkerFile(prev, fsx)
    if (fallback.kind === 'ok') return { kind: 'ok', marker: fallback.marker, from: 'prev' }
  }
  return { kind: 'corrupt' }
}

/** Copies the current marker to prev, then writes tmp + rename (UTF-8, no BOM). */
export function writeMarker(targetDir: string, m: LegacyMigrationMarker, fsx: MarkerFs = realFs): void {
  fsx.mkdirSync(targetDir, { recursive: true })
  const main = join(targetDir, MARKER_FILE)
  const tmp = `${main}.tmp`
  if (fsx.existsSync(main) && parseMarkerFile(main, fsx).kind === 'ok') {
    fsx.copyFileSync(main, join(targetDir, MARKER_PREV_FILE))
  }
  fsx.writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n', 'utf8')
  fsx.renameSync(tmp, main)
}

/** Moves an unreadable marker aside as legacy-migration.json.corrupt-<ISO>; it is never read back. */
export function quarantineMarker(targetDir: string, now: number, fsx: MarkerFs = realFs): string | null {
  const main = join(targetDir, MARKER_FILE)
  if (!fsx.existsSync(main)) return null
  const name = MARKER_CORRUPT_PREFIX + isoStamp(now)
  fsx.renameSync(main, join(targetDir, name))
  return name
}

export function newMarker(fields: {
  phase: LegacyPhase
  mode: 'installed' | 'portable'
  from: string | null
  to: string
  appVersion: string
  now: number
  attempts?: number
}): LegacyMigrationMarker {
  return {
    v: 2,
    phase: fields.phase,
    mode: fields.mode,
    from: fields.from,
    to: fields.to,
    attempts: fields.attempts ?? 0,
    sources: [],
    hooksMigration: 'pending',
    loginItemMigrated: false,
    cleanup: {},
    cleanupStarts: 0,
    noticeSeen: false,
    appVersion: fields.appVersion,
    at: fields.now,
  }
}
