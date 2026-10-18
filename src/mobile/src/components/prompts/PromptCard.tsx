/**
 * The answer area of the terminal screen (E2-FR-17..25), between the exit
 * strip and the composer / KeyBar, for the viewed console:
 *
 *  - while an answer goes out: "Sending answer..." then "Sent"; afterwards
 *    "Not confirmed" or "The connection dropped" until dismissed or the pane
 *    stops waiting (E2-FR-21, 24);
 *  - else the card picked by cardFor (E2-FR-17, 18): permission, the ask
 *    wizard, or "Answer in the terminal". A folded card is a one-line strip
 *    (E2-FR-22) and every new card starts unfolded;
 *  - else, with the pane in 'action', the generic strip (E2-FR-25).
 *
 * The card goes away with the paneStatus that drops its request from
 * pending[], which the answer itself triggers in main (E2-FR-48).
 */
import type { ReactNode } from 'react'
import { AlertTriangle, Check, Loader2, X } from 'lucide-react'
import { useRemoteStore } from '../../lib/store'
import { cardFor, needsGenericStrip, type PromptCardModel } from '../../lib/promptRules'
import { usePromptUi, type AnswerState } from '../../lib/answer'
import { answerer } from '../../lib/answerLive'
import { agentName } from '../../lib/statusText'
import { t } from '../../lib/i18n'
import { openTerminalKeyboard, PromptStrip } from './PromptStrip'
import { PermissionCard } from './PermissionCard'
import { AnswerInTerminal, AskHeader, AskWizard, askTitle } from './AskWizard'

/**
 * The answer outcome wins over the card while it is sending, or when it is
 * about the same request. A new request (another id) shows its card at once,
 * even while the previous answer still reads "Sent".
 */
export function showsAnswer(answer: AnswerState | undefined, card: PromptCardModel | undefined): answer is AnswerState {
  if (!answer) return false
  return answer.phase === 'sending' || !card || card.pending.id === answer.pendingId
}

export function answerText(answer: AnswerState): string {
  switch (answer.phase) {
    case 'sending':
      return t('prompt.sending')
    case 'sent':
      return t('prompt.sent')
    case 'unconfirmed':
      return t('prompt.unconfirmed')
    case 'disconnected':
      return t('prompt.disconnected')
  }
}

/** One-line text of a folded card (E2-FR-22). */
export function foldedText(card: PromptCardModel): string {
  if (card.kind === 'question') return askTitle(card.questions?.length ?? card.pending.questions?.length ?? 1)
  return card.generic ? t('prompt.stripPermGeneric') : t('prompt.stripPerm', { tool: card.pending.toolName ?? '' })
}

function AnswerStatus({ paneId, answer }: { paneId: string; answer: AnswerState }): ReactNode {
  const warn = answer.phase === 'unconfirmed' || answer.phase === 'disconnected'
  return (
    <div
      data-answer-phase={answer.phase}
      role="status"
      className="flex h-11 shrink-0 items-center gap-2 border-t border-border bg-bg-secondary px-3 text-xs"
    >
      {answer.phase === 'sending' && <Loader2 size={15} className="shrink-0 animate-spin text-text-secondary" />}
      {answer.phase === 'sent' && <Check size={15} className="shrink-0 text-state-done" />}
      {warn && <AlertTriangle size={15} className="shrink-0 text-state-action" />}
      {warn ? (
        <button
          type="button"
          onPointerDown={(e) => e.preventDefault()}
          onClick={openTerminalKeyboard}
          className="min-w-0 flex-1 truncate text-left font-medium text-text-primary"
        >
          {answerText(answer)}
        </button>
      ) : (
        <span className="min-w-0 flex-1 truncate font-medium text-text-primary">{answerText(answer)}</span>
      )}
      {warn && (
        <button
          type="button"
          data-answer-dismiss
          onClick={() => answerer.dismiss(paneId)}
          aria-label={t('prompt.dismiss')}
          className="-mr-1.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-btn text-text-secondary active:bg-card"
        >
          <X size={16} />
        </button>
      )}
    </div>
  )
}

export function PromptCard(): ReactNode {
  const paneId = useRemoteStore((s) => s.activePaneId)
  const status = useRemoteStore((s) => (s.activePaneId ? s.paneStatus[s.activePaneId] : undefined))
  const enabled = useRemoteStore((s) => s.promptCards)
  const answer = usePromptUi((s) => (paneId ? s.answers[paneId] : undefined))
  const folded = usePromptUi((s) => s.folded)
  const wizardSeq = usePromptUi((s) => s.wizardSeq)
  const setFolded = usePromptUi((s) => s.setFolded)
  if (!paneId) return null
  const card = cardFor(status, enabled)
  if (showsAnswer(answer, card)) return <AnswerStatus paneId={paneId} answer={answer} />
  if (card) {
    const id = card.pending.id
    if (folded[id]) return <PromptStrip variant="folded" text={foldedText(card)} onTap={() => setFolded(id, false)} />
    const fold = (): void => setFolded(id, true)
    if (card.kind === 'permission') return <PermissionCard key={id} paneId={paneId} card={card} onFold={fold} />
    if (!card.questions) {
      return (
        <div data-prompt-card="terminal" data-pending={id} className="shrink-0 border-t border-state-action/40 bg-bg-secondary px-3 pb-2 pt-2.5">
          <AskHeader count={card.pending.questions?.length || 1} onFold={fold} />
          <AnswerInTerminal />
        </div>
      )
    }
    return <AskWizard key={`${id}:${wizardSeq[id] ?? 0}`} paneId={paneId} pending={card.pending} questions={card.questions} onFold={fold} />
  }
  if (status && needsGenericStrip(status, card)) {
    return <PromptStrip variant="waiting" text={t('prompt.waiting', { agent: agentName(status) })} onTap={openTerminalKeyboard} />
  }
  return null
}
