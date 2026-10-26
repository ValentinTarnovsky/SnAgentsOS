import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { COMMENT_TEXT_MAX, isActiveRun } from '@shared/teams'
import type { AgentView, CommentView } from '@shared/team-protocol'
import { useLang, useT } from '@/i18n'
import { cn } from '@/lib/cn'
import { clockTime } from '@/lib/statusSignals'
import { loadLead, sayToLead, threadMessages, useLeadStore } from '@/lib/teams/lead'
import { Button } from '@/components/ui/Button'
import { StatusGlyph } from '@/components/ui/StatusDot'
import { BODY_BAD_RE, CommentBody, authorText, escKeepsDraft, useLinkConfirm } from './TaskComments'
import { taskFailText } from './TaskCard'

const SEND_KEYS = ['Ctrl', 'Enter']

/** teamId -> the unsent message while the drawer is closed (this session only, never stored). */
const drafts = new Map<string, string>()

/** One message of the thread: the user's on the right, the Lead's on the left (Markdown), a main line small. */
export function LeadMessage({ m, onLink, compact }: { m: CommentView; onLink: (href: string) => void; compact?: boolean }) {
  const t = useT()
  const lang = useLang()
  const mine = m.author === 'user'
  if (m.sys || m.author === 'system') {
    return (
      <li data-lead-msg={m.id} data-lead-author="system" className="px-2">
        <CommentBody comment={m} onLink={onLink} className="text-center text-[11px]" />
      </li>
    )
  }
  return (
    <li data-lead-msg={m.id} data-lead-author={mine ? 'user' : 'lead'} className={cn('flex min-w-0 flex-col gap-1', mine ? 'items-end' : 'items-start')}>
      <div className={cn('min-w-0 max-w-[88%] rounded-card border px-3 py-2', mine ? 'border-border bg-card' : 'border-border/60 bg-bg-secondary/50', compact && 'max-w-full py-1.5')}>
        <CommentBody comment={m} onLink={onLink} className={compact ? 'line-clamp-3' : undefined} />
      </div>
      <div className="flex items-center gap-1.5 px-1 text-[10px] text-text-secondary">
        <span>{mine ? t('teams.lead.you') : authorText(m, t)}</span>
        <span className="tabular-nums">{clockTime(m.at, lang, Date.now())}</span>
        {mine && m.queued && (
          <span data-lead-queued className="rounded border border-accent-violet/40 px-1 leading-4">
            {t('teams.lead.queued')}
          </span>
        )}
      </div>
    </li>
  )
}

/**
 * The conversation with the Lead (app 2.7.0, E10 B3), the first view of the
 * Lead's drawer: the thread main keeps (`lead`), "Ver anteriores" for the
 * pages before, "El Líder está trabajando" while its run is live, and the
 * composer (Enter is a new line, only [Enviar] or Ctrl+Enter sends, Esc with
 * a draft only leaves the box). A
 * message is a comment main queues for the Lead's next run ("Lo lee en su
 * próxima corrida"): nothing here starts a run or touches a console.
 */
export function LeadThreadView({ teamId, lead }: { teamId: string; lead: AgentView | undefined }) {
  const t = useT()
  const thread = useLeadStore((s) => s.threads[teamId])
  const { onLink, dialog } = useLinkConfirm()
  const [draft, setDraftState] = useState(() => drafts.get(teamId) ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const boxRef = useRef<HTMLTextAreaElement | null>(null)
  const messages = threadMessages(thread)
  const lastId = messages[messages.length - 1]?.id

  useEffect(() => {
    void loadLead(teamId)
    // The drawer is still sliding in: a plain focus would scroll the app's overflow-hidden root sideways.
    boxRef.current?.focus({ preventScroll: true })
  }, [teamId])
  // A new message at the end scrolls into view (an older page in front keeps the place).
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lastId])

  const setDraft = (v: string): void => {
    if (v) drafts.set(teamId, v)
    else drafts.delete(teamId)
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
    const fail = await sayToLead(teamId, text)
    setBusy(false)
    if (fail) {
      setError(fail.error === 'io' ? t('teams.lead.sendFailed') : taskFailText(fail, t))
      return
    }
    if ((drafts.get(teamId) ?? '') === sent) setDraft('')
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (escKeepsDraft(e, draft)) return
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.altKey || e.shiftKey || !(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    void send()
  }
  const cursor = thread?.older.length ? thread.olderCursor : thread?.cursor
  const working = !!lead?.run && isActiveRun(lead.run.state)

  return (
    <div data-lead-thread={teamId} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {!thread || (thread.loading && messages.length === 0) ? (
          <p className="text-sm text-text-secondary" data-lead-loading>
            {t('teams.lead.loading')}
          </p>
        ) : thread.failed && messages.length === 0 ? (
          <div className="flex flex-col items-start gap-3" data-lead-failed>
            <p className="text-sm text-text-secondary">{t('teams.lead.loadFailed')}</p>
            <Button variant="ghost" size="sm" onClick={() => void loadLead(teamId)}>
              {t('teams.lead.retry')}
            </Button>
          </div>
        ) : (
          <>
            {cursor && (
              <button
                type="button"
                data-lead-older
                disabled={thread.olderLoading}
                onClick={() => void loadLead(teamId, true)}
                className="mb-2 rounded px-1 text-[11px] text-text-secondary hover:text-text-primary disabled:opacity-60"
              >
                {thread.olderLoading ? t('teams.comment.loadingOlder') : t('teams.lead.older')}
              </button>
            )}
            {thread.olderFailed && <p className="mb-2 text-[11px] text-state-error">{t('teams.lead.olderFailed')}</p>}
            {messages.length === 0 ? (
              <p className="text-sm text-text-secondary" data-lead-empty>
                {t('teams.lead.empty')}
              </p>
            ) : (
              <ol className="flex flex-col gap-3">
                {messages.map((m) => (
                  <LeadMessage key={m.id} m={m} onLink={onLink} />
                ))}
              </ol>
            )}
          </>
        )}
        {working && (
          <p data-lead-working className="mt-3 flex items-center gap-1.5 text-xs text-text-secondary">
            <StatusGlyph kind="working" size={13} noTooltip />
            {t('teams.lead.working')}
          </p>
        )}
      </div>
      <div data-lead-composer-box className="shrink-0 border-t border-border bg-bg-secondary/40 px-3 py-2">
        <textarea
          ref={boxRef}
          data-lead-composer
          value={draft}
          rows={3}
          maxLength={COMMENT_TEXT_MAX}
          aria-label={t('teams.lead.composerLabel')}
          placeholder={t('teams.lead.placeholder')}
          onKeyDown={onKeyDown}
          onChange={(e) => {
            setDraft(e.target.value)
            if (error) setError(null)
          }}
          className="block max-h-48 min-h-[4rem] w-full resize-none rounded-btn border border-border bg-bg-primary px-2.5 py-1.5 text-[13px] leading-[1.4] text-text-primary outline-none placeholder:text-text-secondary/60 focus:border-accent-violet/50"
        />
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2">
          <p role="status" data-lead-note={error ? 'error' : control ? 'control' : 'hint'} className={cn('min-w-0 flex-1 text-[11px] leading-4', error || control ? 'text-state-error' : 'text-text-secondary')}>
            {error ?? (control ? t('teams.comment.control') : t('teams.lead.composerHint'))}
          </p>
          <Button size="sm" data-lead-send disabled={!canSend} keyHint={SEND_KEYS} onClick={() => void send()} className="h-8">
            {busy ? t('teams.lead.sending') : t('teams.lead.send')}
          </Button>
        </div>
      </div>
      {dialog}
    </div>
  )
}
