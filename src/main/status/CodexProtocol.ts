import type { AttentionReason } from '@shared/types'
import { codexFailure, type FailureInfo } from '@shared/failure'
import { familyOf, fileOfToolInput, type ToolFamily } from '@shared/toolActivity'
import type { AgentEvent } from './events'
import { LIMITS, clip, firstLine, sanitize, summarizeTool } from './statusDetails'

// Only metadata is retained. Prompts, command output and tool arguments are never logged.
type Wire = { id?: string | number; method?: string; params?: any; result?: any; error?: unknown }
const REQUESTS: Record<string, AttentionReason> = {
  'item/commandExecution/requestApproval': 'permission',
  'item/fileChange/requestApproval': 'permission',
  'item/permissions/requestApproval': 'permission',
  'item/tool/requestUserInput': 'question',
  'tool/requestUserInput': 'question',
  'mcpServer/elicitation/request': 'elicitation',
}

/**
 * App 2.7.0 (A3): the app-server ThreadItem types that are tool calls. Their
 * `item/started` opens a tool (toolUseId = item.id, toolName = the type, so
 * its family is familyOf(type, 'codex')) and their `item/completed` closes it.
 */
const TOOL_ITEMS: ReadonlySet<string> = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'imageView', 'collabAgentToolCall', 'dynamicToolCall'])
/** Longest item id kept as a tool id, and turn id kept on a usage (app-server ids are short: `call_...` or a UUID). */
const ITEM_ID_MAX = 128
/** Open tool items kept per connection, so a lost `item/completed` never grows the set. */
const OPEN_TOOLS_MAX = 64

/** The family of a tool item (undefined for items that are not tools). */
export function codexItemFamily(item: any): ToolFamily | undefined {
  return typeof item?.type === 'string' && TOOL_ITEMS.has(item.type) ? familyOf(item.type, 'codex') : undefined
}

function itemId(item: any): string | undefined {
  return typeof item?.id === 'string' && item.id && item.id.length <= ITEM_ID_MAX ? item.id : undefined
}

/** Token counts of a `thread/tokenUsage/updated` (TokenUsageBreakdown, codex-cli 0.163.0). */
export interface CodexTokenBreakdown {
  totalTokens: number
  /** Includes `cachedInputTokens` (E10 SPIKE S8). */
  inputTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

/**
 * App 2.7.0 (A3; the A4 ledger and context indicator build on it): the root
 * thread's token usage. `total` is cumulative per thread, `last` the latest
 * model call; `modelContextWindow` is null when the CLI does not know it.
 * `inTurn` is false for a usage sent with no turn of the root thread running
 * (the restored one a resume replays): `last` is then no new call.
 */
export interface CodexTokenUsage {
  threadId: string
  turnId?: string
  total: CodexTokenBreakdown
  last: CodexTokenBreakdown
  modelContextWindow: number | null
  inTurn: boolean
}

/** A count from the wire: a finite non-negative number, or undefined. */
function tokenCount(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
}

/**
 * A TokenUsageBreakdown, or null when it is not one. totalTokens, inputTokens
 * and outputTokens are required; a cache or reasoning count an older CLI does
 * not send is 0, while any field that is there must be a valid count.
 */
function tokenBreakdown(v: unknown): CodexTokenBreakdown | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const src = v as Record<string, unknown>
  const out = {} as CodexTokenBreakdown
  for (const key of ['totalTokens', 'inputTokens', 'outputTokens'] as const) {
    const n = tokenCount(src[key])
    if (n === undefined) return null
    out[key] = n
  }
  for (const key of ['cachedInputTokens', 'cacheWriteInputTokens', 'reasoningOutputTokens'] as const) {
    const n = src[key] === undefined || src[key] === null ? 0 : tokenCount(src[key])
    if (n === undefined) return null
    out[key] = n
  }
  return out
}

