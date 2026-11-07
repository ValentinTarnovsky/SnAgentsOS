import { spawn } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { BrowserWindow, globalShortcut, ipcMain, net, utilityProcess } from 'electron'
import { CH } from '@shared/ipc-channels'
import { labOn } from '@shared/labs'
import type { VoiceInstallProgress } from '@shared/voice'
import type { ConfigFile } from '@shared/types'
import { electronCrypto } from '../accounts/safeCrypto'
import { defaultTarPath, extractWithTar, statfsFreeBytes, WhisperInstaller } from '../dictation/whisper/WhisperInstaller'
import { netFetch } from '../dictation/whisper/netFetch'
import { createDictationLog } from '../dictation/DictationService'
import { dataDir } from '../paths'
import { treeKillSync } from '../proc/treeKill'
import { claudeConfigDir } from '../status/statusDetails'
import { resolveAgentCli, spawnTarget } from '../teams/agentCli'
import { packPaths, voiceDir, voiceInstallerCatalog, VOICE_PACK_ID } from '../voice/catalog'
import { ElevenLabs, type FetchLike } from '../voice/ElevenLabs'
import { LocalTts, type WorkerLike } from '../voice/LocalTts'
import { PhraseCache } from '../voice/PhraseCache'
import { Summarizer } from '../voice/Summarizer'
import { VoiceService, type VoiceStatusSource } from '../voice/VoiceService'
import type { VoiceSettings } from '@shared/voice'

export interface VoiceIpcOptions {
  getConfig: () => ConfigFile | null
  status: VoiceStatusSource
  /** Keeps the renderer unthrottled while hands-free listens (RemoteManager.setThrottleHold). */
  throttleHold: (on: boolean) => void
  dictationReady: () => boolean
}

export interface VoiceIpc {
  service: VoiceService
  /** CONFIG_SAVE and boot: the lab, the settings and the global hotkey. */
  configure(cfg: ConfigFile | null): void
  dispose(): void
}

