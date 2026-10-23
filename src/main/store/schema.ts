import { z } from 'zod'
import { CONFIG_VERSION, type ConfigFile } from '@shared/types'
import { migrateQuickCommandsConfig, QUICK_COMMAND_ID_MAX } from '@shared/quickCommands'

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
  // Schema 17: on by default (migrate() flips it once for older configs).
  codexEnabled: z.boolean().catch(true).default(true), discord: discordSettingsSchema.default({}),
  inAppWhenFocused: z.boolean().default(true), // schema 11
  // Schema 12. A non-object value falls back to the defaults instead of
  // rejecting the whole config (the field-level catches only cover fields).
  ntfy: ntfySettingsSchema.default({}).catch(() => ntfySettingsSchema.parse({})),
  onlyWhenAway: z.boolean().catch(false).default(false), // schema 12
})

// Schema 13 (E5-FR-28): Claude prompt cache countdown.
export const cacheTimerSettingsSchema = z.object({
  enabled: z.boolean().catch(false).default(false),
  ttlMinutes: z.union([z.literal(5), z.literal(60)]).catch(5).default(5),
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
  // Schema 13 (E5-FR-28).
  cacheTimer: cacheTimerSettingsSchema.default({}).catch(() => cacheTimerSettingsSchema.parse({})),
  // Schema 17 (app 2.4.0).
  syncAgentRename: z.boolean().catch(true).default(true),
  shellAgentDetect: z.boolean().catch(true).default(true),
})

// Schema 12 (E8-FR-08/09).
export const automationSettingsSchema = z.object({
  defaultAgentPresetId: z.string().max(128).catch('').default(''),
  composerCreateAnother: z.boolean().catch(false).default(false),
  // Schema 13 (E8-FR-22/29/30/31, R30-01 amendment). An out-of-range number
  // falls back to its default, like the schema 12 agent keys.
  cliProtectSsh: z.boolean().catch(true).default(true),
  cliUserPath: z.boolean().catch(false).default(false),
  scheduleGraceMin: z.number().int().min(0).max(1440).catch(120).default(120),
  scheduleMaxWaitMin: z.number().int().min(1).max(240).catch(30).default(30),
  scheduleNotify: z.boolean().catch(false).default(false),
})

// Schema 17 (app 2.4.0): desktop dictation. The language is 'auto' or a BCP 47
// tag. Schema 18 (app 2.5.0): the local Whisper engine replaces the Windows
// ones; `engine` is gone (zod strips it) and device / interim / vocabulary are
// new, each falling back to its default on its own.
export const dictationSettingsSchema = z.object({
  device: z.enum(['auto', 'gpu', 'cpu']).catch('auto').default('auto'),
  language: z
    .string()
    .max(35)
    .regex(/^(?:auto|[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3})$/)
    .catch('auto')
    .default('auto'),
  headerButton: z.boolean().catch(true).default(true),
  interim: z.boolean().catch(true).default(true),
  vocabulary: z.string().max(400).catch('').default(''),
})

// Schema 17 (app 2.4.0): desktop-to-desktop sharing. Off until the Share dialog
// turns it on; grants, links and the identity live in dataDir(), never here.
export const shareSettingsSchema = z.object({
  enabled: z.boolean().catch(false).default(false),
  port: z.number().int().min(1024).max(65535).catch(4527).default(4527),
  guestName: z.string().max(48).catch('').default(''),
  defaultPerm: z.enum(['view', 'type', 'full']).catch('view').default('view'),
})

// Schema 13 (E3-FR-42). Only `tailscaleServe` exists (manualCert retired, E3-FR-51).
export const remoteHttpsSettingsSchema = z.object({
  enabled: z.boolean().catch(false).default(false),
  mode: z.literal('tailscaleServe').catch('tailscaleServe').default('tailscaleServe'),
})

const paneType = z.enum(['shell', 'claude', 'codex', 'custom'])

// ---- Schema 13: PaneSchedule automation fields (E8-FR-28..31) -------------
// They replace the contract's top-level `automations` (R30-01 amendment). All
// optional: an old one-shot schedule parses unchanged, and a junk value in a
// new field is dropped on its own instead of losing the schedule.
const SCHEDULE_HISTORY_MAX = 20

