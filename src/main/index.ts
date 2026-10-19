// Must stay the first import: isolates the dev userData before any path is read (E0-FR-26).
import './devUserData'
import { readFileSync, writeFileSync } from 'fs'
import { stat } from 'fs/promises'
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, powerMonitor, session } from 'electron'
import { CH } from '@shared/ipc-channels'
import { BRAND } from '@shared/brand'
import type { AppInfo, AppMetrics, OpenRequest } from '@shared/ipc-contract'
import type { AwakeMode, ConfigFile } from '@shared/types'
import { createMainWindow } from './window'
import { dataDir, getConfigPath, isPortable } from './paths'
import { PtyManager } from './pty/PtyManager'
import { ScrollbackStore, buildSeed } from './pty/ScrollbackStore'
import { ScrollbackCheckpoint } from './pty/ScrollbackCheckpoint'
import { engineFromSettings } from '@shared/terminalEngine'
import { ConfigStore } from './store/ConfigStore'
import { parseConfig } from './store/schema'
import { sanitizeExport } from './store/exportConfig'
import { registerPtyIpc } from './ipc/registerPtyIpc'
import { registerWindowIpc, wireWindowMaximizeEvents } from './ipc/registerWindowIpc'
import { registerSystemIpc } from './ipc/registerSystemIpc'
import { registerUpdateIpc } from './ipc/registerUpdateIpc'
import { registerUsageIpc } from './ipc/registerUsageIpc'
import { registerGitIpc } from './ipc/registerGitIpc'
import { registerRemoteIpc } from './ipc/registerRemoteIpc'
import { registerLegacyIpc } from './ipc/registerLegacyIpc'
import { registerStatusIpc, type StatusIpc } from './ipc/registerStatusIpc'
import { registerPowerIpc } from './ipc/registerPowerIpc'
import type { AwakeService } from './agents/AwakeService'
import { AgentSessionStore } from './agents/AgentSessionStore'
import { CodexRolloutIndex } from './agents/transcripts'
import { registerAgentsIpc } from './ipc/registerAgentsIpc'
import type { ExitTrigger } from '@shared/agents'
import { RemoteManager } from './remote/RemoteManager'
import { StatusManager } from './status/StatusManager'
import { HookServer } from './status/HookServer'
import { CodexBridge } from './status/CodexBridge'
import { statusBinDir } from './pty/shellResolver'
import { DiscordNotifier } from './status/DiscordNotifier'
import { NtfyNotifier } from './status/NtfyNotifier'
import { createNoticeRouter, type NoticeRouter } from './status/noticeRouter'
import { isDesktopAway } from './status/desktopAway'
import { join } from 'path'
import { homedir } from 'os'
import { ensureTray, destroyTray, hasTray } from './tray'
import { mainT, shortDateTime, shortTime } from './i18n'
import { runLegacyMigrationAtBoot, scheduleLegacyCleanup } from './migration/runLegacyMigration'
import { installLogRing } from './diagnostics/logRing'
import { CrashStore } from './crash/crashStore'
import { diagnosticsSecrets } from './diagnostics/buildDiagnostics'
import { RendererRecovery } from './crash/rendererRecovery'
import { copyMainDiagnostics, registerCrashIpc, type CrashIpcDeps } from './ipc/registerCrashIpc'
import { updateState } from './updateState'
import { makeOpenRequest, OpenRequestQueue, parseOpenArg, validateOpenPath } from './openRequest'
import { refreshExplorerMenuOnStartup } from './shellIntegration'

// Remember main's warn/error lines for "Copy diagnostics" (E4-FR-24).
installLogRing()

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL)

