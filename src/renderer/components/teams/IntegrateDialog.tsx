/**
 * "Integrar" (app 2.7.0, E10 B6): the merge of a task branch into its base,
 * opened from Te necesita or the task drawer. First what it would be (the
 * commits and the files, the verification team.md declares, whether you
 * confirmed it and, for an install, that its node_modules are built in the
 * temporary copy, how it reaches the base or why it cannot (a dirty base names
 * its files), a change to the team definition, and that the repo's git hooks
 * do not run on this merge),
 * then Integrar with the tip on screen, its steps live with the
 * verification's output, and the result: a merge commit on the base (with
 * the offer to delete the task worktree) or an error that says what happened
 * and what to do (ask the Dev to rebase or to fix it, a console in the task
 * worktree, check again). While it runs Esc, the backdrop and Cerrar do
 * nothing: it does not stop halfway. Cancel holds the focus, so Enter never
 * integrates on its own. Mounted once in App; nothing while closed.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCheck, GitBranch, GitMerge, Loader2, ShieldAlert, X } from 'lucide-react'
import { labOn } from '@shared/labs'
import type { IntegrateError, IntegrateStep } from '@shared/teams'
import type { ApprovalView, VerifyNote } from '@shared/team-protocol'
import { useT, type TFn } from '@/i18n'
import { cn } from '@/lib/cn'
import { useAppStore } from '@/lib/store'
import { toast } from '@/lib/toast'
import { MAX_PANES } from '@/lib/worktrees'
import { useTeamsStore } from '@/lib/teamsStore'
import { taskKey, useBoardStore } from '@/lib/teams/board'
import {
  aheadText,
  askRebase,
  behindText,
  closeIntegrate,
  confirmVerifyCommand,
  failedLanding,
  integrateActions,
  integrateErrorKey,
  integrateFailText,
  integrateRunning,
  isIntegrateError,
  isStep,
  openIntegrate,
  openWorktreeConsole,
  reloadIntegrate,
  removeTaskWorktree,
  startIntegrate,
  useIntegrateStore,
  type FailedLanding,
} from '@/lib/teams/integrate'
import { visibleName } from '@/lib/teams/issues'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Tooltip } from '@/components/ui/Tooltip'
import { SMALL_BTN, SMALL_BTN_QUIET, SMALL_BTN_TEXT } from './RunHeader'
import { CHIP, CHIP_AMBER, CHIP_NEUTRAL } from './TaskCard'
import { IntegrateErrorView, IntegrateSteps } from './IntegrateSteps'

const SECTION = 'text-[11px] font-semibold uppercase tracking-wide text-text-secondary'
const HINT = 'text-[11px] text-text-secondary'
const CODE = 'min-w-0 break-all rounded border border-border bg-bg-primary px-1.5 py-0.5 font-mono text-[11px] text-text-primary'

export function IntegrateDialog() {
  const open = useIntegrateStore((s) => s.open)
  const disabled = useTeamsStore((s) => s.disabled)
  const teamsOn = useAppStore((s) => labOn(s.settings, 'teams'))
  // Labs off while open (here, or main answered `disabled`): nothing of Teams stays on screen.
  useEffect(() => {
    if (open && (disabled || !teamsOn)) closeIntegrate()
  }, [open, disabled, teamsOn])
  if (!open || disabled || !teamsOn) return null
  return <DialogBody key={`${open.teamId}/${open.taskId}`} teamId={open.teamId} taskId={open.taskId} />
}

/** The way out of an error, as integrateActions orders it; each button waits while another request is on its way. */
function ErrorActions({ teamId, taskId, error, path }: { teamId: string; taskId: string; error: IntegrateError; path?: string }) {
  const t = useT()
  const busy = useIntegrateStore((s) => s.busy)
  const rebase = (why: 'conflict' | 'verify'): void => {
    void askRebase(why).then((fail) => {
      if (!fail) toast.success(t(why === 'conflict' ? 'teams.integrate.asked.conflict' : 'teams.integrate.asked.verify'))
    })
  }
  const openConsole = (cwd: string): void => {
    const r = openWorktreeConsole(teamId, cwd, t('teams.integrate.consoleTitle', { id: taskId }))
    if (r === 'full') toast.error(t('teams.integrate.consoleFull', { max: MAX_PANES }))
    else if (r === 'none') toast.error(t('teams.integrate.consoleNone'))
  }
  return (
    <>
      {integrateActions(error).map((a) => {
        switch (a) {
          case 'rebase':
          case 'fix': {
            const why = a === 'rebase' ? 'conflict' : 'verify'
            return (
              <button key={a} type="button" data-integrate-ask-rebase={why} disabled={!!busy} onClick={() => rebase(why)} className={cn(SMALL_BTN, SMALL_BTN_TEXT)}>
                {busy === 'rebase' && <Loader2 size={13} aria-hidden className="animate-spin" />}
                {t(a === 'rebase' ? 'teams.integrate.action.rebase' : 'teams.integrate.action.fix')}
              </button>
            )
          }
          case 'console':
            return path ? (
              <button key={a} type="button" data-integrate-console disabled={!!busy} onClick={() => openConsole(path)} className={cn(SMALL_BTN, SMALL_BTN_TEXT)}>
                {t('teams.integrate.action.console')}
              </button>
            ) : null
          case 'retry':
            return (
              <button key={a} type="button" data-integrate-retry disabled={!!busy} onClick={() => reloadIntegrate()} className={cn(SMALL_BTN, SMALL_BTN_QUIET)}>
                {t('teams.integrate.action.retry')}
              </button>
            )
        }
      })}
    </>
  )
}

