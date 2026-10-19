/**
 * Git chip under a workspace name (E2-FR-50): `main +142 -37 · 5` plus
 * ahead/behind arrows, from RemoteWorkspaceInfo.git (E7-FR-09). A tap opens
 * the workspace's Changes screen (E3-FR-52). Nothing at all (no reserved
 * space) without the field.
 */
import type { ReactNode } from 'react'
import type { RemoteGitChip } from '@shared/remote-protocol'
import { openChanges } from '../../lib/changes'
import { t } from '../../lib/i18n'

/** The chip text, exported for tests. */
export function gitChipText(git: RemoteGitChip): string {
  const parts = [git.branch]
  if (git.added || git.removed) parts.push(`+${git.added} -${git.removed}`)
  let text = parts.join(' ')
  if (git.files) text += ` · ${git.files}`
  if (git.ahead) text += ` ↑${git.ahead}`
  if (git.behind) text += ` ↓${git.behind}`
  return text
}

export function GitChip({ git, workspaceId }: { git?: RemoteGitChip; workspaceId: string }): ReactNode {
  if (!git) return null
  return (
    <button
      type="button"
      data-git-chip
      onClick={() => openChanges(workspaceId)}
      title={t('home.git', { branch: git.branch })}
      aria-label={t('changes.openFor', { branch: git.branch })}
      className="block min-h-7 max-w-full truncate rounded-btn px-1 text-left font-mono text-[12px] leading-7 text-text-secondary active:bg-card"
    >
      {gitChipText(git)}
    </button>
  )
}
