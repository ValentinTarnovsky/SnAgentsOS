import { ipcMain, type WebContents } from 'electron'
import { CH } from '@shared/ipc-channels'
import type { InstallKind, UpdateInfo, UpdateNotApplied, UpdateProgress, UpdateState } from '@shared/ipc-contract'
import { checkForUpdate, downloadAndInstall } from '../updater'
import { isUpdateBusy, updateState as sharedState, type UpdateStateStore } from '../updateState'

interface UpdateIpcHooks {
  getSender: () => WebContents | null
  /** Quit + relaunch for an applied update (bypasses tray-hide / close confirm). */
  quitForUpdate: () => void
  /** Reports whether an install is in flight so the main process can block close. */
  setInstalling: (installing: boolean) => void
  /**
   * Saves the scrollback synchronously right before the NSIS setup starts
   * (E6-FR-10). Only the Windows installer: the portable swap and the
   * AppImage quit through before-quit, which saves on its own.
   */
  persistBeforeInstall?: () => void
  /**
   * The silent update that did not land, read from the marker at start (app
   * 2.4.0). `update:notApplied` hands it out once, then answers null.
   */
  notApplied?: UpdateNotApplied | null
  /** Test seams: the check/install implementations and the state store. */
  check?: () => Promise<UpdateInfo>
  install?: (onProgress: (p: UpdateProgress) => void, opts?: { beforeApply?: (kind: InstallKind) => void }) => Promise<{ relaunching: boolean }>
  state?: UpdateStateStore
}

/**
 * Auto-update IPC.
 *  - `update:check`    -> UpdateInfo (queries GitHub releases)
 *  - `update:getState` -> UpdateState (main owns phase/progress/error/info, E4-FR-37)
 *  - `update:install`  -> downloads + verifies the matching asset, streams
 *                         progress on `update:progress`, then runs it. When the
 *                         build relaunches itself (Windows portable / Linux
 *                         AppImage, the silent NSIS setup) it calls
 *                         `quitForUpdate`; mac/.deb, and the NSIS wizard when the
 *                         silent setup cannot start, open and leave the app
 *                         running. A second call while one runs joins it.
 *  - `update:state`    -> pushed on every phase change.
 *  - `update:notApplied` -> UpdateNotApplied | null, one-shot (app 2.4.0).
 */
export function registerUpdateIpc(hooks: UpdateIpcHooks): void {
  const { getSender, quitForUpdate, setInstalling } = hooks
  const check = hooks.check ?? checkForUpdate
  const install = hooks.install ?? downloadAndInstall
  const state = hooks.state ?? sharedState

  const send = (channel: string, payload: UpdateProgress | UpdateState): void => {
    const wc = getSender()
    if (wc && !wc.isDestroyed()) wc.send(channel, payload)
  }

  // The close guard follows main's phase, the same one the title bar's close
  // button mirrors, so both agree on "an install is running".
  state.onChange((s) => {
    setInstalling(isUpdateBusy(s.phase))
    send(CH.UPDATE_STATE, s)
  })

  /** The running install; a second `update:install` joins it instead of downloading again. */
  let inflight: Promise<{ relaunching: boolean }> | null = null

  ipcMain.handle(CH.UPDATE_CHECK, (): Promise<UpdateInfo> => check())

  ipcMain.handle(CH.UPDATE_GET_STATE, (): UpdateState => state.get())

  let notApplied = hooks.notApplied ?? null
  ipcMain.handle(CH.UPDATE_NOT_APPLIED, (): UpdateNotApplied | null => {
    const out = notApplied
    notApplied = null
    return out
  })

  ipcMain.handle(CH.UPDATE_INSTALL, (): Promise<{ relaunching: boolean }> => {
    if (inflight) return inflight
    const run = async (): Promise<{ relaunching: boolean }> => {
      state.begin()
      try {
        const result = await install(
          (p) => {
            state.progress(p)
            send(CH.UPDATE_PROGRESS, p)
          },
          {
            beforeApply: (kind) => {
              if (kind === 'win-installer') hooks.persistBeforeInstall?.()
            },
          },
        )
        state.installed(result.relaunching)
        if (result.relaunching) {
          // Give the renderer a tick to settle, then quit so the swap can run.
          setTimeout(quitForUpdate, 400)
        }
        return result
      } catch (err) {
        const message = (err as { message?: unknown } | null)?.message
        state.failed(typeof message === 'string' ? message : String(err))
        throw err
      }
    }
    const current = run().finally(() => {
      inflight = null
    })
    inflight = current
    return current
  })
}
