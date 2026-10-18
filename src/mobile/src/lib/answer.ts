/**
 * Sending an answer card (E2-FR-21, 24): plain `input` frames, no new WS
 * message. Allow is "1", Deny is Esc (never followed by Enter); an
 * AskUserQuestion answer is the key groups of buildAskAnswerKeys.
 *
 *  - Before the first group the request must still be in the last paneStatus
 *    (else the toast "Already answered"). Main takes it out of pending[] as
 *    soon as any input reaches the pty (E2-FR-48), the phone's own answer
 *    included, so the card goes away at once and a second tap finds nothing.
 *  - One lock per pane: a second tap during a sequence is ignored.
 *  - One group every ANSWER_STEP_MS through a single chained timer. Before
 *    each later group the socket must still be authenticated and the pane
 *    still in 'action' with reason 'question'; otherwise the rest is dropped.
 *    A socket that drops mid way aborts with "The connection dropped".
 *  - "Sending answer..." lasts groups * ANSWER_STEP_MS, then "Sent". An ask
 *    still waiting ASK_CONFIRM_MS after its last group reads "Not confirmed,
 *    check the terminal", with no automatic retry.
 *
 * createAnswerer is pure (deps injected) so the rules run under fake timers;
 * answerLive.ts binds the singleton to the WS client and the store.
 */
import { create } from 'zustand'
import type { RemotePaneStatus, RemotePending } from '@shared/remote-protocol'
import {
  ANSWER_STEP_MS,
  MAX_ANSWER_GROUPS,
  buildAskAnswerKeys,
  groupData,
  type AnswerKeyGroup,
  type AskSelection,
} from '@shared/askAnswerKeys'

/** An ask still waiting this long after its last group is "not confirmed". */
export const ASK_CONFIRM_MS = 5000
/** "Sent" stays on screen this long for a permission answer. */
export const SENT_VISIBLE_MS = 1500

export type AnswerPayload =
  | { kind: 'allow' }
  | { kind: 'deny' }
  | { kind: 'ask'; selections: readonly (AskSelection | undefined)[] }

export type AnswerPhase = 'sending' | 'sent' | 'unconfirmed' | 'disconnected'

/** The send in progress (or its outcome) for one pane. */
export interface AnswerState {
  pendingId: string
  kind: 'permission' | 'question'
  phase: AnswerPhase
  groups: number
}

/** What a tap did: started a sequence, or why it did not. */
export type AnswerResult = 'started' | 'busy' | 'stale' | 'invalid' | 'tooLong' | 'offline'

/** The key groups of an answer, [] when it cannot be built. Allow and Deny never carry "\r". */
export function answerGroups(pending: RemotePending, payload: AnswerPayload): AnswerKeyGroup[] {
  if (payload.kind === 'allow') return pending.kind === 'permission' ? [{ raw: '1' }] : []
  if (payload.kind === 'deny') return pending.kind === 'permission' ? [{ raw: '\x1b' }] : []
  return pending.kind === 'question' ? buildAskAnswerKeys(pending, payload.selections) : []
}

/** The pane still shows an AskUserQuestion menu. */
function stillAsking(status: RemotePaneStatus | undefined): boolean {
  return !!status && status.state === 'action' && status.reason === 'question'
}

type Timer = ReturnType<typeof setTimeout>

export interface AnswerDeps {
  /** An authenticated socket is open. */
  isOpen(): boolean
  /** Write one group to the pane; false when it could not go out. */
  send(paneId: string, data: string): boolean
  /** The last paneStatus received for the pane. */
  status(paneId: string): RemotePaneStatus | undefined
  /** Publish the pane's answer state (null clears it). */
  setState(paneId: string, state: AnswerState | null): void
  /** The tapped request is gone ("Already answered"). */
  onStale(paneId: string): void
  setTimeout(fn: () => void, ms: number): Timer
  clearTimeout(id: Timer): void
}

export interface Answerer {
  answerCard(paneId: string, pendingId: string, payload: AnswerPayload): AnswerResult
  /** A sequence is running on the pane (its buttons stay disabled). */
  busy(paneId: string): boolean
  /** The socket dropped: abort every running sequence. */
  abortAll(): void
  /** Forget the pane's outcome (dismissed, or the pane left 'action'). */
  dismiss(paneId: string): void
}

