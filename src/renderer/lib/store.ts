import { create } from 'zustand'
import type { AgentPreset, Pane, Settings, Workspace } from '@shared/types'

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
  { id: 'preset-claude', name: 'Claude Code', type: 'claude', command: 'claude', args: [], color: '#d97757', icon: 'sparkles' },
  { id: 'preset-codex', name: 'Codex', type: 'codex', command: 'codex', args: [], color: '#10a37f', icon: 'bot' },
]

const DEFAULT_SETTINGS: Settings = {
  defaultShell: {},
  fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
  fontSize: 13,
  accent: 'violet',
  scrollback: 5000,
  restoreLastWorkspace: true,
  confirmCloseRunning: true,
  sidebarCollapsed: false,
}

interface AppState {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  sidebarCollapsed: boolean
  presets: AgentPreset[]
  settings: Settings
  settingsOpen: boolean

  createWorkspace: (name: string, cwd: string) => string
  deleteWorkspace: (id: string) => void
  setActive: (id: string) => void
  toggleSidebar: () => void
  addPane: (workspaceId: string, pane?: Partial<Pane>) => void
  removePane: (workspaceId: string, paneId: string) => void

  savePreset: (preset: AgentPreset) => void
  deletePreset: (id: string) => void
  newPresetId: () => string

  updateSettings: (patch: Partial<Settings>) => void
  setSettingsOpen: (open: boolean) => void
}

export const useAppStore = create<AppState>((set) => ({
  workspaces: [],
  activeWorkspaceId: null,
  sidebarCollapsed: false,
  presets: DEFAULT_PRESETS,
  settings: DEFAULT_SETTINGS,
  settingsOpen: false,

  createWorkspace: (name, cwd) => {
    const ws: Workspace = { id: uid('ws'), name, cwd, panes: [makeShellPane(0)] }
    set((s) => ({ workspaces: [...s.workspaces, ws], activeWorkspaceId: ws.id }))
    return ws.id
  },

  deleteWorkspace: (id) =>
    set((s) => {
      const workspaces = s.workspaces.filter((w) => w.id !== id)
      const activeWorkspaceId =
        s.activeWorkspaceId === id ? (workspaces[0]?.id ?? null) : s.activeWorkspaceId
      return { workspaces, activeWorkspaceId }
    }),

  setActive: (id) => set({ activeWorkspaceId: id }),

  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  addPane: (workspaceId, pane) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w
        const newPane: Pane = { ...makeShellPane(w.panes.length), ...pane, id: uid('pane') }
        return { ...w, panes: [...w.panes, newPane] }
      }),
    })),

  removePane: (workspaceId, paneId) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === workspaceId ? { ...w, panes: w.panes.filter((p) => p.id !== paneId) } : w,
      ),
    })),

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

  updateSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

  setSettingsOpen: (open) => set({ settingsOpen: open }),
}))
