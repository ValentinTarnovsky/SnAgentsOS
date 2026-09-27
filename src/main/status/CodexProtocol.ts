import type { AttentionReason } from '@shared/types'
import type { AgentEvent } from './events'

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

/** Observes the exact JSON-RPC connection used by one TUI. Never answers requests. */
export class CodexProtocol {
  private root = ''
  private turn = ''
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
        this.requests.clear()
        this.asyncQuestions.clear()
        this.send('start')
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
        case 'turn/started': this.turn = p.turn?.id ?? this.turn; this.send('working'); break
        case 'turn/completed':
          if (this.turn && p.turn?.id && p.turn.id !== this.turn) return
          this.turn = p.turn?.id ?? this.turn
          this.send(p.turn?.status === 'failed' ? 'error' : p.turn?.status === 'interrupted' ? 'idle' : 'done')
          break
        case 'thread/status/changed': this.status(p.status); break
        case 'error': if (p.willRetry === false) this.send('error'); break
        case 'thread/closed': this.send('unknown'); break
        case 'item/completed':
          if (p.item?.type === 'agentMessage' && p.item.delivery === 'async' && p.item.questions?.length && typeof p.item.id === 'string') {
            const id = `async:${p.item.id}`
            this.asyncQuestions.add(id)
            this.send('request', id, 'question')
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
  private send(kind: AgentEvent['kind'], requestId?: string, reason?: AttentionReason): void {
    this.emit({ paneId: this.paneId, ptyId: this.ptyId, provider: 'codex', sessionId: this.root, turnId: this.turn, kind, requestId, reason })
  }
  private read(raw: string, apply: (message: Wire) => void): void {
    try { const value = JSON.parse(raw); if (value && typeof value === 'object' && !Array.isArray(value)) apply(value) } catch { /* not a protocol message */ }
  }
}
