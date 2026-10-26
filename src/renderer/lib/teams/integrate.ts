/**
 * Integrar of a task (app 2.7.0, E10 B6): the dialog's state. `integratePreview`
 * says what a merge of the task branch into its base would be (the commits,
 * the verification, how it lands, why it cannot); `integrate` with the
 * preview's tip runs it in main, which streams each step on
 * `teams:integrateProgress` (the verification output too, redacted) and ends
 * in a merge commit on the base or in an error that leaves the user's
 * checkout as it was. `confirmVerify` confirms the exact command team.md
 * declares, `askRebase` hands a conflict or a failed verification back to the
 * Dev, `removeWorktree` deletes the task worktree once it is done. Main owns
 * every state and runs every check; while an integrate runs the dialog cannot
 * be closed (it does not stop halfway). A quit mid-integrate is main's
 * (`interrupted` at load): the task detail carries it and the dialog shows it
 * on reopen. Never persisted.
 */
import { create } from 'zustand'
import { REPO_MAIN, type IntegrateError, type IntegrateStatus, type IntegrateStep } from '@shared/teams'
import type { IntegratePreview, IntegrateProgressEvt, IntegrateStepState, TaskDetail, TeamFail, VerifyNote } from '@shared/team-protocol'
import type { MessageKey, TFn } from '@/i18n'
import { useAppStore } from '@/lib/store'
import { revealPane } from '@/lib/revealPane'
import { MAX_PANES, worktreePathKey } from '@/lib/worktrees'
import { onIntegrateProgress, onTeamChanged, teamReq, useTeamsStore } from '@/lib/teamsStore'
import { loadTask, summaryOf, taskKey, useBoardStore } from './board'
import { loadNeeds } from './needs'
import { visibleLine, visibleName } from './issues'

export const INTEGRATE_STEPS: readonly IntegrateStep[] = ['preflight', 'temp', 'merge', 'verify', 'land', 'cleanup']

/** Each IntegrateError in words: what happened and what to do. A Record, so a new code fails typecheck until worded. */
export const INTEGRATE_ERROR_KEY: Record<IntegrateError, MessageKey> = {
  missing_worktree: 'teams.integrate.err.missing_worktree',
  dirty_worktree: 'teams.integrate.err.dirty_worktree',
  in_progress: 'teams.integrate.err.in_progress',
  wrong_branch: 'teams.integrate.err.wrong_branch',
  busy: 'teams.integrate.err.busy',
  merge_conflict: 'teams.integrate.err.merge_conflict',
  no_identity: 'teams.integrate.err.no_identity',
  verify_failed: 'teams.integrate.err.verify_failed',
  verify_timeout: 'teams.integrate.err.verify_timeout',
  base_moved: 'teams.integrate.err.base_moved',
  base_dirty: 'teams.integrate.err.base_dirty',
  base_busy: 'teams.integrate.err.base_busy',
  base_checked_out_elsewhere: 'teams.integrate.err.base_checked_out_elsewhere',
  git_error: 'teams.integrate.err.git_error',
  timeout: 'teams.integrate.err.timeout',
  interrupted: 'teams.integrate.err.interrupted',
}

export function isIntegrateError(code: unknown): code is IntegrateError {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(INTEGRATE_ERROR_KEY, code)
}

/** How a landing that failed was writing the base (main sends it for a failure at step land whose mode it knew). */
export type FailedLanding = 'ffOnly' | 'updateRef'

/**
 * An error in words where it happened (B6 review): a timeout of an ffOnly landing (the one write of the user's
 * checkout of the base: a git cut midway may leave it partly updated) is not one of an updateRef landing (only the
 * branch moves, no checkout is touched) nor one in the temporary copy (the checkout stayed as it was). Main's `landing`
 * of a failure (the event's, the stored one) says which landing it was; a failure at step land without it, or one
 * whose step is not known either (an attempt stored without them), may have been the ffOnly one. A refusal before
 * anything ran, or a preview, passes 'preflight'.
 */
