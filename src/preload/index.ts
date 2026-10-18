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
  PtySpawnReq,
  PtySpawnRes,
  PtyWriteReq,
  RecoveryInfo,
  RemoteCommand,
  RemoteCommandResult,
  RemoteUiState,
  RenderErrorReport,
  RendererDiagnostics,
  SnApi,
  TerminalEngineSettings,
  UpdateInfo,
  UpdateProgress,
  UpdateState,
  UsageSnapshot,
} from '@shared/ipc-contract'
import type {
  AgentSessionEndEvt,
  AgentSettings,
  AwakeMode,
  ConfigFile,
  Language,
  NotificationSettings,
  PaneStatusEvt,
  RemoteSettings,
  StatusHooksStatusRes,
  UsageSettings,
} from '@shared/types'
import type { RemoteStateSnapshot } from '@shared/remote-protocol'
import type { AgentSessionView, AgentsChangedEvt, AgentsReadyEvt, AgentsStartup } from '@shared/agents'
import type { GitInfoRes, GitTarget, GitUpdateEvt } from '@shared/git-types'

/** Subscribe to a main->renderer channel, returning an unsubscribe fn. */
function sub<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
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
  },
  dialog: {
    openDirectory: () => ipcRenderer.invoke(CH.DIALOG_OPEN_DIR) as Promise<string | null>,
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
  },
  system: {
    setLoginItem: (enabled: boolean) =>
      ipcRenderer.invoke(CH.SYSTEM_SET_LOGIN_ITEM, enabled) as Promise<void>,
    getLoginItem: () => ipcRenderer.invoke(CH.SYSTEM_GET_LOGIN_ITEM) as Promise<boolean>,
    setGlobalHotkey: (enabled: boolean, accelerator: string) =>
      ipcRenderer.invoke(CH.SYSTEM_SET_HOTKEY, { enabled, accelerator }) as Promise<boolean>,
    getMetrics: () => ipcRenderer.invoke(CH.SYSTEM_METRICS) as Promise<AppMetrics>,
    openExternal: (url: string) => ipcRenderer.send(CH.SHELL_OPEN_EXTERNAL, url),
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
  },
  usage: {
    get: () => ipcRenderer.invoke(CH.USAGE_GET) as Promise<UsageSnapshot>,
    refresh: () => ipcRenderer.invoke(CH.USAGE_REFRESH) as Promise<UsageSnapshot>,
    setConfig: (cfg: UsageSettings) => ipcRenderer.send(CH.USAGE_SET_CONFIG, cfg),
    onUpdate: (cb: (s: UsageSnapshot) => void) => sub<UsageSnapshot>(CH.USAGE_UPDATE, cb),
  },
  status: {
    reportTitle: (paneId: string, title: string) =>
      ipcRenderer.send(CH.STATUS_TITLE, { paneId, title }),
    setViewed: (paneIds: string[]) => ipcRenderer.send(CH.STATUS_VIEWED, paneIds),
    setConfig: (cfg: NotificationSettings) => ipcRenderer.send(CH.STATUS_SET_CONFIG, cfg),
    onState: (cb: (e: PaneStatusEvt) => void) => sub<PaneStatusEvt>(CH.STATUS_STATE, cb),
    snapshot: () => ipcRenderer.invoke(CH.STATUS_SNAPSHOT),
    health: () => ipcRenderer.invoke(CH.STATUS_HEALTH),
    testDiscord: (cfg: import('@shared/types').DiscordSettings) => ipcRenderer.invoke(CH.STATUS_DISCORD_TEST, cfg),
    testDesktop: () => ipcRenderer.invoke(CH.STATUS_DESKTOP_TEST),
    onReveal: (cb: (paneId: string) => void) => sub<string>(CH.STATUS_REVEAL, cb),
    onSessionEnd: (cb: (e: AgentSessionEndEvt) => void) => sub<AgentSessionEndEvt>(CH.STATUS_SESSION_END, cb),
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
  },
  power: {
    setConfig: (mode: AwakeMode) => ipcRenderer.send(CH.POWER_SET_CONFIG, mode),
    getState: () => ipcRenderer.invoke(CH.POWER_GET_STATE) as Promise<PowerState>,
    onState: (cb: (s: PowerState) => void) => sub<PowerState>(CH.POWER_STATE, cb),
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
  },
  git: {
    setWatch: (targets: GitTarget[]) => ipcRenderer.send(CH.GIT_SET_WATCH, targets),
    setConfig: (cfg: { gitChip: boolean }) => ipcRenderer.send(CH.GIT_SET_CONFIG, cfg),
    refresh: (req?: { keys?: string[]; reason?: 'manual' | 'agent' }) => ipcRenderer.send(CH.GIT_REFRESH, req ?? {}),
    info: (force?: boolean) => ipcRenderer.invoke(CH.GIT_INFO, { force: force === true }) as Promise<GitInfoRes>,
    onUpdate: (cb: (e: GitUpdateEvt) => void) => sub<GitUpdateEvt>(CH.GIT_UPDATE, cb),
  },
}

// contextIsolation is always enabled (see window.ts), so the bridge is the only path.
try {
  contextBridge.exposeInMainWorld('snApi', api)
} catch (error) {
  console.error('Failed to expose snApi over contextBridge:', error)
}
