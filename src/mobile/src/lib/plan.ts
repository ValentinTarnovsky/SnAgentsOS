/**
 * "View full plan" (app 2.7.0, A8): what the Plan card's sheet shows for one
 * planReq answer (client.requestPlan). Pure, so the logic suite covers it.
 *
 *  - ok: the plan as Markdown (a plan main cut carries `truncated`);
 *  - noReply: no answer in 10s, the socket is down or the PC's rate limit
 *    (PLAN_REQ_MAX per window): "The PC did not answer [Retry]";
 *  - gone: main no longer keeps that plan (`not_found`), or the desktop is
 *    older than 2.7.0 (`unsupported`, answered by the phone to itself).
 */
import type { PanePlan } from '@shared/types'
import type { RemotePlanReply } from '@shared/remote-protocol'
import type { PendingOutcome } from './pending'

export type PlanLoadStatus = 'loading' | 'ok' | 'noReply' | 'gone'

export interface PlanLoad {
  status: PlanLoadStatus
  plan: PanePlan | null
}

export const PLAN_LOADING: PlanLoad = { status: 'loading', plan: null }

export function planLoadOf(out: PendingOutcome<RemotePlanReply>): PlanLoad {
  if (!out.ok) return { status: 'noReply', plan: null }
  const reply = out.value
  if (reply.ok && reply.plan && typeof reply.plan.text === 'string' && reply.plan.text.trim()) return { status: 'ok', plan: reply.plan }
  if (reply.error === 'rate') return { status: 'noReply', plan: null }
  return { status: 'gone', plan: null }
}
