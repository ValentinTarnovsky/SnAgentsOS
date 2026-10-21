import { spawn } from 'child_process'
import { mkdirSync, readFileSync, rmSync } from 'fs'
import { promises as fsp } from 'fs'
import { availableParallelism } from 'os'
import { join } from 'path'
import { BrowserWindow, ipcMain, shell, type WebContents } from 'electron'
import { CH } from '@shared/ipc-channels'
import type { DictationEvt, DictationStartRes } from '@shared/ipc-contract'
import { isWhisperPackId, type WhisperInstallError, type WhisperInstallProgress, type WhisperStatus } from '@shared/dictation'
import { createDictationLog, DictationService, dictationSettingsUri, engineThreads } from '../dictation/DictationService'
import { ASSETS, whisperDir, type EnginePlan } from '../dictation/whisper/catalog'
import { netFetch } from '../dictation/whisper/netFetch'
import { createVcRuntimeCheck, regQuery } from '../dictation/whisper/vcRuntime'
import { defaultTarPath, extractWithTar, statfsFreeBytes, WhisperInstaller } from '../dictation/whisper/WhisperInstaller'
import {
  freeLocalPort,
  killOrphan,
  newServerToken,
  processExePath,
  WhisperServer,
  type ServerChild,
  type ServerSpec,
} from '../dictation/whisper/WhisperServer'
import { writeAtomic } from '../fsAtomic'
import { dataDir } from '../paths'

export interface DictationIpcOptions {
  /** An NVIDIA GPU is present: index.ts caches app.getGPUInfo('basic') at bootstrap. */
  nvidia: () => boolean
}

/**
 * `server.json`: the live whisper-server pids (the session server and the
 * warmup one), so a crash of main leaves no orphan behind. Writes are atomic
 * and serialized after the boot cleanup; the file goes when no server lives.
 */
function pidFile(dir: string, after: Promise<unknown>): (name: string) => (pid: number | null) => void {
  const live = new Map<string, { pid: number; startedAt: number }>()
  let chain: Promise<unknown> = after.catch(() => undefined)
  const file = join(dir, 'server.json')
  const flush = (): void => {
    const servers = [...live.entries()].map(([name, v]) => ({ name, pid: v.pid, startedAt: v.startedAt }))
    chain = chain
      .then(async () => {
        if (servers.length) {
          await fsp.mkdir(dir, { recursive: true })
          await writeAtomic(file, JSON.stringify({ servers }))
        } else {
          await fsp.rm(file, { force: true })
        }
      })
      .catch(() => undefined)
  }
  return (name) => (pid) => {
    if (pid === null) {
      if (!live.delete(name)) return
    } else {
      live.set(name, { pid, startedAt: Date.now() })
    }
    flush()
  }
}

/**
 * Desktop dictation channels (app 2.5.0, contract `dictation:*`): the local
 * Whisper engine, its packs and the capture stream. Desktop IPC only, never
 * on the phone protocol.
 *
 *  - The session belongs to the webContents that started it: its reload,
 *    crash or close ends it. Audio from any other sender is dropped.
 *  - Pack ids come from PACK_IDS only; the renderer never sends a path.
 *  - openSettings maps to two fixed targets (the microphone privacy page and
 *    the VC++ runtime download) and never takes a URL.
 *  - Install progress goes to every window.
 * Returns the service: index.ts feeds it the config cache and disposes it on quit.
 */
