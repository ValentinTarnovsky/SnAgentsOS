/**
 * Single source of truth for IPC channel names.
 * Convention: `domain:action`. Imported by both main and preload.
 */
export const CH = {
  // App
  APP_INFO: 'app:info',

  // 1.x migration (E0-FR-10, 28, 35). Main computes every path; none comes from the renderer.
  APP_LEGACY_INFO: 'app:legacyInfo', // invoke -> LegacyDataInfo
  APP_LEGACY_ACK: 'app:legacyAck', // send -> noticeSeen = true in the marker
  APP_LEGACY_SHOW_BACKUP: 'app:legacyShowBackup', // send -> reveal migration-backup-v1.zip
  APP_LEGACY_OPEN_LOG: 'app:legacyOpenLog', // send -> open logs/legacy-migration.log
  APP_LEGACY_STATUS: 'app:legacyStatus', // main -> renderer (LegacyDataInfo on every marker change)

  // Crash resilience (E4-FR-19..25). main owns the breaker, the crash records and lastRecovery.
  APP_RELOAD: 'app:reload', // send; manual reload, resets the breaker and drops lastRecovery
  APP_TAKE_RECOVERY: 'app:takeRecovery', // invoke -> RecoveryInfo | null (consumed once)
  APP_REPORT_RENDER_ERROR: 'app:reportRenderError', // send (RenderErrorReport), zod-validated and throttled in main
  APP_DIAGNOSTICS: 'app:diagnostics', // invoke (RendererDiagnostics) -> redacted markdown (<= 64KB)
  // "Open in SnAgentsOS" (E4-FR-32..34). main validates every path; the renderer only matches it.
  APP_OPEN_PATH: 'app:openPath', // main -> renderer (OpenRequest; superset of { path })
  APP_TAKE_PENDING_OPEN: 'app:takePendingOpen', // invoke -> OpenRequest | null (consumes it)
  SYSTEM_SET_EXPLORER_MENU: 'system:setExplorerMenu', // invoke ({ enabled, language }) -> ExplorerMenuResult
  SYSTEM_GET_EXPLORER_MENU: 'system:getExplorerMenu', // invoke -> ExplorerMenuResult

  // PTY lifecycle (renderer -> main)
  PTY_SPAWN: 'pty:spawn', // invoke -> { ptyId }
  PTY_REATTACH: 'pty:reattach', // invoke (paneId) -> { ptyId, replay } | null
  PTY_WRITE: 'pty:write', // send (high frequency)
  PTY_RESIZE: 'pty:resize', // send
  PTY_KILL: 'pty:kill', // invoke
  PTY_SET_ACTIVE: 'pty:setActive', // send (paneIds of the visible workspace)
  PTY_FLOW: 'pty:flow', // send ({ ptyId, pause }) backpressure
  PTY_RESTART: 'pty:restart', // invoke (PtyRestartReq) -> PtyRestartRes (rejects when the spawn fails; E6-FR-18/19)
  // Explicit pty lifecycle (E4-FR-36): kills by paneId, so they work with an empty renderer registry.
  PTY_KILL_PANES: 'pty:killPanes', // invoke (paneIds: string[]) -> number (killed)
  PTY_RECONCILE: 'pty:reconcile', // invoke (livePaneIds: string[]) -> number (killed)
  PTY_SET_ENGINE: 'pty:setEngine', // send (TerminalEngineSettings; E6-FR-06)
  PTY_SUBMIT: 'pty:submit', // invoke (PtySubmitReq) -> PtySubmitRes (E8-FR-02a)
  // Saved scrollback (E6-FR-11/12): the seed itself arrives in PtySpawnRes.
  PTY_SCROLLBACK_LOAD: 'pty:scrollbackLoad', // invoke (paneId) -> string | null (sanitized saved text, not consumed)
  SCROLLBACK_CLEAR: 'scrollback:clear', // invoke (paneId, opts?: { trash?: boolean }) -> void
  SCROLLBACK_CLEAR_ALL: 'scrollback:clearAll', // invoke -> void
  SCROLLBACK_STATS: 'scrollback:stats', // invoke -> ScrollbackStats

  // PTY events (main -> renderer)
  PTY_DATA: 'pty:data', // { ptyId, data }
  PTY_EXIT: 'pty:exit', // { ptyId, exitCode, signal }
  PTY_PROMPT_RESULT: 'pty:promptResult', // PtyPromptResultEvt (E8-FR-02b)

  // Config (single blob: workspaces + presets + settings + layout)
  CONFIG_LOAD: 'config:load', // invoke -> ConfigFile | null
  CONFIG_SAVE: 'config:save', // send (debounced from the renderer)
  CONFIG_EXPORT: 'config:export', // invoke (config) -> boolean (saved)
  CONFIG_IMPORT: 'config:import', // invoke -> ConfigFile | null

  // Dialogs
  DIALOG_OPEN_DIR: 'dialog:openDirectory',
  // Workspace composer folder hint (E8-FR-08).
  FS_DIR_EXISTS: 'fs:dirExists', // invoke (path) -> boolean

  // Clipboard (terminal copy/paste)
  CLIPBOARD_WRITE: 'clipboard:write', // send (text)
  CLIPBOARD_READ: 'clipboard:read', // invoke -> string

  // Window controls (custom frameless title bar)
  WINDOW_MINIMIZE: 'window:minimize', // send
  WINDOW_MAXIMIZE: 'window:maximize', // send (toggles maximize/restore)
  WINDOW_CLOSE: 'window:close', // send
  WINDOW_IS_MAXIMIZED: 'window:isMaximized', // invoke -> boolean
  WINDOW_MAXIMIZE_CHANGED: 'window:maximizeChanged', // main -> renderer (boolean)
  WINDOW_REVEAL: 'window:reveal', // send (restore, show and focus; flash when focus is denied; E2-FR-07)

  // System integration (installed build only)
  SYSTEM_SET_LOGIN_ITEM: 'system:setLoginItem', // invoke (boolean) -> void
  SYSTEM_GET_LOGIN_ITEM: 'system:getLoginItem', // invoke -> boolean

  // Global shortcut to show/focus the app
  SYSTEM_SET_HOTKEY: 'system:setHotkey', // invoke ({enabled, accelerator}) -> boolean success

  // Live resource metrics
  SYSTEM_METRICS: 'system:metrics', // invoke -> AppMetrics

  // Open a URL in the OS default browser (terminal links, About page, etc.)
  SHELL_OPEN_EXTERNAL: 'shell:openExternal', // send (url)
  // A path tapped on the phone: open (inert) or reveal it, contained in cwd (E2-FR-30)
  SHELL_OPEN_PATH: 'shell:openPath', // invoke ({ cwd, path }) -> { ok, error? }

  // GPU/display recovery (main -> renderer). Fired after system resume, screen
  // unlock, or a GPU process crash so terminals rebuild their glyph atlases.
  SYSTEM_DISPLAY_RECOVERED: 'system:displayRecovered',

  // Auto-update (GitHub releases)
  UPDATE_CHECK: 'update:check', // invoke -> UpdateInfo
  UPDATE_INSTALL: 'update:install', // invoke -> { relaunching } (downloads + applies)
  UPDATE_PROGRESS: 'update:progress', // main -> renderer ({ percent, transferred, total })
  UPDATE_GET_STATE: 'update:getState', // invoke -> UpdateState (main owns the phase, E4-FR-37)
  UPDATE_STATE: 'update:state', // main -> renderer (UpdateState on every phase change)

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
  STATUS_SNAPSHOT: 'status:snapshot',
  STATUS_HEALTH: 'status:health',
  STATUS_DISCORD_TEST: 'status:discordTest',
  STATUS_DESKTOP_TEST: 'status:desktopTest',
  STATUS_NTFY_TEST: 'status:ntfyTest', // invoke -> { ok, error? } (saved ntfy config, E2-FR-40)
  STATUS_REVEAL: 'status:reveal', // main -> renderer (paneId; notification clicked)
  STATUS_SESSION_END: 'status:sessionEnd', // main -> renderer (AgentSessionEndEvt; E6-FR-21)
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
  REMOTE_FIREWALL_CHECK: 'remote:firewallCheck', // invoke (force?: boolean) -> FirewallStatus (E2-FR-38)
  REMOTE_FIREWALL_FIX: 'remote:firewallFix', // invoke -> FirewallFixRes (UAC, E2-FR-39)
  REMOTE_OPEN_NETWORK_SETTINGS: 'remote:openNetworkSettings', // send (opens ms-settings:network-status)
  REMOTE_FIT_RELEASE: 'remote:fitRelease', // send ({ paneId } | { all: true }; phone-fit back to the desktop, E3-FR-17/19)
  REMOTE_SECURE_SET: 'remote:secureSet', // invoke (enabled: boolean) -> SecureModeStatus (tailscale serve, E3-FR-42)

  // Keep the PC awake while agents work (E5-FR-23/24). Main decides; the renderer persists.
  POWER_SET_CONFIG: 'power:setConfig', // send (AwakeMode); main answers with power:state
  POWER_STATE: 'power:state', // main -> renderer (PowerState, on every change)
  POWER_GET_STATE: 'power:getState', // invoke -> PowerState

  // Agent behavior settings (settings.agents). awakeDisplay rides here.
  AGENTS_SET_CONFIG: 'agents:setConfig', // send (AgentSettings)

  // Durable agent sessions and resume (E5-FR-05..11). agent-sessions.json is main-owned.
  AGENTS_LIST: 'agents:list', // invoke -> AgentSessionView[]
  AGENTS_STARTUP: 'agents:startup', // invoke -> AgentsStartup (stable for the run)
  AGENTS_CONSUME_STARTUP: 'agents:consumeStartup', // invoke (paneId) -> boolean (true once per run)
  AGENTS_STARTUP_PENDING: 'agents:startupPending', // invoke (paneIds) -> the ones whose startup decision is unspent (peek, E5-FR-12)
  AGENTS_CHANGED: 'agents:changed', // main -> renderer (AgentSessionView | { paneId, removed: true })
  AGENTS_FORGET: 'agents:forget', // send (paneId)
  AGENTS_READY: 'agents:ready', // main -> renderer ({ paneId, sessionId, phase: 'start' | 'idle' })
  // Hibernation (E5-FR-25/26). Main plans and kills; the renderer shows the sleeping overlay and wakes.
  AGENTS_SET_HIBERNATION: 'agents:setHibernation', // send (HibernationConfig { idleMinutes, keep })
  AGENTS_HIBERNATE: 'agents:hibernate', // main -> renderer (AgentsHibernateEvt { paneId, at, idleMinutes })

  // Session history (E3-FR-36..40): Claude transcripts + Codex rollouts indexed by main.
  SESSIONS_LIST: 'sessions:list', // invoke ({ query?, cwd? }) -> SessionSummary[]

  // Review notes (E7-FR-17..21): main owns dataDir()/review-notes.json; the renderer mirrors it per workspace.
  GIT_NOTES_LIST: 'git:notesList', // invoke (workspaceId) -> ReviewNotesListRes { notes, rev }
  GIT_NOTES_UPSERT: 'git:notesUpsert', // invoke (ReviewNoteInput) -> ReviewNote (rejects 'invalid' | 'limit')
  GIT_NOTES_DELETE: 'git:notesDelete', // invoke ({ ids?, workspaceId? }) -> void
  GIT_NOTES_MARK_SENT: 'git:notesMarkSent', // invoke ({ ids, paneId, sentAt }) -> void
  GIT_NOTES_PRUNE: 'git:notesPrune', // send (workspaceIds still in the store)
  GIT_NOTES_CHANGED: 'git:notesChanged', // main -> renderer ({ workspaceId, rev })

  // Git chip (E7-FR-05..10). Names per PLAN D6; a target carries a key (ws:<id> | pane:<id>) besides its cwd.
  GIT_SET_WATCH: 'git:setWatch', // send (GitTarget[])
  GIT_UPDATE: 'git:update', // main -> renderer (GitUpdateEvt { key, cwd, summary, error? }, only on change)
  GIT_INFO: 'git:info', // invoke ({ force? }) -> GitInfoRes
  GIT_SET_CONFIG: 'git:setConfig', // send ({ gitChip: boolean })
  GIT_REFRESH: 'git:refresh', // send ({ keys?: string[], reason?: 'manual' | 'agent' })
  // Changes panel (E7-FR-11..16). Keyed like the targets: main resolves the repo and only serves paths it listed.
  GIT_STATUS: 'git:status', // invoke ({ key }) -> GitChangesRes | null
  GIT_FILE_DIFF: 'git:fileDiff', // invoke ({ key, path, area, force? }) -> GitDiffReply
  GIT_OPEN_FILE: 'git:openFile', // invoke ({ key, path, reveal? }) -> boolean
  GIT_SET_PANEL: 'git:setPanel', // send ({ key: string | null }): the open panel's target, polled every 3 s
  // Worktree per console (E7-FR-27..32, 36). Add/Remove are contract names; Probe, Inspect, List, Reveal are amendments.
  GIT_WORKTREE_ADD: 'git:worktreeAdd', // invoke (WorktreeAddReq) -> WorktreeAddRes
  GIT_WORKTREE_REMOVE: 'git:worktreeRemove', // invoke (WorktreeRemoveReq) -> WorktreeRemoveRes
  GIT_WORKTREE_PROBE: 'git:worktreeProbe', // invoke ({ repoCwd }) -> WorktreeProbeRes
  GIT_WORKTREE_INSPECT: 'git:worktreeInspect', // invoke ({ path, base? }) -> WorktreeInspectRes
  GIT_WORKTREE_LIST: 'git:worktreeList', // invoke () -> WorktreeListRes
  GIT_WORKTREE_REVEAL: 'git:worktreeReveal', // invoke ({ path }) -> boolean (manifest paths only)

  // snaos CLI (E8-FR-12..22). setEnabled is the contract name; state, skill and userPath are amendments.
  // The CLI's renderer ops ride REMOTE_CONTROL_CMD / REMOTE_CONTROL_RESULT (CONTRATOS).
  CLI_SET_ENABLED: 'cli:setEnabled', // send (boolean)
  CLI_STATE: 'cli:state', // invoke -> CliUiState (never a token)
  CLI_SKILL: 'cli:skill', // invoke (SkillOp) -> SkillStatus
  CLI_USER_PATH: 'cli:userPath', // invoke (boolean) -> boolean

  // Per-repo .snagentsos.json (E8-FR-23..27). Trust lives in main's dataDir()/trusted-repos.json; previewExport is an amendment.
  REPO_CONFIG_READ: 'repoConfig:read', // invoke (dir) -> RepoConfigReadRes
  REPO_CONFIG_TRUST: 'repoConfig:trust', // invoke ({ dir, sha256 }) -> RepoConfigTrustRes (main re-hashes the file first)
  REPO_CONFIG_PREVIEW_EXPORT: 'repoConfig:previewExport', // invoke ({ dir, file }) -> RepoConfigPreviewRes
  REPO_CONFIG_EXPORT: 'repoConfig:export', // invoke ({ dir, file, overwrite }) -> RepoConfigExportRes (the written hash is trusted)
} as const

export type ChannelName = (typeof CH)[keyof typeof CH]
