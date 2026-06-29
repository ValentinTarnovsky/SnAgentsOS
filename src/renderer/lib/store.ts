import { create } from 'zustand'
import type {
  AgentPreset,
  ConfigFile,
  ConnectionProfile,
  GridPreset,
  Pane,
  PaneSchedule,
  PaneType,
  Settings,
  Snippet,
  Workspace,
  WorkspaceLayout,
} from '@shared/types'
import { gridForCount } from '@/components/layout/gridTemplates'
import { killPanePtys } from '@/lib/ptyRegistry'

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
  connections: ConnectionProfile[]
  settings: Settings
  settingsOpen: boolean
  wizardOpen: boolean
  paletteOpen: boolean
  /** workspaceId -> maximized paneId (transient; never persisted). */
  maximized: Record<string, string | null>
  /** workspaceId -> minimized paneIds (transient; never persisted). */
  minimized: Record<string, string[]>
  /** paneId -> relaunch counter (transient; bumping it remounts the console). */
  paneEpoch: Record<string, number>
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
  renamePane: (workspaceId: string, paneId: string, title: string) => void
  setPaneFontSize: (workspaceId: string, paneId: string, fontSize: number) => void
  /** Force a console to relaunch (kills + respawns its pty via remount). */
  restartPane: (paneId: string) => void
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

  saveConnection: (connection: ConnectionProfile) => void
  deleteConnection: (id: string) => void
  newConnectionId: () => string

  updateSettings: (patch: Partial<Settings>) => void
  setSettingsOpen: (open: boolean) => void
  setWizardOpen: (open: boolean) => void
  setPaletteOpen: (open: boolean) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  previousWorkspaceId: null,
  sidebarCollapsed: false,
  presets: DEFAULT_PRESETS,
  snippets: [],
  connections: [],
  settings: DEFAULT_SETTINGS,
  settingsOpen: false,
  wizardOpen: false,
  paletteOpen: false,
  maximized: {},
  minimized: {},
  paneEpoch: {},
  hydrated: false,

  hydrate: (config) =>
    set((s) => {
      if (!config) return { hydrated: true }
      const workspaces = config.workspaces ?? []
      const presets = config.presets && config.presets.length ? config.presets : s.presets
      const snippets = config.snippets ?? []
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
        connections,
        settings,
        sidebarCollapsed: settings.sidebarCollapsed,
        activeWorkspaceId,
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
    set((s) => ({ workspaces: [...s.workspaces, ws], activeWorkspaceId: ws.id }))
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
    set((s) => ({ workspaces: [...s.workspaces, ws], activeWorkspaceId: ws.id }))
    return ws.id
  },

  importConfig: (config) =>
    set((s) => ({
      workspaces: config.workspaces ?? [],
      presets: config.presets && config.presets.length ? config.presets : s.presets,
      snippets: config.snippets ?? [],
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
      const existingConn = new Set(s.connections.map((x) => x.id))
      const newConnections = (config.connections ?? []).filter((x) => !existingConn.has(x.id))
      return {
        workspaces: [...s.workspaces, ...importedWs],
        presets: [...s.presets, ...newPresets],
        snippets: [...s.snippets, ...newSnippets],
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
      return { workspaces, activeWorkspaceId, maximized, minimized }
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

  setActive: (id) =>
    set((s) => ({
      activeWorkspaceId: id,
      previousWorkspaceId: s.activeWorkspaceId !== id ? s.activeWorkspaceId : s.previousWorkspaceId,
    })),

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
      return {
        maximized,
        minimized,
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

  restartPane: (paneId) =>
    set((s) => ({ paneEpoch: { ...s.paneEpoch, [paneId]: (s.paneEpoch[paneId] ?? 0) + 1 } })),

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

  toggleMinimize: (workspaceId, paneId) =>
    set((s) => {
      const current = s.minimized[workspaceId] ?? []
      const next = current.includes(paneId)
        ? current.filter((id) => id !== paneId)
        : [...current, paneId]
      return { minimized: { ...s.minimized, [workspaceId]: next } }
    }),

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

  setWizardOpen: (open) => set({ wizardOpen: open }),

  setPaletteOpen: (open) => set({ paletteOpen: open }),
}))
