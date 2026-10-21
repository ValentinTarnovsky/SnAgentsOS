import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { CH } from '@shared/ipc-channels'
import type {
  AppInfo,
  AppMetrics,
  ExplorerMenuResult,
  LegacyDataInfo,
  OpenRequest,
  PairingQrPayload,
  PowerState,
  PtyDataEvt,
  PtyExitEvt,
  PtyFlowReq,
  PtyReattachRes,
  PtyResizeReq,
  PtyRestartReq,
  PtyRestartRes,
  PtyPromptResultEvt,
  PtySpawnReq,
  PtySpawnRes,
  PtySubmitReq,
  StatusTuneHintReq,
  PtySubmitRes,
  PtyWriteReq,
  RecoveryInfo,
  RemoteCommand,
  RemoteCommandResult,
  RemoteFitReleaseReq,
  RemoteUiState,
  SecureModeStatus,
  FirewallFixRes,
  FirewallStatus,
  RenderErrorReport,
  RendererDiagnostics,
  SnApi,
  ScrollbackStats,
  TerminalEngineSettings,
  UpdateInfo,
  UpdateProgress,
  UpdateState,
  UpdateNotApplied,
  UsageSnapshot,
} from '@shared/ipc-contract'
import type {
  AgentSessionEndEvt,
  AgentSettings,
  AwakeMode,
  ClaudeAccountsSettings,
  ConfigFile,
  Language,
  NotificationSettings,
  PaneStatusEvt,
  RemoteSettings,
  StatusHooksStatusRes,
  UsageSettings,
} from '@shared/types'
import type { RemoteStateSnapshot } from '@shared/remote-protocol'
import type { AccountsCaptureReq, AccountsOpRes, ClaudeAccountsEvent, ClaudeAccountsState, RendererSwitchReason } from '@shared/claude-accounts'
import type { AgentSessionView, AgentsChangedEvt, AgentsReadyEvt, AgentsStartup } from '@shared/agents'
import type { AgentsHibernateEvt, HibernationConfig } from '@shared/hibernation'
import type { SessionSummary, SessionsListReq } from '@shared/session-history'
import type { GitArea, GitBaseStat, GitChangesRes, GitDiffReply, GitInfoRes, GitTarget, GitUpdateEvt } from '@shared/git-types'
import type { ReviewNote, ReviewNoteInput, ReviewNotesChangedEvt, ReviewNotesDeleteReq, ReviewNotesListRes, ReviewNotesMarkSentReq } from '@shared/review-notes'
import type { WsNoteCreateReq, WsNoteDoc, WsNoteMeta, WsNoteReadReq, WsNoteResult, WsNoteWriteReq, WsNotesChangedEvt, WsNotesListRes } from '@shared/ws-notes'
import type { FileCreateReq, FileReadRes, FileRenameReq, FileWriteReq, FileWriteRes, FilesChangedEvt, FilesListReq, FilesListRes, FilesOpRes, FilesRootRes } from '@shared/files'
import type { WorktreeAddReq, WorktreeAddRes, WorktreeInspectRes, WorktreeListRes, WorktreeProbeRes, WorktreeRemoveReq, WorktreeRemoveRes } from '@shared/worktree-types'
import type { OpenPathReq, OpenPathRes } from '@shared/inertOpen'
import type { CliUiState, SkillOp, SkillStatus, SkillTarget } from '@shared/ctl-protocol'
import type { RepoConfigExportRes, RepoConfigFile, RepoConfigPreviewRes, RepoConfigReadRes, RepoConfigTrustRes } from '@shared/repo-config'
import type { DictationEvt, DictationStartReq, DictationStartRes } from '@shared/ipc-contract'
import type { ShareGuestApi } from '@shared/ipc-contract'
import type {
  ShareCreateReq,
  ShareCreateRes,
  ShareHostApi,
  ShareHostConfig,
  ShareHostPaneGuests,
  ShareHostState,
  ShareInviteRes,
  ShareOpRes,
  ShareResolveReq,
  ShareUpdateReq,
} from '@shared/ipc-contract'
import type { SharePerm } from '@shared/types'
import type {
  ShareChatEvt,
  ShareChatReq,
  ShareFlowReq,
  ShareGuestCtlReq,
  ShareGuestCtlRes,
  ShareGuestGitReq,
  ShareGuestGitRes,
  ShareGuestInputReq,
  ShareGuestNotesReq,
  ShareGuestNotesRes,
  ShareJoinRes,
  ShareLinkEvt,
  ShareLinksRes,
  SharePasswordReq,
  SharePasswordRes,
  SharePreviewRes,
  ShareStreamEvt,
} from '@shared/share-guest'

