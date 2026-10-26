/**
 * The chat with a team's Lead on the phone (app 2.7.0, E10 B8): the Lead
 * thread (`lead`, "Ver anteriores" pages back) as bubbles, the user's on the
 * right, the Lead's on the left in Markdown (agent text spelled out), a
 * message main wrote from its key; "El Líder está trabajando" while its run
 * is live and "Lo lee en su próxima corrida" under a message it has not read
 * yet. The composer sends only on Enviar (`leadSay`), dictated words
 * included; the Lead reads it in its next run. A reload (a change on the PC,
 * a message sent) keeps the earlier messages loaded (keepOlderPages).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { COMMENT_TEXT_MAX } from '@shared/teams'
import type { CommentView, LeadView } from '@shared/team-protocol'
import { PushScreen } from '../PushScreen'
import { NoReply } from '../NoReply'
import { Markdown } from '../chat/Markdown'
import { COMPOSER_CLEARANCE_PX, Composer, GHOST_BTN, LoadFailed, Spinner, bodyProblem, keepOlderPages, loadStatusOf, outgoingText, useTeamChange, type Load, type OlderPages } from './TeamBits'
import { isRunLive, refusalOf, replyOf, sysText, visibleName, visibleText, writeFailText } from './teamText'
import { client } from '../../lib/client'
import { closeLeadChat, useTeamsUi } from '../../lib/teamsStore'
import { relativeAge } from '../../lib/statusText'
import { stopDictation } from '../../lib/voice'
import { t } from '../../lib/i18n'

const MIC_OWNER = 'teamLead'

function LeadBubble({ m, now }: { m: CommentView; now: number }): ReactNode {
  if (m.sys || m.author === 'system')
    return (
      <div data-lead-msg={m.id} data-lead-author="system" data-comment-sys={m.sys?.key} className="flex justify-center px-4">
        <span className="max-w-full whitespace-pre-wrap text-center text-[11px] text-text-secondary [overflow-wrap:anywhere]">{m.sys ? sysText(m) : visibleText(m.text)}</span>
      </div>
    )
  if (m.author === 'user')
    return (
      <div data-lead-msg={m.id} data-lead-author="user" className="flex flex-col items-end gap-0.5">
        <div className="min-w-0 max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent-violet px-3 py-2 text-sm text-white [overflow-wrap:anywhere]">{visibleText(m.text)}</div>
        <span className="px-1 text-[10px] text-text-secondary">
          {m.queued ? t('teams.lead.queued') : relativeAge(m.at, now)}
        </span>
      </div>
    )
  return (
    <div data-lead-msg={m.id} data-lead-author="lead" className="flex flex-col items-start gap-0.5">
      <span className="px-1 text-[10px] text-text-secondary">{visibleName(m.authorName || m.author)}</span>
      <div className="min-w-0 max-w-[92%] rounded-2xl rounded-bl-md border border-border bg-bg-secondary px-3 py-2 text-sm">
        <Markdown text={visibleText(m.text)} />
      </div>
      <span className="px-1 text-[10px] text-text-secondary">{relativeAge(m.at, now)}</span>
    </div>
  )
}

export function LeadChatBody({ teamId }: { teamId: string }): ReactNode {
  const [lead, setLead] = useState<Load<LeadView>>({ status: 'loading', value: null })
  const [older, setOlder] = useState<OlderPages<CommentView> | null>(null)
  const [olderBusy, setOlderBusy] = useState(false)
  const [olderFailed, setOlderFailed] = useState(false)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)
  const endRef = useRef<HTMLDivElement | null>(null)
  const scrolled = useRef(false)
  /** What a reload keeps: the messages shown and the earlier pages "Ver anteriores" loaded. */
  const shownRef = useRef<{ page: readonly CommentView[]; older: OlderPages<CommentView> | null }>({ page: [], older: null })
  shownRef.current = { page: lead.value?.messages ?? [], older }

  const load = useCallback(async (): Promise<void> => {
    const n = ++seq.current
    const out = await client.requestTeam({ op: 'lead', teamId })
    if (n !== seq.current) return
    const ok = replyOf(out)
    if (!ok) {
      const status = loadStatusOf(refusalOf(out))
      setLead((cur) => ({ status, value: status === 'gone' ? null : cur.value }))
      return
    }
    const prev = shownRef.current
    setLead({ status: 'ok', value: ok.lead })
    setOlder(keepOlderPages(prev.older, prev.page, ok.lead.messages, ok.lead.cursor))
  }, [teamId])

  useEffect(() => {
    void load()
  }, [load])
  useTeamChange(teamId, 'lead', undefined, () => void load())

  // The first page lands at the newest message.
  useLayoutEffect(() => {
    if (scrolled.current || !lead.value) return
    scrolled.current = true
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [lead.value])

  const view = lead.value
  const loadOlder = async (): Promise<void> => {
    const cursor = older ? older.cursor : view?.cursor
    if (!cursor || olderBusy) return
    const n = seq.current
    setOlderBusy(true)
    setOlderFailed(false)
    const out = await client.requestTeam({ op: 'lead', teamId, before: cursor })
    setOlderBusy(false)
    if (n !== seq.current) return
    const ok = replyOf(out)
    if (!ok) {
      setOlderFailed(true)
      return
    }
    setOlder((cur) => {
      const have = new Set([...(cur?.items ?? []), ...(view?.messages ?? [])].map((m) => m.id))
      return { items: [...ok.lead.messages.filter((m) => !have.has(m.id)), ...(cur?.items ?? [])], cursor: ok.lead.cursor }
    })
  }

  const send = async (): Promise<void> => {
    const value = outgoingText(text).trim()
    if (!value || sending) return
    const problem = bodyProblem(value, COMMENT_TEXT_MAX)
    if (problem) {
      setError(problem)
      return
    }
    stopDictation(MIC_OWNER, true)
    const sent = text
    setSending(true)
    setError(null)
    const out = await client.requestTeam({ op: 'leadSay', teamId, text: value })
    setSending(false)
    const ok = replyOf(out)
    if (!ok) {
      setError(writeFailText(refusalOf(out) ?? { error: 'io' }, 'teams.lead.sendFailed'))
      return
    }
    // Only what was sent goes: text typed or dictated while the message was out stays in the field.
    setText((cur) => (cur.startsWith(sent) ? cur.slice(sent.length).replace(/^\s+/, '') : cur))
    setLead((cur) => (cur.value && !cur.value.messages.some((m) => m.id === ok.comment.id) ? { ...cur, value: { ...cur.value, messages: [...cur.value.messages, ok.comment] } } : cur))
    requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: 'end' }))
    void load()
  }

  if (lead.status === 'gone') return <p className="py-8 text-center text-sm text-text-secondary">{t('teams.board.gone')}</p>
  if (!view) {
    if (lead.status === 'loading') return <Spinner />
    if (lead.status === 'noReply') return <NoReply onRetry={() => void load()} />
    return <LoadFailed text={t('teams.lead.loadFailed')} onRetry={() => void load()} />
  }
  const now = Date.now()
  const messages = [...(older?.items ?? []), ...view.messages]
  const cursor = older ? older.cursor : view.cursor
  const working = !!view.agent?.run && isRunLive(view.agent.run.state)
  return (
    <div data-lead-chat={teamId} className="flex min-w-0 flex-col gap-3">
      {lead.status === 'noReply' && <NoReply onRetry={() => void load()} />}
      {cursor && (
        <button type="button" data-lead-older disabled={olderBusy} onClick={() => void loadOlder()} className={GHOST_BTN}>
          {olderBusy && <Loader2 size={16} className="spin" />}
          {t('teams.lead.older')}
        </button>
      )}
      {olderFailed && <p className="px-1 text-[11px] text-state-error">{t('teams.lead.olderFailed')}</p>}
      {messages.length === 0 && <p className="px-4 py-6 text-center text-sm text-text-secondary">{t('teams.lead.empty')}</p>}
      {messages.map((m) => (
        <LeadBubble key={m.id} m={m} now={now} />
      ))}
      {working && (
        <p data-lead-working className="flex items-center gap-2 px-1 text-xs text-text-secondary">
          <Loader2 size={14} className="spin" aria-hidden />
          {t('teams.lead.working')}
        </p>
      )}
      <div ref={endRef} />
      <div className="sticky bottom-0 -mx-4 border-t border-border bg-bg-primary px-4 pb-1 pt-2">
        <Composer
          owner={MIC_OWNER}
          value={text}
          onChange={setText}
          onSend={() => void send()}
          sending={sending}
          label={t('teams.lead.composerLabel')}
          placeholder={t('teams.lead.placeholder')}
          sendLabel={t('teams.lead.send')}
          sendingLabel={t('teams.lead.sending')}
          maxLength={COMMENT_TEXT_MAX}
          error={error}
          resetKey={teamId}
          sendAttr="data-lead-send"
          fieldAttr="data-lead-text"
        />
      </div>
    </div>
  )
}

export function LeadChatScreen(): ReactNode {
  const teamId = useTeamsUi((s) => s.leadFor)
  const name = useTeamsUi((s) => (s.leadFor ? s.list?.find((x) => x.id === s.leadFor)?.name : undefined))
  const title = name ? `${t('teams.lead.title')} - ${visibleName(name)}` : t('teams.lead.title')
  return (
    <PushScreen id="team-lead" open={teamId != null} onClose={closeLeadChat} title={title} toastBottom={COMPOSER_CLEARANCE_PX}>
      {teamId && <LeadChatBody key={teamId} teamId={teamId} />}
    </PushScreen>
  )
}
