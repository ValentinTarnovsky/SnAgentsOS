import { create } from 'zustand'
import type {
  AgentPreset,
  AgentSessionEndEvt,
  PaneStatus,
  ConfigFile,
  ConnectionProfile,
  GridPreset,
  KeyButton,
  Pane,
  PaneSchedule,
  PaneStatusEvt,
  PaneType,
  Settings,
  Snippet,
  Workspace,
  WorkspaceLayout,
} from '@shared/types'
import { gridForCount } from '@/components/layout/gridTemplates'
import { killPanePtys } from '@/lib/ptyRegistry'
import { restartInPlace } from '@/lib/restartRegistry'
import { visiblePaneIds } from '@shared/status'
import { useAgentStore } from '@/lib/agentStore'
import {
  type EnsureMountedOpts,
  type MountedWorkspaces,
  keepMounted,
  withMounted,
  withoutMounted,
} from '@/lib/mounting'

const ACCENTS = ['#6366f1', '#8b5cf6', '#60a5fa']

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`
}

function makeShellPane(index: number): Pane {
  return {
    id: uid('pane'),
    type: 'shell',
    title: 'PowerShell',
    color: ACCENTS[index % ACCENTS.length],
    icon: 'terminal',
  }
}

const DEFAULT_PRESETS: AgentPreset[] = [
  { id: 'preset-shell', name: 'Shell', type: 'shell', command: '', args: [], color: '#6366f1', icon: 'terminal' },
  { id: 'preset-claude', name: 'Claude Code', type: 'claude', command: 'claude', args: [], color: '#d97757', icon: 'claude' },
  { id: 'preset-codex', name: 'Codex', type: 'codex', command: 'codex', args: [], color: '#10a37f', icon: 'openai' },
]

const DEFAULT_SETTINGS: Settings = {
  defaultShell: {},
  fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
  fontSize: 13,
  accent: 'violet',
  theme: 'midnight',
  customColors: {},
  language: 'en',
  scrollback: 5000,
  infiniteScrollback: true,
  terminalRenderer: 'canvas',
  terminalSelectionOverride: true,
  terminalUnicode11: true,
  terminalAgentEndChip: true,
  awakeMode: 'auto',
  restoreLastWorkspace: true,
  confirmCloseRunning: true,
  autoCheckUpdates: true,
  closeToTray: true,
  launchOnStartup: false,
  globalHotkeyEnabled: false,
  globalHotkey: 'Super+Alt+O',
  keymap: {},
  sidebarCollapsed: false,
  usage: {
    enabled: true,
    claudeIntervalMs: 60000,
    codexIntervalMs: 10000,
    refreshOnFocus: true,
    showStatus: true,
    rows: {
      claude5h: true,
      claude7d: true,
      claudeOpus7d: false,
      claudeSonnet7d: false,
      codex5h: true,
      codex7d: true,
    },
    custom: [],
  },
  remote: {
    enabled: false,
    port: 4517,
  },
  notifications: {
    enabled: true,
    notifyDone: true,
    notifyAction: true,
    sound: true,
    soundId: 'chime',
    volume: 70,
    flashTaskbar: true,
    hooksEnabled: false,
    hookPort: 43917,
    hookToken: '',
    codexEnabled: false,
    discord: { enabled: false, webhookUrl: '', userId: '', notifyAction: true, notifyDone: true },
    inAppWhenFocused: true,
  },
  agents: {
    resumeOnStartup: 'ask',
    awakeDisplay: false,
    sidebarAgentRows: true,
    topicAsTitle: true,
    ctrlDigitFocus: true,
  },
}

/** A single terminal cell chosen in the new-workspace wizard. */
export interface WorkspaceDraftPane {
  type: PaneType
  presetId?: string
  title: string
  color: string
  icon: string
  command?: string
}

export interface WorkspaceDraft {
  name: string
  cwd: string
  grid: GridPreset
  panes: WorkspaceDraftPane[]
  /** Connection profile applied to every console in the new workspace. */
  setupId?: string
}

export interface AppState {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  /** Last active workspace (drives Ctrl+Tab quick-flip). */
  previousWorkspaceId: string | null
  sidebarCollapsed: boolean
  presets: AgentPreset[]
  snippets: Snippet[]
  keyButtons: KeyButton[]
  connections: ConnectionProfile[]
  settings: Settings
  settingsOpen: boolean
  /** Deep-link target for the settings modal: the category to open on. */
  settingsCategory: string | null
  wizardOpen: boolean
  paletteOpen: boolean
  globalPromptOpen: boolean
  /** workspaceId -> maximized paneId (transient; never persisted). */
  maximized: Record<string, string | null>
  /** workspaceId -> minimized paneIds (transient; never persisted). */
  minimized: Record<string, string[]>
  /** paneId -> relaunch counter (transient; bumping it remounts the console). */
  paneEpoch: Record<string, number>
  /** paneId -> live Claude state (transient; fed by main over STATUS_STATE). */
  paneStatus: Record<string, PaneStatus>
  /** paneId -> unacknowledged done/action flag (transient; drives sidebar badges). */
  paneAttention: Record<string, true>
  /** paneId -> exit code of a shell that ended on its own (transient; "exited" label, E6-FR-38). */
  paneExit: Record<string, number>
  /** paneId -> Claude session that just ended (transient; "Claude exited" chip, E6-FR-22). */
  agentEnded: Record<string, AgentSessionEndEvt>
  /**
   * workspaceId -> 'full' | mounted paneIds (transient; never persisted). The
   * single mounting primitive (D4): activating a workspace mounts it 'full',
   * and nothing unmounts except deleting the workspace.
   */
  mountedWorkspaces: MountedWorkspaces
  /** False until persisted config has been loaded (gates the persistence writer). */
  hydrated: boolean

  hydrate: (config: ConfigFile | null) => void
  createWorkspace: (name: string, cwd: string) => string
  createWorkspaceFull: (draft: WorkspaceDraft) => string
  importConfig: (config: ConfigFile) => void
  mergeConfig: (config: ConfigFile) => void
  deleteWorkspace: (id: string) => void
  renameWorkspace: (id: string, name: string) => void
  toggleFavorite: (id: string) => void
  setActive: (id: string) => void
  toggleSidebar: () => void
  addPane: (workspaceId: string, pane?: Partial<Pane>) => void
  removePane: (workspaceId: string, paneId: string) => void
  /**
   * Close a console the way the user does (grid, phone): remembers it on the
   * closed stack for reopenClosedPane, then removes it (E5-FR-14).
   */
  closePane: (workspaceId: string, paneId: string) => void
  /** Put a closed pane back with its own id at `orderIndex` of layout.order. */
  restorePane: (workspaceId: string, pane: Pane, orderIndex: number) => boolean
  /**
   * Reopen the most recently closed console still restorable (its workspace
   * exists). Activates its workspace. Returns the reopened entry, or null.
   */
  reopenClosedPane: () => { workspaceId: string; paneId: string } | null
  /** Drop a pane's lastSession mirror ("Restart with a new chat"). */
  clearLastSession: (paneId: string) => void
  renamePane: (workspaceId: string, paneId: string, title: string) => void
  setPaneFontSize: (workspaceId: string, paneId: string, fontSize: number) => void
  /**
   * Relaunch a console: in place when its terminal is mounted (same xterm,
   * scrollback kept, E6-FR-18), else by remount.
   */
  restartPane: (paneId: string) => void
  /** "Restart clean": remount the console (empty screen, fresh pty). */
  restartPaneClean: (paneId: string) => void
  /** Record (code) or clear (null) a console's natural shell exit. */
  setPaneExit: (paneId: string, code: number | null) => void
  /** Show the "Claude exited" chip for the event's console (E6-FR-22). */
  setAgentEnded: (evt: AgentSessionEndEvt) => void
  /** Hide a console's "Claude exited" chip (typing, exit, an action, [x]). */
  clearAgentEnded: (paneId: string) => void
  /** Set (or clear, with null) a console's one-shot scheduled prompt. */
  setPaneSchedule: (workspaceId: string, paneId: string, schedule: PaneSchedule | null) => void
  setGrid: (workspaceId: string, grid: GridPreset) => void
  movePane: (workspaceId: string, paneId: string, toIndex: number) => void
  toggleMaximize: (workspaceId: string, paneId: string) => void
  clearMaximize: (workspaceId: string) => void
  toggleMinimize: (workspaceId: string, paneId: string) => void

  savePreset: (preset: AgentPreset) => void
  deletePreset: (id: string) => void
  newPresetId: () => string

  saveSnippet: (snippet: Snippet) => void
  deleteSnippet: (id: string) => void
  newSnippetId: () => string

  saveKeyButton: (button: KeyButton) => void
  deleteKeyButton: (id: string) => void
  newKeyButtonId: () => string

  saveConnection: (connection: ConnectionProfile) => void
  deleteConnection: (id: string) => void
  newConnectionId: () => string

  updateSettings: (patch: Partial<Settings>) => void
  setSettingsOpen: (open: boolean) => void
  /** Open settings, optionally deep-linking to a category (e.g. 'remote'). */
  openSettings: (category?: string) => void
  setWizardOpen: (open: boolean) => void
  setPaletteOpen: (open: boolean) => void
  setGlobalPromptOpen: (open: boolean) => void

  /** Apply a Claude status update pushed by main (also flags attention). */
  setPaneStatus: (evt: PaneStatusEvt) => void
  /** Acknowledge one console's attention flag (typing into it, restoring it). */
  clearPaneAttention: (paneId: string) => void
  /** Acknowledge every non-minimized console of a workspace (viewing it). */
  markWorkspaceSeen: (workspaceId: string) => void
  /**
   * Mount a workspace without activating it: every console, or with `only`
   * just those panes (the rest show the "console not started" placeholder).
   * No-op for unknown workspaces and when already mounted that far.
   */
  ensureMounted: (workspaceId: string, opts?: EnsureMountedOpts) => void
}

/** Mount `wsId` fully in `map` (activation). Null ids leave the map as is. */
function mountActive(map: MountedWorkspaces, wsId: string | null): MountedWorkspaces {
  return wsId ? withMounted(map, wsId, []) : map
}

/**
 * `workspaces` with `pane.lastSession` updated from a status event carrying a
 * session id (main already dropped `launch:` ids and SSH consoles). Returns
 * the same reference when nothing changes, so status traffic stays transient.
 */
function withLastSession(workspaces: Workspace[], evt: PaneStatusEvt): Workspace[] {
  if (!evt.sessionId || !evt.provider) return workspaces
  const { sessionId, provider } = evt
  for (const ws of workspaces) {
    const pane = ws.panes.find((p) => p.id === evt.paneId)
    if (!pane) continue
    const prev = pane.lastSession
    // The first cwd of a session is its launch directory (what a resume needs,
    // E5 spawnCwd). Claude's hook cwd follows a later `cd`, so it never moves it.
    const same = prev?.sessionId === sessionId && prev.provider === provider
    const cwd = same && prev.cwd ? prev.cwd : evt.cwd ?? ''
    if (prev && prev.sessionId === sessionId && prev.provider === provider && prev.cwd === cwd) return workspaces
    const lastSession = { provider, sessionId, cwd, at: evt.updatedAt ?? Date.now() }
    return workspaces.map((w) => (w === ws ? { ...w, panes: w.panes.map((p) => (p === pane ? { ...p, lastSession } : p)) } : w))
  }
  return workspaces
}

export const useAppStore = create<AppState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  previousWorkspaceId: null,
  sidebarCollapsed: false,
  presets: DEFAULT_PRESETS,
  snippets: [],
  keyButtons: [],
  connections: [],
  settings: DEFAULT_SETTINGS,
  settingsOpen: false,
  settingsCategory: null,
  wizardOpen: false,
  paletteOpen: false,
  globalPromptOpen: false,
  maximized: {},
  minimized: {},
  paneEpoch: {},
  paneStatus: {},
  paneAttention: {},
  paneExit: {},
  agentEnded: {},
  mountedWorkspaces: {},
  hydrated: false,

  hydrate: (config) =>
    set((s) => {
      if (!config) return { hydrated: true }
      const workspaces = config.workspaces ?? []
      const presets = config.presets && config.presets.length ? config.presets : s.presets
      const snippets = config.snippets ?? []
      const keyButtons = config.keyButtons ?? []
      const connections = config.connections ?? []
      const settings: Settings = { ...s.settings, ...config.settings }
      let activeWorkspaceId: string | null = null
      if (settings.restoreLastWorkspace) {
        const wanted = config.activeWorkspaceId ?? null
        activeWorkspaceId = workspaces.some((w) => w.id === wanted)
          ? wanted
          : (workspaces[0]?.id ?? null)
      }
      return {
        workspaces,
        presets,
        snippets,
        keyButtons,
        connections,
        settings,
        sidebarCollapsed: settings.sidebarCollapsed,
        activeWorkspaceId,
        mountedWorkspaces: mountActive(s.mountedWorkspaces, activeWorkspaceId),
        hydrated: true,
      }
    }),

  createWorkspace: (name, cwd) => {
    const pane = makeShellPane(0)
    const ws: Workspace = {
      id: uid('ws'),
      name,
      cwd,
      panes: [pane],
      favorite: false,
      layout: { grid: 1, order: [pane.id] },
    }
    set((s) => ({
      workspaces: [...s.workspaces, ws],
      activeWorkspaceId: ws.id,
      mountedWorkspaces: mountActive(s.mountedWorkspaces, ws.id),
    }))
    return ws.id
  },

  createWorkspaceFull: (draft) => {
    const panes: Pane[] =
      draft.panes.length > 0
        ? draft.panes.map((p) => ({
            id: uid('pane'),
            type: p.type,
            presetId: p.presetId,
            command: p.command,
            title: p.title,
            color: p.color,
            icon: p.icon,
          }))
        : [makeShellPane(0)]
    const layout: WorkspaceLayout = { grid: draft.grid, order: panes.map((p) => p.id) }
    const ws: Workspace = {
      id: uid('ws'),
      name: draft.name,
      cwd: draft.cwd,
      panes,
      favorite: false,
      layout,
      setupId: draft.setupId,
    }
    set((s) => ({
      workspaces: [...s.workspaces, ws],
      activeWorkspaceId: ws.id,
      mountedWorkspaces: mountActive(s.mountedWorkspaces, ws.id),
    }))
    return ws.id
  },

  importConfig: (config) =>
    set((s) => ({
      // Workspaces that leave the list unmount; ones that survive the import
      // (same id) keep their consoles running, and the new active one mounts.
      mountedWorkspaces: mountActive(
        keepMounted(s.mountedWorkspaces, (config.workspaces ?? []).map((w) => w.id)),
        config.workspaces?.[0]?.id ?? null,
      ),
      workspaces: config.workspaces ?? [],
      presets: config.presets && config.presets.length ? config.presets : s.presets,
      snippets: config.snippets ?? [],
      keyButtons: config.keyButtons ?? [],
      connections: config.connections ?? [],
      settings: { ...s.settings, ...config.settings },
      sidebarCollapsed: config.settings?.sidebarCollapsed ?? s.sidebarCollapsed,
      activeWorkspaceId: config.workspaces?.[0]?.id ?? null,
      previousWorkspaceId: null,
    })),

  mergeConfig: (config) =>
    set((s) => {
      const existingPreset = new Set(s.presets.map((p) => p.id))
      const newPresets = (config.presets ?? []).filter((p) => !existingPreset.has(p.id))
      // Re-id imported workspaces + their panes so they never collide with ours.
      const importedWs: Workspace[] = (config.workspaces ?? []).map((w) => {
        const idMap = new Map<string, string>()
        const panes = w.panes.map((p) => {
          const nid = uid('pane')
          idMap.set(p.id, nid)
          return { ...p, id: nid }
        })
        const layout: WorkspaceLayout | undefined = w.layout
          ? { grid: w.layout.grid, order: w.layout.order.map((id) => idMap.get(id) ?? id) }
          : undefined
        return { ...w, id: uid('ws'), panes, layout }
      })
      const existingSnip = new Set(s.snippets.map((x) => x.id))
      const newSnippets = (config.snippets ?? []).filter((x) => !existingSnip.has(x.id))
      const existingKeyButton = new Set(s.keyButtons.map((x) => x.id))
      const newKeyButtons = (config.keyButtons ?? []).filter((x) => !existingKeyButton.has(x.id))
      const existingConn = new Set(s.connections.map((x) => x.id))
      const newConnections = (config.connections ?? []).filter((x) => !existingConn.has(x.id))
      return {
        workspaces: [...s.workspaces, ...importedWs],
        presets: [...s.presets, ...newPresets],
        snippets: [...s.snippets, ...newSnippets],
        keyButtons: [...s.keyButtons, ...newKeyButtons],
        connections: [...s.connections, ...newConnections],
      }
    }),

  deleteWorkspace: (id) => {
    // Force-kill the workspace's consoles so nothing lingers in the background.
    const ws = get().workspaces.find((w) => w.id === id)
    if (ws) killPanePtys(ws.panes.map((p) => p.id))
    set((s) => {
      const workspaces = s.workspaces.filter((w) => w.id !== id)
      const activeWorkspaceId =
        s.activeWorkspaceId === id ? (workspaces[0]?.id ?? null) : s.activeWorkspaceId
      const maximized = { ...s.maximized }
      delete maximized[id]
      const minimized = { ...s.minimized }
      delete minimized[id]
      const mountedWorkspaces = mountActive(withoutMounted(s.mountedWorkspaces, id), activeWorkspaceId)
      return { workspaces, activeWorkspaceId, maximized, minimized, mountedWorkspaces }
    })
  },

  renameWorkspace: (id, name) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === id ? { ...w, name: name.trim() || w.name } : w,
      ),
    })),

  toggleFavorite: (id) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, favorite: !w.favorite } : w)),
    })),

  setActive: (id) => {
    set((s) => ({
      activeWorkspaceId: id,
      previousWorkspaceId: s.activeWorkspaceId !== id ? s.activeWorkspaceId : s.previousWorkspaceId,
      mountedWorkspaces: mountActive(s.mountedWorkspaces, id),
    }))
    // Viewing a workspace acknowledges its visible consoles' attention badges.
    get().markWorkspaceSeen(id)
  },

  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  addPane: (workspaceId, pane) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w
        const newPane: Pane = { ...makeShellPane(w.panes.length), ...pane, id: uid('pane') }
        const panes = [...w.panes, newPane]
        const order = [...(w.layout?.order ?? w.panes.map((p) => p.id)), newPane.id]
        const grid = gridForCount(panes.length)
        return { ...w, panes, layout: { grid, order } }
      }),
    })),

  removePane: (workspaceId, paneId) =>
    set((s) => {
      const maximized = { ...s.maximized }
      if (maximized[workspaceId] === paneId) maximized[workspaceId] = null
      const minimized = { ...s.minimized }
      if (minimized[workspaceId]?.includes(paneId)) {
        minimized[workspaceId] = minimized[workspaceId].filter((id) => id !== paneId)
      }
      const paneExit = { ...s.paneExit }
      delete paneExit[paneId]
      const agentEnded = { ...s.agentEnded }
      delete agentEnded[paneId]
      return {
        maximized,
        minimized,
        paneExit,
        agentEnded,
        workspaces: s.workspaces.map((w) => {
          if (w.id !== workspaceId) return w
          const panes = w.panes.filter((p) => p.id !== paneId)
          const order = (w.layout?.order ?? w.panes.map((p) => p.id)).filter((id) => id !== paneId)
          // Shrink the grid back to the smallest preset that fits the remaining
          // panes so removing a console reflows the rest (no leftover empty cells).
          const grid = gridForCount(panes.length)
          return { ...w, panes, layout: { grid, order } }
        }),
      }
    }),

  closePane: (workspaceId, paneId) => {
    const ws = get().workspaces.find((w) => w.id === workspaceId)
    const pane = ws?.panes.find((p) => p.id === paneId)
    if (!ws || !pane) return
    const order = ws.layout?.order ?? ws.panes.map((p) => p.id)
    const orderIndex = Math.max(0, order.indexOf(paneId))
    useAgentStore.getState().pushClosed({ workspaceId, pane, orderIndex })
    get().removePane(workspaceId, paneId)
  },

  restorePane: (workspaceId, pane, orderIndex) => {
    const ws = get().workspaces.find((w) => w.id === workspaceId)
    if (!ws || get().workspaces.some((w) => w.panes.some((p) => p.id === pane.id))) return false
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w
        const panes = [...w.panes, pane]
        const order = (w.layout?.order ?? w.panes.map((p) => p.id)).filter((id) => id !== pane.id)
        order.splice(Math.max(0, Math.min(orderIndex, order.length)), 0, pane.id)
        return { ...w, panes, layout: { grid: gridForCount(panes.length), order } }
      }),
    }))
    return true
  },

  reopenClosedPane: () => {
    const agents = useAgentStore.getState()
    for (;;) {
      const entry = agents.popClosed()
      if (!entry) return null
      // A deleted workspace drops the entry; try the next one down the stack.
      if (!get().restorePane(entry.workspaceId, entry.pane, entry.orderIndex)) continue
      get().setActive(entry.workspaceId)
      return { workspaceId: entry.workspaceId, paneId: entry.pane.id }
    }
  },

  clearLastSession: (paneId) =>
    set((s) => {
      const ws = s.workspaces.find((w) => w.panes.some((p) => p.id === paneId && p.lastSession))
      if (!ws) return {}
      return {
        workspaces: s.workspaces.map((w) =>
          w === ws
            ? {
                ...w,
                panes: w.panes.map((p) => {
                  if (p.id !== paneId) return p
                  const { lastSession: _dropped, ...rest } = p
                  return rest
                }),
              }
            : w,
        ),
      }
    }),

  renamePane: (workspaceId, paneId, title) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === workspaceId
          ? {
              ...w,
              panes: w.panes.map((p) =>
                p.id === paneId ? { ...p, title: title.trim() || p.title } : p,
              ),
            }
          : w,
      ),
    })),

  setPaneFontSize: (workspaceId, paneId, fontSize) =>
    set((s) => {
      const clamped = Math.max(8, Math.min(40, Math.round(fontSize)))
      return {
        workspaces: s.workspaces.map((w) =>
          w.id === workspaceId
            ? {
                ...w,
                panes: w.panes.map((p) =>
                  p.id === paneId ? { ...p, fontSize: clamped } : p,
                ),
              }
            : w,
        ),
      }
    }),

  restartPane: (paneId) => {
    if (restartInPlace(paneId)) return
    get().restartPaneClean(paneId)
  },

  restartPaneClean: (paneId) =>
    set((s) => ({ paneEpoch: { ...s.paneEpoch, [paneId]: (s.paneEpoch[paneId] ?? 0) + 1 } })),

  setPaneExit: (paneId, code) => {
    // Hot path on every spawn: no set() when nothing changes.
    const cur = get().paneExit[paneId]
    if (code === null ? cur === undefined : cur === code) return
    set((s) => {
      const paneExit = { ...s.paneExit }
      if (code === null) delete paneExit[paneId]
      else paneExit[paneId] = code
      return { paneExit }
    })
  },

  setAgentEnded: (evt) => set((s) => ({ agentEnded: { ...s.agentEnded, [evt.paneId]: evt } })),

  clearAgentEnded: (paneId) => {
    // Hot path (called per keystroke): bail without a set() when clean.
    if (!(paneId in get().agentEnded)) return
    set((s) => {
      const agentEnded = { ...s.agentEnded }
      delete agentEnded[paneId]
      return { agentEnded }
    })
  },

  setPaneSchedule: (workspaceId, paneId, schedule) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === workspaceId
          ? {
              ...w,
              panes: w.panes.map((p) =>
                p.id === paneId ? { ...p, schedule: schedule ?? undefined } : p,
              ),
            }
          : w,
      ),
    })),

  setGrid: (workspaceId, grid) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === workspaceId
          ? { ...w, layout: { grid, order: w.layout?.order ?? w.panes.map((p) => p.id) } }
          : w,
      ),
    })),

  movePane: (workspaceId, paneId, toIndex) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w
        const order = (w.layout?.order ?? w.panes.map((p) => p.id)).slice()
        const from = order.indexOf(paneId)
        if (from === -1) return w
        const to = Math.max(0, Math.min(toIndex, order.length - 1))
        if (from === to) return w
        order.splice(from, 1)
        order.splice(to, 0, paneId)
        const grid = gridForCount(w.panes.length)
        return { ...w, layout: { grid, order } }
      }),
    })),

  toggleMaximize: (workspaceId, paneId) =>
    set((s) => ({
      maximized: {
        ...s.maximized,
        [workspaceId]: s.maximized[workspaceId] === paneId ? null : paneId,
      },
    })),

  clearMaximize: (workspaceId) =>
    set((s) => ({ maximized: { ...s.maximized, [workspaceId]: null } })),

  toggleMinimize: (workspaceId, paneId) => {
    const wasMinimized = (get().minimized[workspaceId] ?? []).includes(paneId)
    set((s) => {
      const current = s.minimized[workspaceId] ?? []
      const next = current.includes(paneId)
        ? current.filter((id) => id !== paneId)
        : [...current, paneId]
      return { minimized: { ...s.minimized, [workspaceId]: next } }
    })
    // Restoring a minimized console counts as looking at it.
    if (wasMinimized) get().clearPaneAttention(paneId)
  },

  savePreset: (preset) =>
    set((s) => {
      const exists = s.presets.some((p) => p.id === preset.id)
      return {
        presets: exists
          ? s.presets.map((p) => (p.id === preset.id ? preset : p))
          : [...s.presets, preset],
      }
    }),

  deletePreset: (id) => set((s) => ({ presets: s.presets.filter((p) => p.id !== id) })),

  newPresetId: () => uid('preset'),

  saveSnippet: (snippet) =>
    set((s) => {
      const exists = s.snippets.some((x) => x.id === snippet.id)
      return {
        snippets: exists
          ? s.snippets.map((x) => (x.id === snippet.id ? snippet : x))
          : [...s.snippets, snippet],
      }
    }),

  deleteSnippet: (id) => set((s) => ({ snippets: s.snippets.filter((x) => x.id !== id) })),

  newSnippetId: () => uid('snip'),

  saveKeyButton: (button) =>
    set((s) => {
      const exists = s.keyButtons.some((x) => x.id === button.id)
      return {
        keyButtons: exists
          ? s.keyButtons.map((x) => (x.id === button.id ? button : x))
          : [...s.keyButtons, button],
      }
    }),

  deleteKeyButton: (id) => set((s) => ({ keyButtons: s.keyButtons.filter((x) => x.id !== id) })),

  newKeyButtonId: () => uid('key'),

  saveConnection: (connection) =>
    set((s) => {
      const exists = s.connections.some((c) => c.id === connection.id)
      return {
        connections: exists
          ? s.connections.map((c) => (c.id === connection.id ? connection : c))
          : [...s.connections, connection],
      }
    }),

  deleteConnection: (id) => set((s) => ({ connections: s.connections.filter((c) => c.id !== id) })),

  newConnectionId: () => uid('conn'),

  updateSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

  setSettingsOpen: (open) => set({ settingsOpen: open }),

  openSettings: (category) => set({ settingsOpen: true, settingsCategory: category ?? null }),

  setPaneStatus: (evt) =>
    set((s) => {
      const paneStatus = { ...s.paneStatus }
      let paneAttention = s.paneAttention
      if (evt.state === null) {
        if (!(evt.paneId in paneStatus) && !(evt.paneId in paneAttention)) return {}
        delete paneStatus[evt.paneId]
        if (evt.paneId in paneAttention) {
          paneAttention = { ...paneAttention }
          delete paneAttention[evt.paneId]
        }
        return { paneStatus, paneAttention }
      }
      paneStatus[evt.paneId] = {
        state: evt.state, precise: evt.precise, provider: evt.provider, reason: evt.reason, pendingCount: evt.pendingCount, updatedAt: evt.updatedAt,
        stateSince: evt.stateSince, lastMessage: evt.lastMessage, activity: evt.activity, pending: evt.pending, sessionId: evt.sessionId, cwd: evt.cwd,
        detail: evt.detail, topic: evt.topic, firstPrompt: evt.firstPrompt, cacheSince: evt.cacheSince,
      }
      // A new session (or Claude working again) hides the "Claude exited" chip (E6-FR-22).
      let agentEnded = s.agentEnded
      const ended = agentEnded[evt.paneId]
      if (ended && (evt.state === 'working' || (evt.sessionId && evt.sessionId !== ended.sessionId))) {
        agentEnded = { ...agentEnded }
        delete agentEnded[evt.paneId]
      }
      // E4-FR-09 (d): mirror a validated session id onto pane.lastSession
      // (schema 11, a seed for main's agent-sessions.json). Only a change of
      // session, provider or cwd writes, so plain status traffic never persists.
      const workspaces = withLastSession(s.workspaces, evt)
      if (evt.state === 'done' || evt.state === 'action' || evt.state === 'error') {
        // Only flag attention when the console is not being looked at right now:
        // other workspace, minimized in the active one, or the window unfocused.
        const wsId = s.workspaces.find((w) => w.panes.some((p) => p.id === evt.paneId))?.id
        const visible = wsId ? visiblePaneIds(s.workspaces.find(w => w.id === wsId), s.minimized[wsId] ?? [], s.maximized[wsId]) : []
        const inView = wsId === s.activeWorkspaceId && visible.includes(evt.paneId) && document.hasFocus()
        if (!inView && !(evt.paneId in paneAttention)) {
          paneAttention = { ...paneAttention, [evt.paneId]: true }
        }
      } else if ((evt.state === 'working' || evt.state === 'idle') && evt.paneId in paneAttention) {
        // Back to work: the pending "look at me" flag is stale.
        paneAttention = { ...paneAttention }
        delete paneAttention[evt.paneId]
      }
      return workspaces === s.workspaces ? { paneStatus, paneAttention, agentEnded } : { paneStatus, paneAttention, agentEnded, workspaces }
    }),

  clearPaneAttention: (paneId) => {
    // Hot path (called per keystroke): bail without a set() when clean.
    if (!(paneId in get().paneAttention)) return
    set((s) => {
      const paneAttention = { ...s.paneAttention }
      delete paneAttention[paneId]
      return { paneAttention }
    })
  },

  markWorkspaceSeen: (workspaceId) =>
    set((s) => {
      const ws = s.workspaces.find((w) => w.id === workspaceId)
      if (!ws) return {}
      const visible = new Set(visiblePaneIds(ws, s.minimized[workspaceId] ?? [], s.maximized[workspaceId]))
      const toClear = ws.panes.filter(
        (p) => p.id in s.paneAttention && visible.has(p.id),
      )
      if (toClear.length === 0) return {}
      const paneAttention = { ...s.paneAttention }
      for (const p of toClear) delete paneAttention[p.id]
      return { paneAttention }
    }),

  ensureMounted: (workspaceId, opts) => {
    const s = get()
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    if (!ws) return
    const next = withMounted(s.mountedWorkspaces, workspaceId, ws.panes.map((p) => p.id), opts)
    if (next !== s.mountedWorkspaces) set({ mountedWorkspaces: next })
  },

  setWizardOpen: (open) => set({ wizardOpen: open }),

  setPaletteOpen: (open) => set({ paletteOpen: open }),

  setGlobalPromptOpen: (open) => set({ globalPromptOpen: open }),
}))
