/**
 * The Chat view of an agent console (E3 M12, FR-26..31): the transcript as
 * a chat, over the (paused, hidden) terminal. Oldest first, with:
 *
 *  - "Load earlier" at the top (chatMore) with a 3-row skeleton, keeping the
 *    scroll position when the older page lands;
 *  - tool calls folded into rows, the floating expand-all control and the
 *    "Go to the end (N)" pill past 200px from the end; at the end, new
 *    messages scroll in on their own;
 *  - "Claude is working..." while the status says working;
 *  - "The PC did not answer [Retry]" when a page never came (E3-FR-04);
 *  - long-press actions per message (Copy, Select text).
 *
 * The list is a `role="log"`; only the newest assistant message is
 * announced (a polite live region), rows use `content-visibility: auto`, and
 * scrolling is instant under prefers-reduced-motion. The composer and the
 * answer cards stay below, in MainScreen.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Copy, Loader2, TextSelect } from 'lucide-react'
import { client } from '../../lib/client'
import { selectPaneChat, useChatStore } from '../../lib/chatStore'
import { buildRows, messageText, type ChatRow } from '../../lib/chatModel'
import { useRemoteStore } from '../../lib/store'
import { copyText } from '../../lib/clipboard'
import { t } from '../../lib/i18n'
import { Sheet } from '../Sheet'
import { ActionList } from '../ActionList'
import { NoReply } from '../NoReply'
import { MessageRow } from './MessageRow'
import { ToolRunRow } from './ToolRunRow'
import { FloatingControls } from './FloatingControls'

/** Within this many px of the end, the view follows new messages. */
const FOLLOW_PX = 40
/** Past this many px from the end, the "Go to the end" pill shows (FR-29). */
const JUMP_PX = 200

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

function Skeleton(): ReactNode {
  return (
    <div data-chat-skeleton aria-hidden className="flex flex-col gap-3 px-3 py-2">
      {[70, 90, 55].map((w, i) => (
        <div key={i} className="h-10 animate-pulse rounded-card bg-card motion-reduce:animate-none" style={{ width: `${w}%`, marginLeft: i === 1 ? 'auto' : undefined }} />
      ))}
    </div>
  )
}

