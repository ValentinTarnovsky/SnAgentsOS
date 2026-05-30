import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CH } from '@shared/ipc-channels'
import type {
  AppInfo,
  AppMetrics,
  PtyDataEvt,
  PtyExitEvt,
  PtyResizeReq,
  PtySpawnReq,
  PtySpawnRes,
  PtyWriteReq,
  SnApi,
} from '@shared/ipc-contract'
import type { ConfigFile } from '@shared/types'

/** Subscribe to a main->renderer channel, returning an unsubscribe fn. */
function sub<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: SnApi = {
  platform: process.platform,
  app: {
    info: () => ipcRenderer.invoke(CH.APP_INFO) as Promise<AppInfo>,
  },
  pty: {
    spawn: (req: PtySpawnReq) => ipcRenderer.invoke(CH.PTY_SPAWN, req) as Promise<PtySpawnRes>,
    write: (req: PtyWriteReq) => ipcRenderer.send(CH.PTY_WRITE, req),
    resize: (req: PtyResizeReq) => ipcRenderer.send(CH.PTY_RESIZE, req),
    kill: (ptyId: string) => ipcRenderer.invoke(CH.PTY_KILL, ptyId) as Promise<void>,
    onData: (cb: (e: PtyDataEvt) => void) => sub<PtyDataEvt>(CH.PTY_DATA, cb),
    onExit: (cb: (e: PtyExitEvt) => void) => sub<PtyExitEvt>(CH.PTY_EXIT, cb),
  },
  dialog: {
    openDirectory: () => ipcRenderer.invoke(CH.DIALOG_OPEN_DIR) as Promise<string | null>,
  },
  config: {
    load: () => ipcRenderer.invoke(CH.CONFIG_LOAD) as Promise<ConfigFile | null>,
    save: (config: ConfigFile) => ipcRenderer.send(CH.CONFIG_SAVE, config),
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
  },
}

// contextIsolation is always enabled (see window.ts), so the bridge is the only path.
try {
  contextBridge.exposeInMainWorld('snApi', api)
} catch (error) {
  console.error('Failed to expose snApi over contextBridge:', error)
}
