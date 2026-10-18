/**
 * The in-page toasts of the live screens (store.toasts, at most TOASTS_MAX),
 * newest on top, each gone after TOAST_MS. Home and the terminal both mount
 * one inside their content area; only the screen on top is visible. D9: the
 * richer ToastStack of E2-FR-43 ([Go], vibration, per-kind timing) replaces it.
 */
import { useEffect, type ReactNode } from 'react'
import { useRemoteStore, type MobileToast } from '../lib/store'

export const TOAST_MS = 2500

function ToastItem({ toast }: { toast: MobileToast }): ReactNode {
  const dismiss = useRemoteStore((s) => s.dismissToast)
  useEffect(() => {
    const id = setTimeout(() => dismiss(toast.id), TOAST_MS)
    return () => clearTimeout(id)
  }, [toast.id, dismiss])
  return (
    <div
      data-toast={toast.id}
      className="fade-in max-w-full rounded-full bg-card/95 px-4 py-2 text-center text-xs font-medium text-text-primary shadow-lg ring-1 ring-border"
    >
      {toast.text}
    </div>
  )
}

export function LiveToasts({ bottom = 12 }: { bottom?: number }): ReactNode {
  const toasts = useRemoteStore((s) => s.toasts)
  return (
    <div
      aria-live="polite"
      className="pointer-events-none absolute inset-x-3 z-30 flex flex-col items-center gap-1.5"
      style={{ bottom }}
    >
      {[...toasts].reverse().map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  )
}