export function ChatView({ paneId }: { paneId: string }): ReactNode {
  const chat = useChatStore((s) => selectPaneChat(s, paneId))
  const status = useRemoteStore((s) => s.paneStatus[paneId])
  const rows = useMemo(() => buildRows(chat.list.items), [chat.list.items])
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [showJump, setShowJump] = useState(false)
  const [newCount, setNewCount] = useState(0)
  const [expandAll, setExpandAll] = useState({ open: false, v: 0 })
  const [actions, setActions] = useState<{ id: string; el: HTMLElement | null } | null>(null)
  const [selectable, setSelectable] = useState<string | null>(null)
  const atEnd = useRef(true)

  // What the list looked like at the previous commit, to tell a prepend
  // (keep the reader's place) from an append (follow or count).
  const prev = useRef<{ first: string | null; last: string | null; count: number; version: number; height: number }>({
    first: null,
    last: null,
    count: 0,
    version: -1,
    height: 0,
  })

  const onScroll = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    atEnd.current = dist <= FOLLOW_PX
    setShowJump(dist > JUMP_PX)
    if (atEnd.current) setNewCount(0)
  }, [])

  const jump = useCallback((smooth = true): void => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' })
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
      // A first page (or a reset): start at the end.
      el.scrollTop = el.scrollHeight
      atEnd.current = true
      setNewCount(0)
      setShowJump(false)
    } else if (first !== p.first && last === p.last && p.count > 0) {
      // "Load earlier" landed: the same messages stay under the finger.
      el.scrollTop += el.scrollHeight - p.height
    } else if (last !== p.last && p.last !== null) {
      const at = items.findIndex((m) => m.id === p.last)
      const added = at >= 0 ? items.length - 1 - at : 1
      if (atEnd.current) el.scrollTop = el.scrollHeight
      else if (added > 0) setNewCount((n) => n + added)
    }
    prev.current = { first, last, count: items.length, version: chat.version, height: el.scrollHeight }
  }, [chat.list.items, chat.version])

  // The working row appearing at the end keeps a reader at the end there.
  const working = status?.state === 'working'
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && atEnd.current) el.scrollTop = el.scrollHeight
    if (el) prev.current.height = el.scrollHeight
  }, [working])

  // Leaving a selected message: back to long-press mode.
  useEffect(() => {
    if (!selectable) return
    const clear = (e: PointerEvent): void => {
      const row = (e.target as Element | null)?.closest?.('[data-chat-id]')
      if (!row || row.getAttribute('data-chat-id') !== selectable) setSelectable(null)
    }
    document.addEventListener('pointerdown', clear, true)
    return () => document.removeEventListener('pointerdown', clear, true)
  }, [selectable])

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

  const rowBlocks = (id: string): ChatRow | undefined => rows.find((r) => r.id === id)
  const agent = status?.provider === 'codex' ? 'Codex' : 'Claude'
  const firstLoading = chat.loading === 'first' && chat.list.items.length === 0
  const list = chat.list

  return (
    <div data-chat-view={paneId} className="absolute inset-0 flex flex-col bg-bg-primary">
      <div
        ref={scrollRef}
        data-scrollable
        data-chat-scroll
        role="log"
        aria-label={t('chat.log')}
        aria-live="off"
        onScroll={onScroll}
        className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain pb-16 pt-2"
      >
        {chat.failed === 'more' ? (
          <NoReply onRetry={() => client.requestChatMore(paneId)} />
        ) : chat.loading === 'more' ? (
          <Skeleton />
        ) : list.capped ? (
          <div data-chat-capped className="px-4 py-2 text-center text-[11px] text-text-secondary">
            {t('chat.olderOnPc')}
          </div>
        ) : !list.done && list.items.length > 0 ? (
          <div className="flex justify-center py-1">
            <button
              type="button"
              data-chat-load-earlier
              onClick={() => client.requestChatMore(paneId)}
              className="min-h-11 rounded-btn border border-border px-4 text-xs font-medium text-text-primary active:bg-card"
            >
              {t('chat.loadEarlier')}
            </button>
          </div>
        ) : null}

        {firstLoading && <Skeleton />}
        {chat.failed === 'first' && <NoReply onRetry={() => client.requestChatFirst(paneId)} />}
        {!firstLoading && !chat.failed && list.items.length === 0 && list.done && (
          <div data-chat-empty className="px-4 py-8 text-center text-sm text-text-secondary">
            {t('chat.empty')}
          </div>
        )}

        <div className="flex min-w-0 flex-col gap-3">
          {rows.map((row) => (
            <div key={row.id} className="min-w-0" style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 64px' }}>
              {row.kind === 'tools' ? (
                <ToolRunRow calls={row.calls} expandAll={expandAll} />
              ) : (
                <MessageRow
                  id={row.id}
                  role={row.role}
                  blocks={row.blocks}
                  selectable={selectable === row.id}
                  onActions={(id, el) => setActions({ id, el })}
                />
              )}
            </div>
          ))}
        </div>

        {working && (
          <div data-chat-working className="flex items-center gap-2 px-3 pt-3 text-xs text-text-secondary">
            <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden />
            {t('chat.working', { agent })}
          </div>
        )}
      </div>

      <div className="sr-only" aria-live="polite" data-chat-announce>
        {lastAssistant}
      </div>

      <FloatingControls
        allOpen={expandAll.open}
        onToggleAll={() => setExpandAll((s) => ({ open: !s.open, v: s.v + 1 }))}
        showJump={showJump}
        newCount={newCount}
        onJump={() => jump()}
      />

      <Sheet open={!!actions} onClose={() => setActions(null)} title={t('chat.messageActions')}>
        <ActionList
          items={[
            {
              id: 'copy',
              icon: <Copy size={16} />,
              label: t('chat.copy'),
              onSelect: () => {
                const row = actions ? rowBlocks(actions.id) : undefined
                const text = row && row.kind === 'message' ? messageText(row.blocks) : ''
                setActions(null)
                if (text && copyText(text)) useRemoteStore.getState().setToast(t('toast.copied'))
              },
            },
            {
              id: 'select',
              icon: <TextSelect size={16} />,
              label: t('chat.selectText'),
              onSelect: () => {
                const target = actions
                setActions(null)
                if (!target) return
                setSelectable(target.id)
                requestAnimationFrame(() => {
                  try {
                    if (target.el) window.getSelection()?.selectAllChildren(target.el)
                  } catch {
                    /* selection not available */
                  }
                })
              },
            },
          ]}
        />
      </Sheet>
    </div>
  )
}
