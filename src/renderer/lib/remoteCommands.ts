import type { RemoteCommand } from '@shared/ipc-contract'
import type { RemoteCtlAction } from '@shared/remote-protocol'
import { useAppStore } from './store'
import { killPanePtys } from './ptyRegistry'
import { broadcastToWorkspace } from './broadcastPrompt'
import { restartFresh, restartFromButton, restartResume } from './agentLaunch'
import { toast } from './toast'
import { translate } from '@/i18n'
import type { Language } from '@shared/types'

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
      // Through closePane so the desktop can reopen it (E5-FR-14).
      store.closePane(action.workspaceId, action.paneId)
      return { ok: true }
    }

    case 'restartPane': {
      const ws = store.workspaces.find((w) => w.id === action.workspaceId)
      if (!ws || !ws.panes.some((p) => p.id === action.paneId)) {
        return { ok: false, error: 'not_found' }
      }
      // E5-FR-11: true resumes (falls back to a new chat with the chip when the
      // record is gone), false forgets the session, absent = the header button.
      if (action.resume === true) restartResume(action.paneId)
      else if (action.resume === false) restartFresh(action.paneId)
      else restartFromButton(action.paneId)
      return { ok: true }
    }

    case 'globalPrompt': {
      const ws = store.workspaces.find((w) => w.id === action.workspaceId)
      if (!ws) return { ok: false, error: 'not_found' }
      const count = broadcastToWorkspace(ws, action.text)
      return { ok: true, info: count }
    }

    case 'setTheme': {
      store.updateSettings({ theme: action.theme })
      return { ok: true }
    }

    case 'renamePane': {
      const ws = store.workspaces.find((w) => w.id === action.workspaceId)
      if (!ws || !ws.panes.some((p) => p.id === action.paneId)) {
        return { ok: false, error: 'not_found' }
      }
      store.renamePane(action.workspaceId, action.paneId, action.title)
      return { ok: true }
    }

    default:
      return { ok: false, error: 'unknown_action' }
  }
}

/**
 * Text of the info toast for a phone action that changed the desktop
 * (E4-FR-08): globalPrompt, restartPane and closePane. `deviceName` is the one
 * main resolved from the authenticated session; without it the text says
 * "from the phone". Null for every other action or a failed one.
 */
export function remoteNoticeText(
  action: RemoteCtlAction,
  result: CmdResult,
  deviceName: string | undefined,
  paneTitle: string | undefined,
  lang: Language,
): string | null {
  if (!result.ok) return null
  let what: string
  if (action.kind === 'globalPrompt') {
    const count = result.info ?? 0
    what = translate(lang, count === 1 ? 'toast.remote.promptOne' : count === 0 ? 'toast.remote.promptNone' : 'toast.remote.promptMany', { count })
  } else if (action.kind === 'restartPane') {
    what = translate(lang, 'toast.remote.restarted', { pane: paneTitle ?? '' })
  } else if (action.kind === 'closePane') {
    what = translate(lang, 'toast.remote.closed', { pane: paneTitle ?? '' })
  } else return null
  const name = deviceName?.trim()
  return name ? translate(lang, 'toast.remote.fromDevice', { device: name, what }) : translate(lang, 'toast.remote.fromPhone', { what })
}

/** Title of the pane an action targets, read before it runs (closePane removes it). */
function targetTitle(action: RemoteCtlAction): string | undefined {
  if (action.kind !== 'restartPane' && action.kind !== 'closePane') return undefined
  const ws = useAppStore.getState().workspaces.find((w) => w.id === action.workspaceId)
  return ws?.panes.find((p) => p.id === action.paneId)?.title
}

let wired = false

/** Wire the main->renderer control-command stream to the store actions (idempotent). */
export function initRemoteCommands(): () => void {
  if (wired) return () => undefined
  wired = true
  const off = window.snApi.remote.onCommand((cmd: RemoteCommand) => {
    let result: CmdResult
    const title = targetTitle(cmd.action)
    try {
      result = run(cmd.action)
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : 'error' }
    }
    window.snApi.remote.commandResult({ id: cmd.id, ...result })
    const notice = remoteNoticeText(cmd.action, result, cmd.deviceName, title, useAppStore.getState().settings.language)
    if (notice) toast.info(notice)
  })
  return () => {
    wired = false
    off()
  }
}
