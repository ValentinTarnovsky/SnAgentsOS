/**
 * Tool activity (app 2.7.0, A2): the family of a Claude Code or Codex tool
 * call, and the digest of one turn built from those families ("Edit 3, Read
 * 2, Run 1 (a.ts, b.ts)"). Pure, with no Node and no DOM: main (status, open
 * tools, the turn digest), the desktop and the phone (chat phases) share it.
 * Nothing here is translated: a family's words are the i18n keys
 * `tool.verb.<family>` ("Reading") and `tool.family.<family>` ("Read") of the
 * three catalogs (test-tool-activity.cjs checks them).
 */

export type ToolFamily = 'read' | 'search' | 'edit' | 'run' | 'web' | 'agent' | 'plan' | 'ask' | 'todo' | 'mcp' | 'notebook' | 'other'

/** Every family, in display order (also the tie break of digestLine). */
export const TOOL_FAMILIES: readonly ToolFamily[] = ['read', 'search', 'edit', 'run', 'web', 'agent', 'plan', 'ask', 'todo', 'mcp', 'notebook', 'other']

export type ToolProvider = 'claude' | 'codex'

export type ToolVerbKey = `tool.verb.${ToolFamily}`
export type ToolFamilyKey = `tool.family.${ToolFamily}`

const FAMILY_SET: ReadonlySet<string> = new Set(TOOL_FAMILIES)

/** A known family (a value from the wire or a config is checked before use). */
export function isToolFamily(v: unknown): v is ToolFamily {
  return typeof v === 'string' && FAMILY_SET.has(v)
}

function table(groups: Partial<Record<ToolFamily, readonly string[]>>, key: (name: string) => string): ReadonlyMap<string, ToolFamily> {
  const map = new Map<string, ToolFamily>()
  for (const family of TOOL_FAMILIES) for (const name of groups[family] ?? []) map.set(key(name), family)
  return map
}

/**
 * Claude Code tools, by exact name (case included). TaskOutput and TaskStop
 * are the 2.x names of BashOutput and KillShell; LSP (definitions,
 * references) navigates code like a search; ListMcpResourcesTool and
 * ReadMcpResourceTool are built in but read MCP resources. `mcp__*` is
 * parsed apart (parseMcpTool); anything else (Skill, SlashCommand...) is
 * `other`.
 */
const CLAUDE = table(
  {
    read: ['Read', 'LS'],
    search: ['Grep', 'Glob', 'ToolSearch', 'LSP'],
    edit: ['Edit', 'Write', 'MultiEdit'],
    notebook: ['NotebookEdit', 'NotebookRead'],
    run: ['Bash', 'PowerShell', 'BashOutput', 'KillShell', 'KillBash', 'Monitor', 'TaskOutput', 'TaskStop'],
    web: ['WebFetch', 'WebSearch'],
    agent: ['Task', 'Agent', 'Workflow', 'SendMessage', 'ListAgents'],
    plan: ['ExitPlanMode', 'EnterPlanMode'],
    ask: ['AskUserQuestion'],
    todo: ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'],
    mcp: ['ListMcpResourcesTool', 'ReadMcpResourceTool'],
  },
  (name) => name,
)

/** Codex names compare without case, `_`, `.` or `-`: snake_case and camelCase are one name. */
function codexKey(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, '').toLowerCase()
}

/**
 * Codex, three vocabularies in one table:
 *  - tool names (hooks, rollout `function_call`): shell, exec_command,
 *    local_shell, unified_exec, write_stdin, container.exec, apply_patch,
 *    update_plan, web_search, view_image, and the collab agent tools;
 *  - `exec --json` item types: command_execution, file_change, web_search,
 *    mcp_tool_call, todo_list, collab_tool_call;
 *  - app-server ThreadItem types: commandExecution, fileChange, webSearch,
 *    mcpToolCall, imageView, collabAgentToolCall, subAgentActivity, plan,
 *    dynamicToolCall.
 */