export const scheduleRecurrenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once') }),
  z.object({ kind: z.literal('daily') }),
  z.object({ kind: z.literal('weekdays') }),
  z.object({
    kind: z.literal('weekly'),
    days: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .refine((d) => new Set(d).size === d.length, 'duplicate day'),
  }),
  z.object({ kind: z.literal('hourly') }),
])

export const scheduleRunSchema = z.object({
  at: z.number(),
  scheduledFor: z.number(),
  trigger: z.enum(['scheduled', 'manual']),
  status: z.enum(['sent', 'sent_unconfirmed', 'skipped_busy', 'missed', 'failed']),
  // `enter_held` post 2.6.0: an older build drops the unknown reason (catch) and keeps the run.
  reason: z.enum(['agent_not_running', 'multiline_unsafe', 'not_delivered', 'enter_held']).optional().catch(undefined),
})

type ScheduleRunParsed = z.infer<typeof scheduleRunSchema>

/**
 * Item by item: a malformed run is dropped and the rest kept. Over the cap,
 * the 20 most recent (by `at`) survive in their stored order, whichever end
 * the writer appends to.
 */
const scheduleHistorySchema = z.array(z.unknown()).transform((items) => {
  const runs: ScheduleRunParsed[] = []
  for (const item of items) {
    const r = scheduleRunSchema.safeParse(item)
    if (r.success) runs.push(r.data)
  }
  if (runs.length <= SCHEDULE_HISTORY_MAX) return runs
  const keep = new Set(
    runs
      .map((_, i) => i)
      .sort((a, b) => runs[b].at - runs[a].at || b - a)
      .slice(0, SCHEDULE_HISTORY_MAX),
  )
  return runs.filter((_, i) => keep.has(i))
})

const paneScheduleSchema = z.object({
  time: z.string(),
  prompt: z.string(),
  dueAt: z.number(),
  recurrence: scheduleRecurrenceSchema.optional().catch(undefined),
  waitIdle: z.boolean().optional().catch(undefined),
  enabled: z.boolean().optional().catch(undefined),
  waitingSince: z.number().optional().catch(undefined),
  history: scheduleHistorySchema.optional().catch(undefined),
})

// Schema 13 (E7-FR-28, Contratos compartidos). Without this field zod's
// z.object() would strip `pane.worktree` and the link to the worktree would
// be lost on the next reload. A malformed value is dropped on its own (the
// pane falls back to its plain cwd resolution). Same regexes as
// WORKTREE_BRANCH_RE / SHA_RE in src/shared/worktree-types.ts.
export const paneWorktreeSchema = z.object({
  repoRoot: z.string().min(1).max(4096),
  path: z.string().min(1).max(4096),
  branch: z.string().regex(/^sn\/[a-z0-9-]{1,40}$/),
  base: z.string().regex(/^[0-9a-f]{7,64}$/i),
})

// Schema 13 (E8-FR-25): trace of the applied repo file. The trust is never
// here (main-owned trusted-repos.json, R30-01 amendment).
const workspaceRepoConfigSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  appliedAt: z.number(),
  // Id by id, like the Quick Commands themselves: a junk or duplicate id is
  // dropped instead of losing the whole trace (and with it "Reload from repo").
  quickCommandIds: z.array(z.unknown()).transform((ids) => {
    const out: string[] = []
    for (const id of ids) {
      if (typeof id !== 'string' || !id || id.length > QUICK_COMMAND_ID_MAX || out.includes(id)) continue
      out.push(id)
      if (out.length === 20) break
    }
    return out
  }),
})
// ---- end schema 13 pane/workspace fields ----------------------------------

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
  worktree: paneWorktreeSchema.optional().catch(undefined), // schema 13
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
  repoConfig: workspaceRepoConfigSchema.optional().catch(undefined), // schema 13
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
    collapsed: z.boolean().catch(false).default(false),
  })
  .default({})

