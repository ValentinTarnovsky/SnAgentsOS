/**
 * Composer drafts per pane (E1-FR-28), in localStorage as
 * `snagentsos.draft.<paneId>` -> { text, updatedAt }. Writes are debounced by
 * DRAFT_DEBOUNCE_MS, restored when the pane is viewed again and removed once
 * the text is sent. At most DRAFT_MAX_KEYS drafts of DRAFT_MAX_CHARS each: a
 * new draft over the cap evicts the oldest one. On the page's first authOk,
 * drafts older than DRAFT_MAX_AGE_MS whose pane is gone are pruned.
 *
 * Pure apart from storage (mobileStorage.ts, every access try/catch) and the
 * injectable clock/timers, so the rules run under Node in the tests.
 */
import { DRAFT_PREFIX, storageGet, storageKeys, storageRemove, storageSet, storageWipeGeneration } from './mobileStorage'

export const DRAFT_DEBOUNCE_MS = 300
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const DRAFT_MAX_KEYS = 50
export const DRAFT_MAX_CHARS = 16384

export interface Draft {
  text: string
  updatedAt: number
}

export function draftKey(paneId: string): string {
  return `${DRAFT_PREFIX}${paneId}`
}

function parseDraft(raw: string | null): Draft | null {
  if (raw == null) return null
  try {
    const v: unknown = JSON.parse(raw)
    if (!v || typeof v !== 'object') return null
    const { text, updatedAt } = v as Record<string, unknown>
    if (typeof text !== 'string' || typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return null
    return { text: text.slice(0, DRAFT_MAX_CHARS), updatedAt }
  } catch {
    return null
  }
}

export function loadDraft(paneId: string): Draft | null {
  return parseDraft(storageGet(draftKey(paneId)))
}

export function clearDraft(paneId: string): void {
  storageRemove(draftKey(paneId))
}

/** Drop the oldest drafts (other than keepKey) until a new one fits the cap. */
function evictForNewKey(keepKey: string): void {
  const entries = storageKeys(DRAFT_PREFIX)
    .filter((key) => key !== keepKey)
    .map((key) => ({ key, at: parseDraft(storageGet(key))?.updatedAt ?? -Infinity }))
  let excess = entries.length + 1 - DRAFT_MAX_KEYS
  if (excess <= 0) return
  entries.sort((a, b) => a.at - b.at)
  for (const { key } of entries) {
    if (excess-- <= 0) break
    storageRemove(key)
  }
}

/** Save (or, for an empty text, remove) a pane's draft right away. */
export function saveDraft(paneId: string, text: string, now: number = Date.now()): void {
  const key = draftKey(paneId)
  if (text.length === 0) {
    storageRemove(key)
    return
  }
  if (storageGet(key) == null) evictForNewKey(key)
  const draft: Draft = { text: text.slice(0, DRAFT_MAX_CHARS), updatedAt: now }
  storageSet(key, JSON.stringify(draft))
}

/**
 * Remove drafts older than DRAFT_MAX_AGE_MS whose pane is not in the snapshot,
 * plus unreadable entries. A recent draft of a gone pane stays (the pane may
 * come back on a reload of the desktop). Returns how many were removed.
 */
export function pruneDrafts(livePaneIds: ReadonlySet<string>, now: number = Date.now()): number {
  let removed = 0
  for (const key of storageKeys(DRAFT_PREFIX)) {
    const draft = parseDraft(storageGet(key))
    const paneId = key.slice(DRAFT_PREFIX.length)
    if (!draft || (now - draft.updatedAt > DRAFT_MAX_AGE_MS && !livePaneIds.has(paneId))) {
      storageRemove(key)
      removed++
    }
  }
  return removed
}

interface TimerApi {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (id: unknown) => void
}

export interface DraftWriter {
  /** Save text for paneId after DRAFT_DEBOUNCE_MS of quiet. */
  schedule(paneId: string, text: string): void
  /** Write the pending draft now (pane switch, page hide, unmount). */
  flush(): void
  /** Drop the pending write (the text was sent). */
  cancel(): void
}

export function createDraftWriter(
  opts: { now?: () => number; timers?: TimerApi; save?: typeof saveDraft } = {},
): DraftWriter {
  const now = opts.now ?? (() => Date.now())
  const timers: TimerApi = opts.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  }
  const save = opts.save ?? saveDraft
  let pending: { paneId: string; text: string; gen: number } | null = null
  let timer: unknown = null

  const clear = (): void => {
    if (timer != null) timers.clearTimeout(timer)
    timer = null
  }
  const flush = (): void => {
    clear()
    const p = pending
    pending = null
    // A wipe (unpair, revoke) since the keystroke drops the write.
    if (p && p.gen === storageWipeGeneration()) save(p.paneId, p.text, now())
  }
  return {
    schedule(paneId, text) {
      if (pending && pending.paneId !== paneId) flush()
      pending = { paneId, text, gen: storageWipeGeneration() }
      clear()
      timer = timers.setTimeout(flush, DRAFT_DEBOUNCE_MS)
    },
    flush,
    cancel() {
      clear()
      pending = null
    },
  }
}
