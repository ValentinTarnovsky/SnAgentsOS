/**
 * Quick Commands model helpers (E8-FR-01, schema 12). Pure functions shared by
 * main (config parse + the v11 -> v12 snippets migration) and the renderer
 * (store limits, import/merge, popover ordering and filtering).
 *
 * Parsing is item by item: one malformed command is dropped and the rest are
 * kept, so a single bad entry never costs the whole array.
 */
import type { QuickCommand, Snippet } from './types'

/** Hard cap on stored commands; the 101st cannot be created. */
export const QUICK_COMMANDS_MAX = 100
export const QUICK_COMMAND_NAME_MAX = 60
export const QUICK_COMMAND_TEXT_MAX = 16384
/** Same bound as the remote ctl schema for `runQuickCommand.id`. */
export const QUICK_COMMAND_ID_MAX = 128

export interface SanitizedQuickCommands {
  list: QuickCommand[]
  /** Items that failed validation, were duplicates, or fell past the cap. */
  dropped: number
}

function isNonEmptyId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= QUICK_COMMAND_ID_MAX
}

/**
 * Validates one raw item into a QuickCommand (unknown keys stripped), or null.
 * An `agent` command always submits with Enter and needs a preset.
 */
export function parseQuickCommand(raw: unknown): QuickCommand | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (!isNonEmptyId(r.id)) return null
  if (typeof r.name !== 'string' || !r.name.trim() || r.name.length > QUICK_COMMAND_NAME_MAX) return null
  if (typeof r.text !== 'string' || r.text.length < 1 || r.text.length > QUICK_COMMAND_TEXT_MAX) return null
  if (r.action !== 'send' && r.action !== 'agent') return null
  if (typeof r.enter !== 'boolean') return null
  if (r.workspaceId !== undefined && !isNonEmptyId(r.workspaceId)) return null
  if (r.presetId !== undefined && !isNonEmptyId(r.presetId)) return null
  if (r.action === 'agent' && r.presetId === undefined) return null
  const cmd: QuickCommand = {
    id: r.id,
    name: r.name,
    text: r.text,
    action: r.action,
    enter: r.action === 'agent' ? true : r.enter,
  }
  if (r.workspaceId !== undefined) cmd.workspaceId = r.workspaceId as string
  if (r.presetId !== undefined) cmd.presetId = r.presetId as string
  return cmd
}

/** Item-by-item validation, duplicate ids dropped (first wins), capped at 100. */
export function sanitizeQuickCommands(raw: unknown): SanitizedQuickCommands {
  if (!Array.isArray(raw)) return { list: [], dropped: 0 }
  const list: QuickCommand[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const item of raw) {
    const cmd = parseQuickCommand(item)
    if (!cmd || seen.has(cmd.id) || list.length >= QUICK_COMMANDS_MAX) {
      dropped++
      continue
    }
    seen.add(cmd.id)
    list.push(cmd)
  }
  return { list, dropped }
}

/**
 * Snippets (schema <= 11) -> global `send` commands without Enter, same order
 * and ids. Lenient on the label so no saved text is lost: an empty label falls
 * back to the text's first line and a long one is clipped to 60. A snippet
 * without an id or without text has nothing to run and is dropped.
 */
export function migrateSnippets(raw: unknown): SanitizedQuickCommands {
  if (!Array.isArray(raw)) return { list: [], dropped: 0 }
  const converted: unknown[] = raw.map((item) => {
    if (!item || typeof item !== 'object') return null
    const s = item as Record<string, unknown>
    if (!isNonEmptyId(s.id) || typeof s.text !== 'string' || !s.text) return null
    const text = s.text.slice(0, QUICK_COMMAND_TEXT_MAX)
    const firstLine = text.split(/\r?\n/).find((l) => l.trim()) ?? ''
    const name = ((typeof s.name === 'string' ? s.name.trim() : '') || firstLine.trim() || 'Snippet').slice(
      0,
      QUICK_COMMAND_NAME_MAX,
    )
    return { id: s.id, name, text, action: 'send', enter: false }
  })
  return sanitizeQuickCommands(converted)
}