/** Subscribe to a main->renderer channel, returning an unsubscribe fn. */
function sub<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

/** snApi.share.host (app 2.4.0, item 8): this PC's shares; ids only, main resolves every scope. */
const shareHostApi: ShareHostApi = {
  state: () => ipcRenderer.invoke(CH.SHARE_HOST_STATE) as Promise<ShareHostState>,
  onEvent: (cb: (s: ShareHostState) => void) => sub<ShareHostState>(CH.SHARE_HOST_EVENT, cb),
  create: (req: ShareCreateReq) => ipcRenderer.invoke(CH.SHARE_CREATE, req) as Promise<ShareCreateRes>,
  invite: (grantId: string) => ipcRenderer.invoke(CH.SHARE_INVITE, grantId) as Promise<ShareInviteRes>,
  rotate: (grantId: string) => ipcRenderer.invoke(CH.SHARE_ROTATE, grantId) as Promise<ShareInviteRes>,
  update: (req: ShareUpdateReq) => ipcRenderer.invoke(CH.SHARE_UPDATE, req) as Promise<ShareOpRes>,
  setPassword: (grantId: string, password: string | null) => ipcRenderer.invoke(CH.SHARE_SET_PASSWORD, { grantId, password }) as Promise<ShareOpRes>,
  revoke: (grantId: string) => ipcRenderer.invoke(CH.SHARE_REVOKE, grantId) as Promise<ShareOpRes>,
  kick: (sessionId: string) => ipcRenderer.invoke(CH.SHARE_KICK, sessionId) as Promise<ShareOpRes>,
  sessionPerm: (sessionId: string, perm: SharePerm) => ipcRenderer.invoke(CH.SHARE_SESSION_PERM, { sessionId, perm }) as Promise<ShareOpRes>,
  pauseAll: (on: boolean) => ipcRenderer.invoke(CH.SHARE_PAUSE_ALL, on === true) as Promise<ShareOpRes>,
  resolve: (req: ShareResolveReq) => ipcRenderer.send(CH.SHARE_RESOLVE, req),
  onPanes: (cb: (panes: ShareHostPaneGuests[]) => void) => sub<ShareHostPaneGuests[]>(CH.SHARE_PANES, cb),
  setConfig: (cfg: ShareHostConfig) => ipcRenderer.send(CH.SHARE_SET_CONFIG, cfg),
  firewallCheck: (force?: boolean) => ipcRenderer.invoke(CH.SHARE_FIREWALL_CHECK, force === true) as Promise<FirewallStatus>,
  firewallFix: () => ipcRenderer.invoke(CH.SHARE_FIREWALL_FIX) as Promise<FirewallFixRes>,
}

/** snApi.share.guest (app 2.4.0, item 8): the shares this PC joined; main validates every argument. */
const shareGuestApi: ShareGuestApi = {
  preview: (invite: string) => ipcRenderer.invoke(CH.SHARE_PREVIEW, invite) as Promise<SharePreviewRes>,
  join: (invite: string) => ipcRenderer.invoke(CH.SHARE_JOIN, invite) as Promise<ShareJoinRes>,
  links: () => ipcRenderer.invoke(CH.SHARE_LINKS) as Promise<ShareLinksRes>,
  connect: (linkId: string) => ipcRenderer.invoke(CH.SHARE_CONNECT, linkId) as Promise<boolean>,
  disconnect: (linkId: string) => ipcRenderer.invoke(CH.SHARE_DISCONNECT, linkId) as Promise<boolean>,
  forget: (linkId: string) => ipcRenderer.invoke(CH.SHARE_FORGET, linkId) as Promise<boolean>,
  password: (req: SharePasswordReq) => ipcRenderer.invoke(CH.SHARE_PASSWORD, req) as Promise<SharePasswordRes>,
  ctl: (req: ShareGuestCtlReq) => ipcRenderer.invoke(CH.SHARE_CTL, req) as Promise<ShareGuestCtlRes>,
  git: (req: ShareGuestGitReq) => ipcRenderer.invoke(CH.SHARE_GIT, req) as Promise<ShareGuestGitRes>,
  notes: (req: ShareGuestNotesReq) => ipcRenderer.invoke(CH.SHARE_NOTES, req) as Promise<ShareGuestNotesRes>,
  sub: (linkId: string, paneId: string) => ipcRenderer.send(CH.SHARE_SUB, { linkId, paneId }),
  unsub: (linkId: string, paneId: string) => ipcRenderer.send(CH.SHARE_UNSUB, { linkId, paneId }),
  input: (req: ShareGuestInputReq) => ipcRenderer.send(CH.SHARE_INPUT, req),
  flow: (req: ShareFlowReq) => ipcRenderer.send(CH.SHARE_FLOW, req),
  chat: (req: ShareChatReq) => ipcRenderer.send(CH.SHARE_CHAT, req),
  onLinkEvent: (cb: (e: ShareLinkEvt) => void) => sub<ShareLinkEvt>(CH.SHARE_LINK_EVENT, cb),
  onStream: (cb: (e: ShareStreamEvt) => void) => sub<ShareStreamEvt>(CH.SHARE_STREAM, cb),
  onChatEvent: (cb: (e: ShareChatEvt) => void) => sub<ShareChatEvt>(CH.SHARE_CHAT_EVENT, cb),
}

