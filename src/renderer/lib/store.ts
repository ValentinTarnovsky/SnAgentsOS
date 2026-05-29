import { create } from 'zustand'
import type { Pane, Workspace } from '@shared/types'

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

interface AppState {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  sidebarCollapsed: boolean

  createWorkspace: (name: string, cwd: string) => string
  deleteWorkspace: (id: string) => void
  setActive: (id: string) => void
  toggleSidebar: () => void
  addPane: (workspaceId: string, pane?: Partial<Pane>) => void
  removePane: (workspaceId: string, paneId: string) => void
}

export const useAppStore = create<AppState>((set) => ({
  workspaces: [],
  activeWorkspaceId: null,
  sidebarCollapsed: false,

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
}))
