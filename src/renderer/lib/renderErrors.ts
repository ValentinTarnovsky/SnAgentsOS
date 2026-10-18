import type { RenderErrorReport, RenderErrorScope, RendererDiagnostics } from '@shared/ipc-contract'
import { RenderErrorThrottle, renderErrorKey } from '@shared/renderErrorThrottle'
import { BRAND } from '@shared/brand'
import { translate } from '@/i18n'
import { useAppStore } from '@/lib/store'
import { toast } from '@/lib/toast'

/**
 * Render errors on the renderer side (E4-FR-20, 23, 24): a ring of the last
 * 10 reports, the same dedupe/throttle main applies, the send to main, the
 * window-level handlers for async errors that never reach a boundary, and the
 * "Copy diagnostics" / recovery card actions. Nothing here touches a pty.
 */
export const RENDER_RING_MAX = 10
export const STACK_MAX = 8 * 1024
/** [Copy detail] of a pane fallback: message + stack + componentStack. */
export const DETAIL_MAX = 4 * 1024
/** "Reload console" stops being the primary after this many failures in PANE_FAILURE_WINDOW_MS. */
export const PANE_FAILURE_LIMIT = 3
export const PANE_FAILURE_WINDOW_MS = 60_000

const ring: RenderErrorReport[] = []
const throttle = new RenderErrorThrottle()

function errorParts(error: unknown): { message: string; stack?: string } {
  // Duck-typed so an error thrown from another realm still counts as one.
  if (error && typeof error === 'object' && typeof (error as Error).message === 'string' && 'stack' in error) {
    const e = error as Error
    return { message: e.message || e.name || 'Error', stack: typeof e.stack === 'string' ? e.stack : undefined }
  }
  if (typeof error === 'string') return { message: error }
  try {
    return { message: JSON.stringify(error) ?? String(error) }
  } catch {
    return { message: String(error) }
  }
}

/** Normalize anything thrown into a report (strings trimmed to the limits). */
export function toReport(scope: RenderErrorScope, error: unknown, extra: { paneId?: string; componentStack?: string | null; at?: number } = {}): RenderErrorReport {
  const { message, stack } = errorParts(error)
  return {
    scope,
    ...(extra.paneId ? { paneId: extra.paneId } : {}),
    message: message.slice(0, 1024),
    ...(stack ? { stack: stack.slice(0, STACK_MAX) } : {}),
    ...(extra.componentStack ? { componentStack: extra.componentStack.slice(0, STACK_MAX) } : {}),
    at: extra.at ?? Date.now(),
  }
}

/**
 * Remember and forward one report. Throttled per scope+message (1 per 60 s)
 * and 10 per minute overall; returns whether it went through.
 */
export function reportRenderError(report: RenderErrorReport, now = Date.now()): boolean {
  if (!throttle.allow(renderErrorKey(report.scope, report.message), now)) return false
  ring.push(report)
  if (ring.length > RENDER_RING_MAX) ring.splice(0, ring.length - RENDER_RING_MAX)
  try {
    window.snApi?.app?.reportRenderError?.(report)
  } catch {
    /* main unreachable: the ring still has it */
  }
  return true
}

export function recentRenderErrors(): RenderErrorReport[] {
  return [...ring]
}

/** Noise the browser raises on its own, never a bug of ours. */
function ignorable(message: string): boolean {
  return /^ResizeObserver loop/.test(message)
}

let globalHandlersInstalled = false

/**
 * window.onerror / unhandledrejection as `render-error` scope 'window'
 * (async callbacks such as pty.onData or term.write never reach a boundary).
 * No visual fallback. Idempotent.
 */
export function installGlobalErrorHandlers(): void {
  if (globalHandlersInstalled || typeof window === 'undefined') return
  globalHandlersInstalled = true
  window.addEventListener('error', (e) => {
    const message = errorParts(e.error ?? e.message).message
    if (ignorable(message)) return
    reportRenderError(toReport('window', e.error ?? e.message))
  })
  window.addEventListener('unhandledrejection', (e) => {
    reportRenderError(toReport('window', e.reason))
  })
}