let mainWindow: BrowserWindow | null = null
let isQuitting = false
// Set while an update is being applied: lets the window close immediately,
// skipping both the hide-to-tray and the "active consoles" confirmation so the
// installer/swap can replace files and relaunch.
let bypassCloseGuards = false
// True while an update download/install is in flight: blocks the user closing
// the window mid-download (which would abort the update).
let isInstalling = false
const ptyManager = new PtyManager(
  () => mainWindow?.webContents ?? null,
  (ptyId, paneId, cwd) => codexBridge.environment(ptyId, paneId, cwd),
  // Closure: statusManager is constructed below; the prompt gate polls it (E8-FR-02b).
  (paneId) => {
    const s = statusManager.stateOf(paneId)
    return s && s.state ? { state: s.state, precise: s.precise } : null
  },
)
const configStore = new ConfigStore()
const remoteManager = new RemoteManager(
  ptyManager,
  () => mainWindow?.webContents ?? null,
  app.getVersion(),
  // Closure: statusManager is constructed below; only read once phones connect.
  () => statusManager.snapshot(),
)
const hookServer = new HookServer()
const discordNotifier = new DiscordNotifier()
const ntfyNotifier = new NtfyNotifier(undefined, undefined, () => configStore.load())
// Lazy closure: the router is built right below StatusManager (E2-FR-40..42, 52).
let noticeRouter: NoticeRouter | null = null
const statusManager = new StatusManager(
  () => mainWindow,
  () => configStore.load(),
  notice => noticeRouter?.route(notice),
)
noticeRouter = createNoticeRouter({
  discord: discordNotifier,
  ntfy: ntfyNotifier,
  loadConfig: () => configStore.load(),
  // powerMonitor needs app ready; a notice before that reads unknown and delivers.
  isAway: () => (app.isReady() ? isDesktopAway(powerMonitor) : undefined),
  isPaneViewed: (paneId) => remoteManager.isPaneViewed(paneId),
  deepLinkBase: () => remoteManager.deepLinkBase(),
})
const codexBridge = new CodexBridge(statusBinDir, join(__dirname, 'statusRuntime.js'), event => statusManager.onAgentEvent(event))
ptyManager.addSink(statusManager)
// Agent status reaches phones straight from main (E1-FR-03), not via the renderer.
statusManager.addListener((evt) => remoteManager.pushPaneStatus(evt))
ptyManager.addSink(codexBridge)
let statusIpc: StatusIpc | null = null
// Created in bootstrap: powerSaveBlocker/powerMonitor need app ready.
let awakeService: AwakeService | null = null
let trayAwakeMode: AwakeMode | null = null
// Created in bootstrap, after the legacy migration put dataDir() in place.
let agentSessions: AgentSessionStore | null = null
// Saved scrollback (E6-FR-08..13, 36): created in bootstrap, under dataDir().
let scrollbackCheckpoint: ScrollbackCheckpoint | null = null
// Crash resilience (E4-FR-21..25). The breaker dialog's [Close] quits without
// the tray-hide or "active consoles" guards (the button already names N).
let crashQuit = false
let crashStore: CrashStore | null = null
let crashIpcDeps: CrashIpcDeps | null = null
const rendererRecovery = new RendererRecovery({
  isQuitting: () => isQuitting,
  bypassCloseGuards: () => bypassCloseGuards,
  // The update download finished and it is applying / relaunching: never reload over it.
  updateRelaunchPending: () => updateState.get().phase === 'installing',
  consoles: () => ptyManager.count,
  crashes: { write: (rec) => crashStore?.write(rec) ?? null },
  t: (key, vars) => mainT(configStore.load(), key, vars),
  productName: BRAND.productName,
  showMessageBox: (win, opts) => {
    const box = { ...opts, title: BRAND.productName, noLink: true }
    return win ? dialog.showMessageBox(win as BrowserWindow, box) : dialog.showMessageBox(box)
  },
  copyDiagnostics: () => {
    if (crashIpcDeps) copyMainDiagnostics(crashIpcDeps)
  },
  hideToBackground: (win) => {
    ;(win as BrowserWindow).hide()
    showTray()
  },
  quitSkippingGuards: () => {
    crashQuit = true
    quitApp()
  },
})

