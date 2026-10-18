import { z } from 'zod'
import { CONFIG_VERSION, type ConfigFile } from '@shared/types'
import { migrateQuickCommandsConfig } from '@shared/quickCommands'

export { CONFIG_VERSION }

export const discordSettingsSchema = z.object({
  enabled: z.boolean().default(false), webhookUrl: z.string().max(2048).default(''),
  userId: z.string().max(32).default(''), notifyAction: z.boolean().default(true), notifyDone: z.boolean().default(true),
})
// Schema 12 (E2-FR-40). Every field defaults on its own and a junk value falls
// back instead of invalidating the config. Topic and token never reach an export.
export const ntfySettingsSchema = z.object({
  enabled: z.boolean().catch(false).default(false),
  server: z.string().max(512).catch('https://ntfy.sh').default('https://ntfy.sh'),
  topic: z.string().regex(/^(?:[A-Za-z0-9_-]{1,64})?$/).catch('').default(''),
  token: z.string().max(128).catch('').default(''),
  notifyAction: z.boolean().catch(true).default(true),
  notifyDone: z.boolean().catch(false).default(false),
})
export const notificationSettingsSchema = z.object({
  enabled: z.boolean().default(true), notifyDone: z.boolean().default(true), notifyAction: z.boolean().default(true),
  sound: z.boolean().default(true), soundId: z.enum(['chime', 'ping', 'pop']).default('chime'), volume: z.number().min(0).max(100).default(70),
  flashTaskbar: z.boolean().default(true), hooksEnabled: z.boolean().default(false),
  hookPort: z.number().int().min(1024).max(65535).default(43917), hookToken: z.string().regex(/^(?:[a-f0-9]{32,64})?$/).default(''),
  codexEnabled: z.boolean().default(false), discord: discordSettingsSchema.default({}),
  inAppWhenFocused: z.boolean().default(true), // schema 11
  // Schema 12. A non-object value falls back to the defaults instead of
  // rejecting the whole config (the field-level catches only cover fields).
  ntfy: ntfySettingsSchema.default({}).catch(() => ntfySettingsSchema.parse({})),
  onlyWhenAway: z.boolean().catch(false).default(false), // schema 12
})

// Schema 11. Field-level defaults are the whole migration (migrate() only re-stamps).
export const agentSettingsSchema = z.object({
  resumeOnStartup: z.enum(['ask', 'auto', 'off']).catch('ask').default('ask'),
  awakeDisplay: z.boolean().default(false),
  sidebarAgentRows: z.boolean().default(true),
  topicAsTitle: z.boolean().default(true),
  ctrlDigitFocus: z.boolean().default(true),
  // Schema 12 (E5-FR-12/13/22), same tolerant field-level defaults.
  resumeModalTimeoutSec: z.number().int().min(0).max(600).catch(60).default(60),
  resumeNudge: z.boolean().catch(false).default(false),
  resumeNudgeText: z.string().max(500).catch('').default(''),
  sidebarSort: z.enum(['manual', 'smart']).catch('manual').default('manual'),
})

// Schema 12 (E8-FR-08/09). v3.0 adds the CLI and schedule fields here.
export const automationSettingsSchema = z.object({
  defaultAgentPresetId: z.string().max(128).catch('').default(''),
  composerCreateAnother: z.boolean().catch(false).default(false),
})

const paneType = z.enum(['shell', 'claude', 'codex', 'custom'])

const paneScheduleSchema = z.object({
  time: z.string(),
  prompt: z.string(),
  dueAt: z.number(),
})

const paneSchema = z.object({
  id: z.string(),
  type: paneType,
  presetId: z.string().optional(),
  cwd: z.string().optional(),
  command: z.string().optional(),
  setupId: z.string().optional(),
  title: z.string(),
  color: z.string(),
  icon: z.string(),
  fontSize: z.number().optional(),
  schedule: paneScheduleSchema.optional(),
  // Schema 11: a mirror of main's agent-sessions.json. A malformed value is
  // dropped instead of failing the whole config (which would fall back to .bak).
  lastSession: z
    .object({
      provider: z.enum(['claude', 'codex']),
      // Same charset as E5's SESSION_ID_RE, so an imported config can never
      // smuggle shell syntax into a resume command typed later.
      sessionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/),
      cwd: z.string().max(4096),
      at: z.number(),
    })
    .optional()
    .catch(undefined),
})

const setupStepSchema = z.object({
  send: z.string(),
  waitFor: z.string().optional(),
  timeoutMs: z.number().optional(),
  delayMs: z.number().optional(),
  secret: z.boolean().optional(),
  noEnter: z.boolean().optional(),
})

const connectionProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  steps: z.array(setupStepSchema),
})

const layoutSchema = z
  .object({
    grid: z.number(),
    order: z.array(z.string()),
  })
  .optional()
  // Old v1 configs stored an opaque dockview blob here, tolerate & drop it.
  .catch(undefined)

const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
  panes: z.array(paneSchema),
  favorite: z.boolean().optional(),
  layout: layoutSchema,
  setupId: z.string().optional(),
  agentsCollapsed: z.boolean().optional().catch(undefined), // schema 11
  // Schema 12 (E8-FR-10): an over-long note is clipped, a junk value dropped.
  note: z.string().transform((v) => v.slice(0, 140)).optional().catch(undefined),
  taskState: z.enum(['todo', 'doing', 'review', 'done']).optional().catch(undefined),
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

