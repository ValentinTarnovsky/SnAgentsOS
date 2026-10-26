import { useState } from 'react'
import { GitBranch, GitMerge, Loader2, Trash2 } from 'lucide-react'
import type { TaskDetail } from '@shared/team-protocol'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { taskKey } from '@/lib/teams/board'
import { aheadText, behindText, integrateFailText, isIntegrateError, openIntegrate, removeTaskWorktree, useIntegrateStore } from '@/lib/teams/integrate'
import { visibleName } from '@/lib/teams/issues'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { SMALL_BTN, SMALL_BTN_QUIET, SMALL_BTN_TEXT } from './RunHeader'
import { CHIP, CHIP_AMBER, CHIP_NEUTRAL } from './TaskCard'
import { integrateErrorLine } from './IntegrateDialog'
import { VerifyNoteLine } from './IntegrateSteps'

const SECTION = 'text-[11px] font-semibold uppercase tracking-wide text-text-secondary'

/**
 * The worktree section of the task drawer (app 2.7.0, E10 B6): the task's
 * own branch and folder (its base, how far ahead and behind main measured
 * it, a folder that is gone), where it stands with its base (ready to
 * integrate, integrating now, why the last attempt failed with the verify
 * runner's note main kept, integrated with
 * its merge commit), Integrar... while it waits for it, and "Borrar el
 * worktree" once the task is done or cancelled (its folder and its branch;
 * asked first; main refuses it while the tree has changes or the branch has
 * commits its base does not, and the refusal says which). Nothing for a task
 * without a worktree.
 */
export function TaskWorktreeSection({ teamId, detail }: { teamId: string; detail: TaskDetail }) {
  const t = useT()
  const removing = useIntegrateStore((s) => !!s.removing[taskKey(teamId, detail.id)])
  const [ask, setAsk] = useState(false)
  const wt = detail.worktree
  const integrated = detail.integratedInfo
  if (!wt && !integrated) return null
  const base = wt?.baseBranch ?? integrated?.base ?? ''
  const branch = wt?.branch ?? detail.branch ?? ''
  const gone = wt?.exists === false
  const waits = detail.state === 'review' && detail.phase === 'integrating'
  const st = detail.integrate
  const running = st?.state === 'running'
  const failed = waits && st?.state === 'failed' && isIntegrateError(st.error) ? st.error : undefined
  const canRemove = !!wt && !gone && (detail.state === 'done' || detail.state === 'cancelled')
  const status = integrated ? 'integrated' : running ? 'running' : failed ? 'failed' : waits ? 'ready' : null

  const remove = async (): Promise<void> => {
    const fail = await removeTaskWorktree(teamId, detail.id)
    if (fail) toast.error(integrateFailText('remove', fail, t))
    else toast.success(t('teams.integrate.removed'))
  }

  return (
    <section data-task-section="worktree" {...(status ? { 'data-worktree-status': status } : {})} className="flex min-w-0 flex-col gap-2 border-t border-border px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <h3 className={SECTION}>{t('teams.integrate.section')}</h3>
        {status === 'integrated' && <span className={cn(CHIP, CHIP_NEUTRAL)}>{t('teams.integrate.wt.integrated')}</span>}
        {status === 'failed' && <span className={cn(CHIP, CHIP_AMBER)}>{t('teams.integrate.wt.failed')}</span>}
      </div>
      {wt && (
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-text-secondary">
            <GitBranch size={13} aria-hidden className="shrink-0" />
            <code data-worktree-branch className="min-w-0 break-all font-mono text-[11px] text-text-primary">{visibleName(branch)}</code>
            <span className="min-w-0">{t('teams.integrate.wt.from', { base: visibleName(base) })}</span>
            {/* Main measures them in the task read (cached per tip); a folder that is gone has none. */}
            {!gone && wt.ahead !== undefined && wt.ahead > 0 && (
              <span data-worktree-ahead={wt.ahead} className={cn(CHIP, CHIP_NEUTRAL, 'tabular-nums')}>
                {aheadText(wt.ahead, t)}
              </span>
            )}
            {!gone && wt.behind !== undefined && wt.behind > 0 && (
              <span data-worktree-behind={wt.behind} className={cn(CHIP, CHIP_NEUTRAL, 'tabular-nums')}>
                {behindText(wt.behind, base, t)}
              </span>
            )}
          </div>
          {wt.path && <p data-worktree-path className="min-w-0 break-all font-mono text-[11px] text-text-secondary">{visibleName(wt.path)}</p>}
          {gone && (
            <p data-worktree-gone className="text-[11px] text-state-action">
              {t('teams.integrate.wt.gone')}
            </p>
          )}
        </div>
      )}
      {integrated && (
        <p data-worktree-integrated={integrated.mergeSha} className="break-words text-xs text-text-primary">
          {t('teams.integrate.wt.integratedInto', { base: visibleName(integrated.base), sha: integrated.mergeSha.slice(0, 7) })}
        </p>
      )}
      {!integrated && running && (
        <p className="flex items-center gap-1.5 text-xs text-text-primary">
          <Loader2 size={13} aria-hidden className="shrink-0 animate-spin text-state-working" />
          {t('teams.integrate.wt.running')}
        </p>
      )}
      {/* Where it failed, how it was landing and the verify runner's note, as main keeps them (B6 review, second round). */}
      {!integrated && !running && failed && (
        <p data-worktree-error={failed} className="break-words text-xs text-state-action">
          {integrateErrorLine(failed, st?.step, st?.landing, base, branch, t)}
        </p>
      )}
      {!integrated && !running && failed && <VerifyNoteLine note={st?.verifyNote} />}
      {!integrated && !running && !failed && waits && <p className="text-xs text-text-primary">{t('teams.integrate.wt.ready', { base: visibleName(base) })}</p>}
      {(waits || canRemove) && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {waits && (
            <button type="button" data-task-integrate={detail.id} onClick={() => openIntegrate(teamId, detail.id)} className={cn(SMALL_BTN, SMALL_BTN_TEXT)}>
              <GitMerge size={13} aria-hidden />
              {t('teams.integrate.open')}
            </button>
          )}
          {canRemove && (
            <button type="button" data-task-remove-worktree={detail.id} disabled={removing} onClick={() => setAsk(true)} className={cn(SMALL_BTN, SMALL_BTN_QUIET)}>
              {removing ? <Loader2 size={13} aria-hidden className="animate-spin" /> : <Trash2 size={13} aria-hidden />}
              {t(removing ? 'teams.integrate.removing' : 'teams.integrate.remove')}
            </button>
          )}
        </div>
      )}
      <ConfirmDialog
        open={ask}
        title={t('teams.integrate.removeTitle', { id: detail.id })}
        message={t(integrated ? 'teams.integrate.removeMsg' : 'teams.integrate.removeMsgUnmerged', { branch: visibleName(branch), base: visibleName(base) })}
        confirmLabel={t('teams.integrate.removeYes')}
        cancelLabel={t('common.cancel')}
        danger
        onConfirm={() => {
          setAsk(false)
          void remove()
        }}
        onCancel={() => setAsk(false)}
      />
    </section>
  )
}
