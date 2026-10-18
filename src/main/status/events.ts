import type { AgentDetail, AgentProvider, AttentionReason, ConfigFile, RemotePending } from '@shared/types'
export interface AgentEvent {
  paneId: string
  ptyId: string
  provider: AgentProvider
  sessionId: string
  kind: 'start' | 'working' | 'request' | 'resolved' | 'done' | 'error' | 'idle' | 'end' | 'unknown'
  turnId?: string
  requestId?: string
  reason?: AttentionReason
  // Enrichment (E4-FR-09, E5-FR-01). All optional and already bounded by the
  // producer; prompts and replies live in memory only and are never logged.
  /** Absolute existing directory the agent reported. */
  cwd?: string
  /** Claude transcript, only after isSafeTranscriptPath. Main only. */
  transcriptPath?: string
  /** UserPromptSubmit text, <= 2000. */
  prompt?: string
  /** Assistant reply (Stop last_assistant_message, Codex last agentMessage of the turn), <= 2000. */
  reply?: string
  /** First user message of a resumed thread (Codex `thread.preview`), <= 2000; never a last prompt. */
  firstPrompt?: string
  /** SessionEnd reason as sent by Claude ('prompt_input_exit', 'other', 'clear', ...). */
  endReason?: string
  /** Replaces the pane detail when set. */
  detail?: AgentDetail
  /** Current tool summary (activity), <= 160. */
  tool?: string
  toolName?: string
  /** Pending card summary, <= 200. */
  summary?: string
  questions?: RemotePending['questions']
  /** Event of a subagent: never changes the main detail. */
  subagent?: boolean
}
export interface StatusNotice {
  paneId: string
  provider: AgentProvider
  state: 'action' | 'done' | 'error'
  reason?: AttentionReason
}

/**
 * The words every remote channel (Discord, ntfy) sends for a notice: agent
 * name, reason in the config language, "workspace / console" and the
 * workspace id the deep link needs. Never any text of the agent's reply.
 */
export interface NoticeText {
  agent: 'Claude' | 'Codex'
  message: string
  /** "workspace / console", or the product name when the pane is unknown. */
  place: string
  workspaceId: string | null
}

export function describeNotice(notice: StatusNotice, config: ConfigFile | null, fallbackPlace: string): NoticeText {
  const es = config?.settings.language === 'es'
  let place = fallbackPlace
  let workspaceId: string | null = null
  for (const ws of config?.workspaces ?? []) {
    const pane = ws.panes.find(p => p.id === notice.paneId)
    if (pane) { place = `${ws.name} / ${pane.title}`; workspaceId = ws.id; break }
  }
  const reasons = es
    ? { permission: 'Permiso pendiente', question: 'Pregunta pendiente', plan: 'Plan para aprobar', elicitation: 'Respuesta MCP pendiente', failure: 'El agente se detuvo por un error' }
    : { permission: 'Permission requested', question: 'Question pending', plan: 'Plan approval requested', elicitation: 'MCP response requested', failure: 'Agent stopped with an error' }
  const message = notice.state === 'done' ? (es ? 'Turno terminado' : 'Turn complete') : reasons[notice.reason ?? (notice.state === 'error' ? 'failure' : 'question')]
  return { agent: notice.provider === 'codex' ? 'Codex' : 'Claude', message, place, workspaceId }
}
