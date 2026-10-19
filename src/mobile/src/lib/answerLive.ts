/**
 * The answer card sender bound to the live page (E2-FR-21, 24): keys go to
 * the pane through client.sendInputTo (the viewed pane or a Home row), the
 * last paneStatus comes from the store, and the outcome lands in usePromptUi.
 * A socket that drops aborts every running sequence; an outcome left on a
 * pane that is no longer waiting is cleared.
 */
import { client } from './client'
import { store } from './store'
import { createAnswerer, usePromptUi, type AnswerPayload, type AnswerResult } from './answer'
import { t } from './i18n'

export const answerer = createAnswerer({
  isOpen: () => client.isOpen(),
  send: (paneId, data) => client.sendInputTo(paneId, data),
  status: (paneId) => store.getState().paneStatus[paneId],
  setState: (paneId, state) => usePromptUi.getState().setAnswer(paneId, state),
  onStale: () => store.getState().setToast(t('prompt.alreadyAnswered')),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
})

/** Answer a card of `paneId` (E2-FR-21). */
export function answerCard(paneId: string, pendingId: string, payload: AnswerPayload): AnswerResult {
  return answerer.answerCard(paneId, pendingId, payload)
}

store.subscribe((s, prev) => {
  if (prev.connected && !s.connected) answerer.abortAll()
  if (s.paneStatus === prev.paneStatus) return
  // "Not confirmed" / "connection dropped" go away once the pane stops waiting.
  const answers = usePromptUi.getState().answers
  for (const [paneId, state] of Object.entries(answers)) {
    if ((state.phase === 'unconfirmed' || state.phase === 'disconnected') && s.paneStatus[paneId]?.state !== 'action') answerer.dismiss(paneId)
  }
})