// "Open in SnAgentsOS" (E4-FR-32/33): main holds the latest request until the
// renderer takes it, and pokes it when a window is up.
const openRequests = new OpenRequestQueue((req) => {
  const wc = mainWindow?.webContents
  if (wc && !wc.isDestroyed()) wc.send(CH.APP_OPEN_PATH, req)
})

/** Parses `--open`, stats the path off the main thread's critical path (3 s deadline) and queues it. */
async function handleOpenArgv(argv: readonly string[], cwd: string, source: OpenRequest['source']): Promise<void> {
  const requested = parseOpenArg(argv, cwd)
  if (!requested) return
  const dir = await validateOpenPath(requested, (p) => stat(p))
  if (dir) openRequests.offer(makeOpenRequest(dir, source))
}

/**
 * Exit snapshot of the agent session registry (E5-FR-06): before the ptys
 * die, mark who was mid-turn and freeze the store, flushed synchronously.
 * Idempotent; an update quit is 'update' whatever path gets here first.
 */
function snapshotAgentsOnce(trigger: ExitTrigger): void {
  agentSessions?.snapshotExitOnce(bypassCloseGuards ? 'update' : trigger)
}

/**
 * Saves every console's new output before the ptys die (E6-FR-10/36), once
 * per exit: X, tray, Windows session end, macOS/Linux shutdown.
 */
function persistScrollbackOnExit(): void {
  try {
    scrollbackCheckpoint?.persistOnExit()
  } catch (error) {
    console.warn('[scrollback] exit save failed:', error)
  }
}

/** After killAll(): the next exit saves again and the next spawns restore again (macOS new window). */
function afterPtysKilled(): void {
  scrollbackCheckpoint?.resetExit()
  ptyManager.resetSeeds()
}

/**
 * The OS is ending the session: save now, but if the shutdown is cancelled
 * the app lives on, so a later quit must save again.
 */
function persistScrollbackForShutdown(): void {
  persistScrollbackOnExit()
  setTimeout(() => scrollbackCheckpoint?.resetExit(), 10_000).unref?.()
}

function quitApp(): void {
  isQuitting = true
  app.quit()
}

/** Quit for an in-progress update, bypassing tray-hide and close confirmations. */
function quitForUpdate(): void {
  isQuitting = true
  bypassCloseGuards = true
  app.quit()
}

/** Bring the window to the front from anywhere (tray / global hotkey). */
function showWindow(): void {
  if (!mainWindow) {
    openMainWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  // Left in background after the breaker dialog: bring a live UI back.
  rendererRecovery.ensureAlive(mainWindow)
}

/** Shows (or refreshes) the tray with labels in the persisted language. */
function showTray(): void {
  const cfg = configStore.load()
  const awake = awakeService
  trayAwakeMode = awake ? awake.getState().mode ?? 'auto' : null
  ensureTray(
    () => mainWindow,
    quitApp,
    {
      show: mainT(cfg, 'tray.show', { app: BRAND.productName }),
      quit: mainT(cfg, 'tray.quit'),
    },
    awake && trayAwakeMode
      ? {
          mode: trayAwakeMode,
          labels: {
            title: mainT(cfg, 'tray.awake'),
            auto: mainT(cfg, 'tray.awakeAuto'),
            always: mainT(cfg, 'tray.awakeAlways'),
            never: mainT(cfg, 'tray.awakeNever'),
          },
          // Main decides; the power:state echo makes the renderer persist it.
          onMode: (mode) => awake.setMode(mode),
        }
      : undefined,
  )
}

let currentHotkey: string | null = null

/** (Re)register the global show-app shortcut. Returns false if binding failed. */
function applyGlobalHotkey(enabled: boolean, accelerator: string): boolean {
  if (currentHotkey) {
    try {
      globalShortcut.unregister(currentHotkey)
    } catch {
      /* ignore */
    }
    currentHotkey = null
  }
  if (!enabled || !accelerator || !accelerator.trim()) return true
  try {
    const ok = globalShortcut.register(accelerator, showWindow)
    if (ok) currentHotkey = accelerator
    return ok
  } catch {
    return false
  }
}

function registerCsp(): void {
  const csp = isDev
    ? "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws://localhost:* http://localhost:*;"
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:;"

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    })
  })
}

