/**
 * Small pieces the phone's Teams screens share (app 2.7.0, E10 B8): the
 * "En la PC" chip of what is decided only on the desktop (decision 50), a
 * chip, the loading spinner, a text folded after a number of lines, the
 * button classes, the input checks main's schema applies (a frame it would
 * refuse costs the session a strike, so nothing like it is ever sent) and a
 * composer whose text goes out only on its button (Enter is a newline;
 * dictation lands in the field and waits).
 */
import { useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { clsx } from 'clsx'
import { Loader2, Monitor } from 'lucide-react'
import { Markdown } from '../chat/Markdown'
import { MicButton, VoiceInterim } from '../MicButton'
import type { TeamRefusal } from './teamText'
import { teamChangeWants, useTeamsUi, type TeamChangeTarget } from '../../lib/teamsStore'
import { spaced } from '../../lib/voice'
import { t } from '../../lib/i18n'

export type Load<T> = { status: 'loading' | 'ok' | 'noReply' | 'gone' | 'failed'; value: T | null; error?: string }

/**
 * The Load status of a read that did not bring its view: gone (`not_found`),
 * no answer (NoReply), a socket that was down (`offline`: it stays loading,
 * like WsNotesScreen, and the reconnect's resyncTeams reads it again) or a
 * refusal of the PC (LoadFailed).
 */
export function loadStatusOf(f: TeamRefusal | null): Load<unknown>['status'] {
  if (f?.error === 'not_found') return 'gone'
  if (f?.error === 'timeout' || f?.error === 'rate') return 'noReply'
  if (f?.error === 'offline') return 'loading'
  return 'failed'
}

export const GHOST_BTN = 'flex min-h-11 items-center justify-center gap-1.5 rounded-btn border border-border bg-bg-secondary px-3 text-sm font-medium text-text-primary active:bg-card disabled:opacity-50'
export const PRIMARY_BTN = 'flex min-h-11 items-center justify-center gap-1.5 rounded-btn bg-accent-violet px-4 text-sm font-semibold text-white active:brightness-110 disabled:opacity-50'
/** Room a screen's toasts leave for its composer at the bottom (field, error line, buttons). */
export const COMPOSER_CLEARANCE_PX = 150
export const SECTION_TITLE ='mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary'

/** C0 but tab and newline, and DEL: main's schema refuses them in a body. */
const BODY_BAD_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/
/** One-line fields (a task title): every control and the line separators. */
const LINE_BAD_RE = /[\u0000-\u001f\u007f-\u009f\u{2028}\u{2029}]/u

/** Text as it goes out: CRLF (a paste) as newlines, never a stray carriage return. */
export function outgoingText(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

export function bodyOk(text: string): boolean {
  return !BODY_BAD_RE.test(outgoingText(text))
}

/**
 * Why a body cannot go out as it is, in words, else null: a control
 * character, or more than `max` characters (a field's maxLength holds only
 * what is typed: dictated words land past it).
 */
export function bodyProblem(text: string, max: number): string | null {
  if (!bodyOk(text)) return t('teams.comment.control')
  if (outgoingText(text).length > max) return t('teams.comment.tooLong')
  return null
}

export function lineOk(text: string): boolean {
  return !LINE_BAD_RE.test(text)
}

/** The earlier pages of a thread loaded with "Ver anteriores" (oldest first) and the cursor before them. */
export interface OlderPages<T> {
  items: T[]
  cursor: string | null
}

/**
 * A reload of a thread's newest page (a task's comments, the Lead chat)
 * keeps the earlier pages the user loaded: what was shown before the new
 * page (its own first page included) stays above it, and an id the new page
 * repeats is the new page's. When the new page no longer touches what was
 * shown (more new messages than a page, the gap between them never read)
 * the earlier pages go and "Ver anteriores" pages back from the new page
 * again. Null without earlier pages.
 */
export function keepOlderPages<T extends { id: string }>(older: OlderPages<T> | null, prevPage: readonly T[], page: readonly T[], pageCursor: string | null): OlderPages<T> | null {
  if (!older) return null
  const before = [...older.items, ...prevPage]
  const had = new Set(before.map((x) => x.id))
  if (pageCursor !== null && !page.some((x) => had.has(x.id))) return null
  const fresh = new Set(page.map((x) => x.id))
  const items = before.filter((x) => !fresh.has(x.id))
  return items.length > 0 ? { items, cursor: older.cursor } : null
}

/**
 * Runs `onChange` when a change of the team on the PC names what the screen
 * shows (teamChangeWants). The change held when the screen mounts is old
 * news: its own first load covers it.
 */
export function useTeamChange(teamId: string, what: TeamChangeTarget, taskId: string | undefined, onChange: () => void): void {
  const seq = useTeamsUi((s) => s.changed[teamId]?.seq)
  const seen = useRef(seq)
  const run = useRef(onChange)
  run.current = onChange
  useEffect(() => {
    if (seq === undefined || seq === seen.current) return
    seen.current = seq
    if (teamChangeWants(useTeamsUi.getState().changed[teamId], what, taskId)) run.current()
  }, [seq, teamId, what, taskId])
}

/** "En la PC": this row is shown here and decided on the desktop. */
export function OnPcChip({ label }: { label?: string }): ReactNode {
  return (
    <span data-on-pc className="inline-flex min-h-7 max-w-full items-center gap-1 rounded-btn border border-border bg-bg-secondary px-2 text-[11px] font-medium text-text-secondary">
      <Monitor size={13} className="shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{label ? `${label} · ${t('teams.onPc')}` : t('teams.onPc')}</span>
    </span>
  )
}

/** A chip; `tone` only for a state (waits on the user, an agent working), never decoration (STYLEGUIDE 9). */
export function Chip({ children, tone, ...rest }: { children: ReactNode; tone?: 'action' | 'working' } & Record<`data-${string}`, string | number | boolean | undefined>): ReactNode {
  return (
    <span
      {...rest}
      className={clsx(
        'inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] leading-4',
        tone === 'action' ? 'border-state-action/50 bg-state-action/10 text-text-primary' : tone === 'working' ? 'border-state-working/50 bg-state-working/10 text-text-primary' : 'border-border text-text-secondary',
      )}
    >
      {children}
    </span>
  )
}

/** The PC answered with a refusal (not silence, that is NoReply): what did not load, and Retry. */
export function LoadFailed({ text, onRetry }: { text: string; onRetry: () => void }): ReactNode {
  return (
    <div data-load-failed role="status" className="flex flex-col items-center gap-2 py-4 text-center">
      <p className="text-sm text-text-secondary">{text}</p>
      <button type="button" onClick={onRetry} className={GHOST_BTN}>
        {t('pending.retry')}
      </button>
    </div>
  )
}

export function Spinner(): ReactNode {
  return (
    <div className="flex justify-center py-6" role="status" aria-label={t('teams.task.loading')}>
      <Loader2 size={20} className="spin text-text-secondary" />
    </div>
  )
}

/** `text` past `lines` lines folds behind "Ver más"; `cut` (the PC sent only part of it) adds "Sigue en la PC". */
export function Folded({ text, lines = 12, markdown, cut, ...rest }: { text: string; lines?: number; markdown?: boolean; cut?: boolean } & Record<`data-${string}`, string | undefined>): ReactNode {
  const [open, setOpen] = useState(false)
  const all = text.split('\n')
  const folds = all.length > lines
  const shown = folds && !open ? all.slice(0, lines).join('\n') : text
  return (
    <div {...rest} data-folded={folds && !open ? 'true' : 'false'} className="min-w-0">
      {markdown ? <Markdown text={shown} /> : <p className="whitespace-pre-wrap text-sm text-text-primary [overflow-wrap:anywhere]">{shown}</p>}
      {folds && (
        <button type="button" data-fold-toggle onClick={() => setOpen((o) => !o)} className="min-h-11 px-1 text-xs font-medium text-accent-violet">
          {open ? t('teams.task.showLess') : t('teams.task.showMore')}
        </button>
      )}
      {cut && (!folds || open) && (
        <p data-more-on-pc className="mt-1 flex items-center gap-1 text-[11px] text-text-secondary">
          <Monitor size={13} aria-hidden />
          {t('teams.task.morePc')}
        </p>
      )}
    </div>
  )
}

/**
 * A text field with dictation and its send button. Enter is a newline; the
 * text goes out only when the button is tapped (`onSend`), dictated words
 * included. `error` shows under the field.
 */
export function Composer({
  owner,
  value,
  onChange,
  onSend,
  sending,
  label,
  placeholder,
  sendLabel,
  sendingLabel,
  maxLength,
  error,
  resetKey,
  sendAttr,
  fieldAttr,
}: {
  owner: string
  value: string
  /** A state setter: dictation appends through its updater form, so words heard after a keystroke keep it. */
  onChange: Dispatch<SetStateAction<string>>
  onSend: () => void
  sending: boolean
  label: string
  placeholder: string
  sendLabel: string
  sendingLabel: string
  maxLength: number
  error?: string | null
  resetKey?: unknown
  sendAttr: string
  fieldAttr: string
}): ReactNode {
  return (
    <div className="flex flex-col gap-1.5">
      <VoiceInterim owner={owner} />
      <textarea
        {...{ [fieldAttr]: true }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        maxLength={maxLength}
        aria-label={label}
        placeholder={placeholder}
        enterKeyHint="enter"
        className="max-h-40 min-h-[64px] w-full resize-none rounded-btn border border-border bg-bg-secondary px-3 py-2 text-[15px] leading-6 text-text-primary outline-none focus:border-accent-violet"
      />
      {error && (
        <p role="alert" data-composer-error className="text-xs text-state-error">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <MicButton owner={owner} resetKey={resetKey} onFinal={(chunk) => onChange((prev) => prev + spaced(prev, chunk))} />
        <button type="button" {...{ [sendAttr]: true }} disabled={sending || !value.trim()} onClick={onSend} className={clsx(PRIMARY_BTN, 'flex-1')}>
          {sending && <Loader2 size={16} className="spin" />}
          {sending ? sendingLabel : sendLabel}
        </button>
      </div>
    </div>
  )
}
