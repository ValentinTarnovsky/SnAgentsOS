/**
 * The phone's Chat view (E3 M12, FR-24..34): one decoded transcript entry as
 * it travels in `chatPage` / `chatAppend`. Pure types and constants with no
 * imports, bundled into main (decoders, watcher) and into the mobile client.
 *
 * A message `id` is the byte offset of the transcript line it came from
 * ("123456"), with ".N" when one line yields several messages. The phone
 * reads the oldest offset back as the `before` of "Load earlier" after it
 * trims its list (500 messages at most in memory).
 */

export type ChatRole = 'user' | 'assistant' | 'tool' | 'system'

/** Why a console has no chat (FR-33). */
export type ChatUnavailableReason = 'noTranscript' | 'ambiguous' | 'notLocal'

export interface ChatPatchHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** Unified lines with their ' ', '+' or '-' prefix. */
  lines: string[]
}

export type ChatBlock =
  /** Markdown, <= CHAT_TEXT_MAX characters. */
  | { t: 'text'; text: string; truncated?: boolean }
  /** <= CHAT_THINKING_MAX characters. */
  | { t: 'thinking'; text: string; truncated?: boolean }
  /** `summary` <= CHAT_SUMMARY_MAX characters (toolSummary.ts). */
  | { t: 'toolUse'; id: string; name: string; summary: string }
  /** `text` <= CHAT_TOOL_TEXT_MAX characters; `patch` from Claude's structuredPatch. */
  | { t: 'toolResult'; toolUseId: string; isError: boolean; text: string; truncated?: boolean; patch?: { filePath?: string; hunks: ChatPatchHunk[] } }
  /** An image in the transcript: a chip, never loaded. */
  | { t: 'image'; label: string }
  /** FR-33: the only block of the notice a chatPage carries when there is no chat. */
  | { t: 'notice'; code: ChatUnavailableReason }

export interface ChatMessage {
  id: string
  role: ChatRole
  /** Epoch ms of the record, null when it has none. */
  ts: number | null
  blocks: ChatBlock[]
  parentId?: string
}

/** Text block cap (16KB). */
export const CHAT_TEXT_MAX = 16 * 1024
/** Thinking block cap (4KB). */
export const CHAT_THINKING_MAX = 4 * 1024
/** Tool output preview cap (4KB); the rest stays on the PC. */
export const CHAT_TOOL_TEXT_MAX = 4 * 1024
/** Tool summary cap. */
export const CHAT_SUMMARY_MAX = 120
/** Patch caps before the frame budget trims further. */
export const CHAT_PATCH_MAX_HUNKS = 40
export const CHAT_PATCH_MAX_LINES = 400
/** Messages one chatPage carries at most (FR-26). */
export const CHAT_PAGE_MAX_MESSAGES = 50
/** Serialized size cap of every chat frame (E3-FR-02). */
export const CHAT_FRAME_MAX_BYTES = 48 * 1024

/**
 * System row texts the phone translates: Claude writes the first one itself
 * on an interrupt (Codex's `turn_aborted` reuses it), main writes the second
 * for a record over 2MB it skipped.
 */
export const CHAT_INTERRUPTED_TEXT = '[Request interrupted by user]'
export const CHAT_SKIPPED_TEXT = '[Record skipped: too large]'

/** Byte offset of the transcript line a message came from, or null for a notice. */
export function chatMessageOffset(id: string): number | null {
  const m = /^(\d{1,15})(?:\.\d+)?$/.exec(id)
  return m ? Number(m[1]) : null
}

/** The notice block of a chatPage without a chat (FR-33), or null. */
export function chatNoticeOf(items: readonly ChatMessage[]): ChatUnavailableReason | null {
  if (items.length !== 1) return null
  const block = items[0].blocks[0]
  return items[0].role === 'system' && block?.t === 'notice' ? block.code : null
}
