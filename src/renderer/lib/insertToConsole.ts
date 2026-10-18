import { focusPane, getFocusedPane } from './focus'
import { getPtyId } from './ptyRegistry'
import { useAppStore } from './store'

/**
 * Write text into the most recently focused console; falls back to the active
 * workspace's first console. No trailing newline, the user reviews and sends.
 * Returns the id of the pane that received it, or null when none could.
 */
export function insertToConsole(text: string): string | null {
  if (!text) return null
  let paneId = getFocusedPane()
  if (!paneId || !getPtyId(paneId)) {
    const s = useAppStore.getState()
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId)
    paneId = ws?.panes[0]?.id ?? null
  }
  if (!paneId) return null
  const ptyId = getPtyId(paneId)
  if (!ptyId) return null
  window.snApi.pty.write({ ptyId, data: text })
  // Refocus the console (after the palette has closed) so the user can keep
  // typing without clicking back in.
  const target = paneId
  requestAnimationFrame(() => focusPane(target))
  return target
}
