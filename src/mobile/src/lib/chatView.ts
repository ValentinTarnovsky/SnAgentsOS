/**
 * Terminal or Chat per console (E3-FR-24): the [Terminal | Chat] control
 * shows only for a console whose agent status names Claude or Codex (or, with
 * no provider in the status, a Claude or Codex console by type), a choice
 * that differs from the default is saved per pane
 * ('snagentsos.remote.paneView.<paneId>'), and "Open agent consoles in Chat"
 * ('snagentsos.remote.chatDefault', off) is the default of every eligible
 * console; flipping it clears the per-pane choices (v2.2.1). Storage always
 * goes through mobileStorage's try/catch helpers.
 */
import type { RemotePaneStatus } from '@shared/remote-protocol'
import type { PaneType } from '@shared/types'
import { STORAGE_PREFIX, storageGet, storageKeys, storageRemove, storageSet } from './mobileStorage'

export type PaneView = 'terminal' | 'chat'

export const PANE_VIEW_PREFIX = `${STORAGE_PREFIX}remote.paneView.`
const CHAT_DEFAULT_KEY = `${STORAGE_PREFIX}remote.chatDefault`
/** Marks the one-time paneView reset of v2.2.1 as done. */
export const PANE_VIEW_RESET_KEY = `${STORAGE_PREFIX}remote.paneViewReset`

/**
 * A console the Chat view can read (FR-24, FR-34): its status says Claude or
 * Codex, or no status names a provider and the console is a Claude or Codex
 * one by type (a Codex console without its integration has no status, v2.2.1).
 * A shell where someone started an agent by hand still needs its status.
 */
export function chatEligible(status: RemotePaneStatus | null | undefined, paneType?: PaneType | null): boolean {
  if (status?.provider === 'claude' || status?.provider === 'codex') return true
  return !status?.provider && (paneType === 'claude' || paneType === 'codex')
}

/**
 * The effective view: Terminal unless eligible, or while the desktop refused
 * the chat on this open (FR-33, in memory only), then the saved choice, then
 * chatDefault.
 */
export function resolvePaneView(saved: PaneView | undefined, chatDefault: boolean, eligible: boolean, refused = false): PaneView {
  if (!eligible || refused) return 'terminal'
  return saved ?? (chatDefault ? 'chat' : 'terminal')
}

/**
 * What the "Chat not available" toast remembers per console (v2.3.0): the
 * provider and whether the status is precise, or 'none' without a status.
 * Never `state`: it changes on every turn and would bring the toast back.
 */
export function chatToastKey(status: RemotePaneStatus | null | undefined): string {
  return status ? `${status.provider ?? ''}|${status.precise === false ? 'title' : 'precise'}` : 'none'
}

export function loadPaneViews(): Record<string, PaneView> {
  const out: Record<string, PaneView> = {}
  for (const key of storageKeys(PANE_VIEW_PREFIX)) {
    const v = storageGet(key)
    if (v === 'terminal' || v === 'chat') out[key.slice(PANE_VIEW_PREFIX.length)] = v
  }
  return out
}

/**
 * Store init (v2.2.1): the choices saved up to v2.2.0 include every toggle
 * tap, even one equal to the default back then, and those stale keys beat
 * chatDefault (bug 8). They are dropped once, gated by PANE_VIEW_RESET_KEY;
 * from here on only a real exception to the default is saved.
 */
export function migratePaneViews(): Record<string, PaneView> {
  if (storageGet(PANE_VIEW_RESET_KEY) !== '1') {
    clearPaneViews()
    storageSet(PANE_VIEW_RESET_KEY, '1')
  }
  return loadPaneViews()
}

export function savePaneView(paneId: string, view: PaneView): void {
  storageSet(`${PANE_VIEW_PREFIX}${paneId}`, view)
}

/** A choice equal to the default is not an exception: its key goes away. */
export function removePaneView(paneId: string): void {
  storageRemove(`${PANE_VIEW_PREFIX}${paneId}`)
}

/** Every saved per-pane choice goes away (the chatDefault switch flipped). */
export function clearPaneViews(): void {
  for (const key of storageKeys(PANE_VIEW_PREFIX)) storageRemove(key)
}

export function loadChatDefault(): boolean {
  return storageGet(CHAT_DEFAULT_KEY) === 'true'
}

export function saveChatDefault(on: boolean): void {
  storageSet(CHAT_DEFAULT_KEY, on ? 'true' : 'false')
}
