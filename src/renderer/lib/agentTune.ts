/**
 * Executor of the phone's `agentTune` ctl (app 2.3.0): one allowlisted slash
 * command (tuneCommand) into an agent console of the phone's workspace, by the
 * same delivery path as a phone Quick Command (`pty.submit`, main resolves the
 * pane's live pty). Enter only with the phone's explicit "Apply with Enter":
 * then the agent must be precise and at rest (tuneReady), checked here and
 * again in main together with the unsent input of its box (`readyFor`); else
 * `busy` and nothing is written. Only an applied tune (Enter and ok) reaches
 * main's read-back (`status:tuneHint`): an inserted one may never run.
 */
import type { RemoteCtlAction } from '@shared/remote-protocol'
import { effectiveProvider } from '@shared/agents'
import { tuneCommand, tuneHintOf, tuneReady } from '@shared/agentTune'
import { useAppStore } from './store'
import { getPtyId } from './ptyRegistry'

export type AgentTuneError = 'not_found' | 'not_agent' | 'unsupported' | 'busy' | 'not_running' | 'multiline_unsafe'

export async function runAgentTune(
  action: Extract<RemoteCtlAction, { kind: 'agentTune' }>,
): Promise<{ ok: boolean; error?: AgentTuneError | string }> {
  const s = useAppStore.getState()
  const ws = s.workspaces.find((w) => w.id === action.workspaceId)
  const pane = ws?.panes.find((p) => p.id === action.paneId)
  if (!pane) return { ok: false, error: 'not_found' }
  const status = s.paneStatus[pane.id]
  const preset = pane.presetId ? s.presets.find((p) => p.id === pane.presetId) : undefined
  const provider = status?.provider ?? effectiveProvider(pane, preset)
  if (!provider) return { ok: false, error: 'not_agent' }
  const text = tuneCommand(provider, action.set)
  if (!text) return { ok: false, error: 'unsupported' }
  // An ended session (`/exit`) left a bare shell: main refuses it too.
  if (action.enter && (s.agentEnded[pane.id] || !tuneReady(status, provider))) return { ok: false, error: 'busy' }
  const res = await window.snApi.pty.submit({
    ptyId: getPtyId(pane.id) ?? '',
    paneId: pane.id,
    text,
    enter: action.enter,
    ...(action.enter ? { readyFor: provider } : {}),
  })
  if (!res.ok) return { ok: false, error: res.error }
  const hint = action.enter ? tuneHintOf(action.set) : null
  if (hint) window.snApi.status.tuneHint({ paneId: pane.id, ...hint })
  return { ok: true }
}