const CODEX = table(
  {
    read: ['view_image', 'imageView'],
    edit: ['apply_patch', 'file_change', 'fileChange'],
    run: ['shell', 'exec_command', 'local_shell', 'unified_exec', 'write_stdin', 'container.exec', 'command_execution', 'commandExecution'],
    web: ['web_search', 'webSearch'],
    agent: [
      'collab_tool_call',
      'collabAgentToolCall',
      'subAgentActivity',
      'spawn_agent',
      'send_input',
      'resume_agent',
      'close_agent',
      'interrupt_agent',
      'followup_task',
      'list_agents',
      'send_message',
    ],
    plan: ['plan'],
    todo: ['update_plan', 'todo_list'],
    mcp: ['mcp_tool_call', 'mcpToolCall'],
    other: ['dynamicToolCall'],
  },
  codexKey,
)

const MCP_PREFIX = 'mcp__'

/**
 * A Claude MCP tool name, `mcp__<server>__<tool>`. The server may hold single
 * underscores (`mcp__claude_ai_Docs__read`); the first run of two or more
 * underscores after it is the separator, its last two underscores the
 * delimiter (so `mcp__a___b` is server `a_`, tool `b`). Null when the name is
 * not MCP or the server or the tool is empty.
 */
export function parseMcpTool(name: string): { server: string; tool: string } | null {
  if (typeof name !== 'string' || !name.startsWith(MCP_PREFIX)) return null
  const rest = name.slice(MCP_PREFIX.length)
  const m = /_{2,}/.exec(rest)
  if (!m || m.index === 0) return null
  const cut = m.index + m[0].length - 2
  const server = rest.slice(0, cut)
  const tool = rest.slice(cut + 2)
  return server && tool ? { server, tool } : null
}

/**
 * The family of a tool call. `provider` only orders the lookups (its own
 * table first); the other CLI's table still answers, since no name means two
 * different things today. Unknown, empty or missing names are `other`.
 */
export function familyOf(name: string | undefined, provider?: ToolProvider): ToolFamily {
  if (typeof name !== 'string' || !name) return 'other'
  const claude = (): ToolFamily | undefined => CLAUDE.get(name)
  const codex = (): ToolFamily | undefined => CODEX.get(codexKey(name))
  const found = provider === 'codex' ? (codex() ?? claude()) : (claude() ?? codex())
  if (found) return found
  return parseMcpTool(name) ? 'mcp' : 'other'
}

/** `tool.verb.<family>` ("Reading"); junk from the wire falls back to `other`. */
export function toolVerbKey(family: ToolFamily): ToolVerbKey {
  return `tool.verb.${isToolFamily(family) ? family : 'other'}`
}

/** `tool.family.<family>` ("Read"); junk from the wire falls back to `other`. */
export function toolFamilyKey(family: ToolFamily): ToolFamilyKey {
  return `tool.family.${isToolFamily(family) ? family : 'other'}`
}

// --- Files ---------------------------------------------------------------------------

/** Families whose input names the file they work on (a Grep or Glob `path` is a search scope, so search names none). */
const FILE_FAMILIES: ReadonlySet<ToolFamily> = new Set(['read', 'edit', 'notebook'])

/** Longest file label kept (its end, where the name is). */
const FILE_LABEL_MAX = 120

// C0, DEL, C1, line separators, zero-width and bidi marks, BOM: a path is shown
// as one line of text that reads as it is (a digest line also goes out in notices).
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** The first file of a Codex patch (`*** Update File: src/a.ts`). */
function patchFile(patch: string): string {
  return /^\*\*\* (?:Update|Add|Delete) File: (.+)$/m.exec(patch)?.[1] ?? ''
}

