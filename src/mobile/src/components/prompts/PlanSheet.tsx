/**
 * "View full plan" (app 2.7.0, A8): the sheet the Plan card opens with the
 * agent's whole ExitPlanMode plan, asked of the PC with planReq (by the
 * request id, client.requestPlan) every time it opens and rendered with the
 * phone's Markdown (lexer only, never HTML). A plan main cut says so on top;
 * one main no longer keeps (or a desktop older than 2.7.0) reads "no longer
 * available" with the request's first line; no answer (10s, offline, the
 * PC's rate limit) is "The PC did not answer [Retry]". Read only: answering
 * the plan stays on the card.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { Sheet } from '../Sheet'
import { NoReply } from '../NoReply'
import { Markdown } from '../chat/Markdown'
import { client } from '../../lib/client'
import { PLAN_LOADING, planLoadOf, type PlanLoad } from '../../lib/plan'
import { t } from '../../lib/i18n'

export function PlanSheet({
  paneId,
  requestId,
  summary,
  open,
  onClose,
}: {
  paneId: string
  /** The pending ExitPlanMode request the card answers. */
  requestId: string
  /** Its first line, the fallback when the plan is gone. */
  summary?: string
  open: boolean
  onClose: () => void
}): ReactNode {
  const [load, setLoad] = useState<PlanLoad>(PLAN_LOADING)
  // Bumped by Retry: the same request again under a new id.
  const [round, setRound] = useState(0)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoad(PLAN_LOADING)
    void client.requestPlan(paneId, requestId).then((out) => {
      if (!cancelled) setLoad(planLoadOf(out))
    })
    return () => {
      cancelled = true
    }
  }, [open, paneId, requestId, round])

  const plan = load.status === 'ok' ? load.plan : null
  return (
    <Sheet open={open} onClose={onClose} title={t('plan.title')}>
      <div data-plan-sheet={paneId} data-plan-state={load.status} className="min-w-0">
        {load.status === 'loading' && (
          <div data-plan-loading role="status" className="flex items-center justify-center gap-2 py-6 text-sm text-text-secondary">
            <Loader2 size={16} className="spin" aria-hidden />
            {t('plan.loading')}
          </div>
        )}
        {load.status === 'noReply' && <NoReply onRetry={() => setRound((n) => n + 1)} />}
        {load.status === 'gone' && (
          <div data-plan-unavailable role="status" className="py-2">
            <p className="text-sm text-text-secondary">{t('plan.unavailable')}</p>
            {summary && (
              <p className="mt-2 whitespace-pre-wrap break-words rounded-btn bg-bg-primary px-2 py-1.5 font-mono text-[12px] leading-snug text-text-primary">
                {summary}
              </p>
            )}
          </div>
        )}
        {plan && (
          <>
            {plan.truncated && (
              <p data-plan-truncated role="note" className="mb-2 rounded-btn border border-border bg-bg-secondary px-2 py-1.5 text-xs leading-snug text-text-secondary">
                {t('plan.truncated')}
              </p>
            )}
            <div data-plan-text>
              <Markdown text={plan.text} />
            </div>
          </>
        )}
      </div>
    </Sheet>
  )
}
