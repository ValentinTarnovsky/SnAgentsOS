/**
 * Words of the phone's Teams screens (app 2.7.0, E10 B8): agent and repo text
 * as it really is (visibleText: the characters that hide or reorder a line
 * spelled out, like the desktop's visibleLine), the labels of columns,
 * phases, priorities, modes, run states and card reasons, a comment main
 * wrote rendered from its key, main's run notes, and every refusal the phone
 * can get in the catalog's words (never main's code, never a record's JSON).
 * Pure: no React.
 */
import type { ChatBlock, ChatMessage } from '@shared/chat-types'
import type { ApprovalKind, BoardColumn, CardAction, CardReason, DeferInfo, RunMode, RunState, TaskPhase, TaskPriority } from '@shared/teams'
import { RUN_LOG_CUT_TEXT, runNoteOfText } from '@shared/teams'
import type { CardView, CommentView, PhoneTeamListItem, TaskBlockedView, TeamFail } from '@shared/team-protocol'
import type { PendingOutcome } from '../../lib/pending'
import { isNoReply } from '../../lib/pending'
import { clockTime } from '../../lib/statusText'
import { teamsEn } from '../../lib/i18nTeams'
import { t, type MobileMessageKey } from '../../lib/i18n'

// ---- text as it really is ----------------------------------------------------------------------------

/**
 * C0/C1 controls (newline and tab stay), the Arabic letter mark, zero-width
 * and bidi marks, overrides and isolates, the word joiner family, the BOM, the
 * line and paragraph separators and the tag characters (U+E0000-U+E007F, read
 * by a model as ASCII yet invisible): each one becomes `<U+XXXX>`.
 */
const HIDDEN_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u{61C}\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2069}\u{FEFF}\u{2028}\u{2029}\u{E0000}-\u{E007F}]/gu

function codePoint(ch: string): string {
  return `<U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}>`
}

/** Agent or repo text with every hiding character spelled out; line breaks stay (CRLF reads as one). */
export function visibleText(text: string): string {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(HIDDEN_RE, codePoint)
}

/** One line of such text (a name, a rule, an option): tab and newline spelled out too. */
export function visibleName(text: string): string {
  return visibleText(text).replace(/[\t\n]/g, codePoint)
}

function visibleBlock(b: ChatBlock): ChatBlock {
  switch (b.t) {
    case 'text':
    case 'thinking':
      return { ...b, text: visibleText(b.text) }
    case 'toolUse':
      return { ...b, name: visibleName(b.name), summary: visibleName(b.summary) }
    case 'toolResult':
      return {
        ...b,
        text: visibleText(b.text),
        ...(b.patch
          ? {
              patch: {
                ...(b.patch.filePath !== undefined ? { filePath: visibleName(b.patch.filePath) } : {}),
                hunks: b.patch.hunks.map((h) => ({ ...h, lines: h.lines.map(visibleText) })),
              },
            }
          : {}),
      }
    case 'image':
      return { ...b, label: visibleName(b.label) }
    default:
      return b
  }
}

/** A run's message with its agent text spelled out, and main's own system rows (the log cut, a run note) in words. */
export function runMessageOf(m: ChatMessage): ChatMessage {
  if (m.role === 'system') {
    const words = runSystemText(m.blocks.map((b) => (b.t === 'text' ? b.text : '')).join('\n'))
    if (words !== null) return { ...m, blocks: [{ t: 'text', text: words }] }
  }
  return { ...m, blocks: m.blocks.map(visibleBlock) }
}

/** RunLog's cut row and main's notes (B5), worded; null for any other system text. */
export function runSystemText(text: string): string | null {
  if (text === RUN_LOG_CUT_TEXT) return t('teams.run.chat.cut')
  const note = runNoteOfText(text)
  if (!note) return null
  const vars: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(note.vars)) vars[k] = typeof v === 'string' ? visibleName(v) : v
  switch (note.key) {
    case 'blockStopped':
      return t(note.vars.detail === 'secret' ? 'teams.run.chat.note.blockSecret' : 'teams.run.chat.note.blockRefused', vars)
    case 'blockStateFull':
      return t('teams.run.chat.note.blockStateFull', vars)
  }
  return null
}

// ---- labels ----------------------------------------------------------------------------------------