export function integrateErrorKey(error: IntegrateError, step: IntegrateStep | undefined, landing?: FailedLanding): MessageKey {
  if (error !== 'timeout') return INTEGRATE_ERROR_KEY[error]
  // Main sends a landing only for a failure at step land.
  if (landing === 'ffOnly') return 'teams.integrate.err.timeoutLand'
  if (landing === 'updateRef') return 'teams.integrate.err.timeoutLandRef'
  if (!isStep(step) || step === 'land') return 'teams.integrate.err.timeoutUnknown'
  return INTEGRATE_ERROR_KEY.timeout
}

/** The landing main named for a failure, when it is one of the two that write the base. */
export function failedLanding(landing: unknown): FailedLanding | undefined {
  return landing === 'ffOnly' || landing === 'updateRef' ? landing : undefined
}

/** Each note of the verify runner in words (main sends the code only; the English line stays in its log). */
export const VERIFY_NOTE_KEY: Record<VerifyNote, MessageKey> = {
  leftStopped: 'teams.integrate.verifyNote.leftStopped',
  leftLetGo: 'teams.integrate.verifyNote.leftLetGo',
  timeoutKill: 'teams.integrate.verifyNote.timeoutKill',
  spawnFailed: 'teams.integrate.verifyNote.spawnFailed',
}

export function isVerifyNote(code: unknown): code is VerifyNote {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(VERIFY_NOTE_KEY, code)
}

export function isStep(step: unknown): step is IntegrateStep {
  return typeof step === 'string' && (INTEGRATE_STEPS as readonly string[]).includes(step)
}

/**
 * What the user can do about an error, in the order the dialog offers it:
 * hand it back to the Dev (`rebase` for a conflict, `fix` for a failed or
 * slow verification), a console in the task worktree for what only a hand
 * there fixes, and `retry` (a new preview: integrating again needs its tip).
 */
export type IntegrateAction = 'rebase' | 'fix' | 'console' | 'retry'

export function integrateActions(error: IntegrateError): IntegrateAction[] {
  switch (error) {
    case 'merge_conflict':
      return ['rebase', 'retry']
    case 'verify_failed':
    case 'verify_timeout':
      return ['fix', 'retry']
    case 'dirty_worktree':
    case 'in_progress':
    case 'wrong_branch':
      return ['console', 'retry']
    default:
      return ['retry']
  }
}

export type IntegratePhase = 'loading' | 'preview' | 'starting' | 'running' | 'done'
/**
 * `step` and, at step land, `landing`: where it failed and how it was landing (integrateErrorKey words a landing
 * timeout apart); `verifyNote`: the verify runner's own.
 */
export type IntegrateResult =
  | { ok: true; mergeSha?: string; landing?: 'ffOnly' | 'updateRef' | 'alreadyMerged' }
  | { ok: false; error: IntegrateError; step?: IntegrateStep; landing?: FailedLanding; files?: string[]; tail?: string; verifyNote?: VerifyNote }
export type IntegrateBusy = 'start' | 'verify' | 'rebase' | 'remove'

export interface IntegrateState {
  /** The task whose dialog is open; null = closed. */
  open: { teamId: string; taskId: string } | null
  phase: IntegratePhase
  /** The repo of the task (confirmVerify confirms that repo's command). */
  repoId: string
  preview?: IntegratePreview
  /** The preview request itself failed (not a preflight error: those come in `preview.error`). */
  loadFail?: TeamFail
  integrationId?: string
  steps: Partial<Record<IntegrateStep, IntegrateStepState>>
  /** The verification output as main streams it (redacted, at most 8 KB); shown through tailLines. */
  logTail?: string
  /** What the verify runner itself had to do (a leftover stopped, a command that could not start), at its end. */
  verifyNote?: VerifyNote
  result?: IntegrateResult
  busy: IntegrateBusy | null
  /** A refusal of the dialog's last request, shown inline. */
  actionFail?: { what: IntegrateBusy; fail: TeamFail }
  /** taskKey -> a removeWorktree on its way (the dialog and the drawer wait on the same one). */
  removing: Record<string, true>
  /** The task worktree was deleted from this dialog. */
  removed?: boolean
}

