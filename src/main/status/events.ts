import type { AgentDetail, AgentProvider, AttentionReason, RemotePending } from '@shared/types'
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
  /** Assistant reply (Stop last_assistant_message), <= 2000. */
  reply?: string
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
