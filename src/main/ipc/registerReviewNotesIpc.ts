import { app, ipcMain, type WebContents } from 'electron'
import { join } from 'path'
import { CH } from '@shared/ipc-channels'
import type { ReviewNotesChangedEvt } from '@shared/review-notes'
import { ReviewNoteStore } from '../git/ReviewNoteStore'
import { dataDir } from '../paths'

export interface ReviewNotesIpcDeps {
  getSender: () => WebContents | null
}

/**
 * Review note channels (E7-FR-17..20, Design D): `git:notesList`,
 * `git:notesUpsert`, `git:notesDelete`, `git:notesMarkSent` and
 * `git:notesPrune` in, `git:notesChanged` out. The file lives under dataDir()
 * and is resolved on first use, after the legacy migration. A pending write
 * is flushed when the app quits.
 */
export function registerReviewNotesIpc(deps: ReviewNotesIpcDeps): ReviewNoteStore {
  const store = new ReviewNoteStore({
    file: () => join(dataDir(), 'review-notes.json'),
    emit: (evt: ReviewNotesChangedEvt) => {
      const wc = deps.getSender()
      if (wc && !wc.isDestroyed()) wc.send(CH.GIT_NOTES_CHANGED, evt)
    },
  })
  ipcMain.handle(CH.GIT_NOTES_LIST, (_e, workspaceId: unknown) => store.list(workspaceId))
  ipcMain.handle(CH.GIT_NOTES_UPSERT, (_e, note: unknown) => store.upsert(note))
  ipcMain.handle(CH.GIT_NOTES_DELETE, (_e, req: unknown) => store.delete(req))
  ipcMain.handle(CH.GIT_NOTES_MARK_SENT, (_e, req: unknown) => store.markSent(req))
  ipcMain.on(CH.GIT_NOTES_PRUNE, (_e, keep: unknown) => store.prune(keep))
  app.once('before-quit', () => store.flush())
  app.once('will-quit', () => store.flush())
  return store
}
