import { z } from 'zod'
import type { ConfigFile } from '@shared/types'

export const CONFIG_VERSION = 1

const paneType = z.enum(['shell', 'claude', 'codex', 'custom'])

const paneSchema = z.object({
  id: z.string(),
  type: paneType,
  presetId: z.string().optional(),
  cwd: z.string().optional(),
  command: z.string().optional(),
  title: z.string(),
  color: z.string(),
  icon: z.string(),
})

const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
  panes: z.array(paneSchema),
  layout: z.unknown().optional(),
})

const presetSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: paneType,
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string()).optional(),
  color: z.string(),
  icon: z.string(),
  defaultCwd: z.string().optional(),
})

const settingsSchema = z.object({
  defaultShell: z.object({
    win32: z.string().optional(),
    darwin: z.string().optional(),
    linux: z.string().optional(),
  }),
  fontFamily: z.string(),
  fontSize: z.number(),
  accent: z.enum(['violet', 'purple', 'blue']),
  scrollback: z.number(),
  restoreLastWorkspace: z.boolean(),
  confirmCloseRunning: z.boolean(),
  sidebarCollapsed: z.boolean(),
})

const configSchema = z.object({
  version: z.number(),
  workspaces: z.array(workspaceSchema),
  presets: z.array(presetSchema),
  settings: settingsSchema,
  activeWorkspaceId: z.string().nullable().optional(),
})

/** Validates a raw parsed object into a ConfigFile, or null if invalid. */
export function parseConfig(raw: unknown): ConfigFile | null {
  const result = configSchema.safeParse(raw)
  if (!result.success) return null
  return migrate(result.data as ConfigFile)
}

/** Forward migrations live here as the schema version grows. */
function migrate(config: ConfigFile): ConfigFile {
  // v1 is the current shape — nothing to migrate yet.
  return { ...config, version: CONFIG_VERSION }
}
