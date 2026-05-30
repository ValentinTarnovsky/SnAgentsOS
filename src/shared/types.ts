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

/** Number of terminals in a workspace grid; maps to a fixed CSS grid template. */
export type GridPreset = 1 | 2 | 4 | 6 | 8 | 10 | 12

/** Simple, human-readable layout descriptor (replaces dockview's opaque blob). */
export interface WorkspaceLayout {
  grid: GridPreset
  /** Pane ids in display order (cell placement). */
  order: string[]
}

export interface Workspace {
  id: string
  name: string
  cwd: string
  panes: Pane[]
  /** When true, sorts to the top of the workspace list. */
  favorite?: boolean
  /** Console grid layout (custom tiling grid). */
  layout?: WorkspaceLayout
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

/** Legacy accent selector (superseded by the theme registry; kept for migration). */
export type AccentName = 'violet' | 'purple' | 'blue'

export type ThemeName = 'midnight' | 'light' | 'nord' | 'dracula' | 'solarized' | 'custom'

export type Language = 'en' | 'es'

/**
 * Flat set of themeable tokens. One registry consumed by:
 *  - CSS custom properties (UI chrome),
 *  - the xterm terminal palette,
 *  - the console grid/header colors.
 */
export type ThemeTokenKey =
  // UI chrome
  | 'bg-primary'
  | 'bg-secondary'
  | 'card'
  | 'border'
  | 'text-primary'
  | 'text-secondary'
  | 'accent'
  | 'accent-2'
  | 'accent-3'
  // terminal core
  | 'term-bg'
  | 'term-fg'
  | 'term-cursor'
  | 'term-selection'
  // ansi 16
  | 'ansi-black'
  | 'ansi-red'
  | 'ansi-green'
  | 'ansi-yellow'
  | 'ansi-blue'
  | 'ansi-magenta'
  | 'ansi-cyan'
  | 'ansi-white'
  | 'ansi-brightBlack'
  | 'ansi-brightRed'
  | 'ansi-brightGreen'
  | 'ansi-brightYellow'
  | 'ansi-brightBlue'
  | 'ansi-brightMagenta'
  | 'ansi-brightCyan'
  | 'ansi-brightWhite'

export type ThemeTokens = Record<ThemeTokenKey, string>

export interface ThemeDefinition {
  name: ThemeName
  /** Human label shown in settings. */
  label: string
  /** True for light-background themes (drives `color-scheme`). */
  light?: boolean
  tokens: ThemeTokens
}

export interface Settings {
  /** Default shell per platform; undefined => resolver picks the OS default. */
  defaultShell: { win32?: string; darwin?: string; linux?: string }
  fontFamily: string
  fontSize: number
  /** Legacy; retained for back-compat with v1 configs. */
  accent: AccentName
  theme: ThemeName
  /** Per-token overrides applied on top of the active theme (used by 'custom'). */
  customColors?: Partial<Record<ThemeTokenKey, string>>
  language: Language
  scrollback: number
  restoreLastWorkspace: boolean
  confirmCloseRunning: boolean
  /** Installed build only: hide to tray on window close instead of quitting. */
  closeToTray: boolean
  /** Installed build only: register the app to launch at system login. */
  launchOnStartup: boolean
  sidebarCollapsed: boolean
}

export interface ConfigFile {
  version: number
  workspaces: Workspace[]
  presets: AgentPreset[]
  settings: Settings
  activeWorkspaceId?: string | null
}
