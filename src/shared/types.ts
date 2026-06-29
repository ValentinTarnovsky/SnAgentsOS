/**
 * Core domain model, shared by main and renderer.
 * Must stay free of Node/DOM imports so it is safe in the renderer bundle.
 */

/**
 * Persisted config schema version. Single source of truth for both the main
 * process (schema/migrations) and the renderer (persistence writer).
 */
export const CONFIG_VERSION = 5

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

/**
 * A one-shot prompt scheduled to run in a single console at a wall-clock time.
 * The renderer ticker writes `prompt` (then Enter) into the pane once `dueAt`
 * is reached, using the local PC clock, then clears the schedule.
 */
export interface PaneSchedule {
  /** "HH:MM" wall-clock time the user picked (for display/editing). */
  time: string
  /** Prompt text sent into the console (Enter appended) when it fires. */
  prompt: string
  /** Epoch ms of the next occurrence; the ticker fires when Date.now() >= dueAt. */
  dueAt: number
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
  /** One-shot prompt scheduled to run in this console at a set time. */
  schedule?: PaneSchedule
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

/**
 * A user-defined usage row that counts tokens for an arbitrary model by parsing
 * the local transcript JSONL (no live quota %, totals only). The optional
 * `tokenBudget` turns the absolute count into a percent bar.
 */
export interface UsageCustomRow {
  id: string
  /** Display label for the row. */
  label: string
  /** Which transcript store to scan. */
  source: 'claude' | 'codex'
  /** Case-insensitive substring matched against each turn's model id. */
  modelMatch: string
  /** Time window the tokens are summed over. */
  window: 'session5h' | 'weekly7d' | 'today' | 'all'
  /** When set, the row shows used/budget as a percent bar. */
  tokenBudget?: number
  enabled: boolean
}

/** Settings for the live usage bars feature (Claude + Codex + custom). */
export interface UsageSettings {
  /** Master switch for the sidebar widget + polling. */
  enabled: boolean
  /** Poll interval for the Claude OAuth endpoint (ms; clamped >= 30s in main). */
  claudeIntervalMs: number
  /** Poll interval for the local Codex rollout file (ms; clamped >= 3s in main). */
  codexIntervalMs: number
  /** Re-fetch when the app window regains focus. */
  refreshOnFocus: boolean
  /** Show the Anthropic service-status dot. */
  showStatus: boolean
  /** Which built-in quota rows are visible. */
  rows: {
    claude5h: boolean
    claude7d: boolean
    claudeOpus7d: boolean
    claudeSonnet7d: boolean
    codex5h: boolean
    codex7d: boolean
  }
  custom: UsageCustomRow[]
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
  /**
   * Terminal draw engine. 'canvas' (default) has no corruptible GPU glyph
   * atlas, so it cannot show garbled mojibake after a GPU reset (sleep/resume,
   * screen unlock, Windows TDR, GPU-process crash); its worst case is a blank
   * glyph that repaints on the next output. 'webgl' is faster for many busy
   * panes but its context can come back "alive but invalid" with a trashed
   * atlas and NO event to detect it, which is the historical mojibake bug, so
   * it is opt-in only.
   */
  terminalRenderer: 'canvas' | 'webgl'
  restoreLastWorkspace: boolean
  confirmCloseRunning: boolean
  /** Installed build only: hide to tray on window close instead of quitting. */
  closeToTray: boolean
  /** Installed build only: register the app to launch at system login. */
  launchOnStartup: boolean
  /** Check GitHub for a newer release on startup and offer to install it. */
  autoCheckUpdates: boolean
  /** Global OS shortcut to show/focus the app from anywhere. */
  globalHotkeyEnabled: boolean
  /** Electron accelerator string, e.g. "Super+Alt+O". */
  globalHotkey: string
  /** Remapped in-app shortcuts: actionId -> accelerator (overrides defaults). */
  keymap: Record<string, string>
  sidebarCollapsed: boolean
  /** Live usage / quota bars (Claude + Codex + custom models). */
  usage: UsageSettings
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