export function createAnswerer(deps: AnswerDeps): Answerer {
  /** Running sequences: the chained group timer per pane. */
  const running = new Map<string, { timer: Timer | null; state: AnswerState }>()
  /** Timers after the last group ("Sent" -> clear / "Not confirmed"). */
  const after = new Map<string, Timer>()

  const clearAfter = (paneId: string): void => {
    const timer = after.get(paneId)
    if (timer !== undefined) deps.clearTimeout(timer)
    after.delete(paneId)
  }

  const finish = (paneId: string, state: AnswerState | null): void => {
    const run = running.get(paneId)
    if (run?.timer) deps.clearTimeout(run.timer)
    running.delete(paneId)
    deps.setState(paneId, state)
  }

  const afterLast = (paneId: string, state: AnswerState): void => {
    const sent: AnswerState = { ...state, phase: 'sent' }
    finish(paneId, sent)
    if (state.kind === 'permission') {
      after.set(paneId, deps.setTimeout(() => {
        after.delete(paneId)
        deps.setState(paneId, null)
      }, SENT_VISIBLE_MS))
      return
    }
    // ASK_CONFIRM_MS after the last group, which went out ANSWER_STEP_MS ago.
    after.set(paneId, deps.setTimeout(() => {
      after.delete(paneId)
      const status = deps.status(paneId)
      // A new question of its own is a new request, not this one unconfirmed.
      const newer = status?.pending?.some((p) => p.kind === 'question' && p.id !== state.pendingId)
      deps.setState(paneId, stillAsking(status) && !newer ? { ...state, phase: 'unconfirmed' } : null)
    }, Math.max(0, ASK_CONFIRM_MS - ANSWER_STEP_MS)))
  }

  return {
    answerCard(paneId, pendingId, payload) {
      if (running.has(paneId)) return 'busy'
      const pending = deps.status(paneId)?.pending?.find((p) => p.id === pendingId)
      if (!pending) {
        deps.onStale(paneId)
        return 'stale'
      }
      const groups = answerGroups(pending, payload)
      if (groups.length === 0) return 'invalid'
      if (groups.length > MAX_ANSWER_GROUPS) return 'tooLong'
      const state: AnswerState = { pendingId, kind: pending.kind === 'question' ? 'question' : 'permission', phase: 'sending', groups: groups.length }
      clearAfter(paneId)
      if (!deps.isOpen()) {
        deps.setState(paneId, { ...state, phase: 'disconnected' })
        return 'offline'
      }
      const run = { timer: null as Timer | null, state }
      running.set(paneId, run)
      deps.setState(paneId, state)
      const step = (i: number): void => {
        if (!deps.send(paneId, groupData(groups[i]))) {
          finish(paneId, { ...state, phase: 'disconnected' })
          return
        }
        run.timer = deps.setTimeout(() => {
          run.timer = null
          if (running.get(paneId) !== run) return
          if (i + 1 >= groups.length) {
            afterLast(paneId, state)
            return
          }
          if (!deps.isOpen()) {
            finish(paneId, { ...state, phase: 'disconnected' })
            return
          }
          // The menu went away (answered elsewhere, or done): drop the rest.
          if (!stillAsking(deps.status(paneId))) {
            finish(paneId, null)
            return
          }
          step(i + 1)
        }, ANSWER_STEP_MS)
      }
      step(0)
      return 'started'
    },
    busy(paneId) {
      return running.has(paneId)
    },
    abortAll() {
      for (const [paneId, run] of [...running]) finish(paneId, { ...run.state, phase: 'disconnected' })
    },
    dismiss(paneId) {
      clearAfter(paneId)
      if (!running.has(paneId)) deps.setState(paneId, null)
    },
  }
}

// --- UI state (answer outcomes, folded cards, wizard resets) ---

export interface PromptUiState {
  /** Answer state per pane (createAnswerer publishes here). */
  answers: Record<string, AnswerState>
  /** Folded cards by request id, for the page's life (E2-FR-22); new cards start open. */
  folded: Record<string, true>
  /** Bumped by "Answer" on Home: the wizard of that request restarts at step 1. */
  wizardSeq: Record<string, number>
  setAnswer: (paneId: string, state: AnswerState | null) => void
  setFolded: (pendingId: string, folded: boolean) => void
  /** Unfold the card and restart its wizard (Home's [Answer], E2-FR-23). */
  openCard: (pendingId: string) => void
}

export const usePromptUi = create<PromptUiState>((set) => ({
  answers: {},
  folded: {},
  wizardSeq: {},
  setAnswer: (paneId, state) =>
    set((s) => {
      if (!state && !(paneId in s.answers)) return s
      const answers = { ...s.answers }
      if (state) answers[paneId] = state
      else delete answers[paneId]
      return { answers }
    }),
  setFolded: (pendingId, folded) =>
    set((s) => {
      if (!!s.folded[pendingId] === folded) return s
      const next = { ...s.folded }
      if (folded) next[pendingId] = true
      else delete next[pendingId]
      return { folded: next }
    }),
  openCard: (pendingId) =>
    set((s) => {
      const folded = { ...s.folded }
      delete folded[pendingId]
      return { folded, wizardSeq: { ...s.wizardSeq, [pendingId]: (s.wizardSeq[pendingId] ?? 0) + 1 } }
    }),
}))
