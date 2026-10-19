import type { AttentionReason } from '@shared/types'
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

/** First non-empty line of a command, one line, without touching shell syntax. */
function commandLine(command: unknown): string {
  if (typeof command !== 'string') return ''
  for (const line of sanitize(command).split('\n')) {
    const text = line.replace(/\s+/g, ' ').trim()
    if (text) return clip(text, LIMITS.detail)
  }
  return ''
}

/** Text parts of a userMessage item (images, mentions and skills carry no prompt text). */
function userText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n')
}

/**
 * Detail of a Codex item for the agent row (E5-FR-03): commandExecution ->
 * the command (the parsed one when the CLI split a shell wrapper),
 * fileChange -> the file, mcpToolCall -> `mcp srv.tool`. Undefined for items
 * that are not tools.
 */
export function codexItemTool(item: any): string | undefined {
  switch (item?.type) {
    case 'commandExecution': {
      const parsed = Array.isArray(item.commandActions) ? item.commandActions.find((a: any) => typeof a?.command === 'string' && a.command.trim()) : undefined
      return commandLine(parsed?.command ?? item.command) || undefined
    }
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes.filter((c: any) => typeof c?.path === 'string' && c.path) : []
      if (!changes.length) return undefined
      const extra = changes.length > 1 ? ` +${changes.length - 1}` : ''
      return clip(summarizeTool('Edit', { file_path: changes[0].path }) + extra, LIMITS.detail)
    }
    case 'mcpToolCall':
      return typeof item.server === 'string' && typeof item.tool === 'string' ? summarizeTool(`mcp__${item.server}__${item.tool}`, {}) || undefined : undefined
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
  constructor(private paneId: string, private ptyId: string, private emit: (evt: AgentEvent) => void) {}
  client(raw: string): void {
    this.read(raw, m => {
      if (m.id !== undefined && ['thread/start', 'thread/resume', 'thread/fork'].includes(m.method ?? '')) this.starts.add(m.id)
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
        // A resumed thread names its first user message (`preview`): the row title until a prompt arrives.
        const preview = typeof m.result.thread.preview === 'string' ? clip(m.result.thread.preview, LIMITS.text) : ''
        this.send('start', undefined, undefined, preview.trim() ? { firstPrompt: preview } : undefined)
        this.status(m.result.thread.status)
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
        case 'turn/started': this.turn = p.turn?.id ?? this.turn; this.active = true; this.reply = ''; this.send('working'); break
        case 'turn/completed': {
          if (this.turn && p.turn?.id && p.turn.id !== this.turn) return
          this.turn = p.turn?.id ?? this.turn
          this.active = false
          const kind = p.turn?.status === 'failed' ? 'error' : p.turn?.status === 'interrupted' ? 'idle' : 'done'
          // The last agentMessage of a completed turn is its reply, like Claude's Stop (E1-FR-08).
          const reply = kind === 'done' && this.reply ? { reply: this.reply, detail: { kind: 'reply' as const, text: firstLine(this.reply, LIMITS.detail) } } : undefined
          this.reply = ''
          this.send(kind, undefined, undefined, reply)
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
          if (tool && this.active) this.send('working', undefined, undefined, { tool, detail: { kind: 'tool', text: tool } })
          break
        }
        case 'thread/status/changed': this.status(p.status); break
        case 'error': if (p.willRetry === false) this.send('error'); break
        case 'thread/closed': this.send('unknown'); break
        case 'item/completed':
          if (p.item?.type === 'agentMessage' && p.item.delivery === 'async' && p.item.questions?.length && typeof p.item.id === 'string') {
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
  private send(kind: AgentEvent['kind'], requestId?: string, reason?: AttentionReason, extra?: Pick<AgentEvent, 'detail' | 'tool' | 'prompt' | 'reply' | 'firstPrompt'>): void {
    this.emit({ paneId: this.paneId, ptyId: this.ptyId, provider: 'codex', sessionId: this.root, turnId: this.turn, kind, requestId, reason, ...extra })
  }
  private read(raw: string, apply: (message: Wire) => void): void {
    try { const value = JSON.parse(raw); if (value && typeof value === 'object' && !Array.isArray(value)) apply(value) } catch { /* not a protocol message */ }
  }
}
