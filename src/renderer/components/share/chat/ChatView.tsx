/**
 * The read-only Chat of a shared agent console (app 2.4.0, item 8, S5),
 * ported from the phone's ChatView (src/mobile/src/components/chat): the
 * host's transcript as a chat, oldest first, with "Load earlier", tool calls
 * folded into rows, expand-all and "Go to the end (N)", "<agent> is
 * working..." and "The host did not answer [Retry]". There is no composer:
 * a guest types only in the terminal, through the share gate. Links go
 * through ConfirmLinkDialog.
 *
 * Mounting reads the chat (chatSub), unmounting stops (chatUnsub). A new
 * connection (reconnect, or the host resuming a pause) asks for a fresh
 * first page, since the host forgets the reader with the old session.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ChevronsDownUp, ChevronsUpDown, Loader2 } from 'lucide-react'
import type { ShareLinkView } from '@shared/share-guest'
import type { ShareAgentStatus, SharePaneInfo } from '@shared/share-protocol'
import { useT } from '@/i18n'
import { Tooltip } from '@/components/ui/Tooltip'
import { useShareGuestStore } from '@/lib/shareGuestStore'
import { EMPTY_CHAT, chatFirst, chatForget, chatMore, chatUnsub, extrasKey, liveKeyOf, useShareExtrasStore } from '@/lib/shareGuestExtras'
import { buildRows, messageText } from './chatModel'
import { MessageRow } from './MessageRow'
import { ToolRunRow } from './ToolRunRow'

const FOLLOW_PX = 40
const JUMP_PX = 200

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

function Skeleton() {
  return (
    <div data-chat-skeleton aria-hidden className="flex flex-col gap-3 px-3 py-2">
      {[70, 90, 55].map((w, i) => (
        <div key={i} className="h-9 animate-pulse rounded-card bg-card motion-reduce:animate-none" style={{ width: `${w}%`, marginLeft: i === 1 ? 'auto' : undefined }} />
      ))}
    </div>
  )
}

function NoReply({ onRetry }: { onRetry: () => void }) {
  const t = useT()
  return (
    <div data-chat-noreply className="flex items-center justify-center gap-2 px-4 py-3 text-xs text-text-secondary">
      {t('shareGuest.extras.noReply')}
      <button type="button" data-chat-retry onClick={onRetry} className="rounded-btn border border-border px-2.5 py-1 text-xs text-text-primary transition-colors hover:bg-card">
        {t('shareGuest.extras.retry')}
      </button>
    </div>
  )
}

export function SharedChatView({ link, pane, status, hostLabel }: { link: ShareLinkView; pane: SharePaneInfo; status: ShareAgentStatus | null; hostLabel: string }) {
  const t = useT()
  const linkId = link.id
  const paneId = pane.id
  const key = extrasKey(linkId, paneId)
  const chat = useShareExtrasStore((s) => s.chats[key] ?? EMPTY_CHAT)
  const confirmLink = useShareGuestStore((s) => s.confirmLink)
  const rows = useMemo(() => buildRows(chat.list.items), [chat.list.items])
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [showJump, setShowJump] = useState(false)
  const [newCount, setNewCount] = useState(0)
  const [expandAll, setExpandAll] = useState({ open: false, v: 0 })
  const atEnd = useRef(true)
  const liveKey = liveKeyOf(link)

  useEffect(() => {
    if (liveKey === null) return
    chatFirst(linkId, paneId)
    return () => chatUnsub(linkId, paneId)
  }, [linkId, paneId, liveKey])
  useEffect(() => () => chatForget(linkId, paneId), [linkId, paneId])

  const onLink = useCallback((href: string) => confirmLink(href, hostLabel), [confirmLink, hostLabel])

  const prev = useRef<{ first: string | null; last: string | null; count: number; version: number; height: number }>({ first: null, last: null, count: 0, version: -1, height: 0 })

  const onScroll = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    atEnd.current = dist <= FOLLOW_PX
    setShowJump(dist > JUMP_PX)
    if (atEnd.current) setNewCount(0)
  }, [])

  const jump = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' })
    atEnd.current = true
    setNewCount(0)
    setShowJump(false)
  }, [])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const items = chat.list.items
    const first = items[0]?.id ?? null
    const last = items.at(-1)?.id ?? null
    const p = prev.current
    if (chat.version !== p.version) {
      el.scrollTop = el.scrollHeight
      atEnd.current = true
      setNewCount(0)
      setShowJump(false)
    } else if (first !== p.first && last === p.last && p.count > 0) {
      el.scrollTop += el.scrollHeight - p.height
    } else if (last !== p.last && p.last !== null) {
      const at = items.findIndex((m) => m.id === p.last)
      const added = at >= 0 ? items.length - 1 - at : 1
      if (atEnd.current) el.scrollTop = el.scrollHeight
      else if (added > 0) setNewCount((n) => n + added)
    }
    prev.current = { first, last, count: items.length, version: chat.version, height: el.scrollHeight }
  }, [chat.list.items, chat.version])

  const working = status?.state === 'working'
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && atEnd.current) el.scrollTop = el.scrollHeight
    if (el) prev.current.height = el.scrollHeight
  }, [working])

  const lastAssistant = useMemo(() => {
    for (let i = chat.list.items.length - 1; i >= 0; i--) {
      const m = chat.list.items[i]
      if (m.role === 'assistant') {
        const text = messageText(m.blocks)
        if (text) return text.slice(0, 500)
      }
    }
    return ''
  }, [chat.list.items])

  const agent = status?.provider === 'codex' || pane.type === 'codex' ? 'Codex' : 'Claude'
  const list = chat.list
  const firstLoading = chat.loading === 'first' && list.items.length === 0

  if (chat.notice) {
    return (
      <div data-chat-view={paneId} data-chat-notice={chat.notice} className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-text-secondary">
        {t('shareGuest.chat.unavailable')}
      </div>
    )
  }

  return (
    <div data-chat-view={paneId} className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        data-chat-scroll
        role="log"
        aria-label={t('shareGuest.chat.log')}
        aria-live="off"
        onScroll={onScroll}
        className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-14 pt-2"
      >
        {chat.failed === 'more' ? (
          <NoReply onRetry={() => chatMore(linkId, paneId)} />
        ) : chat.loading === 'more' ? (
          <Skeleton />
        ) : list.capped ? (
          <div data-chat-capped className="px-4 py-2 text-center text-[11px] text-text-secondary">
            {t('shareGuest.chat.olderOnHost')}
          </div>
        ) : !list.done && list.items.length > 0 ? (
          <div className="flex justify-center py-1">
            <button
              type="button"
              data-chat-load-earlier
              onClick={() => chatMore(linkId, paneId)}
              className="rounded-btn border border-border px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-card"
            >
              {t('shareGuest.chat.loadEarlier')}
            </button>
          </div>
        ) : null}

        {firstLoading && <Skeleton />}
        {chat.failed === 'first' && <NoReply onRetry={() => chatFirst(linkId, paneId)} />}
        {!firstLoading && !chat.failed && list.items.length === 0 && list.done && (
          <div data-chat-empty className="px-4 py-8 text-center text-sm text-text-secondary">
            {t('shareGuest.chat.empty')}
          </div>
        )}

        <div className="flex min-w-0 flex-col gap-3">
          {rows.map((row) => (
            <div key={row.id} className="min-w-0" style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 64px' }}>
              {row.kind === 'tools' ? <ToolRunRow calls={row.calls} expandAll={expandAll} /> : <MessageRow id={row.id} role={row.role} blocks={row.blocks} onLink={onLink} />}
            </div>
          ))}
        </div>

        {working && (
          <div data-chat-working className="flex items-center gap-2 px-3 pt-3 text-xs text-text-secondary">
            <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden />
            {t('shareGuest.chat.working', { agent })}
          </div>
        )}
      </div>

      <div className="sr-only" aria-live="polite" data-chat-announce>
        {lastAssistant}
      </div>

      <div className="pointer-events-none absolute bottom-3 right-3 z-10 flex items-center gap-2">
        {showJump && (
          <button
            type="button"
            data-chat-jump
            onClick={jump}
            className="pointer-events-auto flex h-8 items-center gap-1.5 rounded-full border border-border bg-bg-secondary px-3 text-xs font-medium text-text-primary shadow-lg transition-colors hover:bg-card"
          >
            <ArrowDown size={13} aria-hidden />
            {newCount > 0 ? t('shareGuest.chat.jumpEndN', { n: newCount }) : t('shareGuest.chat.jumpEnd')}
          </button>
        )}
        <Tooltip label={expandAll.open ? t('shareGuest.chat.collapseAll') : t('shareGuest.chat.expandAll')} side="left">
          <button
            type="button"
            data-chat-toggle-all={expandAll.open ? 'open' : 'closed'}
            onClick={() => setExpandAll((s) => ({ open: !s.open, v: s.v + 1 }))}
            aria-label={expandAll.open ? t('shareGuest.chat.collapseAll') : t('shareGuest.chat.expandAll')}
            className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-border bg-bg-secondary text-text-secondary shadow-lg transition-colors hover:bg-card hover:text-text-primary"
          >
            {expandAll.open ? <ChevronsDownUp size={15} /> : <ChevronsUpDown size={15} />}
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
