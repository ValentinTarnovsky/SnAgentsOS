/**
 * Bring the main window to the front (E2-FR-07): restore it when minimized,
 * show it when it lives in the tray and focus it. Windows may refuse the focus
 * to a process that is not in the foreground (a phone asking from the LAN, a
 * toast clicked late); the taskbar button then flashes instead. With a paneId
 * the renderer is also told to reveal that console (notification click); the
 * phone's "Show on the PC" reveals the pane from the renderer itself.
 */
import type { BrowserWindow } from 'electron'
import { CH } from '@shared/ipc-channels'

export type RevealableWindow = Pick<
  BrowserWindow,
  'isDestroyed' | 'isMinimized' | 'restore' | 'show' | 'focus' | 'isFocused' | 'flashFrame'
> & { webContents: Pick<BrowserWindow['webContents'], 'send'> }

/** Returns true when the window ended focused (false = it flashes). */
export function revealWindow(win: RevealableWindow, paneId?: string): boolean {
  if (win.isDestroyed()) return false
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  const focused = win.isFocused()
  if (!focused) win.flashFrame(true)
  if (paneId) win.webContents.send(CH.STATUS_REVEAL, paneId)
  return focused
}
