// Adaptado de paperclipai/paperclip (MIT) - packages/adapters/codex-local/src/ui/parse-stdout.ts

/**
 * One line of `codex exec --json` (the stdout of a Codex team run, kept in its
 * run log, app 2.7.0 E10 B2) as chat messages, the way decodeCodex.ts reads a
 * rollout. Same item mapping as paperclip's stdout parser, rewritten for
 * SnAgentsOS's ChatMessage:
 *
 *  - `agent_message` is assistant text and `reasoning` its thinking;
 *  - `command_execution` is a tool call at `item.started` and its result at
 *    `item.completed` (an error when the exit code is not 0 or the status
 *    failed), paired by the item id;
 *  - `mcp_tool_call` likewise; `file_change`, `web_search` and `todo_list`
 *    arrive whole at `item.completed`, so that line yields the call and its
 *    result;
 *  - `error` events, `turn.failed` and error items are system rows;
 *  - `thread.started`, `turn.started`, `turn.completed` and `item.updated`
 *    show nothing.
 *
 * Unknown fields and shapes are dropped, never thrown on.
 */
import {
  CHAT_SUMMARY_MAX,
  CHAT_TEXT_MAX,
  CHAT_THINKING_MAX,
  CHAT_TOOL_TEXT_MAX,
  type ChatBlock,
  type ChatMessage,
  type ChatRole,
} from '@shared/chat-types'
import { baseName, boundedText, cleanText, clipLine, cutAt, tsOf } from './chatText'
import { firstCommandLine, toolSummary } from './toolSummary'

type Rec = Record<string, unknown>

function isRec(v: unknown): v is Rec {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

const FAILED_STATUS_RE = /^(?:failed|errored|error|cancelled|declined)$/i
/** A shell the command runs through: its body is what the summary shows. */
const SHELL_NAME_RE = /(?:^|[\\/])(?:(?:ba|z|da)?sh|powershell|pwsh|cmd)(?:\.exe)?$/i

/**
 * `"C:\...\powershell.exe" -NoProfile -Command 'Get-Content a.txt'` -> `Get-Content a.txt`
 * (also `bash -lc "..."`, `cmd /c ...`); any other command as is.
 */
function shellBody(command: string): string {
  const m = /^\s*(?:"([^"]+)"|(\S+))\s+([\s\S]*)$/.exec(command)
  if (!m || !SHELL_NAME_RE.test(m[1] ?? m[2] ?? '')) return command
  const flag = /(?:^|\s)(?:-command|-c|-lc|\/c)\s+([\s\S]*)$/i.exec(m[3])
  if (!flag) return command
  let body = flag[1].trim()
  const q = body[0]
  if ((q === "'" || q === '"') && body.length > 1 && body.endsWith(q)) body = body.slice(1, -1)
  return body
}

function commandOf(v: unknown): string {
  if (typeof v === 'string') return v
  return Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string').join(' ') : ''
}

function toolUse(id: string, name: string, summary: string): ChatBlock {
  return { t: 'toolUse', id, name: cutAt(cleanText(name), 128) || 'tool', summary: clipLine(summary, CHAT_SUMMARY_MAX) }
}

function toolResult(toolUseId: string, isError: boolean, text: string): ChatBlock {
  const b = boundedText(text.replace(/\s+$/, ''), CHAT_TOOL_TEXT_MAX)
  const block: ChatBlock = { t: 'toolResult', toolUseId, isError, text: b.text }
  if (b.truncated) block.truncated = true
  return block
}

/** An error's words: a string, or the `message` / `error` / `code` of an object. */
function errorText(v: unknown): string {
  if (typeof v === 'string') return v
  if (!isRec(v)) return ''
  return str(v.message) || str(v.error) || str(v.code)
}

function systemRow(text: string): Array<{ role: ChatRole; blocks: ChatBlock[] }> {
  const b = boundedText(text.trim(), CHAT_TEXT_MAX)
  return b.text ? [{ role: 'system', blocks: [{ t: 'text', ...b }] }] : []
}

/** `{content: [{type: 'text', text}]}` of an MCP result, or its error. */
function mcpText(item: Rec): string {
  const result = item.result
  if (typeof result === 'string') return result
  const parts: string[] = []
  if (isRec(result) && Array.isArray(result.content)) {
    for (const p of result.content) if (isRec(p) && typeof p.text === 'string') parts.push(p.text)
  }
  return parts.length ? parts.join('\n') : errorText(item.error)
}