const CLOSED: Omit<IntegrateState, 'removing'> = { open: null, phase: 'loading', repoId: REPO_MAIN, steps: {}, busy: null }

export const useIntegrateStore = create<IntegrateState>(() => ({ ...CLOSED, removing: {} }))

/** True while the dialog cannot close: an integrate is on its way or running in main. */
export function integrateRunning(s: Pick<IntegrateState, 'phase'>): boolean {
  return s.phase === 'starting' || s.phase === 'running'
}

// An answer that arrives after a close, a reopen or a newer request is dropped.
let seq = 0
/** The detail as it was when this integrate started: a later failed attempt or integration settles it (fallback to the stream). */
let baseline: { attempt: number; integratedAt?: number } = { attempt: 0 }
/** Integrations already over here: a late step of one (its cleanup after a Revisar de nuevo) never reopens its steps. */
const finished = new Set<string>()

function isOpen(teamId: string, taskId: string): boolean {
  const o = useIntegrateStore.getState().open
  return !!o && o.teamId === teamId && o.taskId === taskId
}

function detailOf(teamId: string, taskId: string): TaskDetail | undefined {
  return useBoardStore.getState().tasks[taskKey(teamId, taskId)]?.detail
}

function repoOf(teamId: string, taskId: string, d?: TaskDetail): string {
  return d?.repoId ?? summaryOf(teamId, taskId)?.repoId ?? REPO_MAIN
}

async function loadPreview(teamId: string, taskId: string): Promise<void> {
  const n = ++seq
  useIntegrateStore.setState({ phase: 'loading', loadFail: undefined })
  const res = await teamReq({ op: 'integratePreview', teamId, taskId })
  if (n !== seq || !isOpen(teamId, taskId)) return
  // A run that started meanwhile (its first step came in) keeps the dialog on its steps.
  if (integrateRunning(useIntegrateStore.getState())) return
  if (!res.ok) {
    useIntegrateStore.setState({ phase: 'preview', preview: undefined, loadFail: res })
    return
  }
  useIntegrateStore.setState({ phase: 'preview', preview: res.preview, loadFail: undefined })
}

/**
 * Opens Integrar on a task (Te necesita's row, the drawer's worktree
 * section): the task as main has it now (its last attempt, a quit
 * mid-integrate), then the preview. A task main is integrating right now
 * opens on its steps instead, which the stream fills.
 */
export function openIntegrate(teamId: string, taskId: string): void {
  seq++
  baseline = { attempt: 0 }
  useIntegrateStore.setState((s) => ({ ...CLOSED, removing: s.removing, open: { teamId, taskId }, repoId: repoOf(teamId, taskId, detailOf(teamId, taskId)) }), true)
  const n = seq
  void loadTask(teamId, taskId).then((d) => {
    if (n !== seq || !isOpen(teamId, taskId)) return
    const detail = d ?? detailOf(teamId, taskId)
    useIntegrateStore.setState({ repoId: repoOf(teamId, taskId, detail) })
    if (detail?.integrate?.state === 'running') {
      // Main is on it (the renderer came back mid-run): its steps come as main sends them.
      baseline = { attempt: Math.max(0, detail.integrate.attempt - 1), integratedAt: detail.integratedInfo?.at }
      // Unless the stream took the dialog while this read was on its way (its steps, its end): it stays as the stream left it.
      if (useIntegrateStore.getState().phase === 'loading') useIntegrateStore.setState({ phase: 'running' })
      return
    }
    void loadPreview(teamId, taskId)
  })
}

/** "Revisar de nuevo": a fresh preview (integrating again needs its tip); the last result goes. */
export function reloadIntegrate(): void {
  const s = useIntegrateStore.getState()
  if (!s.open || integrateRunning(s)) return
  useIntegrateStore.setState({ result: undefined, steps: {}, logTail: undefined, verifyNote: undefined, integrationId: undefined, actionFail: undefined })
  void loadPreview(s.open.teamId, s.open.taskId)
}