function registerAppIpc(): void {
  ipcMain.handle(
    CH.APP_INFO,
    (): AppInfo => ({
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      portable: isPortable(),
      configPath: getConfigPath(),
    }),
  )
}

function registerConfigIpc(): void {
  ipcMain.handle(CH.CONFIG_LOAD, (): ConfigFile | null => configStore.load({ upgrade: true }))
  ipcMain.on(CH.CONFIG_SAVE, (_e, config: ConfigFile) => configStore.save(config))

  ipcMain.handle(CH.CONFIG_EXPORT, async (_e, config: ConfigFile): Promise<boolean> => {
    const opts = {
      defaultPath: BRAND.exportFileName,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    }
    const res = mainWindow
      ? await dialog.showSaveDialog(mainWindow, opts)
      : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return false
    try {
      const exported = sanitizeExport(config)
      writeFileSync(res.filePath, JSON.stringify(exported, null, 2), 'utf8')
      return true
    } catch (error) {
      console.error('Config export failed:', error)
      return false
    }
  })

  ipcMain.handle(CH.CONFIG_IMPORT, async (): Promise<ConfigFile | null> => {
    const opts = {
      properties: ['openFile' as const],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    }
    const res = mainWindow
      ? await dialog.showOpenDialog(mainWindow, opts)
      : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return null
    try {
      return parseConfig(JSON.parse(readFileSync(res.filePaths[0], 'utf8')))
    } catch (error) {
      console.error('Config import failed:', error)
      return null
    }
  })
}

function registerClipboardIpc(): void {
  ipcMain.on(CH.CLIPBOARD_WRITE, (_e, text: string) => clipboard.writeText(String(text ?? '')))
  ipcMain.handle(CH.CLIPBOARD_READ, (): string => clipboard.readText())
}

function registerDialogIpc(): void {
  ipcMain.handle(CH.DIALOG_OPEN_DIR, async (): Promise<string | null> => {
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, {
          properties: ['openDirectory', 'createDirectory'],
        })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
}

function openMainWindow(): void {
  mainWindow = createMainWindow()
  const win = mainWindow
  wireWindowMaximizeEvents(win)

  // Stop the taskbar flash (status notifications) once the user comes back.
  win.on('focus', () => win.flashFrame(false))

  // A renderer reload or crash leaves any ptys it had paused (backpressure)
  // stuck paused, which would starve connected phones. Resume them so the
  // remote data plane keeps flowing regardless of the desktop renderer.
  win.webContents.on('render-process-gone', () => ptyManager.resumeRendererPaused())
  // Crash resilience (E4-FR-21, 25): auto reload behind the breaker; a hang
  // over 15 s asks [Wait] / [Reload window]. Neither path kills a pty.
  win.webContents.on('render-process-gone', (_e, details) => rendererRecovery.onGone(win, details))
  win.on('unresponsive', () => rendererRecovery.onUnresponsive(win))
  win.on('responsive', () => rendererRecovery.onResponsive())
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame) ptyManager.resumeRendererPaused()
  })

  let forceClose = false
  win.on('close', (event) => {
    // Updater is relaunching us, or the crash dialog's [Close] was picked:
    // let the window close without any guard.
    if (bypassCloseGuards || crashQuit) return
    // An update is downloading/installing: don't let the user abort it.
    if (isInstalling) {
      event.preventDefault()
      return
    }
    const cfg = configStore.load()
    // Installed build: hide to tray instead of quitting (keeps consoles running).
    const useTray = !isPortable() && cfg?.settings?.closeToTray !== false
    if (useTray && !isQuitting) {
      event.preventDefault()
      win.hide()
      showTray()
      return
    }
    if (forceClose) return
    const shouldConfirm = cfg?.settings?.confirmCloseRunning !== false
    if (shouldConfirm && ptyManager.count > 0) {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'question',
        buttons: [mainT(cfg, 'dialog.cancel'), mainT(cfg, 'dialog.closeAnyway')],
        defaultId: 1,
        cancelId: 0,
        noLink: true,
        title: BRAND.productName,
        message: mainT(cfg, 'dialog.activeTitle'),
        detail: mainT(cfg, 'dialog.activeDetail', { n: ptyManager.count }),
      })
      if (choice === 0) {
        event.preventDefault()
        isQuitting = false
        return
      }
    }
    forceClose = true
  })

  // Windows shutdown, restart or log off: Electron emits no before-quit, so the
  // agent snapshot runs here, synchronously (E5-FR-06).
  win.on('session-end', () => {
    snapshotAgentsOnce('shutdown')
    persistScrollbackForShutdown()
  })

  win.on('closed', () => {
    mainWindow = null
  })
}

