/**
 * One row of "Te necesita" on the phone (app 2.7.0, E10 B8), shared by the
 * Te necesita screen and the task screen (that task's rows first). By kind:
 *
 *  - a plan or a final OK: Aprobar, or Pedir cambios with a note (required,
 *    dictation, sent only on Enviar) -> teamDecide;
 *  - a permission: the rule and the denied command, Aprobar / Rechazar after
 *    a confirmation -> teamDecide;
 *  - a question: one option sends at once, several wait for Responder, a
 *    text answer (dictation) waits for Responder, a confirm is Hecho / No
 *    puedo; a system card offers its actions -> teamAnswer;
 *  - a run to dispatch: Despachar / Descartar -> teamDispatch;
 *  - the definition to trust, an auth or billing pause, a hire (its diff,
 *    cut to TEAM_PHONE_HIRE_LINES), an integrate and the PC-only card actions
 *    (resumeTeam, killOrphan): read only with "En la PC" (decision 50; main
 *    refuses them from the phone anyway);
 *  - an approval or a card the PC could not send whole (fitMarks pcOnly,
 *    Tanda B close): read only with "En la PC", what came of it shown with
 *    "Sigue en la PC" (never an Aprobar for a rule the user cannot read).
 *
 * Every agent and repo text goes through visibleText. Each send waits for
 * its ack; a refusal says why in words, an ok hides the row (onDone). A
 * decide carries the approval's rev; a stale one (a permission a later run
 * grew) reads Te necesita again (onStale) and says it changed.
 */
import { useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { Check, ChevronRight, Loader2, MessageSquareText, Send, X } from 'lucide-react'
import type { ChatPatchHunk } from '@shared/chat-types'
import { CARD_TEXT_ANSWER_MAX, DECIDE_NOTE_MAX, DESKTOP_ONLY_CARD_ACTIONS, type CardAction, type CardAnswer } from '@shared/teams'
import type { ApprovalView, CardView, QueueItemView, TeamCtlAction, TeamNeedsView } from '@shared/team-protocol'
import { TEAM_PHONE_HIRE_LINES } from '@shared/team-protocol'
import { teamNeedKey, type TeamNeedRow } from '@shared/teamNeeds'
import { Sheet } from '../Sheet'
import { ConfirmSheet, type ConfirmState } from '../ConfirmSheet'
import { MicButton, VoiceInterim } from '../MicButton'
import { DiffBlock } from '../chat/DiffBlock'
import { Chip, Folded, GHOST_BTN, MoreOnPc, OnPcChip, PRIMARY_BTN, bodyOk, bodyProblem, outgoingText } from './TeamBits'
import {
  CARD_ACTION_KEY,
  MODE_KEY,
  answerFailText,
  approvalRevOf,
  cardWhyText,
  decideFailText,
  deferText,
  dispatchFailText,
  fitMarks,
  hasTeamKey,
  isStaleRefusal,
  refusalOfAck,
  visibleName,
  visibleText,
} from './teamText'
import { client } from '../../lib/client'
import { openTeamTask } from '../../lib/teamsStore'
import { useRemoteStore } from '../../lib/store'
import { relativeAge } from '../../lib/statusText'
import { spaced, stopDictation } from '../../lib/voice'
import { t, type MobileMessageKey } from '../../lib/i18n'

function toast(text: string): void {
  useRemoteStore.getState().setToast(text)
}

/**
 * Sends one decision; true once the PC applied it. A refusal stays in words
 * under the row (`onFail`, cleared by the next try): a toast would be cut to
 * one line, and it may say what to do next.
 */
async function sendCtl(action: TeamCtlAction, failText: (error: string | undefined) => string, onFail: (text: string | null) => void): Promise<boolean> {
  onFail(null)
  const res = await client.sendTeamCtl(action)
  if (res.ok) return true
  onFail(failText(res.error))
  return false
}

function NeedError({ text }: { text: string | null }): ReactNode {
  if (!text) return null
  return (
    <p role="alert" data-need-error className="text-xs text-state-error [overflow-wrap:anywhere]">
      {text}
    </p>
  )
}

/** The hire diff, every line spelled out and at most TEAM_PHONE_HIRE_LINES lines in all. */
function hireHunks(hunks: readonly ChatPatchHunk[]): { hunks: ChatPatchHunk[]; cut: boolean } {
  let left = TEAM_PHONE_HIRE_LINES
  const out: ChatPatchHunk[] = []
  let cut = false
  for (const h of hunks) {
    if (left <= 0) {
      cut = true
      break
    }
    const lines = h.lines.slice(0, left).map(visibleText)
    if (lines.length < h.lines.length) cut = true
    left -= lines.length
    out.push({ ...h, lines })
  }
  return { hunks: out, cut }
}

/**
 * The note of Pedir cambios: required, dictation into the field, sent only on
 * Enviar. `onSend` answers the refusal's words (the sheet stays open with
 * them) or null once the PC applied it.
 */
function NoteSheet({ open, onClose, onSend }: { open: boolean; onClose: () => void; onSend: (note: string) => Promise<string | null> }): ReactNode {
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const send = async (): Promise<void> => {
    const text = outgoingText(note).trim()
    if (!text) {
      setError(t('teams.approval.noteRequired'))
      return
    }
    if (!bodyOk(text)) {
      setError(t('teams.approval.noteBad'))
      return
    }
    if (text.length > DECIDE_NOTE_MAX) {
      setError(t('teams.comment.tooLong'))
      return
    }
    stopDictation('teamNote', true)
    setSending(true)
    setError(null)
    const why = await onSend(text)
    setSending(false)
    if (why) {
      setError(why)
      return
    }
    setNote('')
    onClose()
  }
  return (
    <Sheet open={open} onClose={onClose} title={t('teams.approval.changes')}>
      <div data-need-note className="flex flex-col gap-2 pb-2">
        <VoiceInterim owner="teamNote" />
        <textarea
          data-need-note-text
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={4}
          maxLength={DECIDE_NOTE_MAX}
          aria-label={t('teams.approval.noteChanges')}
          placeholder={t('teams.approval.noteChanges')}
          className="min-h-[96px] w-full resize-none rounded-btn border border-border bg-bg-secondary px-3 py-2 text-[15px] leading-6 text-text-primary outline-none focus:border-accent-violet"
        />
        {error && (
          <p role="alert" data-need-note-error className="text-xs text-state-error [overflow-wrap:anywhere]">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <MicButton owner="teamNote" onFinal={(chunk) => setNote((prev) => prev + spaced(prev, chunk))} />
          <button type="button" data-need-note-send disabled={sending} onClick={() => void send()} className={clsx(PRIMARY_BTN, 'flex-1')}>
            {sending ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
            {t('teams.approval.send')}
          </button>
        </div>
      </div>
    </Sheet>
  )
}

function ApprovalError({ error }: { error?: string }): ReactNode {
  if (!error) return null
  return <p className="text-[11px] text-state-action">{t(error === 'interrupted' ? 'teams.approval.interrupted' : 'teams.approval.lastFailed')}</p>
}

/** A row the PC could not send whole (fitMarks pcOnly): why, and "En la PC" in place of its buttons. */
function FitPcNote(): ReactNode {
  return (
    <>
      <p data-need-fit-pc className="text-xs text-text-secondary">
        {t('teams.need.fitPc')}
      </p>
      <OnPcChip />
    </>
  )
}

function ApprovalRow({ teamId, approval, onDone, onStale }: { teamId: string; approval: ApprovalView; onDone: () => void; onStale: () => void }): ReactNode {
  const [busy, setBusy] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [fail, setFail] = useState<string | null>(null)
  const p = approval.payload
  const pcOnly = fitMarks(approval).pcOnly
  const cut = fitMarks(p).truncated
  /** The refusal's words, or null once the PC applied it. */
  const decide = async (decision: 'approve' | 'reject', note?: string): Promise<string | null> => {
    setBusy(true)
    let why: string | null = null
    let stale = false
    // The rev of what is shown (Tanda B close): main refuses a permission that grew since as stale.
    const rev = approvalRevOf(approval)
    const ok = await sendCtl(
      { kind: 'teamDecide', teamId, approvalId: approval.id, decision, ...(note ? { note } : {}), ...(rev !== undefined ? { rev } : {}) },
      (e) => {
        const f = refusalOfAck(e)
        stale = isStaleRefusal(f)
        return decideFailText(f, p.kind, decision)
      },
      (text) => {
        why = text
        // A note's refusal shows in its sheet, which stays open.
        if (!note) setFail(text)
      },
    )
    setBusy(false)
    if (ok) {
      toast(t(decision === 'approve' ? 'teams.approval.approved' : note ? 'teams.approval.changesSent' : 'teams.approval.rejected'))
      onDone()
    } else if (stale) {
      // What it decided on changed on the PC: Te necesita reads it again, the words stay under the row.
      onStale()
    }
    return why
  }
  const applying = approval.state === 'applying'
  const buttons = (approve: ReactNode, second: ReactNode): ReactNode =>
    pcOnly ? (
      <>
        <NeedError text={fail} />
        <FitPcNote />
      </>
    ) : applying ? (
      <p className="flex items-center gap-1.5 text-xs text-text-secondary">
        <Loader2 size={13} className="spin" aria-hidden />
        {t('teams.approval.applying')}
      </p>
    ) : (
      <>
        <NeedError text={fail} />
        <div className="flex gap-2">
          {approve}
          {second}
        </div>
      </>
    )

  switch (p.kind) {
    case 'plan':
    case 'final': {
      const approve = (
        <button type="button" data-need-approve={approval.id} disabled={busy} onClick={() => void decide('approve')} className={clsx(GHOST_BTN, 'flex-1')}>
          {busy ? <Loader2 size={16} className="spin" /> : <Check size={16} />}
          {t('teams.approval.approve')}
        </button>
      )
      const changes = (
        <button type="button" data-need-changes={approval.id} disabled={busy} onClick={() => setNoteOpen(true)} className={clsx(GHOST_BTN, 'flex-1')}>
          <MessageSquareText size={16} />
          {t('teams.approval.changes')}
        </button>
      )
      return (
        <div className="flex min-w-0 flex-col gap-2">
          {p.kind === 'plan' ? (
            <>
              <div className="flex flex-wrap gap-1">
                {p.small && <Chip>{t('teams.approval.small')}</Chip>}
                <Chip>{t('teams.approval.rev', { rev: p.planRev })}</Chip>
              </div>
              {p.text.trim() ? (
                <div className="min-w-0 rounded-btn border border-border bg-bg-primary px-3 py-2">
                  <Folded data-need-plan={approval.id} text={visibleText(p.text)} markdown cut={p.truncated} />
                </div>
              ) : (
                <p className="text-xs text-text-secondary">{t('teams.approval.planEmpty')}</p>
              )}
            </>
          ) : (
            <>
              <p className="text-xs text-text-secondary">{t('teams.approval.finalHintNoQa')}</p>
              {p.summary.trim() ? (
                <div className="min-w-0 rounded-btn border border-border bg-bg-primary px-3 py-2">
                  <Folded data-need-summary={approval.id} text={visibleText(p.summary)} markdown cut={cut} />
                </div>
              ) : (
                <p className="text-xs text-text-secondary">{t('teams.approval.noSummary')}</p>
              )}
              {p.stat && (
                <div className="min-w-0 text-[11px] text-text-secondary">
                  <p className="tabular-nums">{t('teams.approval.stat', { files: p.stat.files, add: p.stat.insertions, del: p.stat.deletions })}</p>
                  {p.stat.top.map((f) => (
                    <p key={f.path} className="flex min-w-0 gap-2 font-mono">
                      <span className="min-w-0 truncate">{visibleName(f.path)}</span>
                      <span className="shrink-0 tabular-nums">
                        +{f.add} -{f.del}
                      </span>
                    </p>
                  ))}
                </div>
              )}
            </>
          )}
          <ApprovalError error={approval.error} />
          {buttons(approve, changes)}
          <NoteSheet open={noteOpen} onClose={() => setNoteOpen(false)} onSend={(note) => decide('reject', note)} />
        </div>
      )
    }
    case 'permission': {
      const role = visibleName(p.roleId)
      const approve =
        p.tools.length > 0 ? (
          <button
            type="button"
            data-need-approve={approval.id}
            disabled={busy}
            onClick={() => setConfirm({ message: t('teams.approval.grantConfirm', { role }), onConfirm: () => void decide('approve') })}
            className={clsx(GHOST_BTN, 'flex-1')}
          >
            {busy ? <Loader2 size={16} className="spin" /> : <Check size={16} />}
            {t('teams.approval.approve')}
          </button>
        ) : null
      const reject = (
        <button
          type="button"
          data-need-reject={approval.id}
          disabled={busy}
          onClick={() => setConfirm({ message: t('teams.approval.rejectConfirm'), onConfirm: () => void decide('reject') })}
          className={clsx(GHOST_BTN, 'flex-1')}
        >
          <X size={16} />
          {t('teams.approval.reject')}
        </button>
      )
      return (
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-xs text-text-secondary">{t('teams.approval.permissionHint', { role })}</p>
          <p className="text-[11px] font-medium text-text-secondary">{t('teams.approval.permissionRule')}</p>
          {p.tools.length > 0 ? (
            <div className="flex min-w-0 flex-wrap gap-1">
              {p.tools.map((tool) => (
                <span key={tool} data-permission-rule className="min-w-0 max-w-full break-all rounded border border-state-action/50 bg-state-action/10 px-1.5 py-0.5 font-mono text-[11px] text-text-primary">
                  {visibleName(tool)}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-text-secondary">{t('teams.approval.permissionNone')}</p>
          )}
          {(p.denied ?? []).length > 0 && (
            <>
              <p className="text-[11px] font-medium text-text-secondary">{t('teams.approval.permissionDenied')}</p>
              {(p.denied ?? []).map((c, i) => (
                <span key={i} data-permission-denied className="min-w-0 break-all rounded border border-border bg-bg-primary px-1.5 py-0.5 font-mono text-[11px] text-text-primary">
                  {visibleName(c)}
                </span>
              ))}
            </>
          )}
          {cut && <MoreOnPc />}
          <ApprovalError error={approval.error} />
          {buttons(approve, reject)}
          <ConfirmSheet state={confirm} onClose={() => setConfirm(null)} />
        </div>
      )
    }
    case 'hire': {
      const role = visibleName(p.roleId)
      const diff = hireHunks(p.diff.hunks)
      return (
        <div className="flex min-w-0 flex-col gap-2">
          <p data-hire-role className="text-xs font-medium text-text-primary">
            {t(p.diff.status === 'added' ? 'teams.approval.hireNew' : 'teams.approval.hireChange', { role })}
          </p>
          {diff.hunks.length > 0 && <DiffBlock hunks={diff.hunks} filePath={visibleName(p.diff.rel)} />}
          {(diff.cut || p.diff.truncated) && <p className="text-[11px] text-text-secondary">{t('teams.approval.hireCut', { count: TEAM_PHONE_HIRE_LINES })}</p>}
          <p className="text-xs text-text-secondary">{t('teams.need.hirePc')}</p>
          <OnPcChip />
        </div>
      )
    }
    case 'integrate':
      return (
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-xs text-text-secondary [overflow-wrap:anywhere]">{t('teams.approval.integrateHint', { branch: visibleName(p.branch), base: visibleName(p.base) })}</p>
          {p.ahead !== undefined && <p className="text-[11px] text-text-secondary">{p.ahead === 1 ? t('teams.approval.aheadOne') : t('teams.approval.ahead', { count: p.ahead })}</p>}
          {p.lastError && <p className="text-[11px] text-state-action">{t('teams.approval.integrateFailed')}</p>}
          <p className="text-xs text-text-secondary">{t('teams.need.integratePc')}</p>
          <OnPcChip />
        </div>
      )
  }
  return null
}

function CardRow({ teamId, card, onDone }: { teamId: string; card: CardView; onDone: () => void }): ReactNode {
  const [busy, setBusy] = useState(false)
  const [picked, setPicked] = useState<number[]>([])
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const owner = `teamCard:${card.id}`
  const answer = async (a: CardAnswer, done: MobileMessageKey = 'teams.need.q.sent'): Promise<void> => {
    setBusy(true)
    const ok = await sendCtl({ kind: 'teamAnswer', teamId, cardId: card.id, answer: a }, (e) => answerFailText(refusalOfAck(e)), setError)
    setBusy(false)
    if (ok) {
      toast(t(done))
      onDone()
    }
  }

  if (card.system) {
    const system = card.system
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-sm text-text-primary [overflow-wrap:anywhere]">{cardWhyText(system)}</p>
        <div className="flex flex-wrap gap-2">
          {system.actions.map((action: CardAction) =>
            DESKTOP_ONLY_CARD_ACTIONS.includes(action) ? (
              <span key={action} data-card-action={action} data-card-action-pc>
                <OnPcChip label={t(CARD_ACTION_KEY[action])} />
              </span>
            ) : (
              <button
                key={action}
                type="button"
                data-card-action={action}
                disabled={busy}
                onClick={() =>
                  action === 'cancelTask'
                    ? setConfirm({
                        message: `${t('teams.cardAction.cancelTaskTitle', { id: card.taskId ?? '' })} ${t('teams.cardAction.cancelTaskMsg')}`,
                        onConfirm: () => void answer({ action }, 'teams.cardAction.done'),
                      })
                    : void answer({ action }, 'teams.cardAction.done')
                }
                className={GHOST_BTN}
              >
                {busy && <Loader2 size={16} className="spin" />}
                {t(CARD_ACTION_KEY[action] ?? 'teams.cardAction.dismiss')}
              </button>
            ),
          )}
        </div>
        <NeedError text={error} />
        <ConfirmSheet state={confirm} onClose={() => setConfirm(null)} />
      </div>
    )
  }

  const options = card.options ?? []
  const marks = fitMarks(card)
  if (marks.pcOnly) {
    // The PC could not send it whole: what came of it, read only, answered on the PC.
    return (
      <div className="flex min-w-0 flex-col gap-2">
        {card.agentId && <p className="text-[11px] text-text-secondary">{t('teams.need.q.asks', { agent: visibleName(card.agentId) })}</p>}
        {card.question && (
          <div className="min-w-0 rounded-btn border border-border bg-bg-primary px-3 py-2">
            <Folded data-card-question={card.id} text={visibleText(card.question)} markdown />
          </div>
        )}
        {options.length > 0 && (
          <ul className="flex min-w-0 flex-col gap-1">
            {options.map((opt, i) => (
              <li key={i} data-card-option-pc={i} className="min-w-0 rounded border border-border px-2 py-1 text-xs text-text-primary [overflow-wrap:anywhere]">
                {visibleName(opt)}
              </li>
            ))}
          </ul>
        )}
        {marks.truncated && <MoreOnPc />}
        <FitPcNote />
      </div>
    )
  }
  const sendText = (): void => {
    const value = outgoingText(text).trim()
    if (!value) {
      setError(t('teams.need.q.textRequired'))
      return
    }
    const problem = bodyProblem(value, CARD_TEXT_ANSWER_MAX)
    if (problem) {
      setError(problem)
      return
    }
    stopDictation(owner, true)
    setError(null)
    void answer({ text: value })
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {card.agentId && <p className="text-[11px] text-text-secondary">{t('teams.need.q.asks', { agent: visibleName(card.agentId) })}</p>}
      {card.question && (
        <div className="min-w-0 rounded-btn border border-border bg-bg-primary px-3 py-2">
          <Folded data-card-question={card.id} text={visibleText(card.question)} markdown cut={marks.truncated} />
        </div>
      )}
      {card.kind === 'choice' && (
        <>
          {card.multi && <p className="text-[11px] text-text-secondary">{t('teams.need.q.multi')}</p>}
          <div className="flex flex-col gap-1.5">
            {options.map((opt, i) => {
              const on = picked.includes(i)
              return (
                <button
                  key={i}
                  type="button"
                  data-card-option={i}
                  aria-pressed={card.multi ? on : undefined}
                  disabled={busy}
                  onClick={() => (card.multi ? setPicked((cur) => (cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i].sort((a, b) => a - b))) : void answer({ choices: [i] }))}
                  className={clsx(GHOST_BTN, 'justify-start text-left', on && 'border-accent-violet bg-accent-violet/15')}
                >
                  {card.multi && <span aria-hidden className={clsx('flex h-4 w-4 shrink-0 items-center justify-center rounded border', on ? 'border-accent-violet bg-accent-violet text-white' : 'border-border')}>{on && <Check size={12} />}</span>}
                  <span className="min-w-0 [overflow-wrap:anywhere]">{visibleName(opt)}</span>
                </button>
              )
            })}
          </div>
          {card.multi && (
            <button
              type="button"
              data-card-send={card.id}
              disabled={busy}
              onClick={() => (picked.length === 0 ? setError(t('teams.need.q.pickRequired')) : void answer({ choices: picked }))}
              className={GHOST_BTN}
            >
              {busy ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
              {t('teams.need.q.answer')}
            </button>
          )}
        </>
      )}
      {card.kind === 'text' && (
        <>
          <VoiceInterim owner={owner} />
          <textarea
            data-card-text={card.id}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            maxLength={CARD_TEXT_ANSWER_MAX}
            aria-label={t('teams.need.q.placeholder')}
            placeholder={t('teams.need.q.placeholder')}
            className="min-h-[72px] w-full resize-none rounded-btn border border-border bg-bg-secondary px-3 py-2 text-[15px] leading-6 text-text-primary outline-none focus:border-accent-violet"
          />
          <div className="flex gap-2">
            <MicButton owner={owner} onFinal={(chunk) => setText((prev) => prev + spaced(prev, chunk))} />
            <button type="button" data-card-send={card.id} disabled={busy} onClick={sendText} className={clsx(GHOST_BTN, 'flex-1')}>
              {busy ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
              {t('teams.need.q.answer')}
            </button>
          </div>
        </>
      )}
      {card.kind === 'confirm' && (
        <div className="flex gap-2">
          <button type="button" data-card-confirm="yes" disabled={busy} onClick={() => void answer({ confirm: true })} className={clsx(GHOST_BTN, 'flex-1')}>
            <Check size={16} />
            {t('teams.need.q.done')}
          </button>
          <button type="button" data-card-confirm="no" disabled={busy} onClick={() => void answer({ confirm: false })} className={clsx(GHOST_BTN, 'flex-1')}>
            <X size={16} />
            {t('teams.need.q.cant')}
          </button>
        </div>
      )}
      <NeedError text={error} />
    </div>
  )
}

function DispatchRow({ teamId, item, onDone }: { teamId: string; item: QueueItemView; onDone: () => void }): ReactNode {
  const [busy, setBusy] = useState<'go' | 'drop' | null>(null)
  const [fail, setFail] = useState<string | null>(null)
  const send = async (go: boolean): Promise<void> => {
    setBusy(go ? 'go' : 'drop')
    const ok = await sendCtl({ kind: 'teamDispatch', teamId, queueId: item.id, go }, (e) => dispatchFailText(refusalOfAck(e), false, go), setFail)
    setBusy(null)
    if (ok) {
      if (go) toast(t('teams.dispatch.allDone', { count: 1 }))
      onDone()
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-xs text-text-primary">{t('teams.task.runLine', { agent: visibleName(item.agentId), mode: t(MODE_KEY[item.mode] ?? 'teams.mode.free') })}</p>
      <p className="text-[11px] text-text-secondary">{deferText(item.defer, Date.now())}</p>
      <NeedError text={fail} />
      <div className="flex gap-2">
        <button type="button" data-dispatch-go={item.id} disabled={busy !== null} onClick={() => void send(true)} className={clsx(GHOST_BTN, 'flex-1')}>
          {busy === 'go' ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
          {t('teams.dispatch.go')}
        </button>
        <button type="button" data-dispatch-drop={item.id} disabled={busy !== null} onClick={() => void send(false)} className={clsx(GHOST_BTN, 'flex-1')}>
          {busy === 'drop' ? <Loader2 size={16} className="spin" /> : <X size={16} />}
          {t('teams.dispatch.drop')}
        </button>
      </div>
    </div>
  )
}

/** The row's title: its kind (a system card reads "Necesita tu decisión"). */
function rowTitle(row: TeamNeedRow, card: CardView | undefined): string {
  if (row.kind === 'card' && card?.system) return t('teams.need.cardSystem')
  const key = teamNeedKey(row)
  return hasTeamKey(key) ? t(key) : t('teams.need.card')
}

export function NeedCard({
  teamId,
  row,
  needs,
  onDone,
  onStale,
  showTask = true,
}: {
  teamId: string
  row: TeamNeedRow
  needs: TeamNeedsView
  onDone: (rowId: string) => void
  /** A decide the PC refused as stale (what it decided on changed): read the needs view again. */
  onStale: () => void
  /** Off on the task's own screen. */
  showTask?: boolean
}): ReactNode {
  const now = Date.now()
  const done = (): void => onDone(row.id)
  const approval = row.kind === 'approval' ? needs.approvals.find((a) => a.id === row.id) : undefined
  const card = row.kind === 'card' ? needs.cards.find((c) => c.id === row.id) : undefined
  const queued = row.kind === 'dispatch' ? needs.queue.find((q) => q.id === row.id) : undefined
  const task = row.taskId ? needs.tasks[row.taskId] : undefined
  const from = approval?.requestedBy && approval.requestedBy !== 'system' && approval.requestedBy !== 'user' ? approval.requestedBy : undefined

  let body: ReactNode = null
  if (row.kind === 'trust') {
    body = (
      <>
        <p className="text-xs text-text-secondary">{t('teams.need.trustPc')}</p>
        <OnPcChip />
      </>
    )
  } else if (row.kind === 'paused') {
    body = (
      <>
        <p className="text-xs text-text-secondary">{t(needs.paused?.reason === 'billing' ? 'teams.need.pausedBilling' : 'teams.need.pausedAuth')}</p>
        <p className="text-xs text-text-secondary">{t('teams.need.pausedPc')}</p>
        <OnPcChip label={t('teams.cardAction.resumeTeam')} />
      </>
    )
  } else if (approval) body = <ApprovalRow teamId={teamId} approval={approval} onDone={done} onStale={onStale} />
  else if (card) body = <CardRow teamId={teamId} card={card} onDone={done} />
  else if (queued) body = <DispatchRow teamId={teamId} item={queued} onDone={done} />

  const readOnly =
    row.kind === 'trust' || row.kind === 'paused' || approval?.payload.kind === 'hire' || approval?.payload.kind === 'integrate' || fitMarks(approval).pcOnly || fitMarks(card).pcOnly
  return (
    <article
      data-team-need={row.id}
      data-need-kind={row.kind}
      data-approval-kind={row.approvalKind}
      data-read-only={readOnly ? 'true' : undefined}
      className="flex min-w-0 flex-col gap-2 rounded-card border border-border bg-bg-secondary px-3 py-3"
    >
      <header className="flex min-w-0 items-baseline gap-2">
        <h3 className="min-w-0 flex-1 text-sm font-semibold text-text-primary">{rowTitle(row, card)}</h3>
        {row.at > 0 && <span className="shrink-0 text-[11px] text-text-secondary">{relativeAge(row.at, now)}</span>}
      </header>
      {from && <p className="-mt-1 text-[11px] text-text-secondary">{t('teams.need.from', { agent: visibleName(from) })}</p>}
      {showTask && row.taskId && (
        <button
          type="button"
          data-need-task={row.taskId}
          onClick={() => openTeamTask(teamId, row.taskId as string)}
          className="-mx-1 flex min-h-11 min-w-0 items-center gap-1.5 rounded-btn px-1 text-left text-xs text-text-secondary active:bg-card"
        >
          <span className="shrink-0 font-mono">{row.taskId}</span>
          <span className="min-w-0 flex-1 truncate">{task ? visibleName(task.title) : t('teams.need.openTask', { id: row.taskId })}</span>
          <ChevronRight size={14} className="shrink-0" aria-hidden />
        </button>
      )}
      {!showTask || row.taskId ? null : row.kind === 'dispatch' ? <p className="text-[11px] text-text-secondary">{t('teams.dispatch.noTask')}</p> : null}
      {body}
    </article>
  )
}
