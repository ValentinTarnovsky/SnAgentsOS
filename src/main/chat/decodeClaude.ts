// Adaptado de stablyai/orca (MIT) - src/main/native-chat/transcript-line-decoders-claude.ts

/**
 * One line of a Claude Code transcript (`<claudeRoot>/projects/<slug>/<id>.jsonl`)
 * as the phone's chat messages (E3 M12, FR-26..28). Same rules as Orca's
 * decoder, rewritten for SnAgentsOS's ChatMessage:
 *
 *  - only `user` and `assistant` records; subagent (sidechain) records skipped;
 *  - `isMeta`, `isSynthetic` and `isCompactSummary` records skipped, except
 *    for their `tool_result` blocks (the result of a call the chat shows);
 *  - a user record made only of tool results is a `tool` message, and the
 *    record's `toolUseResult.structuredPatch` becomes the result's `patch`
 *    (40 hunks x 400 lines at most, before the frame budget trims more);
 *  - "[Request interrupted by user...]" is a `system` row;
 *  - slash command wrappers read as the command the user typed, and local
 *    command output as a `system` row.
 *
 * Unknown fields and shapes are dropped, never thrown on: a format change
 * degrades to fewer rows, not to a broken chat.
 */
import {
  CHAT_PATCH_MAX_HUNKS,
  CHAT_PATCH_MAX_LINES,
  CHAT_TEXT_MAX,
  CHAT_THINKING_MAX,
  CHAT_TOOL_TEXT_MAX,
  type ChatBlock,
  type ChatMessage,
  type ChatPatchHunk,
} from '@shared/chat-types'
import { boundedText, cleanText, cutAt, tsOf } from './chatText'
import { toolSummary } from './toolSummary'

/** One unified diff line kept at most this long. */
const PATCH_LINE_MAX = 2000

type Rec = Record<string, unknown>

function isRec(v: unknown): v is Rec {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

const INTERRUPT_RE = /^\[Request interrupted by user[^\]]*\]$/

/** `<command-name>/x</command-name> ... <command-args>y</command-args>` -> "/x y". */
function commandText(text: string): string | null {
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)
  if (!name) return null
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)
  return `${name[1].trim()}${args && args[1].trim() ? ' ' + args[1].trim() : ''}`
}

/** `<local-command-stdout>` / `-stderr>` body, or null. */
function localOutput(text: string): string | null {
  const m = /^\s*<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>\s*$/.exec(text)
  return m ? m[1] : null
}

function textBlock(text: string, max = CHAT_TEXT_MAX): ChatBlock | null {
  const b = boundedText(text, max)
  return b.text.trim() ? { t: 'text', ...b } : null
}

/** The text of a tool_result `content` (a string or text/image parts). */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (!isRec(part)) continue
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
    else if (part.type === 'image') parts.push('[image]')
  }
  return parts.join('\n')
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0
}

/** Claude's structuredPatch as hunks, capped; `cut` = something was dropped. */
export function patchOf(raw: unknown): { hunks: ChatPatchHunk[]; cut: boolean } | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const hunks: ChatPatchHunk[] = []
  let cut = raw.length > CHAT_PATCH_MAX_HUNKS
  for (const h of raw.slice(0, CHAT_PATCH_MAX_HUNKS)) {
    if (!isRec(h) || !Array.isArray(h.lines)) continue
    const all = h.lines.filter((l): l is string => typeof l === 'string')
    if (all.length > CHAT_PATCH_MAX_LINES) cut = true
    const lines = all.slice(0, CHAT_PATCH_MAX_LINES).map((l) => {
      const clean = cleanText(l).replace(/\n/g, ' ')
      if (clean.length > PATCH_LINE_MAX) cut = true
      return cutAt(clean, PATCH_LINE_MAX)
    })
    hunks.push({ oldStart: num(h.oldStart), oldLines: num(h.oldLines), newStart: num(h.newStart), newLines: num(h.newLines), lines })
  }
  return hunks.length ? { hunks, cut } : null
}

