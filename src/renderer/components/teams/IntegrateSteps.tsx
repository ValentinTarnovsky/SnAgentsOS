import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { Check, Circle, Loader2, Minus, X } from 'lucide-react'
import type { IntegrateError, IntegrateStep } from '@shared/teams'
import type { IntegrateStepState, VerifyNote } from '@shared/team-protocol'
import { useT, type MessageKey } from '@/i18n'
import { cn } from '@/lib/cn'
import { INTEGRATE_STEPS, VERIFY_NOTE_KEY, failedLanding, integrateErrorKey, isVerifyNote, tailLines, type FailedLanding } from '@/lib/teams/integrate'
import { visibleName } from '@/lib/teams/issues'

const STEP_KEY: Record<IntegrateStep, MessageKey> = {
  preflight: 'teams.integrate.step.preflight',
  temp: 'teams.integrate.step.temp',
  merge: 'teams.integrate.step.merge',
  verify: 'teams.integrate.step.verify',
  land: 'teams.integrate.step.land',
  cleanup: 'teams.integrate.step.cleanup',
}

const STATE_KEY: Record<IntegrateStepState, MessageKey> = {
  pending: 'teams.integrate.stepState.pending',
  running: 'teams.integrate.stepState.running',
  ok: 'teams.integrate.stepState.ok',
  failed: 'teams.integrate.stepState.failed',
  skipped: 'teams.integrate.stepState.skipped',
}

/** Files named in an error (conflicts, what the merge would overwrite): the first ones, then how many more. */
const FILES_SHOWN = 20

/** The glyph of a step: never color alone, the state is also written beside it. */
function StepGlyph({ state }: { state: IntegrateStepState }) {
  switch (state) {
    case 'running':
      return <Loader2 size={13} aria-hidden className="shrink-0 animate-spin text-state-working" />
    case 'ok':
      return <Check size={13} aria-hidden className="shrink-0 text-state-done" />
    case 'failed':
      return <X size={13} aria-hidden className="shrink-0 text-state-error" />
    case 'skipped':
      return <Minus size={13} aria-hidden className="shrink-0 text-text-secondary" />
    default:
      return <Circle size={13} aria-hidden className="shrink-0 text-text-secondary/60" />
  }
}

/**
 * The end of an output (the verification's, or git's for an error), as text
 * only: every line through visibleLine and capped (tailLines). While it is
 * live it keeps its newest line in view.
 */
export function IntegrateTail({ text, live, label }: { text: string; live?: boolean; label: MessageKey }) {
  const t = useT()
  const ref = useRef<HTMLPreElement | null>(null)
  const { lines, cut } = tailLines(text)
  useLayoutEffect(() => {
    const el = ref.current
    if (el && live) el.scrollTop = el.scrollHeight
  }, [text, live])
  if (lines.length === 0) return null
  return (
    <div data-integrate-tail className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-medium text-text-secondary">{t(label)}</span>
      <pre
        ref={ref}
        tabIndex={0}
        aria-label={t(label)}
        className="max-h-48 min-w-0 overflow-auto whitespace-pre-wrap break-all rounded-btn border border-border bg-bg-primary px-2.5 py-1.5 font-mono text-[11px] leading-[1.45] text-text-primary outline-none focus-visible:ring-1 focus-visible:ring-accent-violet/60"
      >
        {lines.join('\n')}
      </pre>
      {cut && <span className="text-[11px] text-text-secondary">{t('teams.integrate.tailCut', { count: lines.length })}</span>}
    </div>
  )
}

/** What the verify runner itself had to do, in the catalog's words (main sends only the code); nothing for another value. */
export function VerifyNoteLine({ note, className }: { note: VerifyNote | undefined; className?: string }) {
  const t = useT()
  if (!isVerifyNote(note)) return null
  return (
    <p data-integrate-verify-note={note} className={cn('break-words text-[11px] text-text-secondary', className)}>
      {t(VERIFY_NOTE_KEY[note])}
    </p>
  )
}

/**
 * The steps of one integrate as main streams them (app 2.7.0, E10 B6): check
 * the task worktree, a temporary copy of the base, the merge, the
 * verification (with its output while it runs and the runner's own note at
 * its end), the landing on the base and the cleanup. A step main has not
 * reached yet waits.
 */
