import type { Pane, PaneStatus } from '@shared/types'
import { isBracketedPaste } from './pasteRegistry'

/**
 * "Agent pane" as E7 defines it: the pane runs Claude Code or Codex (by its
 * type, or because its last status event carried a provider) AND the inner app
 * has bracketed-paste mode on. Both conditions are needed: a claude-typed pane
 * that dropped back to its shell is not an agent, and neither is a shell whose
 * agent never enabled mode 2004. Used by file drops, review notes and races.
 *
 * `bracketed` defaults to the live state of the mounted terminal; a pane with
 * no mounted xterm is never an agent pane.
 */
export function isAgentPane(
  pane: Pick<Pane, 'id' | 'type'>,
  status: Pick<PaneStatus, 'provider'> | null | undefined,
  bracketed: boolean | null = isBracketedPaste(pane.id),
): boolean {
  if (bracketed !== true) return false
  return pane.type === 'claude' || pane.type === 'codex' || status?.provider != null
}
