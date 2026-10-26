/**
 * The desktop console chat (app 2.7.0, A7; settings.labs.consoleChat): per
 * console, its transcript as a chat list (the phone's list rules,
 * src/shared/chatRows.ts) read from main's ChatHub, and which view its cell
 * shows (Terminal | Chat). Main checks the lab and the pane on every call;
 * this store only keeps what the views show. Nothing here is persisted
 * except the view choice, and nothing is ever written to a pty.
 *
 *  - `openConsoleChat(paneId)` starts reading (chat:sub, the first page as
 *    its answer) and returns the close. Main keeps ONE reader per window and
 *    pane, so two views of one console share it: the first open subscribes,
 *    the last close unsubscribes and forgets the list.
 *  - "Load earlier" is chat:more, one at a time; its page goes in front.
 *  - chat:frame brings the appends and the resets (a chatPage there is a new
 *    first page: /clear, a resume, the transcript that was coming).
 *  - A first page main did not get in time (`timeout`) shows [Retry]; it may
 *    still come later as a frame.
 *  - Main pauses a chat whose watcher goes to another one (ChatHub's LRU of
 *    4): the `paused` notice keeps the list on screen and nothing more comes
 *    until the user resumes it (a new chat:sub, a fresh first page). It is
 *    never resumed by itself: two chats on screen would take turns pausing
 *    each other.
 *  - `disabled` means main has not heard the lab yet (the renderer saves 400
 *    ms after a change and main waits 2 s for it): with the lab on here the
 *    config goes to main at once and the chat asks again, once per open; the
 *    lab turning on asks again for every chat refused that way.
 *  - `unknown_pane` means main has neither saved nor spawned the console
 *    yet (one just reopened: its save waits 400 ms, its pty its launch): a
 *    console this renderer has sends the config at once and asks again,
 *    once per open, and one still refused without a pty asks once more
 *    when its pty registers. Never a loop: past that, [Retry] is the user's.
 *  - The view per pane is saved under `snagentsos.paneView.<paneId>` (only
 *    'chat' is stored; the terminal is the default). `togglePaneView` is the
 *    `toggleConsoleChat` shortcut and its palette command, on the console
 *    `focusedChatConsole` names.
 */
import { useState } from 'react'
import { create } from 'zustand'
import { chatNoticeOf, type ChatMessage, type ChatUnavailableReason } from '@shared/chat-types'
import type { ChatFrameEvt, ChatIpcError, ChatPageFrame, ChatPageRes } from '@shared/ipc-contract'
import { labOn } from '@shared/labs'
import { visiblePaneIds } from '@shared/status'
import type { AgentProvider, Pane } from '@shared/types'
import { EMPTY_LIST, appendList, prependList, replaceList } from '@/components/chat/chatModel'
import type { ChatScrollerState } from '@/components/chat/ChatScroller'
import { useAppStore } from './store'
import { snapshotConfig } from './persist'
import { focusPane, getFocusedPane } from './focus'
import { getPtyId, onPtyRegistryChange } from './ptyRegistry'

export interface ConsoleChat extends ChatScrollerState {
  /** No chat for this console (FR-33): no transcript, ambiguous, not local. */
  notice: ChatUnavailableReason | null
  /** Main refused to read it: the lab is off there, too many chats, an unknown console. */
  refused: ChatIpcError | null
  /** Main closed its watcher for another chat: the list stays, nothing new comes until a resume. */
  paused: boolean
}

export const EMPTY_CONSOLE_CHAT: ConsoleChat = { list: EMPTY_LIST, loading: null, failed: null, version: 0, notice: null, refused: null, paused: false }

export type PaneView = 'terminal' | 'chat'

interface ConsoleChatState {
  /** paneId -> its chat, while some view reads it. */
  chats: Record<string, ConsoleChat>
  /** paneId -> the view chosen in this session (absent: the saved one). */
  views: Record<string, PaneView>
}

export const useConsoleChatStore = create<ConsoleChatState>(() => ({ chats: {}, views: {} }))

// --- Reading ------------------------------------------------------------------------