const usageCustomRowSchema = z.object({
  id: z.string(),
  label: z.string().default(''),
  source: z.enum(['claude', 'codex']).default('claude'),
  modelMatch: z.string().default(''),
  window: z.enum(['session5h', 'weekly7d', 'today', 'all']).default('session5h'),
  tokenBudget: z.number().optional(),
  enabled: z.boolean().default(true),
})

const usageSettingsSchema = z
  .object({
    enabled: z.boolean().default(true),
    claudeIntervalMs: z.number().default(60000),
    codexIntervalMs: z.number().default(10000),
    refreshOnFocus: z.boolean().default(true),
    showStatus: z.boolean().default(true),
    rows: z
      .object({
        claude5h: z.boolean().default(true),
        claude7d: z.boolean().default(true),
        claudeOpus7d: z.boolean().default(false),
        claudeSonnet7d: z.boolean().default(false),
        codex5h: z.boolean().default(true),
        codex7d: z.boolean().default(true),
      })
      .default({}),
    custom: z.array(usageCustomRowSchema).default([]),
  })
  .default({})

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
  // Field-level default is the load-bearing migration: parseConfig runs this
  // schema over every existing config, so configs that predate the key silently
  // gain 'canvas' WITHOUT any migrate() logic (migrate only re-stamps version).
  // .catch(): an unknown renderer value falls back to the safe engine instead
  // of invalidating the whole config.
  terminalRenderer: z.enum(['canvas', 'webgl']).catch('canvas').default('canvas'),
  // Same load-bearing-default pattern: pre-v9 configs silently gain `true`.
  terminalSelectionOverride: z.boolean().default(true),
  // Schema 11 (same load-bearing-default pattern, tolerant of junk values).
  terminalUnicode11: z.boolean().catch(true).default(true),
  terminalAgentEndChip: z.boolean().catch(true).default(true),
  awakeMode: z.enum(['auto', 'always', 'never']).catch('auto').default('auto'),
  // Schema 12 (E6-FR-01/08, E7-FR-06/07, E4-FR-13/34): same pattern.
  terminalSnapshotMode: z.enum(['auto', 'lazy', 'off']).catch('auto').default('auto'),
  persistScrollback: z.boolean().catch(true).default(true),
  persistScrollbackLines: z
    .number()
    .int()
    .transform((v) => Math.min(5000, Math.max(200, v)))
    .catch(2000)
    .default(2000),
  gitChip: z.boolean().catch(true).default(true),
  explorerMenu: z.boolean().catch(false).default(false),
  updateDismissedVersion: z.string().max(64).catch('').default(''),
  restoreLastWorkspace: z.boolean(),
  confirmCloseRunning: z.boolean(),
  autoCheckUpdates: z.boolean().default(true),
  closeToTray: z.boolean().default(true),
  launchOnStartup: z.boolean().default(false),
  globalHotkeyEnabled: z.boolean().default(false),
  globalHotkey: z.string().default('Super+Alt+O'),
  keymap: z.record(z.string()).default({}),
  sidebarCollapsed: z.boolean(),
  usage: usageSettingsSchema,
  // Field-level defaults migrate configs that predate the remote feature.
  remote: z
    .object({
      enabled: z.boolean().default(false),
      port: z.number().int().min(1024).max(65535).default(4517),
    })
    .default({}),
  // Field-level defaults migrate configs that predate the notifications feature.
  notifications: notificationSettingsSchema.default({}),
  // Schema 11: agent behavior settings, defaulted field by field.
  agents: agentSettingsSchema.default({}),
  // Schema 12: workspace composer defaults.
  automation: automationSettingsSchema.default({}).catch(() => automationSettingsSchema.parse({})),
})

const keyButtonSchema = z.object({
  id: z.string(),
  label: z.string(),
  seq: z.string(),
})

const configSchema = z.object({
  version: z.number(),
  workspaces: z.array(workspaceSchema),
  presets: z.array(presetSchema),
  settings: settingsSchema,
  activeWorkspaceId: z.string().nullable().optional(),
  // Schema 12 (E8-FR-01): items stay unknown here and migrate() validates them
  // one by one, so a broken command never empties the list. Only a non-array
  // value falls back to undefined.
  quickCommands: z.array(z.unknown()).optional().catch(undefined),
  // Schema <= 11 input only: migrate() converts it to quickCommands, also item
  // by item (a malformed snippet no longer drops all of them).
  snippets: z.array(z.unknown()).optional().catch(undefined),
  connections: z.array(connectionProfileSchema).optional().catch(undefined),
  keyButtons: z.array(keyButtonSchema).optional().catch(undefined),
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
 * v1 configs load without data loss. v10 -> v11 adds only defaulted keys.
 * v11 -> v12 is the one real transformation: `snippets` become global `send`
 * quick commands (once, only while `quickCommands` is missing) and `snippets`
 * is never carried forward. Idempotent: a second parse changes nothing.
 */
function migrate(config: ConfigFile): ConfigFile {
  const m = migrateQuickCommandsConfig(config)
  if (m.dropped > 0) console.warn(`[config] dropped ${m.dropped} invalid quick command(s)`)
  return { ...m.config, version: CONFIG_VERSION }
}
