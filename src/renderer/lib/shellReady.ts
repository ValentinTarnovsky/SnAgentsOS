/**
 * When a console's shell can take a typed command again after its agent
 * exited (E6-FR-22): with shell integration (an OSC 133;A seen on this pane
 * since its shell started) the first prompt mark at or after the event;
 * without it, AGENT_END_READY_MS after the event. A pane with integration
 * whose prompt never comes (a nested shell without marks, a ConPTY that ate
 * the mark) falls back at AGENT_END_PROMPT_CAP_MS, the cap FR-30's
 * ready-marker uses for the initial command.
 *
 * useXterm feeds it from ShellMarks; the desktop chip enables its buttons with
 * it and runAgentEnd defers the phone's early write with it, so both wait for
 * the same moment. Timestamps share Date.now() with main's `evt.at`.
 */
import { AGENT_END_READY_MS } from './agentEnd'

/** With integration, the longest the offer waits for the prompt mark. */
export const AGENT_END_PROMPT_CAP_MS = 2500

interface PromptTrack {
  /** Date.now() of the newest OSC 133;A. */
  lastPromptAt: number
  /** Pending readiness callbacks, fired by the next prompt mark. */
  waiters: Set<() => void>
}

const tracks = new Map<string, PromptTrack>()

/** A prompt mark (OSC 133;A) reached the pane's terminal. */
export function notePrompt(paneId: string, at = Date.now()): void {
  let track = tracks.get(paneId)
  if (!track) {
    track = { lastPromptAt: at, waiters: new Set() }
    tracks.set(paneId, track)
  } else {
    track.lastPromptAt = Math.max(track.lastPromptAt, at)
  }
  for (const fire of [...track.waiters]) fire()
}

/**
 * The pane's terminal unmounted or its shell was replaced: forget its marks
 * (the next shell may run without integration). Pending waiters keep their
 * cap timer.
 */
export function forgetPrompts(paneId: string): void {
  tracks.delete(paneId)
}

/** Whether the pane's current shell has emitted prompt marks. */
export function hasPromptMarks(paneId: string): boolean {
  return tracks.has(paneId)
}

/**
 * Calls `ready` once the shell of `paneId` can take a command after an event
 * stamped `since` (synchronously when it already can). Returns the cancel.
 */
export function whenShellReady(paneId: string, since: number, ready: () => void): () => void {
  const track = tracks.get(paneId)
  const elapsed = Date.now() - since
  if (track && track.lastPromptAt >= since) {
    ready()
    return () => undefined
  }
  const wait = (track ? AGENT_END_PROMPT_CAP_MS : AGENT_END_READY_MS) - elapsed
  if (wait <= 0) {
    ready()
    return () => undefined
  }
  let done = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const fire = (): void => {
    if (done) return
    done = true
    if (timer !== undefined) clearTimeout(timer)
    track?.waiters.delete(fire)
    ready()
  }
  track?.waiters.add(fire)
  timer = setTimeout(fire, wait)
  return () => {
    done = true
    if (timer !== undefined) clearTimeout(timer)
    track?.waiters.delete(fire)
  }
}
