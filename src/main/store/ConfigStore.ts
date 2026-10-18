import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { dirname, join } from 'path'
import { CONFIG_VERSION, type ConfigFile } from '@shared/types'
import { getConfigPath } from '../paths'
import { parseConfig } from './schema'

/** How many timestamped history snapshots to keep in the backups/ folder. */
const MAX_BACKUPS = 12
/** Minimum gap between timestamped history snapshots (the .bak last-good is always fresh). */
const ROTATE_EVERY_MS = 10 * 60 * 1000

export interface LadderResult {
  config: ConfigFile
  /** `version` as written in the file, before parseConfig stamps CONFIG_VERSION. */
  rawVersion: number
  /** Which rung loaded: 'config.json', 'config.json.bak' or 'backups/<name>'. */
  source: string
}

function readRung(p: string): { config: ConfigFile; rawVersion: number } | null {
  try {
    if (!existsSync(p)) return null
    const raw: unknown = JSON.parse(readFileSync(p, 'utf8'))
    const config = parseConfig(raw)
    if (!config) return null
    const v = (raw as { version?: unknown }).version
    return { config, rawVersion: typeof v === 'number' ? v : 0 }
  } catch {
    return null
  }
}

/**
 * The load ladder as a pure, read-only function over a folder: config.json,
 * then config.json.bak, then the newest readable backups/*.json (alphabetical
 * order, which is why nothing but config-<ISO>.json may ever land there).
 * Never writes, rotates or repairs anything, so the legacy migration can run
 * it on the 1.x folder and on the copy to verify both load the same config
 * (E0-FR-27). ConfigStore.load() is this ladder over its own folder.
 */
export function loadLadder(dir: string): LadderResult | null {
  const primary = readRung(join(dir, 'config.json'))
  if (primary) return { ...primary, source: 'config.json' }
  const bak = readRung(join(dir, 'config.json.bak'))
  if (bak) return { ...bak, source: 'config.json.bak' }
  const backupDir = join(dir, 'backups')
  try {
    if (!existsSync(backupDir)) return null
    const files = readdirSync(backupDir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse()
    for (const f of files) {
      const hit = readRung(join(backupDir, f))
      if (hit) return { ...hit, source: `backups/${f}` }
    }
  } catch {
    /* ignore */
  }
  return null
}

/**
 * Reads/writes the single config.json blob. Path is resolved per run:
 * next to the executable when portable, else in userData (see paths.ts).
 *
 * Durability (the whole app state lives in one file, so a torn write is fatal):
 *  - saves are atomic (write a temp file, then rename over the live one),
 *  - the previous good blob is snapshotted to config.json.bak before each write,
 *  - a throttled, rotating history is kept under backups/,
 *  - load() transparently falls back to .bak / newest history when the primary
 *    file is missing, truncated, or fails schema validation.
 */
export class ConfigStore {
  private readonly path = getConfigPath()
  private readonly tmpPath = `${this.path}.tmp`
  private readonly bakPath = `${this.path}.bak`
  private readonly backupDir = join(dirname(this.path), 'backups')
  private lastRotateMs = 0
  /**
   * Which rung the last load() read: the primary file, a backup (.bak or
   * backups/), or nothing. The scrollback GC only trusts 'primary' (E6-FR-12):
   * a recovered config may have lost panes whose history must stay.
   */
  lastLoadSource: 'primary' | 'backup' | 'none' = 'none'

  get filePath(): string {
    return this.path
  }

  /**
   * `upgrade` (only the renderer's CONFIG_LOAD passes it): stamp an older
   * primary file once with the migrated blob. The renderer writes only on
   * relevant changes, so without this a config that is merely opened would
   * stay on the old schema version. save() keeps the pre-upgrade file as .bak
   * and in backups/. A newer file (downgrade) and a recovered rung are never
   * rewritten. Every other caller (the legacy migration's verification among
   * them) stays read-only.
   */
  load(opts?: { upgrade?: boolean }): ConfigFile | null {
    // Primary missing or corrupt: the ladder recovers from the last-good snapshot or history.
    const hit = loadLadder(dirname(this.path))
    this.lastLoadSource = !hit ? 'none' : hit.source === 'config.json' ? 'primary' : 'backup'
    if (hit && hit.source !== 'config.json') console.warn('[ConfigStore] primary config unreadable, recovered from backup.')
    if (opts?.upgrade && hit && hit.source === 'config.json' && hit.rawVersion < CONFIG_VERSION) this.save(hit.config)
    return hit?.config ?? null
  }

  save(config: ConfigFile): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const json = JSON.stringify(config, null, 2)

      // 1) Atomic write: serialize to a temp file first.
      writeFileSync(this.tmpPath, json, 'utf8')

      // 2) Snapshot the current good file before it is replaced.
      if (existsSync(this.path)) {
        try {
          copyFileSync(this.path, this.bakPath)
          this.rotateBackup()
        } catch {
          /* backups are best-effort; never block a save on them */
        }
      }

      // 3) Promote the temp file to the live config (rename is atomic same-volume).
      renameSync(this.tmpPath, this.path)
    } catch (error) {
      console.error('Failed to save config:', error)
    }
  }

  /** Copy the freshly-made .bak into the throttled, capped history folder. */
  private rotateBackup(): void {
    const now = Date.now()
    if (now - this.lastRotateMs < ROTATE_EVERY_MS) return
    this.lastRotateMs = now
    try {
      mkdirSync(this.backupDir, { recursive: true })
      const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
      copyFileSync(this.bakPath, join(this.backupDir, `config-${stamp}.json`))

      const files = readdirSync(this.backupDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
      while (files.length > MAX_BACKUPS) {
        const oldest = files.shift()
        if (oldest) rmSync(join(this.backupDir, oldest), { force: true })
      }
    } catch {
      /* ignore */
    }
  }
}
