/**
 * Read-only git chip under a workspace name (E2-FR-50): `main +142 -37 · 5`
 * plus ahead/behind arrows, from RemoteWorkspaceInfo.git (E7-FR-09). No tap
 * in this epic, and nothing at all (no reserved space) without the field.
 */
import type { ReactNode } from 'react'
import type { RemoteGitChip } from '@shared/remote-protocol'
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

export function GitChip({ git }: { git?: RemoteGitChip }): ReactNode {
  if (!git) return null
  return (
    <span data-git-chip title={t('home.git', { branch: git.branch })} className="block truncate font-mono text-[12px] leading-tight text-text-secondary">
      {gitChipText(git)}
    </span>
  )
}