function toolResultBlock(part: Rec, extra: Rec | null, single: boolean): ChatBlock | null {
  const toolUseId = typeof part.tool_use_id === 'string' ? part.tool_use_id : ''
  if (!toolUseId) return null
  const b = boundedText(resultText(part.content), CHAT_TOOL_TEXT_MAX)
  const block: Extract<ChatBlock, { t: 'toolResult' }> = { t: 'toolResult', toolUseId, isError: part.is_error === true, text: b.text }
  if (b.truncated) block.truncated = true
  // toolUseResult describes the record's (single) tool call.
  if (single && extra) {
    const patch = patchOf(extra.structuredPatch)
    if (patch) {
      block.patch = { hunks: patch.hunks }
      if (typeof extra.filePath === 'string') block.patch.filePath = cleanText(extra.filePath)
      if (patch.cut) block.truncated = true
    }
  }
  return block
}

function userTextBlocks(text: string): { blocks: ChatBlock[]; system: boolean } {
  const trimmed = text.trim()
  if (INTERRUPT_RE.test(trimmed)) {
    const b = textBlock(trimmed)
    return { blocks: b ? [b] : [], system: true }
  }
  const local = localOutput(text)
  if (local !== null) {
    const b = textBlock(local, CHAT_TOOL_TEXT_MAX)
    return { blocks: b ? [b] : [], system: true }
  }
  const cmd = commandText(text)
  const b = textBlock(cmd ?? text)
  return { blocks: b ? [b] : [], system: false }
}

function assistantBlocks(content: unknown): ChatBlock[] {
  if (typeof content === 'string') {
    const b = textBlock(content)
    return b ? [b] : []
  }
  if (!Array.isArray(content)) return []
  const blocks: ChatBlock[] = []
  for (const part of content) {
    if (!isRec(part)) continue
    if (part.type === 'text' && typeof part.text === 'string') {
      const b = textBlock(part.text)
      if (b) blocks.push(b)
    } else if (part.type === 'thinking' && typeof part.thinking === 'string') {
      const b = boundedText(part.thinking, CHAT_THINKING_MAX)
      if (b.text.trim()) blocks.push({ t: 'thinking', ...b })
    } else if (part.type === 'tool_use' && typeof part.id === 'string' && typeof part.name === 'string') {
      const name = cutAt(cleanText(part.name), 128)
      blocks.push({ t: 'toolUse', id: part.id, name, summary: toolSummary(name, part.input) })
    } else if (part.type === 'image') {
      blocks.push({ t: 'image', label: 'image' })
    }
  }
  return blocks
}

/**
 * Messages of one parsed transcript record that starts at byte `offset`
 * (empty for anything the chat does not show).
 */
export function decodeClaude(record: unknown, offset: number): ChatMessage[] {
  if (!isRec(record)) return []
  const type = record.type
  if ((type !== 'user' && type !== 'assistant') || record.isSidechain === true) return []
  const message = isRec(record.message) ? record.message : null
  if (!message) return []
  const meta = record.isMeta === true || record.isSynthetic === true || record.isCompactSummary === true
  const ts = tsOf(record.timestamp)
  const id = String(offset)

  if (type === 'assistant') {
    if (meta) return []
    const blocks = assistantBlocks(message.content)
    return blocks.length ? [{ id, role: 'assistant', ts, blocks }] : []
  }

  const content = message.content
  const extra = isRec(record.toolUseResult) ? record.toolUseResult : null
  if (typeof content === 'string') {
    if (meta) return []
    const { blocks, system } = userTextBlocks(content)
    return blocks.length ? [{ id, role: system ? 'system' : 'user', ts, blocks }] : []
  }
  if (!Array.isArray(content)) return []
  const results = content.filter((p): p is Rec => isRec(p) && p.type === 'tool_result')
  const toolBlocks: ChatBlock[] = []
  for (const part of results) {
    const b = toolResultBlock(part, extra, results.length === 1)
    if (b) toolBlocks.push(b)
  }
  if (meta) return toolBlocks.length ? [{ id, role: 'tool', ts, blocks: toolBlocks }] : []

  const blocks: ChatBlock[] = []
  let system = false
  for (const part of content) {
    if (!isRec(part)) continue
    if (part.type === 'text' && typeof part.text === 'string') {
      const r = userTextBlocks(part.text)
      if (r.system) system = true
      blocks.push(...r.blocks)
    } else if (part.type === 'image') {
      blocks.push({ t: 'image', label: 'image' })
    }
  }
  const out: ChatMessage[] = []
  if (toolBlocks.length) out.push({ id: blocks.length ? `${id}.0` : id, role: 'tool', ts, blocks: toolBlocks })
  if (blocks.length) out.push({ id: toolBlocks.length ? `${id}.1` : id, role: system ? 'system' : 'user', ts, blocks })
  return out
}
