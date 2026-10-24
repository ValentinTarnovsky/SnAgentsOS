/**
 * The read-only Chat of a shared agent console (app 2.4.0, item 8, S5),
 * ported from the phone's ChatView (src/mobile/src/components/chat): the
 * host's transcript as a chat, oldest first, with "Load earlier", tool calls
 * folded into rows, expand-all and "Go to the end (N)", "<agent> is
 * working..." and "The host did not answer [Retry]". There is no composer:
 * a guest types only in the terminal, through the share gate. Links go
 * through ConfirmLinkDialog. The log itself is the desktop's ChatScroller
 * (app 2.7.0, src/renderer/components/chat); this view adds the share
 * guest's store, its words and its notice.
 *
 * Mounting reads the chat (chatSub), unmounting stops (chatUnsub). A new
 * connection (reconnect, or the host resuming a pause) asks for a fresh
 * first page, since the host forgets the reader with the old session.
 */
import { useCallback, useEffect, useMemo } from 'react'
import type { ShareLinkView } from '@shared/share-guest'
import type { ShareAgentStatus, SharePaneInfo } from '@shared/share-protocol'
import { useT } from '@/i18n'
import { useShareGuestStore } from '@/lib/shareGuestStore'
import { EMPTY_CHAT, chatFirst, chatForget, chatMore, chatUnsub, extrasKey, liveKeyOf, useShareExtrasStore } from '@/lib/shareGuestExtras'
import { ChatScroller, type ChatScrollerTexts } from '@/components/chat/ChatScroller'

export function SharedChatView({ link, pane, status, hostLabel }: { link: ShareLinkView; pane: SharePaneInfo; status: ShareAgentStatus | null; hostLabel: string }) {
  const t = useT()
  const linkId = link.id
  const paneId = pane.id
  const key = extrasKey(linkId, paneId)
  const chat = useShareExtrasStore((s) => s.chats[key] ?? EMPTY_CHAT)
  const confirmLink = useShareGuestStore((s) => s.confirmLink)
  const liveKey = liveKeyOf(link)

  useEffect(() => {
    if (liveKey === null) return
    chatFirst(linkId, paneId)
    return () => chatUnsub(linkId, paneId)
  }, [linkId, paneId, liveKey])
  useEffect(() => () => chatForget(linkId, paneId), [linkId, paneId])

  const onLink = useCallback((href: string) => confirmLink(href, hostLabel), [confirmLink, hostLabel])
  const onMore = useCallback(() => chatMore(linkId, paneId), [linkId, paneId])
  const onRetryFirst = useCallback(() => chatFirst(linkId, paneId), [linkId, paneId])
  const texts = useMemo<ChatScrollerTexts>(
    () => ({
      log: t('shareGuest.chat.log'),
      capped: t('shareGuest.chat.olderOnHost'),
      noReply: t('shareGuest.extras.noReply'),
      outputCut: t('shareGuest.chat.outputCut'),
    }),
    [t],
  )

  if (chat.notice) {
    return (
      <div data-chat-view={paneId} data-chat-notice={chat.notice} className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-text-secondary">
        {t('shareGuest.chat.unavailable')}
      </div>
    )
  }

  const agent = status?.provider === 'codex' || pane.type === 'codex' ? 'Codex' : 'Claude'
  return (
    <ChatScroller
      paneId={paneId}
      chat={chat}
      working={status?.state === 'working'}
      agent={agent}
      onMore={onMore}
      onRetryFirst={onRetryFirst}
      onLink={onLink}
      texts={texts}
    />
  )
}
