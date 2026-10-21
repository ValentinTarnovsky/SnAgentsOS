/**
 * The renderer side of the snaos CLI bus (E8 Group C): main resolves every
 * address and checks every rule, then asks the owner of the model for what
 * only it can do (list, open, spawn, read the xterm buffer, status line,
 * note, attention; in app 2.3.0 also kill, restart, rename, workspaces and
 * the Notes drawer, each with an info toast when it changes the desktop under
 * the user). Ops arrive on the remote control relay as `{ kind: 'cli',
 * op }` (CONTRATOS: the CLI reuses remote:controlCmd) and never come from a
 * phone: the phone schema has no `cli` action.
 */
import type { CtlListData, CtlRendererData, CtlRendererOp } from '@shared/ctl-protocol'
import type { AgentPreset, Pane, Workspace } from '@shared/types'
import { initialPromptFallback } from '@shared/initialPrompt'
import { shellKind } from '@shared/shellKind'
import { isTaskState, normalizeWorkspaceNote } from '@shared/workspaceNote'
import { useAppStore, type AppState } from './store'
import { useAgentStore } from './agentStore'
import { liveSidebarOrder } from './sidebarOrder'
import { revealPane } from './revealPane'
import { resolveLaunch } from './launch'
import { platformDefaultShell } from './agentEndRun'
import { readTerm } from './termReaders'
import { useStatusLines } from './statusLineStore'
import { killPanePtys } from './ptyRegistry'
import { restartPaneWith } from './paneRestart'
import { markStopped } from './stoppedPanes'
import { openNoteInPanel } from './sidePanels'
import { toast } from './toast'
import { isNoteId } from '@shared/ws-notes'
import { translate } from '@/i18n'

export interface CtlOpResult {
  ok: boolean
  error?: string
  data?: unknown
}

/** Panes in grid order (layout order first, any pane missing from it after). */
function gridPanes(ws: Workspace): Pane[] {
  const order = ws.layout?.order ?? ws.panes.map((p) => p.id)
  const byId = new Map(ws.panes.map((p) => [p.id, p]))
  const out = order.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
  for (const p of ws.panes) if (!order.includes(p.id)) out.push(p)
  return out
}

export function listData(state: AppState): CtlListData {
  const order = liveSidebarOrder(state, useAgentStore.getState())
  return {
    workspaces: order.map((w) => ({
      id: w.id,
      name: w.name,
      cwd: w.cwd,
      ...(w.setupId ? { setupId: w.setupId } : {}),
      ...(w.favorite ? { favorite: true as const } : {}),
      ...(w.note ? { note: w.note } : {}),
      ...(w.taskState ? { taskState: w.taskState } : {}),
      panes: gridPanes(w).map((p) => {
        const home = state.paneHome[p.id]?.workspaceId
        return {
          id: p.id,
          title: p.title,
          type: p.type,
          ...(p.presetId ? { presetId: p.presetId } : {}),
          ...(p.setupId !== undefined ? { setupId: p.setupId } : {}),
          ...(home && home !== w.id ? { homeWorkspaceId: home } : {}),
        }
      }),
    })),
    activeWorkspaceId: state.activeWorkspaceId,
    presets: state.presets.map((p) => ({ id: p.id, name: p.name, type: p.type })),
    statusLines: { ...useStatusLines.getState().lines },
  }
}

/**
 * How main will deliver a spawn's prompt (E8-FR-16 `promptDelivery`), as the
 * phone path predicts it: `argv` when the agent command can carry it, else
 * the gate (Enter only on a precise ready signal). Main decides again with
 * the resolved shell.
 */
export function predictDelivery(
  state: Pick<AppState, 'presets' | 'connections' | 'settings'>,
  ws: Workspace,
  pane: Pane,
  preset: AgentPreset | undefined,
  text: string,
  platform: string,
): 'argv' | 'gate' {
  if (!preset || (preset.type !== 'claude' && preset.type !== 'codex')) return 'gate'
  const launch = resolveLaunch(pane, ws, state.presets, state.connections)
  const configured = platform === 'win32' || platform === 'darwin' || platform === 'linux' ? state.settings.defaultShell[platform] : undefined
  const shell = configured?.trim() ? configured : platformDefaultShell(platform)
  return initialPromptFallback({ text, shell: shellKind(shell, platform), platform, hasSetup: !!launch.setup, launchKind: launch.launchKind ?? 'other' }) ? 'gate' : 'argv'
}

