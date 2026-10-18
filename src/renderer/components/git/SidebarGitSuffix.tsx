import type { GitSummary } from '@shared/git-types'
import { chipBranch, chipDirty } from '@/lib/gitChip'
import { GitCounts } from './GitChip'

/**
 * "· main +142 -37" after the console count of a sidebar row (E7-FR-08). It
 * shrinks a thousand times faster than the count, so the chip truncates first
 * and the count only after the chip is gone.
 */
export function SidebarGitSuffix({ summary }: { summary: GitSummary }) {
  return (
    <span className="min-w-0 shrink-[1000] truncate pl-1" data-sidebar-git>
      {'· '}
      <span className="font-mono">{chipBranch(summary)}</span>
      {chipDirty(summary) && (
        <>
          {' '}
          <GitCounts summary={summary} />
        </>
      )}
    </span>
  )
}
