import type { GitSummary } from '@shared/git-types'
import { chipBranch, chipDirty } from '@/lib/gitChip'
import { GitCounts } from './GitChip'

/**
 * "· main +142 -37" after the console count of a sidebar row (E7-FR-08). The
 * count never shrinks (only `max-w-full` caps it), so this chip truncates
 * first and the count only once the chip has no room left.
 */
export function SidebarGitSuffix({ summary }: { summary: GitSummary }) {
  return (
    <span className="min-w-0 truncate pl-1" data-sidebar-git>
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
