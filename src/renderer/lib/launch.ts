import type { AgentPreset, ConnectionProfile, Pane, SetupStep, Workspace } from '@shared/types'

export interface ResolvedLaunch {
  cwd: string
  initialCommand?: string
  /** Pre-launch sequence (e.g. SSH) the pty runs before initialCommand. */
  setup?: SetupStep[]
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

  let initialCommand: string | undefined
  if (pane.command && pane.command.trim()) {
    initialCommand = pane.command.trim()
  } else if (preset && preset.type !== 'shell' && preset.command.trim()) {
    initialCommand = [preset.command, ...preset.args].join(' ').trim()
  }

  const setupId = pane.setupId ?? workspace.setupId
  const setup = setupId ? connections.find((c) => c.id === setupId)?.steps : undefined

  return { cwd, initialCommand, setup: setup && setup.length ? setup : undefined }
}
