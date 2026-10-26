/**
 * The chat model of a transcript (app 2.7.0, A2), free of React, the DOM and
 * any socket: the phone's Chat (src/mobile/src/lib/chatModel.ts, E3-FR-26..30)
 * and the share guest's read-only Chat (src/renderer/components/share/chat/
 * chatModel.ts, app 2.4.0 item 8) were near duplicates and now re-export this.
 *
 *  - list merges: a first page replaces the list, "Load earlier" prepends,
 *    chatAppend appends; at most CHAT_MEMORY_MAX messages stay in memory
 *    (appends drop the oldest and move the cursor to the oldest kept, a
 *    prepend at the cap keeps what fits and stops offering more);
 *  - rows: consecutive calls of the same tool (and their results) fold into
 *    one `tools` row, each result paired with its call by id (also across
 *    rows), so three Reads read as "Read 3 files" and the Edit after them as
 *    its own "Edit App.tsx +12 -3";
 *  - phases: inside one assistant turn, consecutive `tools` rows of the same
 *    family (src/shared/toolActivity.ts: a Grep then a Glob, an Edit then a
 *    Write) fold into one `phase` row that keeps them as its items;
 *  - the run label and the diff counts of a tool row;
 *  - which links may be offered (http and https only).
 *
 * Nothing here is translated: labels come back as i18n keys plus their vars.
 * The two copies differed only in where their keys live, so the namespace is
 * a parameter: the phone's are `chat.*` (`chat.tools.files`), the guest's
 * `shareGuest.chat.*`, with the same suffixes and the same words. Each
 * chatModel.ts keeps its own `runLabel(calls, t)` and `systemKey(text)` over
 * runLabelOf / systemKeyOf.
 */
import {
  CHAT_INTERRUPTED_TEXT,
  CHAT_SKIPPED_TEXT,
  chatMessageOffset,
  type ChatBlock,
  type ChatMessage,
  type ChatPatchHunk,
  type ChatRole,
} from './chat-types'
import { DIGEST_FILES_MAX, familyOf, fileOfToolInput, type ToolFamily } from './toolActivity'

/** Messages one pane keeps in memory. */
export const CHAT_MEMORY_MAX = 500

export interface ChatList {
  items: ChatMessage[]
  /** `before` of the next "Load earlier"; null with nothing before. */
  cursor: string | null
  done: boolean
  /** Prepends stopped at CHAT_MEMORY_MAX: older messages stay on the PC (or the host). */
  capped: boolean
}

export const EMPTY_LIST: ChatList = { items: [], cursor: null, done: true, capped: false }

/** A chatPage as the list model reads it. */
export interface ChatPageIn {
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
  /** tool_use id (or the result's toolUseId for an orphan result). */
  id: string
  name: string
  summary: string
  result: ToolResultBlock | null
}

export interface ChatMessageRow {
  kind: 'message'
  id: string
  role: Exclude<ChatRole, 'tool'>
  blocks: ChatBlock[]
}

/** Consecutive calls of one tool (plus orphan results), id `t:<msg>:<call>`. */
export interface ChatToolsRow {
  kind: 'tools'
  id: string
  calls: ToolCall[]
}

/**
 * Two or more consecutive `tools` rows of one family, id `p:<first row id>`.
 * `count` is their named calls, `files` the first DIGEST_FILES_MAX distinct
 * files (fileOfToolInput), `items` the rows themselves, for a UI that expands.
 */
export interface ChatPhaseRow {
  kind: 'phase'
  id: string
  family: ToolFamily
  count: number
  files: string[]
  items: ChatToolsRow[]
}

export type ChatRow = ChatMessageRow | ChatToolsRow | ChatPhaseRow

export interface BuildRowsOptions {
  /** Fold same-family tool rows into phases (default true). */
  phases?: boolean
}

function isToolBlock(b: ChatBlock): boolean {
  return b.t === 'toolUse' || b.t === 'toolResult'
}

/**
 * Message and tool rows, oldest first. Calls of one tool that follow each
 * other (across messages, results in between included) make one `tools` row;
 * a different tool starts the next row, any text, thinking or image part ends
 * it, and a result whose call is in an earlier row completes that call
 * instead of opening a new one. A `tool` role message renders as assistant.
 */
