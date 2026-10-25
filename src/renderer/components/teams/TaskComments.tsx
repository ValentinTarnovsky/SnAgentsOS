import { useCallback, useState, type KeyboardEvent, type ReactNode } from 'react'
import { COMMENT_TEXT_MAX, type SysKey, type SysText } from '@shared/teams'
import type { CommentView, TeamError } from '@shared/team-protocol'
import { useLang, useT, type MessageKey, type TFn } from '@/i18n'
import { cn } from '@/lib/cn'
import { clockTime } from '@/lib/statusSignals'
import { addComment, loadOlderComments, type TaskEntry } from '@/lib/teams/board'
import { ChatMarkdown } from '@/components/chat/Markdown'
import { safeHref } from '@/components/chat/chatModel'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { CHIP, CHIP_NEUTRAL, taskFailText } from './TaskCard'

/** C0 except tab and newline, and DEL: main refuses a comment that has one. */
export const BODY_BAD_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/
const SEND_KEYS = ['Ctrl', 'Enter']

/**
 * Takes the keyboard out of a field and leaves it on the nearest container that
 * holds one (the drawer, the Te necesita row, the dialog, the overlay), so the
 * next Esc reaches what it closed before; nowhere when none does.
 */
export function leaveField(field: HTMLElement): void {
  field.parentElement?.closest<HTMLElement>('[tabindex="-1"]')?.focus({ preventScroll: true })
  if (document.activeElement === field) field.blur()
}

/**
 * Esc in a team text field that holds a draft (app 2.7.0, E10 B5: a card's text
 * answer, the comment, Lead and run-now composers): consumed (prevented and
 * stopped, as the drawers, the dialogs and the overlay expect) and it only
 * leaves the field, so the draft stays; the next Esc closes as before. An empty
 * field lets it through. True when it took the key.
 */
export function escKeepsDraft(e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>, draft: string): boolean {
  if (e.key !== 'Escape' || e.nativeEvent.isComposing || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || !draft.trim()) return false
  e.preventDefault()
  e.stopPropagation()
  leaveField(e.currentTarget)
  return true
}

/** Refusals of a comment that say more than "it could not be sent". */
const COMMENT_FAIL_WORDED: readonly TeamError[] = ['cap', 'not_found', 'too_big', 'disabled']

/** Every key main writes a comment with (decision 65): its words are `teams.sys.<key>`, never the comment's `text`. */
const SYS_KEY: Record<SysKey, MessageKey> = {
  noQaRole: 'teams.sys.noQaRole',
  hireRejected: 'teams.sys.hireRejected',
  rebaseConflict: 'teams.sys.rebaseConflict',
  rebaseVerify: 'teams.sys.rebaseVerify',
  leadEscalation: 'teams.sys.leadEscalation',
}

/** A main-authored comment in the UI language; a key this version does not know reads as a plain app message. */
export function sysText(sys: SysText, t: TFn): string {
  const key = SYS_KEY[sys.key]
  return key ? t(key, sys.vars) : t('teams.comment.sysUnknown')
}

const KIND_KEY: Partial<Record<CommentView['kind'], MessageKey>> = {
  review: 'teams.comment.kind.review',
  system: 'teams.comment.kind.system',
  answer: 'teams.comment.kind.answer',
}

/**
 * Links an agent wrote open in the browser only after a confirm that shows
 * their whole target, and only for http(s) (the run chat's rule).
 */
export function useLinkConfirm(): { onLink: (href: string) => void; dialog: ReactNode } {
  const t = useT()
  const [link, setLink] = useState<string | null>(null)
  const onLink = useCallback((href: string) => {
    const safe = safeHref(href)
    if (safe) setLink(safe)
  }, [])
  const dialog = (
    <ConfirmDialog
      open={link !== null}
      title={t('teams.run.link.title')}
      message={t('teams.run.link.msg', { href: link ?? '' })}
      confirmLabel={t('teams.run.link.yes')}
      cancelLabel={t('common.cancel')}
      onConfirm={() => {
        const href = link ? safeHref(link) : null
        setLink(null)
        if (href) window.snApi.system.openExternal(href)
      }}
      onCancel={() => setLink(null)}
    />
  )
  return { onLink, dialog }
}

/** The body of a comment: a `sys` one worded from its key, else the author's Markdown (never HTML). */
export function CommentBody({ comment, onLink, className }: { comment: CommentView; onLink: (href: string) => void; className?: string }) {
  const t = useT()
  if (comment.sys) {
    return (
      <p data-comment-sys={comment.sys.key} className={cn('whitespace-pre-wrap break-words text-xs text-text-secondary', className)}>
        {sysText(comment.sys, t)}
      </p>
    )
  }
  return <ChatMarkdown text={comment.text} onLink={onLink} className={className} />
}

/** Who wrote it: "Vos", "Sistema" or the agent's name main sent. */
export function authorText(c: CommentView, t: TFn): string {
  if (c.author === 'user') return t('teams.comment.you')
  if (c.author === 'system') return t('teams.comment.system')
  return c.authorName || c.author
}

/** The queued chip: the recipient main fixed when the comment was written (never today's assignee, 4.5). */
function queuedText(c: CommentView, t: TFn): string {
  const to = c.recipientName || c.recipient
  return to ? t('teams.comment.queued', { agent: to }) : t('teams.comment.queuedAny')
}

