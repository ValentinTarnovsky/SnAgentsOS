/**
 * What to do with a tapped link (E2-FR-28/29).
 *
 *  - URL: "Open on the phone" (window.open, hidden for localhost / 127.0.0.1 /
 *    0.0.0.0, which would point at the phone itself), "Open on the PC"
 *    (ctl openUrl) and Copy.
 *  - Path: "Copy path", "Insert in the composer" and a PC action through
 *    ctl openPath. Its label says "Open on the PC" for an inert extension and
 *    "Show in Explorer" (Finder, file manager) for the rest; main decides the
 *    same way and may still reveal (home or drive root). The ack's error
 *    becomes a toast: outside the workspace, missing file, or wait a second.
 *
 * Copy runs inside the row's click (execCommand needs the gesture); when the
 * browser refuses, the text opens in the same fallback sheet as a selection.
 */
import { useRef, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { ClipboardCopy, ExternalLink, FolderOpen, Monitor, Smartphone, TextCursorInput } from 'lucide-react'
import { Sheet } from './Sheet'
import { ActionList, type ActionItem } from './ActionList'
import { isLocalUrl, pcActionFor, type TerminalLink } from '../lib/links'
import { copyText } from '../lib/clipboard'
import { client } from '../lib/client'
import { selectInputMode, store, useRemoteStore } from '../lib/store'
import { viewedWorkspaceId } from '../lib/workspace'
import { getComposerHandle } from '../lib/terminalBus'
import { t, type MobileMessageKey } from '../lib/i18n'

/** Toast for a failed openPath / openUrl ack. */
export function linkErrorText(error: string | undefined): string {
  if (error === 'denied_path') return t('link.err.denied')
  if (error === 'not_found') return t('link.err.notFound')
  if (error === 'rate') return t('link.err.rate')
  return t('link.err.generic')
}

/** "Show in Explorer" on Windows, Finder on macOS, the file manager elsewhere. */
function revealKey(hostPlatform: string): MobileMessageKey {
  if (hostPlatform === 'darwin') return 'link.revealPcMac'
  if (hostPlatform === 'win32' || !hostPlatform) return 'link.revealPc'
  return 'link.revealPcLinux'
}

/** Insert into the viewed pane's composer, opening it one-shot from Direct (E1-FR-31). */
function insertInComposer(text: string): void {
  const s = store.getState()
  const paneId = s.activePaneId
  if (!paneId) return
  if (selectInputMode(s) !== 'composer') flushSync(() => s.update({ composerOneShot: paneId }))
  getComposerHandle()?.insert(text)
}

export function LinkSheet({
  link: openLink,
  onClose,
  onCopyFallback,
}: {
  link: TerminalLink | null
  onClose: () => void
  /** The browser refused to copy: show the text to copy by hand (E2-FR-27). */
  onCopyFallback: (text: string) => void
}): ReactNode {
  const hostPlatform = useRemoteStore((s) => s.hostPlatform)
  // The closing sheet keeps showing the last link while it slides out.
  const last = useRef<TerminalLink | null>(null)
  if (openLink) last.current = openLink
  const link = last.current

  const toast = (text: string): void => store.getState().setToast(text)
  const copy = (text: string): void => {
    onClose()
    if (copyText(text, () => onCopyFallback(text))) toast(t('link.copied'))
    else onCopyFallback(text)
  }
  const sendToPc = async (action: Parameters<typeof client.sendCtl>[0]): Promise<void> => {
    onClose()
    const res = await client.sendCtl(action)
    toast(res.ok ? t('link.sentPc') : linkErrorText(res.error))
  }

  let items: ActionItem[] = []
  let title = ''
  let message = ''
  if (link?.kind === 'url') {
    title = t('link.urlTitle')
    message = link.url
    items = [
      ...(isLocalUrl(link.url)
        ? []
        : [{
            id: 'openPhone',
            icon: <Smartphone size={16} />,
            label: t('link.openPhone'),
            onSelect: () => {
              window.open(link.url, '_blank', 'noopener')
              onClose()
            },
          }]),
      // ctl openUrl caps the link at 2048 (contract R22-14); a longer one would be a malformed frame.
      ...(link.url.length <= 2048
        ? [{ id: 'openPc', icon: <Monitor size={16} />, label: t('link.openPc'), onSelect: () => void sendToPc({ kind: 'openUrl', url: link.url }) }]
        : []),
      { id: 'copy', icon: <ClipboardCopy size={16} />, label: t('link.copy'), onSelect: () => copy(link.url) },
    ]
  } else if (link?.kind === 'path') {
    title = t('link.pathTitle')
    message = link.raw
    const reveal = pcActionFor(link.path) === 'reveal'
    items = [
      { id: 'copyPath', icon: <ClipboardCopy size={16} />, label: t('link.copyPath'), onSelect: () => copy(link.raw) },
      {
        id: 'insert',
        icon: <TextCursorInput size={16} />,
        label: t('link.insert'),
        onSelect: () => {
          onClose()
          insertInComposer(link.raw)
        },
      },
      {
        id: reveal ? 'revealPc' : 'openPc',
        icon: reveal ? <FolderOpen size={16} /> : <ExternalLink size={16} />,
        label: t(reveal ? revealKey(hostPlatform) : 'link.openPc'),
        onSelect: () => {
          const s = store.getState()
          const paneId = s.activePaneId
          const workspaceId = s.snapshot ? viewedWorkspaceId(s.snapshot, paneId) : null
          if (!paneId || !workspaceId) {
            onClose()
            toast(t('link.err.generic'))
            return
          }
          void sendToPc({ kind: 'openPath', workspaceId, paneId, path: link.raw })
        },
      },
    ]
  }

  return (
    <Sheet open={openLink != null} onClose={onClose}>
      <div data-link-sheet={link?.kind}>
        <ActionList title={title} message={message} items={items} />
      </div>
    </Sheet>
  )
}
