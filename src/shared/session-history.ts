/**
 * Session history shapes (E3-FR-36..40): what main's SessionHistory index
 * answers on `sessions:list` and what the remote `createPane.resume` checks.
 * Pure types and constants, safe in main, renderer and tests.
 */
import type { AgentProvider } from './types'

/**
 * Session ids the history resumes (E3-FR-39): Claude UUIDs and Codex thread
 * ids. Stricter than agent-argv's SESSION_ID_RE, which every id here also passes.
 */
export const HISTORY_SESSION_ID_RE = /^[0-9a-fA-F-]{8,64}$/

export function isHistorySessionId(id: unknown): id is string {
  return typeof id === 'string' && HISTORY_SESSION_ID_RE.test(id)
}

/** One indexed session (CONTRATOS `sessions:list`). */
export interface SessionSummary {
  provider: AgentProvider
  sessionId: string
  /** Directory the session ran in (absolute). */
  cwd: string
  /** Custom title, else Claude's summary, else the first real prompt cut to 60. */
  title: string
  /** Epoch ms of the last record (the file's mtime without timestamps). */
  updatedAt: number
  /** Last assistant reply or real prompt, <= 280. '' when none. */
  lastMessage: string
  /** Exact count of prompts and replies; null until the background count reaches the file. */
  messageCount: number | null
}

/**
 * `sessions:list` request. `query` matches the title and the last message
 * (case-insensitive) or an exact session id; `cwd` keeps the sessions of
 * that directory (resolved, no trailing separator, case-insensitive on win32).
 */
export interface SessionsListReq {
  query?: string
  cwd?: string
}