/** `thread/tokenUsage/updated` params as a CodexTokenUsage, or null when they are not valid. `inTurn`: a turn of the thread is running. */
export function codexTokenUsage(params: any, inTurn: boolean): CodexTokenUsage | null {
  if (typeof params?.threadId !== 'string' || !params.threadId) return null
  const usage = params.tokenUsage
  const total = tokenBreakdown(usage?.total)
  const last = tokenBreakdown(usage?.last)
  if (!total || !last) return null
  const window = tokenCount(usage.modelContextWindow)
  const out: CodexTokenUsage = { threadId: params.threadId, total, last, modelContextWindow: window ? window : null, inTurn }
  if (typeof params.turnId === 'string' && params.turnId && params.turnId.length <= ITEM_ID_MAX) out.turnId = params.turnId
  return out
}

/**
 * Share of the context window the latest call used, 0..1, or null without a
 * window. `inputTokens` already holds the cached ones (E10 SPIKE S8), so it is
 * (last.inputTokens + last.outputTokens) / modelContextWindow.
 */
export function codexContextPct(usage: CodexTokenUsage): number | null {
  const window = usage?.modelContextWindow
  if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0) return null
  const used = (usage.last?.inputTokens ?? 0) + (usage.last?.outputTokens ?? 0)
  if (!Number.isFinite(used)) return null
  return Math.min(1, Math.max(0, used / window))
}

/** First non-empty line of a command, one line, without touching shell syntax. */
function commandLine(command: unknown): string {
  if (typeof command !== 'string') return ''
  for (const line of sanitize(command).split('\n')) {
    const text = line.replace(/\s+/g, ' ').trim()
    if (text) return clip(text, LIMITS.detail)
  }
  return ''
}

/**
 * v2.4: a thread name from `thread/name/set` params (`name`), the
 * `thread/name/updated` notification (`threadName`) or a Thread (`name`),
 * one line, <= 60. Both keys are read wherever it appears: the field names
 * come from `codex app-server generate-ts` of 0.163, not from a capture of
 * the TUI's own traffic. Undefined for no name.
 */
function threadName(source: any): string | undefined {
  const raw = typeof source?.name === 'string' ? source.name : typeof source?.threadName === 'string' ? source.threadName : ''
  const name = clip(sanitize(raw, true), LIMITS.title)
  return name ? name : undefined
}

/** Text parts of a userMessage item (images, mentions and skills carry no prompt text). */
function userText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n')
}

/** A wire string as one clean line (empty for anything else). */
function oneLine(v: unknown): string {
  return typeof v === 'string' ? sanitize(v, true) : ''
}

/** The query or the page of a webSearch item (its `query` is often empty until it completes). */
function webSearchTool(item: any): string {
  const action = item.action && typeof item.action === 'object' ? item.action : {}
  const queries: unknown[] = Array.isArray(action.queries) ? action.queries : []
  const query = oneLine(item.query) || oneLine(action.query) || queries.map(oneLine).find(Boolean) || ''
  if (query) return clip(`WebSearch "${clip(query, 40)}"`, LIMITS.detail)
  return typeof action.url === 'string' ? summarizeTool('WebFetch', { url: action.url }) : 'WebSearch'
}

/**
 * Detail of a Codex item for the agent row (E5-FR-03): commandExecution ->
 * the command (the parsed one when the CLI split a shell wrapper),
 * fileChange -> the file, mcpToolCall -> `mcp srv.tool`; app 2.7.0 (A3):
 * webSearch -> its query or page host, imageView -> the image, a collab agent
 * call -> the tool and its prompt's first line, dynamicToolCall ->
 * `namespace.tool`. A tool item missing those fields still names its kind;
 * undefined only for items that are not tools.
 */
