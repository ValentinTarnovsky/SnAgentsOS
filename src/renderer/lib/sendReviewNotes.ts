/**
 * Sending review notes to a console (E7-FR-19, 21, and the executor side of
 * the phone's `sendReviewNotes` ctl, E7-FR-25). One batch is one
 * `term.paste`: the agent gets a single bracketed paste, never a line by line
 * run in a shell, so consoles without bracketed paste are refused and nothing
 * is written. Enter only goes with the explicit "Send with Enter" (off by
 * default), only to an agent console, after `submitDelayFor(bytes)`.
 */
import type { Pane } from '@shared/types'
import { REVIEW_BATCH_MAX_NOTES, type ReviewNote, type SendReviewNotesError } from '@shared/review-notes'
import type { ReviewNotePayload } from '@shared/review-notes-format'
import { useAppStore } from './store'
import { getPtyId } from './ptyRegistry'
import { isBracketedPaste, pasteToPane } from './pasteRegistry'
import { isAgentPane } from './agentPane'
import { submitDelayFor } from './submit'
import { checkBatch, pendingNotes, toPayload, useReviewNotesStore, workspaceNotes } from './reviewNotesStore'

/** Panes per workspace (the largest GridPreset). */
export const MAX_WORKSPACE_PANES = 12
/** FR-21: how long a new Claude console has to get ready before the notes go anyway (or fail). */
export const NEW_CONSOLE_READY_MS = 20_000
const READY_POLL_MS = 250
/** After the ready signal, a beat for the agent's input box to settle. */
const READY_SETTLE_MS = 400

/** How a console takes a batch: agent (paste + optional Enter), safe (paste only), plain or unmounted (refused). */
export type NotesTarget = 'agent' | 'safe' | 'plain' | 'unmounted'

export function notesTargetOf(pane: Pick<Pane, 'id' | 'type'>): NotesTarget {
  const bracketed = isBracketedPaste(pane.id)
  if (bracketed === null || !getPtyId(pane.id)) return 'unmounted'
  if (!bracketed) return 'plain'
  return isAgentPane(pane, useAppStore.getState().paneStatus[pane.id], bracketed) ? 'agent' : 'safe'
}

export interface SendReviewNotesOpts {
  /** Store notes to send (default: every pending note of the workspace). */
  noteIds?: string[]
  /** Inline notes (the phone): formatted the same way, never stored. */
  notes?: ReviewNotePayload[]
  submit: boolean
}

export interface SendReviewNotesResult {
  ok: boolean
  sent: number
  error?: SendReviewNotesError
}

const fail = (error: SendReviewNotesError): SendReviewNotesResult => ({ ok: false, sent: 0, error })

/**
 * Validates the target and the batch, pastes it and stamps the store notes
 * as sent. Every check runs before the first write, so a refused send
 * writes nothing to the pty.
 */
export function sendReviewNotes(workspaceId: string, paneId: string, opts: SendReviewNotesOpts): SendReviewNotesResult {
  const s = useAppStore.getState()
  const ws = s.workspaces.find((w) => w.id === workspaceId)
  const pane = ws?.panes.find((p) => p.id === paneId)
  if (!ws || !pane) return fail('not_found')
  const target = notesTargetOf(pane)
  if (target === 'unmounted') return fail('no_pty')
  if (target === 'plain' || (opts.submit && target !== 'agent')) return fail('not_agent')

  let stored: ReviewNote[] = []
  let payloads: ReviewNotePayload[]
  if (opts.notes) {
    payloads = opts.notes
  } else {
    const all = workspaceNotes(useReviewNotesStore.getState().notes, workspaceId)
    const ids = opts.noteIds ? new Set(opts.noteIds) : null
    stored = ids ? all.filter((n) => ids.has(n.id) && n.resolvedAt === undefined) : pendingNotes(all)
    payloads = stored.map(toPayload)
  }
  if (!payloads.length) return fail('no_notes')
  if (payloads.length > REVIEW_BATCH_MAX_NOTES) return fail('too_large')
  const batch = checkBatch(payloads)
  if (!batch.ok) return fail('too_large')

  const ptyId = getPtyId(paneId)
  if (!ptyId || !pasteToPane(paneId, batch.text)) return fail('no_pty')
  if (opts.submit) {
    setTimeout(() => {
      // The same pty only: a console restarted in between never gets a stray Enter.
      if (getPtyId(paneId) === ptyId) window.snApi.pty.write({ ptyId, data: '\r' })
    }, submitDelayFor(batch.bytes))
  }
  if (stored.length) {
    void window.snApi.reviewNotes.markSent({ ids: stored.map((n) => n.id), paneId, sentAt: Date.now() }).catch(() => undefined)
  }
  return { ok: true, sent: payloads.length }
}

