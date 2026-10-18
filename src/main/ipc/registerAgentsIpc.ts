import { ipcMain } from 'electron'
import { CH } from '@shared/ipc-channels'
import type { AgentSessionView, AgentsStartup } from '@shared/agents'
import type { AgentSessionStore } from '../agents/AgentSessionStore'

/**
 * `agents:*` channels over main's AgentSessionStore (E5 G2). The renderer
 * only reads views and asks to forget a pane; it never sends paths, ids to
 * store or activity. Pushes (agents:changed / agents:ready) are wired by the
 * store's onChanged / onReady callbacks in index.ts.
 */
export function registerAgentsIpc(store: AgentSessionStore): void {
  ipcMain.handle(CH.AGENTS_LIST, (): AgentSessionView[] => store.list())
  ipcMain.handle(CH.AGENTS_STARTUP, (): AgentsStartup => store.startup())
  ipcMain.handle(CH.AGENTS_CONSUME_STARTUP, (_e, paneId: unknown): boolean =>
    typeof paneId === 'string' && paneId.length <= 128 ? store.consumeStartup(paneId) : false,
  )
  ipcMain.handle(CH.AGENTS_STARTUP_PENDING, (_e, paneIds: unknown): string[] =>
    Array.isArray(paneIds) && paneIds.length <= 1000
      ? store.startupPending(paneIds.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128))
      : [],
  )
  ipcMain.on(CH.AGENTS_FORGET, (_e, paneId: unknown) => {
    if (typeof paneId === 'string' && paneId && paneId.length <= 128) store.forget(paneId)
  })
}
