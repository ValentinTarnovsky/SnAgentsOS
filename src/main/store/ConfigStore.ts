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
import type { ConfigFile } from '@shared/types'
import { getConfigPath } from '../paths'
import { parseConfig } from './schema'

/** How many timestamped history snapshots to keep in the backups/ folder. */
const MAX_BACKUPS = 12
/** Minimum gap between timestamped history snapshots (the .bak last-good is always fresh). */
const ROTATE_EVERY_MS = 10 * 60 * 1000

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

  get filePath(): string {
    return this.path
  }

  load(): ConfigFile | null {
    const primary = this.tryRead(this.path)
    if (primary) return primary

    // Primary missing or corrupt, recover from the last-good snapshot or history.
    const recovered = this.tryRead(this.bakPath) ?? this.tryReadNewestBackup()
    if (recovered) {
      console.warn('[ConfigStore] primary config unreadable, recovered from backup.')
      return recovered
    }
    return null
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

  private tryRead(p: string): ConfigFile | null {
    try {
      if (!existsSync(p)) return null
      return parseConfig(JSON.parse(readFileSync(p, 'utf8')))
    } catch {
      return null
    }
  }

  private tryReadNewestBackup(): ConfigFile | null {
    try {
      if (!existsSync(this.backupDir)) return null
      const files = readdirSync(this.backupDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .reverse()
      for (const f of files) {
        const cfg = this.tryRead(join(this.backupDir, f))
        if (cfg) return cfg
      }
    } catch {
      /* ignore */
    }
    return null
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