/** How many of `times` fall inside the window ending at `now`. */
export function countRecent(times: number[], now: number, windowMs = PANE_FAILURE_WINDOW_MS): number {
  return times.filter((t) => now - t < windowMs).length
}

const paneFailures = new Map<string, number[]>()

/** Note a pane fallback; returns the failures of that pane in the last 60 s. */
export function notePaneFailure(paneId: string, now = Date.now()): number {
  const list = (paneFailures.get(paneId) ?? []).filter((t) => now - t < PANE_FAILURE_WINDOW_MS)
  list.push(now)
  paneFailures.set(paneId, list)
  return list.length
}

/** Text of [Copy detail]: message, stack and component stack, at most 4KB. */
export function formatErrorDetail(error: unknown, componentStack?: string | null): string {
  const { message, stack } = errorParts(error)
  const text = [message, stack && stack !== message ? stack : '', componentStack ? `Component stack:${componentStack}` : ''].filter(Boolean).join('\n\n')
  return text.length > DETAIL_MAX ? text.slice(0, DETAIL_MAX) : text
}

/** Counts only, never contents (E4-FR-24). */
export function rendererDiagnostics(): RendererDiagnostics {
  const s = useAppStore.getState()
  return {
    renderErrors: recentRenderErrors(),
    workspaces: s.workspaces.length,
    panes: s.workspaces.reduce((n, w) => n + w.panes.length, 0),
    connections: s.connections.length,
    snippets: s.quickCommands.length,
    lang: s.settings.language,
  }
}

function lang(): 'en' | 'es' {
  return useAppStore.getState().settings.language === 'es' ? 'es' : 'en'
}

/** UTF-8 size in KB, rounded up (at least 1). */
export function sizeKb(text: string): number {
  return Math.max(1, Math.ceil(new TextEncoder().encode(text).length / 1024))
}

/** "Copy diagnostics" (About, recovery card, app fallback): main builds it, we copy and confirm. */
export async function copyDiagnostics(): Promise<boolean> {
  try {
    const text = await window.snApi.app.diagnostics(rendererDiagnostics())
    window.snApi.clipboard.writeText(text)
    toast.success(translate(lang(), 'crash.diagCopied', { kb: sizeKb(text) }), { dedupeKey: 'diag-copied' })
    return true
  } catch {
    toast.error(translate(lang(), 'crash.diagFailed'), { dedupeKey: 'diag-copied' })
    return false
  }
}

/** Copy a short text (a pane's error detail) with the "Copied" toast. */
export function copyText(text: string): void {
  window.snApi.clipboard.writeText(text)
  toast.success(translate(lang(), 'toast.copied'), { dedupeKey: 'copied' })
}

export const RECOVERY_TOAST_KEY = 'crash-recovered'

/**
 * After hydrate and the pty reconcile (FR-36), ask main once for a pending
 * recovery and show the persistent card (E4-FR-22). A manual reload leaves
 * nothing to take, so it never shows.
 */
export async function showRecoveryCard(): Promise<boolean> {
  let info: Awaited<ReturnType<typeof window.snApi.app.takeRecovery>> = null
  try {
    info = await window.snApi.app.takeRecovery()
  } catch {
    return false
  }
  if (!info) return false
  const l = lang()
  const n = info.consoles
  toast.warning(translate(l, 'crash.recovered.title', { app: BRAND.productName }), {
    body: translate(l, n === 0 ? 'crash.recovered.bodyNone' : n === 1 ? 'crash.recovered.bodyOne' : 'crash.recovered.bodyMany', { n }),
    durationMs: null,
    priority: 3,
    dedupeKey: RECOVERY_TOAST_KEY,
    actions: [{ label: translate(l, 'crash.copyDiagnostics'), run: () => void copyDiagnostics() }],
  })
  return true
}
