import { buildDropPayload, type DropMode } from './dropPaths'
import { focusPane, getFocusedPane } from './focus'
import { getPtyId } from './ptyRegistry'
import { isBracketedPaste, pasteToPane } from './pasteRegistry'
import { isAgentPane } from './agentPane'
import { useAppStore } from './store'

/**
 * "Insert path in the focused console" of the Changes panel (E7-FR-15): the
 * same target the old snippet insert used (the last focused console, else the active
 * workspace's first one) and the same format as dropping the file on it
 * (E7-FR-02): agent and bracketed-paste consoles get `term.paste`, a plain
 * one the 1.14.1 quoted write. Never an Enter. Returns the pane id, or null.
 */
export function insertPathToConsole(absPath: string): string | null {
  const s = useAppStore.getState()
  let paneId = getFocusedPane()
  if (!paneId || !getPtyId(paneId)) {
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId)
    paneId = ws?.panes[0]?.id ?? null
  }
  if (!paneId) return null
  const ptyId = getPtyId(paneId)
  const pane = s.workspaces.flatMap((w) => w.panes).find((p) => p.id === paneId)
  const bracketed = isBracketedPaste(paneId)
  if (!ptyId || !pane || bracketed === null) return null
  const mode: DropMode = !bracketed ? 'plain' : isAgentPane(pane, s.paneStatus[paneId], bracketed) ? 'agent' : 'safe'
  const payload = buildDropPayload([absPath], mode)
  if (!payload) return null
  if (payload.kind === 'paste') {
    for (const part of payload.parts) if (!pasteToPane(paneId, part)) return null
  } else {
    window.snApi.pty.write({ ptyId, data: payload.text })
  }
  const target = paneId
  requestAnimationFrame(() => focusPane(target))
  return target
}
