/**
 * Claude's menu for the viewed console's card (E2-FR-53, 54), re-read every
 * MENU_POLL_MS while a card needs it: the hook fires before Claude draws the
 * menu, and a new Claude version may draw another layout.
 *
 *  - Terminal: the live xterm of the streamed console first (the phone's
 *    own read), else main's read.
 *  - Chat (app 2.4.0): the terminal stream is paused there, so only main's
 *    read off the headless mirror counts (RemotePaneStatus.menu), and only
 *    when it is for this very request and the desktop is 2.4.0 or newer.
 */
import { useEffect, useState } from 'react'
import { APP_2_4_0, appVersionAtLeast } from '@shared/agentTune'
import { selectInChat, store, useRemoteStore } from '../../lib/store'
import { getActiveTerm } from '../../lib/terminalBus'
import { MENU_POLL_MS, chooseMenu, readMenu, type MenuOption, type SourcedMenu } from '../../lib/promptMenu'

/** The menu of `paneId` for `pendingId`, with where it came from, or null. */
export function readCurrentMenu(paneId: string | null, pendingId: string | null = null): SourcedMenu | null {
  const st = store.getState()
  if (!paneId) return null
  const viewed = st.activePaneId === paneId
  const inChat = viewed && selectInChat(st)
  const local = viewed && !inChat && st.subscribedPaneId === paneId ? readMenu(getActiveTerm()) : null
  return chooseMenu(local, inChat, st.paneStatus[paneId], pendingId, appVersionAtLeast(st.appVersion, APP_2_4_0))
}

/** The menu of `paneId` for `pendingId`, or null. */
export function currentMenu(paneId: string | null, pendingId: string | null = null): MenuOption[] | null {
  return readCurrentMenu(paneId, pendingId)?.menu ?? null
}

const menuKey = (menu: MenuOption[] | null): string => (menu ? menu.map((o) => `${o.n}:${o.label}`).join('\n') : '')

/** `requestId` restarts the read when the card moves to another request. */
export function usePromptMenu(paneId: string | null, requestId: string | null): MenuOption[] | null {
  const active = !!paneId && !!requestId
  // app 2.4.0: main's read arrives with paneStatus; the view decides which read counts.
  const remote = useRemoteStore((s) => (paneId ? s.paneStatus[paneId]?.menu : undefined))
  const inChat = useRemoteStore(selectInChat)
  const [menu, setMenu] = useState<MenuOption[] | null>(() => (active ? currentMenu(paneId, requestId) : null))
  useEffect(() => {
    if (!active) {
      setMenu(null)
      return
    }
    let key: string | null = null
    const read = (): void => {
      const next = currentMenu(paneId, requestId)
      const k = menuKey(next)
      if (k === key) return
      key = k
      setMenu(next)
    }
    read()
    const id = setInterval(read, MENU_POLL_MS)
    return () => clearInterval(id)
  }, [active, paneId, requestId, remote, inChat])
  return active ? menu : null
}
