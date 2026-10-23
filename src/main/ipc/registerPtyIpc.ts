import { ipcMain } from 'electron'
import { CH } from '@shared/ipc-channels'
import type {
  PtyFlowReq,
  PtyReattachRes,
  PtyResizeReq,
  PtyRestartReq,
  PtyRestartRes,
  PtySpawnReq,
  PtySpawnRes,
  PtySubmitRes,
  PtyWriteReq,
  ScrollbackStats,
} from '@shared/ipc-contract'
import { SUBMIT_TEXT_MAX } from '@shared/initialPrompt'
import type { PtyManager } from '../pty/PtyManager'
import type { ScrollbackStore } from '../pty/ScrollbackStore'

/**
 * `restartLabel` gives the localized separator text for an in-place restart
 * ("restarted 14:32"), read from the current config language. `scrollback`
 * (the saved history store, E6-FR-12) adds the `scrollback:*` channels.
 */
export function registerPtyIpc(manager: PtyManager, restartLabel: () => string = () => 'restarted', scrollback?: ScrollbackStore): void {
  ipcMain.handle(CH.PTY_SPAWN, (_e, req: PtySpawnReq): PtySpawnRes => manager.spawn(req))

  // In-place restart (E6-FR-18/19): rejects when the new shell fails to spawn.
  ipcMain.handle(CH.PTY_RESTART, (_e, req: PtyRestartReq): PtyRestartRes => manager.restart(req, restartLabel()))

  ipcMain.handle(
    CH.PTY_REATTACH,
    (_e, paneId: string): PtyReattachRes | null => manager.reattach(paneId),
  )

  // High-frequency, fire-and-forget channels use send (not invoke).
  // v2.3: only an explicit 'auto' skips the attention ack; the keyboard is 'user'.
  ipcMain.on(CH.PTY_WRITE, (_e, req: PtyWriteReq) =>
    manager.write(req.ptyId, req.data, req.origin === 'auto' ? 'auto' : 'user'),
  )
  ipcMain.on(CH.PTY_RESIZE, (_e, req: PtyResizeReq) =>
    manager.resize(req.ptyId, req.cols, req.rows),
  )
  ipcMain.on(CH.PTY_SET_ACTIVE, (_e, paneIds: string[]) => manager.setActive(paneIds))
  ipcMain.on(CH.PTY_FLOW, (_e, req: PtyFlowReq) => manager.setFlow(req.ptyId, req.pause))
  // Headless mirror settings (E6-FR-06): normalized in setEngine, junk never throws.
  ipcMain.on(CH.PTY_SET_ENGINE, (_e, settings: unknown) => manager.setEngine(settings))

  ipcMain.handle(CH.PTY_KILL, (_e, ptyId: string) => manager.kill(ptyId))

  // The shared delivery path (E8-FR-02a): validated here, the text is never trusted blindly.
  ipcMain.handle(CH.PTY_SUBMIT, (_e, req: unknown): Promise<PtySubmitRes> => {
    const r = (req && typeof req === 'object' ? req : {}) as Record<string, unknown>
    const ptyId = typeof r.ptyId === 'string' ? r.ptyId : ''
    const paneId = typeof r.paneId === 'string' && r.paneId ? r.paneId : undefined
    if (typeof r.text !== 'string' || r.text.length > SUBMIT_TEXT_MAX || (!ptyId && !paneId)) {
      return Promise.resolve({ ok: false, error: 'not_running' })
    }
    // v2.3: only an explicit 'auto' skips the attention ack; anything else is the user.
    // `readyFor` (agentTune) gates the Enter on a ready agent with no draft.
    const readyFor = r.readyFor === 'claude' || r.readyFor === 'codex' ? r.readyFor : undefined
    // `userGate` (typingBlocked): never type over, nor press Enter into, a menu waiting on the user.
    return manager.submitToPane(ptyId, paneId, r.text, r.enter === true, r.origin === 'auto' ? 'auto' : 'user', readyFor, r.userGate === true)
  })

  // Explicit lifecycle (E4-FR-36): an unmount never kills, these do, by paneId.
  ipcMain.handle(CH.PTY_KILL_PANES, (_e, paneIds: unknown): number => manager.killPanes(paneIdList(paneIds)))
  ipcMain.handle(CH.PTY_RECONCILE, (_e, livePaneIds: unknown): number => {
    // A malformed list must never read as "no panes" and kill everything.
    if (!Array.isArray(livePaneIds)) return 0
    return manager.reconcile(paneIdList(livePaneIds))
  })

  if (scrollback) registerScrollbackIpc(manager, scrollback)
}

/**
 * Saved scrollback (E6-FR-11/12). A closed pane's file goes to the trash and
 * its seed can be taken again (reopened in this session); "clear" deletes at
 * once and also drops what the next save could bring back.
 */
export function registerScrollbackIpc(manager: PtyManager, store: ScrollbackStore): void {
  ipcMain.handle(CH.PTY_SCROLLBACK_LOAD, (_e, paneId: unknown): string | null =>
    typeof paneId === 'string' ? (store.load(paneId)?.ansi ?? null) : null,
  )
  ipcMain.handle(CH.SCROLLBACK_CLEAR, async (_e, paneId: unknown, opts: unknown): Promise<void> => {
    if (typeof paneId !== 'string') return
    if ((opts as { trash?: unknown } | null)?.trash === true) {
      manager.forgetSeed(paneId)
      await store.trash(paneId)
      return
    }
    manager.clearPersisted(paneId)
    await store.remove(paneId)
  })
  ipcMain.handle(CH.SCROLLBACK_CLEAR_ALL, async (): Promise<void> => {
    manager.clearPersisted()
    await store.clearAll()
  })
  ipcMain.handle(CH.SCROLLBACK_STATS, (): Promise<ScrollbackStats> => store.stats())
}

/** The string entries of an IPC paneId list (anything else is dropped). */
function paneIdList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
}
