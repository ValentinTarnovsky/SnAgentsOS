/**
 * Sidebar blocks the user can hide (schema 20, app 2.8.0). Pure and zod-free so
 * main and renderer share it; main derives `sidebarBlocksSettingsSchema`
 * (src/main/store/schema.ts) from SIDEBAR_BLOCK_KEYS. All shown by default.
 * The header, the workspace list and the Settings button cannot be hidden.
 */

/**
 * Every block, in sidebar order. A new block is one more key here plus its
 * literal row in the Appearance section, catalog entry and i18n keys.
 */
export const SIDEBAR_BLOCK_KEYS = ['agentsBoard', 'teams', 'sharedWithMe', 'shareIndicator', 'remoteIndicator', 'usageBars'] as const

export type SidebarBlockKey = (typeof SIDEBAR_BLOCK_KEYS)[number]

/** settings.sidebarBlocks: one boolean per block, true = shown. */
export type SidebarBlocksSettings = Record<SidebarBlockKey, boolean>

export const DEFAULT_SIDEBAR_BLOCKS: SidebarBlocksSettings = {
  agentsBoard: true, teams: true, sharedWithMe: true, shareIndicator: true, remoteIndicator: true, usageBars: true,
}

/** Absent or junk means shown: only an explicit `false` hides a block. */
export function sidebarBlockOn(
  settings: { sidebarBlocks?: Partial<Record<SidebarBlockKey, unknown>> | null } | null | undefined,
  key: SidebarBlockKey,
): boolean {
  return settings?.sidebarBlocks?.[key] !== false
}
