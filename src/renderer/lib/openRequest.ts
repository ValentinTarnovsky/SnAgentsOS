import type { Workspace } from '@shared/types'
import type { OpenRequest } from '@shared/ipc-contract'
import { normalizeOpenPath } from '@shared/openPath'
import { translate } from '@/i18n'
import { useAppStore } from './store'
import { sidebarOrder } from './sidebarOrder'
import { focusWorkspaceConsole } from './focusWorkspace'
import { toast } from './toast'

/**
 * "Open in SnAgentsOS" on the renderer side (E4-FR-33). main already validated
 * the folder; here it is matched against the workspaces and dispatched: an
 * existing workspace is activated and focused, otherwise the new-workspace
 * wizard opens prefilled (cwd + basename, focus on Next). Requests only run
 * after hydrate; one that arrives earlier waits in main (takePendingOpen).
 */

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

/**
 * Workspace for a folder, or null. Same normalized cwd; workspaces without a
 * connection profile (`setupId`) win, then the active one, then sidebar order.
 */
export function pickOpenWorkspace(
  workspaces: readonly Workspace[],
  activeId: string | null,
  path: string,
): Workspace | null {
  const key = normalizeOpenPath(path)
  if (!key) return null
  const same = sidebarOrder(workspaces).filter((w) => normalizeOpenPath(w.cwd) === key)
  if (same.length === 0) return null
  const local = same.filter((w) => !w.setupId)
  const pool = local.length > 0 ? local : same
  return pool.find((w) => w.id === activeId) ?? pool[0]
}

// The wizard's live folder (the draft, not only the prefill): a request for
// another folder never overwrites a workspace being created.
let wizardDraftCwd = ''
export function setWizardDraftCwd(cwd: string | null): void {
  wizardDraftCwd = cwd ?? ''
}

const HANDLED_KEY = 'snagentsos.openHandled'
const HANDLED_MAX = 20
const handled = new Set<string>()

/** Ids already dispatched, kept across a reload (sessionStorage) so a request never runs twice. */
function alreadyHandled(id: string): boolean {
  if (handled.has(id)) return true
  try {
    const list = JSON.parse(sessionStorage.getItem(HANDLED_KEY) ?? '[]') as unknown
    if (Array.isArray(list) && list.includes(id)) {
      handled.add(id)
      return true
    }
  } catch {
    /* storage unavailable: the in-memory set still dedupes this run */
  }
  return false
}

function rememberHandled(id: string): void {
  handled.add(id)
  try {
    const list = JSON.parse(sessionStorage.getItem(HANDLED_KEY) ?? '[]') as unknown
    const next = [...(Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []), id].slice(-HANDLED_MAX)
    sessionStorage.setItem(HANDLED_KEY, JSON.stringify(next))
  } catch {
    /* ignore */
  }
}

export type OpenOutcome = 'activated' | 'wizard' | 'busy' | 'duplicate' | 'ignored'

function isOpenRequest(v: unknown): v is OpenRequest {
  const r = v as OpenRequest | null
  return !!r && typeof r.id === 'string' && typeof r.path === 'string' && r.path.length > 0
}

export function dispatchOpenRequest(req: unknown): OpenOutcome {
  if (!isOpenRequest(req)) return 'ignored'
  if (alreadyHandled(req.id)) return 'duplicate'
  const s = useAppStore.getState()
  if (!s.hydrated) return 'ignored'
  rememberHandled(req.id)
  const ws = pickOpenWorkspace(s.workspaces, s.activeWorkspaceId, req.path)
  if (ws) {
    // Overlays would hide the workspace that just came forward.
    if (s.paletteOpen) s.setPaletteOpen(false)
    if (s.settingsOpen) s.setSettingsOpen(false)
    s.ensureMounted(ws.id)
    if (s.activeWorkspaceId !== ws.id) s.setActive(ws.id)
    focusWorkspaceConsole(ws.id)
    return 'activated'
  }
  if (s.wizardOpen && wizardDraftCwd.trim()) {
    if (normalizeOpenPath(wizardDraftCwd) === normalizeOpenPath(req.path)) return 'wizard'
    toast.info(translate(s.settings.language, 'open.wizardBusy', { folder: basename(req.path) }), {
      dedupeKey: 'open:wizardBusy',
    })
    return 'busy'
  }
  if (s.paletteOpen) s.setPaletteOpen(false)
  if (s.settingsOpen) s.setSettingsOpen(false)
  s.setWizardOpen(true, { cwd: req.path, name: basename(req.path) })
  return 'wizard'
}

/**
 * Starts listening (call once hydrated): takes what main is holding and
 * handles every later push. A push is followed by a take so main drops the
 * request it keeps; the id dedupe makes that second sight a no-op.
 */
export function initOpenRequests(): () => void {
  const api = window.snApi?.app
  if (!api) return () => undefined
  const take = (): void => {
    void Promise.resolve()
      .then(() => api.takePendingOpen())
      .then((req) => {
        if (req) dispatchOpenRequest(req)
      })
      .catch(() => undefined)
  }
  let unsub: (() => void) | undefined
  try {
    unsub = api.onOpenPath((req) => {
      dispatchOpenRequest(req)
      take()
    })
  } catch {
    unsub = undefined
  }
  take()
  return () => unsub?.()
}