export function codexItemTool(item: any): string | undefined {
  switch (item?.type) {
    case 'commandExecution': {
      const parsed = Array.isArray(item.commandActions) ? item.commandActions.find((a: any) => typeof a?.command === 'string' && a.command.trim()) : undefined
      return commandLine(parsed?.command ?? item.command) || 'shell'
    }
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes.filter((c: any) => typeof c?.path === 'string' && c.path) : []
      if (!changes.length) return 'Edit'
      const extra = changes.length > 1 ? ` +${changes.length - 1}` : ''
      return clip(summarizeTool('Edit', { file_path: changes[0].path }) + extra, LIMITS.detail)
    }
    case 'mcpToolCall':
      return (typeof item.server === 'string' && typeof item.tool === 'string' ? summarizeTool(`mcp__${item.server}__${item.tool}`, {}) : '') || 'mcp'
    case 'webSearch':
      return webSearchTool(item)
    case 'imageView':
      return typeof item.path === 'string' && item.path ? summarizeTool('Read', { file_path: item.path }) : 'Read'
    case 'collabAgentToolCall': {
      const tool = clip(oneLine(item.tool), 40) || 'Agent'
      const prompt = firstLine(typeof item.prompt === 'string' ? item.prompt : '', 60)
      return clip(prompt ? `${tool}: ${prompt}` : tool, LIMITS.detail)
    }
    case 'dynamicToolCall': {
      const tool = oneLine(item.tool)
      const namespace = oneLine(item.namespace)
      return clip(tool ? (namespace ? `${namespace}.${tool}` : tool) : 'tool', LIMITS.detail)
    }
    default:
      return undefined
  }
}