function mcpName(item: Rec): string {
  const server = str(item.server).trim()
  const tool = str(item.tool).trim()
  return server && tool ? `mcp__${server}__${tool}` : 'mcp_tool_call'
}

function decodeItem(item: Rec, phase: 'started' | 'completed', fallbackId: string): Array<{ role: ChatRole; blocks: ChatBlock[] }> {
  const type = str(item.type)
  const id = str(item.id) || fallbackId
  const failed = FAILED_STATUS_RE.test(str(item.status))
  switch (type) {
    case 'agent_message': {
      if (phase !== 'completed') return []
      const b = boundedText(str(item.text), CHAT_TEXT_MAX)
      return b.text.trim() ? [{ role: 'assistant', blocks: [{ t: 'text', ...b }] }] : []
    }
    case 'reasoning': {
      if (phase !== 'completed') return []
      const b = boundedText(str(item.text), CHAT_THINKING_MAX)
      return b.text.trim() ? [{ role: 'assistant', blocks: [{ t: 'thinking', ...b }] }] : []
    }
    case 'command_execution': {
      if (phase === 'started') return [{ role: 'assistant', blocks: [toolUse(id, 'command_execution', firstCommandLine(shellBody(commandOf(item.command))))] }]
      const exit = typeof item.exit_code === 'number' && Number.isFinite(item.exit_code) ? item.exit_code : null
      return [{ role: 'tool', blocks: [toolResult(id, (exit !== null && exit !== 0) || failed, str(item.aggregated_output))] }]
    }
    case 'mcp_tool_call': {
      const name = mcpName(item)
      if (phase === 'started') return [{ role: 'assistant', blocks: [toolUse(id, name, toolSummary(name, item.arguments))] }]
      return [{ role: 'tool', blocks: [toolResult(id, failed || item.error != null, mcpText(item))] }]
    }
    case 'file_change': {
      if (phase !== 'completed') return []
      const changes = (Array.isArray(item.changes) ? item.changes : []).filter(isRec)
      const paths = changes.map((c) => str(c.path)).filter(Boolean)
      const lines = changes.map((c) => `${str(c.kind) || 'update'} ${str(c.path) || '?'}`)
      return [
        { role: 'assistant', blocks: [toolUse(id, 'file_change', paths.map(baseName).join(', '))] },
        { role: 'tool', blocks: [toolResult(id, failed, lines.join('\n'))] },
      ]
    }
    case 'web_search': {
      if (phase !== 'completed') return []
      return [
        { role: 'assistant', blocks: [toolUse(id, 'web_search', str(item.query))] },
        { role: 'tool', blocks: [toolResult(id, failed, '')] },
      ]
    }
    case 'todo_list': {
      if (phase !== 'completed') return []
      const items = (Array.isArray(item.items) ? item.items : []).filter(isRec)
      const open = items.find((i) => i.completed !== true) ?? items[0]
      const lines = items.map((i) => `${i.completed === true ? '[x]' : '[ ]'} ${str(i.text)}`)
      return [
        { role: 'assistant', blocks: [toolUse(id, 'todo_list', open ? str(open.text) : '')] },
        { role: 'tool', blocks: [toolResult(id, false, lines.join('\n'))] },
      ]
    }
    case 'error':
      return phase === 'completed' ? systemRow(errorText(item.message ?? item.error)) : []
    default:
      return []
  }
}

/** Messages of one parsed `codex exec --json` record that starts at byte `offset`. */
export function decodeCodexExec(record: unknown, offset: number): ChatMessage[] {
  if (!isRec(record)) return []
  const id = String(offset)
  const ts = tsOf(record.timestamp)
  let rows: Array<{ role: ChatRole; blocks: ChatBlock[] }> = []
  switch (record.type) {
    case 'item.started':
    case 'item.completed':
      if (isRec(record.item)) rows = decodeItem(record.item, record.type === 'item.started' ? 'started' : 'completed', `item:${id}`)
      break
    case 'turn.failed':
      rows = systemRow(errorText(record.error ?? record.message))
      break
    case 'error':
      rows = systemRow(errorText(record.message ?? record.error))
      break
    default:
      return []
  }
  if (rows.length === 1) return [{ id, ts, ...rows[0] }]
  return rows.map((r, i) => ({ id: `${id}.${i}`, ts, ...r }))
}
