import { app, BrowserWindow, ipcMain, type WebContents } from 'electron'
import { isAbsolute } from 'path'
import { CH } from '@shared/ipc-channels'
import type { GitInfoRes, GitUpdateEvt } from '@shared/git-types'
import { gitRunner } from '../git/gitExec'
import { GitService, sanitizeTargets } from '../git/GitService'

export interface GitIpcDeps {
  getSender: () => WebContents | null
  /** settings.gitChip at boot (the renderer re-pushes it once hydrated). */
  initialGitChip: boolean
}

/** Debug counters go to the log at most this often, and only when they moved. */
const STATS_LOG_MS = 5 * 60 * 1000

/**
 * Git chip channels (E7-FR-05..10, names per PLAN D6): `git:setWatch`,
 * `git:setConfig`, `git:refresh`, `git:info` in, `git:update` out. Creates the
 * GitService and follows window focus for its focus refresh and active poll.
 */
export function registerGitIpc(deps: GitIpcDeps): GitService {
  const service = new GitService({
    runner: gitRunner,
    emit: (evt: GitUpdateEvt) => {
      const wc = deps.getSender()
      if (wc && !wc.isDestroyed()) wc.send(CH.GIT_UPDATE, evt)
    },
  })
  service.setEnabled(deps.initialGitChip)

  ipcMain.on(CH.GIT_SET_WATCH, (_e, targets: unknown) => service.setTargets(sanitizeTargets(targets, isAbsolute)))
  ipcMain.on(CH.GIT_SET_CONFIG, (_e, cfg: { gitChip?: unknown } | null) => {
    if (cfg && typeof cfg === 'object' && typeof cfg.gitChip === 'boolean') service.setEnabled(cfg.gitChip)
  })
  ipcMain.on(CH.GIT_REFRESH, (_e, p: { keys?: unknown; reason?: unknown } | null) => {
    const keys = Array.isArray(p?.keys) ? p.keys.filter((k): k is string => typeof k === 'string').slice(0, 200) : undefined
    service.refresh(keys, p?.reason === 'agent' ? 'agent' : 'manual')
  })
  ipcMain.handle(CH.GIT_INFO, (_e, p: { force?: unknown } | null): Promise<GitInfoRes> => gitRunner.info(p?.force === true))

  app.on('browser-window-focus', () => service.setFocused(true))
  app.on('browser-window-blur', () => service.setFocused(BrowserWindow.getFocusedWindow() != null))
  service.setFocused(BrowserWindow.getFocusedWindow() != null)

  let last = ''
  const statsTimer = setInterval(() => {
    const line = `[git] runs=${service.stats.runs} watchEvents=${service.stats.watchEvents} watched=${service.watchedCount()}`
    if (line !== last) console.debug(line)
    last = line
  }, STATS_LOG_MS)
  statsTimer.unref?.()
  app.once('before-quit', () => {
    clearInterval(statsTimer)
    service.dispose()
  })
  return service
}
