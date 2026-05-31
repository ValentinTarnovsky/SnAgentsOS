/**
 * Core domain model, shared by main and renderer.
 * Must stay free of Node/DOM imports so it is safe in the renderer bundle.
 */

/**
 * Persisted config schema version. Single source of truth for both the main
 * process (schema/migrations) and the renderer (persistence writer).
 */
export const CONFIG_VERSION = 4

export type PaneType = 'shell' | 'claude' | 'codex' | 'custom'

/**
 * One step of a pre-launch sequence (expect/send). The runner sends `send`,
 * optionally waiting for the terminal to print `waitFor` first, this is how a
 * console can auto-answer an interactive prompt (e.g. send a password right
 * after the shell prints "password:").
 */
export interface SetupStep {
  /** Text written to the shell. A CR (Enter) is appended unless `noEnter`. */
  send: string
  /**
   * Wait until the terminal output contains this string before sending.
   * Wrap in slashes for a regex, e.g. "/\\$\\s*$/". Empty = send immediately.
   */
  waitFor?: string
  /** Max ms to wait for `waitFor` before sending anyway. Default 15000. */
  timeoutMs?: number
  /** Fixed pause (ms) applied right before sending (after any `waitFor`). */
  delayMs?: number
  /** Treat `send` as a secret (password): masked in the UI. */
  secret?: boolean
  /** Send `send` literally without appending Enter/CR. */
  noEnter?: boolean
}

/**
 * A reusable pre-launch sequence (e.g. "SSH into the dedi") applied to a
 * console before its model command runs. Defined in Settings, selected when a
 * workspace is created, and applied to every console in that workspace.
 */
export interface ConnectionProfile {
  id: string
  name: string
  steps: SetupStep[]
}

export interface Pane {
  id: string
  type: PaneType
  /** Reference to an AgentPreset; when set, preset fields are merged in. */
  presetId?: string
  /** Overrides the workspace cwd for this pane. */
  cwd?: string
  /** Overrides the resolved shell/command for this pane. */
  command?: string
  /** Per-pane connection profile override (falls back to the workspace's). */
  setupId?: string
  title: string
  color: string
  icon: string
  /** Per-pane terminal font size override (Ctrl +/-/0, Ctrl+wheel). */
  fontSize?: number
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
  /** Connection profile run in every console before its model command. */
  setupId?: string
}

/** A saved, reusable prompt/text snippet inserted into a console (U10). */
export interface Snippet {
  id: string
  name: string
  text: string
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
  /** When true, consoles keep effectively unlimited scrollback (like a normal terminal). */
  infiniteScrollback: boolean
  restoreLastWorkspace: boolean
  confirmCloseRunning: boolean
  /** Installed build only: hide to tray on window close instead of quitting. */
  closeToTray: boolean
  /** Installed build only: register the app to launch at system login. */
  launchOnStartup: boolean
  /** Global OS shortcut to show/focus the app from anywhere. */
  globalHotkeyEnabled: boolean
  /** Electron accelerator string, e.g. "Super+Alt+O". */
  globalHotkey: string
  /** Remapped in-app shortcuts: actionId -> accelerator (overrides defaults). */
  keymap: Record<string, string>
  sidebarCollapsed: boolean
}

export interface ConfigFile {
  version: number
  workspaces: Workspace[]
  presets: AgentPreset[]
  settings: Settings
  activeWorkspaceId?: string | null
  /** Saved prompt snippets (U10). */
  snippets?: Snippet[]
  /** Reusable pre-launch connection sequences (e.g. SSH). */
  connections?: ConnectionProfile[]
}