export function registerDictationIpc(opts: DictationIpcOptions): DictationService {
  const dir = whisperDir(dataDir())
  const log = createDictationLog(dataDir())
  const publicDir = join(dir, 'public-empty')
  if (process.platform === 'win32') {
    try {
      mkdirSync(publicDir, { recursive: true })
    } catch {
      /* the server start fails later and says so */
    }
  }
  // A server left behind by a crash of main: only ours (image path under `dir`).
  const orphans =
    process.platform === 'win32'
      ? killOrphan(dir, {
          readText: (f) => {
            try {
              return readFileSync(f, 'utf8')
            } catch {
              return null
            }
          },
          processPath: (pid) => processExePath(pid),
          kill: (pid) => process.kill(pid),
          remove: (f) => rmSync(f, { force: true }),
          log,
        })
      : Promise.resolve(0)
  const writePid = pidFile(dir, orphans)
  let servers = 0

  const spec = (plan: EnginePlan): ServerSpec => {
    const runtime = join(dir, ASSETS[plan.runtime].target)
    return {
      device: plan.device,
      exe: join(runtime, 'whisper-server.exe'),
      cwd: runtime,
      model: join(dir, ASSETS[plan.model].target),
      vadModel: join(dir, ASSETS.vad.target),
      publicDir,
      threads: engineThreads(plan.device, availableParallelism()),
      ...(plan.device === 'gpu' ? { cudaCache: join(dir, 'cuda-cache') } : {}),
    }
  }

  const broadcast = (p: WhisperInstallProgress): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send(CH.DICTATION_INSTALL_PROGRESS, p)
    }
  }

  // The installer's warmup calls back into the service, built right after it.
  let service: DictationService | null = null
  const installer = new WhisperInstaller({
    dir,
    fetch: netFetch,
    extract: extractWithTar(defaultTarPath()),
    freeBytes: statfsFreeBytes,
    warmup: (pack) => (service ? service.warmup(pack) : Promise.resolve(false)),
    emit: broadcast,
    log,
    platform: process.platform,
    arch: process.arch,
  })
  const svc = new DictationService({
    platform: process.platform,
    arch: process.arch,
    installer,
    createServer: () =>
      new WhisperServer({
        spawn: (exe, args, o) => spawn(exe, args, o) as unknown as ServerChild,
        freePort: freeLocalPort,
        token: newServerToken,
        log,
        writePid: writePid(`s${++servers}`),
      }),
    spec,
    nvidia: opts.nvidia,
    vcRuntime: createVcRuntimeCheck(regQuery()),
    whisperDir: dir,
    log,
  })
  service = svc

  const wired = new WeakSet<WebContents>()
  const watch = (wc: WebContents): void => {
    if (wired.has(wc)) return
    wired.add(wc)
    const id = wc.id
    wc.on('destroyed', () => svc.stopOwner(id))
    wc.on('render-process-gone', () => svc.stopOwner(id))
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) svc.stopOwner(id)
    })
  }

  ipcMain.handle(CH.DICTATION_START, (e, req: unknown): Promise<DictationStartRes> => {
    const wc = e.sender
    watch(wc)
    return svc.start(
      wc.id,
      (evt: DictationEvt) => {
        if (!wc.isDestroyed()) wc.send(CH.DICTATION_EVENT, evt)
      },
      req,
    )
  })
  ipcMain.handle(CH.DICTATION_STOP, (e, sessionId: unknown): void => {
    if (typeof sessionId === 'string') svc.stop(sessionId, e.sender.id)
  })
  ipcMain.on(CH.DICTATION_AUDIO, (e, sessionId: unknown, pcm: unknown) => {
    if (typeof sessionId === 'string') svc.audio(sessionId, e.sender.id, pcm)
  })
  ipcMain.handle(CH.DICTATION_OPEN_SETTINGS, async (_e, page: unknown): Promise<boolean> => {
    const uri = process.platform === 'win32' ? dictationSettingsUri(page) : null
    if (!uri) return false
    return shell.openExternal(uri).then(
      () => true,
      () => false,
    )
  })
  ipcMain.handle(CH.DICTATION_MODELS, (): Promise<WhisperStatus> => svc.status())
  ipcMain.handle(CH.DICTATION_INSTALL, (_e, pack: unknown): Promise<{ ok: boolean; error?: WhisperInstallError }> => {
    if (!isWhisperPackId(pack)) return Promise.resolve({ ok: false, error: 'unsupported' })
    return svc.install(pack)
  })
  ipcMain.handle(CH.DICTATION_CANCEL_INSTALL, (_e, pack: unknown): void => {
    if (isWhisperPackId(pack)) svc.cancelInstall(pack)
  })
  ipcMain.handle(CH.DICTATION_REMOVE, (_e, pack: unknown): Promise<{ ok: boolean; error?: WhisperInstallError }> => {
    if (!isWhisperPackId(pack)) return Promise.resolve({ ok: false, error: 'unsupported' })
    return svc.remove(pack)
  })
  return svc
}
