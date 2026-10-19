import { SUBMIT_DELAY_MS } from '@shared/initialPrompt'

export { SUBMIT_DELAY_MS }

/**
 * Wait before the Enter that follows a renderer-side paste (review notes,
 * E7-FR-19): 150 ms plus 50 ms per started 4 KB of text, at most 1000 ms, so
 * the agent has taken the whole bracketed paste before it sees the CR.
 * Text sent through `pty.submit` gets its delay in main instead.
 */
export function submitDelayFor(bytes: number): number {
  return Math.min(1000, SUBMIT_DELAY_MS + 50 * Math.ceil(Math.max(0, bytes) / 4096))
}