/** True when the phone's catalog has this key (a newer PC may send a key this bundle does not know). */
export function hasTeamKey(key: string): key is MobileMessageKey {
  return Object.prototype.hasOwnProperty.call(teamsEn, key)
}

export const COL_KEY: Record<BoardColumn, MobileMessageKey> = {
  todo: 'teams.col.todo',
  doing: 'teams.col.doing',
  review: 'teams.col.review',
  done: 'teams.col.done',
  blocked: 'teams.col.blocked',
}

export const PHASE_KEY: Record<TaskPhase, MobileMessageKey> = {
  none: 'teams.phase.none',
  planning: 'teams.phase.planning',
  planApproval: 'teams.phase.planApproval',
  executing: 'teams.phase.executing',
  qa: 'teams.phase.qa',
  userOk: 'teams.phase.userOk',
  integrating: 'teams.phase.integrating',
}

export const PRIO_KEY: Record<TaskPriority, MobileMessageKey> = {
  urgent: 'teams.prio.urgent',
  high: 'teams.prio.high',
  normal: 'teams.prio.normal',
  low: 'teams.prio.low',
}

export const MODE_KEY: Record<RunMode, MobileMessageKey> = {
  plan: 'teams.mode.plan',
  exec: 'teams.mode.exec',
  qa: 'teams.mode.qa',
  lead: 'teams.mode.lead',
  free: 'teams.mode.free',
}

export const RUN_STATE_KEY: Record<RunState, MobileMessageKey> = {
  queued: 'teams.run.state.queued',
  starting: 'teams.run.state.starting',
  running: 'teams.run.state.running',
  stopping: 'teams.run.state.stopping',
  succeeded: 'teams.run.state.succeeded',
  failed: 'teams.run.state.failed',
  cancelled: 'teams.run.state.cancelled',
  interrupted: 'teams.run.state.interrupted',
  takenOver: 'teams.run.state.takenOver',
}

export const CARD_WHY_KEY: Record<CardReason, MobileMessageKey> = {
  noProgress: 'teams.cardWhy.noProgress',
  qaRounds: 'teams.cardWhy.qaRounds',
  qaNoVerdict: 'teams.cardWhy.qaNoVerdict',
  interrupted: 'teams.cardWhy.interrupted',
  failure: 'teams.cardWhy.failure',
  timeout: 'teams.cardWhy.timeout',
  stalled: 'teams.cardWhy.stalled',
  depCancelled: 'teams.cardWhy.depCancelled',
  unblockLimit: 'teams.cardWhy.unblockLimit',
  cwdMissing: 'teams.cardWhy.cwdMissing',
  sessionConflict: 'teams.cardWhy.sessionConflict',
  auth: 'teams.cardWhy.auth',
  billing: 'teams.cardWhy.billing',
  stateReset: 'teams.cardWhy.stateReset',
  spawnFailed: 'teams.cardWhy.spawnFailed',
  cliOff: 'teams.cardWhy.cliOff',
  orphan: 'teams.cardWhy.orphan',
}

export const CARD_ACTION_KEY: Record<CardAction, MobileMessageKey> = {
  retry: 'teams.cardAction.retry',
  resume: 'teams.cardAction.resume',
  toTodo: 'teams.cardAction.toTodo',
  cancelTask: 'teams.cardAction.cancelTask',
  stopRun: 'teams.cardAction.stopRun',
  keepWaiting: 'teams.cardAction.keepWaiting',
  dropBlocker: 'teams.cardAction.dropBlocker',
  resumeTeam: 'teams.cardAction.resumeTeam',
  newSession: 'teams.cardAction.newSession',
  killOrphan: 'teams.cardAction.killOrphan',
  dismiss: 'teams.cardAction.dismiss',
}

export function isRunLive(state: RunState | undefined): boolean {
  return state === 'queued' || state === 'starting' || state === 'running' || state === 'stopping'
}

/** Why a system card is up; its vars (task ids, a pid) are main's, spelled out like any repo text. */
export function cardWhyText(system: NonNullable<CardView['system']>): string {
  const v = system.vars ?? {}
  const str = (k: string): string => visibleName(String(v[k] ?? ''))
  if (system.why === 'stateReset' && v.what === 'trust') return t('teams.cardWhy.stateResetTrust')
  if (system.why === 'spawnFailed' && v.what === 'cmdLine') return t('teams.cardWhy.spawnFailedCmdLine')
  return t(CARD_WHY_KEY[system.why] ?? 'teams.cardWhy.failure', {
    blockers: str('blockers').split(',').filter(Boolean).join(', '),
    pid: str('pid'),
  })
}

