import { create } from 'zustand'
import type {
  AgentPreset,
  ConfigFile,
  GridPreset,
  Pane,
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

/** Grow the grid to fit `count` panes, never shrinking a deliberately larger grid. */
function growGrid(current: GridPreset | undefined, count: number): GridPreset {
  const needed = gridForCount(count)
  return current && current >= needed ? current : needed
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
  restoreLastWorkspace: true,
  confirmCloseRunning: true,
  closeToTray: true,
  launchOnStartup: false,
  globalHotkeyEnabled: false,
  globalHotkey: 'Super+Alt+O',
  keymap: {},
  sidebarCollapsed: false,
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
}

export interface AppState {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  /** Last active workspace (drives Ctrl+Tab quick-flip). */
  previousWorkspaceId: string | null
  sidebarCollapsed: boolean
  presets: AgentPreset[]
  snippets: Snippet[]
  settings: Settings
  settingsOpen: boolean
  wizardOpen: boolean
  paletteOpen: boolean
  /** workspaceId -> maximized paneId (transient; never persisted). */
  maximized: Record<string, string | null>
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
  setGrid: (workspaceId: string, grid: GridPreset) => void
  movePane: (workspaceId: string, paneId: string, toIndex: number) => void
  toggleMaximize: (workspaceId: string, paneId: string) => void
  clearMaximize: (workspaceId: string) => void

  savePreset: (preset: AgentPreset) => void
  deletePreset: (id: string) => void
  newPresetId: () => string

  saveSnippet: (snippet: Snippet) => void
  deleteSnippet: (id: string) => void
  newSnippetId: () => string

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
  settings: DEFAULT_SETTINGS,
  settingsOpen: false,
  wizardOpen: false,
  paletteOpen: false,
  maximized: {},
  paneEpoch: {},
  hydrated: false,

  hydrate: (config) =>
    set((s) => {
      if (!config) return { hydrated: true }
      const workspaces = config.workspaces ?? []
      const presets = config.presets && config.presets.length ? config.presets : s.presets
      const snippets = config.snippets ?? []
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
    }
    set((s) => ({ workspaces: [...s.workspaces, ws], activeWorkspaceId: ws.id }))
    return ws.id
  },

  importConfig: (config) =>
    set((s) => ({
      workspaces: config.workspaces ?? [],
      presets: config.presets && config.presets.length ? config.presets : s.presets,
      snippets: config.snippets ?? [],
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
      return {
        workspaces: [...s.workspaces, ...importedWs],
        presets: [...s.presets, ...newPresets],
        snippets: [...s.snippets, ...newSnippets],
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
      return { workspaces, activeWorkspaceId, maximized }
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
        const grid = growGrid(w.layout?.grid, panes.length)
        return { ...w, panes, layout: { grid, order } }
      }),
    })),

  removePane: (workspaceId, paneId) =>
    set((s) => {
      const maximized = { ...s.maximized }
      if (maximized[workspaceId] === paneId) maximized[workspaceId] = null
      return {
        maximized,
        workspaces: s.workspaces.map((w) => {
          if (w.id !== workspaceId) return w
          const panes = w.panes.filter((p) => p.id !== paneId)
          const order = (w.layout?.order ?? w.panes.map((p) => p.id)).filter((id) => id !== paneId)
          const grid = w.layout?.grid ?? gridForCount(panes.length)
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
        const grid = w.layout?.grid ?? gridForCount(w.panes.length)
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

  updateSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

  setSettingsOpen: (open) => set({ settingsOpen: open }),

  setWizardOpen: (open) => set({ wizardOpen: open }),

  setPaletteOpen: (open) => set({ paletteOpen: open }),
}))