/** narrator@better-claude is on in the user's Claude settings (read only, never written). */
function narratorModOn(): boolean {
  try {
    const raw = JSON.parse(readFileSync(join(claudeConfigDir(), 'settings.json'), 'utf8').replace(/^﻿/, '')) as { enabledPlugins?: Record<string, unknown> }
    return raw?.enabledPlugins?.['narrator@better-claude'] === true
  } catch {
    return false
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/**
 * Hands-free voice channels (app 2.11.0, contract `voice:*`, Labs voice).
 * Desktop IPC only. The renderer never sends a path, a URL or text to say:
 * phrase keys and roster ids, which VoiceService checks. Returns the service
 * and the config hook index.ts calls on every save.
 */
export function registerVoiceIpc(opts: VoiceIpcOptions): VoiceIpc {
  const dir = voiceDir(dataDir())
  // The voice log shares the dictation log's format and rotation, in its own file.
  const log = createDictationLog(dataDir(), Date.now, 'voice.log')
  const supported = process.platform === 'win32' && process.arch === 'x64'
  let cfg = opts.getConfig()
  // Filled once the service exists: engines and the cache read the settings it normalized.
  const current = (): VoiceSettings => service.currentSettings

  const installer = new WhisperInstaller({
    dir,
    fetch: netFetch,
    extract: extractWithTar(defaultTarPath()),
    freeBytes: statfsFreeBytes,
    warmup: async () => true,
    emit: (p) => {
      const out: VoiceInstallProgress = { phase: p.phase, transferred: p.transferred, total: p.total, ...(p.error ? { error: p.error } : {}) }
      broadcast(CH.VOICE_INSTALL_PROGRESS, out)
    },
    log,
    platform: process.platform,
    arch: process.arch,
    catalog: voiceInstallerCatalog(),
  })
  const installedPaths = (): { addon: string; model: string } | null => {
    try {
      const have = installer.installed()
      return have.has('voice-runtime' as never) && have.has('voice-model' as never) ? packPaths(dir) : null
    } catch {
      return null
    }
  }
  const local = new LocalTts({
    fork: () => utilityProcess.fork(join(__dirname, 'voiceWorker.js'), [], { serviceName: 'snagentsos-voice', stdio: 'ignore' }) as unknown as WorkerLike,
    paths: installedPaths,
    threads: 2,
    log,
  })
  const eleven = new ElevenLabs({
    dir,
    crypto: electronCrypto(),
    fetch: ((url, init) => net.fetch(url, init as RequestInit)) as FetchLike,
    settings: () => current().eleven,
    log,
  })
  const summarizer = new Summarizer({
    resolve: (env) => {
      const cli = resolveAgentCli('claude', env, { skipDirs: [join(dataDir(), 'bin')] })
      return cli ? spawnTarget(cli, []) : null
    },
    spawn: (file, args, o) => spawn(file, args, o),
    kill: (pid) => {
      treeKillSync(pid)
    },
    cwd: join(dir, 'summarizer'),
    log,
  })
  const cache = new PhraseCache(join(dir, 'cache'), (): number => current().eleven.cacheMaxMb * 1024 * 1024)

  const service: VoiceService = new VoiceService({
    getConfig: () => cfg,
    status: opts.status,
    installer: installer as never,
    local,
    eleven,
    summarizer,
    cache,
    send: (msg) => broadcast(msg.ch === 'play' ? CH.VOICE_PLAY : CH.VOICE_EVENT, msg.payload),
    throttleHold: opts.throttleHold,
    dictationReady: opts.dictationReady,
    narratorMod: narratorModOn,
    supported,
    log,
  })

  let hotkey = ''
  const applyHotkey = (): void => {
    const wanted = labOn(cfg?.settings, 'voice') ? current().globalHotkey : ''
    if (wanted === hotkey) return
    if (hotkey) {
      try {
        globalShortcut.unregister(hotkey)
      } catch {
        /* never registered */
      }
    }
    hotkey = ''
    if (!wanted) return
    try {
      if (globalShortcut.register(wanted, () => broadcast(CH.VOICE_EVENT, { t: 'toggle' }))) hotkey = wanted
      else log('hotkey taken')
    } catch {
      log('hotkey invalid')
    }
  }

  ipcMain.handle(CH.VOICE_STATUS, () => service.status())
  ipcMain.handle(CH.VOICE_SET_ACTIVE, (_e, on: unknown) => service.setActive(on === true))
  ipcMain.on(CH.VOICE_ROSTER, (_e, roster: unknown) => service.setRoster(roster))
  ipcMain.on(CH.VOICE_MODE, (_e, mode: unknown) => service.setMode(mode))
  ipcMain.handle(CH.VOICE_CMD, (_e, cmd: unknown) => service.cmd(cmd))
  ipcMain.on(CH.VOICE_PLAYED, (_e, res: unknown) => {
    const id = res && typeof res === 'object' ? (res as { id?: unknown }).id : undefined
    service.played(id)
  })
  ipcMain.handle(CH.VOICE_INSTALL, () => service.install())
  ipcMain.handle(CH.VOICE_CANCEL_INSTALL, () => service.cancelInstall())
  ipcMain.handle(CH.VOICE_REMOVE, () => service.remove())
  ipcMain.handle(CH.VOICE_SET_KEY, (_e, key: unknown) => (key === null || typeof key === 'string' ? eleven.setKey(key) : { ok: false, error: 'bad_key' }))
  ipcMain.handle(CH.VOICE_TEST_ELEVEN, () => eleven.test())
  ipcMain.handle(CH.VOICE_PREVIEW, () => service.preview())
  ipcMain.handle(CH.VOICE_WARM_PHRASES, (_e, req: unknown) => service.warmPhrases(!!(req && typeof req === 'object' && (req as { dryRun?: unknown }).dryRun === true)))
  ipcMain.handle(CH.VOICE_CLEAR_CACHE, () => service.clearCache())

  applyHotkey()
  return {
    service,
    configure(next) {
      cfg = next
      service.configure(next)
      applyHotkey()
    },
    dispose() {
      if (hotkey) {
        try {
          globalShortcut.unregister(hotkey)
        } catch {
          /* gone */
        }
      }
      service.dispose()
      local.dispose()
      summarizer.dispose()
      installer.cancel(VOICE_PACK_ID as never)
    },
  }
}
