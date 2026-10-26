/**
 * The in-page toasts of the live screens (store.toasts, at most TOASTS_MAX),
 * newest on top (E2-FR-43; D9: replaces the plain LiveToasts). A plain notice
 * lasts TOAST_MS; a console state toast lasts 6s (action, error) or 4s (done)
 * and carries [Go], which opens that console like a row tap. Home and the
 * terminal both mount one inside their content area; only the screen on top
 * is visible. Home passes `notices`: a console state toast raised in the
 * terminal never shows there (E2-FR-43: no toast on Home).
 *
 * App 2.7.0 (E10 B8): the pushed screens (Notes, Automations, History, the
 * Teams screens...) cover both, so the open PushScreen on top mounts one more
 * inside its own dialog (usePushToasts), `toastBottom` px up: the live region
 * sits in the open dialog, which is what a screen reader still reads under
 * aria-modal. It shows notices only, like Home: a [Go] there would open its
 * console under the pushed screens. While a pushed screen is open the notices
 * show only there: Home and the terminal hide theirs (each copy stays mounted,
 * so its timer still ends the toast on time), and a notice a pushed screen
 * took does not show again on them once it closes, so each one shows and is
 * announced once. The terminal's [Go] toasts stay in the terminal.
 */
import { useEffect, useId, useState, type ReactNode, type RefObject } from 'react'
import { create } from 'zustand'
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

/** `covered`: a pushed screen shows this notice; from then on this copy is hidden (display none: out of the accessibility tree too). */
function ToastItem({ toast, covered = false }: { toast: MobileToast; covered?: boolean }): ReactNode {
  const dismiss = useRemoteStore((s) => s.dismissToast)
  const [taken, setTaken] = useState(covered)
  if (covered && !taken) setTaken(true)
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
        'fade-in max-w-full items-center gap-2 rounded-full bg-card/95 text-xs font-medium text-text-primary shadow-lg ring-1',
        taken ? 'hidden' : 'flex',
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

/** The pushed screens open now: each one's dialog element, by its PushScreen. */
const usePushRooms = create<{ rooms: Record<string, HTMLElement> }>(() => ({ rooms: {} }))

/** The open pushed screen on top: the last in document order (they share z-40, so a later one covers an earlier one). */
function topRoom(rooms: Record<string, HTMLElement>): string | null {
  let top: string | null = null
  let topEl: HTMLElement | null = null
  for (const [id, el] of Object.entries(rooms)) {
    if (!topEl || topEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
      top = id
      topEl = el
    }
  }
  return top
}

export function ToastStack({ bottom = 12, notices = false, shell = false }: { bottom?: number; notices?: boolean; shell?: boolean }): ReactNode {
  const all = useRemoteStore((s) => s.toasts)
  const covered = usePushRooms((s) => !shell && Object.keys(s.rooms).length > 0)
  const toasts = notices ? all.filter((x) => !x.paneId) : all
  return (
    <div
      role="status"
      aria-live="polite"
      data-toast-stack={shell ? 'shell' : ''}
      className="pointer-events-none absolute inset-x-3 z-30 flex flex-col items-center gap-1.5"
      style={{ bottom }}
    >
      {[...toasts].reverse().map((toast) => (
        <ToastItem key={toast.id} toast={toast} covered={covered && !toast.paneId} />
      ))}
    </div>
  )
}

/**
 * A PushScreen's claim while it is open (`ref` is its dialog element);
 * whether it is the one on top, which shows the notices inside it.
 */
export function usePushToasts(open: boolean, ref: RefObject<HTMLElement | null>): boolean {
  const id = useId()
  useEffect(() => {
    const el = ref.current
    if (!open || !el) return
    usePushRooms.setState((s) => ({ rooms: { ...s.rooms, [id]: el } }))
    return () =>
      usePushRooms.setState((s) => {
        const rooms = { ...s.rooms }
        delete rooms[id]
        return { rooms }
      })
  }, [open, ref, id])
  return usePushRooms((s) => open && topRoom(s.rooms) === id)
}
