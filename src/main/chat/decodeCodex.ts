// Adaptado de stablyai/orca (MIT) - src/main/native-chat/transcript-line-decoders-codex.ts

/**
 * One line of a Codex rollout (`<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*-<threadId>.jsonl`)
 * as the phone's chat messages (E3-FR-34, P2). Same reading as Orca's decoder,
 * rewritten for SnAgentsOS's ChatMessage:
 *
 *  - `response_item` carries the conversation: `message` (user / assistant
 *    text), `reasoning` (its summary as thinking), `function_call`,
 *    `custom_tool_call` and `local_shell_call` (tool rows) and their outputs;
 *  - the injected context Codex writes as user text (`<environment_context>`,
 *    `<user_instructions>`, AGENTS.md) and `developer` messages are skipped;
 *  - `event_msg` only adds the interruption (`turn_aborted`) as a system row,
 *    since its user / agent messages repeat the response items;
 *  - older rollouts without the `{type, payload}` envelope decode the same.
 */
import {
  CHAT_INTERRUPTED_TEXT,
  CHAT_SUMMARY_MAX,
  CHAT_TEXT_MAX,
  CHAT_THINKING_MAX,
  CHAT_TOOL_TEXT_MAX,
  type ChatBlock,
  type ChatMessage,
} from '@shared/chat-types'
import { boundedText, cleanText, clipLine, cutAt, tsOf } from './chatText'
import { firstCommandLine, toolSummary } from './toolSummary'

type Rec = Record<string, unknown>

function isRec(v: unknown): v is Rec {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

const INJECTED_RE = /^\s*(<environment_context>|<user_instructions>|<user_shell_command>|# AGENTS\.md instructions|<INSTRUCTIONS>)/

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (isRec(part) && typeof part.text === 'string' && /^(input_text|output_text|text)$/.test(String(part.type))) parts.push(part.text)
  }
  return parts.join('\n')
}

function hasImage(content: unknown): boolean {
  return Array.isArray(content) && content.some((p) => isRec(p) && p.type === 'input_image')
}

