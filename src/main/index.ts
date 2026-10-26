// Must stay the first import: isolates the dev userData before any path is read (E0-FR-26).
import './devUserData'
import { readFileSync, writeFileSync } from 'fs'
import { stat } from 'fs/promises'
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, Notification, powerMonitor, session, shell } from 'electron'
import { CH } from '@shared/ipc-channels'
import { BRAND } from '@shared/brand'
import type { AppInfo, AppMetrics, OpenRequest } from '@shared/ipc-contract'
import type { AwakeMode, ConfigFile } from '@shared/types'
import { createMainWindow } from './window'
import { dataDir, getConfigPath, isPortable } from './paths'
import { PtyManager } from './pty/PtyManager'
import { ScrollbackStore, buildSeed } from './pty/ScrollbackStore'
import { ScrollbackCheckpoint } from './pty/ScrollbackCheckpoint'
import { createShutdownPersist, wirePowerShutdown, wireSessionEnd } from './pty/shutdownPersist'
import { engineFromSettings } from '@shared/terminalEngine'
import { resolvePresetEnv } from '@shared/presetEnv'
import { ConfigStore } from './store/ConfigStore'
import { parseConfig } from './store/schema'
import { sanitizeExport } from './store/exportConfig'
import { registerPtyIpc } from './ipc/registerPtyIpc'
import { registerWindowIpc, wireWindowMaximizeEvents } from './ipc/registerWindowIpc'
import { registerSystemIpc } from './ipc/registerSystemIpc'
import { registerUpdateIpc } from './ipc/registerUpdateIpc'
import { registerUsageIpc } from './ipc/registerUsageIpc'
import { registerAccountsIpc } from './ipc/registerAccountsIpc'
import { AccountService } from './accounts/AccountService'
import { ctlAccountsView } from './cli/accountsView'
import { AccountVault } from './accounts/AccountVault'
import { electronCrypto } from './accounts/safeCrypto'
import { registerGitIpc } from './ipc/registerGitIpc'
import { registerReviewNotesIpc } from './ipc/registerReviewNotesIpc'
import { registerWsNotesIpc } from './ipc/registerWsNotesIpc'
import { registerChatIpc, type ChatIpc } from './ipc/registerChatIpc'
import { registerFilesIpc } from './ipc/registerFilesIpc'
import type { ReviewNoteStore } from './git/ReviewNoteStore'
import { registerWorktreeIpc } from './ipc/registerWorktreeIpc'
import { registerRepoConfigIpc } from './ipc/registerRepoConfigIpc'
import { registerRemoteIpc } from './ipc/registerRemoteIpc'
import { registerLegacyIpc } from './ipc/registerLegacyIpc'
import { registerStatusIpc, type StatusIpc } from './ipc/registerStatusIpc'
import { registerPowerIpc } from './ipc/registerPowerIpc'
import type { AwakeService } from './agents/AwakeService'
import { AgentSessionStore } from './agents/AgentSessionStore'
import { HibernationCoordinator } from './agents/Hibernation'
import { CodexRolloutIndex } from './agents/transcripts'
import { registerAgentsIpc } from './ipc/registerAgentsIpc'
import { SessionHistory, openSessionsOf } from './history/SessionHistory'
import { ChatHub } from './chat/ChatHub'
import { TranscriptLocator } from './chat/TranscriptLocator'
import { claudeConfigDir } from './status/statusDetails'
import { sessionsRoot } from './agents/codexPaths'
import { registerHistoryIpc } from './ipc/registerHistoryIpc'
import type { ExitTrigger } from '@shared/agents'
import { RemoteManager } from './remote/RemoteManager'
import { StatusManager } from './status/StatusManager'
import { HookServer } from './status/HookServer'
import { CodexBridge } from './status/CodexBridge'
import { ConsoleLedger } from './usage/ConsoleLedger'
import { statusBinDir } from './pty/shellResolver'
import { DiscordNotifier } from './status/DiscordNotifier'
import { NtfyNotifier } from './status/NtfyNotifier'
import { createNoticeRouter, type NoticeRouter } from './status/noticeRouter'
import { isDesktopAway } from './status/desktopAway'
import { join } from 'path'
import { homedir, hostname } from 'os'
import { ensureTray, destroyTray, hasTray } from './tray'
import { mainT, shortDateTime, shortTime } from './i18n'
import { runLegacyMigrationAtBoot, scheduleLegacyCleanup } from './migration/runLegacyMigration'
import { installLogRing } from './diagnostics/logRing'
import { CrashStore } from './crash/crashStore'
import { diagnosticsSecrets } from './diagnostics/buildDiagnostics'
import { RendererRecovery } from './crash/rendererRecovery'
import { copyMainDiagnostics, registerCrashIpc, type CrashIpcDeps } from './ipc/registerCrashIpc'
import { updateState } from './updateState'
import { takeUpdateMarker } from './updateMarker'
import { makeOpenRequest, OpenRequestQueue, parseOpenArg, validateOpenPath } from './openRequest'
import { refreshExplorerMenuOnStartup } from './shellIntegration'
import { CliService } from './cli/CliService'
import { removeFromUserPath } from './cli/userPath'
import { registerCliIpc } from './ipc/registerCliIpc'
import { registerDictationIpc } from './ipc/registerDictationIpc'
import { registerShareGuestIpc } from './ipc/registerShareGuestIpc'
import { createShareIdentityStore, type ShareIdentityStore } from './share/identity'
import type { ShareGuest } from './share/guest/ShareGuest'
import { ShareHost } from './share/ShareHost'
import { GrantStore, shareGrantsPath } from './share/GrantStore'
import { ShareServer } from './share/ShareServer'
import { registerShareHostIpc } from './ipc/registerShareHostIpc'
import { listEndpoints } from './remote/network'
import { runNotesRequest } from './remote/RemoteManager'
import type { RemoteGitReply, RemoteGitRequest } from '@shared/remote-protocol'
import { hasNvidiaGpu, type DictationService } from './dictation/DictationService'
import { installPermissionHandlers } from './permissions'
import { pathToFileURL } from 'url'
import { gitRunner } from './git/gitExec'
import { TeamService } from './teams/TeamService'
import { registerTeamsIpc } from './teams/registerTeamsIpc'
import { createTeamsLog } from './teams/teamsLog'

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
const ptyManager: PtyManager = new PtyManager(
  () => mainWindow?.webContents ?? null,
  // Codex bridge + snaos CLI (E8-FR-13); cliService is constructed below, read at spawn time.
  (ptyId, paneId, cwd, workspaceId): Record<string, string> => ({ ...codexBridge.environment(ptyId, paneId, cwd), ...cliService.envFor(ptyId, paneId, workspaceId) }),
  // Closure: statusManager is constructed below; the prompt gate polls it (E8-FR-02b).
  (paneId) => {
    const s = statusManager.stateOf(paneId)
    return s && s.state ? { state: s.state, precise: s.precise, provider: s.provider, pendingCount: s.pendingCount, ended: statusManager.isEnded(paneId) } : null
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
  // Web Push to the PWA (E3-FR-44): devices with a visible session are skipped.
  push: (notice, config) => void remoteManager.notifyPush(notice, config),
  // Teams (app 2.7.0, E10 B8): the push of a new "Te necesita" row or an integrate result, with the #team= deep link.
  pushTeam: (notice, config) => void remoteManager.notifyTeamPush(notice, config),
})
// App 2.7.0 (A4): tokens, cost and context per console, recomputed once per turn for Claude (its done) and on
// every model call for Codex (thread/tokenUsage/updated), always published as status detail (inside its throttle).
const consoleLedger = new ConsoleLedger({
  transcript: (paneId) => statusManager.transcriptFor(paneId),
  model: (paneId) => statusManager.stateOf(paneId)?.model,
  publish: (paneId, usage, context) => statusManager.setUsage(paneId, usage, context),
})
const codexBridge = new CodexBridge(statusBinDir, join(__dirname, 'statusRuntime.js'), event => statusManager.onAgentEvent(event),
  // v2.4 `/rename`: the thread's name goes through the same dedup as Claude's.
  (paneId, ptyId, sessionId, title, explicit) => statusManager.reportAgentTitle(paneId, ptyId, 'codex', sessionId, title, explicit),
  // App 2.7.0 (A3): every app-server line is a sign of life. A4: the root thread's token usage feeds the ledger.
  { onSignal: (paneId, ptyId) => statusManager.noteSignal(paneId, ptyId), onUsage: (paneId, ptyId, usage) => consoleLedger.codexUsage(paneId, ptyId, usage) })
