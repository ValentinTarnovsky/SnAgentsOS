/**
 * Feedback for initial prompts (E8-FR-02b). Main decides argv or gate and
 * reports the outcome on pty:promptResult; this turns the unhappy ones into
 * toasts. The text is remembered per pane when useXterm hands it to a spawn,
 * so "Copy" works after it left the store; it is forgotten on any outcome.
 */
import type { PtyPromptResultEvt } from '@shared/ipc-contract'
import { translate } from '@/i18n'
import { useAppStore } from './store'
import { toast } from './toast'

const texts = new Map<string, string>()

/** The pane's spawn carries this prompt (called right before pty.spawn). */
export function rememberPrompt(paneId: string, text: string): void {
  texts.set(paneId, text)
}

/** Shows the toast for one outcome; exported for tests. */
export function handlePromptResult(evt: PtyPromptResultEvt): void {
  const text = texts.get(evt.paneId)
  texts.delete(evt.paneId)
  const lang = useAppStore.getState().settings.language
  const t = (key: Parameters<typeof translate>[1]): string => translate(lang, key)
  const copy = text
    ? [{ label: t('quick.toast.copy'), run: () => window.snApi.clipboard.writeText(text) }]
    : undefined
  switch (evt.result) {
    case 'inserted_unconfirmed':
      toast.warning(t('quick.toast.insertedUnconfirmed'), { dedupeKey: `prompt:${evt.paneId}` })
      break
    case 'not_delivered':
      toast.error(t('quick.toast.notDelivered'), { dedupeKey: `prompt:${evt.paneId}`, actions: copy })
      break
    case 'dropped_exit':
      toast.warning(t('quick.toast.droppedExit'), { dedupeKey: `prompt:${evt.paneId}`, actions: copy })
      break
    default:
      break
  }
}

let wired = false

/** Subscribe to main's prompt outcomes once (App). Returns the unsubscribe. */
export function initPromptResults(): () => void {
  if (wired) return () => undefined
  wired = true
  const off = window.snApi.pty.onPromptResult(handlePromptResult)
  return () => {
    wired = false
    off()
  }
}