/** teamId/taskId -> the unsent comment while the drawer is closed (this session only, never stored). */
const drafts = new Map<string, string>()

/**
 * The comments of a task (app 2.7.0, E10 B3): oldest first, "Ver anteriores"
 * for the pages before, each with its author, time and kind; a comment that
 * waits for its recipient says "En cola para Dev 2" (the agent main fixed
 * when it was written, `recipient`); a `sys` comment is worded from
 * `teams.sys.<key>` (`data-comment-sys`). The composer at the foot: Enter is
 * a new line, only [Comentar] or Ctrl+Enter sends, Esc with a draft only
 * leaves the box; main picks the recipient and queues it for their next run
 * (nothing here runs).
 */
export function TaskComments({ teamId, taskId, entry }: { teamId: string; taskId: string; entry: TaskEntry }) {
  const t = useT()
  const lang = useLang()
  const { onLink, dialog } = useLinkConfirm()
  const detail = entry.detail
  const key = `${teamId}/${taskId}`
  const [draft, setDraftState] = useState(() => drafts.get(key) ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!detail) return null

  const byId = new Map<string, CommentView>()
  for (const c of [...entry.older, ...detail.comments]) byId.set(c.id, c)
  const comments = [...byId.values()].sort((a, b) => a.at - b.at || Number(a.id.slice(2)) - Number(b.id.slice(2)))
  const cursor = entry.older.length ? entry.olderCursor : detail.commentsCursor
  const now = Date.now()

  const setDraft = (v: string): void => {
    if (v) drafts.set(key, v)
    else drafts.delete(key)
    setDraftState(v)
  }
  const text = draft.trim()
  const control = BODY_BAD_RE.test(text)
  const canSend = !busy && text !== '' && !control
  const send = async (): Promise<void> => {
    if (!canSend) return
    const sent = draft
    setBusy(true)
    setError(null)
    const fail = await addComment(teamId, taskId, text)
    setBusy(false)
    if (fail) {
      setError(COMMENT_FAIL_WORDED.includes(fail.error) ? taskFailText(fail, t) : t('teams.comment.failed'))
      return
    }
    if ((drafts.get(key) ?? '') === sent) setDraft('')
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (escKeepsDraft(e, draft)) return
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.altKey || e.shiftKey || !(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    void send()
  }

  return (
    <section data-task-comments className="flex flex-col gap-2">
      {cursor && (
        <button
          type="button"
          data-comment-older
          disabled={entry.olderLoading}
          onClick={() => void loadOlderComments(teamId, taskId)}
          className="self-start rounded px-1 text-[11px] text-text-secondary hover:text-text-primary disabled:opacity-60"
        >
          {entry.olderLoading ? t('teams.comment.loadingOlder') : t('teams.comment.older')}
        </button>
      )}
      {entry.olderFailed && <p className="text-[11px] text-state-error">{t('teams.comment.olderFailed')}</p>}
      {!cursor && detail.commentsArchived > 0 && <p className="text-[11px] text-text-secondary">{t('teams.comment.archived', { count: detail.commentsArchived })}</p>}
      {comments.length === 0 ? (
        <p className="text-xs text-text-secondary">{t('teams.comment.empty')}</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {comments.map((c) => {
            const kind = KIND_KEY[c.kind]
            return (
              <li key={c.id} data-comment={c.id} data-comment-author={c.author} className="min-w-0 rounded-btn border border-border bg-card/40 px-2.5 py-2">
                <div className="mb-1 flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="min-w-0 truncate text-xs font-medium text-text-primary">{authorText(c, t)}</span>
                  {kind && <span className={cn(CHIP, CHIP_NEUTRAL)}>{t(kind)}</span>}
                  <span className="text-[11px] tabular-nums text-text-secondary">{clockTime(c.at, lang, now)}</span>
                  {c.queued && (
                    <span data-comment-queued={c.recipient ?? ''} className={cn(CHIP, 'border-accent-violet/40 text-text-secondary')}>
                      {queuedText(c, t)}
                    </span>
                  )}
                </div>
                <CommentBody comment={c} onLink={onLink} />
              </li>
            )
          })}
        </ol>
      )}
      <div data-comment-box className="mt-1">
        <textarea
          data-comment-composer
          value={draft}
          rows={3}
          maxLength={COMMENT_TEXT_MAX}
          aria-label={t('teams.comment.label')}
          placeholder={t('teams.comment.placeholder')}
          onKeyDown={onKeyDown}
          onChange={(e) => {
            setDraft(e.target.value)
            if (error) setError(null)
          }}
          className="block max-h-48 min-h-[4rem] w-full resize-y rounded-btn border border-border bg-bg-primary px-2.5 py-1.5 text-[13px] leading-[1.4] text-text-primary outline-none placeholder:text-text-secondary/60 focus:border-accent-violet/50"
        />
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2">
          <p role="status" data-comment-note={error ? 'error' : control ? 'control' : 'hint'} className={cn('min-w-0 flex-1 text-[11px] leading-4', error || control ? 'text-state-error' : 'text-text-secondary')}>
            {error ?? (control ? t('teams.comment.control') : t('teams.comment.hint'))}
          </p>
          <Button size="sm" data-comment-send disabled={!canSend} keyHint={SEND_KEYS} onClick={() => void send()} className="h-8">
            {busy ? t('teams.comment.sending') : t('teams.comment.send')}
          </Button>
        </div>
      </div>
      {dialog}
    </section>
  )
}
