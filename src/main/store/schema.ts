import { z } from 'zod'
import { CONFIG_VERSION, type ConfigFile } from '@shared/types'

export { CONFIG_VERSION }

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
  fontSize: z.number().optional(),
})

const layoutSchema = z
  .object({
    grid: z.number(),
    order: z.array(z.string()),
  })
  .optional()
  // Old v1 configs stored an opaque dockview blob here — tolerate & drop it.
  .catch(undefined)

const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
  panes: z.array(paneSchema),
  favorite: z.boolean().optional(),
  layout: layoutSchema,
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
  accent: z.enum(['violet', 'purple', 'blue']).default('violet'),
  theme: z
    .enum(['midnight', 'light', 'nord', 'dracula', 'solarized', 'custom'])
    .default('midnight'),
  customColors: z.record(z.string()).optional(),
  language: z.enum(['en', 'es']).default('en'),
  scrollback: z.number(),
  infiniteScrollback: z.boolean().default(true),
  restoreLastWorkspace: z.boolean(),
  confirmCloseRunning: z.boolean(),
  closeToTray: z.boolean().default(true),
  launchOnStartup: z.boolean().default(false),
  globalHotkeyEnabled: z.boolean().default(false),
  globalHotkey: z.string().default('Super+Alt+O'),
  keymap: z.record(z.string()).default({}),
  sidebarCollapsed: z.boolean(),
})

const snippetSchema = z.object({
  id: z.string(),
  name: z.string(),
  text: z.string(),
})

const configSchema = z.object({
  version: z.number(),
  workspaces: z.array(workspaceSchema),
  presets: z.array(presetSchema),
  settings: settingsSchema,
  activeWorkspaceId: z.string().nullable().optional(),
  snippets: z.array(snippetSchema).optional().catch(undefined),
})

/** Validates a raw parsed object into a ConfigFile, or null if invalid. */
export function parseConfig(raw: unknown): ConfigFile | null {
  const result = configSchema.safeParse(raw)
  if (!result.success) return null
  return migrate(result.data as unknown as ConfigFile)
}

/**
 * Forward migrations. The zod schema applies field-level defaults (theme,
 * language, closeToTray, …) and drops the legacy dockview `layout` blob, so
 * v1 configs load without data loss. Here we just stamp the current version.
 */
function migrate(config: ConfigFile): ConfigFile {
  return { ...config, version: CONFIG_VERSION }
}
