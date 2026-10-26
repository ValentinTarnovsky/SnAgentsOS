import { app, ipcMain, shell, type WebContents } from 'electron'
import { CH } from '@shared/ipc-channels'
import type { ConfigFile } from '@shared/types'
import { FileService } from '../files/FileService'

export interface FilesIpcDeps {
  getSender: () => WebContents | null
  config: () => ConfigFile | null
  /** WorktreeService.isManaged: a pane's tree is its worktree only when main manages it (app 2.7.0, A9). */
  isManagedWorktree?: (path: string) => boolean
  /** PtyManager.getSpawnCwd: where relative `file:line` refs of a pane start. */
  spawnCwd?: (paneId: string) => string | undefined
}

/**
 * Files drawer channels (v2.2, E9). The renderer names a workspace (and,
 * app 2.7.0, optionally one of its panes) and a relative path; FileService
 * resolves the folder from the config and keeps every target inside it. One
 * folder is watched at a time. `files:resolveRefs` resolves a pane's
 * terminal `file:line` refs against that same root.
 */
export function registerFilesIpc(deps: FilesIpcDeps): FileService {
  const files = new FileService({
    config: deps.config,
    emit: (evt) => {
      const wc = deps.getSender()
      if (wc && !wc.isDestroyed()) wc.send(CH.FILES_CHANGED, evt)
    },
    trash: (p) => shell.trashItem(p),
    reveal: (p) => shell.showItemInFolder(p),
    openPath: (p) => shell.openPath(p),
    isManagedWorktree: deps.isManagedWorktree,
    spawnCwd: deps.spawnCwd,
  })
  ipcMain.handle(CH.FILES_ROOT, (_e, workspaceId: unknown, paneId: unknown) => files.rootInfo(workspaceId, paneId))
  ipcMain.handle(CH.FILES_LIST, (_e, req: unknown) => files.list(req))
  ipcMain.handle(CH.FILES_READ, (_e, req: unknown) => files.read(req))
  ipcMain.handle(CH.FILES_WRITE, (_e, req: unknown) => files.write(req))
  ipcMain.handle(CH.FILES_CREATE, (_e, req: unknown) => files.create(req))
  ipcMain.handle(CH.FILES_RENAME, (_e, req: unknown) => files.rename(req))
  ipcMain.handle(CH.FILES_TRASH, (_e, req: unknown) => files.trash(req))
  ipcMain.handle(CH.FILES_REVEAL, (_e, req: unknown) => files.reveal(req))
  ipcMain.handle(CH.FILES_OPEN, (_e, req: unknown) => files.openExternal(req))
  ipcMain.on(CH.FILES_WATCH, (_e, workspaceId: unknown, paneId: unknown) => files.watch(typeof workspaceId === 'string' ? workspaceId : null, paneId))
  ipcMain.handle(CH.FILES_RESOLVE_REFS, (_e, req: unknown) => files.resolveRefs(req))
  app.once('will-quit', () => files.unwatch())
  return files
}