// Schema 16 (app 2.3.0): Claude multi-account policy, every field with its own
// default so a junk value only resets that field. The saved accounts live in
// dataDir()/claude-accounts/, never here.
const pct = (min: number, max: number, d: number) => z.number().int().min(min).max(max).catch(d).default(d)
const claudeAccountsSettingsSchema = z.object({
  autoSwitch: z.boolean().catch(false).default(false),
  switchAtPercent: pct(50, 100, 99),
  returnToPrimary: z.boolean().catch(true).default(true),
  returnBelowPercent: pct(0, 99, 90),
  returnMarginMinutes: pct(0, 120, 5),
  minDwellMinutes: pct(0, 240, 10),
  deferWhileWorking: z.boolean().catch(true).default(true),
  deferMaxMinutes: pct(0, 60, 3),
  pollParked: z.boolean().catch(true).default(true),
  alertOnSwitch: z.boolean().catch(true).default(true),
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
  // Schema 13 (E8-FR-12, E7-FR-28, E5-FR-25): same pattern. Hibernation is 0
  // (off) or 5..1440 minutes; anything else turns it off.
  cliEnabled: z.boolean().catch(true).default(true),
  worktreesRoot: z.string().max(4096).catch('').default(''),
  hibernateIdleMinutes: z
    .union([z.literal(0), z.number().int().min(5).max(1440)])
    .catch(0)
    .default(0),
  // Schema 14 (E6-FR-25..31): same pattern; a junk value leaves it on.
  terminalShellIntegration: z.boolean().catch(true).default(true),
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
  claudeAccounts: claudeAccountsSettingsSchema.default({}).catch(() => claudeAccountsSettingsSchema.parse({})),
  // Field-level defaults migrate configs that predate the remote feature.
  remote: z
    .object({
      enabled: z.boolean().default(false),
      port: z.number().int().min(1024).max(65535).default(4517),
      // Schema 13 (E3-FR-12..23, E3-FR-42).
      phoneFit: z.boolean().catch(true).default(true),
      https: remoteHttpsSettingsSchema.default({}).catch(() => remoteHttpsSettingsSchema.parse({})),
    })
    .default({}),
  // Field-level defaults migrate configs that predate the notifications feature.
  notifications: notificationSettingsSchema.default({}),
  // Schema 11: agent behavior settings, defaulted field by field.
  agents: agentSettingsSchema.default({}),
  // Schema 12: workspace composer defaults; schema 13: CLI and schedule options.
  automation: automationSettingsSchema.default({}).catch(() => automationSettingsSchema.parse({})),
  // Schema 17: desktop dictation and desktop-to-desktop sharing.
  dictation: dictationSettingsSchema.default({}).catch(() => dictationSettingsSchema.parse({})),
  share: shareSettingsSchema.default({}).catch(() => shareSettingsSchema.parse({})),
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
 * v12 -> v13 is again defaults only (no logic): phoneFit, https, cliEnabled,
 * worktreesRoot, pane.worktree, hibernation, cacheTimer, the automation
 * cli/schedule options, the PaneSchedule fields and workspace.repoConfig. A
 * stray top-level `repoConfigTrust` or `automations` is stripped (R30-01
 * amendment: trust is main-owned in trusted-repos.json, automations extend
 * PaneSchedule).
 * v13 -> v14 is defaults only as well (no logic, R31-00): the single new key
 * is settings.terminalShellIntegration (default true).
 * v14 -> v15 is defaults only (no logic): settings.usage.collapsed (default false).
 * v15 -> v16 is defaults only (no logic): settings.claudeAccounts.* (app 2.3.0,
 * automatic switching off by default).
 * v16 -> v17 (app 2.4.0) is defaults plus the codexEnabled flip: agents
 * syncAgentRename / shellAgentDetect, settings.dictation.*, settings.share.*,
 * and notifications.codexEnabled turns on once for configs older than 17.
 * Idempotent: the result is stamped 17, so a later `false` survives.
 * v17 -> v18 (app 2.5.0) is defaults only (no logic):
 * settings.dictation.{device, interim, vocabulary}; settings.dictation.engine
 * is dropped (zod strips it; the Windows engines are gone).
 */
function migrate(config: ConfigFile): ConfigFile {
  const m = migrateQuickCommandsConfig(config)
  if (m.dropped > 0) console.warn(`[config] dropped ${m.dropped} invalid quick command(s)`)
  let out = m.config
  // configSchema.version is the raw file version, so the flip runs only once.
  if (config.version < 17) {
    out = { ...out, settings: { ...out.settings, notifications: { ...out.settings.notifications, codexEnabled: true } } }
  }
  return { ...out, version: CONFIG_VERSION }
}