/** Open views per pane. */
const readers = new Map<string, number>()
/** Per pane, the generation of its latest chat:sub: an older answer is stale (also one from before a close and reopen). */
const gens = new Map<string, number>()
/** Per pane, the "Load earlier" in flight; a first page drops it, so a late older page never lands on a new list. */
const mores = new Map<string, number>()
/** Panes whose `disabled` refusal already sent the config and asked again in this open. */
const labRetried = new Set<string>()
/** Panes whose `unknown_pane` refusal already sent the config and asked again in this open. */
const paneRetried = new Set<string>()
/** Per pane refused as `unknown_pane` with no pty yet, the stop of its one wait for the pty to register. */
const ptyWaits = new Map<string, () => void>()
let genSeq = 0
let stopFrames: (() => void) | null = null
let stopLab: (() => void) | null = null

const labIsOn = (): boolean => labOn(useAppStore.getState().settings, 'consoleChat')

/**
 * The config to main now instead of 400 ms later (persist.ts): main reads the
 * lab from each save, in order, so a chat:sub sent after this sees it. The
 * debounced save still goes and writes the same or newer.
 */
function sendConfigNow(): void {
  if (!useAppStore.getState().hydrated) return
  try {
    window.snApi.config.save(snapshotConfig())
  } catch {
    /* the debounced save still goes */
  }
}

/** While some chat is read: the lab turning on asks again for every chat main refused as `disabled`. */
function watchLab(): void {
  if (stopLab) return
  let was = labIsOn()
  try {
    stopLab = useAppStore.subscribe((s) => {
      const on = labOn(s.settings, 'consoleChat')
      if (on === was) return
      was = on
      if (!on) return
      labRetried.clear()
      const chats = useConsoleChatStore.getState().chats
      const refused = Object.keys(chats).filter((id) => readers.has(id) && chats[id].refused === 'disabled')
      if (refused.length === 0) return
      sendConfigNow()
      for (const id of refused) chatFirst(id)
    })
  } catch {
    stopLab = null
  }
}

function patchChat(paneId: string, next: Partial<ConsoleChat>): void {
  if (!readers.has(paneId)) return
  useConsoleChatStore.setState((s) => ({ chats: { ...s.chats, [paneId]: { ...(s.chats[paneId] ?? EMPTY_CONSOLE_CHAT), ...next } } }))
}

function chatOf(paneId: string): ConsoleChat | undefined {
  return useConsoleChatStore.getState().chats[paneId]
}

/**
 * A first page (the answer to chat:sub, or a reset frame): replaces the list,
 * or the notice. One read while main closed its watcher comes marked paused.
 */
function applyFirst(paneId: string, page: ChatPageFrame): void {
  mores.delete(paneId)
  const cur = chatOf(paneId) ?? EMPTY_CONSOLE_CHAT
  const items: ChatMessage[] = Array.isArray(page.items) ? page.items : []
  const notice = chatNoticeOf(items)
  if (notice) {
    patchChat(paneId, { list: EMPTY_LIST, loading: null, failed: null, notice, refused: null, paused: false })
    return
  }
  const list = replaceList({ items, cursor: typeof page.cursor === 'string' ? page.cursor : null, done: page.done === true })
  patchChat(paneId, { list, loading: null, failed: null, notice: null, refused: null, paused: page.notice === 'paused', version: cur.version + 1 })
}

function onFrame(e: ChatFrameEvt): void {
  if (!e || typeof e.paneId !== 'string' || !e.frame) return
  const cur = chatOf(e.paneId)
  // Nobody reads this pane any more: a late frame is dropped.
  if (!cur || !readers.has(e.paneId)) return
  if (e.frame.type === 'chatAppend') {
    // ChatHub's LRU closed its watcher: the list stays as it is, marked paused.
    if (e.frame.notice === 'paused') {
      if (!cur.notice && !cur.refused) patchChat(e.paneId, { paused: true })
      return
    }
    const items = Array.isArray(e.frame.items) ? e.frame.items : []
    if (!cur.notice && !cur.refused) patchChat(e.paneId, { list: appendList(cur.list, items) })
    return
  }
  if (e.frame.type === 'chatPage') applyFirst(e.paneId, e.frame)
}

/** One of this renderer's consoles (in some workspace): the next config tells main about it. */
function paneHere(paneId: string): boolean {
  return useAppStore.getState().workspaces.some((w) => w.panes.some((p) => p.id === paneId))
}

/**
 * Refused as `unknown_pane` with no pty here yet: main also knows a console
 * by its live pty, so the pty registering asks once more (if still refused
 * that way). Once per open: the wait stays spent until the close.
 */
