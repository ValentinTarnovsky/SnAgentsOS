import type { AgentPreset, Pane, Workspace } from '@shared/types'

export interface ResolvedLaunch {
  cwd: string
  initialCommand?: string
}

/**
 * Resolves what a pane should actually run: its cwd and an optional command to
 * type into the shell. Precedence: pane override > preset > workspace default.
 */
export function resolveLaunch(
  pane: Pane,
  workspace: Workspace,
  presets: AgentPreset[],
): ResolvedLaunch {
  const preset = pane.presetId ? presets.find((p) => p.id === pane.presetId) : undefined
  const cwd = pane.cwd ?? preset?.defaultCwd ?? workspace.cwd

  let initialCommand: string | undefined
  if (pane.command && pane.command.trim()) {
    initialCommand = pane.command.trim()
  } else if (preset && preset.type !== 'shell' && preset.command.trim()) {
    initialCommand = [preset.command, ...preset.args].join(' ').trim()
  }

  return { cwd, initialCommand }
}