export type NewConsoleError = 'full' | 'no_preset' | 'not_found' | 'timeout' | 'closed'
export type NewConsoleResult = (SendReviewNotesResult & { paneId: string; late?: boolean }) | { ok: false; sent: 0; error: NewConsoleError; paneId?: string }

/** The Claude preset a new console uses: the default agent preset when it is Claude, else the first Claude preset. */
export function claudePresetFor(s: Pick<ReturnType<typeof useAppStore.getState>, 'presets' | 'settings'>) {
  const preferred = s.settings.automation?.defaultAgentPresetId
  const byDefault = preferred ? s.presets.find((p) => p.id === preferred && p.type === 'claude') : undefined
  return byDefault ?? s.presets.find((p) => p.type === 'claude')
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * "New Claude console" as the destination (E7-FR-21): adds a pane with the
 * Claude preset in the same folder (`cwd` for a pane worktree), waits until it
 * is ready (a first status and bracketed paste on, at most 20 s) and pastes
 * the notes chosen now. Past the timeout it still sends when the console
 * takes a safe paste (`late`), else nothing is written.
 */
export async function sendReviewNotesToNewClaude(
  workspaceId: string,
  opts: { noteIds: string[]; submit: boolean; cwd?: string },
  timing: { readyMs?: number; pollMs?: number; settleMs?: number } = {},
): Promise<NewConsoleResult> {
  const s = useAppStore.getState()
  const ws = s.workspaces.find((w) => w.id === workspaceId)
  if (!ws) return { ok: false, sent: 0, error: 'not_found' }
  if (ws.panes.length >= MAX_WORKSPACE_PANES) return { ok: false, sent: 0, error: 'full' }
  const preset = claudePresetFor(s)
  if (!preset) return { ok: false, sent: 0, error: 'no_preset' }
  const paneId = s.addPane(workspaceId, {
    type: preset.type,
    presetId: preset.id,
    title: preset.name,
    color: preset.color,
    icon: preset.icon,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  })
  if (!paneId) return { ok: false, sent: 0, error: 'not_found' }
  const readyMs = timing.readyMs ?? NEW_CONSOLE_READY_MS
  const pollMs = timing.pollMs ?? READY_POLL_MS
  const exists = (): boolean => useAppStore.getState().workspaces.some((w) => w.id === workspaceId && w.panes.some((p) => p.id === paneId))
  const ready = (): boolean => useAppStore.getState().paneStatus[paneId] != null && isBracketedPaste(paneId) === true
  const deadline = Date.now() + readyMs
  while (!ready() && Date.now() < deadline) {
    await sleep(pollMs)
    if (!exists()) return { ok: false, sent: 0, error: 'closed', paneId }
  }
  const late = !ready()
  if (late && isBracketedPaste(paneId) !== true) return { ok: false, sent: 0, error: 'timeout', paneId }
  if (!late) await sleep(timing.settleMs ?? READY_SETTLE_MS)
  if (!exists()) return { ok: false, sent: 0, error: 'closed', paneId }
  // A late console never confirmed its agent is up: the notes wait in its input, no Enter.
  const res = sendReviewNotes(workspaceId, paneId, { noteIds: opts.noteIds, submit: opts.submit && !late })
  return { ...res, paneId, ...(late ? { late: true } : {}) }
}
