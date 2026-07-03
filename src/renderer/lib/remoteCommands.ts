import type { RemoteCommand } from '@shared/ipc-contract'
import type { RemoteCtlAction } from '@shared/remote-protocol'
import { useAppStore } from './store'
import { killPanePtys } from './ptyRegistry'
import { broadcastToWorkspace } from './broadcastPrompt'

interface CmdResult {
  ok: boolean
  error?: string
  /** createPane: id of the freshly created pane. */
  paneId?: string
  /** globalPrompt: number of consoles the text was inserted into. */
  info?: number
}

/**
 * Execute a phone control action through the existing store actions. Ids are
 * validated first so a stale phone view can't act on a deleted workspace/pane.
 */
function run(action: RemoteCtlAction): CmdResult {
  const store = useAppStore.getState()

  switch (action.kind) {
    case 'switchWorkspace': {
      const ws = store.workspaces.find((w) => w.id === action.workspaceId)
      if (!ws) return { ok: false, error: 'not_found' }
      store.setActive(action.workspaceId)
      return { ok: true }
    }

    case 'createPane': {
      const ws = store.workspaces.find((w) => w.id === action.workspaceId)
      if (!ws) return { ok: false, error: 'not_found' }
      const before = new Set(ws.panes.map((p) => p.id))
      const preset = action.presetId
        ? store.presets.find((p) => p.id === action.presetId)
        : undefined
      if (preset) {
        store.addPane(action.workspaceId, {
          type: preset.type,
          presetId: preset.id,
          title: preset.name,
          color: preset.color,
          icon: preset.icon,
        })
      } else if (action.paneType) {
        store.addPane(action.workspaceId, { type: action.paneType })
      } else {
        store.addPane(action.workspaceId)
      }
      // addPane is synchronous; diff the panes to recover the new id.
      const after = useAppStore.getState().workspaces.find((w) => w.id === action.workspaceId)
      const created = after?.panes.find((p) => !before.has(p.id))
      return { ok: true, paneId: created?.id }
    }

    case 'closePane': {
      const ws = store.workspaces.find((w) => w.id === action.workspaceId)
      if (!ws || !ws.panes.some((p) => p.id === action.paneId)) {
        return { ok: false, error: 'not_found' }
      }
      killPanePtys([action.paneId])
      store.removePane(action.workspaceId, action.paneId)
      return { ok: true }
    }

    case 'restartPane': {
      const ws = store.workspaces.find((w) => w.id === action.workspaceId)
      if (!ws || !ws.panes.some((p) => p.id === action.paneId)) {
        return { ok: false, error: 'not_found' }
      }
      store.restartPane(action.paneId)
      return { ok: true }
    }

    case 'globalPrompt': {
      const ws = store.workspaces.find((w) => w.id === action.workspaceId)
      if (!ws) return { ok: false, error: 'not_found' }
      const count = broadcastToWorkspace(ws, action.text)
      return { ok: true, info: count }
    }

    default:
      return { ok: false, error: 'unknown_action' }
  }
}

let wired = false

/** Wire the main->renderer control-command stream to the store actions (idempotent). */
export function initRemoteCommands(): () => void {
  if (wired) return () => undefined
  wired = true
  const off = window.snApi.remote.onCommand((cmd: RemoteCommand) => {
    let result: CmdResult
    try {
      result = run(cmd.action)
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : 'error' }
    }
    window.snApi.remote.commandResult({ id: cmd.id, ...result })
  })
  return () => {
    wired = false
    off()
  }
}
