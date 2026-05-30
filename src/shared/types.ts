/**
 * Core domain model, shared by main and renderer.
 * Must stay free of Node/DOM imports so it is safe in the renderer bundle.
 */

export type PaneType = 'shell' | 'claude' | 'codex' | 'custom'

export interface Pane {
  id: string
  type: PaneType
  /** Reference to an AgentPreset; when set, preset fields are merged in. */
  presetId?: string
  /** Overrides the workspace cwd for this pane. */
  cwd?: string
  /** Overrides the resolved shell/command for this pane. */
  command?: string
  title: string
  color: string
  icon: string
}

export interface Workspace {
  id: string
  name: string
  cwd: string
  panes: Pane[]
  /** Serialized dockview layout (SerializedDockview). */
  layout?: unknown
}

export interface AgentPreset {
  id: string
  name: string
  type: PaneType
  command: string
  args: string[]
  env?: Record<string, string>
  color: string
  icon: string
  defaultCwd?: string
}

export type AccentName = 'violet' | 'purple' | 'blue'

export interface Settings {
  /** Default shell per platform; undefined => resolver picks the OS default. */
  defaultShell: { win32?: string; darwin?: string; linux?: string }
  fontFamily: string
  fontSize: number
  accent: AccentName
  scrollback: number
  restoreLastWorkspace: boolean
  confirmCloseRunning: boolean
  sidebarCollapsed: boolean
}

export interface ConfigFile {
  version: number
  workspaces: Workspace[]
  presets: AgentPreset[]
  settings: Settings
  activeWorkspaceId?: string | null
}
