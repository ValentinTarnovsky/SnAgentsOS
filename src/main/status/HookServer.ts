import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { timingSafeEqual } from 'crypto'
import type { RemotePending } from '@shared/types'
import { LIMITS, claudeConfigDir, cleanString, extractQuestions, isSafeCwd, isSafeTranscriptPath, summarizeRequest, summarizeTool } from './statusDetails'

/** One Claude Code hook event, already attributed to a console. */
export interface HookEvent {
  /** SNAOS_CONSOLE_ID forwarded by the hook (the paneId). */
  consoleId: string
  /** hook_event_name: UserPromptSubmit | Stop | StopFailure | Notification | SessionStart | SessionEnd */
  name: string
  /** Notification only: permission_prompt | idle_prompt | elicitation_dialog | ... */
  notificationType?: string
  sessionId?: string
  ptyId?: string
  toolName?: string
  toolUseId?: string
  elicitationId?: string
  agentId?: string
  // Enrichment (E5-FR-01, E4-FR-09). Bounded and sanitized here; the raw
  // payload (tool_input included) is dropped with the request.
  /** json.cwd, only when absolute and an existing directory. */
  cwd?: string
  /** json.transcript_path, only when isSafeTranscriptPath(p, session_id). */
  transcriptPath?: string
  /** UserPromptSubmit json.prompt, <= 2000. */
  prompt?: string
  /** Stop json.last_assistant_message, <= 2000. */
  lastAssistantMessage?: string
  /** SessionEnd json.reason ('clear' | 'logout' | 'prompt_input_exit' | 'other' | ...). */
  endReason?: string
  /** summarizeTool(tool_name, tool_input), <= 160. */
  toolSummary?: string
  /** summarizeRequest(tool_name, tool_input) for pending cards, <= 200. */
  requestSummary?: string
  /** AskUserQuestion tool_input.questions[0].question, <= 300. */
  question?: string
  /** AskUserQuestion questions in the RemotePending shape. */
  questions?: RemotePending['questions']
  /**
   * A sub-session: a `claude -p` the console's own agent started (a driver),
   * marked by the X-Agent-Child / X-Agent-Parent headers. Never the console's agent.
   */
  nested?: boolean
  /** SessionStart json.source ('startup' | 'resume' | 'clear' | 'compact' | 'fork'). */
  source?: string
  /** Stop json.background_tasks still running, by what the stop means for the console. */
  background?: BackgroundTasks
}

/**
 * Work a turn left running when it stopped (Stop `background_tasks`). `waits`:
 * tasks that come back to the agent (subagents, workflows, teammates, a
 * `snaos wait` or a driver), so the agent is not done; `other`: the rest
 * (a dev server, a monitor), which never hold the console.
 */
export interface BackgroundTasks {
  waits: number
  other: number
}

/** A shell task that waits on other consoles or drives sub-sessions. */
const WAITING_SHELL_RE = /\bsnaos(?:\.cmd)?\s+wait\b|\bclaude(?:\.exe)?\s+(?:.*\s)?(?:-p|--print)\b|\bcodex(?:\.exe)?\s+exec\b|\bsn-drive\b/i
const PARENT_RE = /^(?:claude|codex):[A-Za-z0-9_-]{1,64}$/

/** Classifies Stop `background_tasks` (an array of { type, status, description }). Undefined when none run. */
export function backgroundTasks(raw: unknown): BackgroundTasks | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: BackgroundTasks = { waits: 0, other: 0 }
  for (const task of raw.slice(0, 64)) {
    if (!task || typeof task !== 'object') continue
    const { type, status, description, command } = task as Record<string, unknown>
    if (typeof status === 'string' && /^(?:completed|failed|killed|stopped|cancell?ed|done)$/i.test(status)) continue
    const kind = typeof type === 'string' ? type.toLowerCase() : ''
    const text = [description, command].filter((v): v is string => typeof v === 'string').join(' ').slice(0, 2000)
    if (/agent|teammate|workflow|cloud|remote/.test(kind)) out.waits++
    else if (/bash|shell/.test(kind) && WAITING_SHELL_RE.test(text)) out.waits++
    else out.other++
  }
  return out.waits || out.other ? out : undefined
}

/** True when the request headers mark a sub-session (see HookEvent.nested). */
export function nestedFromHeaders(child: unknown, parent: unknown): boolean {
  return String(child ?? '').trim() === '1' || PARENT_RE.test(String(parent ?? '').trim())
}

const MAX_BODY = 2 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 3000

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/**
 * Loopback-only listener for Claude Code hook POSTs. Claude Code is configured
 * (by HookInstaller) with `type: "http"` hooks pointing at
 * `http://127.0.0.1:<port>/cc-hook/<token>` plus an X-Console-Id header
 * interpolated from the SNAOS_CONSOLE_ID env var each pty injects.
 *
 * Contract with Claude Code: ALWAYS answer 200 with an empty body. A non-empty
 * body could be parsed as a hook decision and a non-2xx would surface as a
 * hook error inside the user's session, so even malformed requests get 200.
 *
 * Deliberately separate from RemoteServer: that one is LAN-facing and keeps a
 * "no REST endpoints" invariant; this one never leaves 127.0.0.1.
 */