ptyManager.addSink(statusManager)
// App 2.7.0 (A4): a Claude turn's done recomputes its console's ledger; a cleared status forgets it.
statusManager.addListener((evt, cause) => void consoleLedger.onStatus(evt, cause))
// Agent status reaches phones straight from main (E1-FR-03), not via the renderer.
statusManager.addListener((evt) => remoteManager.pushPaneStatus(evt))
// app 2.4.0 Share: the guests' pane statuses too (ShareHost exists once bootstrap ran).
statusManager.addListener((evt) => shareHost?.onPaneStatus(evt))
// v2.3 attention: a phone looking at a pane acknowledges it, both ways.
statusManager.setRemoteSeen((paneId) => remoteManager.isPaneSeen(paneId))
// v2.4: the nonce of each integrated pty's OSC 133 marks (claude / codex typed in a shell).
statusManager.setShellMarks((ptyId) => ptyManager.shellMarkOf(ptyId))
remoteManager.setPaneSeenListener((paneId) => statusManager.ackPane(paneId))
// App 2.7.0 (A3): the phone's markRead / mutePane / silenceAck ctls and planReq.
remoteManager.setStatusControl(statusManager)
ptyManager.addSink(codexBridge)
// snaos CLI (E8-FR-12..22): control server, console tokens, runtime.json and shim under dataDir().
const cliService: CliService = new CliService({
  dataDir,
  appVersion: app.getVersion(),
  execPath: process.execPath,
  cliPath: join(__dirname, 'cli.js'),
  portable: isPortable(),
  getSender: () => mainWindow?.webContents ?? null,
  pty: ptyManager,
  status: statusManager,
  config: () => configStore.load(),
  routeCustom: (notice) => noticeRouter?.routeCustom(notice),
})
ptyManager.addSink(cliService.sink)
statusManager.addListener((evt) => cliService.handlers.onStatus(evt))
let statusIpc: StatusIpc | null = null
// Created in bootstrap: powerSaveBlocker/powerMonitor need app ready.
let awakeService: AwakeService | null = null
let trayAwakeMode: AwakeMode | null = null
// Created in bootstrap, after the legacy migration put dataDir() in place.
let agentSessions: AgentSessionStore | null = null
let hibernation: HibernationCoordinator | null = null
// Saved scrollback (E6-FR-08..13, 36): created in bootstrap, under dataDir().
let scrollbackCheckpoint: ScrollbackCheckpoint | null = null
// Claude multi-account (app 2.3.0): created in bootstrap (safeStorage needs app ready).
let accountService: AccountService | null = null
// Teams (app 2.7.0, E10 B, labs.teams): created in bootstrap under dataDir(); idle and answering 'disabled' with the lab off.
let teamService: TeamService | null = null
// Review notes (E7-FR-18): created in bootstrap; flushed on the exits that skip before-quit.
let reviewNotes: ReviewNoteStore | null = null
// Desktop dictation (app 2.5.0): created in bootstrap; its whisper-server dies on quit.
let dictationService: DictationService | null = null
// Desktop console chat (app 2.7.0, A7): created in bootstrap next to ChatHub; CONFIG_SAVE re-reads its lab.
let chatIpc: ChatIpc | null = null
// An NVIDIA GPU (app.getGPUInfo, read once at bootstrap): picks the GPU pack for device 'auto'.
let nvidiaGpu = false
// Share (app 2.4.0, item 8): ONE identity store for both roles (share-identity.json holds host and guest keys;
// two instances would overwrite each other's entry). Created lazily after app ready (DPAPI).
let shareIdentityStore: ShareIdentityStore | null = null
function shareIdentities(): ShareIdentityStore {
  if (!shareIdentityStore) shareIdentityStore = createShareIdentityStore()
  return shareIdentityStore
}
// Guest half: the shares this PC joined (src/main/share/guest/); links never reach config.json.
let shareGuest: ShareGuest | null = null
// Host half: this PC's shared consoles (src/main/share/ShareHost.ts); created in bootstrap.
let shareHost: ShareHost | null = null
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
  // No console goes to sleep while the app exits (the next window pushes its view again).
  hibernation?.rendererGone()
  // Team runs (app 2.7.0, E10 B2): interrupted, process trees killed and stores flushed, before the CLI and the ptys go.
  teamService?.shutdownSync(bypassCloseGuards ? 'update' : trigger)
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
 * the app lives on, so a later quit must save again (shutdownPersist).
 */
