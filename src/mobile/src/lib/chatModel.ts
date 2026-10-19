/**
 * The phone's Chat view model (E3-FR-26..30), free of React, the DOM and the
 * socket so the rules run under Node in the tests:
 *
 *  - list merges: a first page replaces the list, "Load earlier" prepends,
 *    chatAppend appends; at most CHAT_MEMORY_MAX messages stay in memory
 *    (appends drop the oldest and move the cursor to the oldest kept, a
 *    prepend at the cap keeps what fits and stops offering more);
 *  - rows: consecutive calls of the same tool (and their results) fold into
 *    one row, each result paired with its call by id (also across rows), so
 *    three Reads read as "Read 3 files" and the Edit after them as its own
 *    "Edit App.tsx +12 -3";
 *  - the run label and the diff counts of a tool row;
 *  - which links may open (http and https only, FR-32).
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

/** Messages one pane keeps in memory. */
export const CHAT_MEMORY_MAX = 500

export interface ChatList {
  items: ChatMessage[]
  /** `before` of the next "Load earlier"; null with nothing before. */
  cursor: string | null
  done: boolean
  /** Prepends stopped at CHAT_MEMORY_MAX: older messages stay on the PC. */
  capped: boolean
}

export const EMPTY_LIST: ChatList = { items: [], cursor: null, done: true, capped: false }

interface Page {
  items: ChatMessage[]
  cursor: string | null
  done: boolean
}

/** The cursor that reads the messages before `first`. */
function cursorBefore(first: ChatMessage | undefined, fallback: string | null): string | null {
  if (!first) return fallback
  const offset = chatMessageOffset(first.id)
  return offset === null ? fallback : String(offset)
}

/** A first page: replaces the list (FR-30 reset included). */
export function replaceList(page: Page): ChatList {
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
export function prependList(list: ChatList, page: Page): ChatList {
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
  /** tool_use id (or the result's toolUseId for an orphan result). */
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

/**
 * Rows for the list, oldest first. Calls of one tool that follow each other
 * (across messages, results in between included) make one `tools` row; a
 * different tool starts the next row, and a result whose call is in an
 * earlier row completes that call instead of opening a new one.
 */
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
        // Its call is in a page not loaded yet: show the result alone.
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

/** + and - lines of a patch. */
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

/** A tool row's status: a call still waiting, any error, or all done. */
export function runStatus(calls: readonly ToolCall[]): 'pending' | 'error' | 'done' {
  if (calls.some((c) => c.result?.isError)) return 'error'
  if (calls.some((c) => !c.result)) return 'pending'
  return 'done'
}

type Translate = (key: string, vars?: Record<string, string | number>) => string

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/**
 * The one line of a tool row (FR-28): "Read 3 files", "Bash npm test",
 * "Edit App.tsx +12 -3", "4 tools: Read, Edit, Bash".
 */
export function runLabel(calls: readonly ToolCall[], t: Translate): string {
  const named = calls.filter((c) => c.name)
  if (!named.length) return t('chat.tools.result', { n: calls.length })
  const names = [...new Set(named.map((c) => c.name))]
  if (names.length > 1) return t('chat.tools.mixed', { n: calls.length, names: names.join(', ') })
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
  if (name === 'Read' || FILE_TOOLS.has(name)) return t('chat.tools.files', { name, n })
  if (name === 'Bash' || name === 'shell' || name === 'local_shell') return t('chat.tools.commands', { name, n })
  return t('chat.tools.times', { name, n })
}

/** A system row's text the phone translates (interrupt, skipped record), else null. */
export function systemKey(text: string): 'chat.interrupted' | 'chat.skipped' | null {
  if (text.startsWith(CHAT_INTERRUPTED_TEXT.slice(0, -1))) return 'chat.interrupted'
  if (text === CHAT_SKIPPED_TEXT) return 'chat.skipped'
  return null
}

/** FR-32: only http and https links open, in a new tab. */
export function safeHref(href: string | null | undefined): string | null {
  if (!href) return null
  const trimmed = href.trim()
  return /^https?:\/\//i.test(trimmed) ? trimmed : null
}

/** The plain text of a message, for Copy (FR-29). */
export function messageText(blocks: readonly ChatBlock[]): string {
  return blocks
    .map((b) => (b.t === 'text' || b.t === 'thinking' ? b.text : ''))
    .filter(Boolean)
    .join('\n\n')
}

/** A user bubble folds past this many lines (FR-27). */
export const USER_FOLD_LINES = 4

/** True when a user text is longer than the fold (by lines, or roughly by length on a phone). */
export function needsFold(text: string): boolean {
  return text.split('\n').length > USER_FOLD_LINES || text.length > 280
}
