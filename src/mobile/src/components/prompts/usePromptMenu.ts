/**
 * Claude's menu on the viewed console's screen (E2-FR-53, 54), re-read every
 * MENU_POLL_MS while a card needs it: the hook fires before Claude draws the
 * menu, and a new Claude version may draw another layout. Only the console
 * the terminal is streaming counts, and never under the Chat view, whose
 * terminal stream is paused (the screen there may be stale).
 */
import { useEffect, useState } from 'react'
import { selectInChat, store } from '../../lib/store'
import { getActiveTerm } from '../../lib/terminalBus'
import { MENU_POLL_MS, readMenu, type MenuOption } from '../../lib/promptMenu'

/** The menu of the live screen of `paneId`, or null. */
export function currentMenu(paneId: string | null): MenuOption[] | null {
  const st = store.getState()
  if (!paneId || st.activePaneId !== paneId || st.subscribedPaneId !== paneId || selectInChat(st)) return null
  return readMenu(getActiveTerm())
}

const menuKey = (menu: MenuOption[] | null): string => (menu ? menu.map((o) => `${o.n}:${o.label}`).join('\n') : '')

/** `requestId` restarts the read when the card moves to another request. */
export function usePromptMenu(paneId: string | null, requestId: string | null): MenuOption[] | null {
  const active = !!paneId && !!requestId
  const [menu, setMenu] = useState<MenuOption[] | null>(() => (active ? currentMenu(paneId) : null))
  useEffect(() => {
    if (!active) {
      setMenu(null)
      return
    }
    let key: string | null = null
    const read = (): void => {
      const next = currentMenu(paneId)
      const k = menuKey(next)
      if (k === key) return
      key = k
      setMenu(next)
    }
    read()
    const id = setInterval(read, MENU_POLL_MS)
    return () => clearInterval(id)
  }, [active, paneId, requestId])
  return active ? menu : null
}
