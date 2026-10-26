/**
 * "Nuevo equipo" (app 2.7.0, E10 B1). Steps: Repo (a workspace folder or the
 * folder picker; main finds the git main root), Adopt (the repo already
 * brings .snagentsos/team/: its risks, problems, the note on the user's own
 * allow rules and diffs, Cancel focused, "Confiar y agregar"), Edit (the
 * draft main proposed: name, goal, rules, base branch, agents at once, small
 * plans, verify, roles, daily summary and the access warnings) and Preview
 * (the exact files, written only with the hash of that preview). Main
 * renders, validates, writes and trusts; a write that lands opens the team.
 * Mounted once in App; nothing while closed.
 */
import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { FolderOpen, Loader2, ShieldAlert, Users } from 'lucide-react'
import { labOn } from '@shared/labs'
import { GOAL_MAX, RULES_MAX, TEAM_NAME_MAX } from '@shared/teams'
import { validBranchName, VERIFY_COMMAND_MAX, type TeamSetupDraft } from '@shared/teamDefinition'
import type { SetupProbe } from '@shared/team-protocol'
import { useLang, useT, type MessageKey } from '@/i18n'
import { cn } from '@/lib/cn'
import { useAppStore } from '@/lib/store'
import { useTeamsStore } from '@/lib/teamsStore'
import {
  adoptExisting,
  closeTeamSetup,
  draftWarnings,
  openRegistered,
  previewSetup,
  probeRepo,
  setDraft,
  setRoleDraft,
  setupBack,
  textBytes,
  TRUST_WARNINGS,
  useTeamSetupStore,
  writeSetup,
  type SetupNotice,
  type SetupStep,
} from '@/lib/teams/setup'
import { hasDefErrors } from '@/lib/teams/issues'
import { Button } from '@/components/ui/Button'
import { Toggle } from '@/components/settings/ui'
import { DefIssueList, TeamDiffView } from './TeamDiffView'
import { rolesValid, SetupRolesTable } from './SetupRolesTable'
import { SetupPreview, SetupWarnings } from './SetupPreview'
import { teamErrorText } from './TeamTrustDialog'

const STEP_NUM: Record<SetupStep, number> = { repo: 1, adopt: 2, edit: 2, preview: 3 }
const PARALLEL: readonly TeamSetupDraft['maxConcurrent'][] = [1, 2, 3]

const NOTICE_KEY: Record<SetupNotice, MessageKey> = {
  previewChanged: 'teams.setup.preview.changed',
  exists: 'teams.setup.exists',
  adoptChanged: 'teams.setup.adopt.changed',
}

const fieldCls =
  'w-full rounded-btn border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-violet/60'
const labelCls = 'text-xs font-medium text-text-secondary'
const hintCls = 'text-[11px] text-text-secondary/80'
const ghostBtn =
  'rounded-btn border border-border px-4 py-2 text-sm text-text-primary transition-colors hover:bg-card disabled:cursor-not-allowed disabled:opacity-50'

/** Workspace folders, once each (case-insensitive on Windows), in sidebar order. */
function workspaceDirs(ws: ReadonlyArray<{ id: string; name: string; cwd: string }>, win: boolean): Array<{ id: string; name: string; cwd: string }> {
  const seen = new Set<string>()
  const out: Array<{ id: string; name: string; cwd: string }> = []
  for (const w of ws) {
    const cwd = w.cwd?.trim()
    if (!cwd) continue
    const key = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
    const k = win ? key.toLowerCase() : key
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ id: w.id, name: w.name, cwd })
  }
  return out
}

function Field({ label, hint, children, extra }: { label: string; hint?: string; children: ReactNode; extra?: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className={labelCls}>{label}</span>
        {extra}
      </div>
      {children}
      {hint && <p className={hintCls}>{hint}</p>}
    </div>
  )
}

function SwitchRow({ field, title, hint, checked, onChange }: { field: string; title: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div data-setup-field={field} className="flex min-w-0 items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-sm text-text-primary">{title}</div>
        {hint && <p className={hintCls}>{hint}</p>}
      </div>
      <Toggle checked={checked} onChange={onChange} ariaLabel={title} />
    </div>
  )
}

