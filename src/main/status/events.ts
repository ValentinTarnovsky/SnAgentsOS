import type { AgentProvider, AttentionReason } from '@shared/types'
export interface AgentEvent {
  paneId: string
  ptyId: string
  provider: AgentProvider
  sessionId: string
  kind: 'start' | 'working' | 'request' | 'resolved' | 'done' | 'error' | 'idle' | 'end' | 'unknown'
  turnId?: string
  requestId?: string
  reason?: AttentionReason
}
export interface StatusNotice {
  paneId: string
  provider: AgentProvider
  state: 'action' | 'done' | 'error'
  reason?: AttentionReason
}
