import type { Pane, Workspace } from '@shared/types'
import { sanitizeForPaste } from '@shared/review-notes-format'
import { useAppStore } from './store'
import { getPtyId } from './ptyRegistry'
import { pasteToPane } from './pasteRegistry'
import { isAgentPane } from './agentPane'
import { submitDelayFor } from './submit'

/**
 * How a console takes a global prompt (E7-FR-33): an agent console (Claude
 * or Codex with bracketed paste on) gets the whole text as one paste and,
 * with "Send with Enter", the Enter after it; any other console ("plain")
 * gets it on a single line and never an Enter, so a shell runs nothing.
 */
export type PromptTarget = 'agent' | 'plain'

export function promptTargetOf(pane: Pick<Pane, 'id' | 'type'>): PromptTarget {
  return isAgentPane(pane, useAppStore.getState().paneStatus[pane.id]) ? 'agent' : 'plain'
}

/** CRLF and lone CR become LF, then controls are neutralized as for any paste (ESC can never close the frame). */
export function promptText(text: string): string {
  return sanitizeForPaste(text.replace(/\r\n?/g, '\n'))
}

/** One line for a plain console: every line break (and the tabs around it) becomes one space. */
export function oneLine(text: string): string {
  return text
    .replace(/[ \t]*(?:\r\n|\r|\n|\u2028|\u2029)+[ \t]*/g, ' ')
    .trim()
}

/** UTF-8 size (the Enter delay grows with the paste). */
function bytesOf(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * Paste one prompt into a console through xterm (`term.paste`, never a raw
 * pty write) and, when asked and the console is an agent, press Enter after
 * `submitDelayFor(bytes)` on the same pty only. False when the console has no
 * live pty or mounted terminal. v2.3: both writes go as `origin: 'auto'`, so a
 * prompt inserted without Enter never clears the consoles' attention marks.
 */
export function deliverPrompt(paneId: string, text: string, opts: { agent: boolean; enter: boolean }): boolean {
  const ptyId = getPtyId(paneId)
  if (!ptyId) return false
  const clean = promptText(text)
  const payload = opts.agent ? clean : oneLine(clean)
  if (!payload || !pasteToPane(paneId, payload, { auto: true })) return false
  if (opts.enter && opts.agent) {
    setTimeout(() => {
      // A console restarted in between never gets a stray Enter.
      if (getPtyId(paneId) === ptyId) window.snApi.pty.write({ ptyId, data: '\r', origin: 'auto' })
    }, submitDelayFor(bytesOf(payload)))
  }
  return true
}

export interface BroadcastOpts {
  /** The chosen destinations (default: every active console). */
  paneIds?: readonly string[]
  /** "Send with Enter" (default off): agent consoles only. */
  enter?: boolean
}

/**
 * Insert the same text into the ACTIVE (non-minimized) consoles of a
 * workspace that have a live pty, optionally only the chosen ones (E7-FR-33).
 * Agent consoles get the text as is (plus Enter when asked); plain ones get
 * it on one line, without Enter. The phone's globalPrompt uses it with the
 * defaults: every active console, no Enter. Returns how many received it.
 */
export function broadcastToWorkspace(workspace: Workspace, text: string, opts: BroadcastOpts = {}): number {
  if (!text) return 0
  const minimized = useAppStore.getState().minimized[workspace.id] ?? []
  const chosen = opts.paneIds ? new Set(opts.paneIds) : null
  let sent = 0
  for (const pane of workspace.panes) {
    if (minimized.includes(pane.id)) continue
    if (chosen && !chosen.has(pane.id)) continue
    const agent = promptTargetOf(pane) === 'agent'
    if (deliverPrompt(pane.id, text, { agent, enter: opts.enter === true })) sent++
  }
  return sent
}
