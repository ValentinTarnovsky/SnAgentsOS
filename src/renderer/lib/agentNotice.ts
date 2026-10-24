import type { ClaudePaneState, PaneStatusEvt } from '@shared/types'
import { translate, type MessageKey } from '@/i18n'
import { useAppStore } from './store'
import { toast, type ToastAction } from './toast'
import { agentToastKey, revealPane } from './revealPane'
import { openPlan, planRequestOf } from './planModal'

/** paneId -> state its open in-app agent card describes. */
const shown = new Map<string, ClaudePaneState>()

const CARD_KEYS: Partial<Record<ClaudePaneState, MessageKey>> = {
  done: 'toast.agent.done',
  action: 'toast.agent.action',
  error: 'toast.agent.error',
}

/**
 * In-app agent notice (E4-FR-07). Main marks `delivery: 'inApp'` when the
 * window has focus but the console is out of view, and skips the OS
 * notification; here that becomes a card with [Go] and a Settings link. A card
 * closes itself once its console leaves that state (any later status event of
 * the same pane with another state) or is revealed.
 */
export function onAgentStatus(evt: PaneStatusEvt): void {
  const key = agentToastKey(evt.paneId)
  const current = shown.get(evt.paneId)
  // v2.3: the card also goes once main says the console no longer needs the user.
  if (current !== undefined && (evt.state !== current || evt.attention === false)) {
    shown.delete(evt.paneId)
    toast.dismissByKey(key)
  }
  if (!evt.notify || evt.delivery !== 'inApp' || !evt.state) return
  let textKey = CARD_KEYS[evt.state]
  if (!textKey) return
  // A title-only (approximate) stop is not known to be a question: same
  // generic copy as main's native notification.
  if (evt.state === 'action' && !evt.precise) textKey = 'toast.agent.generic'

  const s = useAppStore.getState()
  const lang = s.settings.language
  const ws = s.workspaces.find((w) => w.panes.some((p) => p.id === evt.paneId))
  const pane = ws?.panes.find((p) => p.id === evt.paneId)
  if (!ws || !pane) return
  const provider = evt.provider === 'codex' ? 'Codex' : 'Claude'
  const title = translate(lang, textKey, { provider, place: `${ws.name} / ${pane.title}` })
  const paneId = evt.paneId
  const actions: ToastAction[] = [{ label: translate(lang, 'toast.agent.go'), run: () => void revealPane(paneId) }]
  // App 2.7.0 (A6): a plan waiting for review can be read from the card.
  const planReq = evt.precise ? planRequestOf(evt) : null
  if (planReq) actions.push({ label: translate(lang, 'plan.read'), run: () => openPlan(paneId, planReq) })
  const opts = {
    dedupeKey: key,
    actions,
    link: {
      label: translate(lang, 'toast.agent.settings'),
      run: () => useAppStore.getState().openSettings('notifications#inAppWhenFocused'),
    },
  }
  shown.set(paneId, evt.state)
  if (evt.state === 'done') toast.success(title, { ...opts, durationMs: 8000 })
  else if (evt.state === 'action') toast.warning(title, { ...opts, durationMs: null, priority: 2 })
  else toast.error(title, opts)
}

/** Consoles that came into view (focused window) close their agent cards. */
export function dismissAgentCardsInView(viewed: readonly string[]): void {
  if (shown.size === 0) return
  for (const paneId of viewed) {
    if (!shown.has(paneId)) continue
    shown.delete(paneId)
    toast.dismissByKey(agentToastKey(paneId))
  }
}