function parseJson(text: unknown): unknown {
  if (typeof text !== 'string') return text
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** `["bash", "-lc", "npm test"]` -> "npm test"; a string command as is. */
function shellCommand(command: unknown): string {
  if (typeof command === 'string') return command
  if (!Array.isArray(command)) return ''
  const parts = command.filter((c): c is string => typeof c === 'string')
  if (parts.length >= 3 && /(^|[\\/])(ba|z|)sh(\.exe)?$|powershell|pwsh|cmd(\.exe)?$/i.test(parts[0]) && /^(-l?c|-Command|\/c)$/i.test(parts[1])) {
    return parts.slice(2).join(' ')
  }
  return parts.join(' ')
}

/** Files an apply_patch touches, for its summary. */
function patchFiles(input: string): string[] {
  const files: string[] = []
  for (const m of input.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) files.push(m[1].trim())
  return files
}

function toolUse(id: string, name: string, input: unknown): ChatBlock {
  const clean = cutAt(cleanText(name), 128) || 'tool'
  let summary: string
  if (clean === 'shell' || clean === 'local_shell' || clean === 'exec_command' || clean === 'container.exec') {
    const args = isRec(input) ? input : {}
    summary = clipLine(firstCommandLine(shellCommand(args.command ?? args.cmd)), CHAT_SUMMARY_MAX)
  } else if (clean === 'apply_patch' && typeof input === 'string') {
    const files = patchFiles(input).map((f) => f.split(/[\\/]/).pop() ?? f)
    summary = clipLine(files.join(', '), CHAT_SUMMARY_MAX)
  } else {
    summary = toolSummary(clean, input)
  }
  return { t: 'toolUse', id, name: clean, summary }
}

/** A function output: plain text, or `{output, metadata:{exit_code}}` JSON. */
function toolOutput(callId: string, output: unknown): ChatBlock {
  let text = ''
  let isError = false
  const parsed = parseJson(output)
  if (isRec(parsed) && (typeof parsed.output === 'string' || isRec(parsed.metadata))) {
    text = typeof parsed.output === 'string' ? parsed.output : ''
    const meta = isRec(parsed.metadata) ? parsed.metadata : null
    if (meta && typeof meta.exit_code === 'number' && meta.exit_code !== 0) isError = true
  } else if (typeof output === 'string') {
    text = output
    const exit = /^Exit code: (\d+)/m.exec(output)
    if (exit && exit[1] !== '0') isError = true
  } else if (isRec(output) && typeof output.content === 'string') {
    text = output.content
    if (output.success === false) isError = true
  }
  const b = boundedText(text, CHAT_TOOL_TEXT_MAX)
  const block: ChatBlock = { t: 'toolResult', toolUseId: callId, isError, text: b.text }
  if (b.truncated) block.truncated = true
  return block
}

function decodeItem(item: Rec, id: string, ts: number | null): ChatMessage[] {
  switch (item.type) {
    case 'message': {
      const role = item.role
      if (role !== 'user' && role !== 'assistant') return []
      const text = contentText(item.content)
      if (role === 'user' && INJECTED_RE.test(text)) return []
      const blocks: ChatBlock[] = []
      const b = boundedText(text, CHAT_TEXT_MAX)
      if (b.text.trim()) blocks.push({ t: 'text', ...b })
      if (hasImage(item.content)) blocks.push({ t: 'image', label: 'image' })
      return blocks.length ? [{ id, role, ts, blocks }] : []
    }
    case 'reasoning': {
      const summary = Array.isArray(item.summary)
        ? item.summary.map((s) => (isRec(s) && typeof s.text === 'string' ? s.text : '')).filter(Boolean).join('\n\n')
        : ''
      const b = boundedText(summary, CHAT_THINKING_MAX)
      return b.text.trim() ? [{ id, role: 'assistant', ts, blocks: [{ t: 'thinking', ...b }] }] : []
    }
    case 'function_call': {
      const callId = typeof item.call_id === 'string' ? item.call_id : ''
      if (!callId || typeof item.name !== 'string') return []
      return [{ id, role: 'assistant', ts, blocks: [toolUse(callId, item.name, parseJson(item.arguments) ?? item.arguments)] }]
    }
    case 'custom_tool_call': {
      const callId = typeof item.call_id === 'string' ? item.call_id : ''
      if (!callId || typeof item.name !== 'string') return []
      return [{ id, role: 'assistant', ts, blocks: [toolUse(callId, item.name, item.input)] }]
    }
    case 'local_shell_call': {
      const callId = typeof item.call_id === 'string' ? item.call_id : typeof item.id === 'string' ? item.id : ''
      if (!callId) return []
      const action = isRec(item.action) ? item.action : {}
      return [{ id, role: 'assistant', ts, blocks: [toolUse(callId, 'local_shell', action)] }]
    }
    case 'function_call_output':
    case 'custom_tool_call_output':
    case 'local_shell_call_output': {
      const callId = typeof item.call_id === 'string' ? item.call_id : ''
      if (!callId) return []
      return [{ id, role: 'tool', ts, blocks: [toolOutput(callId, item.output)] }]
    }
    default:
      return []
  }
}

/** Messages of one parsed rollout record that starts at byte `offset`. */
export function decodeCodex(record: unknown, offset: number): ChatMessage[] {
  if (!isRec(record)) return []
  const id = String(offset)
  const ts = tsOf(record.timestamp)
  if (record.type === 'response_item' && isRec(record.payload)) return decodeItem(record.payload, id, ts)
  if (record.type === 'event_msg' && isRec(record.payload)) {
    if (record.payload.type !== 'turn_aborted') return []
    return [{ id, role: 'system', ts, blocks: [{ t: 'text', text: CHAT_INTERRUPTED_TEXT }] }]
  }
  // Older rollouts: the item itself on the line.
  if (typeof record.type === 'string' && !('payload' in record)) return decodeItem(record, id, ts)
  return []
}