async function bootstrap(): Promise<void> {
  // Windows toasts need the AppUserModelID to match the installed shortcut's.
  // Packaged only: in dev an AUMID without a Start Menu shortcut can silently
  // suppress notifications, so dev keeps Electron's default.
  if (process.platform === 'win32' && app.isPackaged) {
    app.setAppUserModelId(BRAND.appId)
  }
  // 1.x data moves in before anything reads config.json or remote-devices.json,
  // and before a window exists (its store persists on a debounce). Only the
  // FR-09 dialog's [Quit] stops the start; a failed migration never does.
  if ((await runLegacyMigrationAtBoot()) === 'quit') {
    quitApp()
    return
  }
  // No native menu on Windows/Linux: it's a frameless app with a custom
  // in-renderer title bar, so the default menu is invisible anyway, and its
  // accelerators are footguns in a terminal app. CmdOrCtrl+R (Reload) would
  // hijack readline reverse-i-search, and CmdOrCtrl+Shift+R (Force Reload)
  // would tear down every pane's renderer. Removing the menu lets those keys
  // reach the shell / our remappable redraw action. macOS keeps its menu (its
  // accelerators use Cmd, so they don't collide with the terminal's Ctrl keys).
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  remoteManager.loadDevices()
  registerCsp()
  registerAppIpc()
  registerConfigIpc()
  registerDialogIpc()
  registerClipboardIpc()
  // Headless mirror policy from the saved config before any pty spawns (E6-FR-01);
  // the renderer pushes every later change on pty:setEngine.
  ptyManager.setEngine(engineFromSettings(configStore.load()?.settings))
  // Saved scrollback (E6-FR-08..13): the first spawn of each pane restores
  // its file (sanitized, with the dated separator), a checkpoint saves every
  // 60 s and the exit paths below save synchronously.
  const scrollbackStore = new ScrollbackStore(join(dataDir(), 'scrollback'))
  ptyManager.setSeedSource((paneId, rows) => {
    const saved = scrollbackStore.load(paneId)
    if (!saved) return null
    const cfg = configStore.load()
    return buildSeed(saved.ansi, mainT(cfg, 'pty.historyRestored', { date: shortDateTime(cfg, new Date(saved.savedAt)) }), rows)
  })
  registerPtyIpc(
    ptyManager,
    () => {
      const cfg = configStore.load()
      return mainT(cfg, 'pty.restarted', { time: shortTime(cfg) })
    },
    scrollbackStore,
  )
  scrollbackCheckpoint = new ScrollbackCheckpoint(scrollbackStore, ptyManager, { log: (msg) => console.warn(msg) })
  scrollbackCheckpoint.start()
  {
    // Startup GC: only a config read from the primary file says which panes are gone.
    const cfg = configStore.load()
    const live = cfg && configStore.lastLoadSource === 'primary' ? new Set(cfg.workspaces.flatMap((w) => w.panes.map((p) => p.id))) : null
    void scrollbackStore.gc(live).catch(() => undefined)
  }
  // macOS/Linux shutdown (Windows uses the window's session-end, E6-FR-36).
  powerMonitor.on('shutdown', () => persistScrollbackForShutdown())
  registerWindowIpc(() => mainWindow)
  registerSystemIpc(() => mainWindow?.webContents ?? null, openRequests)
  void handleOpenArgv(process.argv, process.cwd(), 'argv')
  registerUpdateIpc({
    getSender: () => mainWindow?.webContents ?? null,
    quitForUpdate,
    setInstalling: (v) => {
      isInstalling = v
    },
    // The NSIS setup closes the app without a before-quit (E6-FR-10). Leaves
    // the exit flag alone: a cancelled wizard still saves on the next quit.
    persistBeforeInstall: () => scrollbackCheckpoint?.persistAllSync(),
  })
  registerUsageIpc({
    getSender: () => mainWindow?.webContents ?? null,
    getInitialConfig: () => configStore.load()?.settings?.usage ?? null,
  })
  // Git chip (E7-FR-05..10); settings.gitChip is a schema 12 key, absent = on.
  registerGitIpc({
    getSender: () => mainWindow?.webContents ?? null,
    initialGitChip: (configStore.load()?.settings as { gitChip?: unknown } | undefined)?.gitChip !== false,
  })
  registerRemoteIpc(remoteManager)
  registerLegacyIpc({
    getSender: () => mainWindow?.webContents ?? null,
    remoteEnabled: () => configStore.load()?.settings?.remote?.enabled === true,
  })
  statusIpc = registerStatusIpc(statusManager, hookServer, codexBridge, discordNotifier, ntfyNotifier)
  // Crash records live under dataDir(), in place after the legacy migration.
  // Records are scrubbed like the copied diagnostics (home folder, tokens, sends).
  crashStore = new CrashStore(join(dataDir(), 'crashes'), app.getVersion(), undefined, () => ({
    home: homedir(),
    extraSecrets: diagnosticsSecrets(configStore.load()),
  }))
  crashIpcDeps = {
    recovery: rendererRecovery,
    crashes: crashStore,
    getConfig: () => configStore.load(),
    consoles: () => ptyManager.count,
    statusHealth: () => statusIpc?.health() ?? null,
    remoteStatus: () => remoteManager.getUiState().status,
  }
  registerCrashIpc(crashIpcDeps)
  const sendToRenderer = (channel: string, payload: unknown): void => {
    const wc = mainWindow?.webContents
    if (wc && !wc.isDestroyed()) wc.send(channel, payload)
  }
  const sessions = new AgentSessionStore({
    file: join(dataDir(), 'agent-sessions.json'),
    getConfig: () => configStore.load(),
    spawnCwd: (paneId) => ptyManager.getSpawnCwd(paneId),
    codexIndex: new CodexRolloutIndex(),
    onChanged: (evt) => sendToRenderer(CH.AGENTS_CHANGED, evt),
    onReady: (evt) => sendToRenderer(CH.AGENTS_READY, evt),
  })
  sessions.load()
  agentSessions = sessions
  statusManager.addListener((evt, cause) => sessions.onStatus(evt, cause))
  registerAgentsIpc(sessions)
  const bootCfg = configStore.load()
  awakeService = registerPowerIpc({
    getSender: () => mainWindow?.webContents ?? null,
    initialMode: bootCfg?.settings?.awakeMode,
    initialDisplay: bootCfg?.settings?.agents?.awakeDisplay,
    onState: (state) => {
      if (hasTray() && state.mode && state.mode !== trayAwakeMode) showTray()
    },
  })
  const awake = awakeService
  statusManager.addListener((evt) => awake.onPaneStatus(evt))
  awake.seed(statusManager.snapshot())
  remoteManager.setPhoneListener((connected) => awake.setPhoneConnected(connected))
  awake.setPhoneConnected(remoteManager.phoneConnected)
  ipcMain.handle(CH.SYSTEM_SET_HOTKEY, (_e, p: { enabled: boolean; accelerator: string }) =>
    applyGlobalHotkey(p.enabled, p.accelerator),
  )
  ipcMain.handle(CH.SYSTEM_METRICS, (): AppMetrics => {
    const metrics = app.getAppMetrics()
    let memKB = 0
    let cpu = 0
    for (const m of metrics) {
      memKB += m.memory?.workingSetSize ?? 0
      cpu += m.cpu?.percentCPUUsage ?? 0
    }
    return {
      memMB: Math.round(memKB / 1024),
      cpuPercent: Math.round(cpu * 10) / 10,
      processes: metrics.length,
      consoles: ptyManager.count,
      headless: ptyManager.headlessMetrics(),
    }
  })
  const startupCfg = configStore.load()
  await codexBridge.configure(startupCfg?.settings.notifications.codexEnabled ?? false)
  openMainWindow()
  // Explorer menu (E4-FR-34): with the toggle on, rewrite the keys when the exe
  // or the label changed (a moved portable, the language). After the first paint.
  mainWindow?.once('ready-to-show', () => {
    const cfg = configStore.load()
    void refreshExplorerMenuOnStartup(cfg?.settings?.explorerMenu === true, cfg?.settings?.language === 'es' ? 'es' : 'en')
  })
  // Deletes what 1.x left behind, only after a committed migration, in the background.
  if (mainWindow) scheduleLegacyCleanup(mainWindow)
  if (startupCfg?.settings) {
    applyGlobalHotkey(startupCfg.settings.globalHotkeyEnabled, startupCfg.settings.globalHotkey)
  }
  remoteManager.applyConfig(
    startupCfg?.settings?.remote ?? { enabled: false, port: 4517, phoneFit: true, https: { enabled: false, mode: 'tailscaleServe' } },
  )
  statusIpc?.applyStartup(startupCfg?.settings?.notifications)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      // macOS: the window closed but the app lived on; record sessions again.
      agentSessions?.thaw()
      openMainWindow()
    }
  })
}

