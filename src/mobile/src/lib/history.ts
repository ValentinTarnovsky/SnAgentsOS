/**
 * Session history on the phone (E3-FR-36..39): which workspace the History
 * screen was opened from, and the small pure helpers its cards and its
 * resume flow use. The requests themselves go through client.ts
 * (requestHistory / sendCtl), pending by id with the 10s timeout of E3-FR-04.
 */
import { create } from 'zustand'
import type { RemoteHistorySession, RemoteStateSnapshot } from '@shared/remote-protocol'
import { relativeAge } from './statusText'
import { paneById } from './workspace'
import { t } from './i18n'

/** E3-FR-36: the search waits this long after the last keystroke. */
export const HISTORY_DEBOUNCE_MS = 250

export type HistoryTab = 'workspace' | 'all'

interface HistoryState {
  /** The workspace History was opened from (its tab, and where a resume opens); null = closed. */
  workspaceId: string | null
  update: (patch: Partial<Pick<HistoryState, 'workspaceId'>>) => void
}

export const useHistoryStore = create<HistoryState>((set) => ({
  workspaceId: null,
  update: (patch) => set(patch),
}))

/** Open History for a workspace (Home's workspace menu, the terminal's kebab). */
export function openHistory(workspaceId: string): void {
  useHistoryStore.getState().update({ workspaceId })
}

export function closeHistory(): void {
  useHistoryStore.getState().update({ workspaceId: null })
}

/** The historyReq fields for a tab and a search box value (E3-FR-36). */
export function historyRequest(tab: HistoryTab, query: string, workspaceId: string): { query?: string; workspaceId?: string } {
  const q = query.trim().slice(0, 200)
  return { ...(q ? { query: q } : {}), ...(tab === 'workspace' ? { workspaceId } : {}) }
}

/** Last segment of a directory, Windows or POSIX (E3-FR-37 "folder"). */
export function folderName(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, '')
  const last = trimmed.split(/[\\/]/).pop() ?? ''
  return last || cwd
}

/** "3h ago" / "hace 3h" from a session's last activity (E3-FR-37). */
export function historyAgo(updatedAt: number, now: number): string {
  const age = relativeAge(updatedAt, now)
  return age === t('status.now') ? age : t('history.ago', { age })
}

/**
 * The console a card leads to when the desktop says the session is already
 * open (E3-FR-38) and the phone still lists that console; else null (the
 * sheet offers "Resume in a new console").
 */
export function openPaneOf(snap: RemoteStateSnapshot | null, session: Pick<RemoteHistorySession, 'paneId'>): string | null {
  if (!snap || !session.paneId) return null
  return paneById(snap, session.paneId) ? session.paneId : null
}