/** Why a task is blocked, in words. */
export function blockedText(b: TaskBlockedView): string {
  const text = b.text ? visibleText(b.text) : ''
  switch (b.kind) {
    case 'deps':
      return b.waitingOn && b.waitingOn.length > 0 ? t('teams.blocked.deps', { tasks: b.waitingOn.map(visibleName).join(', ') }) : t('teams.blocked.depsNone')
    case 'user':
      if (b.by === 'lead') return text ? t('teams.blocked.leadText', { text }) : t('teams.blocked.lead')
      return text ? t('teams.blocked.userText', { text }) : t('teams.blocked.user')
    case 'stopped':
      return t('teams.blocked.stopped')
    case 'card':
      return t('teams.blocked.card')
  }
  return t('teams.blocked.depsNone')
}

/** Why a queued run would wait, with its time when it has one. */
export function deferText(d: DeferInfo | undefined, now: number): string {
  if (!d) return t('teams.dispatch.ready')
  const key = `teams.defer.${d.reason}`
  const reason = hasTeamKey(key) ? t(key) : t('teams.defer.running')
  return d.until && d.until > now ? t('teams.dispatch.deferredUntil', { reason, time: clockTime(d.until, now) }) : t('teams.dispatch.deferred', { reason })
}

/** A comment main wrote, from its key (decision 65); a key this bundle does not know reads as "A message of the app". */
export function sysText(c: Pick<CommentView, 'sys'>): string {
  const sys = c.sys
  if (!sys) return ''
  const key = `teams.sys.${sys.key}`
  if (!hasTeamKey(key)) return t('teams.comment.sysUnknown')
  const vars: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(sys.vars ?? {})) vars[k] = typeof v === 'string' ? visibleText(v) : v
  return t(key, vars)
}

/** The Home card's and the list's second line of a team. */
export function teamLine(item: PhoneTeamListItem): string {
  if (item.trust === 'changed') return t('teams.home.review')
  if (item.trust !== 'trusted') return t('teams.home.reviewDef')
  if (item.paused) return t('teams.chip.paused')
  if (item.running > 0) return item.running === 1 ? t('teams.home.workingOne') : t('teams.home.working', { count: item.running })
  if (item.needsCount > 0) return t('teams.home.needsYou')
  return t('teams.home.quiet')
}

// ---- refusals ----------------------------------------------------------------------------------------

/** A refusal as the phone can get it: a teamRes TeamFail, or a ctl ack's error string. */
export interface TeamRefusal {
  error: string
  reason?: string
  detail?: string
}

const CONFLICT_REASONS = ['rev', 'stale', 'concluded', 'already_decided', 'newer_comment_not_delivered']
const BAD_DETAILS = ['nothingToGrant', 'secret']

/**
 * A ctl ack's error (decide, answer, dispatch carry only a string): the code,
 * or `code:sub` / `code/sub` when the PC adds the conflict reason or the
 * detail, or that reason or detail alone.
 */
export function refusalOfAck(error: string | undefined): TeamRefusal {
  const raw = typeof error === 'string' ? error : ''
  const m = /^([a-z_]+)[:/]([A-Za-z_]+)$/.exec(raw)
  if (m) return CONFLICT_REASONS.includes(m[2]) ? { error: m[1], reason: m[2] } : { error: m[1], detail: m[2] }
  if (CONFLICT_REASONS.includes(raw)) return { error: 'conflict', reason: raw }
  if (BAD_DETAILS.includes(raw)) return { error: 'bad_request', detail: raw }
  return { error: raw || 'io' }
}

/** What every op shares: no answer, too many requests, Labs off, a device that may not act, a live key in the text. */
function commonWords(f: TeamRefusal): string | null {
  if (f.error === 'timeout' || f.error === 'offline') return t('pending.noReply')
  if (f.error === 'rate') return t('teams.err.rate')
  if (f.error === 'disabled') return t('teams.err.disabled')
  if (f.error === 'denied') return t('teams.err.denied')
  if (f.error === 'too_big') return t('teams.err.tooBig')
  if (f.detail === 'secret') return t('teams.err.secret')
  return null
}

