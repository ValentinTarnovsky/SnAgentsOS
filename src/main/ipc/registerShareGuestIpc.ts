import { hostname } from 'os'
import { ipcMain, type IpcMainEvent, type WebContents } from 'electron'
import { CH } from '@shared/ipc-channels'
import { SHARE_LIMITS, shareText } from '@shared/share-protocol'
import { electronCrypto } from '../accounts/safeCrypto'
import { keyFingerprint, toB64u } from '../share/crypto'
import type { ShareIdentityStore } from '../share/identity'
import { shareLoopbackAllowed } from '../share/invite'
import { LinkStore, shareLinksPath } from '../share/guest/LinkStore'
import { ShareGuest } from '../share/guest/ShareGuest'

export interface ShareGuestIpcDeps {
  /** The one ShareIdentityStore of the process (share-identity.json holds both roles). */
  identities: ShareIdentityStore
  /** settings.share.guestName ('' = the device name). */
  guestName(): string
  app: string
  send(channel: string, payload: unknown): void
}

/**
 * Guest channels of desktop sharing (app 2.4.0, item 8, `share:*` guest
 * half). Every argument is validated in ShareGuest; the renderer only ever
 * names a link id and a pane id. Needs app ready (DPAPI). Returns the facade
 * so index.ts disposes it on quit.
 */
export function registerShareGuestIpc(deps: ShareGuestIpcDeps): ShareGuest {
  const ids = deps.identities
  const guest = new ShareGuest({
    store: new LinkStore(shareLinksPath(), electronCrypto()),
    guestIdentity: () => ids.get('guest'),
    guestFingerprint: () => {
      const pub = ids.peekPub('guest')
      return pub ? keyFingerprint(pub) : null
    },
    ownKeys: () => (['host', 'guest'] as const).map((r) => ids.peekPub(r)).filter((k): k is Buffer => k !== null).map(toB64u),
    guestName: () => shareText(deps.guestName(), SHARE_LIMITS.guestNameMax) || shareText(hostname(), SHARE_LIMITS.guestNameMax),
    app: deps.app,
    send: deps.send,
    allowLoopback: shareLoopbackAllowed(),
  })

  ipcMain.handle(CH.SHARE_PREVIEW, (_e, invite: unknown) => guest.preview(invite))
  ipcMain.handle(CH.SHARE_JOIN, (_e, invite: unknown) => guest.join(invite))
  ipcMain.handle(CH.SHARE_LINKS, () => guest.links())
  ipcMain.handle(CH.SHARE_CONNECT, (_e, linkId: unknown) => guest.connect(linkId))
  ipcMain.handle(CH.SHARE_DISCONNECT, (_e, linkId: unknown) => guest.disconnect(linkId))
  ipcMain.handle(CH.SHARE_FORGET, (_e, linkId: unknown) => guest.forget(linkId))
  ipcMain.handle(CH.SHARE_PASSWORD, (_e, req: unknown) => guest.password(req))
  ipcMain.handle(CH.SHARE_CTL, (_e, req: unknown) => guest.ctl(req))
  ipcMain.handle(CH.SHARE_GIT, (_e, req: unknown) => guest.git(req))
  ipcMain.handle(CH.SHARE_NOTES, (_e, req: unknown) => guest.notes(req))
  ipcMain.handle(CH.SHARE_FILES, (_e, req: unknown) => guest.files(req))
  // A reload or a crash of the window drops its mounts, so the host stops streaming (and keeping awake) panes nobody shows.
  const wired = new WeakSet<WebContents>()
  const watch = (e: IpcMainEvent): void => {
    const wc = e.sender
    if (wired.has(wc)) return
    wired.add(wc)
    wc.on('destroyed', () => guest.resetRenderer())
    wc.on('render-process-gone', () => guest.resetRenderer())
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) guest.resetRenderer()
    })
  }
  ipcMain.on(CH.SHARE_SUB, (e, req: unknown) => {
    watch(e)
    guest.sub(req)
  })
  ipcMain.on(CH.SHARE_UNSUB, (_e, req: unknown) => guest.unsub(req))
  ipcMain.on(CH.SHARE_INPUT, (_e, req: unknown) => guest.input(req))
  ipcMain.on(CH.SHARE_FLOW, (_e, req: unknown) => guest.flowCtl(req))
  ipcMain.on(CH.SHARE_CHAT, (_e, req: unknown) => guest.chat(req))
  ipcMain.on(CH.SHARE_FILES_WATCH, (e, req: unknown) => {
    watch(e)
    guest.filesWatch(req)
  })
  return guest
}
