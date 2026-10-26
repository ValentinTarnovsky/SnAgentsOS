import { useState, type KeyboardEvent } from 'react'
import { Check, Send, X } from 'lucide-react'
import { CARD_TEXT_ANSWER_MAX, type CardAction, type CardAnswer, type CardReason } from '@shared/teams'
import type { CardView } from '@shared/team-protocol'
import { useT, type MessageKey, type TFn } from '@/i18n'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { answerCard, answerFailText, busyKey, useNeedsStore } from '@/lib/teams/needs'
import { visibleName } from '@/lib/teams/issues'
import { ChatMarkdown } from '@/components/chat/Markdown'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { SMALL_BTN, SMALL_BTN_QUIET, SMALL_BTN_TEXT } from './RunHeader'
import { BODY_BAD_RE, escKeepsDraft, useLinkConfirm } from './TaskComments'

export const CARD_WHY_KEY: Record<CardReason, MessageKey> = {
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

export const CARD_ACTION_KEY: Record<CardAction, MessageKey> = {
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

/** Actions that ask first: they cancel a task or end a process. */
const ASKS_FIRST: readonly CardAction[] = ['cancelTask', 'killOrphan']

/** Why a system card is up, in words; its vars (task ids, a pid) are main's, spelled out like any repo text. */
export function cardWhyText(system: NonNullable<CardView['system']>, t: TFn): string {
  const v = system.vars ?? {}
  const str = (k: string): string => visibleName(String(v[k] ?? ''))
  if (system.why === 'stateReset' && v.what === 'trust') return t('teams.cardWhy.stateResetTrust')
  // B5 integration, seventh round: the command line through cmd.exe of a .cmd agent CLI would be too long (RunStarter).
  if (system.why === 'spawnFailed' && v.what === 'cmdLine') return t('teams.cardWhy.spawnFailedCmdLine')
  return t(CARD_WHY_KEY[system.why] ?? 'teams.cardWhy.failure', {
    blockers: str('blockers').split(',').filter(Boolean).join(', '),
    pid: str('pid'),
  })
}

/** Sends one answer; the toast says it went or why main refused it. */
function useAnswer(teamId: string, card: CardView): { send: (a: CardAnswer, ok?: MessageKey) => Promise<boolean>; busy: boolean } {
  const t = useT()
  const busy = useNeedsStore((s) => !!s.busy[busyKey(teamId, card.id)])
  const send = async (a: CardAnswer, ok: MessageKey = 'teams.need.q.sent'): Promise<boolean> => {
    const fail = await answerCard(teamId, card.id, a)
    if (fail) toast.error(answerFailText(fail, t))
    else toast.success(t(ok))
    return !fail
  }
  return { send, busy }
}

function SystemCard({ teamId, card, system }: { teamId: string; card: CardView; system: NonNullable<CardView['system']> }) {
  const t = useT()
  const { send, busy } = useAnswer(teamId, card)
  const [ask, setAsk] = useState<CardAction | null>(null)
  const act = (action: CardAction): void => {
    void send({ action }, 'teams.cardAction.done')
  }
  const pid = visibleName(String(system.vars?.pid ?? ''))
  return (
    <div data-card-system={system.why} className="flex min-w-0 flex-col gap-2">
      <p data-card-why className="break-words text-xs text-text-primary">
        {cardWhyText(system, t)}
      </p>
      {system.actions.length > 0 && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {system.actions.map((a) => (
            <button
              key={a}
              type="button"
              data-card-action={a}
              disabled={busy}
              onClick={() => (ASKS_FIRST.includes(a) ? setAsk(a) : act(a))}
              className={cn(SMALL_BTN, a === 'dismiss' ? SMALL_BTN_QUIET : SMALL_BTN_TEXT)}
            >
              {t(CARD_ACTION_KEY[a])}
            </button>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={ask !== null}
        danger
        title={ask === 'killOrphan' ? t('teams.cardAction.killOrphanTitle') : t('teams.cardAction.cancelTaskTitle', { id: card.taskId ?? '' })}
        message={ask === 'killOrphan' ? t('teams.cardAction.killOrphanMsg', { pid }) : t('teams.cardAction.cancelTaskMsg')}
        confirmLabel={ask === 'killOrphan' ? t('teams.cardAction.killOrphanYes') : t('teams.cardAction.cancelTaskYes')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => {
          const a = ask
          setAsk(null)
          if (a) act(a)
        }}
        onCancel={() => setAsk(null)}
      />
    </div>
  )
}

function AgentCard({ teamId, card }: { teamId: string; card: CardView }) {
  const t = useT()
  const { onLink, dialog } = useLinkConfirm()
  const { send, busy } = useAnswer(teamId, card)
  const [picked, setPicked] = useState<number[]>([])
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const options = card.options ?? []

  const sendText = (): void => {
    if (!text.trim()) {
      setError(t('teams.need.q.textRequired'))
      return
    }
    if (BODY_BAD_RE.test(text)) {
      setError(t('teams.approval.noteBad'))
      return
    }
    setError(null)
    void send({ text: text.trim() }).then((ok) => ok && setText(''))
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing || escKeepsDraft(e, text)) return
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault()
      sendText()
    }
  }

  return (
    <div data-card-kind={card.kind} className="flex min-w-0 flex-col gap-2">
      {card.question?.trim() && (
        <div data-card-question className="min-w-0 max-h-64 overflow-y-auto">
          <ChatMarkdown text={card.question} onLink={onLink} />
        </div>
      )}
      {card.kind === 'choice' && (
        <div className="flex min-w-0 flex-col gap-1.5">
          {card.multi && <p className="text-[11px] text-text-secondary">{t('teams.need.q.multi')}</p>}
          <div role={card.multi ? 'group' : undefined} className="flex min-w-0 flex-wrap gap-1.5">
            {options.map((o, i) => {
              const on = picked.includes(i)
              return (
                <button
                  key={i}
                  type="button"
                  data-card-option={i}
                  aria-pressed={card.multi ? on : undefined}
                  disabled={busy}
                  onClick={() => {
                    // One choice answers at once; several are picked first and sent with Responder.
                    if (!card.multi) void send({ choices: [i] })
                    else {
                      setPicked((cur) => (cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i].sort((a, b) => a - b)))
                      setError(null)
                    }
                  }}
                  className={cn(
                    'inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-btn border px-2.5 py-1 text-left text-xs transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-violet/60',
                    on ? 'border-accent-violet/60 bg-accent-violet/10 text-text-primary' : 'border-border text-text-primary hover:bg-card',
                  )}
                >
                  {card.multi && <Check size={12} aria-hidden className={cn('shrink-0', on ? 'opacity-100' : 'opacity-0')} />}
                  <span className="min-w-0 break-words">{o}</span>
                </button>
              )
            })}
          </div>
          {card.multi && (
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                data-card-send
                disabled={busy}
                onClick={() => {
                  if (picked.length === 0) setError(t('teams.need.q.pickRequired'))
                  else void send({ choices: picked })
                }}
                className={cn(SMALL_BTN, SMALL_BTN_TEXT)}
              >
                <Send size={13} aria-hidden />
                {t('teams.need.q.answer')}
              </button>
            </div>
          )}
        </div>
      )}
      {card.kind === 'text' && (
        <div className="flex min-w-0 flex-col gap-1.5">
          <textarea
            data-card-text
            value={text}
            rows={3}
            maxLength={CARD_TEXT_ANSWER_MAX}
            placeholder={t('teams.need.q.placeholder')}
            aria-label={t('teams.need.q.placeholder')}
            aria-invalid={error ? true : undefined}
            onKeyDown={onKey}
            onChange={(e) => {
              setText(e.target.value)
              if (error) setError(null)
            }}
            className="block max-h-48 min-h-[4.5rem] w-full resize-y rounded-btn border border-border bg-bg-primary px-2.5 py-1.5 text-[13px] leading-[1.45] text-text-primary outline-none focus:border-accent-violet/50"
          />
          <div className="flex min-w-0 items-center justify-end">
            <button type="button" data-card-send disabled={busy} onClick={sendText} className={cn(SMALL_BTN, SMALL_BTN_TEXT)}>
              <Send size={13} aria-hidden />
              {t('teams.need.q.answer')}
            </button>
          </div>
        </div>
      )}
      {card.kind === 'confirm' && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <button type="button" data-card-confirm="yes" disabled={busy} onClick={() => void send({ confirm: true })} className={cn(SMALL_BTN, SMALL_BTN_TEXT)}>
            <Check size={13} aria-hidden />
            {t('teams.need.q.done')}
          </button>
          <button type="button" data-card-confirm="no" disabled={busy} onClick={() => void send({ confirm: false })} className={cn(SMALL_BTN, SMALL_BTN_QUIET)}>
            <X size={13} aria-hidden />
            {t('teams.need.q.cant')}
          </button>
        </div>
      )}
      {error && (
        <p data-card-error className="text-[11px] text-state-error" role="alert">
          {error}
        </p>
      )}
      {dialog}
    </div>
  )
}

/**
 * A card of Te necesita (app 2.7.0, E10 B5). An agent's question (`team ask`
 * or `team needs`): its Markdown, then the options (one answers at once,
 * several are picked and sent with Responder), a text answer (Enter is a new
 * line, Ctrl+Enter or Responder sends, Esc with a draft only leaves the box)
 * or Hecho / No puedo. A system card
 * (main raised it: no progress, QA rounds, a failure, an auth pause, a
 * process left behind...): why, in words, and its actions; cancelling the
 * task or ending a process asks first. The asking agent gets the answer in
 * its next run; nothing is sent without its button.
 */
export function QuestionCard({ teamId, card }: { teamId: string; card: CardView }) {
  return card.system ? <SystemCard teamId={teamId} card={card} system={card.system} /> : <AgentCard teamId={teamId} card={card} />
}