/**
 * Integrar: main runs it with the tip the preview showed (a branch that moved
 * since answers `busy`, to check again). Its steps arrive on the stream; a
 * refusal before it starts is either an integrate error (shown as the result,
 * with its action) or a request error (shown inline). An update being
 * installed or the team being removed (`busy` with that detail) refuses every
 * start whatever the branch: inline, in its own words, never the Integrator's
 * busy (a branch that moved, another integration).
 */
export async function startIntegrate(): Promise<void> {
  const s = useIntegrateStore.getState()
  if (!s.open || !s.preview || s.busy || s.phase !== 'preview') return
  const { teamId, taskId } = s.open
  const d = detailOf(teamId, taskId)
  baseline = { attempt: d?.integrate?.attempt ?? 0, integratedAt: d?.integratedInfo?.at }
  const n = ++seq
  useIntegrateStore.setState({ phase: 'starting', busy: 'start', steps: {}, logTail: undefined, verifyNote: undefined, result: undefined, integrationId: undefined, actionFail: undefined })
  const res = await teamReq({ op: 'integrate', teamId, taskId, expectTip: s.preview.tip })
  if (n !== seq || !isOpen(teamId, taskId)) return
  if (!res.ok) {
    if (isIntegrateError(res.error) && !refusesEveryStart(res)) {
      // Refused before anything ran: the checkout was never touched (step preflight).
      useIntegrateStore.setState({ phase: 'done', busy: null, result: { ok: false, error: res.error, step: 'preflight', ...(res.files?.length ? { files: res.files } : {}) } })
    } else {
      useIntegrateStore.setState({ phase: 'preview', busy: null, actionFail: { what: 'start', fail: res } })
    }
    return
  }
  useIntegrateStore.setState((st) => {
    // Steps that came before the reply were taken by team and task; the reply's id is the one that counts.
    const same = !st.integrationId || st.integrationId === res.integrationId
    return {
      busy: null,
      integrationId: res.integrationId,
      ...(same ? {} : { steps: {}, logTail: undefined, verifyNote: undefined, result: undefined }),
      phase: st.phase === 'starting' || !same ? 'running' : st.phase,
    }
  })
}

/** Main's `busy` while an update installs or the team is being removed: about the app or the team, never this task. */
function refusesEveryStart(f: TeamFail): boolean {
  return f.error === 'busy' && (f.detail === 'install' || f.detail === 'remove')
}

/** "Confirmar este comando": the exact command team.md declares for the task's repo; the preview then shows it confirmed. */
export async function confirmVerifyCommand(): Promise<TeamFail | null> {
  const s = useIntegrateStore.getState()
  const v = s.preview?.verify
  if (!s.open || !v || !('command' in v) || v.confirmed || s.busy || s.phase !== 'preview') return null
  const { teamId, taskId } = s.open
  const n = ++seq
  useIntegrateStore.setState({ busy: 'verify', actionFail: undefined })
  const res = await teamReq({ op: 'confirmVerify', teamId, repoId: s.repoId, command: v.command })
  if (n !== seq || !isOpen(teamId, taskId)) return res.ok ? null : res
  if (!res.ok) {
    useIntegrateStore.setState({ busy: null, actionFail: { what: 'verify', fail: res } })
    return res
  }
  useTeamsStore.setState((st) => ({ views: { ...st.views, [teamId]: res.team } }))
  useIntegrateStore.setState({ busy: null })
  await loadPreview(teamId, taskId)
  return null
}

/**
 * "Pedile al Dev que haga rebase" / "que lo arregle" (T15): the files in
 * conflict or the verification output go to the assignee as a comment, the
 * task goes back to In progress and the Dev resumes it. The dialog closes
 * once main took it.
 */