function toolRuns(items: readonly ChatMessage[]): ChatRow[] {
  const rows: ChatRow[] = []
  const calls = new Map<string, ToolCall>()
  let run: ChatToolsRow | null = null
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
        const current = run as ChatToolsRow | null
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

/** The family of a tools row (its named call), null for a row of orphan results. */
function rowFamily(row: ChatToolsRow): ToolFamily | null {
  const named = row.calls.find((c) => c.name)
  return named ? familyOf(named.name) : null
}

/**
 * The files of a call, from what the wire carries: no input travels, but the
 * decoders put a file tool's file name in its summary (toolSummary), and a
 * Codex apply_patch lists every file it touches, comma separated.
 */
function callFiles(c: ToolCall): string[] {
  if (!c.name || !c.summary) return []
  const names = /^apply_?patch$/i.test(c.name) ? c.summary.split(', ') : [c.summary]
  const out: string[] = []
  for (const n of names) {
    const f = fileOfToolInput(c.name, { file_path: n })
    if (f) out.push(f)
  }
  return out
}

function phaseOf(items: ChatToolsRow[], family: ToolFamily): ChatPhaseRow {
  let count = 0
  const files: string[] = []
  for (const row of items) {
    for (const c of row.calls) {
      if (!c.name) continue
      count++
      for (const f of callFiles(c)) if (files.length < DIGEST_FILES_MAX && !files.includes(f)) files.push(f)
    }
  }
  return { kind: 'phase', id: `p:${items[0].id}`, family, count, files, items }
}

/**
 * Consecutive `tools` rows of one family become one `phase`. A message row
 * (text, thinking, a user prompt, a system row: so also a turn boundary),
 * another family, a row of orphan results or a row with an errored call ends
 * the phase; the errored row stays visible on its own. A lone row stays a
 * plain `tools` row. Results land later than their calls, so this runs over
 * the finished runs.
 */
function foldPhases(rows: ChatRow[]): ChatRow[] {
  const out: ChatRow[] = []
  let group: ChatToolsRow[] = []
  let family: ToolFamily | null = null
  const end = (): void => {
    if (group.length > 1 && family) out.push(phaseOf(group, family))
    else out.push(...group)
    group = []
    family = null
  }
  for (const row of rows) {
    const f = row.kind === 'tools' && runStatus(row.calls) !== 'error' ? rowFamily(row) : null
    if (row.kind !== 'tools' || f === null) {
      end()
      out.push(row)
      continue
    }
    if (group.length && f !== family) end()
    group.push(row)
    family = f
  }
  end()
  return out
}

/** Rows for the list, oldest first: tool runs, then phases unless `phases: false`. */
export function buildRows(items: readonly ChatMessage[], opts: BuildRowsOptions = {}): ChatRow[] {
  const rows = toolRuns(items)
  return opts.phases === false ? rows : foldPhases(rows)
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

/** Every call of a phase, for its status and its expanded view. */
export function phaseCalls(row: ChatPhaseRow): ToolCall[] {
  return row.items.flatMap((r) => r.calls)
}

/** Where a consumer's chat keys live: the phone `chat.`, the share guest `shareGuest.chat.`. */
export type ChatKeyNs = 'chat.' | 'shareGuest.chat.'

export type RunLabelSuffix = 'tools.result' | 'tools.mixed' | 'tools.files' | 'tools.commands' | 'tools.times'

/** A tool row label: literal text (one call), or a key of the namespace plus its vars. */
export type RunLabel<N extends ChatKeyNs> = { text: string } | { key: `${N}${RunLabelSuffix}`; vars: Record<string, string | number> }

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/**
 * The one line of a tool row (FR-28): "Read 3 files", "Bash npm test",
 * "Edit App.tsx +12 -3", "4 tools: Read, Edit, Bash". One call is literal
 * text (its name and summary are not words to translate); the rest are keys.
 */
export function runLabelOf<N extends ChatKeyNs>(calls: readonly ToolCall[], ns: N): RunLabel<N> {
  const key = (suffix: RunLabelSuffix): `${N}${RunLabelSuffix}` => `${ns}${suffix}`
  const named = calls.filter((c) => c.name)
  if (!named.length) return { key: key('tools.result'), vars: { n: calls.length } }
  const names = [...new Set(named.map((c) => c.name))]
  if (names.length > 1) return { key: key('tools.mixed'), vars: { n: calls.length, names: names.join(', ') } }
  const name = names[0]
  const n = named.length
  if (n === 1) {
    const c = named[0]
    let text = c.summary ? `${name} ${c.summary}` : name
    if (FILE_TOOLS.has(name) && c.result?.patch) {
      const { add, del } = patchCounts(c.result.patch.hunks)
      text += ` +${add} -${del}`
    }
    return { text }
  }
  if (name === 'Read' || FILE_TOOLS.has(name)) return { key: key('tools.files'), vars: { name, n } }
  if (name === 'Bash' || name === 'shell' || name === 'local_shell') return { key: key('tools.commands'), vars: { name, n } }
  return { key: key('tools.times'), vars: { name, n } }
}

/** A system row's text the UI translates (interrupt, skipped record) as a key of the namespace, else null. */
export function systemKeyOf<N extends ChatKeyNs>(text: string, ns: N): `${N}interrupted` | `${N}skipped` | null {
  if (text.startsWith(CHAT_INTERRUPTED_TEXT.slice(0, -1))) return `${ns}interrupted`
  if (text === CHAT_SKIPPED_TEXT) return `${ns}skipped`
  return null
}

/** FR-32: only http and https links are offered (the guest still confirms them). */
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

/** True when a user text is longer than the fold (by lines, or roughly by length). */
export function needsFold(text: string): boolean {
  return text.split('\n').length > USER_FOLD_LINES || text.length > 280
}
