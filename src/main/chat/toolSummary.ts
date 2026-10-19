/**
 * One line that says what a tool call did, for the phone's grouped tool rows
 * (E3-FR-28): Bash its first command line, the file tools the file name,
 * Grep/Glob the pattern, Task its description, WebFetch the URL, and any
 * other tool the first string of its input. Capped at CHAT_SUMMARY_MAX; the
 * tool name travels apart (`toolUse.name`), so it is not repeated here.
 */
import { CHAT_SUMMARY_MAX } from '@shared/chat-types'
import { baseName, cleanText, clipLine } from './chatText'

function field(input: unknown, key: string): string {
  if (!input || typeof input !== 'object') return ''
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}

/** First non-empty line of a command. */
export function firstCommandLine(command: string): string {
  for (const line of cleanText(command).split('\n')) {
    if (line.trim()) return line
  }
  return ''
}

/** First string found in an input object, depth first (arrays included). */
function firstString(input: unknown, depth = 0): string {
  if (typeof input === 'string') return input
  if (depth > 3 || !input || typeof input !== 'object') return ''
  const values = Array.isArray(input) ? input : Object.values(input as Record<string, unknown>)
  for (const v of values) {
    const s = firstString(v, depth + 1)
    if (s.trim()) return s
  }
  return ''
}

export function toolSummary(name: string, input: unknown): string {
  let out = ''
  switch (name) {
    case 'Bash':
    case 'BashOutput':
      out = firstCommandLine(field(input, 'command')) || field(input, 'description')
      break
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'NotebookRead': {
      const file = field(input, 'file_path') || field(input, 'notebook_path') || field(input, 'path')
      out = file ? baseName(file) : ''
      break
    }
    case 'Grep':
    case 'Glob':
      out = field(input, 'pattern')
      break
    case 'Task':
    case 'Agent':
      out = field(input, 'description')
      break
    case 'WebFetch':
      out = field(input, 'url')
      break
    case 'WebSearch':
      out = field(input, 'query')
      break
    default:
      out = firstString(input)
  }
  return clipLine(out, CHAT_SUMMARY_MAX)
}
