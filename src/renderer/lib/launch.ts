import type { AgentPreset, ConnectionProfile, Pane, SetupStep, Workspace } from '@shared/types'
import { buildAgentArgv } from '@shared/agent-argv'

export interface ResolvedLaunch {
  cwd: string
  initialCommand?: string
  /** Pre-launch sequence (e.g. SSH) the pty runs before initialCommand. */
  setup?: SetupStep[]
  /** Set by prepareAgentLaunch when this spawn resumes a chat: no saved scrollback then (E6-FR-13). */
  resumed?: boolean
}

/**
 * Resolves what a pane should actually run: its cwd, an optional command to
 * type into the shell, and an optional connection sequence to run first.
 * Precedence: pane override > preset > workspace default. The connection
 * profile is resolved from pane.setupId, falling back to the workspace's.
 */
export function resolveLaunch(
  pane: Pane,
  workspace: Workspace,
  presets: AgentPreset[],
  connections: ConnectionProfile[],
): ResolvedLaunch {
  const preset = pane.presetId ? presets.find((p) => p.id === pane.presetId) : undefined
  const cwd = pane.cwd ?? preset?.defaultCwd ?? workspace.cwd

  // buildAgentArgv is the single agent command builder (D1); a resume is
  // decided later, at spawn time, by agentLaunch.prepareAgentLaunch.
  const initialCommand = buildAgentArgv({ preset, command: pane.command })

  const setupId = pane.setupId ?? workspace.setupId
  const setup = setupId ? connections.find((c) => c.id === setupId)?.steps : undefined

  return { cwd, initialCommand, setup: setup && setup.length ? setup : undefined }
}
