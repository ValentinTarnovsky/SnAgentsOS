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

  // GPU/display recovery (main -> renderer). Fired after system resume, screen
  // unlock, or a GPU process crash so terminals rebuild their glyph atlases.
  SYSTEM_DISPLAY_RECOVERED: 'system:displayRecovered',

  // Auto-update (GitHub releases)
  UPDATE_CHECK: 'update:check', // invoke -> UpdateInfo
  UPDATE_INSTALL: 'update:install', // invoke -> { relaunching } (downloads + applies)
  UPDATE_PROGRESS: 'update:progress', // main -> renderer ({ percent, transferred, total })

  // Live usage / quota bars (Claude OAuth + Codex rollout + custom models)
  USAGE_GET: 'usage:get', // invoke -> UsageSnapshot (cached, kicks a refresh)
  USAGE_REFRESH: 'usage:refresh', // invoke -> UsageSnapshot (force a full refresh)
  USAGE_SET_CONFIG: 'usage:setConfig', // send (renderer pushes the usage settings to main)
  USAGE_UPDATE: 'usage:update', // main -> renderer (UsageSnapshot, pushed on the poll interval)

  // Claude status (per-console state dots, badges, notifications)
  STATUS_TITLE: 'status:title', // send (renderer reports an xterm OSC title change: { paneId, title })
  STATUS_VIEWED: 'status:viewed', // send (paneIds currently in view: active workspace minus minimized)
  STATUS_SET_CONFIG: 'status:setConfig', // send (renderer pushes NotificationSettings to main)
  STATUS_STATE: 'status:state', // main -> renderer (PaneStatusEvt)
  STATUS_REVEAL: 'status:reveal', // main -> renderer (paneId; notification clicked)
  STATUS_HOOKS_INSTALL: 'status:hooksInstall', // invoke -> StatusHooksStatusRes
  STATUS_HOOKS_UNINSTALL: 'status:hooksUninstall', // invoke -> StatusHooksStatusRes
  STATUS_HOOKS_STATUS: 'status:hooksStatus', // invoke -> StatusHooksStatusRes

  // Remote control (embedded LAN/Tailscale server for phone clients)
  REMOTE_SET_CONFIG: 'remote:setConfig', // send (renderer pushes RemoteSettings; main starts/stops/restarts)
  REMOTE_GET_STATE: 'remote:getState', // invoke -> RemoteUiState
  REMOTE_PAIRING_BEGIN: 'remote:pairingBegin', // invoke -> PairingQrPayload | null (server not running)
  REMOTE_PAIRING_CANCEL: 'remote:pairingCancel', // send (QR modal closed; invalidates the active code)
  REMOTE_PAIRING_RESOLVE: 'remote:pairingResolve', // send ({ requestId, allow })
  REMOTE_DEVICE_REVOKE: 'remote:deviceRevoke', // invoke (deviceId) -> void (kills live sessions)
  REMOTE_STATE_PUSH: 'remote:statePush', // send (RemoteStateSnapshot, renderer -> main, debounced)
  REMOTE_CONTROL_CMD: 'remote:controlCmd', // main -> renderer (RemoteCommand)
  REMOTE_CONTROL_RESULT: 'remote:controlResult', // send (RemoteCommandResult, renderer -> main)
  REMOTE_EVENT: 'remote:event', // main -> renderer (RemoteUiState: status/devices/pendingPairing)
} as const

export type ChannelName = (typeof CH)[keyof typeof CH]