const findPane = (state: AppState, paneId: string): { ws: Workspace; pane: Pane } | null => {
  for (const ws of state.workspaces) {
    const pane = ws.panes.find((p) => p.id === paneId)
    if (pane) return { ws, pane }
  }
  return null
}

export function runCtlOp(op: CtlRendererOp): CtlOpResult {
  const s = useAppStore.getState()
  switch (op.kind) {
    case 'list':
      return { ok: true, data: listData(s) satisfies CtlListData }

    case 'open': {
      if (!s.workspaces.some((w) => w.id === op.workspaceId)) return { ok: false, error: 'not_found' }
      window.snApi.window.reveal()
      if (op.paneId) return revealPane(op.paneId) ? { ok: true } : { ok: false, error: 'not_found' }
      s.ensureMounted(op.workspaceId)
      s.setActive(op.workspaceId)
      return { ok: true }
    }

    case 'composer':
      s.setWizardOpen(true, { cwd: op.cwd, ...(op.name ? { name: op.name } : {}) })
      window.snApi.window.reveal()
      return { ok: true }

    case 'spawn': {
      const ws = s.workspaces.find((w) => w.id === op.workspaceId)
      if (!ws) return { ok: false, error: 'not_found' }
      const preset = op.presetId ? s.presets.find((p) => p.id === op.presetId) : undefined
      if (op.presetId && !preset) return { ok: false, error: 'not_found' }
      const pane: Partial<Pane> = preset
        ? { type: preset.type, presetId: preset.id, title: preset.name, color: preset.color, icon: preset.icon }
        : { type: op.paneType ?? 'shell' }
      if (op.title) pane.title = op.title
      // --no-profile: a local console in a workspace with a Connection Profile.
      if (op.noProfile && ws.setupId) pane.setupId = ''
      const paneId = s.addPane(ws.id, pane)
      if (!paneId) return { ok: false, error: 'not_found' }
      const after = useAppStore.getState()
      const created = after.workspaces.find((w) => w.id === ws.id)
      const newPane = created?.panes.find((p) => p.id === paneId)
      let promptDelivery: CtlRendererData['spawn']['promptDelivery'] = 'none'
      if (op.prompt && created && newPane) {
        promptDelivery = predictDelivery(after, created, newPane, preset, op.prompt, window.snApi.platform)
        after.setPendingPrompt(paneId, { text: op.prompt, enter: true, source: 'cli', createdAt: Date.now() })
      }
      // Without --focus only the new console starts; the desktop keeps its workspace (E8-FR-30).
      if (op.focus) revealPane(paneId)
      else useAppStore.getState().ensureMounted(ws.id, { only: [paneId] })
      const index = created ? gridPanes(created).findIndex((p) => p.id === paneId) + 1 : 0
      return { ok: true, data: { paneId, index, promptDelivery } satisfies CtlRendererData['spawn'] }
    }

    case 'read': {
      const lines = readTerm(op.paneId, Math.max(1, Math.min(op.lines, 2000)))
      return lines ? { ok: true, data: { lines } satisfies CtlRendererData['read'] } : { ok: false, error: 'not_running' }
    }

    case 'setStatusLine':
      if (op.text !== null && !findPane(s, op.paneId)) return { ok: false, error: 'not_found' }
      useStatusLines.getState().setLine(op.paneId, op.text)
      return { ok: true }

    case 'setNote': {
      if (!s.workspaces.some((w) => w.id === op.workspaceId)) return { ok: false, error: 'not_found' }
      if (op.note !== undefined) s.setWorkspaceNote(op.workspaceId, op.note === null ? null : normalizeWorkspaceNote(op.note) ?? null)
      if (op.taskState !== undefined) s.setWorkspaceTaskState(op.workspaceId, isTaskState(op.taskState) ? op.taskState : null)
      return { ok: true }
    }

    case 'attention': {
      if (!findPane(s, op.paneId)) return { ok: false, error: 'not_found' }
      if (!(op.paneId in s.paneAttention)) useAppStore.setState((st) => ({ paneAttention: { ...st.paneAttention, [op.paneId]: true } }))
      return { ok: true }
    }

    // --- app 2.3.0 -----------------------------------------------------------

    case 'kill': {
      const pane = paneIn(s, op.workspaceId, op.paneId)
      if (!pane) return { ok: false, error: 'not_found' }
      // Explicit kill (E4-FR-36), the same path as the phone's closePane.
      killPanePtys([op.paneId])
      // Closed like the desktop does it: reopenable, a worktree keeps its folder.
      if (op.close) s.closePane(op.workspaceId, op.paneId)
      // Kept stopped: a later mount shows the exit card instead of spawning again.
      else markStopped(op.paneId)
      if (op.close) cliToast('toast.cli.closed', { pane: pane.title })
      // Main owns the ptys (this registry is empty after a reload): nothing ran, nothing was stopped.
      else if (op.running !== false) cliToast('toast.cli.killed', { pane: pane.title })
      return { ok: true }
    }

    case 'restart': {
      const pane = paneIn(s, op.workspaceId, op.paneId)
      if (!pane) return { ok: false, error: 'not_found' }
      restartPaneWith(op.paneId, op.resume)
      cliToast('toast.cli.restarted', { pane: pane.title })
      return { ok: true }
    }

    case 'renamePane': {
      if (!paneIn(s, op.workspaceId, op.paneId)) return { ok: false, error: 'not_found' }
      s.renamePane(op.workspaceId, op.paneId, op.title)
      return { ok: true }
    }

    case 'createWorkspace': {
      const prevActive = s.activeWorkspaceId
      const prevPrevious = s.previousWorkspaceId
      // Activates and mounts the new workspace with one shell.
      const id = s.createWorkspace(op.name, op.cwd)
      if (op.focus) window.snApi.window.reveal()
      // Without --focus the desktop keeps its workspace (E8-FR-30); the new shell still starts.
      else if (prevActive && prevActive !== id) useAppStore.setState({ activeWorkspaceId: prevActive, previousWorkspaceId: prevPrevious })
      const index = liveSidebarOrder(useAppStore.getState(), useAgentStore.getState()).findIndex((w) => w.id === id) + 1
      return { ok: true, data: { workspaceId: id, index } satisfies CtlRendererData['createWorkspace'] }
    }

    case 'renameWorkspace': {
      if (!s.workspaces.some((w) => w.id === op.workspaceId)) return { ok: false, error: 'not_found' }
      s.renameWorkspace(op.workspaceId, op.name)
      return { ok: true }
    }

    case 'deleteWorkspace': {
      const ws = s.workspaces.find((w) => w.id === op.workspaceId)
      if (!ws) return { ok: false, error: 'not_found' }
      // Kills every console of it (killPanePtys inside), like the Sidebar's confirmed delete.
      s.deleteWorkspace(ws.id)
      cliToast('toast.cli.wsClosed', { name: ws.name })
      return { ok: true }
    }

    case 'setFavorite': {
      const ws = s.workspaces.find((w) => w.id === op.workspaceId)
      if (!ws) return { ok: false, error: 'not_found' }
      if (!!ws.favorite !== op.favorite) s.toggleFavorite(ws.id)
      return { ok: true }
    }

    case 'openNote': {
      if (!isNoteId(op.noteId)) return { ok: false, error: 'bad_request' }
      if (!s.workspaces.some((w) => w.id === op.workspaceId)) return { ok: false, error: 'not_found' }
      window.snApi.window.reveal()
      // The board would cover the drawer.
      useAgentStore.getState().setView('grid')
      s.ensureMounted(op.workspaceId)
      if (s.activeWorkspaceId !== op.workspaceId) s.setActive(op.workspaceId)
      openNoteInPanel(op.workspaceId, op.noteId)
      return { ok: true }
    }

    default:
      return { ok: false, error: 'bad_request' }
  }
}

const paneIn = (state: AppState, workspaceId: string, paneId: string): Pane | undefined =>
  state.workspaces.find((w) => w.id === workspaceId)?.panes.find((p) => p.id === paneId)

/** Info toast of a CLI action that changed the desktop (es/en, like the phone's). */
function cliToast(key: 'toast.cli.killed' | 'toast.cli.closed' | 'toast.cli.restarted' | 'toast.cli.wsClosed', vars: Record<string, string>): void {
  toast.info(translate(useAppStore.getState().settings.language, key, vars))
}
