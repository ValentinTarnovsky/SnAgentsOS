/**
 * Terminal or Chat per console (E3-FR-24): the [Terminal | Chat] control
 * shows only for a console whose agent status names Claude or Codex, the
 * choice is saved per pane ('snagentsos.remote.paneView.<paneId>'), and
 * "Open agent consoles in Chat" ('snagentsos.remote.chatDefault', off) makes
 * eligible consoles without a saved choice open in Chat. Storage always goes
 * through mobileStorage's try/catch helpers.
 */
import type { RemotePaneStatus } from '@shared/remote-protocol'
import { STORAGE_PREFIX, storageGet, storageKeys, storageSet } from './mobileStorage'

export type PaneView = 'terminal' | 'chat'

export const PANE_VIEW_PREFIX = `${STORAGE_PREFIX}remote.paneView.`
const CHAT_DEFAULT_KEY = `${STORAGE_PREFIX}remote.chatDefault`

/** A console the Chat view can read: its status says Claude or Codex (FR-24, FR-34). */
export function chatEligible(status: RemotePaneStatus | null | undefined): boolean {
  return status?.provider === 'claude' || status?.provider === 'codex'
}

/** The effective view: Terminal unless eligible, then the saved choice, then chatDefault. */
export function resolvePaneView(saved: PaneView | undefined, chatDefault: boolean, eligible: boolean): PaneView {
  if (!eligible) return 'terminal'
  return saved ?? (chatDefault ? 'chat' : 'terminal')
}

export function loadPaneViews(): Record<string, PaneView> {
  const out: Record<string, PaneView> = {}
  for (const key of storageKeys(PANE_VIEW_PREFIX)) {
    const v = storageGet(key)
    if (v === 'terminal' || v === 'chat') out[key.slice(PANE_VIEW_PREFIX.length)] = v
  }
  return out
}

export function savePaneView(paneId: string, view: PaneView): void {
  storageSet(`${PANE_VIEW_PREFIX}${paneId}`, view)
}

export function loadChatDefault(): boolean {
  return storageGet(CHAT_DEFAULT_KEY) === 'true'
}

export function saveChatDefault(on: boolean): void {
  storageSet(CHAT_DEFAULT_KEY, on ? 'true' : 'false')
}
