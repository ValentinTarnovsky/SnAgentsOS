import { spawn } from 'child_process'
import { join } from 'path'
import { ipcMain, shell, type WebContents } from 'electron'
import { CH } from '@shared/ipc-channels'
import type { DictationEvt, DictationStartRes } from '@shared/ipc-contract'
import { createDictationLog, DictationService, dictationSettingsUri, type HelperChild } from '../dictation/DictationService'
import { dataDir } from '../paths'

/** Absolute path, so a powershell.exe earlier in PATH is never picked up. */
function powershellExe(): string {
  return join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/**
 * Desktop dictation channels (app 2.4.0, contract `dictation:*`). The session
 * belongs to the webContents that started it: its reload, crash or close
 * kills the helper. openSettings maps to two fixed ms-settings URIs and
 * never takes a URL. Returns the service so index.ts disposes it on quit.
 */
export function registerDictationIpc(): DictationService {
  const service = new DictationService({
    platform: process.platform,
    exe: powershellExe,
    spawn: (exe, args, opts) => spawn(exe, args, opts) as unknown as HelperChild,
    env: () => process.env,
    log: createDictationLog(dataDir()),
  })
  const wired = new WeakSet<WebContents>()
  const watch = (wc: WebContents): void => {
    if (wired.has(wc)) return
    wired.add(wc)
    const id = wc.id
    wc.on('destroyed', () => service.stopOwner(id))
    wc.on('render-process-gone', () => service.stopOwner(id))
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) service.stopOwner(id)
    })
  }

  ipcMain.handle(CH.DICTATION_START, (e, req: unknown): DictationStartRes => {
    const wc = e.sender
    watch(wc)
    return service.start(wc.id, (evt: DictationEvt) => {
      if (!wc.isDestroyed()) wc.send(CH.DICTATION_EVENT, evt)
    }, req)
  })
  ipcMain.handle(CH.DICTATION_STOP, (e, sessionId: unknown): void => {
    if (typeof sessionId === 'string') service.stop(sessionId, e.sender.id)
  })
  ipcMain.handle(CH.DICTATION_OPEN_SETTINGS, async (_e, page: unknown): Promise<boolean> => {
    const uri = process.platform === 'win32' ? dictationSettingsUri(page) : null
    if (!uri) return false
    return shell.openExternal(uri).then(() => true, () => false)
  })
  return service
}
