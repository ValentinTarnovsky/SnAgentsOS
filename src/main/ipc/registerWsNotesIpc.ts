import { ipcMain, shell, type WebContents } from 'electron'
import { join } from 'path'
import { CH } from '@shared/ipc-channels'
import type { WsNotesChangedEvt } from '@shared/ws-notes'
import { WsNoteStore } from '../notes/WsNoteStore'
import { dataDir } from '../paths'

export interface WsNotesIpcDeps {
  getSender: () => WebContents | null
  /** Every change also goes to the phones (RemoteManager). */
  onChanged?: (evt: WsNotesChangedEvt) => void
}

/**
 * Workspace note channels (v2.2, E9): list, read, write, create, delete and
 * open in, `wsNotes:changed` out. The folder lives under dataDir() and is
 * resolved on use, after the legacy migration.
 */
export function registerWsNotesIpc(deps: WsNotesIpcDeps): WsNoteStore {
  const store = new WsNoteStore({
    root: () => join(dataDir(), 'notes'),
    emit: (evt) => {
      const wc = deps.getSender()
      if (wc && !wc.isDestroyed()) wc.send(CH.WS_NOTES_CHANGED, evt)
      deps.onChanged?.(evt)
    },
  })
  ipcMain.handle(CH.WS_NOTES_LIST, (_e, workspaceId: unknown) => store.list(workspaceId))
  ipcMain.handle(CH.WS_NOTES_READ, (_e, req: unknown) => store.read(req))
  ipcMain.handle(CH.WS_NOTES_WRITE, (_e, req: unknown) => store.write(req))
  ipcMain.handle(CH.WS_NOTES_CREATE, (_e, req: unknown) => store.create(req))
  ipcMain.handle(CH.WS_NOTES_DELETE, (_e, req: unknown) => store.delete(req))
  ipcMain.handle(CH.WS_NOTES_OPEN, async (_e, req: unknown) => {
    const path = await store.pathOf(req)
    // A .md of our own folder: an inert format, it opens in the user's editor.
    return path ? (await shell.openPath(path)) === '' : false
  })
  ipcMain.on(CH.WS_NOTES_PRUNE, (_e, keep: unknown) => void store.prune(keep))
  return store
}
