/**
 * Running Quick Commands (E8-FR-05 desktop, E8-FR-07 phone). Every text goes
 * through the shared delivery path (pty.submit, E8-FR-02a) and every agent
 * prompt through the pane's pending prompt (E8-FR-02b), so the popover, the
 * palette and the phone behave the same.
 */
import type { QuickCommand } from '@shared/types'
import type { RemoteCtlAction } from '@shared/remote-protocol'
import { translate, type MessageKey } from '@/i18n'
import { useAppStore, type AppState } from './store'
import { focusPane, focusPaneWhenReady, getFocusedPane } from './focus'
import { getPtyId } from './ptyRegistry'
import { toast } from './toast'

export type QuickRunError = 'no_console' | 'no_workspace' | 'no_preset' | 'multiline_unsafe' | 'not_running' | 'not_found' | 'bad_request'
export type QuickRunResult = { ok: true; paneId?: string } | { ok: false; error: QuickRunError }

function tr(key: MessageKey, params?: Record<string, string | number>): string {
  return translate(useAppStore.getState().settings.language, key, params)
}

/**
 * Where a desktop `send` goes: the focused console of the active workspace
 * when its pty is live, else the first console with a live pty in that
 * workspace's grid order, else null.
 */
export function sendTarget(s: Pick<AppState, 'workspaces' | 'activeWorkspaceId'>): string | null {
  const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId)
  if (!ws) return null
  const focused = getFocusedPane()
  if (focused && ws.panes.some((p) => p.id === focused) && getPtyId(focused)) return focused
  const order = ws.layout?.order ?? ws.panes.map((p) => p.id)
  const ids = [...order.filter((id) => ws.panes.some((p) => p.id === id)), ...ws.panes.map((p) => p.id).filter((id) => !order.includes(id))]
  return ids.find((id) => !!getPtyId(id)) ?? null
}

/**
 * Adds an agent console with the command's preset to `workspaceId` and queues
 * the prompt for its first spawn. Null when the preset no longer exists.
 */
function createAgentPane(cmd: QuickCommand, workspaceId: string): { paneId: string; presetName: string } | null {
  const s = useAppStore.getState()
  const preset = cmd.presetId ? s.presets.find((p) => p.id === cmd.presetId) : undefined
  if (!preset) return null
  const paneId = s.addPane(workspaceId, { type: preset.type, presetId: preset.id, title: preset.name, color: preset.color, icon: preset.icon })
  if (!paneId) return null
  s.setPendingPrompt(paneId, { text: cmd.text, enter: true, source: 'quick', createdAt: Date.now() })
  return { paneId, presetName: preset.name }
}

/** Open the Quick Commands editor on `id` (a command whose preset was deleted). */
export function editQuickCommand(id: string): void {
  const s = useAppStore.getState()
  s.setQuickEdit({ id })
  s.openSettings('quick')
}

/** Open the editor on a new command scoped to `workspaceId` (the popover's "Create"). */
export function createQuickCommand(workspaceId: string | null): void {
  const s = useAppStore.getState()
  s.setQuickEdit({ newScope: workspaceId })
  s.openSettings('quick')
}

/**
 * Desktop run (E8-FR-05), from the popover and the palette. `send` writes to
 * the focused (or first live) console of the active workspace and gives it
 * the focus back; `agent` adds a console with the preset to the command's
 * workspace (or the active one), focuses it and delivers the prompt once.
 */
export async function runQuickCommand(cmd: QuickCommand): Promise<QuickRunResult> {
  const s = useAppStore.getState()
  if (cmd.action === 'send') {
    const paneId = sendTarget(s)
    const ptyId = paneId ? getPtyId(paneId) : undefined
    if (!paneId || !ptyId) {
      toast.error(tr('quick.toast.noConsole'), { dedupeKey: 'quick' })
      return { ok: false, error: 'no_console' }
    }
    setTimeout(() => focusPane(paneId), 0)
    const res = await window.snApi.pty.submit({ ptyId, paneId, text: cmd.text, enter: cmd.enter })
    if (!res.ok) {
      if (res.error === 'multiline_unsafe') toast.warning(tr('quick.toast.multiline'), { dedupeKey: 'quick' })
      else toast.error(tr('quick.toast.noConsole'), { dedupeKey: 'quick' })
      return { ok: false, error: res.error }
    }
    // E4-FR-06: the toast names the command and the console it went to.
    const pane = s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.panes.find((p) => p.id === paneId)
    toast.success(tr('quick.toast.sent', { label: cmd.name, pane: pane?.title ?? '' }), { dedupeKey: 'quick' })
    return { ok: true, paneId }
  }
  const scoped = cmd.workspaceId && s.workspaces.some((w) => w.id === cmd.workspaceId) ? cmd.workspaceId : null
  const wsId = scoped ?? s.activeWorkspaceId
  if (!wsId || !s.workspaces.some((w) => w.id === wsId)) {
    toast.warning(tr('quick.toast.noWorkspace'), { dedupeKey: 'quick' })
    return { ok: false, error: 'no_workspace' }
  }
  const created = createAgentPane(cmd, wsId)
  if (!created) {
    toast.error(tr('quick.toast.presetMissing'), { dedupeKey: 'quick' })
    editQuickCommand(cmd.id)
    return { ok: false, error: 'no_preset' }
  }
  if (wsId !== s.activeWorkspaceId) useAppStore.getState().setActive(wsId)
  focusPaneWhenReady(created.paneId)
  toast.info(tr('quick.toast.opening', { preset: created.presetName, label: cmd.name }), { dedupeKey: 'quick' })
  return { ok: true, paneId: created.paneId }
}

/**
 * Phone run (E8-FR-07), strict: the command must be global or scoped to the
 * phone's workspace; `send` goes only to the console open on the phone (never
 * the desktop's focus); `agent` mounts just the new console of that workspace
 * without activating it and returns its id for the phone to subscribe.
 */
export async function runRemoteQuickCommand(
  action: Extract<RemoteCtlAction, { kind: 'runQuickCommand' }>,
): Promise<{ ok: boolean; error?: string; paneId?: string }> {
  const s = useAppStore.getState()
  const ws = s.workspaces.find((w) => w.id === action.workspaceId)
  const cmd = s.quickCommands.find((c) => c.id === action.id)
  if (!ws || !cmd || (cmd.workspaceId !== undefined && cmd.workspaceId !== ws.id)) return { ok: false, error: 'not_found' }
  if (cmd.action === 'send') {
    if (!action.paneId) return { ok: false, error: 'bad_request' }
    if (!ws.panes.some((p) => p.id === action.paneId)) return { ok: false, error: 'not_found' }
    // The registry can miss a live pty after a reload (pane not remounted
    // yet): main resolves the pane's pty then.
    const res = await window.snApi.pty.submit({ ptyId: getPtyId(action.paneId) ?? '', paneId: action.paneId, text: cmd.text, enter: cmd.enter })
    return res.ok ? { ok: true, paneId: action.paneId } : { ok: false, error: res.error }
  }
  const created = createAgentPane(cmd, ws.id)
  if (!created) return { ok: false, error: 'no_preset' }
  // Partial mount (E8-FR-30): only the new console spawns; the desktop keeps
  // its active workspace.
  useAppStore.getState().ensureMounted(ws.id, { only: [created.paneId] })
  return { ok: true, paneId: created.paneId }
}