/** Observes the exact JSON-RPC connection used by one TUI. Never answers requests. */
export class CodexProtocol {
  private root = ''
  private turn = ''
  /** A turn of the root thread is running (between turn/started and turn/completed). */
  private active = false
  /** Last completed agentMessage of the running turn: the reply `done` publishes (E1-FR-08). */
  private reply = ''
  private starts = new Set<string | number>()
  private requests = new Set<string>()
  private asyncQuestions = new Set<string>()
  private submissions = new Map<string | number, string[]>()
  /** v2.4: `thread/name/set` requests of the root thread waiting for their answer: id -> name. */
  private renames = new Map<string | number, string>()
  /** App 2.7.0 (A3): tool items of the root thread's running turn that started and have not completed. */
  private tools = new Set<string>()
  /** App 2.7.0 (A3): the failure the running turn's `error` notification reported (a failed turn/completed may carry none). */
  private failure: FailureInfo | undefined
  /**
   * `onRename` (v2.4 `/rename`): the root thread's name. `explicit` when the
   * server accepted a `thread/name/set` (the user renamed it now); otherwise
   * the name a started or resumed thread already had (undefined: none). It
   * never touches the state machine. `onUsage` (app 2.7.0, A3): the root
   * thread's validated token usage; never an AgentEvent either.
   */
  constructor(private paneId: string, private ptyId: string, private emit: (evt: AgentEvent) => void, private onRename: (sessionId: string, title: string | undefined, explicit: boolean) => void = () => {}, private onUsage: (usage: CodexTokenUsage) => void = () => {}) {}
  client(raw: string): void {
    this.read(raw, m => {
      if (m.id !== undefined && ['thread/start', 'thread/resume', 'thread/fork'].includes(m.method ?? '')) this.starts.add(m.id)
      // v2.4: ThreadSetNameParams { threadId, name } (app-server generate-ts, Codex 0.163).
      // `threadName` is also read in case a later CLI renames the field.
      if (m.id !== undefined && m.method === 'thread/name/set' && this.root && m.params?.threadId === this.root) {
        const name = threadName(m.params)
        if (name !== undefined) { this.renames.set(m.id, name); if (this.renames.size > 16) this.renames.delete(this.renames.keys().next().value!) }
      }
      // Async question answers are submitted as normal user input by current TUIs.
      // Only acknowledge after the server accepts the input, never on a failed send.
      if (m.id !== undefined && ['turn/start', 'turn/steer'].includes(m.method ?? '') && m.params?.threadId === this.root && m.params?.input?.length) {
        this.submissions.set(m.id, [...this.asyncQuestions])
      }
    })
  }
  server(raw: string): void {
    this.read(raw, m => {
      const response = m.method === undefined && m.id !== undefined
      if (response && this.starts.delete(m.id!) && m.result?.thread?.id) {
        this.root = m.result.thread.id
        this.turn = ''
        this.active = false
        this.reply = ''
        this.requests.clear()
        this.asyncQuestions.clear()
        this.renames.clear()
        this.tools.clear()
        this.failure = undefined
        // A resumed thread names its first user message (`preview`): the row title until a prompt arrives.
        const preview = typeof m.result.thread.preview === 'string' ? clip(m.result.thread.preview, LIMITS.text) : ''
        this.send('start', undefined, undefined, preview.trim() ? { firstPrompt: preview } : undefined)
        // v2.4: Thread.name (string | null) is the name it already had.
        this.onRename(this.root, threadName(m.result.thread), false)
        this.status(m.result.thread.status)
      }
      if (response && this.renames.has(m.id!)) {
        const name = this.renames.get(m.id!)!
        this.renames.delete(m.id!)
        if (!m.error && this.root) this.onRename(this.root, name, true)
      }
      if (response && this.submissions.has(m.id!)) {
        const ids = this.submissions.get(m.id!)!
        this.submissions.delete(m.id!)
        if (!m.error) for (const id of ids) { this.asyncQuestions.delete(id); this.send('resolved', id) }
      }
      if (!this.root) return
      const p = m.params ?? {}
      if (m.method && REQUESTS[m.method] && m.id !== undefined) {
        // Requests delivered to this TUI can include approval for a child thread.
        const id = `rpc:${String(m.id)}`
        this.requests.add(id)
        this.send('request', id, REQUESTS[m.method])
        return
      }
      if (m.method === 'serverRequest/resolved') {
        const id = `rpc:${String(p.requestId)}`
        if (this.requests.delete(id)) this.send('resolved', id)
        return
      }
      if (p.threadId !== this.root) return
      switch (m.method) {
        case 'turn/started': this.turn = p.turn?.id ?? this.turn; this.active = true; this.reply = ''; this.failure = undefined; this.send('working'); break
        case 'turn/completed': {
          if (this.turn && p.turn?.id && p.turn.id !== this.turn) return
          this.turn = p.turn?.id ?? this.turn
          this.active = false
          const kind = p.turn?.status === 'failed' ? 'error' : p.turn?.status === 'interrupted' ? 'idle' : 'done'
          // The last agentMessage of a completed turn is its reply, like Claude's Stop (E1-FR-08).
          const reply = kind === 'done' && this.reply ? { reply: this.reply, detail: { kind: 'reply' as const, text: firstLine(this.reply, LIMITS.detail) } } : undefined
          // App 2.7.0 (A3): a failed turn says why in turn.error (TurnError); the
          // turn's `error` notification stands in when it is missing or says less.
          const error = p.turn?.error
          const own = kind === 'error' && error && typeof error === 'object' ? codexFailure(error.codexErrorInfo, error.message, Date.now()) : undefined
          const failure = kind !== 'error' ? undefined : own && (own.code || own.kind !== 'unknown' || !this.failure) ? own : this.failure
          this.reply = ''
          this.failure = undefined
          // App 2.7.0 (A3): the turn's tools end with it. done and error clear them in
          // StatusManager; an interrupted turn may never complete its running items, so
          // they close here (a turn with no prompt, like a compaction, would show them).
          if (kind === 'idle') for (const id of this.tools) this.send('resolved', id)
          this.tools.clear()
          this.send(kind, undefined, undefined, failure ? { failure } : reply)
          break
        }
        case 'item/started': {
          const item = p.item
          if (item?.type === 'userMessage') {
            const text = clip(userText(item.content), LIMITS.text)
            if (text.trim()) this.send('working', undefined, undefined, { prompt: text, detail: { kind: 'prompt', text: firstLine(text, LIMITS.detail) } })
            break
          }
          const tool = codexItemTool(item)
          if (!tool || !this.active) break
          // App 2.7.0 (A3): a tool item (the only kind with a tool summary) opens a tool by its id until its item/completed.
          const id = itemId(item)
          if (id) {
            this.tools.add(id)
            if (this.tools.size > OPEN_TOOLS_MAX) this.tools.delete(this.tools.values().next().value!)
          }
          // Its file (a fileChange's first change, an imageView's path) feeds the turn digest.
          const file = fileOfToolInput(item.type, item)
          this.send('working', undefined, undefined, { tool, toolName: item.type, detail: { kind: 'tool', text: tool }, ...(id ? { toolUseId: id } : {}), ...(file ? { toolFile: file } : {}) })
          break
        }
        case 'thread/status/changed': this.status(p.status); break
        // v2.4: ThreadNameUpdatedNotification { threadId, threadName? }. Only a
        // fallback for a recorded set whose answer has not come (never alone).
        case 'thread/name/updated': {
          const name = threadName(p)
          if (name !== undefined && this.renames.size) { this.renames.clear(); this.onRename(this.root, name, true) }
          break
        }
        case 'error':
          // App 2.7.0 (A3): ErrorNotification { error: TurnError, willRetry }; a retried error is no failure yet.
          if (p.willRetry === false) {
            const error = p.error && typeof p.error === 'object' ? p.error : {}
            this.failure = codexFailure(error.codexErrorInfo, error.message, Date.now())
            this.send('error', undefined, undefined, { failure: this.failure })
          }
          break
        case 'thread/closed': this.send('unknown'); break
        // App 2.7.0 (A3): ThreadTokenUsageUpdatedNotification, validated, for the ledger (A4).
        // Outside a running turn (a resume replaying the restored usage) the ledger counts none of it.
        case 'thread/tokenUsage/updated': {
          const usage = codexTokenUsage(p, this.active)
          if (usage) this.onUsage(usage)
          break
        }
        case 'item/completed':
          if (typeof p.item?.type === 'string' && TOOL_ITEMS.has(p.item.type)) {
            // App 2.7.0 (A3): the tool is no longer running (StatusManager drops it from openTools).
            const id = itemId(p.item)
            if (id && this.tools.delete(id)) this.send('resolved', id)
          } else if (p.item?.type === 'agentMessage' && p.item.delivery === 'async' && p.item.questions?.length && typeof p.item.id === 'string') {
            const id = `async:${p.item.id}`
            this.asyncQuestions.add(id)
            this.send('request', id, 'question')
          } else if (p.item?.type === 'agentMessage' && typeof p.item.text === 'string' && p.item.text.trim() && this.active) {
            // Commentary between tools shows as the row detail; the turn's last one becomes its reply.
            this.reply = clip(p.item.text, LIMITS.text)
            this.send('working', undefined, undefined, { detail: { kind: 'reply', text: firstLine(this.reply, LIMITS.detail) } })
          }
          break
      }
    })
  }
  disconnected(): void { if (this.root) this.send('unknown') }
  private status(status: any): void {
    if (status?.type === 'active') this.send('working')
    else if (status?.type === 'systemError') this.send('error')
    else if (status?.type === 'notLoaded') this.send('unknown')
    // idle alone cannot distinguish interrupted from completed turns.
  }
  private send(kind: AgentEvent['kind'], requestId?: string, reason?: AttentionReason, extra?: Pick<AgentEvent, 'detail' | 'tool' | 'toolName' | 'toolUseId' | 'toolFile' | 'prompt' | 'reply' | 'firstPrompt' | 'failure'>): void {
    this.emit({ paneId: this.paneId, ptyId: this.ptyId, provider: 'codex', sessionId: this.root, turnId: this.turn, kind, requestId, reason, ...extra })
  }
  private read(raw: string, apply: (message: Wire) => void): void {
    try { const value = JSON.parse(raw); if (value && typeof value === 'object' && !Array.isArray(value)) apply(value) } catch { /* not a protocol message */ }
  }
}
