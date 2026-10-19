/**
 * The in-page toasts of the live screens (store.toasts, at most TOASTS_MAX),
 * newest on top (E2-FR-43; D9: replaces the plain LiveToasts). A plain notice
 * lasts TOAST_MS; a console state toast lasts 6s (action, error) or 4s (done)
 * and carries [Go], which opens that console like a row tap. Home and the
 * terminal both mount one inside their content area; only the screen on top
 * is visible. Home passes `notices`: a console state toast raised in the
 * terminal never shows there (E2-FR-43: no toast on Home).
 */
import { useEffect, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { useRemoteStore, type MobileToast } from '../lib/store'
import { client } from '../lib/client'
import { t } from '../lib/i18n'
import { TOAST_DONE_MS, TOAST_URGENT_MS } from '../lib/notify'

export const TOAST_MS = 2500

export function toastDuration(toast: Pick<MobileToast, 'kind'>): number {
  if (toast.kind === 'action' || toast.kind === 'error') return TOAST_URGENT_MS
  if (toast.kind === 'done') return TOAST_DONE_MS
  return TOAST_MS
}

function ToastItem({ toast }: { toast: MobileToast }): ReactNode {
  const dismiss = useRemoteStore((s) => s.dismissToast)
  useEffect(() => {
    const id = setTimeout(() => dismiss(toast.id), toastDuration(toast))
    return () => clearTimeout(id)
  }, [toast, dismiss])
  const paneId = toast.paneId
  return (
    <div
      data-toast={toast.id}
      data-toast-kind={toast.kind ?? 'info'}
      className={clsx(
        'fade-in flex max-w-full items-center gap-2 rounded-full bg-card/95 text-xs font-medium text-text-primary shadow-lg ring-1',
        paneId ? 'py-1 pl-4 pr-1' : 'px-4 py-2 text-center',
        toast.kind === 'action' || toast.kind === 'error' ? 'ring-accent-violet/60' : 'ring-border',
      )}
    >
      <span className="min-w-0 truncate">{toast.text}</span>
      {paneId && (
        <button
          data-toast-go={paneId}
          onClick={() => {
            dismiss(toast.id)
            client.requestOpen(paneId)
          }}
          className="pointer-events-auto min-h-8 shrink-0 rounded-full bg-accent-violet px-3 text-xs font-semibold text-white active:opacity-80"
        >
          {t('toast.go')}
        </button>
      )}
    </div>
  )
}

export function ToastStack({ bottom = 12, notices = false }: { bottom?: number; notices?: boolean }): ReactNode {
  const all = useRemoteStore((s) => s.toasts)
  const toasts = notices ? all.filter((x) => !x.paneId) : all
  return (
    <div
      role="status"
      aria-live="polite"
      data-toast-stack
      className="pointer-events-none absolute inset-x-3 z-30 flex flex-col items-center gap-1.5"
      style={{ bottom }}
    >
      {[...toasts].reverse().map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  )
}
