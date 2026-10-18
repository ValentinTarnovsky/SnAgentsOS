import type { AgentPreset, ConnectionProfile, Pane, SetupStep, Workspace } from '@shared/types'
import { buildAgentArgv } from '@shared/agent-argv'
import type { LaunchKind } from '@shared/initialPrompt'

export interface ResolvedLaunch {
  cwd: string
  initialCommand?: string
  /** Pre-launch sequence (e.g. SSH) the pty runs before initialCommand. */
  setup?: SetupStep[]
  /**
   * E8-FR-02b: 'claude' / 'codex' only when initialCommand is that preset's
   * own command (no pane.command override); enables the `argv` prompt.
   * Absent = 'other'.
   */
  launchKind?: LaunchKind
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

  const override = !!pane.command?.trim()
  const launchKind: LaunchKind =
    initialCommand && !override && (preset?.type === 'claude' || preset?.type === 'codex') ? preset.type : 'other'

  return { cwd, initialCommand, setup: setup && setup.length ? setup : undefined, launchKind }
}