function RepoStep() {
  const t = useT()
  const workspaces = useAppStore((s) => s.workspaces)
  const dir = useTeamSetupStore((s) => s.dir)
  const busy = useTeamSetupStore((s) => s.busy)
  const error = useTeamSetupStore((s) => s.error)
  const probe = useTeamSetupStore((s) => s.probe)
  const dirs = useMemo(() => workspaceDirs(workspaces, window.snApi?.platform === 'win32'), [workspaces])

  const browse = async (): Promise<void> => {
    const picked = await window.snApi.dialog.openDirectory()
    if (picked) void probeRepo(picked)
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-text-secondary">{t('teams.setup.repo.intro')}</p>
      <div className="space-y-1.5">
        <span className={labelCls}>{t('teams.setup.repo.workspaces')}</span>
        {dirs.length === 0 ? (
          <p className="text-xs text-text-secondary">{t('teams.setup.repo.noWorkspaces')}</p>
        ) : (
          <ul data-setup-dirs className="max-h-56 space-y-1 overflow-y-auto">
            {dirs.map((w) => (
              <li key={w.id}>
                <button
                  type="button"
                  data-setup-dir={w.cwd}
                  disabled={busy}
                  aria-pressed={dir === w.cwd}
                  onClick={() => void probeRepo(w.cwd)}
                  className={cn(
                    'flex w-full min-w-0 flex-col items-start rounded-btn border px-3 py-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                    dir === w.cwd ? 'border-accent-violet/60 bg-accent-violet/10' : 'border-border hover:bg-bg-secondary',
                  )}
                >
                  <span className="max-w-full truncate text-xs text-text-primary">{w.name}</span>
                  <span className="max-w-full truncate font-mono text-[11px] text-text-secondary">{w.cwd}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <button
        type="button"
        autoFocus
        data-setup-browse
        disabled={busy}
        onClick={() => void browse()}
        className="flex items-center gap-1.5 rounded-btn border border-border px-3 py-1.5 text-xs text-text-primary transition-colors hover:bg-bg-secondary disabled:cursor-not-allowed disabled:opacity-60"
      >
        <FolderOpen size={13} />
        {t('teams.setup.repo.browse')}
      </button>
      {busy && (
        <p data-setup-checking className="flex items-center gap-2 text-xs text-text-secondary">
          <Loader2 size={13} className="animate-spin" />
          {t('teams.setup.repo.checking')}
        </p>
      )}
      {!busy && error && (
        <p data-setup-error={error} className="break-all text-xs text-red-400">
          {teamErrorText(error, t)}
        </p>
      )}
      {!busy && probe?.registered && (
        <div data-setup-registered={probe.registered} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-btn border border-border bg-bg-secondary/60 px-3 py-2">
          <div className="min-w-0">
            <p className="text-xs text-text-primary">{t('teams.setup.repo.registered')}</p>
            <p className="truncate font-mono text-[11px] text-text-secondary">{probe.repoRoot}</p>
          </div>
          <Button size="sm" data-setup-open-registered onClick={() => void openRegistered()}>
            {t('teams.setup.repo.openTeam')}
          </Button>
        </div>
      )}
    </div>
  )
}

function RepoChip({ probe }: { probe: SetupProbe }) {
  return (
    <div data-setup-repo={probe.repoRoot} className="min-w-0 rounded-btn border border-border bg-bg-secondary/60 px-3 py-1.5">
      <span className="block truncate text-xs text-text-primary">{probe.repoName}</span>
      <span className="block truncate font-mono text-[11px] text-text-secondary">{probe.repoRoot}</span>
    </div>
  )
}

function AdoptStep({ probe }: { probe: SetupProbe }) {
  const t = useT()
  const existing = probe.existing
  if (!existing) return null
  return (
    <div className="min-w-0 space-y-4">
      <p className="text-xs text-text-secondary">{t('teams.setup.adopt.intro')}</p>
      <RepoChip probe={probe} />
      <DefIssueList issues={existing.issues} title={t('teams.setup.adopt.issues')} />
      <SetupWarnings warnings={TRUST_WARNINGS} />
      <TeamDiffView diff={existing.diff} />
    </div>
  )
}

function EditStep({ probe, draft }: { probe: SetupProbe; draft: TeamSetupDraft }) {
  const t = useT()
  const lang = useLang()
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => nameRef.current?.focus(), [])
  const goalBytes = textBytes(draft.goal)
  const goalOver = goalBytes > GOAL_MAX
  const kb = (n: number): string => new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(n / 1024)
  const warnings = draftWarnings(draft)
  const suggested = probe.suggestedVerify
  return (
    <div className="min-w-0 space-y-4">
      <RepoChip probe={probe} />
      <Field label={t('teams.setup.edit.name')}>
        <input
          ref={nameRef}
          type="text"
          data-setup-field="name"
          value={draft.name}
          maxLength={TEAM_NAME_MAX}
          aria-invalid={draft.name.trim() ? undefined : true}
          onChange={(e) => setDraft({ name: e.target.value })}
          className={cn(fieldCls, !draft.name.trim() && 'border-red-400/60')}
        />
        {!draft.name.trim() && <p data-setup-name-error className="text-xs text-red-400">{t('teams.setup.edit.nameRequired')}</p>}
      </Field>
      <Field
        label={t('teams.setup.edit.goal')}
        hint={t('teams.setup.edit.goalHint')}
        extra={
          <span data-setup-goal-size={goalBytes} className={cn('text-[11px] tabular-nums', goalOver ? 'text-red-400' : 'text-text-secondary')}>
            {t('teams.setup.edit.size', { used: kb(goalBytes), max: kb(GOAL_MAX) })}
          </span>
        }
      >
        <textarea
          rows={4}
          data-setup-field="goal"
          value={draft.goal}
          aria-invalid={goalOver || undefined}
          onChange={(e) => setDraft({ goal: e.target.value })}
          className={cn(fieldCls, 'resize-y', goalOver && 'border-red-400/60')}
        />
        {goalOver && <p data-setup-goal-error className="text-xs text-red-400">{t('teams.setup.edit.tooLong', { max: kb(GOAL_MAX) })}</p>}
      </Field>
      <Field label={t('teams.setup.edit.rules')} hint={t('teams.setup.edit.rulesHint')}>
        <textarea
          rows={3}
          data-setup-field="rules"
          value={draft.rules ?? ''}
          maxLength={RULES_MAX}
          onChange={(e) => setDraft({ rules: e.target.value || undefined })}
          className={cn(fieldCls, 'resize-y')}
        />
      </Field>
      <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t('teams.setup.edit.baseBranch')}>
          {probe.branches.length > 0 ? (
            <select
              data-setup-field="baseBranch"
              value={draft.baseBranch ?? ''}
              onChange={(e) => setDraft({ baseBranch: e.target.value || undefined })}
              className={fieldCls}
            >
              <option value="">{t('teams.setup.edit.baseAuto')}</option>
              {/* The current branch main proposed can sit past the probe's branch cap: it is always an option. */}
              {(draft.baseBranch && !probe.branches.includes(draft.baseBranch) ? [draft.baseBranch, ...probe.branches] : probe.branches).map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          ) : (
            <>
              <input
                type="text"
                data-setup-field="baseBranch"
                spellCheck={false}
                value={draft.baseBranch ?? ''}
                placeholder={t('teams.setup.edit.baseAuto')}
                aria-invalid={branchOk(draft.baseBranch) ? undefined : true}
                onChange={(e) => setDraft({ baseBranch: e.target.value.trim() || undefined })}
                className={cn(fieldCls, 'font-mono', !branchOk(draft.baseBranch) && 'border-red-400/60')}
              />
              {!branchOk(draft.baseBranch) && (
                <p data-setup-branch-error className="text-xs text-red-400">{t('teams.setup.edit.branchInvalid')}</p>
              )}
            </>
          )}
        </Field>
        <Field label={t('teams.setup.edit.parallel')} hint={t('teams.setup.edit.parallelHint')}>
          <div role="radiogroup" aria-label={t('teams.setup.edit.parallel')} className="flex gap-1.5">
            {PARALLEL.map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={draft.maxConcurrent === n}
                data-setup-parallel={n}
                onClick={() => setDraft({ maxConcurrent: n })}
                className={cn(
                  'h-8 w-10 rounded-full border text-xs font-medium tabular-nums transition-colors',
                  draft.maxConcurrent === n
                    ? 'border-accent-violet bg-accent-violet/15 text-text-primary'
                    : 'border-border text-text-secondary hover:bg-bg-secondary hover:text-text-primary',
                )}
              >
                {n}
              </button>
            ))}
          </div>
        </Field>
      </div>
      <SwitchRow
        field="leadApprovesSmallPlans"
        title={t('teams.setup.edit.leadApproves')}
        hint={t('teams.setup.edit.leadApprovesHint')}
        checked={draft.leadApprovesSmallPlans}
        onChange={(v) => setDraft({ leadApprovesSmallPlans: v })}
      />
      <Field
        label={t('teams.setup.edit.verify')}
        hint={t('teams.setup.edit.verifyHint')}
        extra={
          suggested && draft.verify !== suggested ? (
            <button
              type="button"
              data-setup-verify-suggest={suggested}
              onClick={() => setDraft({ verify: suggested })}
              className="min-w-0 truncate rounded-full border border-border px-2 py-0.5 text-[11px] text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
            >
              {t('teams.setup.edit.verifySuggest', { command: suggested })}
            </button>
          ) : undefined
        }
      >
        <input
          type="text"
          data-setup-field="verify"
          spellCheck={false}
          autoComplete="off"
          value={draft.verify ?? ''}
          maxLength={VERIFY_COMMAND_MAX}
          onChange={(e) => setDraft({ verify: e.target.value || undefined })}
          className={cn(fieldCls, 'font-mono')}
        />
      </Field>
      <div className="min-w-0 space-y-1.5">
        <span className={labelCls}>{t('teams.setup.edit.roles')}</span>
        <SetupRolesTable roles={draft.roles} onChange={setRoleDraft} />
        {!draft.roles.some((r) => r.kind === 'lead') && (
          <p data-setup-no-lead className="text-xs text-red-400">{t('teams.setup.roles.noLead')}</p>
        )}
      </div>
      <SwitchRow
        field="dailySummary"
        title={t('teams.setup.edit.dailySummary')}
        hint={t('teams.setup.edit.dailySummaryHint')}
        checked={draft.dailySummary}
        onChange={(v) => setDraft({ dailySummary: v })}
      />
      <SetupWarnings warnings={warnings} />
    </div>
  )
}

/** A base branch typed by hand (a repo without branches yet) passes git's name rules; empty means the current one. */
function branchOk(branch: string | undefined): boolean {
  return !branch || validBranchName(branch)
}

/** The draft can go to the preview: a name, a goal within its cap, a valid base branch, valid roles with a Lead. */
function draftReady(draft: TeamSetupDraft | undefined): boolean {
  return !!draft && draft.name.trim().length > 0 && textBytes(draft.goal) <= GOAL_MAX && branchOk(draft.baseBranch) && rolesValid(draft.roles)
}

export function TeamSetupDialog() {
  const t = useT()
  const open = useTeamSetupStore((s) => s.open)
  const step = useTeamSetupStore((s) => s.step)
  const probe = useTeamSetupStore((s) => s.probe)
  const draft = useTeamSetupStore((s) => s.draft)
  const preview = useTeamSetupStore((s) => s.preview)
  const busy = useTeamSetupStore((s) => s.busy)
  const error = useTeamSetupStore((s) => s.error)
  const issues = useTeamSetupStore((s) => s.issues)
  const notice = useTeamSetupStore((s) => s.notice)
  const disabled = useTeamsStore((s) => s.disabled)
  const teamsOn = useAppStore((s) => labOn(s.settings, 'teams'))

  // Labs off while open (here, or main answered `disabled`): nothing of Teams stays on screen.
  useEffect(() => {
    if (open && (disabled || !teamsOn)) closeTeamSetup()
  }, [open, disabled, teamsOn])

  // Esc closes only this dialog (never the team host or a modal behind it).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      closeTeamSetup()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  if (!open) return null

  const adopt = step === 'adopt'
  // Only errors block the adopt and the write; warnings are listed and never block.
  const existingBlocked = hasDefErrors(probe?.existing?.issues)
  const footerError = step !== 'repo' && error ? error : undefined

  return createPortal(
    <div className="fixed inset-0 z-[75] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/60" onClick={() => closeTeamSetup()} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="team-setup-title"
        data-team-setup
        data-setup-step={step}
        aria-busy={busy || undefined}
        className="relative z-10 flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-modal border border-border bg-card shadow-[0_20px_48px_-12px_rgba(0,0,0,0.6)]"
      >
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          {adopt ? (
            <ShieldAlert size={18} className="mt-0.5 shrink-0 text-amber-400" />
          ) : (
            <Users size={18} className="mt-0.5 shrink-0 text-accent-violet" />
          )}
          <div className="min-w-0 flex-1">
            <h2 id="team-setup-title" className="text-sm font-semibold text-text-primary">
              {t(adopt ? 'teams.setup.adoptTitle' : 'teams.setup.title')}
            </h2>
            {!adopt && (
              <p data-setup-step-of className="mt-0.5 text-xs text-text-secondary">
                {t('teams.setup.stepOf', { n: STEP_NUM[step], total: 3 })}
                {' · '}
                {t(step === 'repo' ? 'teams.setup.step.repo' : step === 'edit' ? 'teams.setup.step.edit' : 'teams.setup.step.preview')}
              </p>
            )}
          </div>
        </div>
        <div key={step} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {notice && (
            <p data-setup-notice={notice} className="rounded-btn border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-400">
              {t(NOTICE_KEY[notice])}
            </p>
          )}
          {step === 'repo' && <RepoStep />}
          {step === 'adopt' && probe && <AdoptStep probe={probe} />}
          {step === 'edit' && probe && draft && <EditStep probe={probe} draft={draft} />}
          {step === 'preview' && probe && preview && <SetupPreview preview={preview} repoName={probe.repoName} />}
          {issues && issues.length > 0 && <DefIssueList issues={issues} title={t('teams.setup.preview.issues')} />}
          {footerError && (
            <p data-setup-error={footerError} className="text-xs text-red-400">{teamErrorText(footerError, t)}</p>
          )}
        </div>
        <div key={`f-${step}`} className="flex items-center justify-end gap-2 border-t border-border bg-bg-secondary/40 px-5 py-3">
          {step !== 'repo' && (
            <button type="button" data-setup-back disabled={busy} onClick={() => setupBack()} className={cn(ghostBtn, 'mr-auto')}>
              {t('common.back')}
            </button>
          )}
          <button type="button" autoFocus={adopt} data-setup-cancel onClick={() => closeTeamSetup()} className={ghostBtn}>
            {t('common.cancel')}
          </button>
          {adopt && (
            <button
              type="button"
              data-setup-adopt
              disabled={busy || existingBlocked}
              onClick={() => void adoptExisting()}
              className="inline-flex items-center gap-2 rounded-btn bg-amber-500 px-4 py-2 text-sm font-medium text-black transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy && <Loader2 size={16} className="animate-spin" />}
              {t(busy ? 'teams.setup.adopt.adding' : 'teams.setup.adopt.approve')}
            </button>
          )}
          {step === 'edit' && (
            <Button size="sm" data-setup-next disabled={busy || !draftReady(draft)} onClick={() => void previewSetup()}>
              {busy && <Loader2 size={16} className="animate-spin" />}
              {t(busy ? 'teams.setup.edit.previewing' : 'teams.setup.edit.next')}
            </Button>
          )}
          {step === 'preview' && (
            <Button
              size="sm"
              data-setup-write={preview?.hash ?? ''}
              disabled={busy || !preview || hasDefErrors(preview.issues)}
              onClick={() => void writeSetup()}
            >
              {busy && <Loader2 size={16} className="animate-spin" />}
              {t(busy ? 'teams.setup.preview.writing' : 'teams.setup.preview.write')}
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