/** A refused decision (teamDecide). `kind` and `decision` name what was decided: a stale hire, a permission with nothing to grant. */
export function decideFailText(f: TeamRefusal, kind?: ApprovalKind, decision?: 'approve' | 'reject'): string {
  const common = commonWords(f)
  if (common) return common
  switch (f.error) {
    case 'conflict':
      if (f.reason === 'already_decided') return t('teams.err.decided')
      return t(f.reason === 'stale' && kind === 'hire' ? 'teams.err.hireStale' : 'teams.err.gone')
    case 'not_found':
      return t('teams.err.gone')
    case 'forbidden':
      return t('teams.err.forbidden')
    case 'changed':
      return t('teams.err.changed')
    case 'invalid_definition':
      return t('teams.err.invalid')
    case 'untrusted':
      return t('teams.err.untrusted')
    case 'busy':
    case 'running':
    case 'stopping':
      return t('teams.err.busy')
    case 'bad_request':
      // A permission whose every rule the app now refuses: the ack may carry only the code, and the phone never sends an
      // integrate decide (read only here), so a refused approve of a permission is that case.
      if (f.detail === 'nothingToGrant' || (!f.detail && kind === 'permission' && decision === 'approve')) return t('teams.err.nothingToGrant')
      return t('teams.err.decideFailed')
    default:
      return t('teams.err.decideFailed')
  }
}

/** A refused answer to a card (teamAnswer). */
export function answerFailText(f: TeamRefusal): string {
  const common = commonWords(f)
  if (common) return common
  if (f.error === 'conflict') return t(f.reason === 'already_decided' ? 'teams.err.answered' : 'teams.err.gone')
  if (f.error === 'bad_request') return t('teams.err.badAnswer')
  if (['not_found', 'forbidden', 'untrusted', 'busy', 'running', 'stopping'].includes(f.error)) return decideFailText(f)
  return t('teams.err.answerFailed')
}

/** A refused dispatch (teamDispatch): one run (`go` or not) or all of them. */
export function dispatchFailText(f: TeamRefusal, all: boolean, go: boolean): string {
  const common = commonWords(f)
  if (common) return common
  if (f.error === 'conflict' || f.error === 'not_found') return t('teams.dispatch.gone')
  if (f.error === 'untrusted') return t('teams.err.untrusted')
  if (f.error === 'busy') return t('teams.task.fail.busy')
  return t(all ? 'teams.dispatch.allFailed' : go ? 'teams.dispatch.failed' : 'teams.dispatch.dropFailed')
}

/** A refused write of text (a new task, a comment, a message to the Lead), with the op's own fallback. */
export function writeFailText(f: TeamRefusal, fallback: MobileMessageKey): string {
  const common = commonWords(f)
  if (common) return common
  switch (f.error) {
    case 'cap':
      return t('teams.task.fail.cap')
    case 'untrusted':
      return t('teams.task.fail.untrusted')
    case 'not_found':
      return t('teams.task.fail.not_found')
    case 'busy':
      return t('teams.task.fail.busy')
    case 'conflict':
      return t('teams.task.fail.conflict')
    case 'unsupported':
      return t('teams.task.fail.unsupported')
    case 'forbidden':
      return t('teams.err.forbidden')
    default:
      return t(fallback)
  }
}

/** The PC's answer when it went through, else null (refusalOf says why). */
export function replyOf<T extends { ok: boolean }>(out: PendingOutcome<T>): Extract<T, { ok: true }> | null {
  return out.ok && out.value.ok ? (out.value as Extract<T, { ok: true }>) : null
}

/** The refusal of a teamReq outcome (no answer, or the PC's TeamFail), else null when it went through. */
export function refusalOf<T extends { ok: boolean }>(out: PendingOutcome<T>): TeamRefusal | null {
  if (!out.ok) return { error: isNoReply(out.error) ? 'timeout' : out.error }
  if (out.value.ok) return null
  const f = out.value as unknown as TeamFail
  const r: TeamRefusal = { error: typeof f.error === 'string' ? f.error : 'io' }
  if (typeof f.reason === 'string') r.reason = f.reason
  if (typeof f.detail === 'string') r.detail = f.detail
  return r
}
