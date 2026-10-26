import { useState } from 'react'
import { GitBranch } from 'lucide-react'
import type { Pane } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { useGitStore } from '@/lib/gitStore'
import { chipDirty, gitChipEnabled, paneGitKey } from '@/lib/gitChip'
import { openChangesPanel } from '@/lib/changesPanel'
import { useT } from '@/i18n'
import { Tooltip } from '@/components/ui/Tooltip'
import { GitCounts } from './GitChip'

/**
 * Branch chip of a worktree console (E7-FR-29): `[branch] sn/claude-3f2a +12 -3`
 * after the title, plus `main -N` (app 2.7.0, A9) while the workspace HEAD
 * has commits the branch lacks (main's live `mainBehind`, only with the git
 * chip on, like the counts). A click opens the Changes panel on this
 * worktree. The tooltip has the path, the base and the commits over it
 * (asked once, on hover).
 */
export function PaneWorktreeChip({ pane }: { pane: Pane }) {
  const t = useT()
  const wt = pane.worktree
  const key = paneGitKey(pane.id)
  const chipOn = useAppStore((s) => gitChipEnabled(s.settings))
  const summary = useGitStore((s) => s.summaries[key])
  const [ahead, setAhead] = useState<number | null>(null)
  if (!wt) return null
  // Gated like the counts: with the chip off main stops refreshing pane:<id>, so the number would freeze.
  const behind = chipOn ? (summary?.mainBehind ?? 0) : 0

  const loadAhead = (): void => {
    if (ahead !== null) return
    void window.snApi.git
      .worktreeInspect({ path: wt.path, base: wt.base })
      .then((r) => setAhead(r.exists ? r.commitsAhead : 0))
      .catch(() => undefined)
  }

  const tip = (
    <span className="flex max-w-[360px] flex-col gap-0.5" data-worktree-tip>
      <span className="break-all font-mono">{wt.path}</span>
      <span className="font-normal text-text-secondary">{t('worktree.chip.base', { sha: wt.base.slice(0, 7) })}</span>
      {ahead !== null && <span className="font-normal text-text-secondary">{t('worktree.chip.ahead', { count: ahead })}</span>}
      {behind > 0 && <span className="font-normal text-text-secondary">{t('worktree.chip.mainBehindTip', { count: behind })}</span>}
      <span className="font-normal text-text-secondary">{t('worktree.chip.open')}</span>
    </span>
  )

  return (
    <Tooltip label={tip} side="bottom" className="min-w-0 shrink">
      <button
        type="button"
        draggable={false}
        data-pane-worktree-chip={pane.id}
        onMouseEnter={loadAhead}
        onFocus={loadAhead}
        onClick={(e) => {
          e.stopPropagation()
          openChangesPanel(key)
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        className="flex min-w-0 items-center gap-1 overflow-hidden rounded px-1 py-0.5 text-[11px] transition-colors hover:bg-bg-secondary"
      >
        <GitBranch size={12} className="shrink-0 text-accent-violet" />
        <span className="truncate font-mono text-text-secondary">{wt.branch}</span>
        {chipOn && summary && chipDirty(summary) && <GitCounts summary={summary} className="shrink-0" />}
        {behind > 0 && (
          <span data-worktree-main-behind={behind} className="shrink-0 whitespace-nowrap font-mono text-text-secondary">
            {t('worktree.chip.mainBehind', { count: behind })}
          </span>
        )}
      </button>
    </Tooltip>
  )
}