// Single-instance lock: if another copy is already running (e.g. hidden in the
// system tray), hand off to it and quit this one instead of opening a duplicate.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // A second launch (Explorer menu, shortcut, CLI) focuses this one and hands over its `--open`.
  app.on('second-instance', (_e, argv, workingDirectory) => {
    showWindow()
    void handleOpenArgv(argv, workingDirectory, 'second-instance')
  })
  app.whenReady().then(bootstrap)
}

app.on('before-quit', () => {
  isQuitting = true
  snapshotAgentsOnce('quit')
  // Shut the remote server first (best-effort, non-blocking) so phones get a
  // shutdown frame before the ptys they mirror are torn down.
  remoteManager.shutdown('quit')
  persistScrollbackOnExit()
  ptyManager.killAll()
  afterPtysKilled()
  scrollbackCheckpoint?.stop()
  awakeService?.dispose()
  statusManager.dispose()
  codexBridge.dispose()
  discordNotifier.dispose()
  ntfyNotifier.dispose()
  void hookServer.stop()
  destroyTray()
})

app.on('will-quit', () => globalShortcut.unregisterAll())

app.on('window-all-closed', () => {
  // The ptys die below, so the agent snapshot goes first (E5-FR-06).
  snapshotAgentsOnce('quit')
  // On darwin the app stays alive with no window; still stop the server so it
  // isn't left listening without any UI to approve pairings.
  remoteManager.shutdown('quit')
  persistScrollbackOnExit()
  ptyManager.killAll()
  afterPtysKilled()
  if (process.platform !== 'darwin') app.quit()
})
