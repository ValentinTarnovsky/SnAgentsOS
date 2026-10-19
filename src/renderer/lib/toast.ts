import type { ReactNode } from 'react'
import { create } from 'zustand'

/**
 * Desktop toast stack (E4-FR-03). A zustand store kept apart from useAppStore
 * so a push never re-renders the app: only NotificationStack subscribes here.
 * Text is always rendered as React text, never as HTML.
 */
export type ToastKind = 'success' | 'info' | 'warning' | 'error' | 'card'
/** 3 update/recovery, 2 agent `action`, 1 error, 0 everything else. */
export type ToastPriority = 0 | 1 | 2 | 3
export interface ToastAction {
  label: string
  run: () => void
}
export interface ToastItem {
  id: string
  kind: ToastKind
  title: string
  body?: string
  /** Up to 2 buttons, plus the optional `link`. */
  actions?: ToastAction[]
  /** Optional trailing text link (e.g. "Settings"). */
  link?: ToastAction
  /** null = persistent until closed. */
  durationMs: number | null
  priority: ToastPriority
  dedupeKey?: string
  createdAt: number
  /** Only for kind 'card'. */
  node?: ReactNode
  /** Bumped when a dedupeKey push replaces the card: restarts its timer. */
  rev?: number
  /** Only for kind 'card': the node renders its own close controls (the update card). */
  hideClose?: boolean
}

export const TOAST_MAX_VISIBLE = 4

const DEFAULTS: Record<ToastKind, { durationMs: number | null; priority: ToastPriority }> = {
  success: { durationMs: 3000, priority: 0 },
  info: { durationMs: 3000, priority: 0 },
  warning: { durationMs: 6000, priority: 0 },
  error: { durationMs: null, priority: 1 },
  card: { durationMs: null, priority: 0 },
}

/**
 * Which toasts are on screen: the `max` best by priority (newest first within
 * a priority), shown oldest to newest so the newest sits at the bottom. The
 * rest collapse into the "+N" row. Pure, so the rules are unit tested.
 */
export function selectVisible(items: ToastItem[], max = TOAST_MAX_VISIBLE): { visible: ToastItem[]; overflow: number } {
  if (items.length <= max) return { visible: [...items].sort(byAge), overflow: 0 }
  const ranked = [...items].sort((a, b) => b.priority - a.priority || b.createdAt - a.createdAt || order(b) - order(a))
  return { visible: ranked.slice(0, max).sort(byAge), overflow: items.length - max }
}

/**
 * After pushing `newId`, drop the oldest non-persistent toasts while more than
 * `max` are queued. Persistent ones are never evicted (they overflow instead),
 * and neither is the toast that was just pushed.
 */
export function pruneForPush(items: ToastItem[], newId: string, max = TOAST_MAX_VISIBLE): ToastItem[] {
  let next = items
  while (next.length > max) {
    const victim = next
      .filter((t) => t.durationMs !== null && t.id !== newId)
      .sort(byAge)[0]
    if (!victim) break
    next = next.filter((t) => t !== victim)
  }
  return next
}

let seq = 0
const orderOf = new WeakMap<ToastItem, number>()
function order(t: ToastItem): number {
  return orderOf.get(t) ?? 0
}
function byAge(a: ToastItem, b: ToastItem): number {
  return a.createdAt - b.createdAt || order(a) - order(b)
}

interface ToastStoreState {
  items: ToastItem[]
}

export const useToastStore = create<ToastStoreState>(() => ({ items: [] }))

function push(kind: ToastKind, title: string, o: Partial<ToastItem> = {}, node?: ReactNode): string {
  const { items } = useToastStore.getState()
  const prev = o.dedupeKey ? items.find((t) => t.dedupeKey === o.dedupeKey) : undefined
  const id = prev?.id ?? o.id ?? `toast-${++seq}`
  const item: ToastItem = {
    ...DEFAULTS[kind],
    ...o,
    id,
    kind,
    title,
    createdAt: prev?.createdAt ?? o.createdAt ?? Date.now(),
    rev: (prev?.rev ?? 0) + (prev ? 1 : 0),
    ...(node !== undefined ? { node } : {}),
  }
  orderOf.set(item, prev ? order(prev) : ++seq)
  const next = prev ? items.map((t) => (t === prev ? item : t)) : [...items, item]
  useToastStore.setState({ items: pruneForPush(next, id) })
  return id
}

export const toast = {
  success: (title: string, o?: Partial<ToastItem>): string => push('success', title, o),
  info: (title: string, o?: Partial<ToastItem>): string => push('info', title, o),
  warning: (title: string, o?: Partial<ToastItem>): string => push('warning', title, o),
  error: (title: string, o?: Partial<ToastItem>): string => push('error', title, o),
  card: (node: ReactNode, o?: Partial<ToastItem>): string => push('card', o?.title ?? '', o, node),
  dismiss(id: string): void {
    const { items } = useToastStore.getState()
    if (items.some((t) => t.id === id)) useToastStore.setState({ items: items.filter((t) => t.id !== id) })
  },
  dismissByKey(key: string): void {
    const { items } = useToastStore.getState()
    if (items.some((t) => t.dedupeKey === key)) useToastStore.setState({ items: items.filter((t) => t.dedupeKey !== key) })
  },
  /** Whether a toast with this dedupeKey is queued (visible or overflowed). */
  has(key: string): boolean {
    return useToastStore.getState().items.some((t) => t.dedupeKey === key)
  },
}

/**
 * True when a DOM event started inside the toast stack. Modal backdrops use it
 * so a click on a toast never closes the modal underneath.
 */
export function isFromToast(e: { target: EventTarget | null }): boolean {
  const el = e.target as { closest?: (sel: string) => unknown } | null
  return !!el && typeof el.closest === 'function' && !!el.closest('[data-toast-root]')
}
