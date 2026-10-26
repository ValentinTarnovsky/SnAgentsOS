/**
 * "Leer plan completo" (app 2.7.0, A6): the request one global PlanModal
 * renders. Main keeps the plans (StatusManager.planOf, `status:plan`); the
 * renderer only asks for one and shows it, read-only.
 */
import { create } from 'zustand'
import type { PanePlan, PaneStatusDetails } from '@shared/types'
import { useAppStore } from './store'

/** The ExitPlanMode request a status still waits on: its pending id (the plan's key in main) and first line. */
export interface PlanRequest {
  requestId?: string
  summary: string
}

/**
 * The open plan request of a status, or null. Claude reports it as a `plan`
 * request, or as the permission prompt of ExitPlanMode; without a pending
 * entry, `reason: 'plan'` still means one is open (main's newest plan)
 * unless main says it was answered (`attention: false`: the user's input
 * took the request out of `pending` and the state stays `action` until the
 * tool ends).
 */
export function planRequestOf(s: (Pick<PaneStatusDetails, 'pending'> & { state?: string | null; reason?: string; attention?: boolean }) | undefined): PlanRequest | null {
  if (!s || s.state !== 'action') return null
  const p = s.pending?.find((r) => r.kind === 'plan' || r.toolName === 'ExitPlanMode')
  if (p) return { requestId: p.id, summary: p.summary }
  return s.reason === 'plan' && s.attention !== false ? { summary: '' } : null
}

export interface PlanView {
  paneId: string
  /** "Workspace / Console", for the header. */
  place: string
  /** The request's first line, shown when the plan is gone. */
  summary: string
  /** undefined while `status:plan` answers; null = no longer available. */
  plan: PanePlan | null | undefined
}

export const usePlanModal = create<{ view: PlanView | null }>(() => ({ view: null }))

let seq = 0
/** What had the focus before the modal (a console, a toast button): it gets it back on close. */
let returnFocus: HTMLElement | null = null

/**
 * Open the modal on a console's plan. `req` defaults to the request the
 * console's status waits on; with none, main's newest plan of the pane.
 */
export function openPlan(paneId: string, req?: PlanRequest): void {
  if (!usePlanModal.getState().view) {
    const active = typeof HTMLElement !== 'undefined' ? document.activeElement : null
    returnFocus = active instanceof HTMLElement && active !== document.body ? active : null
  }
  const s = useAppStore.getState()
  const ws = s.workspaces.find((w) => w.panes.some((p) => p.id === paneId))
  const pane = ws?.panes.find((p) => p.id === paneId)
  const target = req ?? planRequestOf(s.paneStatus[paneId]) ?? { summary: '' }
  const token = ++seq
  usePlanModal.setState({ view: { paneId, place: ws && pane ? `${ws.name} / ${pane.title}` : '', summary: target.summary, plan: undefined } })
  const settle = (plan: PanePlan | null): void => {
    const view = usePlanModal.getState().view
    if (token !== seq || !view) return
    usePlanModal.setState({ view: { ...view, plan: plan && typeof plan.text === 'string' && plan.text ? plan : null } })
  }
  let asked: Promise<PanePlan | null>
  try {
    asked = Promise.resolve(window.snApi.status.plan(paneId, target.requestId))
  } catch {
    asked = Promise.resolve(null)
  }
  asked.then(settle, () => settle(null))
}

/** `refocus: false` when something else is taking the focus (a console the user asked for). */
export function closePlan(refocus = true): void {
  seq++
  if (!usePlanModal.getState().view) return
  usePlanModal.setState({ view: null })
  const el = returnFocus
  returnFocus = null
  if (refocus && el?.isConnected) el.focus()
}
