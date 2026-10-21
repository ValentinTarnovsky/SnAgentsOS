/**
 * The read-only Chat of a shared console (app 2.4.0, item 8, S5): a port of
 * the phone's chat model (src/mobile/src/lib/chatModel.ts), free of React and
 * the DOM:
 *
 *  - list merges: a first page replaces the list, "Load earlier" prepends,
 *    chatAppend appends; at most CHAT_MEMORY_MAX messages stay in memory;
 *  - rows: consecutive calls of the same tool (and their results) fold into
 *    one row, each result paired with its call by id;
 *  - the run label and the diff counts of a tool row;
 *  - which links may be offered (http and https only), always through the
 *    guest's ConfirmLinkDialog, never opened from here.
 */
import {
  CHAT_INTERRUPTED_TEXT,
  CHAT_SKIPPED_TEXT,
  chatMessageOffset,
  type ChatBlock,
  type ChatMessage,
  type ChatPatchHunk,
  type ChatRole,
} from '@shared/chat-types'
import type { MessageKey } from '@/i18n'

/** Messages one shared pane keeps in memory. */
export const CHAT_MEMORY_MAX = 500

export interface ChatList {
  items: ChatMessage[]
  /** `before` of the next "Load earlier"; null with nothing before. */
  cursor: string | null
  done: boolean
  /** Prepends stopped at CHAT_MEMORY_MAX: older messages stay on the host. */
  capped: boolean
}

export const EMPTY_LIST: ChatList = { items: [], cursor: null, done: true, capped: false }

export interface ChatPageIn {
  items: ChatMessage[]
  cursor: string | null
  done: boolean
}

function cursorBefore(first: ChatMessage | undefined, fallback: string | null): string | null {
  if (!first) return fallback
  const offset = chatMessageOffset(first.id)
  return offset === null ? fallback : String(offset)
}

/** A first page: replaces the list. */
export function replaceList(page: ChatPageIn): ChatList {
  const items = page.items.slice(-CHAT_MEMORY_MAX)
  const trimmed = items.length < page.items.length
  return {
    items,
    cursor: trimmed ? cursorBefore(items[0], page.cursor) : page.cursor,
    done: trimmed ? false : page.done,
    capped: false,
  }
}

/** "Load earlier": the page goes in front, never past CHAT_MEMORY_MAX. */
export function prependList(list: ChatList, page: ChatPageIn): ChatList {
  const known = new Set(list.items.map((m) => m.id))
  const older = page.items.filter((m) => !known.has(m.id))
  const room = CHAT_MEMORY_MAX - list.items.length
  if (older.length <= room) {
    return { items: [...older, ...list.items], cursor: page.cursor, done: page.done, capped: false }
  }
  const kept = room > 0 ? older.slice(older.length - room) : []
  const items = [...kept, ...list.items]
  return { items, cursor: cursorBefore(items[0], page.cursor), done: false, capped: true }
}

/** chatAppend: new messages at the end (an id seen again replaces its message). */
export function appendList(list: ChatList, items: ChatMessage[]): ChatList {
  if (!items.length) return list
  const index = new Map(list.items.map((m, i) => [m.id, i]))
  const next = list.items.slice()
  for (const m of items) {
    const at = index.get(m.id)
    if (at !== undefined) next[at] = m
    else {
      index.set(m.id, next.length)
      next.push(m)
    }
  }
  if (next.length <= CHAT_MEMORY_MAX) return { ...list, items: next }
  const kept = next.slice(next.length - CHAT_MEMORY_MAX)
  return { items: kept, cursor: cursorBefore(kept[0], list.cursor), done: false, capped: list.capped }
}

// --- Rows ---------------------------------------------------------------------------

export type ToolResultBlock = Extract<ChatBlock, { t: 'toolResult' }>

export interface ToolCall {
  id: string
  name: string
  summary: string
  result: ToolResultBlock | null
}

export type ChatRow =
  | { kind: 'message'; id: string; role: Exclude<ChatRole, 'tool'>; blocks: ChatBlock[] }
  | { kind: 'tools'; id: string; calls: ToolCall[] }

function isToolBlock(b: ChatBlock): boolean {
  return b.t === 'toolUse' || b.t === 'toolResult'
}

