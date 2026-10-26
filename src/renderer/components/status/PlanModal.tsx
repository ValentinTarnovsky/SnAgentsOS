import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { FileText, X } from 'lucide-react'
import { useT } from '@/i18n'
import { closePlan, usePlanModal } from '@/lib/planModal'
import { onPaneFocusRequest } from '@/lib/focus'
import { isFromToast } from '@/lib/toast'
import { Button } from '@/components/ui/Button'
import { MarkdownDoc } from '@/components/ui/MarkdownDoc'
import { Tooltip } from '@/components/ui/Tooltip'

/** A local `status:plan` answers in a few ms: the loading line only shows past this. */
const LOADING_DELAY_MS = 300

/**
 * "Leer plan completo" (app 2.7.0, A6): an agent's ExitPlanMode plan,
 * read-only through MarkdownDoc (never HTML). A plan main cut shows a note;
 * one main no longer keeps shows the request's first line instead. Portaled,
 * since it can open from a toast over a pane cell; Esc, Cerrar, the header X
 * (the toast stack sits above modals and can cover the footer of a tall
 * plan), the backdrop or going to a console close it.
 */
export function PlanModal() {
  const t = useT()
  const view = usePlanModal((s) => s.view)
  const loading = !!view && view.plan === undefined
  const [slow, setSlow] = useState(false)

  useEffect(() => {
    if (!loading) return
    const timer = setTimeout(() => setSlow(true), LOADING_DELAY_MS)
    return () => {
      clearTimeout(timer)
      setSlow(false)
    }
  }, [loading])

  useEffect(() => {
    if (!view) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      closePlan()
    }
    window.addEventListener('keydown', onKey, true)
    // Going to a console ([Ir] on the card, a sidebar row, Ctrl+digit) closes the plan; the console keeps the focus.
    const offFocus = onPaneFocusRequest(() => closePlan(false))
    return () => {
      window.removeEventListener('keydown', onKey, true)
      offFocus()
    }
  }, [view])

  if (!view) return null
  const plan = view.plan

  return createPortal(
    <div className="fixed inset-0 z-[75] flex items-center justify-center p-6">
      {/* A click that starts on a toast never closes the modal (E4-FR-03). */}
      <div className="absolute inset-0 bg-black/60" onClick={(e) => { if (!isFromToast(e)) closePlan() }} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="plan-modal-title"
        aria-busy={loading}
        data-plan-modal={view.paneId}
        className="relative z-10 flex max-h-[82vh] w-full max-w-2xl flex-col overflow-hidden rounded-modal border border-border bg-card shadow-[0_20px_48px_-12px_rgba(0,0,0,0.6)]"
      >
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <FileText size={18} className="mt-0.5 shrink-0 text-text-secondary" />
          <div className="min-w-0 flex-1">
            <h2 id="plan-modal-title" className="text-sm font-semibold text-text-primary">{t('plan.title')}</h2>
            {view.place && <p data-plan-place className="mt-0.5 truncate text-xs text-text-secondary">{view.place}</p>}
          </div>
          <Tooltip label={t('common.close')} side="bottom">
            <button
              type="button"
              data-plan-close-x
              aria-label={t('common.close')}
              onClick={() => closePlan()}
              className="shrink-0 rounded-btn text-text-secondary transition-colors hover:text-text-primary"
            >
              <X size={18} />
            </button>
          </Tooltip>
        </div>
        {plan?.truncated && (
          <p data-plan-truncated className="border-b border-border bg-bg-secondary/40 px-5 py-2 text-xs text-text-secondary">
            {t('plan.truncated')}
          </p>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4" tabIndex={-1}>
          {plan ? (
            <MarkdownDoc text={plan.text} />
          ) : plan === null ? (
            <div data-plan-unavailable className="space-y-2">
              {view.summary && <p data-plan-summary className="whitespace-pre-wrap break-words text-sm text-text-primary">{view.summary}</p>}
              <p className="text-xs text-text-secondary">{t('plan.unavailable')}</p>
            </div>
          ) : (
            slow && <p data-plan-loading className="text-xs text-text-secondary">{t('plan.loading')}</p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border bg-bg-secondary/40 px-5 py-3">
          <Button variant="ghost" size="sm" autoFocus data-plan-close onClick={() => closePlan()}>
            {t('common.close')}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
