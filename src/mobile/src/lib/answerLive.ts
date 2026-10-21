/**
 * The answer card sender bound to the live page (E2-FR-21, 24): keys go to
 * the pane through client.sendInputTo (the viewed pane or a Home row), the
 * last paneStatus comes from the store, and the outcome lands in usePromptUi.
 * A socket that drops aborts every running sequence; an outcome left on a
 * pane that is no longer waiting is cleared.
 */
import { client } from './client'
import { store } from './store'
import { createAnswerer, createMenuAnswerer, usePromptUi, type AnswerPayload, type AnswerResult } from './answer'
import { t, type MobileMessageKey } from './i18n'

export const answerer = createAnswerer({
  isOpen: () => client.isOpen(),
  send: (paneId, data) => client.sendInputTo(paneId, data),
  status: (paneId) => store.getState().paneStatus[paneId],
  setState: (paneId, state) => usePromptUi.getState().setAnswer(paneId, state),
  onStale: () => store.getState().setToast(t('prompt.alreadyAnswered')),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
})

/** app 2.4.0: the toast of a refused answerMenu ack (no raw code ever shows). */
export function menuErrorKey(error: string): MobileMessageKey {
  switch (error) {
    case 'menu_changed':
      return 'prompt.menuChanged'
    case 'stale':
      return 'prompt.alreadyAnswered'
    case 'no_menu':
      return 'prompt.noMenu'
    case 'rate':
      return 'prompt.menuError.rate'
    case 'denied':
      return 'prompt.menuError.denied'
    case 'timeout':
    case 'offline':
    case 'desktop_unavailable':
      return 'prompt.menuError.noReply'
    default:
      return 'prompt.menuError.generic'
  }
}

/** app 2.4.0: Chat view menu answers (ctl answerMenu, checked again in main). */
export const menuAnswerer = createMenuAnswerer({
  isOpen: () => client.isOpen(),
  sendCtl: (action) => client.sendCtl(action),
  status: (paneId) => store.getState().paneStatus[paneId],
  setState: (paneId, state) => usePromptUi.getState().setAnswer(paneId, state),
  onError: (_paneId, pendingId, error) => {
    store.getState().setToast(t(menuErrorKey(error)))
    // The request is gone: its card folds (the next paneStatus drops it anyway).
    if (error === 'stale') usePromptUi.getState().setFolded(pendingId, true)
  },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
})

/** Pick option `n` of main's menu read for a request (Chat view, desktop >= 2.4.0). */
export function answerMenu(paneId: string, pendingId: string, option: { n: number; label: string }): AnswerResult {
  if (answerer.busy(paneId)) return 'busy'
  return menuAnswerer.answer(paneId, pendingId, option)
}

/** Answer a card of `paneId` (E2-FR-21). */
export function answerCard(paneId: string, pendingId: string, payload: AnswerPayload): AnswerResult {
  if (menuAnswerer.busy(paneId)) return 'busy'
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
