import { ipcMain } from 'electron'
import { CH } from '@shared/ipc-channels'
import type { SessionSummary, SessionsListReq } from '@shared/session-history'
import type { SessionHistory } from '../history/SessionHistory'

/** Bounds of a `sessions:list` request (a query is a search box, a cwd a path). */
const QUERY_MAX = 200
const CWD_MAX = 4096

/** Keeps only well-formed string fields of a renderer request. */
export function sanitizeSessionsListReq(raw: unknown): SessionsListReq {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const out: SessionsListReq = {}
  if (typeof r.query === 'string' && r.query.length <= QUERY_MAX) out.query = r.query
  if (typeof r.cwd === 'string' && r.cwd.length <= CWD_MAX) out.cwd = r.cwd
  return out
}

/**
 * `sessions:list` (E3-FR-36..40): the history index for the renderer. The
 * remote createPane.resume executor resolves a session's cwd through it, so
 * the phone never sends one.
 */
export function registerHistoryIpc(history: SessionHistory): void {
  ipcMain.handle(CH.SESSIONS_LIST, (_e, req: unknown): Promise<SessionSummary[]> => history.list(sanitizeSessionsListReq(req)).catch(() => []))
}
