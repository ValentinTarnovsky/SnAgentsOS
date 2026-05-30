import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { ConfigFile } from '@shared/types'
import { getConfigPath } from '../paths'
import { parseConfig } from './schema'

/**
 * Reads/writes the single config.json blob. Path is resolved per run:
 * next to the executable when portable, else in userData (see paths.ts).
 */
export class ConfigStore {
  private readonly path = getConfigPath()

  get filePath(): string {
    return this.path
  }

  load(): ConfigFile | null {
    try {
      if (!existsSync(this.path)) return null
      return parseConfig(JSON.parse(readFileSync(this.path, 'utf8')))
    } catch (error) {
      console.error('Failed to load config:', error)
      return null
    }
  }

  save(config: ConfigFile): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, JSON.stringify(config, null, 2), 'utf8')
    } catch (error) {
      console.error('Failed to save config:', error)
    }
  }
}