export interface QuickCommandsMigration<T> {
  config: T
  /** True when `snippets` was converted (the one real v12 transformation). */
  migrated: boolean
  dropped: number
}

/**
 * The v12 step on a config-like object: runs the snippets conversion once
 * (only when `quickCommands` is missing and `snippets` exists), sanitizes an
 * existing `quickCommands`, and always drops `snippets` from the result so the
 * next save no longer writes it. Idempotent.
 */
export function migrateQuickCommandsConfig<T extends { quickCommands?: unknown; snippets?: unknown }>(
  config: T,
): QuickCommandsMigration<T> {
  const { snippets, ...rest } = config
  if (rest.quickCommands === undefined) {
    if (snippets === undefined) return { config: rest as T, migrated: false, dropped: 0 }
    const m = migrateSnippets(snippets)
    return { config: { ...rest, quickCommands: m.list } as T, migrated: true, dropped: m.dropped }
  }
  const s = sanitizeQuickCommands(rest.quickCommands)
  return { config: { ...rest, quickCommands: s.list } as T, migrated: false, dropped: s.dropped }
}

/**
 * Popover / palette order: the given workspace's commands first, then the
 * globals, each keeping the array (Settings) order. Commands scoped to another
 * workspace are left out.
 */
export function orderQuickCommands(list: QuickCommand[], workspaceId: string | null): QuickCommand[] {
  const own = workspaceId ? list.filter((c) => c.workspaceId === workspaceId) : []
  const globals = list.filter((c) => !c.workspaceId)
  return [...own, ...globals]
}

/** The first 9 entries get the 1-9 hotkeys. */
export function numbered(list: QuickCommand[]): Array<{ cmd: QuickCommand; digit: number | null }> {
  return list.map((cmd, i) => ({ cmd, digit: i < 9 ? i + 1 : null }))
}

/** Case-insensitive subsequence match over the label (same rule as the palette). */
export function matchesFilter(cmd: QuickCommand, filter: string): boolean {
  const needle = filter.trim().toLowerCase()
  if (!needle) return true
  const hay = cmd.name.toLowerCase()
  let i = 0
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++
  }
  return i === needle.length
}

/** Re-points `workspaceId` through an old -> new id map (merge import). */
export function remapScopes(list: QuickCommand[], idMap: ReadonlyMap<string, string>): QuickCommand[] {
  return list.map((c) => {
    if (!c.workspaceId) return c
    const next = idMap.get(c.workspaceId)
    return next && next !== c.workspaceId ? { ...c, workspaceId: next } : c
  })
}

export interface QuickCommandsMergeResult {
  list: QuickCommand[]
  /** Incoming commands actually added. */
  imported: number
  /** Incoming commands that were candidates (not already present by id). */
  total: number
}

/**
 * Merge import: incoming commands whose id we already have are skipped, the
 * rest are remapped to the imported workspaces' new ids and appended up to the
 * 100 limit. `imported < total` means the limit cut the import short.
 */
export function mergeQuickCommands(
  existing: QuickCommand[],
  incoming: QuickCommand[],
  idMap: ReadonlyMap<string, string>,
): QuickCommandsMergeResult {
  const have = new Set(existing.map((c) => c.id))
  const fresh = remapScopes(
    incoming.filter((c) => !have.has(c.id)),
    idMap,
  )
  const room = Math.max(0, QUICK_COMMANDS_MAX - existing.length)
  const added = fresh.slice(0, room)
  return { list: added.length ? [...existing, ...added] : existing, imported: added.length, total: fresh.length }
}

/**
 * Interim view for the phone protocol, which still carries `snippets` until the
 * QuickCommandsSheet replaces it (R22-12): global `send` commands only.
 */
export function legacySnippets(list: QuickCommand[]): Snippet[] {
  return list.filter((c) => c.action === 'send' && !c.workspaceId).map(({ id, name, text }) => ({ id, name, text }))
}
