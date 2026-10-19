/**
 * The request line of a Home row (E2-FR-23): the summary ("Allow Bash: npm
 * test") with inline buttons. A permission gets [Allow] / [Deny], 36px tall,
 * answered through the same sequence as the terminal card without opening
 * the terminal; a question gets [Answer], which opens the terminal with the
 * wizard unfolded at step 1, and a plan (E2-FR-54) gets [Review], which opens
 * the terminal on the Plan card (its buttons need Claude's menu on screen,
 * so the row never answers a plan by itself). While an answer goes out the
 * line shows its state instead. Taps here never reach the row (no open, no
 * long-press).
 */
import type { ReactNode, SyntheticEvent } from 'react'
import type { RemotePaneStatus } from '@shared/remote-protocol'
import { useRemoteStore } from '../../lib/store'
import { cardFor } from '../../lib/promptRules'
import { usePromptUi } from '../../lib/answer'
import { answerCard } from '../../lib/answerLive'
import { client } from '../../lib/client'
import { t } from '../../lib/i18n'
import { answerText, showsAnswer } from './PromptCard'

const stop = (e: SyntheticEvent): void => e.stopPropagation()

export function RowPrompt({ paneId, status }: { paneId: string; status: RemotePaneStatus | undefined }): ReactNode {
  const enabled = useRemoteStore((s) => s.promptCards)
  const answer = usePromptUi((s) => s.answers[paneId])
  const card = cardFor(status, enabled)
  if (showsAnswer(answer, card)) {
    return (
      <span data-row-answer={answer.phase} className="truncate text-[11px] font-medium leading-tight text-state-action">
        {answerText(answer)}
      </span>
    )
  }
  if (!card) return null
  const id = card.pending.id
  let text: string
  if (card.kind === 'question') text = t('prompt.rowAsk', { q: card.pending.questions?.[0]?.question || card.pending.summary })
  else if (card.kind === 'plan') text = card.pending.summary ? t('prompt.rowPlan', { summary: card.pending.summary }) : t('prompt.rowPlanShort')
  else if (card.generic) text = t('prompt.permGeneric')
  else if (card.pending.summary) text = t('prompt.rowPerm', { tool: card.pending.toolName ?? '', summary: card.pending.summary })
  else text = t('prompt.rowPermShort', { tool: card.pending.toolName ?? '' })
  return (
    <span
      data-row-prompt={card.kind}
      data-pending={id}
      onClick={stop}
      onPointerDown={stop}
      onKeyDown={stop}
      onContextMenu={stop}
      className="mt-1 flex min-w-0 items-center gap-2"
    >
      <span data-row-prompt-text className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-primary">{text}</span>
      {card.kind === 'permission' ? (
        <>
          <button
            type="button"
            data-row-deny
            onClick={() => answerCard(paneId, id, { kind: 'deny' })}
            className="h-9 shrink-0 rounded-btn border border-border px-3 text-xs font-medium text-text-primary active:bg-card"
          >
            {t('prompt.deny')}
          </button>
          <button
            type="button"
            data-row-allow
            onClick={() => answerCard(paneId, id, { kind: 'allow' })}
            className="h-9 shrink-0 rounded-btn bg-accent-violet px-3 text-xs font-semibold text-white active:brightness-110"
          >
            {t('prompt.allow')}
          </button>
        </>
      ) : (
        <button
          type="button"
          data-row-answer-open
          onClick={() => {
            usePromptUi.getState().openCard(id)
            client.requestOpen(paneId)
          }}
          className="h-9 shrink-0 rounded-btn bg-accent-violet px-3 text-xs font-semibold text-white active:brightness-110"
        >
          {card.kind === 'plan' ? t('prompt.review') : t('prompt.answer')}
        </button>
      )}
    </span>
  )
}
