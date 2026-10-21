/**
 * The KeyBar's Paste key (E3-FR-48): the clipboard straight into the viewed
 * console in a secure context, the one-shot composer of D11 otherwise. Wires
 * the pure pasteFromClipboard flow to the client, the store and the xterm.
 */
import { client } from '../lib/client'
import { selectInputMode, store } from '../lib/store'
import { getActiveTerm, getComposerHandle } from '../lib/terminalBus'
import { abortableSleep } from '../lib/composerSend'
import { pasteBracketed, safePaste } from '../lib/safePaste'
import { canReadClipboard, pasteFromClipboard } from '../lib/clipboardPaste'
import { openComposerForPaste } from './Composer'

export function pasteKey(): void {
  const paneId = store.getState().activePaneId
  if (!paneId) return
  void pasteFromClipboard({
    canRead: canReadClipboard,
    readText: () => navigator.clipboard.readText(),
    composerMode: () => selectInputMode(store.getState()) === 'composer' && !!getComposerHandle(),
    insertComposer: (text) => getComposerHandle()?.insert(text),
    pasteDirect: (text) => {
      const s = store.getState()
      // A pane switch while the clipboard was read: nothing goes to the new one.
      if (s.subscribedPaneId !== paneId || !client.isOpen()) return Promise.resolve(false)
      if (s.ctrlLatch) s.setCtrlLatch(false)
      return safePaste(
        text,
        {
          bracketed: pasteBracketed(getActiveTerm()?.modes.bracketedPasteMode, s.paneStatus[paneId]),
          enter: false,
          signal: new AbortController().signal,
          live: () => store.getState().subscribedPaneId === paneId && client.isOpen(),
        },
        { sendInput: (data, opts) => client.sendInputTo(paneId, data, opts), sleep: abortableSleep },
      )
    },
    openComposer: openComposerForPaste,
  })
}
