import { open, realpath as realpathAsync } from 'fs/promises'
import { realpathSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import type { RemotePending } from '@shared/types'

/**
 * Pure helpers behind the status enrichment (E4-FR-09, E5-FR-01/02): bounded
 * summaries of hook payloads, the transcript path guard and the transcript
 * tail fallback. Nothing here logs, and raw `tool_input` never leaves these
 * functions: callers only keep the bounded strings they return.
 */

/** In-memory caps (E5-FR-01) and the wire caps of the contracts (E4-FR-09). */
export const LIMITS = {
  /** prompt / reply kept in memory. */
  text: 2000,
  /** RemotePaneStatus.lastMessage. */
  lastMessage: 280,
  /** RemotePending.summary. */
  summary: 200,
  /** detail.text (desktop only). */
  detail: 160,
  /** RemotePaneStatus.activity. */
  activity: 120,
  /** topic and firstPrompt. */
  title: 60,
  /** AskUserQuestion question in HookEvent. */
  question: 300,
} as const

// CSI / OSC / DCS-style escapes and lone ESC pairs.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[@-Z\\-_])/g
// C0 except \n, DEL and C1.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/g
// Any control character at all (paths).
// eslint-disable-next-line no-control-regex
const ANY_CONTROL = /[\x00-\x1f\x7f-\x9f]/

/** Strips ANSI escapes and control characters; keeps line breaks unless `oneLine`. */
export function sanitize(text: string, oneLine = false): string {
  const clean = text.replace(/\r\n?/g, '\n').replace(ANSI_RE, '').replace(/\t/g, ' ').replace(CONTROL_RE, '')
  return oneLine ? clean.replace(/\s+/g, ' ').trim() : clean.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Cuts to at most `max` UTF-16 units, never splitting a surrogate pair, and
 * marks the cut with an ellipsis that counts toward the limit.
 */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  let end = Math.max(0, max - 1)
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end--
  return text.slice(0, end).trimEnd() + '…'
}

/** Sanitizes a value that should be a string; anything else is undefined. */
export function cleanString(value: unknown, max: number, oneLine = false): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = clip(sanitize(value, oneLine), max)
  return text ? text : undefined
}