export class HookServer {
  private server: Server | null = null
  private token = ''
  private port = 0
  private listener: ((evt: HookEvent) => void) | null = null

  /** Port actually bound (configured port, or +1 when it was taken). */
  get activePort(): number {
    return this.port
  }

  get running(): boolean {
    return this.server !== null
  }

  onEvent(cb: (evt: HookEvent) => void): void {
    this.listener = cb
  }

  /** Starts listening on 127.0.0.1; falls back to port+1 once if taken. */
  async start(port: number, token: string): Promise<number> {
    await this.stop()
    this.token = token
    this.port = await this.listen(port).catch(() => this.listen(port < 65535 ? port + 1 : 0))
    return this.port
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.port = 0
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private listen(port: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const server = createServer((req, res) => this.handle(req, res))
      server.on('error', (err) => {
        if (this.server === server) this.server = null
        reject(err)
      })
      server.requestTimeout = REQUEST_TIMEOUT_MS
      server.listen(port, '127.0.0.1', () => {
        this.server = server
        const address = server.address()
        resolve(typeof address === 'object' && address ? address.port : port)
      })
    })
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? ''
    const match = /^\/cc-hook\/([^/?]+)$/.exec(url)
    if (req.method !== 'POST' || !match || !this.token || !safeEqual(match[1], this.token)) {
      res.statusCode = 404
      res.end()
      return
    }

    const chunks: Buffer[] = []
    let bytes = 0
    let overflow = false
    req.on('data', (chunk: Buffer) => {
      if (overflow) return
      bytes += chunk.length
      if (bytes > MAX_BODY) overflow = true
      else chunks.push(chunk)
    })
    req.on('error', () => {
      res.statusCode = 200
      res.end()
    })
    req.on('end', () => {
      // Always 200 + empty body (see class comment).
      res.statusCode = 200
      res.end()
      if (overflow) return
      const consoleId = String(req.headers['x-console-id'] ?? '').trim()
      // Empty id => a claude launched outside the app; not ours to track.
      if (!consoleId) return
      try {
        const json = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        const name = typeof json.hook_event_name === 'string' ? json.hook_event_name : ''
        if (!name) return
        const evt = parseHookPayload(consoleId, String(req.headers['x-pty-id'] ?? ''), name, json)
        if (nestedFromHeaders(req.headers['x-agent-child'], req.headers['x-agent-parent'])) evt.nested = true
        this.listener?.(evt)
      } catch {
        console.warn('[hooks] discarded malformed hook payload')
      }
    })
  }
}

/**
 * Builds a HookEvent from an already parsed payload (E5-FR-01). Invalid
 * optional fields are dropped silently and the event is still delivered.
 * Never logs: prompts, replies and tool inputs are user content.
 */
export function parseHookPayload(consoleId: string, ptyId: string, name: string, json: Record<string, unknown>, claudeDir = claudeConfigDir()): HookEvent {
  const sessionId = typeof json.session_id === 'string' ? json.session_id : undefined
  const toolName = typeof json.tool_name === 'string' ? json.tool_name : undefined
  const evt: HookEvent = {
    consoleId,
    name,
    notificationType: typeof json.notification_type === 'string' ? json.notification_type : undefined,
    sessionId,
    ptyId,
    toolName,
    toolUseId: typeof json.tool_use_id === 'string' ? json.tool_use_id : undefined,
    elicitationId: typeof json.elicitation_id === 'string' ? json.elicitation_id : undefined,
    agentId: typeof json.agent_id === 'string' ? json.agent_id : undefined,
  }
  if (isSafeCwd(json.cwd)) evt.cwd = json.cwd
  if (sessionId && isSafeTranscriptPath(json.transcript_path, sessionId, claudeDir)) evt.transcriptPath = json.transcript_path
  if (name === 'UserPromptSubmit') evt.prompt = cleanString(json.prompt, LIMITS.text)
  if (name === 'Stop') {
    evt.lastAssistantMessage = cleanString(json.last_assistant_message, LIMITS.text)
    evt.background = backgroundTasks(json.background_tasks)
  }
  if (name === 'SessionEnd') evt.endReason = cleanString(json.reason, 64, true)
  if (name === 'SessionStart') evt.source = cleanString(json.source, 32, true)
  if ((name === 'PreToolUse' || name === 'PermissionRequest') && toolName) {
    evt.toolSummary = summarizeTool(toolName, json.tool_input) || undefined
    evt.requestSummary = summarizeRequest(toolName, json.tool_input) || undefined
    if (toolName === 'AskUserQuestion') {
      evt.questions = extractQuestions(json.tool_input)
      evt.question = evt.questions?.[0]?.question
    }
  }
  return evt
}