function waitForPty(paneId: string): void {
  if (ptyWaits.has(paneId) || getPtyId(paneId)) return
  const stop = onPtyRegistryChange(() => {
    if (!getPtyId(paneId)) return
    stop()
    ptyWaits.set(paneId, () => undefined)
    if (readers.has(paneId) && chatOf(paneId)?.refused === 'unknown_pane') chatFirst(paneId)
  })
  ptyWaits.set(paneId, stop)
}

function refusedFirst(paneId: string, error: ChatIpcError): void {
  if (error === 'timeout') {
    patchChat(paneId, { loading: null, failed: 'first' })
    return
  }
  if (error === 'disabled' && labIsOn() && !labRetried.has(paneId)) {
    // On here, off in main: the save has not reached it (debounced, slower than main's 2 s wait). Now, then once more.
    labRetried.add(paneId)
    sendConfigNow()
    chatFirst(paneId)
    return
  }
  if (error === 'unknown_pane' && !paneRetried.has(paneId) && paneHere(paneId)) {
    // Here, not in main yet: its save has not reached it (a reopened console, 400 ms). Now, then once more.
    paneRetried.add(paneId)
    sendConfigNow()
    chatFirst(paneId)
    return
  }
  patchChat(paneId, { list: EMPTY_LIST, loading: null, failed: null, notice: null, refused: error, paused: false })
  if (error === 'unknown_pane') waitForPty(paneId)
}

/** chat:sub: the first page (a repeat is a fresh first page in main). */
export function chatFirst(paneId: string): void {
  if (!readers.has(paneId)) return
  const gen = ++genSeq
  gens.set(paneId, gen)
  mores.delete(paneId)
  patchChat(paneId, { loading: 'first', failed: null, notice: null, refused: null })
  const stale = (): boolean => gens.get(paneId) !== gen || !readers.has(paneId)
  let req: Promise<ChatPageRes>
  try {
    req = window.snApi.chat.sub({ paneId })
  } catch {
    req = Promise.resolve({ ok: false, error: 'timeout' })
  }
  req.then(
    (res) => {
      if (stale()) return
      if (res?.ok) applyFirst(paneId, res.page)
      else refusedFirst(paneId, res?.error ?? 'timeout')
    },
    () => {
      if (!stale()) refusedFirst(paneId, 'timeout')
    },
  )
}

/** "Load earlier": the page before the oldest message held. */
export function chatMore(paneId: string): void {
  const cur = chatOf(paneId)
  const cursor = cur?.list.cursor
  if (!cur || !cursor || cur.list.done || cur.list.capped || cur.loading || cur.notice || cur.refused) return
  const token = ++genSeq
  mores.set(paneId, token)
  patchChat(paneId, { loading: 'more', failed: null })
  // A first page in between (a reset frame, a new sub) or a close drops the request.
  const stale = (): boolean => {
    if (mores.get(paneId) !== token || !readers.has(paneId)) return true
    mores.delete(paneId)
    return false
  }
  let req: Promise<ChatPageRes>
  try {
    req = window.snApi.chat.more({ paneId, before: cursor })
  } catch {
    req = Promise.resolve({ ok: false, error: 'timeout' })
  }
  req.then(
    (res) => {
      if (stale()) return
      const now = chatOf(paneId) ?? EMPTY_CONSOLE_CHAT
      if (!res?.ok) {
        patchChat(paneId, { loading: null, failed: 'more' })
        return
      }
      const items: ChatMessage[] = Array.isArray(res.page.items) ? res.page.items : []
      const notice = chatNoticeOf(items)
      if (notice) {
        patchChat(paneId, { list: EMPTY_LIST, loading: null, failed: null, notice, paused: false })
        return
      }
      const page = { items, cursor: typeof res.page.cursor === 'string' ? res.page.cursor : null, done: res.page.done === true }
      patchChat(paneId, { list: prependList(now.list, page), loading: null, failed: null })
    },
    () => {
      if (!stale()) patchChat(paneId, { loading: null, failed: 'more' })
    },
  )
}

function forget(paneId: string): void {
  useConsoleChatStore.setState((s) => {
    if (!s.chats[paneId]) return s
    const chats = { ...s.chats }
    delete chats[paneId]
    return { chats }
  })
}

/**
 * Start reading a console's chat for one view; returns that view's close
 * (idempotent). The first open subscribes in main and the last close
 * unsubscribes, since main keeps one reader per window and pane.
 */
