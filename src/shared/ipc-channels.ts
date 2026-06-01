/**
 * Single source of truth for IPC channel names.
 * Convention: `domain:action`. Imported by both main and preload.
 */
export const CH = {
  // App
  APP_INFO: 'app:info',

  // PTY lifecycle (renderer -> main)
  PTY_SPAWN: 'pty:spawn', // invoke -> { ptyId }
  PTY_REATTACH: 'pty:reattach', // invoke (paneId) -> { ptyId, replay } | null
  PTY_WRITE: 'pty:write', // send (high frequency)
  PTY_RESIZE: 'pty:resize', // send
  PTY_KILL: 'pty:kill', // invoke
  PTY_SET_ACTIVE: 'pty:setActive', // send (paneIds of the visible workspace)
  PTY_FLOW: 'pty:flow', // send ({ ptyId, pause }) backpressure

  // PTY events (main -> renderer)
  PTY_DATA: 'pty:data', // { ptyId, data }
  PTY_EXIT: 'pty:exit', // { ptyId, exitCode, signal }

  // Config (single blob: workspaces + presets + settings + layout)
  CONFIG_LOAD: 'config:load', // invoke -> ConfigFile | null
  CONFIG_SAVE: 'config:save', // send (debounced from the renderer)
  CONFIG_EXPORT: 'config:export', // invoke (config) -> boolean (saved)
  CONFIG_IMPORT: 'config:import', // invoke -> ConfigFile | null

  // Dialogs
  DIALOG_OPEN_DIR: 'dialog:openDirectory',

  // Clipboard (terminal copy/paste)
  CLIPBOARD_WRITE: 'clipboard:write', // send (text)
  CLIPBOARD_READ: 'clipboard:read', // invoke -> string

  // Window controls (custom frameless title bar)
  WINDOW_MINIMIZE: 'window:minimize', // send
  WINDOW_MAXIMIZE: 'window:maximize', // send (toggles maximize/restore)
  WINDOW_CLOSE: 'window:close', // send
  WINDOW_IS_MAXIMIZED: 'window:isMaximized', // invoke -> boolean
  WINDOW_MAXIMIZE_CHANGED: 'window:maximizeChanged', // main -> renderer (boolean)

  // System integration (installed build only)
  SYSTEM_SET_LOGIN_ITEM: 'system:setLoginItem', // invoke (boolean) -> void
  SYSTEM_GET_LOGIN_ITEM: 'system:getLoginItem', // invoke -> boolean

  // Global shortcut to show/focus the app
  SYSTEM_SET_HOTKEY: 'system:setHotkey', // invoke ({enabled, accelerator}) -> boolean success

  // Live resource metrics
  SYSTEM_METRICS: 'system:metrics', // invoke -> AppMetrics

  // Open a URL in the OS default browser (terminal links, About page, etc.)
  SHELL_OPEN_EXTERNAL: 'shell:openExternal', // send (url)
} as const

export type ChannelName = (typeof CH)[keyof typeof CH]
