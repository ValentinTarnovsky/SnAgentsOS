import type { RemoteCtlAction } from '@shared/remote-protocol'
import { useAppStore } from './store'

type OpenPathAction = Extract<RemoteCtlAction, { kind: 'openPath' }>
type OpenUrlAction = Extract<RemoteCtlAction, { kind: 'openUrl' }>

export interface OpenCmdResult {
  ok: boolean
  error?: string
}

/**
 * Root a pane's relative paths resolve against: its launch cwd with the same
 * precedence as launch.ts (pane, then preset, then workspace). '' when all
 * three are empty, which main treats as the home folder like PtyManager.
 */
export function resolvePaneRoot(workspaceId: string, paneId: string): string | null {
  const st = useAppStore.getState()
  const ws = st.workspaces.find((w) => w.id === workspaceId)
  const pane = ws?.panes.find((p) => p.id === paneId)
  if (!ws || !pane) return null
  const preset = pane.presetId ? st.presets.find((p) => p.id === pane.presetId) : undefined
  return pane.cwd ?? preset?.defaultCwd ?? ws.cwd ?? ''
}

/**
 * ctl `openPath` (E2-FR-30). The roots come from this store, never from the
 * phone. A pane or workspace behind a Connection Profile (SSH) runs on another
 * machine, so its paths mean nothing here: denied_path without calling main.
 * A denied_path under the pane root is retried once under `ws.cwd` when that
 * root differs. main's error is copied to the ack.
 */
export async function runOpenPath(action: OpenPathAction): Promise<OpenCmdResult> {
  const st = useAppStore.getState()
  const ws = st.workspaces.find((w) => w.id === action.workspaceId)
  const pane = ws?.panes.find((p) => p.id === action.paneId)
  if (!ws || !pane) return { ok: false, error: 'not_found' }
  if (pane.setupId || ws.setupId) return { ok: false, error: 'denied_path' }
  const paneRoot = resolvePaneRoot(action.workspaceId, action.paneId) ?? ''
  let res = await window.snApi.system.openPath({ cwd: paneRoot, path: action.path })
  const wsRoot = ws.cwd ?? ''
  if (!res.ok && res.error === 'denied_path' && wsRoot !== paneRoot) {
    res = await window.snApi.system.openPath({ cwd: wsRoot, path: action.path })
  }
  return res.ok ? { ok: true } : { ok: false, error: res.error ?? 'error' }
}

/** ctl `openUrl` (E2-FR-28): http(s) only; main filters again in openExternalSafe. */
export function runOpenUrl(action: OpenUrlAction): OpenCmdResult {
  let url: URL
  try {
    url = new URL(action.url)
  } catch {
    return { ok: false, error: 'bad_request' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: 'bad_request' }
  window.snApi.system.openExternal(url.href)
  return { ok: true }
}
