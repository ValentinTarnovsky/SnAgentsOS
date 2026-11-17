/**
 * App 2.12.0: whether the narrator mod (narrator@better-claude) can talk in
 * the user's Claude consoles, so Settings > Voice tells them to run
 * `/narrator off` and two voices never overlap. Read only, never written.
 *
 * 2.11.0 looked only at enabledPlugins, so the warning stayed after
 * `/narrator off`. The mod keeps its switch in its own plugin store,
 * <claude config>/plugins/store/narrator_better-claude-<hash>.json
 * (`{"enabled": true|false}`, off until switched on). With the plugin
 * enabled: a store file that says `enabled: true` warns, store files that all
 * say otherwise do not, and no store file at all still warns (the state is
 * unknown, so the old answer stands).
 */
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

export const NARRATOR_PLUGIN_ID = 'narrator@better-claude'
const STORE_FILE_RE = /^narrator_better-claude-[A-Za-z0-9]+\.json$/

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''))
}

export function narratorModOn(claudeDir: string): boolean {
  try {
    const settings = readJson(join(claudeDir, 'settings.json')) as { enabledPlugins?: Record<string, unknown> } | null
    if (settings?.enabledPlugins?.[NARRATOR_PLUGIN_ID] !== true) return false
  } catch {
    return false
  }
  let files: string[] = []
  const storeDir = join(claudeDir, 'plugins', 'store')
  try {
    files = readdirSync(storeDir).filter((f) => STORE_FILE_RE.test(f))
  } catch {
    files = []
  }
  if (!files.length) return true
  return files.some((f) => {
    try {
      return (readJson(join(storeDir, f)) as { enabled?: unknown } | null)?.enabled === true
    } catch {
      return false
    }
  })
}