export async function askRebase(why: 'conflict' | 'verify'): Promise<TeamFail | null> {
  const s = useIntegrateStore.getState()
  if (!s.open || s.busy || integrateRunning(s)) return null
  const { teamId, taskId } = s.open
  const n = ++seq
  useIntegrateStore.setState({ busy: 'rebase', actionFail: undefined })
  const res = await teamReq({ op: 'askRebase', teamId, taskId, why })
  if (n !== seq || !isOpen(teamId, taskId)) return res.ok ? null : res
  if (!res.ok) {
    useIntegrateStore.setState({ busy: null, actionFail: { what: 'rebase', fail: res } })
    return res
  }
  closeIntegrate()
  void loadTask(teamId, taskId)
  void loadNeeds(teamId)
  return null
}

/**
 * Deletes the worktree of a done task (its folder and its branch; main checks
 * it did not change since). From the dialog after an integrate and from the
 * drawer's worktree section. Null once main deleted it.
 */
export async function removeTaskWorktree(teamId: string, taskId: string): Promise<TeamFail | null> {
  const key = taskKey(teamId, taskId)
  if (useIntegrateStore.getState().removing[key]) return null
  const inDialog = isOpen(teamId, taskId)
  useIntegrateStore.setState((s) => ({ removing: { ...s.removing, [key]: true }, ...(inDialog ? { busy: 'remove' as const, actionFail: undefined } : {}) }))
  const res = await teamReq({ op: 'removeWorktree', teamId, taskId })
  useIntegrateStore.setState((s) => {
    const removing = { ...s.removing }
    delete removing[key]
    const here = !!s.open && s.open.teamId === teamId && s.open.taskId === taskId
    if (!here) return { removing }
    return res.ok ? { removing, busy: null, removed: true } : { removing, busy: null, actionFail: { what: 'remove' as const, fail: res } }
  })
  void loadTask(teamId, taskId)
  return res.ok ? null : res
}

export function closeIntegrate(): void {
  seq++
  useIntegrateStore.setState((s) => ({ ...CLOSED, removing: s.removing }), true)
}

/**
 * "Abrir consola en el worktree": a shell console in the task worktree, in the
 * team's workspace (else one whose folder is the repo, else the one on
 * screen), brought on screen (which closes Teams). `full` when that workspace
 * has no room, `none` when there is no workspace.
 */
export function openWorktreeConsole(teamId: string, cwd: string, title: string): 'ok' | 'full' | 'none' {
  const app = useAppStore.getState()
  const view = useTeamsStore.getState().views[teamId]
  const repoKey = view ? worktreePathKey(view.repoRoot) : null
  const ws =
    app.workspaces.find((w) => w.id === view?.workspaceId) ??
    (repoKey ? app.workspaces.find((w) => worktreePathKey(w.cwd) === repoKey) : undefined) ??
    app.workspaces.find((w) => w.id === app.activeWorkspaceId)
  if (!ws) return 'none'
  if (ws.panes.length >= MAX_PANES) return 'full'
  const paneId = app.addPane(ws.id, { cwd, title })
  if (!paneId) return 'none'
  closeIntegrate()
  revealPane(paneId)
  return 'ok'
}

// ---- the verification output on screen -----------------------------------------------------------------

/** What the dialog shows of an output (main sends at most 8 KB; the end is what matters). */
export const TAIL_CHARS_MAX = 8192
export const TAIL_LINES_MAX = 80

// Terminal colors and titles (CSI, OSC) carry no text of their own; anything else stays visible as <U+XXXX>.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g

/**
 * The end of a verification (or git) output as lines to show: terminal
 * escapes dropped, CR line ends folded, cut to the last TAIL_CHARS_MAX
 * characters and TAIL_LINES_MAX lines, and every line through visibleLine, so
 * control, bidi, zero-width and tag characters read as `<U+XXXX>` and nothing
 * in it renders as anything but text. `cut`: lines (or a part) left out.
 */
