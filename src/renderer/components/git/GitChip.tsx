import { ArrowDown, ArrowUp, GitBranch } from 'lucide-react'
import type { GitSummary } from '@shared/git-types'
import { useLang, useT, type TFn } from '@/i18n'
import { Tooltip } from '@/components/ui/Tooltip'
import { addedLabel, aheadBehind, chipBranch, chipDirty, lastChangeTime, removedLabel } from '@/lib/gitChip'
import { cn } from '@/lib/cn'

/** Full spoken label of a chip (a11y): "Branch main, 5 files changed, 142 lines added, ...". */
export function gitAriaLabel(s: GitSummary, t: TFn): string {
  const ab = aheadBehind(s)
  const parts = [t('git.aria.branch', { branch: chipBranch(s) })]
  if (chipDirty(s)) {
    parts.push(t('git.aria.files', { count: s.files }), t('git.aria.added', { count: s.added }), t('git.aria.removed', { count: s.removed }))
  }
  if (ab.ahead > 0) parts.push(t('git.aria.ahead', { count: ab.ahead }))
  if (ab.behind > 0) parts.push(t('git.aria.behind', { count: ab.behind }))
  if (s.conflicts > 0) parts.push(t(s.conflicts === 1 ? 'git.conflictOne' : 'git.conflictMany', { count: s.conflicts }))
  if (s.op) parts.push(t(`git.op.${s.op}`))
  return parts.join(', ')
}

/** "+142 -37" in the theme's ansi green and red. */
export function GitCounts({ summary, className }: { summary: GitSummary; className?: string }) {
  return (
    <span className={cn('whitespace-nowrap font-mono', className)}>
      <span className="text-ansi-green">{addedLabel(summary)}</span> <span className="text-ansi-red">{removedLabel(summary)}</span>
    </span>
  )
}

function GitTip({ summary, cwd, setupName }: { summary: GitSummary; cwd: string; setupName?: string }) {
  const t = useT()
  const lang = useLang()
  return (
    <span className="flex max-w-[360px] flex-col gap-0.5" data-git-tip>
      <span className="break-all font-mono">{cwd}</span>
      <span className="font-normal text-text-secondary">
        {summary.upstream ? t('git.tip.upstream', { name: summary.upstream }) : t('git.tip.noUpstream')}
      </span>
      {summary.upstream && <span className="font-normal text-text-secondary">{t('git.tip.abNote')}</span>}
      {summary.detached && summary.headShort && <span className="font-normal text-text-secondary">{t('git.tip.detached', { sha: summary.headShort })}</span>}
      {summary.unborn && <span className="font-normal text-text-secondary">{t('git.tip.unborn')}</span>}
      {summary.approx && <span className="font-normal text-text-secondary">{t('git.tip.approx')}</span>}
      {summary.truncated && <span className="font-normal text-text-secondary">{t('git.tip.truncated')}</span>}
      {setupName && <span className="font-normal text-text-secondary">{t('git.tip.setup', { name: setupName })}</span>}
      {summary.updatedAt > 0 && (
        <span className="font-normal text-text-secondary">{t('git.tip.lastChange', { time: lastChangeTime(summary.updatedAt, lang) })}</span>
      )}
      <span className="font-normal text-text-secondary">{t('git.tip.open')}</span>
    </span>
  )
}

/**
 * Workspace header chip (E7-FR-07): `[branch] main  +142 -37  5 files  ↑2 ↓1`,
 * a red conflicts badge and a REBASE / MERGE / CHERRY-PICK tag. Clean repos
 * show only the branch, muted. The cwd moves to the tooltip.
 */
export function GitChip({
  summary,
  cwd,
  setupName,
  onClick,
}: {
  summary: GitSummary
  cwd: string
  setupName?: string
  onClick: () => void
}) {
  const t = useT()
  const dirty = chipDirty(summary)
  const ab = aheadBehind(summary)
  return (
    <Tooltip label={<GitTip summary={summary} cwd={cwd} setupName={setupName} />} side="bottom" className="min-w-0">
      <button
        type="button"
        onClick={onClick}
        aria-label={gitAriaLabel(summary, t)}
        data-git-chip
        className="flex min-w-0 items-center gap-2 overflow-hidden rounded-btn px-1.5 py-0.5 text-xs transition-colors hover:bg-card"
      >
        <span className={cn('flex min-w-0 items-center gap-1 font-mono', dirty ? 'text-text-primary' : 'text-text-secondary')}>
          <GitBranch size={13} className="shrink-0" />
          <span className="truncate">{chipBranch(summary)}</span>
        </span>
        {dirty && <GitCounts summary={summary} className="shrink-0" />}
        {dirty && (
          <span className="shrink-0 whitespace-nowrap text-text-secondary">
            {t(summary.files === 1 ? 'git.fileOne' : 'git.fileMany', { count: summary.files })}
          </span>
        )}
        {(ab.ahead > 0 || ab.behind > 0) && (
          <span className="flex shrink-0 items-center gap-1 font-mono text-text-secondary">
            {ab.ahead > 0 && (
              <span className="flex items-center">
                <ArrowUp size={11} />
                {ab.ahead}
              </span>
            )}
            {ab.behind > 0 && (
              <span className="flex items-center">
                <ArrowDown size={11} />
                {ab.behind}
              </span>
            )}
          </span>
        )}
        {summary.conflicts > 0 && (
          <span className="shrink-0 whitespace-nowrap rounded-full bg-state-error px-1.5 text-[10px] font-semibold leading-4 text-white">
            {t(summary.conflicts === 1 ? 'git.conflictOne' : 'git.conflictMany', { count: summary.conflicts })}
          </span>
        )}
        {summary.op && (
          <span className="shrink-0 rounded border border-state-action/60 px-1 text-[10px] font-semibold leading-4 text-state-action">
            {t(`git.op.${summary.op}`)}
          </span>
        )}
      </button>
    </Tooltip>
  )
}
