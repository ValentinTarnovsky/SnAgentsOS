import type { AgentRenameEvt } from '@shared/types'
import { translate } from '@/i18n'
import { useAppStore } from './store'
import { toast } from './toast'
import { getPtyId } from './ptyRegistry'
import { isDefaultTitle } from './agentNav'

/** Why an agent rename was not applied (tests), or 'renamed'. */
export type AgentRenameOutcome = 'renamed' | 'off' | 'no_pane' | 'stale_pty' | 'kept_manual' | 'same' | 'invalid'

/**
 * v2.4 `/rename` (status:agentRename): the agent of the console named its
 * session, so the console takes that name. Main already deduplicated it per
 * session and only sends the console's main session. Here:
 *
 * - agents.syncAgentRename off: nothing (main still remembered the name);
 * - the pane is gone, or its live pty is another one: nothing;
 * - `initial` (the name was there before main watched, a resume) never
 *   overwrites a console renamed by hand (isDefaultTitle);
 * - otherwise renamePane, the single writer, and a small toast.
 *
 * Precedence falls out of it: a new agent name always wins (the latest
 * explicit action), a manual rename stays until the agent names the session
 * something else, and automatic titles (topic, AI title) never get here.
 */
export function applyAgentRename(evt: AgentRenameEvt): AgentRenameOutcome {
  const s = useAppStore.getState()
  if (s.settings.agents?.syncAgentRename === false) return 'off'
  const title = typeof evt.title === 'string' ? evt.title.trim() : ''
  if (!title) return 'invalid'
  const ws = s.workspaces.find((w) => w.panes.some((p) => p.id === evt.paneId))
  const pane = ws?.panes.find((p) => p.id === evt.paneId)
  if (!ws || !pane) return 'no_pane'
  // An unmounted pane has no binding here; main already checked its live pty.
  const live = getPtyId(evt.paneId)
  if (live !== undefined && live !== evt.ptyId) return 'stale_pty'
  if (pane.title === title) return 'same'
  if (evt.initial && !isDefaultTitle(pane, s.presets)) return 'kept_manual'
  s.renamePane(ws.id, pane.id, title)
  toast.info(translate(s.settings.language, 'agents.renamed', { title }), { dedupeKey: `agent-rename:${pane.id}` })
  return 'renamed'
}