const persistScrollbackForShutdown = createShutdownPersist({
  checkpoint: () => scrollbackCheckpoint,
  flush: () => reviewNotes?.flush(),
  log: (msg, error) => console.warn(msg, error),
})

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
  ipcMain.on(CH.CONFIG_SAVE, (_e, config: ConfigFile) => {
    configStore.save(config)
    // v2.4: StatusManager caches the agents settings it reads on the pty data path.
    statusManager.setAgentSettings(config?.settings?.agents)
    // v2.5: dictation reads its settings and the workspaces from this cache, never from disk
    // (the renderer saves through a debounce, so a disk read could be stale).
    dictationService?.setConfig(config)
    // App 2.7.0 (A7): labs.consoleChat off drops every desktop chat reader.
    chatIpc?.setConfig(config)
    // App 2.7.0 (E10 B1): labs.teams on loads the teams, off flushes and idles them.
    teamService?.setConfig(config)
  })

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
  win.on('focus', () => { win.flashFrame(false); statusManager.onWindowFocus() })

  // A renderer reload or crash leaves any ptys it had paused (backpressure)
  // stuck paused, which would starve connected phones. Resume them so the
  // remote data plane keeps flowing regardless of the desktop renderer.
  win.webContents.on('render-process-gone', () => ptyManager.resumeRendererPaused())
  // Hibernation waits for the new renderer's view before it plans again (E5-FR-25).
  win.webContents.on('render-process-gone', () => hibernation?.rendererGone())
  // Crash resilience (E4-FR-21, 25): auto reload behind the breaker; a hang
  // over 15 s asks [Wait] / [Reload window]. Neither path kills a pty.
  win.webContents.on('render-process-gone', (_e, details) => rendererRecovery.onGone(win, details))
  win.on('unresponsive', () => rendererRecovery.onUnresponsive(win))
  win.on('responsive', () => rendererRecovery.onResponsive())
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame) ptyManager.resumeRendererPaused()
    // E3-FR-23: a reloaded renderer re-learns which panes a phone sizes.
    if (details.isMainFrame && !details.isSameDocument) remoteManager.onRendererNavigate()
    if (details.isMainFrame && !details.isSameDocument) hibernation?.rendererGone()
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
    // Team runs (app 2.7.0, E10 B2) and the integrates in flight (B6: halted, their verify killed) stop with the app too.
    const liveRuns = teamService?.liveRunCount() ?? 0
    const integrates = teamService?.integrateCount() ?? 0
    if (shouldConfirm && (ptyManager.count > 0 || liveRuns > 0 || integrates > 0)) {
      const detail = [ptyManager.count > 0 ? mainT(cfg, 'dialog.activeDetail', { n: ptyManager.count }) : '', liveRuns + integrates > 0 ? mainT(cfg, 'teams.close.runs', { runs: liveRuns, integrates }) : '']
        .filter(Boolean)
        .join('\n')
      const choice = dialog.showMessageBoxSync(win, {
        type: 'question',
        buttons: [mainT(cfg, 'dialog.cancel'), mainT(cfg, 'dialog.closeAnyway')],
        defaultId: 1,
        cancelId: 0,
        noLink: true,
        title: BRAND.productName,
        message: mainT(cfg, 'dialog.activeTitle'),
        detail,
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
  wireSessionEnd(win, () => snapshotAgentsOnce('shutdown'), persistScrollbackForShutdown)

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
  // app 2.5.0: web permissions only for the app's own page; `media` only there and only audio
  // (dictation captures the microphone in the renderer and streams PCM to main).
  installPermissionHandlers(
    session.defaultSession,
    process.env.ELECTRON_RENDERER_URL || pathToFileURL(join(__dirname, '../renderer/index.html')).href,
  )
  dictationService = registerDictationIpc({ nvidia: () => nvidiaGpu })
  dictationService.setConfig(configStore.load())
  void app.getGPUInfo('basic').then(
    (info) => {
      nvidiaGpu = hasNvidiaGpu(info)
    },
    () => undefined,
  )
  registerAppIpc()
  registerConfigIpc()
  registerDialogIpc()
  registerClipboardIpc()
  // Headless mirror policy from the saved config before any pty spawns (E6-FR-01);
  // the renderer pushes every later change on pty:setEngine.
  ptyManager.setEngine(engineFromSettings(configStore.load()?.settings))
  // A preset's env (AgentPreset.env) from main's own config at every spawn and
  // restart: desktop, phone, CLI, resume and wake all land in PtyManager.
  ptyManager.setPresetEnvSource((paneId, presetHint) => resolvePresetEnv(configStore.load(), paneId, presetHint))
  // A Connection that stops at a secret step without text (an imported export) says so in the pane.
  ptyManager.setSetupNoticeSource((step) => mainT(configStore.load(), 'pty.setupSecretMissing', { n: step }))
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
  wirePowerShutdown(powerMonitor, persistScrollbackForShutdown)
  registerWindowIpc(() => mainWindow)
  registerSystemIpc(() => mainWindow?.webContents ?? null, openRequests)
  void handleOpenArgv(process.argv, process.cwd(), 'argv')
  registerUpdateIpc({
    getSender: () => mainWindow?.webContents ?? null,
    quitForUpdate,
    setInstalling: (v) => {
      isInstalling = v
      // The wizard did not proceed: team runs may start again.
      if (!v) teamService?.installAborted()
    },
    // The NSIS setup closes the app without a before-quit (E6-FR-10). Leaves
    // the exit flag alone: a cancelled wizard still saves on the next quit.
    persistBeforeInstall: async () => {
      reviewNotes?.flush()
      scrollbackCheckpoint?.persistAllSync()
      // Team runs interrupted and flushed, never frozen (a cancelled wizard keeps the app running). B6 integration:
      // the setup waits for an integrate land already running (a git killed mid checkout leaves it half updated),
      // then what the consoles printed meanwhile is saved again.
      const waited = (await teamService?.prepareInstall()) ?? 0
      if (waited > 0) {
        reviewNotes?.flush()
        scrollbackCheckpoint?.persistAllSync()
      }
    },
    // A silent update that did not land (declined permission prompt): read
    // and deleted once here, shown by the renderer as a toast with [Retry].
    notApplied: takeUpdateMarker(dataDir(), app.getVersion()),
  })
  // Claude multi-account (app 2.3.0): saved logins under dataDir()/claude-accounts/,
  // encrypted with safeStorage (needs app ready). Main is the only writer of the
  // live .credentials.json; nothing that leaves main carries a token.
  const vaultCrypto = electronCrypto()
  const accounts = new AccountService({
    vault: new AccountVault(join(dataDir(), 'claude-accounts'), vaultCrypto),
    crypto: vaultCrypto,
    // Team runs count as working Claude consoles for deferWhileWorking (app 2.7.0, E10 B2).
    statuses: () => [...statusManager.snapshot(), ...(teamService?.syntheticStatuses() ?? [])],
    emit: (s) => {
      const wc = mainWindow?.webContents
      if (wc && !wc.isDestroyed()) wc.send(CH.ACCOUNTS_CHANGED, s)
      teamService?.onAccounts()
    },
    event: (e) => {
      const wc = mainWindow?.webContents
      if (wc && !wc.isDestroyed()) wc.send(CH.ACCOUNTS_EVENT, e)
    },
    alert: ({ title, body }) => {
      statusManager.notifyCustom(null, title, body)
      noticeRouter?.routeCustom({ kind: 'custom', paneId: null, title, body })
    },
    // Language of the notices only (read when one fires, which is rare).
    config: () => configStore.load(),
    // The usage poller's normalized interval: no config read per policy run.
    usageIntervalMs: () => usageHandle.intervalMs(),
    usageEnabled: () => usageHandle.enabled(),
  })
  accountService = accounts
  // One usage handle { get, load, enabled, refreshClaudeNow, republish, intervalMs }: AccountService and snaos usage (4b).
  const usageHandle = registerUsageIpc({
    getSender: () => mainWindow?.webContents ?? null,
    getInitialConfig: () => configStore.load()?.settings?.usage ?? null,
    // A finished Codex turn refreshes the Codex usage bar.
    onStatus: (cb) => statusManager.addListener(cb),
    accounts: {
      windowsNeeded: () => accounts.windowsNeeded(),
      badge: () => accounts.badge(),
      onActiveResult: (rows, at) => accounts.onActiveUsage(rows, at),
      reconcile: () => void accounts.reconcile(),
    },
  })
  accounts.setUsageControl({ refreshActive: () => usageHandle.refreshClaudeNow(), republish: () => usageHandle.republish() })
  registerAccountsIpc(accounts)
  // snaos usage / account (app 2.3.0, 4b): the same usage handle, and an adapter
  // over AccountService that picks every field (no token, blob or email) and
  // switches with reason 'cli'. Before cliService.setEnabled below.
  cliService.attach({ usage: usageHandle, accounts: ctlAccountsView(accounts) })
  void accounts.init(configStore.load()?.settings?.claudeAccounts ?? null).catch(() => undefined)
  // The phone's (and the Share guests') git handler, captured when registerGitIpc hands it over.
  let remoteGitHandler: ((req: RemoteGitRequest) => Promise<RemoteGitReply>) | null = null
  // Worktree per console (E7-FR-27..32, 36): worktrees.json under dataDir().
  // Before the chip and the Files drawer: both ask it which folders it manages (app 2.7.0, A9).
  const worktrees = registerWorktreeIpc({
    loadConfig: () => configStore.load(),
    killPane: (paneId) => ptyManager.killPaneAndWait(paneId),
  })
  // Git chip (E7-FR-05..10); settings.gitChip is a schema 12 key, absent = on.
  registerGitIpc({
    getSender: () => mainWindow?.webContents ?? null,
    initialGitChip: (configStore.load()?.settings as { gitChip?: unknown } | undefined)?.gitChip !== false,
    // "main -N" of a pane on a managed worktree (app 2.7.0, A9).
    managedRepoOf: (dir) => worktrees.repoOf(dir),
    // The phone's gitReq (E7-FR-22..26) reads through the same GitService.
    setRemoteGit: (handler) => {
      // app 2.4.0: the same GitRemote handler answers the Share guests (read-only, scoped workspace).
      remoteGitHandler = handler
      remoteManager.setGitHandler(handler)
    },
  })
  // Review notes of the Changes panel (E7-FR-17..20): dataDir()/review-notes.json.
  reviewNotes = registerReviewNotesIpc({ getSender: () => mainWindow?.webContents ?? null })
  // Workspace notes (v2.2, E9): dataDir()/notes/<workspace>/<note>.md, also read and written by the phones.
  const wsNotes = registerWsNotesIpc({
    getSender: () => mainWindow?.webContents ?? null,
    onChanged: (evt) => {
      remoteManager.notesChanged(evt)
      shareHost?.notesChanged(evt)
    },
  })
  remoteManager.setNotes(wsNotes)
  // Files drawer (v2.2, E9): the workspace folder from the config, every target contained.
  // Share guests read it too (app 2.6.0, read-only, through the guest half).
  // app 2.7.0 (A9): a pane's tree is its managed worktree; resolveRefs reads relative refs from its spawn cwd.
  const fileService = registerFilesIpc({
    getSender: () => mainWindow?.webContents ?? null,
    config: () => configStore.load(),
    isManagedWorktree: (p) => worktrees.isManaged(p),
    spawnCwd: (paneId) => ptyManager.getSpawnCwd(paneId),
  })
  // Per-repo .snagentsos.json (E8-FR-23..27): trusted-repos.json under dataDir().
  registerRepoConfigIpc()
  registerRemoteIpc(remoteManager)
  shareGuest = registerShareGuestIpc({
    identities: shareIdentities(),
    guestName: () => configStore.load()?.settings?.share?.guestName ?? '',
    app: app.getVersion(),
    send: (channel, payload) => {
      const wc = mainWindow?.webContents
      if (wc && !wc.isDestroyed()) wc.send(channel, payload)
    },
  })
  // Links with a remembered password reconnect on their own; the rest wait for the user.
  shareGuest.autoConnect()
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
  // v2.4 `/rename`: the store keeps each session's last name (setting on or off), so a restart or a resume never re-applies it.
  statusManager.setAgentTitleSeed((paneId, provider, sessionId) => sessions.agentTitleFor(paneId, provider, sessionId))
  statusManager.onAgentRename((evt) => sessions.noteAgentTitle(evt.paneId, evt.provider, evt.sessionId, evt.title))
  // Hibernation (E5-FR-25, D3): explicit kill after the record is marked, so
  // the end that follows never closes the chat. Off (no interval) by default.
  hibernation = new HibernationCoordinator({
    statuses: () => statusManager.snapshot(),
    lastInputAt: (paneId) => ptyManager.lastInputAt(paneId),
    hasPty: (paneId) => ptyManager.ptyIdForPane(paneId) !== null,
    // Panes a phone or a Share guest watches never sleep.
    subscribedPaneIds: () => {
      const ids = remoteManager.subscribedPaneIds()
      for (const id of shareHost?.subscribedPaneIds() ?? []) ids.add(id)
      return ids
    },
    isAvailable: (paneId) => sessions.isAvailable(paneId),
    getConfig: () => configStore.load(),
    hibernate: (evt) => {
      sessions.markHibernated(evt.paneId)
      sendToRenderer(CH.AGENTS_HIBERNATE, evt)
      ptyManager.killPanes([evt.paneId])
    },
  })
  registerAgentsIpc(sessions, hibernation)
  // Session history (E3-FR-36..40): transcripts and rollouts indexed on demand,
  // for the phone's History screen and the createPane.resume check.
  const history = new SessionHistory({
    getConfig: () => configStore.load(),
    openSessions: () => openSessionsOf(statusManager.snapshot(), configStore.load()),
  })
  registerHistoryIpc(history)
  remoteManager.setHistory(history)
  // Chat view of the phone (E3 M12): transcripts located per console and
  // watched only while a phone reads them.
  const chatLocator: TranscriptLocator = new TranscriptLocator({
    claudeRoot: claudeConfigDir,
    codexSessions: sessionsRoot,
    config: () => configStore.load(),
    status: (paneId) => statusManager.transcriptFor(paneId),
    spawnCwd: (paneId) => ptyManager.getSpawnCwd(paneId),
    spawnedAt: (paneId) => statusManager.spawnedAt(paneId),
    runningPanes: () => ptyManager.runningPaneIds(),
    claims: () => chatHub.claims(),
    // Team transcripts in the repo root's slug folder are never a console's (built later: read lazily).
    teamSession: (id) => teamService?.ownsSession(id) ?? false,
  })
  const chatHub: ChatHub = new ChatHub({ locate: (paneId) => chatLocator.locate(paneId) })
  statusManager.onTranscriptChange((paneId) => chatHub.transcriptChanged(paneId))
  remoteManager.setChat(chatHub)
  // Desktop console chat (app 2.7.0, A7; labs.consoleChat): one ChatHub reader per window.
  chatIpc = registerChatIpc({ hub: chatHub, config: () => configStore.load(), running: (paneId) => ptyManager.ptyIdForPane(paneId) !== null })
  // snaos notes / chat / peek (app 2.3.0): the same notes store as the drawer and
  // the phones; transcripts through the locator only, read one-shot (never a
  // ChatHub reader, so no watcher opens: FR-35 holds). Before setEnabled below.
  cliService.attach({ notes: wsNotes, chat: { locate: (paneId) => chatLocator.locate(paneId) } })
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
  // One presence rule: a phone OR a Share guest counts (the phone listener only fires on phone flips).
  const updatePresence = (): void => awake.setPhoneConnected(remoteManager.phoneConnected || (shareHost?.guestCount ?? 0) > 0)
  remoteManager.setPhoneListener(() => updatePresence())
  // Share host (app 2.4.0, item 8): grants under dataDir(), the identity store shared with the guest half.
  const shareGrants = new GrantStore(shareGrantsPath(), electronCrypto())
  shareGrants.load()
  const host = new ShareHost({
    pty: ptyManager,
    remote: remoteManager,
    grants: shareGrants,
    hostKey: () => shareIdentities().get('host'),
    listen: (port, onTransport) => new ShareServer(port, onTransport),
    endpoints: (port) => listEndpoints(port),
    appVersion: app.getVersion(),
    platform: process.platform === 'darwin' || process.platform === 'linux' ? process.platform : 'win32',
    hostLabel: () => {
      try {
        return hostname()
      } catch {
        return ''
      }
    },
    statuses: () => statusManager.snapshot(),
    chat: () => chatHub,
    git: () => remoteGitHandler,
    // The same notes path as the phones (the host checked the guest's caps and forced its workspace).
    notes: () => (req) => runNotesRequest(wsNotes, req),
    files: () => ({
      list: (workspaceId, rel, max) => fileService.guestList(workspaceId, rel, max),
      read: (workspaceId, rel, limits) => fileService.guestRead(workspaceId, rel, limits),
      acquireWatch: (workspaceId, owner, cb) => fileService.acquireWatch(workspaceId, owner, cb),
      releaseWatch: (workspaceId, owner) => fileService.releaseWatch(workspaceId, owner),
    }),
    guestLabel: (name) => mainT(configStore.load(), 'share.guestLabel', { name }),
    guestFallback: () => mainT(configStore.load(), 'share.guestFallback'),
    onHostEvent: (state) => sendToRenderer(CH.SHARE_HOST_EVENT, state),
    onPanes: (panes) => sendToRenderer(CH.SHARE_PANES, panes),
    onGuestsChanged: (count) => {
      updatePresence()
      // Relayed ctl (createPane/closePane) must run while the window sits in the tray.
      remoteManager.setThrottleHold('share', count > 0)
    },
    onApproval: (a) => {
      if (mainWindow?.isFocused() || !Notification.isSupported()) return
      const cfg = configStore.load()
      const n = new Notification({ title: mainT(cfg, 'share.joinTitle'), body: mainT(cfg, 'share.joinBody', { name: a.guestName, ip: a.ip, scope: a.grantLabel }) })
      n.on('click', () => showWindow())
      n.show()
    },
  })
  shareHost = host
  ptyManager.addSink(host.sink)
  remoteManager.onSnapshot((snap) => host.onSnapshot(snap))
  registerShareHostIpc(host)
  updatePresence()
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
  // Teams (app 2.7.0, E10 B1): main owns every team; the invoke is registered even with the lab off.
  // A pane id only while its pty is alive (a closed console holds no session).
  const livePane = (paneId: string | null | undefined): string | null => (paneId && ptyManager.ptyIdForPane(paneId) !== null ? paneId : null)
  const teams = new TeamService({
    dataDir,
    config: () => configStore.load(),
    git: gitRunner,
    // B8: the phones hear of every change too (RemoteManager throttles it per team); Share never does.
    emit: (evt) => {
      sendToRenderer(CH.TEAMS_CHANGED, evt)
      remoteManager.teamChanged(evt)
    },
    // '' when it opened, else Electron's error text: the reveal op answers io with it.
    openPath: (p) => shell.openPath(p),
    log: createTeamsLog(dataDir),
    // B2 (runs): the consoles' status, who holds a session, the ptys, the accounts, the CLI and Awake.
    status: {
      snapshot: () => statusManager.snapshot(),
      stateOf: (paneId) => statusManager.stateOf(paneId),
      paneForSession: (sessionId) => statusManager.paneForSession(sessionId),
    },
    sessionHolder: (provider, sessionId) => {
      const precise = livePane(statusManager.paneForSession(sessionId))
      if (precise) return precise
      const rec = agentSessions?.list().find((v) => v.provider === provider && v.sessionId === sessionId && livePane(v.paneId))
      if (rec) return rec.paneId
      for (const ws of configStore.load()?.workspaces ?? []) {
        for (const p of ws.panes) if (p.lastSession?.provider === provider && p.lastSession.sessionId === sessionId && livePane(p.id)) return p.id
      }
      return null
    },
    pty: {
      spawnCwd: (id) => ptyManager.getSpawnCwd(id),
      ptyIdForPane: (id) => ptyManager.ptyIdForPane(id),
      killPaneAndWait: (id) => ptyManager.killPaneAndWait(id),
    },
    accounts: () => accountService?.status() ?? null,
    cli: {
      envForTeam: (runId, teamId, agentId, roleKind) => cliService.envForTeam(runId, teamId, agentId, roleKind),
      revokeTeam: (runId) => cliService.revokeTeam(runId),
      ready: () => cliService.ready(),
      // B5 integration, sixth round: the live tokens refuse a Codex block action and are masked in a run's chat rows.
      holdsToken: (text) => cliService.tokens.holdsToken(text),
      maskTokens: (text) => cliService.tokens.maskTokens(text),
    },
    // Synthetic `team:<runId>` statuses reach only AwakeService (and AccountService through statuses), never StatusManager.
    awake: (evt) => awakeService?.onPaneStatus(evt),
    sendRun: (evt) => sendToRenderer(CH.TEAMS_RUN_APPEND, evt),
    sendIntegrate: (evt) => sendToRenderer(CH.TEAMS_INTEGRATE_PROGRESS, evt),
    // B4: task worktrees through the console worktree service, tagged with their team owner (decision 63).
    worktrees,
    // B5: a new "Te necesita" row (an approval, a card, the trust, an auth or billing pause) as a desktop toast; B8 also
    // routes it to the phone push, Discord and ntfy (routeTeam: the away gate; nothing remote for a push: false one).
    notice: (n) => {
      statusManager.notifyCustom(null, n.title, n.body)
      noticeRouter?.routeTeam(n)
    },
  })
  teamService = teams
  // B8: teamReq and the phone's three Teams ctls reach the service from the phone sessions (origin phone).
  remoteManager.setTeams(teams.remoteView)
  statusManager.addListener((evt) => teams.onPaneStatus(evt))
  cliService.onState(() => teams.onCliState())
  // B3: `snaos team` from a team run's token reaches the store through teamCtl.
  cliService.attach({ teams: teams.ctlView })
  registerTeamsIpc(teams)
  const startupCfg = configStore.load()
  // v2.4: on by default (schema 17), a first run without a config included.
  await codexBridge.configure(startupCfg?.settings.notifications.codexEnabled ?? true)
  statusManager.setAgentSettings(startupCfg?.settings.agents)
  // snaos CLI: shim, skill refresh and PATH first; switched on before the first console spawns.
  registerCliIpc(cliService)
  cliService.init()
  void cliService.setEnabled(startupCfg?.settings?.cliEnabled !== false)
  void teams.start(startupCfg)
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
  // Share listener: only while settings.share.enabled and a live grant exist.
  shareHost?.applyConfig(startupCfg?.settings?.share ?? null)
  statusIpc?.applyStartup(startupCfg?.settings?.notifications)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      // macOS: the window closed but the app lived on; record sessions again.
      agentSessions?.thaw()
      teamService?.thaw()
      openMainWindow()
    }
  })
  // A Windows session end the OS cancelled leaves the app alive after the exit hooks: a focus thaws Teams (no-op otherwise).
  app.on('browser-window-focus', () => teamService?.thaw())
}

