import { FolderX, GitBranch, Undo2 } from 'lucide-react'
import type { AgentPreset, Pane, Workspace } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { useWorktreeStore } from '@/lib/worktreeStore'
import { templateFromPane } from '@/lib/worktrees'
import { useT } from '@/i18n'

/**
 * A worktree console whose folder was deleted outside the app (E7-FR-36): the
 * console does not spawn. [Recreate on a new branch] opens the launch dialog
 * on the same repo and moves this console onto the new worktree; [Remove
 * worktree from pane] runs it in its normal folder again (the workspace cwd).
 */
export function WorktreeMissingCard({ workspace, pane, presets }: { workspace: Workspace; pane: Pane; presets: AgentPreset[] }) {
  const t = useT()
  const wt = pane.worktree
  if (!wt) return null

  const recreate = (): void => {
    useWorktreeStore.getState().openLaunch({
      workspaceId: workspace.id,
      repoCwd: wt.repoRoot,
      template: templateFromPane(pane, presets),
      replacePaneId: pane.id,
    })
  }
  const detach = (): void => {
    useAppStore.getState().setPaneWorktree(workspace.id, pane.id, null)
    useWorktreeStore.getState().clearMissing(pane.id)
  }

  return (
    <div data-pane-worktree-missing={pane.id} className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-xs text-text-secondary">
      <FolderX size={20} className="text-state-action" />
      <p className="font-medium text-text-primary">{t('worktree.missing.title')}</p>
      <p className="max-w-full break-all font-mono text-[11px]">{wt.path}</p>
      <div className="flex flex-wrap justify-center gap-2">
        <button
          data-worktree-recreate
          onClick={recreate}
          className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-text-primary transition-colors hover:bg-bg-secondary"
        >
          <GitBranch size={12} />
          {t('worktree.missing.recreate')}
        </button>
        <button
          data-worktree-detach
          onClick={detach}
          className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-text-primary transition-colors hover:bg-bg-secondary"
        >
          <Undo2 size={12} />
          {t('worktree.missing.remove')}
        </button>
      </div>
    </div>
  )
}