function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : ''
}

function DialogBody({ teamId, taskId }: { teamId: string; taskId: string }) {
  const t = useT()
  const s = useIntegrateStore()
  const detail = useBoardStore((st) => st.tasks[taskKey(teamId, taskId)]?.detail)
  const summary = useBoardStore((st) => st.pages[teamId]?.first.find((x) => x.id === taskId) ?? st.pages[teamId]?.olderDone.find((x) => x.id === taskId))
  const view = useTeamsStore((st) => st.views[teamId])
  const removing = useIntegrateStore((st) => !!st.removing[taskKey(teamId, taskId)])
  const [askRemove, setAskRemove] = useState(false)
  const running = integrateRunning(s)
  const p = s.preview

  // Esc closes only this dialog (never Teams behind it); while it runs it closes nothing at all.
  const runningRef = useRef(running)
  runningRef.current = running
  const confirmRef = useRef(askRemove)
  confirmRef.current = askRemove
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.isComposing) return
      // The delete confirm over it takes its own Esc.
      if (confirmRef.current) return
      e.preventDefault()
      e.stopPropagation()
      if (!runningRef.current) closeIntegrate()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const title = detail?.title ?? summary?.title ?? ''
  const branch = p?.branch ?? detail?.worktree?.branch ?? detail?.branch ?? summary?.branch ?? ''
  const base = p?.base ?? detail?.worktree?.baseBranch ?? view?.baseBranch ?? ''
  const wt = detail?.worktree
  const wtPath = wt && wt.exists !== false ? wt.path : undefined
  const verifyCmd = p && 'command' in p.verify && p.verify.confirmed ? p.verify.command : undefined
  // A failure main kept from an earlier attempt (a quit mid-integrate reads `interrupted`), until this dialog has its own.
  const last = !s.result && !running && detail?.integrate?.state === 'failed' && isIntegrateError(detail.integrate.error) ? detail.integrate : undefined
  // A branch already in its base lands nothing (main marks the task done after the preflight): no landing blocks it.
  const landBlocked = p && !p.alreadyMerged && 'blocked' in p.landing ? p.landing : undefined
  const canStart = !!p && s.phase === 'preview' && !p.error && !landBlocked && !s.busy
  const result = s.result
  const offerRemove = s.phase === 'done' && !!result?.ok && !!wtPath && !s.removed
  // `step`: where it failed (a preview or a refusal before the run passes preflight: nothing touched the checkout);
  // `landing`: how a failed landing was landing.
  const errorView = (error: IntegrateError, o: { step: IntegrateStep | undefined; landing?: FailedLanding; files?: readonly string[]; filesMore?: number; path?: string; tail?: string; verifyNote?: VerifyNote; name?: string }) => (
    <IntegrateErrorView
      error={error}
      step={o.step}
      landing={o.landing}
      base={base}
      branch={branch}
      files={o.files}
      filesMore={o.filesMore}
      path={o.path}
      tail={o.tail}
      verifyNote={o.verifyNote}
      name={o.name}
      actions={running ? undefined : <ErrorActions teamId={teamId} taskId={taskId} error={error} path={wtPath} />}
    />
  )

  return createPortal(
    <div className="fixed inset-0 z-[75] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/60" onClick={() => !running && closeIntegrate()} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="team-integrate-title"
        data-integrate-dialog={taskId}
        data-integrate-phase={s.phase}
        aria-busy={running || s.phase === 'loading' || undefined}
        tabIndex={-1}
        className="relative z-10 flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-modal border border-border bg-card shadow-[0_20px_48px_-12px_rgba(0,0,0,0.6)] outline-none"
      >
        <div className="flex items-center gap-3 border-b border-border px-5 py-3">
          <GitMerge size={18} className="shrink-0 text-accent-violet" />
          <h2 id="team-integrate-title" className="flex min-w-0 flex-1 items-baseline gap-2 text-sm font-semibold text-text-primary">
            <span className="shrink-0">{t('teams.integrate.title', { id: taskId })}</span>
            {title && <span className="min-w-0 truncate font-normal text-text-secondary">{title}</span>}
          </h2>
          <Tooltip label={running ? t('teams.integrate.closeWait') : t('common.close')} side="bottom" className="shrink-0">
            <button
              type="button"
              data-integrate-close
              aria-label={running ? t('teams.integrate.closeWait') : t('common.close')}
              disabled={running}
              onClick={() => closeIntegrate()}
              className="rounded p-1 text-text-secondary hover:bg-bg-secondary hover:text-text-primary disabled:pointer-events-none disabled:opacity-40"
            >
              <X size={16} />
            </button>
          </Tooltip>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {last && (
            <div data-integrate-last={last.error} className="flex min-w-0 flex-col gap-1.5">
              <h3 className={SECTION}>{t('teams.integrate.last')}</h3>
              {/* Main keeps where it failed, how it was landing and the verify runner's note (B6 review, second round). */}
              {errorView(last.error as IntegrateError, { step: last.step, landing: failedLanding(last.landing), files: last.files, tail: last.tail, verifyNote: last.verifyNote, name: 'last' })}
            </div>
          )}

          {s.phase === 'loading' && !running && (
            <p data-integrate-loading className="flex items-center gap-2 text-xs text-text-secondary">
              <Loader2 size={13} className="animate-spin" />
              {t('teams.integrate.loading')}
            </p>
          )}

          {s.phase === 'preview' && s.loadFail && (
            <div data-integrate-load-failed={s.loadFail.error} className="flex min-w-0 flex-col gap-2">
              {isIntegrateError(s.loadFail.error) ? (
                errorView(s.loadFail.error, { step: 'preflight', files: s.loadFail.files, name: 'load' })
              ) : (
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <p className="min-w-0 break-words text-xs text-state-error">{integrateFailText('start', s.loadFail, t)}</p>
                  <button type="button" data-integrate-retry onClick={() => reloadIntegrate()} className={cn(SMALL_BTN, SMALL_BTN_QUIET)}>
                    {t('teams.integrate.action.retry')}
                  </button>
                </div>
              )}
            </div>
          )}

          {p && s.phase === 'preview' && (
            <div data-integrate-preview className="flex min-w-0 flex-col gap-4">
              <section data-integrate-summary className="flex min-w-0 flex-col gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-text-secondary">
                  <GitBranch size={13} aria-hidden className="shrink-0" />
                  <code data-integrate-branch className={CODE}>{visibleName(p.branch)}</code>
                  <span>{t('teams.integrate.into')}</span>
                  <code data-integrate-base className={CODE}>{visibleName(p.base)}</code>
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span data-integrate-ahead={p.ahead} className={cn(CHIP, CHIP_NEUTRAL, 'tabular-nums')}>
                    {p.ahead === 1 ? t('teams.integrate.commitsOne') : t('teams.integrate.commits', { count: p.ahead })}
                  </span>
                  {p.behind > 0 && (
                    <span data-integrate-behind={p.behind} className={cn(CHIP, CHIP_NEUTRAL, 'tabular-nums')}>
                      {behindText(p.behind, p.base, t)}
                    </span>
                  )}
                  <span data-integrate-stat className={cn(CHIP, CHIP_NEUTRAL, 'tabular-nums')}>
                    {t('teams.approval.stat', { files: p.stat.files, add: p.stat.insertions, del: p.stat.deletions })}
                  </span>
                </div>
                {p.stat.top.length > 0 && (
                  <ul className="flex min-w-0 flex-col gap-0.5 text-[11px] text-text-secondary">
                    {p.stat.top.map((f, i) => (
                      <li key={i} data-integrate-top className="flex min-w-0 items-center gap-2 font-mono">
                        <span className="min-w-0 flex-1 truncate">{visibleName(f.path)}</span>
                        <span className="shrink-0 tabular-nums">
                          +{f.add} -{f.del}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {p.alreadyMerged && (
                  <p data-integrate-already className="break-words text-xs text-text-primary">
                    {t('teams.integrate.alreadyMerged', { base: visibleName(p.base) })}
                  </p>
                )}
              </section>

              {p.error && errorView(p.error, { step: 'preflight', name: 'preview', path: undefined })}

              {!p.alreadyMerged && (
                <section data-integrate-verify={'command' in p.verify ? (p.verify.confirmed ? 'confirmed' : 'unconfirmed') : p.verify.suggested ? 'suggested' : 'none'} className="flex min-w-0 flex-col gap-1.5">
                  <h3 className={SECTION}>{t('teams.integrate.section.verify')}</h3>
                  {'command' in p.verify ? (
                    <>
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <code data-integrate-verify-command className={CODE}>{visibleName(p.verify.command)}</code>
                        <span className={cn(CHIP, p.verify.confirmed ? CHIP_NEUTRAL : CHIP_AMBER)}>{t(p.verify.confirmed ? 'teams.integrate.verify.confirmed' : 'teams.integrate.verify.unconfirmed')}</span>
                      </div>
                      <p className={HINT}>{t(p.verify.confirmed ? 'teams.integrate.verify.confirmedHint' : 'teams.integrate.verify.unconfirmedHint', { base: visibleName(p.base) })}</p>
                      {/* An install builds its own node_modules in the temporary copy (no link to the repo's), so it never touches yours. */}
                      {p.verify.installs && (
                        <p data-integrate-verify-installs className={HINT}>
                          {t('teams.integrate.verify.installs')}
                        </p>
                      )}
                      {!p.verify.confirmed && (
                        <div>
                          <button type="button" data-integrate-confirm-verify disabled={!!s.busy} onClick={() => void confirmVerifyCommand()} className={cn(SMALL_BTN, SMALL_BTN_TEXT)}>
                            {s.busy === 'verify' && <Loader2 size={13} aria-hidden className="animate-spin" />}
                            {t(s.busy === 'verify' ? 'teams.integrate.verify.confirming' : 'teams.integrate.verify.confirm')}
                          </button>
                        </div>
                      )}
                    </>
                  ) : p.verify.suggested ? (
                    <>
                      <p className="text-xs text-text-primary">{t('teams.integrate.verify.suggested')}</p>
                      <code data-integrate-verify-suggested className={cn(CODE, 'w-fit max-w-full')}>{visibleName(p.verify.suggested)}</code>
                      <p className={HINT}>{t('teams.integrate.verify.suggestedHint')}</p>
                    </>
                  ) : (
                    <p className="text-xs text-text-primary">{t('teams.integrate.verify.none')}</p>
                  )}
                </section>
              )}

              {!p.alreadyMerged && (
                <section data-integrate-landing={'mode' in p.landing ? p.landing.mode : 'blocked'} className="flex min-w-0 flex-col gap-1.5">
                  <h3 className={SECTION}>{t('teams.integrate.section.land', { base: visibleName(p.base) })}</h3>
                  {'mode' in p.landing ? (
                    <p className="break-words text-xs text-text-primary">{t(p.landing.mode === 'ffOnly' ? 'teams.integrate.land.ffOnly' : 'teams.integrate.land.updateRef', { base: visibleName(p.base) })}</p>
                  ) : (
                    <>
                      <p className="text-xs text-text-primary">{t('teams.integrate.land.blocked', { base: visibleName(p.base) })}</p>
                      {/* A dirty base names its changed files (main sends at most 50 and how many more). */}
                      {errorView(p.landing.blocked, { step: 'preflight', files: Array.isArray(p.landing.files) ? p.landing.files : undefined, filesMore: p.landing.filesMore, path: p.landing.path, name: 'landing' })}
                    </>
                  )}
                </section>
              )}

              {p.touchesDefinition && (
                <p data-integrate-touches-def className="flex min-w-0 items-start gap-1.5 break-words text-xs text-state-action">
                  <ShieldAlert size={13} aria-hidden className="mt-0.5 shrink-0" />
                  <span className="min-w-0">{t('teams.integrate.touchesDefinition')}</span>
                </p>
              )}
              {!p.alreadyMerged && (
                <p data-integrate-noverify className={HINT}>
                  {t('teams.integrate.noVerify')}
                </p>
              )}
            </div>
          )}

          {(running || (s.phase === 'done' && Object.keys(s.steps).length > 0)) && (
            <section data-integrate-run className="flex min-w-0 flex-col gap-2">
              {running && (
                <p data-integrate-running role="status" className="flex items-center gap-2 text-xs text-text-primary">
                  <Loader2 size={13} aria-hidden className="shrink-0 animate-spin text-state-working" />
                  <span className="min-w-0">{t(s.integrationId || s.phase === 'starting' ? 'teams.integrate.running' : 'teams.integrate.runningOpen')}</span>
                </p>
              )}
              <IntegrateSteps steps={s.steps} base={base} logTail={s.logTail} verifyCommand={verifyCmd} verifyNote={s.verifyNote} />
            </section>
          )}

          {result &&
            (result.ok ? (
              <div data-integrate-result="ok" role="status" className="flex min-w-0 flex-col gap-1 rounded-btn border border-state-done/40 bg-state-done/10 px-3 py-2">
                <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-text-primary">
                  <CheckCheck size={16} aria-hidden className="shrink-0 text-state-done" />
                  <span className="min-w-0 break-words">{t('teams.integrate.done', { base: visibleName(base) })}</span>
                </p>
                {result.landing === 'alreadyMerged' ? (
                  <p className="text-xs text-text-secondary">{t('teams.integrate.doneAlready', { base: visibleName(base) })}</p>
                ) : (
                  <p className="break-words text-xs text-text-secondary">
                    {result.mergeSha && <span data-integrate-sha={result.mergeSha}>{t('teams.integrate.doneSha', { sha: shortSha(result.mergeSha) })} </span>}
                    {result.landing && t(result.landing === 'ffOnly' ? 'teams.integrate.doneFf' : 'teams.integrate.doneRef', { base: visibleName(base) })}
                  </p>
                )}
                {s.removed && (
                  <p data-integrate-removed className="text-xs text-text-secondary">
                    {t('teams.integrate.removed')}
                  </p>
                )}
              </div>
            ) : (
              // The verification's output and its runner's note already show under its step while this dialog ran it.
              errorView(result.error, {
                step: result.step,
                landing: result.landing,
                files: result.files,
                tail: (result.step === 'verify' || result.error === 'verify_failed' || result.error === 'verify_timeout') && s.logTail ? undefined : result.tail,
                verifyNote: s.verifyNote ? undefined : result.verifyNote,
                name: 'result',
              })
            ))}

          {s.actionFail && (
            <p data-integrate-action-error={s.actionFail.what} role="alert" className="break-words text-xs text-state-error">
              {integrateFailText(s.actionFail.what, s.actionFail.fail, t)}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-bg-secondary/40 px-5 py-3">
          {running ? (
            <>
              <span className="mr-auto min-w-0 text-[11px] text-text-secondary">{t('teams.integrate.closeWait')}</span>
              <Button key="wait" variant="ghost" size="sm" disabled>
                {t('common.close')}
              </Button>
            </>
          ) : s.phase === 'done' ? (
            <>
              {offerRemove && (
                <Button key="remove" variant="ghost" size="sm" data-integrate-remove disabled={removing} onClick={() => setAskRemove(true)}>
                  {removing && <Loader2 size={16} className="animate-spin" />}
                  {t(removing ? 'teams.integrate.removing' : 'teams.integrate.remove')}
                </Button>
              )}
              <Button key="done" variant="ghost" size="sm" autoFocus data-integrate-done-close onClick={() => closeIntegrate()}>
                {t('common.close')}
              </Button>
            </>
          ) : (
            <>
              <Button key="cancel" variant="ghost" size="sm" autoFocus data-integrate-cancel onClick={() => closeIntegrate()}>
                {t('common.cancel')}
              </Button>
              <Button key="start" size="sm" data-integrate-start disabled={!canStart} onClick={() => void startIntegrate()}>
                {s.busy === 'start' && <Loader2 size={16} className="animate-spin" />}
                {t(s.busy === 'start' ? 'teams.integrate.starting' : 'teams.integrate.start')}
              </Button>
            </>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={askRemove}
        title={t('teams.integrate.removeTitle', { id: taskId })}
        message={t('teams.integrate.removeMsg', { branch: visibleName(branch), base: visibleName(base) })}
        confirmLabel={t('teams.integrate.removeYes')}
        cancelLabel={t('common.cancel')}
        danger
        onConfirm={() => {
          setAskRemove(false)
          void removeTaskWorktree(teamId, taskId)
        }}
        onCancel={() => setAskRemove(false)}
      />
    </div>,
    document.body,
  )
}

/**
 * A short line of an integrate error for a row (the full explanation, the dialog has its actions). `step` and
 * `landing`: where it failed and how a failed landing was landing, as main stored them; a timeout without them says
 * it may have been the landing of the checkout.
 */
export function integrateErrorLine(error: IntegrateError, step: IntegrateStep | undefined, landing: unknown, base: string, branch: string, t: TFn): string {
  return t(integrateErrorKey(error, isStep(step) ? step : undefined, failedLanding(landing)), { base: visibleName(base), branch: visibleName(branch) })
}

/**
 * The body of a branch ready to integrate in Te necesita (B6 replaces B5's
 * Marcar hecha): which branch goes into which base, how many commits, why the
 * last attempt failed, and Integrar..., which opens the dialog (an integrate
 * approval is landed by Integrar alone, never decided).
 */
export function IntegrateNeedBody({ teamId, approval }: { teamId: string; approval: ApprovalView }) {
  const t = useT()
  const p = approval.payload
  if (p.kind !== 'integrate') return null
  const taskId = approval.taskId
  return (
    <div data-approval-body="integrate" className="flex min-w-0 flex-col gap-2">
      <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-text-primary">
        <GitBranch size={13} className="shrink-0 text-text-secondary" aria-hidden />
        <span className="min-w-0 break-words">{t('teams.approval.integrateHint', { branch: visibleName(p.branch), base: visibleName(p.base) })}</span>
        {/* The commits main counted when it opened the approval (absent when it could not): never git per render. */}
        {p.ahead !== undefined && p.ahead > 0 && (
          <span data-need-ahead={p.ahead} className={cn(CHIP, CHIP_NEUTRAL, 'tabular-nums')}>
            {aheadText(p.ahead, t)}
          </span>
        )}
      </p>
      {p.lastError && isIntegrateError(p.lastError) && (
        <p data-approval-error="integrate" data-integrate-last-error={p.lastError} className="break-words text-[11px] text-state-action">
          {/* Where it failed and how it was landing, as main keeps them (B6 review, second round). */}
          {t('teams.approval.integrateFailed')} {integrateErrorLine(p.lastError, p.lastStep, p.lastLanding, p.base, p.branch, t)}
        </p>
      )}
      {taskId && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <button type="button" data-need-integrate={taskId} onClick={() => openIntegrate(teamId, taskId)} className={cn(SMALL_BTN, SMALL_BTN_TEXT)}>
            <GitMerge size={13} aria-hidden />
            {t('teams.integrate.open')}
          </button>
        </div>
      )}
    </div>
  )
}