// The uninstaller (build/installer.nsh customUnInit) runs the exe with
// --cleanup-user-path: drop <dataDir>/bin from the user PATH and exit, no
// window, no lock (E8-FR-22). Only that entry; a portable never added one.
if (process.argv.includes('--cleanup-user-path')) {
  void removeFromUserPath(join(dataDir(), 'bin'))
    .catch(() => false)
    .finally(() => app.exit(0))
} else if (!app.requestSingleInstanceLock()) {
  // Single-instance lock: if another copy is already running (e.g. hidden in the
  // system tray), hand off to it and quit this one instead of opening a duplicate.
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
  // Really quitting: a later focus or request never thaws Teams again.
  teamService?.markQuitting()
  snapshotAgentsOnce('quit')
  // Shut the remote server first (best-effort, non-blocking) so phones get a
  // shutdown frame before the ptys they mirror are torn down.
  remoteManager.shutdown('quit')
  // Share guests get ended{host_quit} before their ptys go.
  shareHost?.shutdown()
  // runtime.json goes (only when it is ours) and the control server closes.
  cliService.shutdown()
  persistScrollbackOnExit()
  ptyManager.killAll()
  afterPtysKilled()
  scrollbackCheckpoint?.stop()
  awakeService?.dispose()
  dictationService?.dispose()
  shareGuest?.dispose()
  accountService?.dispose()
  // The only place the Teams DeadlineTimer is disposed (shutdownSync above only cleared its keys).
  teamService?.dispose()
  statusManager.dispose()
  codexBridge.dispose()
  discordNotifier.dispose()
  ntfyNotifier.dispose()
  void hookServer.stop()
  destroyTray()
})

app.on('will-quit', () => {
  teamService?.markQuitting()
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  // The ptys die below, so the agent snapshot goes first (E5-FR-06).
  snapshotAgentsOnce('quit')
  // On darwin the app stays alive with no window; still stop the server so it
  // isn't left listening without any UI to approve pairings.
  remoteManager.shutdown('quit')
  shareHost?.shutdown()
  persistScrollbackOnExit()
  ptyManager.killAll()
  afterPtysKilled()
  if (process.platform !== 'darwin') app.quit()
})