export function tailLines(raw: string | undefined): { lines: string[]; cut: boolean } {
  if (!raw) return { lines: [], cut: false }
  let text = raw.replace(ANSI_RE, '').replace(/\r\n?/g, '\n')
  let cut = false
  if (text.length > TAIL_CHARS_MAX) {
    text = text.slice(-TAIL_CHARS_MAX)
    cut = true
  }
  let lines = text.split('\n')
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  if (lines.length > TAIL_LINES_MAX) {
    lines = lines.slice(-TAIL_LINES_MAX)
    cut = true
  }
  return { lines: lines.map(visibleLine), cut }
}

/** The commits of the task branch its base does not have, as a chip says them (one apart from many). */
export function aheadText(count: number, t: TFn): string {
  return count === 1 ? t('teams.approval.aheadOne') : t('teams.approval.ahead', { count })
}

/** The commits the base has that the task branch does not. */
export function behindText(count: number, base: string, t: TFn): string {
  return count === 1 ? t('teams.integrate.behindOne', { base: visibleName(base) }) : t('teams.integrate.behind', { count, base: visibleName(base) })
}

/** A refused dialog request in the catalog's words (main's detail only picks which of them, never shows). */
export function integrateFailText(what: IntegrateBusy, f: TeamFail, t: TFn): string {
  // An update being installed or the team being removed: neither is about this task, and checking again never helps.
  if (refusesEveryStart(f)) return t(f.detail === 'install' ? 'teams.integrate.fail.installing' : 'teams.integrate.fail.teamRemoving')
  // Main never drops work on a delete: changes or commits the base does not have refuse it, and say which.
  if (what === 'remove' && f.error === 'dirty_worktree') return t(f.detail === 'commits' ? 'teams.integrate.fail.removeCommits' : 'teams.integrate.fail.removeDirty')
  if (what === 'remove' && (f.error === 'missing_worktree' || f.error === 'not_found')) return t('teams.integrate.fail.removeGone')
  if (what === 'remove' && (f.error === 'git_error' || f.error === 'timeout')) return t('teams.integrate.fail.removeGit')
  switch (f.error) {
    case 'conflict':
      return t(what === 'remove' ? 'teams.integrate.fail.removeChanged' : what === 'verify' ? 'teams.integrate.fail.badVerify' : 'teams.integrate.fail.gone')
    case 'not_found':
      return t('teams.integrate.fail.gone')
    case 'running':
    case 'busy':
    case 'stopping':
      return t(what === 'remove' ? 'teams.integrate.fail.removeBusy' : 'teams.integrate.fail.running')
    case 'untrusted':
    case 'changed':
    case 'invalid_definition':
      return t(what === 'verify' && f.error === 'changed' ? 'teams.integrate.fail.badVerify' : 'teams.integrate.fail.untrusted')
    case 'bad_request':
      return t(what === 'verify' ? 'teams.integrate.fail.badVerify' : 'teams.integrate.fail.other', { code: f.error })
    case 'unsupported':
      return t('teams.integrate.fail.unsupported')
    case 'disabled':
      return t('teams.run.fail.disabled')
    case 'io':
      return t('teams.integrate.fail.io')
    default:
      // A refusal of a request: nothing of an integrate ran.
      return isIntegrateError(f.error) ? t(integrateErrorKey(f.error, 'preflight')) : t('teams.integrate.fail.other', { code: f.error })
  }
}

// ---- the stream ---------------------------------------------------------------------------------------------

function settled(state: IntegrateStepState | undefined): boolean {
  return state === 'ok' || state === 'failed' || state === 'skipped'
}