export function IntegrateSteps({ steps, base, logTail, verifyCommand, verifyNote }: { steps: Partial<Record<IntegrateStep, IntegrateStepState>>; base: string; logTail?: string; verifyCommand?: string; verifyNote?: VerifyNote }) {
  const t = useT()
  return (
    <ol data-integrate-steps className="flex min-w-0 flex-col gap-1.5">
      {INTEGRATE_STEPS.map((step) => {
        const state = steps[step] ?? 'pending'
        return (
          <li key={step} data-integrate-step={step} data-step-state={state} className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-2 text-xs">
              <StepGlyph state={state} />
              <span className={cn('min-w-0 flex-1 break-words', state === 'pending' ? 'text-text-secondary' : 'text-text-primary')}>{t(STEP_KEY[step], { base: visibleName(base) })}</span>
              <span className="shrink-0 text-[11px] text-text-secondary">{t(STATE_KEY[state])}</span>
            </div>
            {step === 'verify' && verifyCommand && state !== 'pending' && state !== 'skipped' && (
              <code className="ml-5 min-w-0 break-all font-mono text-[11px] text-text-secondary">{visibleName(verifyCommand)}</code>
            )}
            {step === 'verify' && state === 'skipped' && <p className="ml-5 text-[11px] text-text-secondary">{t('teams.integrate.verifySkipped')}</p>}
            {step === 'verify' && logTail && (
              <div className="ml-5 min-w-0">
                <IntegrateTail text={logTail} live={state === 'running'} label="teams.integrate.tail" />
              </div>
            )}
            {step === 'verify' && <VerifyNoteLine note={verifyNote} className="ml-5" />}
          </li>
        )
      })}
    </ol>
  )
}

/**
 * One integrate error (app 2.7.0, E10 B6): what happened and what to do, in
 * the catalog's words (`data-integrate-error={code}`), the files it names
 * (conflicts, files the merge would overwrite, the changes of a dirty base),
 * where the base is open for `base_checked_out_elsewhere`, the output and the
 * verify runner's note when the steps do not already show them, and its
 * actions (the caller's buttons). Repo text is spelled out, never HTML.
 * `filesMore`: the files main left out of `files` (a dirty base's list is
 * capped at 50 in main), counted in "N más". `step` and `landing`: where it
 * failed and, at step land, how it was landing (a timeout of an ffOnly or an
 * updateRef landing reads apart, integrateErrorKey); undefined when not known.
 */
export function IntegrateErrorView({ error, step, landing, base, branch, files, filesMore, path, tail, verifyNote, actions, name }: { error: IntegrateError; step: IntegrateStep | undefined; landing?: FailedLanding; base: string; branch: string; files?: readonly string[]; filesMore?: number; path?: string; tail?: string; verifyNote?: VerifyNote; actions?: ReactNode; name?: string }) {
  const t = useT()
  const shown = (files ?? []).slice(0, FILES_SHOWN)
  const unsent = typeof filesMore === 'number' && Number.isFinite(filesMore) && filesMore > 0 ? Math.floor(filesMore) : 0
  const more = (files?.length ?? 0) - shown.length + unsent
  // The output of a verification, also one the exit hooks stopped midway (interrupted at the verify step).
  const verify = error === 'verify_failed' || error === 'verify_timeout' || step === 'verify'
  return (
    <div data-integrate-error={error} {...(name ? { 'data-integrate-error-at': name } : {})} className="flex min-w-0 flex-col gap-2 rounded-btn border border-state-action/50 bg-state-action/10 px-3 py-2">
      <p className="break-words text-xs text-text-primary">{t(integrateErrorKey(error, step, failedLanding(landing)), { base: visibleName(base), branch: visibleName(branch) })}</p>
      {shown.length > 0 && (
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[11px] font-medium text-text-secondary">{t('teams.integrate.files')}</span>
          <ul data-integrate-files className="flex min-w-0 flex-col gap-0.5">
            {shown.map((f, i) => (
              <li key={i} data-integrate-file className="min-w-0 break-all font-mono text-[11px] text-text-primary">
                {visibleName(f)}
              </li>
            ))}
          </ul>
          {more > 0 && <span className="text-[11px] text-text-secondary">{t('teams.integrate.filesMore', { count: more })}</span>}
        </div>
      )}
      {path && <p className="min-w-0 break-all text-[11px] text-text-secondary">{t('teams.integrate.path', { path: visibleName(path) })}</p>}
      {tail && <IntegrateTail text={tail} label={verify ? 'teams.integrate.tail' : 'teams.integrate.output'} />}
      <VerifyNoteLine note={verifyNote} />
      {actions && <div className="flex min-w-0 flex-wrap items-center gap-1.5">{actions}</div>}
    </div>
  )
}
