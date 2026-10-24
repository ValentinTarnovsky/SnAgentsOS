/**
 * The chat of an agent console on the desktop (app 2.7.0, A7; Labs
 * `consoleChat`): the "Chat" side of the pane header's Terminal | Chat
 * switch. It covers the terminal, which stays mounted (hidden) with its pty
 * running behind it.
 *
 *  - On top, the console's status chips (A6: needs, failure, silence,
 *    context, muted), the same ones the header shows in short.
 *  - The transcript through ChatScroller, read from main while the cell is
 *    visible (chat:sub on show, chat:unsub on hide or unmount, chat:more for
 *    "Load earlier"; lib/consoleChatStore.ts). A chat main paused for
 *    another one (ChatHub's LRU) keeps its list under a bar that says so;
 *    only its [Resume], a click of the user, reads it again.
 *  - A composer that only types into the console: Enter in it is a new line,
 *    [Insert] writes the text through the shared delivery path (pty.submit,
 *    as Quick Commands do) without any Enter, and only [Send], a click of the
 *    user, adds the Enter after it. Both refuse while the agent waits on the
 *    user (typingBlocked, checked again in main: `userGate`), so a digit or
 *    an Enter never answers a permission or plan menu. A text main typed
 *    but whose Enter it held (`enter_held`: the agent started waiting in
 *    between) is in the console already: the composer empties and says so
 *    until it is used again, and only a later [Send], empty, presses that
 *    Enter. A focus request for the console (Ctrl+digit, a sidebar row, a
 *    palette pick) lands here, since the hidden xterm cannot take it, and
 *    the draft outlives a switch back to the terminal (in memory, this
 *    session only).
 *
 * Links open like the terminal's own links (openExternal, filtered in main).
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Pause, SquareTerminal } from 'lucide-react'
import type { Pane } from '@shared/types'
import { SUBMIT_TEXT_MAX, type SubmitError } from '@shared/initialPrompt'
import { typingBlocked } from '@shared/agentTune'
import { displayStatus } from '@shared/status'
import { useT, type MessageKey } from '@/i18n'
import { cn } from '@/lib/cn'
import { useAppStore } from '@/lib/store'
import { getPtyId, onPtyRegistryChange } from '@/lib/ptyRegistry'
import { onPaneFocusRequest, setFocusedPane } from '@/lib/focus'
import { EMPTY_CONSOLE_CHAT, chatFirst, chatMore, openConsoleChat, useConsoleChatStore, type ConsoleChat } from '@/lib/consoleChatStore'
import { StatusSignals } from '@/components/status/PaneSignals'
import { ChatScroller, type ChatScrollerTexts } from './ChatScroller'

const smallBtn =
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-btn border border-border px-2.5 text-xs font-medium transition-colors hover:bg-card disabled:pointer-events-none disabled:opacity-50'

/** Why a console has no chat to show, as the key of its explanation (null: just "not available"). */
function reasonKey(chat: ConsoleChat): MessageKey | null {
  if (chat.notice === 'noTranscript') return 'consoleChat.reason.noTranscript'
  if (chat.notice === 'ambiguous') return 'consoleChat.reason.ambiguous'
  if (chat.notice === 'notLocal') return 'consoleChat.reason.notLocal'
  if (chat.refused === 'disabled') return 'consoleChat.reason.disabled'
  if (chat.refused === 'limit') return 'consoleChat.reason.limit'
  if (chat.refused === 'unknown_pane') return 'consoleChat.reason.unknownPane'
  return null
}

/** Refusals another try can fix: too many chats (one closed since), a console main had not saved nor spawned yet. */
function retryable(chat: ConsoleChat): boolean {
  return chat.refused === 'limit' || chat.refused === 'unknown_pane'
}

function Unavailable({ paneId, chat, onTerminal }: { paneId: string; chat: ConsoleChat; onTerminal: () => void }) {
  const t = useT()
  const reason = reasonKey(chat)
  return (
    <div
      data-chat-view={paneId}
      data-chat-notice={chat.notice ?? chat.refused ?? ''}
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
    >
      <p className="text-sm text-text-secondary">{t('consoleChat.unavailable')}</p>
      {reason && <p className="max-w-sm text-xs text-text-secondary/80">{t(reason)}</p>}
      <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
        {retryable(chat) && (
          <button type="button" data-chat-retry onClick={() => chatFirst(paneId)} className={cn(smallBtn, 'text-text-primary')}>
            {t('shareGuest.extras.retry')}
          </button>
        )}
        <button type="button" data-console-chat-terminal onClick={onTerminal} className={cn(smallBtn, 'text-text-primary')}>
          <SquareTerminal size={13} aria-hidden />
          {t('consoleChat.backToTerminal')}
        </button>
      </div>
    </div>
  )
}

