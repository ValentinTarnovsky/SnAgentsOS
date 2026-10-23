/**
 * Labs (schema 19, app 2.7.0): opt-in experimental modules, all off by
 * default. Pure and zod-free so main, renderer and mobile can share it; main
 * derives `labsSettingsSchema` (src/main/store/schema.ts) from LABS_KEYS.
 */

/**
 * Every lab flag, in Settings > Labs order. A new lab is one more key here plus
 * its literal LabsSection row, catalog entry and i18n keys (test-labs.cjs checks them).
 */
export const LABS_KEYS = ['consoleChat', 'teams'] as const

export type LabsKey = (typeof LABS_KEYS)[number]

/** settings.labs: one boolean per lab. */
export type LabsSettings = Record<LabsKey, boolean>

export const DEFAULT_LABS: LabsSettings = { consoleChat: false, teams: false }

/** Absent or junk means off: only an explicit `true` turns a lab on. */
export function labOn(
  settings: { labs?: Partial<Record<LabsKey, unknown>> | null } | null | undefined,
  key: LabsKey,
): boolean {
  return settings?.labs?.[key] === true
}

/** Any value (e.g. an unvalidated CONFIG_SAVE payload) as a full LabsSettings. */
export function normalizeLabs(v: unknown): LabsSettings {
  const src = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  const out = { ...DEFAULT_LABS }
  for (const k of LABS_KEYS) out[k] = src[k] === true
  return out
}