/** The last two segments of a path, either separator, joined by `/`. */
function shortPath(path: string): string | undefined {
  const parts = path
    .replace(CONTROL_RE, '')
    .split(/[\\/]+/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (!parts.length) return undefined
  let out = parts.slice(-2).join('/')
  if (out.length > FILE_LABEL_MAX) {
    out = out.slice(-FILE_LABEL_MAX)
    // Never start on the second half of a surrogate pair.
    const code = out.charCodeAt(0)
    if (code >= 0xdc00 && code <= 0xdfff) out = out.slice(1)
  }
  return out
}

/**
 * The file a tool call works on, for digests and chat phases: `file_path`,
 * `path` or `notebook_path` of its input (also a Codex patch text, or the
 * first change of a Codex fileChange item), shown as its last two path
 * segments (`src/a.ts`). Only read, edit and notebook tools name a file.
 */
export function fileOfToolInput(name: string, input: unknown): string | undefined {
  if (!FILE_FAMILIES.has(familyOf(name))) return undefined
  let path = ''
  if (typeof input === 'string') path = patchFile(input)
  else if (input && typeof input === 'object' && !Array.isArray(input)) {
    const rec = input as Record<string, unknown>
    path = str(rec.file_path) || str(rec.path) || str(rec.notebook_path)
    if (!path && Array.isArray(rec.changes)) {
      const first: unknown = rec.changes[0]
      if (first && typeof first === 'object') path = str((first as Record<string, unknown>).path)
    }
  }
  return path.trim() ? shortPath(path) : undefined
}

// --- Turn digest ---------------------------------------------------------------------

export interface TurnDigest {
  /** Tool calls in the turn. */
  tools: number
  /** Calls per family (a missing family is 0). */
  families: Partial<Record<ToolFamily, number>>
  /** Files the turn worked on (fileOfToolInput), the first DIGEST_FILES_MAX distinct ones. */
  files: string[]
  /** Family of the latest call. */
  lastFamily?: ToolFamily
}

export const DIGEST_FILES_MAX = 5

export function emptyDigest(): TurnDigest {
  return { tools: 0, families: {}, files: [] }
}

/** One more call in the turn. Pure: `d` is left as it was. */
export function addTool(d: TurnDigest, name: string, opts: { provider?: ToolProvider; file?: string } = {}): TurnDigest {
  const family = familyOf(name, opts.provider)
  const file = typeof opts.file === 'string' ? opts.file.trim() : ''
  const files = file && d.files.length < DIGEST_FILES_MAX && !d.files.includes(file) ? [...d.files, file] : d.files.slice()
  return { tools: d.tools + 1, families: { ...d.families, [family]: (d.families[family] ?? 0) + 1 }, files, lastFamily: family }
}

/**
 * One line for a digest: the `max` (default 3, at least 1) families with the
 * most calls, ties in TOOL_FAMILIES order, each as "<label> <count>", then
 * its files in parentheses: "Edit 3, Read 2, Run 1 (a.ts, b.ts)". Empty for
 * a digest with no calls. `label` turns a family into words (a translated
 * `tool.family.*`). Junk counts or files (a digest from the wire) are skipped.
 */
export function digestLine(d: TurnDigest, label: (family: ToolFamily) => string, max = 3): string {
  const families = d && typeof d.families === 'object' && d.families ? d.families : {}
  const counts: Array<[ToolFamily, number]> = []
  for (const f of TOOL_FAMILIES) {
    const n = families[f]
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) counts.push([f, Math.floor(n)])
  }
  if (!counts.length) return ''
  // Stable sort: equal counts keep TOOL_FAMILIES order.
  counts.sort((a, b) => b[1] - a[1])
  const limit = Math.max(1, Math.floor(Number.isFinite(max) ? max : 3))
  const head = counts
    .slice(0, limit)
    .map(([f, n]) => `${label(f)} ${n}`)
    .join(', ')
  const files = (Array.isArray(d.files) ? d.files : []).filter((f): f is string => typeof f === 'string' && !!f.trim()).slice(0, DIGEST_FILES_MAX)
  return files.length ? `${head} (${files.join(', ')})` : head
}