/** Rows for the list, oldest first (same folding as the phone). */
export function buildRows(items: readonly ChatMessage[]): ChatRow[] {
  const rows: ChatRow[] = []
  const calls = new Map<string, ToolCall>()
  let run: Extract<ChatRow, { kind: 'tools' }> | null = null
  for (const msg of items) {
    let part: ChatBlock[] = []
    let partIndex = 0
    const flush = (): void => {
      if (!part.length) return
      const role: Exclude<ChatRole, 'tool'> = msg.role === 'tool' ? 'assistant' : msg.role
      rows.push({ kind: 'message', id: partIndex ? `${msg.id}#${partIndex}` : msg.id, role, blocks: part })
      partIndex++
      part = []
      run = null
    }
    for (const b of msg.blocks) {
      if (!isToolBlock(b)) {
        part.push(b)
        continue
      }
      flush()
      if (b.t === 'toolUse') {
        const call: ToolCall = { id: b.id, name: b.name, summary: b.summary, result: null }
        calls.set(b.id, call)
        const current = run as Extract<ChatRow, { kind: 'tools' }> | null
        if (current && current.calls.some((c) => c.name && c.name !== b.name)) run = null
        if (!run) {
          run = { kind: 'tools', id: `t:${msg.id}:${b.id}`, calls: [] }
          rows.push(run)
        }
        run.calls.push(call)
      } else if (b.t === 'toolResult') {
        const call = calls.get(b.toolUseId)
        if (call) {
          call.result = b
          continue
        }
        const orphan: ToolCall = { id: b.toolUseId, name: '', summary: '', result: b }
        calls.set(b.toolUseId, orphan)
        if (!run) {
          run = { kind: 'tools', id: `t:${msg.id}:${b.toolUseId}`, calls: [] }
          rows.push(run)
        }
        run.calls.push(orphan)
      }
    }
    flush()
  }
  return rows
}

export function patchCounts(hunks: readonly ChatPatchHunk[]): { add: number; del: number } {
  let add = 0
  let del = 0
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.startsWith('+')) add++
      else if (l.startsWith('-')) del++
    }
  }
  return { add, del }
}

export function runStatus(calls: readonly ToolCall[]): 'pending' | 'error' | 'done' {
  if (calls.some((c) => c.result?.isError)) return 'error'
  if (calls.some((c) => !c.result)) return 'pending'
  return 'done'
}

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** The one line of a tool row: "Read 3 files", "Bash npm test", "Edit App.tsx +12 -3". */
export function runLabel(calls: readonly ToolCall[], t: Translate): string {
  const named = calls.filter((c) => c.name)
  if (!named.length) return t('shareGuest.chat.tools.result', { n: calls.length })
  const names = [...new Set(named.map((c) => c.name))]
  if (names.length > 1) return t('shareGuest.chat.tools.mixed', { n: calls.length, names: names.join(', ') })
  const name = names[0]
  const n = named.length
  if (n === 1) {
    const c = named[0]
    let label = c.summary ? `${name} ${c.summary}` : name
    if (FILE_TOOLS.has(name) && c.result?.patch) {
      const { add, del } = patchCounts(c.result.patch.hunks)
      label += ` +${add} -${del}`
    }
    return label
  }
  if (name === 'Read' || FILE_TOOLS.has(name)) return t('shareGuest.chat.tools.files', { name, n })
  if (name === 'Bash' || name === 'shell' || name === 'local_shell') return t('shareGuest.chat.tools.commands', { name, n })
  return t('shareGuest.chat.tools.times', { name, n })
}

/** A system row's text the guest translates (interrupt, skipped record), else null. */
export function systemKey(text: string): 'shareGuest.chat.interrupted' | 'shareGuest.chat.skipped' | null {
  if (text.startsWith(CHAT_INTERRUPTED_TEXT.slice(0, -1))) return 'shareGuest.chat.interrupted'
  if (text === CHAT_SKIPPED_TEXT) return 'shareGuest.chat.skipped'
  return null
}

/** Only http and https links are offered (and then only through the confirm dialog). */
export function safeHref(href: string | null | undefined): string | null {
  if (!href) return null
  const trimmed = href.trim()
  return /^https?:\/\//i.test(trimmed) ? trimmed : null
}

/** The plain text of a message, for Copy. */
export function messageText(blocks: readonly ChatBlock[]): string {
  return blocks
    .map((b) => (b.t === 'text' || b.t === 'thinking' ? b.text : ''))
    .filter(Boolean)
    .join('\n\n')
}

export const USER_FOLD_LINES = 4

export function needsFold(text: string): boolean {
  return text.split('\n').length > USER_FOLD_LINES || text.length > 280
}