export function openConsoleChat(paneId: string): () => void {
  const n = (readers.get(paneId) ?? 0) + 1
  readers.set(paneId, n)
  if (n === 1) {
    if (!stopFrames) {
      try {
        stopFrames = window.snApi.chat.onFrame(onFrame)
      } catch {
        stopFrames = null
      }
    }
    watchLab()
    useConsoleChatStore.setState((s) => ({ chats: { ...s.chats, [paneId]: EMPTY_CONSOLE_CHAT } }))
    chatFirst(paneId)
  }
  let closed = false
  return () => {
    if (closed) return
    closed = true
    const left = (readers.get(paneId) ?? 1) - 1
    if (left > 0) {
      readers.set(paneId, left)
      return
    }
    readers.delete(paneId)
    gens.delete(paneId)
    mores.delete(paneId)
    labRetried.delete(paneId)
    paneRetried.delete(paneId)
    ptyWaits.get(paneId)?.()
    ptyWaits.delete(paneId)
    try {
      window.snApi.chat.unsub({ paneId })
    } catch {
      /* main forgets the window's readers on reload anyway */
    }
    forget(paneId)
    if (readers.size === 0) {
      stopFrames?.()
      stopFrames = null
      stopLab?.()
      stopLab = null
    }
  }
}

// --- Terminal | Chat ------------------------------------------------------------------

export const PANE_VIEW_PREFIX = 'snagentsos.paneView.'

/** The saved view of a pane; the terminal when none (or storage is unavailable). */
export function loadPaneView(paneId: string): PaneView {
  try {
    return window.localStorage.getItem(PANE_VIEW_PREFIX + paneId) === 'chat' ? 'chat' : 'terminal'
  } catch {
    return 'terminal'
  }
}

function savePaneView(paneId: string, view: PaneView): void {
  try {
    if (view === 'chat') window.localStorage.setItem(PANE_VIEW_PREFIX + paneId, 'chat')
    else window.localStorage.removeItem(PANE_VIEW_PREFIX + paneId)
  } catch {
    /* the choice lasts for this session only */
  }
}

/** Show a pane's terminal or its chat, and remember it for that pane. */
export function setPaneView(paneId: string, view: PaneView): void {
  savePaneView(paneId, view)
  useConsoleChatStore.setState((s) => ({ views: { ...s.views, [paneId]: view } }))
}

/** The view a pane's cell shows: chosen in this session, else saved (read once per mount). */
export function usePaneView(paneId: string): PaneView {
  const [saved] = useState(() => loadPaneView(paneId))
  return useConsoleChatStore((s) => s.views[paneId]) ?? saved
}

/** An agent console (a Claude or Codex pane, or a shell whose status names its agent): the ones with the switch. */
export function chatCapablePane(pane: Pick<Pane, 'type'>, provider: AgentProvider | null | undefined): boolean {
  return pane.type === 'claude' || pane.type === 'codex' || !!provider
}

/**
 * The console the keyboard is on, when it can switch to its chat: Labs
 * consoleChat on, the focused console of the active workspace, on screen (not
 * minimized nor behind another's maximize) and an agent console. Else null.
 */
export function focusedChatConsole(): string | null {
  const s = useAppStore.getState()
  if (!labOn(s.settings, 'consoleChat')) return null
  const paneId = getFocusedPane()
  const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId)
  const pane = paneId && ws ? ws.panes.find((p) => p.id === paneId) : undefined
  if (!pane || !ws || !visiblePaneIds(ws, s.minimized[ws.id] ?? [], s.maximized[ws.id]).includes(pane.id)) return null
  return chatCapablePane(pane, s.paneStatus[pane.id]?.provider) ? pane.id : null
}

/** Show a pane's terminal or its chat, remember it, and move the keyboard there: the terminal, or the chat's composer. */
export function showPaneView(paneId: string, view: PaneView): void {
  setPaneView(paneId, view)
  requestAnimationFrame(() => {
    if (view === 'terminal') focusPane(paneId)
    else document.querySelector<HTMLElement>(`[data-console-chat="${CSS.escape(paneId)}"] [data-chat-composer]`)?.focus()
  })
}

/** Terminal <-> Chat on one console (the `toggleConsoleChat` shortcut and its palette command). */
export function togglePaneView(paneId: string): void {
  const now = useConsoleChatStore.getState().views[paneId] ?? loadPaneView(paneId)
  showPaneView(paneId, now === 'chat' ? 'terminal' : 'chat')
}
