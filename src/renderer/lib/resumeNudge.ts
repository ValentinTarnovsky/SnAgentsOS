/**
 * Resume nudge (E5-FR-13): a resumed console that was mid-turn when the app
 * closed gets a "continue where you left off" line once its agent is ready:
 * on the first `idle` after the session's `start`, or 1 s after the `start`
 * when no `idle` comes. Without a `start` in 20 s nothing is sent, and a
 * console waiting on the user (`action`) never gets it. The Enter goes 150 ms
 * after the text. Timers, the pty write and the state check are injected so
 * the rules run under fake timers.
 */
import type { AgentsReadyEvt } from '@shared/agents'

export const NUDGE_START_TIMEOUT_MS = 20_000
export const NUDGE_IDLE_WAIT_MS = 1_000
export const NUDGE_ENTER_DELAY_MS = 150

export interface NudgeDeps {
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (id: unknown) => void
  /** Writes to the pane's pty; false when it has none. */
  write: (paneId: string, data: string) => boolean
  /** The console is waiting on the user right now. */
  isAction: (paneId: string) => boolean
}

interface Armed {
  text: string
  /** Session whose start was seen (its idle fires the nudge). */
  sessionId?: string
  timer: unknown
}

export interface Nudger {
  /** Waits for the pane's next session start, then nudges it with `text`. */
  arm: (paneId: string, text: string) => void
  /** agents:ready from main. */
  onReady: (evt: AgentsReadyEvt) => void
  cancel: (paneId: string) => void
  isArmed: (paneId: string) => boolean
}

export function createNudger(deps: NudgeDeps): Nudger {
  const armed = new Map<string, Armed>()

  const drop = (paneId: string): void => {
    const a = armed.get(paneId)
    if (a) deps.clearTimer(a.timer)
    armed.delete(paneId)
  }

  const fire = (paneId: string): void => {
    const a = armed.get(paneId)
    drop(paneId)
    if (!a || deps.isAction(paneId)) return
    if (!deps.write(paneId, a.text)) return
    deps.setTimer(() => {
      if (!deps.isAction(paneId)) deps.write(paneId, '\r')
    }, NUDGE_ENTER_DELAY_MS)
  }

  return {
    arm: (paneId, text) => {
      drop(paneId)
      const body = text.trim()
      if (!body) return
      armed.set(paneId, { text: body, timer: deps.setTimer(() => armed.delete(paneId), NUDGE_START_TIMEOUT_MS) })
    },
    onReady: (evt) => {
      const a = armed.get(evt.paneId)
      if (!a) return
      if (evt.phase === 'start') {
        deps.clearTimer(a.timer)
        a.sessionId = evt.sessionId
        a.timer = deps.setTimer(() => fire(evt.paneId), NUDGE_IDLE_WAIT_MS)
        return
      }
      // The first idle of the session that started fires it at once.
      if (a.sessionId && a.sessionId === evt.sessionId) fire(evt.paneId)
    },
    cancel: drop,
    isArmed: (paneId) => armed.has(paneId),
  }
}