/** One step from main: taken when it is the open task's integrate (the first one while it starts names it). */
function applyProgress(e: IntegrateProgressEvt): void {
  if (!e || typeof e !== 'object' || typeof e.integrationId !== 'string') return
  const s = useIntegrateStore.getState()
  if (!s.open || e.teamId !== s.open.teamId || e.taskId !== s.open.taskId) return
  if (finished.has(e.integrationId) && e.integrationId !== s.integrationId) return
  // While one runs (or its result shows) another id is not this dialog's; else a new one of this task takes the dialog.
  if (s.integrationId && e.integrationId !== s.integrationId && (integrateRunning(s) || s.phase === 'done')) return
  if (!isStep(e.step)) return
  const fresh = s.integrationId !== e.integrationId
  const steps = { ...(fresh ? {} : s.steps), [e.step]: e.state }
  const next: Partial<IntegrateState> = { steps, integrationId: e.integrationId }
  if (fresh) {
    next.result = undefined
    next.logTail = undefined
    next.verifyNote = undefined
    if (s.phase !== 'starting') next.phase = 'running'
  }
  // The live output is the verification's (logTail); another step's output only comes with its failure.
  const eventTail = typeof e.logTail === 'string' && e.logTail ? e.logTail : undefined
  if (e.step === 'verify' && eventTail) next.logTail = eventTail
  // The verify runner's own note comes with the verification's end (a code main never words).
  const note = e.step === 'verify' && isVerifyNote(e.verifyNote) ? e.verifyNote : undefined
  if (note) next.verifyNote = note
  const prev = fresh ? undefined : s.result
  if (e.state === 'failed') {
    const error = isIntegrateError(e.error) ? e.error : 'git_error'
    const tail = eventTail ?? (e.step === 'verify' && !fresh ? s.logTail : undefined)
    const verifyNote = note ?? (e.step === 'verify' && !fresh ? s.verifyNote : undefined)
    // A failed landing names how it was landing (B6 review, second round): only an ffOnly one wrote the checkout.
    const landing = e.step === 'land' ? failedLanding(e.landing) : undefined
    next.result = { ok: false, error, step: e.step, ...(landing ? { landing } : {}), ...(Array.isArray(e.files) && e.files.length ? { files: [...e.files] } : {}), ...(tail ? { tail } : {}), ...(verifyNote ? { verifyNote } : {}) }
  } else if (e.landing) {
    // Only the landing is a success (the merge step names its commit too, before the verification ran).
    if (!prev || prev.ok) next.result = { ok: true, landing: e.landing, ...(e.mergeSha ? { mergeSha: e.mergeSha } : {}) }
  }
  // The end: the cleanup settled (it runs once a temporary copy may exist, and never fails the result), a failed
  // preflight (nothing was created, so main sends no cleanup after it; the task event that would settle it never
  // comes while Teams is closed), or a branch already merged (no copy to clean).
  const result = next.result ?? prev
  const end = (e.step === 'cleanup' && settled(e.state)) || (e.step === 'preflight' && e.state === 'failed') || e.landing === 'alreadyMerged'
  if (end) {
    finished.add(e.integrationId)
    next.phase = 'done'
    // No failure and no landing seen (the dialog opened after them): never a guess, the task detail main commits
    // next says how it ended (settleFromDetail).
    next.result = result ?? (Object.values(steps).includes('failed') ? { ok: false, error: 'git_error' } : undefined)
  }
  useIntegrateStore.setState(next)
  if (end) void loadTask(e.teamId, e.taskId)
}

/**
 * The task as main has it now: a newer failed attempt or a new integration ends a run whose last steps never came,
 * or gives its outcome to one whose end came without it (the dialog opened after its failure or its landing). A
 * failure the stream showed gets what main stored of it and the stream did not carry (withStored).
 */
