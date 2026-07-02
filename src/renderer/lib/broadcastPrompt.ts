import type { Workspace } from '@shared/types'
import { useAppStore } from './store'
import { getPtyId } from './ptyRegistry'

/**
 * Insert the same text into every ACTIVE (non-minimized) console of a workspace
 * that has a live pty. No trailing Enter, the user reviews and runs it in each
 * console (same convention as insertToConsole). Minimized panes and unmounted
 * panes (no pty) are skipped. Returns how many consoles received the text.
 */
export function broadcastToWorkspace(workspace: Workspace, text: string): number {
  if (!text) return 0
  const minimized = useAppStore.getState().minimized[workspace.id] ?? []
  let sent = 0
  for (const pane of workspace.panes) {
    if (minimized.includes(pane.id)) continue
    const ptyId = getPtyId(pane.id)
    if (!ptyId) continue
    window.snApi.pty.write({ ptyId, data: text })
    sent++
  }
  return sent
}
