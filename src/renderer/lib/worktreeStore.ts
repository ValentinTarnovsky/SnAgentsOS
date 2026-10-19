import { create } from 'zustand'
import type { PaneType } from '@shared/types'

/** What a console created in a worktree copies from its preset or from the pane it duplicates. */
export interface PaneTemplate {
  /** Preset or pane name: the new title is `<name> · <slug>`. */
  name: string
  type: PaneType
  presetId?: string
  command?: string
  color: string
  icon: string
  fontSize?: number
}

/** The launch dialog (E7-FR-27), or "Recreate on a new branch" of the missing card (FR-36) when `replacePaneId` is set. */
export interface WorktreeLaunchRequest {
  workspaceId: string
  repoCwd: string
  template: PaneTemplate
  replacePaneId?: string
}

/**
 * The close dialog of a worktree pane (E7-FR-30), or the same check before
 * deleting an orphan from Settings (FR-31: no pane, so no Keep button).
 */
export interface WorktreeCloseRequest {
  workspaceId?: string
  paneId?: string
  path: string
  branch: string
  base?: string
}

/**
 * Transient worktree UI state: which dialog is open and which panes found
 * their worktree gone (FR-36). Never persisted; the worktree itself lives on
 * `pane.worktree` and in main's manifest.
 */
interface WorktreeState {
  launch: WorktreeLaunchRequest | null
  close: WorktreeCloseRequest | null
  /** paneId -> its worktree folder is gone (inspect said so, or a spawn failed with cwd_missing). */
  missing: Record<string, true>
  openLaunch: (req: WorktreeLaunchRequest) => void
  closeLaunch: () => void
  openClose: (req: WorktreeCloseRequest) => void
  closeClose: () => void
  markMissing: (paneId: string) => void
  clearMissing: (paneId: string) => void
}

export const useWorktreeStore = create<WorktreeState>((set, get) => ({
  launch: null,
  close: null,
  missing: {},
  openLaunch: (req) => set({ launch: req }),
  closeLaunch: () => set({ launch: null }),
  openClose: (req) => set({ close: req }),
  closeClose: () => set({ close: null }),
  markMissing: (paneId) => {
    if (get().missing[paneId]) return
    set((s) => ({ missing: { ...s.missing, [paneId]: true } }))
  },
  clearMissing: (paneId) => {
    if (!get().missing[paneId]) return
    set((s) => {
      const missing = { ...s.missing }
      delete missing[paneId]
      return { missing }
    })
  },
}))