const api: SnApi = {
  platform: process.platform,
  filePath: (file: unknown) =>
    webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0]),
  app: {
    info: () => ipcRenderer.invoke(CH.APP_INFO) as Promise<AppInfo>,
    legacyInfo: () => ipcRenderer.invoke(CH.APP_LEGACY_INFO) as Promise<LegacyDataInfo>,
    legacyAck: () => ipcRenderer.send(CH.APP_LEGACY_ACK),
    legacyShowBackup: () => ipcRenderer.send(CH.APP_LEGACY_SHOW_BACKUP),
    legacyOpenLog: () => ipcRenderer.send(CH.APP_LEGACY_OPEN_LOG),
    onLegacyStatus: (cb: (info: LegacyDataInfo) => void) => sub<LegacyDataInfo>(CH.APP_LEGACY_STATUS, cb),
    reload: () => ipcRenderer.send(CH.APP_RELOAD),
    takeRecovery: () => ipcRenderer.invoke(CH.APP_TAKE_RECOVERY) as Promise<RecoveryInfo | null>,
    reportRenderError: (report: RenderErrorReport) => ipcRenderer.send(CH.APP_REPORT_RENDER_ERROR, report),
    diagnostics: (renderer: RendererDiagnostics) => ipcRenderer.invoke(CH.APP_DIAGNOSTICS, renderer) as Promise<string>,
    takePendingOpen: () => ipcRenderer.invoke(CH.APP_TAKE_PENDING_OPEN) as Promise<OpenRequest | null>,
    onOpenPath: (cb: (req: OpenRequest) => void) => sub<OpenRequest>(CH.APP_OPEN_PATH, cb),
  },
  pty: {
    spawn: (req: PtySpawnReq) => ipcRenderer.invoke(CH.PTY_SPAWN, req) as Promise<PtySpawnRes>,
    reattach: (paneId: string) =>
      ipcRenderer.invoke(CH.PTY_REATTACH, paneId) as Promise<PtyReattachRes | null>,
    write: (req: PtyWriteReq) => ipcRenderer.send(CH.PTY_WRITE, req),
    resize: (req: PtyResizeReq) => ipcRenderer.send(CH.PTY_RESIZE, req),
    kill: (ptyId: string) => ipcRenderer.invoke(CH.PTY_KILL, ptyId) as Promise<void>,
    setActive: (paneIds: string[]) => ipcRenderer.send(CH.PTY_SET_ACTIVE, paneIds),
    flow: (req: PtyFlowReq) => ipcRenderer.send(CH.PTY_FLOW, req),
    onData: (cb: (e: PtyDataEvt) => void) => sub<PtyDataEvt>(CH.PTY_DATA, cb),
    onExit: (cb: (e: PtyExitEvt) => void) => sub<PtyExitEvt>(CH.PTY_EXIT, cb),
    restart: (req: PtyRestartReq) => ipcRenderer.invoke(CH.PTY_RESTART, req) as Promise<PtyRestartRes>,
    killPanes: (paneIds: string[]) => ipcRenderer.invoke(CH.PTY_KILL_PANES, paneIds) as Promise<number>,
    reconcile: (livePaneIds: string[]) => ipcRenderer.invoke(CH.PTY_RECONCILE, livePaneIds) as Promise<number>,
    setEngine: (settings: TerminalEngineSettings) => ipcRenderer.send(CH.PTY_SET_ENGINE, settings),
    submit: (req: PtySubmitReq) => ipcRenderer.invoke(CH.PTY_SUBMIT, req) as Promise<PtySubmitRes>,
    onPromptResult: (cb: (e: PtyPromptResultEvt) => void) => sub<PtyPromptResultEvt>(CH.PTY_PROMPT_RESULT, cb),
  },
  scrollback: {
    clear: (paneId: string, opts?: { trash?: boolean }) => ipcRenderer.invoke(CH.SCROLLBACK_CLEAR, paneId, opts) as Promise<void>,
    clearAll: () => ipcRenderer.invoke(CH.SCROLLBACK_CLEAR_ALL) as Promise<void>,
    stats: () => ipcRenderer.invoke(CH.SCROLLBACK_STATS) as Promise<ScrollbackStats>,
    load: (paneId: string) => ipcRenderer.invoke(CH.PTY_SCROLLBACK_LOAD, paneId) as Promise<string | null>,
  },
  dialog: {
    openDirectory: () => ipcRenderer.invoke(CH.DIALOG_OPEN_DIR) as Promise<string | null>,
  },
  fs: {
    dirExists: (path: string) => ipcRenderer.invoke(CH.FS_DIR_EXISTS, path) as Promise<boolean>,
  },
  repoConfig: {
    read: (dir: string) => ipcRenderer.invoke(CH.REPO_CONFIG_READ, dir) as Promise<RepoConfigReadRes>,
    trust: (req: { dir: string; sha256: string }) => ipcRenderer.invoke(CH.REPO_CONFIG_TRUST, req) as Promise<RepoConfigTrustRes>,
    previewExport: (req: { dir: string; file: RepoConfigFile }) => ipcRenderer.invoke(CH.REPO_CONFIG_PREVIEW_EXPORT, req) as Promise<RepoConfigPreviewRes>,
    export: (req: { dir: string; file: RepoConfigFile; overwrite: boolean }) => ipcRenderer.invoke(CH.REPO_CONFIG_EXPORT, req) as Promise<RepoConfigExportRes>,
  },
  clipboard: {
    writeText: (text: string) => ipcRenderer.send(CH.CLIPBOARD_WRITE, text),
    readText: () => ipcRenderer.invoke(CH.CLIPBOARD_READ) as Promise<string>,
  },
  config: {
    load: () => ipcRenderer.invoke(CH.CONFIG_LOAD) as Promise<ConfigFile | null>,
    save: (config: ConfigFile) => ipcRenderer.send(CH.CONFIG_SAVE, config),
    export: (config: ConfigFile) => ipcRenderer.invoke(CH.CONFIG_EXPORT, config) as Promise<boolean>,
    import: () => ipcRenderer.invoke(CH.CONFIG_IMPORT) as Promise<ConfigFile | null>,
  },
  window: {
    minimize: () => ipcRenderer.send(CH.WINDOW_MINIMIZE),
    maximize: () => ipcRenderer.send(CH.WINDOW_MAXIMIZE),
    close: () => ipcRenderer.send(CH.WINDOW_CLOSE),
    isMaximized: () => ipcRenderer.invoke(CH.WINDOW_IS_MAXIMIZED) as Promise<boolean>,
    onMaximizeChange: (cb: (maximized: boolean) => void) =>
      sub<boolean>(CH.WINDOW_MAXIMIZE_CHANGED, cb),
    reveal: () => ipcRenderer.send(CH.WINDOW_REVEAL),
  },
  system: {
    setLoginItem: (enabled: boolean) =>
      ipcRenderer.invoke(CH.SYSTEM_SET_LOGIN_ITEM, enabled) as Promise<void>,
    getLoginItem: () => ipcRenderer.invoke(CH.SYSTEM_GET_LOGIN_ITEM) as Promise<boolean>,
    setGlobalHotkey: (enabled: boolean, accelerator: string) =>
      ipcRenderer.invoke(CH.SYSTEM_SET_HOTKEY, { enabled, accelerator }) as Promise<boolean>,
    getMetrics: () => ipcRenderer.invoke(CH.SYSTEM_METRICS) as Promise<AppMetrics>,
    openExternal: (url: string) => ipcRenderer.send(CH.SHELL_OPEN_EXTERNAL, url),
    openPath: (req: OpenPathReq) => ipcRenderer.invoke(CH.SHELL_OPEN_PATH, req) as Promise<OpenPathRes>,
    onDisplayRecovered: (cb: () => void) => sub<void>(CH.SYSTEM_DISPLAY_RECOVERED, cb),
    setExplorerMenu: (req: { enabled: boolean; language: Language }) =>
      ipcRenderer.invoke(CH.SYSTEM_SET_EXPLORER_MENU, req) as Promise<ExplorerMenuResult>,
    getExplorerMenu: () => ipcRenderer.invoke(CH.SYSTEM_GET_EXPLORER_MENU) as Promise<ExplorerMenuResult>,
  },
  updates: {
    check: () => ipcRenderer.invoke(CH.UPDATE_CHECK) as Promise<UpdateInfo>,
    downloadAndInstall: () =>
      ipcRenderer.invoke(CH.UPDATE_INSTALL) as Promise<{ relaunching: boolean }>,
    onProgress: (cb: (p: UpdateProgress) => void) => sub<UpdateProgress>(CH.UPDATE_PROGRESS, cb),
    getState: () => ipcRenderer.invoke(CH.UPDATE_GET_STATE) as Promise<UpdateState>,
    onState: (cb: (s: UpdateState) => void) => sub<UpdateState>(CH.UPDATE_STATE, cb),
    takeNotApplied: () => ipcRenderer.invoke(CH.UPDATE_NOT_APPLIED) as Promise<UpdateNotApplied | null>,
  },
  usage: {
    get: () => ipcRenderer.invoke(CH.USAGE_GET) as Promise<UsageSnapshot>,
    refresh: () => ipcRenderer.invoke(CH.USAGE_REFRESH) as Promise<UsageSnapshot>,
    setConfig: (cfg: UsageSettings) => ipcRenderer.send(CH.USAGE_SET_CONFIG, cfg),
    onUpdate: (cb: (s: UsageSnapshot) => void) => sub<UsageSnapshot>(CH.USAGE_UPDATE, cb),
  },
  accounts: {
    getState: () => ipcRenderer.invoke(CH.ACCOUNTS_GET_STATE) as Promise<ClaudeAccountsState>,
    capture: (req: AccountsCaptureReq) => ipcRenderer.invoke(CH.ACCOUNTS_CAPTURE, req) as Promise<AccountsOpRes>,
    switchTo: (target: string, reason: RendererSwitchReason) =>
      ipcRenderer.invoke(CH.ACCOUNTS_SWITCH, { target, reason }) as Promise<AccountsOpRes>,
    remove: (id: string) => ipcRenderer.invoke(CH.ACCOUNTS_REMOVE, { id }) as Promise<AccountsOpRes>,
    rename: (id: string, label: string) => ipcRenderer.invoke(CH.ACCOUNTS_RENAME, { id, label }) as Promise<AccountsOpRes>,
    setPrimary: (id: string) => ipcRenderer.invoke(CH.ACCOUNTS_SET_PRIMARY, { id }) as Promise<AccountsOpRes>,
    reorder: (ids: string[]) => ipcRenderer.invoke(CH.ACCOUNTS_REORDER, { ids }) as Promise<AccountsOpRes>,
    resumeAuto: () => ipcRenderer.invoke(CH.ACCOUNTS_RESUME_AUTO) as Promise<AccountsOpRes>,
    setConfig: (cfg: ClaudeAccountsSettings) => ipcRenderer.send(CH.ACCOUNTS_SET_CONFIG, cfg),
    onChanged: (cb: (s: ClaudeAccountsState) => void) => sub<ClaudeAccountsState>(CH.ACCOUNTS_CHANGED, cb),
    onEvent: (cb: (e: ClaudeAccountsEvent) => void) => sub<ClaudeAccountsEvent>(CH.ACCOUNTS_EVENT, cb),
  },
  status: {
    reportTitle: (paneId: string, title: string) =>
      ipcRenderer.send(CH.STATUS_TITLE, { paneId, title }),
    setViewed: (paneIds: string[]) => ipcRenderer.send(CH.STATUS_VIEWED, paneIds),
    tuneHint: (req: StatusTuneHintReq) => ipcRenderer.send(CH.STATUS_TUNE_HINT, req),
    setConfig: (cfg: NotificationSettings) => ipcRenderer.send(CH.STATUS_SET_CONFIG, cfg),
    onState: (cb: (e: PaneStatusEvt) => void) => sub<PaneStatusEvt>(CH.STATUS_STATE, cb),
    snapshot: () => ipcRenderer.invoke(CH.STATUS_SNAPSHOT),
    health: () => ipcRenderer.invoke(CH.STATUS_HEALTH),
    testDiscord: (cfg: import('@shared/types').DiscordSettings) => ipcRenderer.invoke(CH.STATUS_DISCORD_TEST, cfg),
    testDesktop: () => ipcRenderer.invoke(CH.STATUS_DESKTOP_TEST),
    testNtfy: () => ipcRenderer.invoke(CH.STATUS_NTFY_TEST) as Promise<{ ok: boolean; error?: string }>,
    onReveal: (cb: (paneId: string) => void) => sub<string>(CH.STATUS_REVEAL, cb),
    onSessionEnd: (cb: (e: AgentSessionEndEvt) => void) => sub<AgentSessionEndEvt>(CH.STATUS_SESSION_END, cb),
    onAgentRename: (cb: (e: import('@shared/types').AgentRenameEvt) => void) => sub<import('@shared/types').AgentRenameEvt>(CH.STATUS_AGENT_RENAME, cb),
    hooksInstall: (cfg: NotificationSettings) =>
      ipcRenderer.invoke(CH.STATUS_HOOKS_INSTALL, cfg) as Promise<StatusHooksStatusRes>,
    hooksUninstall: () =>
      ipcRenderer.invoke(CH.STATUS_HOOKS_UNINSTALL) as Promise<StatusHooksStatusRes>,
    hooksStatus: () => ipcRenderer.invoke(CH.STATUS_HOOKS_STATUS) as Promise<StatusHooksStatusRes>,
  },
  remote: {
    setConfig: (cfg: RemoteSettings) => ipcRenderer.send(CH.REMOTE_SET_CONFIG, cfg),
    getState: () => ipcRenderer.invoke(CH.REMOTE_GET_STATE) as Promise<RemoteUiState>,
    pairingBegin: () =>
      ipcRenderer.invoke(CH.REMOTE_PAIRING_BEGIN) as Promise<PairingQrPayload | null>,
    pairingCancel: () => ipcRenderer.send(CH.REMOTE_PAIRING_CANCEL),
    pairingResolve: (requestId: string, allow: boolean) =>
      ipcRenderer.send(CH.REMOTE_PAIRING_RESOLVE, { requestId, allow }),
    revokeDevice: (deviceId: string) =>
      ipcRenderer.invoke(CH.REMOTE_DEVICE_REVOKE, deviceId) as Promise<void>,
    pushState: (snapshot: RemoteStateSnapshot) => ipcRenderer.send(CH.REMOTE_STATE_PUSH, snapshot),
    onCommand: (cb: (cmd: RemoteCommand) => void) => sub<RemoteCommand>(CH.REMOTE_CONTROL_CMD, cb),
    commandResult: (res: RemoteCommandResult) => ipcRenderer.send(CH.REMOTE_CONTROL_RESULT, res),
    onEvent: (cb: (s: RemoteUiState) => void) => sub<RemoteUiState>(CH.REMOTE_EVENT, cb),
    firewallCheck: (force?: boolean) =>
      ipcRenderer.invoke(CH.REMOTE_FIREWALL_CHECK, force === true) as Promise<FirewallStatus>,
    firewallFix: () => ipcRenderer.invoke(CH.REMOTE_FIREWALL_FIX) as Promise<FirewallFixRes>,
    openNetworkSettings: () => ipcRenderer.send(CH.REMOTE_OPEN_NETWORK_SETTINGS),
    fitRelease: (req: RemoteFitReleaseReq) => ipcRenderer.send(CH.REMOTE_FIT_RELEASE, req),
    secureSet: (enabled: boolean) => ipcRenderer.invoke(CH.REMOTE_SECURE_SET, enabled === true) as Promise<SecureModeStatus>,
  },
  power: {
    setConfig: (mode: AwakeMode) => ipcRenderer.send(CH.POWER_SET_CONFIG, mode),
    getState: () => ipcRenderer.invoke(CH.POWER_GET_STATE) as Promise<PowerState>,
    onState: (cb: (s: PowerState) => void) => sub<PowerState>(CH.POWER_STATE, cb),
  },
  dictation: {
    start: (req: DictationStartReq) => ipcRenderer.invoke(CH.DICTATION_START, req) as Promise<DictationStartRes>,
    stop: (sessionId: string) => ipcRenderer.invoke(CH.DICTATION_STOP, sessionId) as Promise<void>,
    onEvent: (cb: (e: DictationEvt) => void) => sub<DictationEvt>(CH.DICTATION_EVENT, cb),
    openSettings: (page: 'speech' | 'microphone') => ipcRenderer.invoke(CH.DICTATION_OPEN_SETTINGS, page) as Promise<boolean>,
  },
  agents: {
    setConfig: (cfg: AgentSettings) => ipcRenderer.send(CH.AGENTS_SET_CONFIG, cfg),
    list: () => ipcRenderer.invoke(CH.AGENTS_LIST) as Promise<AgentSessionView[]>,
    startup: () => ipcRenderer.invoke(CH.AGENTS_STARTUP) as Promise<AgentsStartup>,
    consumeStartup: (paneId: string) => ipcRenderer.invoke(CH.AGENTS_CONSUME_STARTUP, paneId) as Promise<boolean>,
    startupPending: (paneIds: string[]) => ipcRenderer.invoke(CH.AGENTS_STARTUP_PENDING, paneIds) as Promise<string[]>,
    forget: (paneId: string) => ipcRenderer.send(CH.AGENTS_FORGET, paneId),
    onChanged: (cb: (e: AgentsChangedEvt) => void) => sub<AgentsChangedEvt>(CH.AGENTS_CHANGED, cb),
    onReady: (cb: (e: AgentsReadyEvt) => void) => sub<AgentsReadyEvt>(CH.AGENTS_READY, cb),
    setHibernation: (cfg: HibernationConfig) => ipcRenderer.send(CH.AGENTS_SET_HIBERNATION, cfg),
    onHibernate: (cb: (e: AgentsHibernateEvt) => void) => sub<AgentsHibernateEvt>(CH.AGENTS_HIBERNATE, cb),
  },
  sessions: {
    list: (req?: SessionsListReq) => ipcRenderer.invoke(CH.SESSIONS_LIST, req ?? {}) as Promise<SessionSummary[]>,
  },
  cli: {
    setEnabled: (enabled: boolean) => ipcRenderer.send(CH.CLI_SET_ENABLED, enabled === true),
    state: () => ipcRenderer.invoke(CH.CLI_STATE) as Promise<CliUiState>,
    skill: (op: SkillOp, target?: SkillTarget) => ipcRenderer.invoke(CH.CLI_SKILL, { op, target: target ?? 'claude' }) as Promise<SkillStatus>,
    userPath: (enabled: boolean) => ipcRenderer.invoke(CH.CLI_USER_PATH, enabled === true) as Promise<boolean>,
  },
  reviewNotes: {
    list: (workspaceId: string) => ipcRenderer.invoke(CH.GIT_NOTES_LIST, workspaceId) as Promise<ReviewNotesListRes>,
    upsert: (note: ReviewNoteInput) => ipcRenderer.invoke(CH.GIT_NOTES_UPSERT, note) as Promise<ReviewNote>,
    delete: (req: ReviewNotesDeleteReq) => ipcRenderer.invoke(CH.GIT_NOTES_DELETE, req) as Promise<void>,
    markSent: (req: ReviewNotesMarkSentReq) => ipcRenderer.invoke(CH.GIT_NOTES_MARK_SENT, req) as Promise<void>,
    prune: (workspaceIds: string[]) => ipcRenderer.send(CH.GIT_NOTES_PRUNE, workspaceIds),
    onChanged: (cb: (e: ReviewNotesChangedEvt) => void) => sub<ReviewNotesChangedEvt>(CH.GIT_NOTES_CHANGED, cb),
  },
  wsNotes: {
    list: (workspaceId: string) => ipcRenderer.invoke(CH.WS_NOTES_LIST, workspaceId) as Promise<WsNotesListRes>,
    read: (req: WsNoteReadReq) => ipcRenderer.invoke(CH.WS_NOTES_READ, req) as Promise<WsNoteResult<{ note: WsNoteDoc }>>,
    write: (req: WsNoteWriteReq) => ipcRenderer.invoke(CH.WS_NOTES_WRITE, req) as Promise<WsNoteResult<{ note: WsNoteMeta }>>,
    create: (req: WsNoteCreateReq) => ipcRenderer.invoke(CH.WS_NOTES_CREATE, req) as Promise<WsNoteResult<{ note: WsNoteMeta }>>,
    delete: (req: WsNoteReadReq) => ipcRenderer.invoke(CH.WS_NOTES_DELETE, req) as Promise<WsNoteResult<Record<never, never>>>,
    open: (req: WsNoteReadReq) => ipcRenderer.invoke(CH.WS_NOTES_OPEN, req) as Promise<boolean>,
    prune: (workspaceIds: string[]) => ipcRenderer.send(CH.WS_NOTES_PRUNE, workspaceIds),
    onChanged: (cb: (e: WsNotesChangedEvt) => void) => sub<WsNotesChangedEvt>(CH.WS_NOTES_CHANGED, cb),
  },
  files: {
    root: (workspaceId: string) => ipcRenderer.invoke(CH.FILES_ROOT, workspaceId) as Promise<FilesRootRes>,
    list: (req: FilesListReq) => ipcRenderer.invoke(CH.FILES_LIST, req) as Promise<FilesListRes>,
    read: (req: { workspaceId: string; rel: string }) => ipcRenderer.invoke(CH.FILES_READ, req) as Promise<FileReadRes>,
    write: (req: FileWriteReq) => ipcRenderer.invoke(CH.FILES_WRITE, req) as Promise<FileWriteRes>,
    create: (req: FileCreateReq) => ipcRenderer.invoke(CH.FILES_CREATE, req) as Promise<FilesOpRes>,
    rename: (req: FileRenameReq) => ipcRenderer.invoke(CH.FILES_RENAME, req) as Promise<FilesOpRes>,
    trash: (req: { workspaceId: string; rel: string }) => ipcRenderer.invoke(CH.FILES_TRASH, req) as Promise<FilesOpRes>,
    reveal: (req: { workspaceId: string; rel: string }) => ipcRenderer.invoke(CH.FILES_REVEAL, req) as Promise<FilesOpRes>,
    open: (req: { workspaceId: string; rel: string }) => ipcRenderer.invoke(CH.FILES_OPEN, req) as Promise<FilesOpRes>,
    watch: (workspaceId: string | null) => ipcRenderer.send(CH.FILES_WATCH, workspaceId),
    onChanged: (cb: (e: FilesChangedEvt) => void) => sub<FilesChangedEvt>(CH.FILES_CHANGED, cb),
  },
  git: {
    setWatch: (targets: GitTarget[]) => ipcRenderer.send(CH.GIT_SET_WATCH, targets),
    setConfig: (cfg: { gitChip: boolean }) => ipcRenderer.send(CH.GIT_SET_CONFIG, cfg),
    refresh: (req?: { keys?: string[]; reason?: 'manual' | 'agent' }) => ipcRenderer.send(CH.GIT_REFRESH, req ?? {}),
    info: (force?: boolean) => ipcRenderer.invoke(CH.GIT_INFO, { force: force === true }) as Promise<GitInfoRes>,
    onUpdate: (cb: (e: GitUpdateEvt) => void) => sub<GitUpdateEvt>(CH.GIT_UPDATE, cb),
    setPanel: (key: string | null) => ipcRenderer.send(CH.GIT_SET_PANEL, { key }),
    status: (key: string, base?: string) => ipcRenderer.invoke(CH.GIT_STATUS, base ? { key, base } : { key }) as Promise<GitChangesRes | null>,
    fileDiff: (req: { key: string; path: string; area: GitArea; force?: boolean; base?: string }) => ipcRenderer.invoke(CH.GIT_FILE_DIFF, req) as Promise<GitDiffReply>,
    openFile: (req: { key: string; path: string; reveal?: boolean; base?: string }) => ipcRenderer.invoke(CH.GIT_OPEN_FILE, req) as Promise<boolean>,
    baseStat: (req: { key: string; base: string }) => ipcRenderer.invoke(CH.GIT_BASE_STAT, req) as Promise<GitBaseStat | null>,
    worktreeAdd: (req: WorktreeAddReq) => ipcRenderer.invoke(CH.GIT_WORKTREE_ADD, req) as Promise<WorktreeAddRes>,
    worktreeRemove: (req: WorktreeRemoveReq) => ipcRenderer.invoke(CH.GIT_WORKTREE_REMOVE, req) as Promise<WorktreeRemoveRes>,
    worktreeProbe: (repoCwd: string) => ipcRenderer.invoke(CH.GIT_WORKTREE_PROBE, { repoCwd }) as Promise<WorktreeProbeRes>,
    worktreeInspect: (req: { path: string; base?: string }) => ipcRenderer.invoke(CH.GIT_WORKTREE_INSPECT, req) as Promise<WorktreeInspectRes>,
    worktreeList: () => ipcRenderer.invoke(CH.GIT_WORKTREE_LIST) as Promise<WorktreeListRes>,
    worktreeReveal: (path: string) => ipcRenderer.invoke(CH.GIT_WORKTREE_REVEAL, { path }) as Promise<boolean>,
  },
  // Desktop-to-desktop Share (app 2.4.0, item 8): `host` (ShareHostApi) sits next to `guest`.
  share: {
    host: shareHostApi,
    guest: shareGuestApi,
  },
}

// contextIsolation is always enabled (see window.ts), so the bridge is the only path.
try {
  contextBridge.exposeInMainWorld('snApi', api)
} catch (error) {
  console.error('Failed to expose snApi over contextBridge:', error)
}