/** First non-empty line without markdown markers (`#*>` and backticks). */
export function firstLine(text: string | undefined, max = 140): string {
  if (!text) return ''
  for (const raw of sanitize(text).split('\n')) {
    const line = raw.replace(/[#*>`]+/g, ' ').replace(/\s+/g, ' ').trim()
    if (line) return clip(line, max)
  }
  return ''
}

function str(input: unknown, key: string): string {
  if (!input || typeof input !== 'object') return ''
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}

function base(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

/**
 * Short tool description for the current-tool line (detail / activity), E5
 * rules: file tools name the file, Bash its first command line (60), search
 * tools their pattern (40), WebFetch the host, Task its description and MCP
 * tools `mcp srv.tool`. Anything else is the tool name.
 */
export function summarizeTool(toolName: string | undefined, toolInput: unknown): string {
  const name = sanitize(toolName ?? '', true)
  if (!name) return ''
  let out = name
  switch (name) {
    case 'Edit': case 'Write': case 'Read': case 'MultiEdit': case 'NotebookEdit': {
      const file = str(toolInput, 'file_path') || str(toolInput, 'notebook_path')
      if (file) out = `${name} ${base(file)}`
      break
    }
    case 'Bash': {
      const line = firstCommandLine(str(toolInput, 'command'))
      if (line) out = `Bash: ${clip(line, 60)}`
      break
    }
    case 'Grep': case 'Glob': {
      const pattern = sanitize(str(toolInput, 'pattern'), true)
      if (pattern) out = `${name} "${clip(pattern, 40)}"`
      break
    }
    case 'WebFetch': {
      try { out = `WebFetch ${new URL(str(toolInput, 'url')).host}` } catch { /* keep the name */ }
      break
    }
    case 'Task': case 'Agent': {
      const description = sanitize(str(toolInput, 'description'), true)
      if (description) out = `Task: ${description}`
      break
    }
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
      if (mcp) out = `mcp ${mcp[1]}.${mcp[2]}`
    }
  }
  return clip(sanitize(out, true), LIMITS.detail)
}

function firstCommandLine(command: string): string {
  for (const line of sanitize(command).split('\n')) {
    const trimmed = line.replace(/\s+/g, ' ').trim()
    if (trimmed) return trimmed
  }
  return ''
}

/**
 * Longer description for a pending request card (RemotePending.summary,
 * <= 200): Bash keeps the whole first command line, file tools the full path,
 * ExitPlanMode the first line of the plan. Falls back to `summarizeTool`.
 */
export function summarizeRequest(toolName: string | undefined, toolInput: unknown): string {
  const name = sanitize(toolName ?? '', true)
  if (!name) return ''
  let out = ''
  if (name === 'Bash') {
    const line = firstCommandLine(str(toolInput, 'command'))
    if (line) out = `Bash: ${line}`
  } else if (['Edit', 'Write', 'Read', 'MultiEdit', 'NotebookEdit'].includes(name)) {
    const file = sanitize(str(toolInput, 'file_path') || str(toolInput, 'notebook_path'), true)
    if (file) out = `${name} ${file}`
  } else if (name === 'ExitPlanMode') {
    out = firstLine(str(toolInput, 'plan'), LIMITS.summary)
  } else if (name === 'AskUserQuestion') {
    out = extractQuestions(toolInput)?.[0]?.question ?? ''
  }
  return clip(out || summarizeTool(name, toolInput), LIMITS.summary)
}

/** Structured AskUserQuestion questions in the RemotePending shape, bounded. */
export function extractQuestions(toolInput: unknown): RemotePending['questions'] {
  const list = toolInput && typeof toolInput === 'object' ? (toolInput as Record<string, unknown>).questions : undefined
  if (!Array.isArray(list)) return undefined
  const out: NonNullable<RemotePending['questions']> = []
  for (const item of list.slice(0, 4)) {
    if (!item || typeof item !== 'object') continue
    const q = item as Record<string, unknown>
    const question = cleanString(q.question, LIMITS.question, true)
    if (!question) continue
    const options: Array<{ label: string; description?: string }> = []
    if (Array.isArray(q.options)) {
      for (const opt of q.options.slice(0, 10)) {
        if (!opt || typeof opt !== 'object') continue
        const o = opt as Record<string, unknown>
        const label = cleanString(o.label, 80, true)
        if (!label) continue
        const description = cleanString(o.description, LIMITS.summary, true)
        options.push(description ? { label, description } : { label })
      }
    }
    const header = cleanString(q.header, 40, true)
    out.push({ question, ...(header ? { header } : {}), multiSelect: q.multiSelect === true, options })
  }
  return out.length ? out : undefined
}

/** Claude's config dir, honoring CLAUDE_CONFIG_DIR (same rule as HookInstaller). */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

function realOrResolved(p: string): string {
  try { return realpathSync.native(p) } catch {
    // A transcript can be announced before its first write: judge its folder.
    try { return join(realpathSync.native(dirname(p)), basename(p)) } catch { return resolve(p) }
  }
}

/**
 * True when `p` is a Claude transcript of `sessionId`: absolute, no `..`
 * segment, `.jsonl`, basename starting with the session id, and a realpath
 * inside `<claudeDir>/projects`. Main never opens a hook path that fails this.
 */
export function isSafeTranscriptPath(p: unknown, sessionId: unknown, claudeDir: string): p is string {
  if (typeof p !== 'string' || typeof sessionId !== 'string' || !sessionId || p.length > 4096) return false
  if (!isAbsolute(p) || p.split(/[\\/]/).includes('..') || ANY_CONTROL.test(p)) return false
  const name = basename(p)
  if (!/\.jsonl$/i.test(name) || !name.startsWith(sessionId)) return false
  const root = realOrResolved(join(claudeDir, 'projects'))
  const real = realOrResolved(p)
  const fold = (s: string): string => (process.platform === 'win32' || process.platform === 'darwin' ? s.toLowerCase() : s)
  const rel = relative(fold(root), fold(real))
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..') && /\.jsonl$/i.test(real)
}

/** A hook `cwd` is kept only when absolute and an existing directory. */
export function isSafeCwd(p: unknown): p is string {
  if (typeof p !== 'string' || !p || p.length > 4096 || !isAbsolute(p)) return false
  if (ANY_CONTROL.test(p)) return false
  try { return statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false } catch { return false }
}

const TAIL_BYTES = 64 * 1024

function assistantText(entry: unknown): string {
  if (!entry || typeof entry !== 'object') return ''
  const e = entry as Record<string, unknown>
  if (e.type !== 'assistant' || e.isSidechain === true) return ''
  const message = e.message as Record<string, unknown> | undefined
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text: string } => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('\n')
}

/**
 * Reads the last 64 KB of a transcript (already validated by
 * isSafeTranscriptPath) and returns the newest main-thread assistant text,
 * sanitized and capped at 2000. Used when Stop carries no
 * `last_assistant_message` (E1-FR-09 / E5-FR-01 P1). Errors resolve to
 * undefined and are never logged with content.
 */
export async function readLastAssistantMessage(path: string, sessionId: string, claudeDir = claudeConfigDir()): Promise<string | undefined> {
  try {
    // Re-judge the realpath right before opening: the file may have moved.
    const real = await realpathAsync(path)
    if (!isSafeTranscriptPath(real, sessionId, claudeDir)) return undefined
    const handle = await open(real, 'r')
    try {
      const { size } = await handle.stat()
      const start = Math.max(0, size - TAIL_BYTES)
      const length = size - start
      if (length <= 0) return undefined
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, start)
      const lines = buffer.toString('utf8').split('\n')
      if (start > 0) lines.shift() // partial first line
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim()
        if (!line) continue
        let entry: unknown
        try { entry = JSON.parse(line) } catch { continue }
        const text = assistantText(entry)
        if (text.trim()) return cleanString(text, LIMITS.text)
      }
      return undefined
    } finally { await handle.close() }
  } catch { return undefined }
}
