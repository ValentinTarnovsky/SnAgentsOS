/**
 * The one way the "Claude exited [Resume] [New]" offer is taken, from the
 * desktop chip (E6-FR-22) or the phone's strip (ctl agentResume, E6-FR-24):
 * both type the very same text, built by agentEndCommands from the store.
 *
 * The first action clears `agentEnded[paneId]` synchronously, so a second
 * one, from any device, finds no offer and gets `stale`: the renderer runs
 * every ctl on its single thread, so two phones tapping at once yield one
 * command.
 */
import type { ShellKind } from '@shared/ipc-contract'
import type { RemotePaneInfo } from '@shared/remote-protocol'
import { shellKind as shellKindOf } from '@shared/shellKind'
import { type AppState, useAppStore } from './store'
import { getPtyId } from './ptyRegistry'
import { resolveLaunch } from './launch'
import { agentEndCommands } from './agentEnd'
import { whenShellReady } from './shellReady'

export type AgentEndMode = 'resume' | 'new'

export type AgentEndResult = { ok: true } | { ok: false; error: 'stale' | 'not_found' | 'no_resume' | 'not_running' }

/** Live shell family of each mounted terminal, registered by its chip. */
const shellKinds = new Map<string, () => ShellKind | null>()

/** Register the shell family getter of a mounted pane; returns the unregister. */
export function registerAgentEndShell(paneId: string, get: () => ShellKind | null): () => void {
  shellKinds.set(paneId, get)
  return () => {
    if (shellKinds.get(paneId) === get) shellKinds.delete(paneId)
  }
}

/** The shell main falls back to when settings.defaultShell is empty (shellResolver.defaultShell). */
export function platformDefaultShell(platform: string): string {
  if (platform === 'win32') return 'powershell.exe'
  return platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
}

/**
 * Shell family of a pane: the live one its terminal reported, else (a pane not
 * mounted on the desktop) the configured default shell, as main resolves it.
 */
function paneShellKind(state: AppState, paneId: string): ShellKind | null {
  const live = shellKinds.get(paneId)?.()
  if (live) return live
  const platform = typeof window !== 'undefined' ? window.snApi.platform : ''
  const configured = platform === 'win32' || platform === 'darwin' || platform === 'linux' ? state.settings.defaultShell?.[platform] : undefined
  const kind = shellKindOf(configured?.trim() ? configured : platformDefaultShell(platform), platform)
  return kind === 'unknown' ? 'other' : kind
}

function findPane(state: AppState, paneId: string) {
  for (const ws of state.workspaces) {
    const pane = ws.panes.find((p) => p.id === paneId)
    if (pane) return { ws, pane }
  }
  return null
}

/** The commands the offer of `paneId` would type now, or null without an offer. */
function commandsFor(state: AppState, paneId: string) {
  const evt = state.agentEnded[paneId]
  if (!evt || state.settings.terminalAgentEndChip === false) return null
  const found = findPane(state, paneId)
  if (!found) return null
  const { ws, pane } = found
  const preset = pane.presetId ? state.presets.find((p) => p.id === pane.presetId) : undefined
  const { initialCommand } = resolveLaunch(pane, ws, state.presets, state.connections)
  return { evt, cmds: agentEndCommands({ evt, shellKind: paneShellKind(state, paneId), preset, paneCommand: pane.command, initialCommand }) }
}

/**
 * The phone's mirror of the chip (`RemotePaneInfo.agentEnded`): present only
 * while the desktop would show it. Resume availability does not depend on the
 * shell (only the cd prefix does).
 */
export function remoteAgentEnded(state: AppState, paneId: string): RemotePaneInfo['agentEnded'] {
  const found = commandsFor(state, paneId)
  return found ? { canResume: found.cmds.resume !== null, ...(found.evt.provider === 'codex' ? { provider: 'codex' as const } : {}) } : undefined
}

/**
 * Take the offer of `paneId`: clear it, then type the command and Enter into
 * its pty. Before the shell is ready (its first prompt mark after the event
 * with shell integration, else AGENT_END_READY_MS) the write waits for it:
 * the desktop buttons stay disabled until then; the phone cannot see that
 * moment (shellReady). `workspaceId`, when given, must own the pane.
 */
export function runAgentEnd(paneId: string, mode: AgentEndMode, workspaceId?: string): AgentEndResult {
  const state = useAppStore.getState()
  if (workspaceId !== undefined) {
    const ws = state.workspaces.find((w) => w.id === workspaceId)
    if (!ws || !ws.panes.some((p) => p.id === paneId)) return { ok: false, error: 'not_found' }
  }
  const found = commandsFor(state, paneId)
  if (!found) return { ok: false, error: 'stale' }
  const text = mode === 'resume' ? found.cmds.resume : found.cmds.fresh
  if (!text) return { ok: false, error: 'no_resume' }
  const ptyId = getPtyId(paneId)
  // Nothing can take an offer without a live pty: drop it (the desktop chip
  // already hid on that refusal) so the phone strip does not linger.
  state.clearAgentEnded(paneId)
  if (!ptyId) return { ok: false, error: 'not_running' }
  // A bare CR is exactly what Enter sends (CRLF makes PowerShell print ">>").
  const write = (): void => window.snApi.pty.write({ ptyId, data: text + '\r' })
  whenShellReady(paneId, found.evt.at, write)
  return { ok: true }
}