/** A refusal that typed nothing (`enter_held` typed the text: it is not one of these). */
function noteOfError(error: SubmitError): MessageKey {
  if (error === 'awaiting_user') return 'consoleChat.blocked'
  if (error === 'multiline_unsafe') return 'consoleChat.error.multiline'
  if (error === 'not_running') return 'consoleChat.notRunning'
  return 'consoleChat.error.failed'
}

/** Trailing line breaks would reach the console as typed Enters (prepareSubmit): they never go. */
function composerText(draft: string): string {
  return draft.replace(/[\r\n]+$/, '')
}

/** paneId -> the composer's unsent text while its chat is closed (Terminal, lab off). Never stored. */
const drafts = new Map<string, string>()
/**
 * paneId -> the pty that typed its last [Insert] or [Send] without the Enter
 * (`enter_held`): the note outlives the menu the agent opened and a trip to
 * the terminal to answer it, until the composer is used again or another pty
 * takes the console (a restart: the text went with the old one). Never stored.
 */
const heldPtys = new Map<string, string>()

function Composer({ paneId, onTerminal }: { paneId: string; onTerminal: () => void }) {
  const t = useT()
  const [draft, setDraftState] = useState(() => drafts.get(paneId) ?? '')
  const draftRef = useRef(draft)
  const boxRef = useRef<HTMLTextAreaElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<MessageKey | null>(null)
  const [heldPty, setHeldPty] = useState<string | null>(() => heldPtys.get(paneId) ?? null)
  const pty = useSyncExternalStore(onPtyRegistryChange, () => getPtyId(paneId) ?? null)
  const live = pty !== null
  const held = heldPty !== null && heldPty === pty
  const blocked = useAppStore((s) => typingBlocked(s.paneStatus[paneId]))
  const text = composerText(draft)
  const canSend = live && !blocked && !busy
  const canInsert = canSend && text.trim() !== ''
  const setDraft = (value: string): void => {
    draftRef.current = value
    if (value) drafts.set(paneId, value)
    else drafts.delete(paneId)
    setDraftState(value)
  }
  const setHeld = (ptyId: string | null): void => {
    if (ptyId) heldPtys.set(paneId, ptyId)
    else heldPtys.delete(paneId)
    setHeldPty(ptyId)
  }
  // A refusal said what the agent was doing then; once that changes the note is stale.
  // The held text is not: it is still typed in the console once the menu closes.
  useEffect(() => {
    setNote(null)
  }, [blocked])
  // Another pty took the console (a restart, also while the chat was closed): the held text went with the old one.
  useEffect(() => {
    if (heldPty === null || pty === null || pty === heldPty) return
    heldPtys.delete(paneId)
    setHeldPty(null)
  }, [pty, heldPty, paneId])
  // Ctrl+digit, a sidebar row or a palette pick asks for this console: its
  // xterm is hidden and cannot take the focus, which would stay where it was
  // (maybe another console), so the composer takes it once it is on screen.
  useEffect(() => {
    let raf = 0
    const off = onPaneFocusRequest((id) => {
      // A later request (this console or another) wins over one still waiting.
      cancelAnimationFrame(raf)
      if (id !== paneId) return
      let tries = 20
      const tick = (): void => {
        const el = boxRef.current
        if (!el) return
        if (el.getClientRects().length > 0) el.focus()
        else if (tries-- > 0) raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
    })
    return () => {
      off()
      cancelAnimationFrame(raf)
    }
  }, [paneId])

  // The Enter of [Send] is the user's (origin 'user'); [Insert] never sends one.
  const deliver = async (enter: boolean): Promise<void> => {
    const ptyId = getPtyId(paneId)
    if (!ptyId || busy) return
    if (!enter && text.trim() === '') return
    const typed = draft
    setBusy(true)
    setNote(null)
    setHeld(null)
    try {
      const res = await window.snApi.pty.submit({ ptyId, paneId, text, enter, userGate: true })
      // Typed either way (enter_held only dropped the Enter): sending it again would type it twice.
      // What was typed in the composer while it went stays for the next one.
      if ((res.ok || res.error === 'enter_held') && draftRef.current === typed) setDraft('')
      if (res.ok) setNote(enter ? null : 'consoleChat.inserted')
      else if (res.error === 'enter_held') setHeld(ptyId)
      else setNote(noteOfError(res.error))
    } catch {
      setNote('consoleChat.error.failed')
    } finally {
      setBusy(false)
    }
  }

  // The held note says the agent waits too, and stays once it no longer does (only on the pty that typed it).
  const shown: MessageKey =
    held ? 'consoleChat.error.held' : blocked ? 'consoleChat.blocked' : !live ? 'consoleChat.notRunning' : (note ?? 'consoleChat.hint')
  return (
    <div data-chat-composer-box className="shrink-0 border-t border-border bg-bg-secondary/40 px-3 py-2">
      <textarea
        ref={boxRef}
        data-chat-composer
        value={draft}
        rows={2}
        maxLength={SUBMIT_TEXT_MAX}
        aria-label={t('consoleChat.composer')}
        placeholder={t('consoleChat.placeholder')}
        spellCheck={false}
        // Typing here is typing in this console, as in its xterm (Quick Commands, review notes and a workspace switch follow it).
        onFocus={() => setFocusedPane(paneId, useAppStore.getState().activeWorkspaceId ?? undefined)}
        onChange={(e) => {
          setDraft(e.target.value)
          if (note) setNote(null)
          if (heldPty) setHeld(null)
        }}
        className="block max-h-40 min-h-[3rem] w-full resize-none rounded-btn border border-border bg-bg-primary px-2.5 py-1.5 text-[13px] leading-[1.4] text-text-primary outline-none placeholder:text-text-secondary/60 focus:border-accent-violet/50"
      />
      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2">
        <p data-chat-composer-note={shown} role="status" className="min-w-0 flex-1 text-[11px] leading-4 text-text-secondary">
          {t(shown)}
        </p>
        {blocked && (
          <button type="button" data-console-chat-terminal onClick={onTerminal} className={cn(smallBtn, 'text-text-secondary hover:text-text-primary')}>
            <SquareTerminal size={13} aria-hidden />
            {t('consoleChat.backToTerminal')}
          </button>
        )}
        <button type="button" data-chat-insert disabled={!canInsert} onClick={() => void deliver(false)} className={cn(smallBtn, 'text-text-secondary hover:text-text-primary')}>
          {t('consoleChat.insert')}
        </button>
        <button type="button" data-chat-send disabled={!canSend} onClick={() => void deliver(true)} className={cn(smallBtn, 'bg-card text-text-primary hover:border-accent-violet/40')}>
          {t('consoleChat.send')}
        </button>
      </div>
    </div>
  )
}

export interface ConsoleChatViewProps {
  pane: Pick<Pane, 'id' | 'type'>
  /** The cell is on screen: the chat is read only then. */
  active: boolean
  /** Back to the terminal (the notice and the blocked composer offer it). */
  onTerminal: () => void
}

export function ConsoleChatView({ pane, active, onTerminal }: ConsoleChatViewProps) {
  const t = useT()
  const paneId = pane.id
  const chat = useConsoleChatStore((s) => s.chats[paneId] ?? EMPTY_CONSOLE_CHAT)
  const status = useAppStore((s) => s.paneStatus[paneId])

  useEffect(() => {
    if (!active) return
    return openConsoleChat(paneId)
  }, [paneId, active])

  const onMore = useCallback(() => chatMore(paneId), [paneId])
  const onRetryFirst = useCallback(() => chatFirst(paneId), [paneId])
  const onLink = useCallback((href: string) => window.snApi.system.openExternal(href), [])
  const texts = useMemo<ChatScrollerTexts>(
    () => ({ log: t('consoleChat.log'), capped: t('consoleChat.capped'), noReply: t('consoleChat.noReply'), outputCut: t('consoleChat.outputCut') }),
    [t],
  )

  const agent = status?.provider === 'codex' || pane.type === 'codex' ? 'Codex' : 'Claude'
  const working = displayStatus(status)?.state === 'working'
  return (
    <div data-console-chat={paneId} className="absolute inset-0 flex min-h-0 min-w-0 flex-col bg-bg-primary">
      <div data-console-chat-signals className="flex min-w-0 shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5 empty:hidden">
        <StatusSignals paneId={paneId} status={status} ack wrap />
      </div>
      {!chat.notice && !chat.refused && chat.paused && (
        // Resuming may pause another chat (4 at most): it is the user's call, never automatic.
        <div data-chat-paused role="status" className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border bg-amber-400/10 px-3 py-1.5">
          <Pause size={13} aria-hidden className="shrink-0 text-amber-400" />
          <p className="min-w-0 flex-1 text-xs text-text-secondary">{t('consoleChat.paused')}</p>
          <button type="button" data-chat-resume disabled={chat.loading === 'first'} onClick={onRetryFirst} className={cn(smallBtn, 'text-text-primary')}>
            {t('consoleChat.resume')}
          </button>
        </div>
      )}
      {chat.notice || chat.refused ? (
        <Unavailable paneId={paneId} chat={chat} onTerminal={onTerminal} />
      ) : (
        <ChatScroller
          key={paneId}
          paneId={paneId}
          chat={chat}
          working={working}
          agent={agent}
          onMore={onMore}
          onRetryFirst={onRetryFirst}
          onLink={onLink}
          texts={texts}
        />
      )}
      <Composer paneId={paneId} onTerminal={onTerminal} />
    </div>
  )
}
