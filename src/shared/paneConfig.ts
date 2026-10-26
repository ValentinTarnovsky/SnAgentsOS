import type { AgentPreset, ConfigFile, Pane, Workspace } from './types'

/** A pane of the saved config, with the workspace that holds it. */
export function findPaneInConfig(cfg: ConfigFile | null | undefined, paneId: string): { pane: Pane; ws: Workspace } | null {
  for (const ws of cfg?.workspaces ?? []) {
    const pane = ws.panes.find((p) => p.id === paneId)
    if (pane) return { pane, ws }
  }
  return null
}

/** The preset a pane references (`pane.presetId`), when it still exists. */
export function presetOfPane(cfg: ConfigFile | null | undefined, pane: Pick<Pane, 'presetId'>): AgentPreset | undefined {
  return presetById(cfg, pane.presetId)
}

export function presetById(cfg: ConfigFile | null | undefined, presetId: string | undefined): AgentPreset | undefined {
  return presetId ? cfg?.presets?.find((p) => p.id === presetId) : undefined
}
