import type { Workspace } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { useGitStore } from '@/lib/gitStore'
import { gitChipEnabled, workspaceGitKey } from '@/lib/gitChip'
import { refreshGit } from '@/lib/gitSync'
import { useT } from '@/i18n'
import { Tooltip } from '@/components/ui/Tooltip'
import { GitChip } from './GitChip'

/**
 * What follows the workspace name in its header: the git chip when the cwd is
 * a repo and settings.gitChip is on (E7-FR-07), otherwise the cwd as before.
 * A repo git refuses to read (dubious ownership) keeps the cwd, with the
 * command that would trust it in the tooltip; safe.directory is never touched.
 */
export function WorkspaceGitLabel({ workspace }: { workspace: Workspace }) {
  const t = useT()
  const key = workspaceGitKey(workspace.id)
  const chipOn = useAppStore((s) => gitChipEnabled(s.settings))
  const setupName = useAppStore((s) => (workspace.setupId ? s.connections.find((c) => c.id === workspace.setupId)?.name : undefined))
  const summary = useGitStore((s) => s.summaries[key])
  const error = useGitStore((s) => s.errors[key])
  const openChanges = useGitStore((s) => s.openChanges)

  if (chipOn && summary && workspace.cwd) {
    return (
      <GitChip
        summary={summary}
        cwd={workspace.cwd}
        setupName={workspace.setupId ? (setupName ?? workspace.setupId) : undefined}
        onClick={() => {
          refreshGit([key])
          openChanges(key)
        }}
      />
    )
  }
  const cwd = <span className="truncate font-mono text-xs text-text-secondary">{workspace.cwd}</span>
  if (chipOn && error === 'unsafe_repo' && workspace.cwd) {
    return (
      <Tooltip label={<span className="max-w-[360px] break-all">{t('git.err.unsafe', { path: workspace.cwd.replace(/\\/g, '/') })}</span>} side="bottom" className="min-w-0 truncate">
        {cwd}
      </Tooltip>
    )
  }
  return cwd
}