function settleFromDetail(d: TaskDetail | undefined): void {
  const s = useIntegrateStore.getState()
  if (!d || !s.open || d.id !== s.open.taskId) return
  const st = d.integrate
  const failed = st && st.state === 'failed' && st.attempt > baseline.attempt ? storedFailure(st) : undefined
  // The stream already ended it in a failure: only what the stream could not show comes from main's.
  if (s.phase === 'done' && s.result && !s.result.ok) {
    const filled = failed ? withStored(s.result, failed) : s.result
    if (filled !== s.result) useIntegrateStore.setState({ result: filled })
    return
  }
  if (!(integrateRunning(s) || (s.phase === 'done' && !s.result))) return
  if (s.integrationId) finished.add(s.integrationId)
  if (d.integratedInfo && d.integratedInfo.at !== baseline.integratedAt) {
    const prev = s.result?.ok ? s.result : undefined
    useIntegrateStore.setState({ phase: 'done', busy: null, result: { ok: true, mergeSha: prev?.mergeSha ?? d.integratedInfo.mergeSha, landing: prev?.landing ?? d.integratedInfo.landed } })
    return
  }
  if (failed) useIntegrateStore.setState({ phase: 'done', busy: null, result: s.result && !s.result.ok ? withStored(s.result, failed) : failed })
}

type FailedResult = Extract<IntegrateResult, { ok: false }>

/**
 * A failed attempt as main stored it (B6 review, second round): where it failed, how it was landing, the files, the
 * output and the verify runner's note (kept also when it failed after the verification).
 */
function storedFailure(st: IntegrateStatus): FailedResult {
  const landing = failedLanding(st.landing)
  return {
    ok: false,
    error: isIntegrateError(st.error) ? st.error : 'git_error',
    ...(isStep(st.step) ? { step: st.step } : {}),
    ...(landing ? { landing } : {}),
    ...(st.files?.length ? { files: [...st.files] } : {}),
    ...(st.tail ? { tail: st.tail } : {}),
    ...(isVerifyNote(st.verifyNote) ? { verifyNote: st.verifyNote } : {}),
  }
}

/**
 * The stream's failure with what only main's stored one has: the runner's note of a verification that ended before
 * the dialog opened, a landing the event did not name. Only of the same failure (its error and its step); otherwise,
 * or with nothing to add, the stream's result itself.
 */
function withStored(r: FailedResult, stored: FailedResult): FailedResult {
  if (stored.error !== r.error || stored.step !== r.step) return r
  const note = !r.verifyNote && stored.verifyNote ? { verifyNote: stored.verifyNote } : {}
  const landing = !r.landing && stored.landing ? { landing: stored.landing } : {}
  return 'verifyNote' in note || 'landing' in landing ? { ...r, ...note, ...landing } : r
}

/** One `teams:changed` hands its scopes over one by one (the core's debounce): a pull waits this long to fold them. */
const SCOPE_FOLD_MS = 16

/**
 * While the lab is on (startTeams): the steps main streams for the open
 * dialog's task, that task read again when main says it changed (its last
 * attempt, a run that ends) or a `task` change names no task (a commit with
 * no hint: any task of the team, CONTRATOS; like initBoardSync's drawer), and
 * `disabled` closes everything.
 */
export function initIntegrateSync(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const offProgress = onIntegrateProgress(applyProgress)
  const offChanged = onTeamChanged((e) => {
    if (e.scopes.includes('disabled')) {
      closeIntegrate()
      return
    }
    const o = useIntegrateStore.getState().open
    if (!o || e.teamId !== o.teamId) return
    const task = e.scopes.includes('task') && (e.taskId === undefined || e.taskId === o.taskId)
    if (!task || timer) return
    timer = setTimeout(() => {
      timer = null
      const cur = useIntegrateStore.getState().open
      if (cur && cur.teamId === o.teamId && cur.taskId === o.taskId) void loadTask(o.teamId, o.taskId)
    }, SCOPE_FOLD_MS)
  })
  // Whoever loads the task (this sync, the drawer, a write's answer), the dialog reads its integrate state.
  const offBoard = useBoardStore.subscribe((st, prev) => {
    const o = useIntegrateStore.getState().open
    if (!o) return
    const key = taskKey(o.teamId, o.taskId)
    const d = st.tasks[key]?.detail
    if (d !== prev.tasks[key]?.detail) settleFromDetail(d)
  })
  return () => {
    offProgress()
    offChanged()
    offBoard()
    if (timer) clearTimeout(timer)
    finished.clear()
    closeIntegrate()
    useIntegrateStore.setState({ removing: {} })
  }
}
