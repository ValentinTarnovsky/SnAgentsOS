/**
 * Chat messages per console (E3 M12), fed by the WS client (chatPage,
 * chatAppend) and read by ChatView. The list rules live in chatModel.ts;
 * this store adds the loading and "The PC did not answer" state of the first
 * page and of "Load earlier" (E3-FR-04, FR-26).
 */
import { create } from 'zustand'
import type { ChatMessage } from '@shared/chat-types'
import { EMPTY_LIST, appendList, prependList, replaceList, type ChatList } from './chatModel'

export type ChatLoad = 'first' | 'more'

export interface PaneChat {
  list: ChatList
  loading: ChatLoad | null
  /** Which request ran out of time (or hit the rate limit). */
  failed: ChatLoad | null
  /** Bumped by every first page: the view jumps to the end. */
  version: number
}

const EMPTY_PANE: PaneChat = { list: EMPTY_LIST, loading: null, failed: null, version: 0 }

interface Page {
  items: ChatMessage[]
  cursor: string | null
  done: boolean
}

export interface ChatState {
  chats: Record<string, PaneChat>
  begin: (paneId: string, kind: ChatLoad) => void
  fail: (paneId: string, kind: ChatLoad) => void
  /** A first page (or a reset): the list is replaced. */
  replace: (paneId: string, page: Page) => void
  prepend: (paneId: string, page: Page) => void
  append: (paneId: string, items: ChatMessage[]) => void
  clear: (paneId: string) => void
}

function patch(chats: Record<string, PaneChat>, paneId: string, next: Partial<PaneChat>): Record<string, PaneChat> {
  return { ...chats, [paneId]: { ...(chats[paneId] ?? EMPTY_PANE), ...next } }
}

export const useChatStore = create<ChatState>((set) => ({
  chats: {},
  begin: (paneId, kind) => set((s) => ({ chats: patch(s.chats, paneId, { loading: kind, failed: null }) })),
  fail: (paneId, kind) =>
    set((s) => {
      const cur = s.chats[paneId] ?? EMPTY_PANE
      if (cur.loading !== kind) return s
      return { chats: patch(s.chats, paneId, { loading: null, failed: kind }) }
    }),
  replace: (paneId, page) =>
    set((s) => {
      const cur = s.chats[paneId] ?? EMPTY_PANE
      return { chats: patch(s.chats, paneId, { list: replaceList(page), loading: null, failed: null, version: cur.version + 1 }) }
    }),
  prepend: (paneId, page) =>
    set((s) => {
      const cur = s.chats[paneId] ?? EMPTY_PANE
      return { chats: patch(s.chats, paneId, { list: prependList(cur.list, page), loading: null, failed: null }) }
    }),
  append: (paneId, items) =>
    set((s) => {
      const cur = s.chats[paneId] ?? EMPTY_PANE
      return { chats: patch(s.chats, paneId, { list: appendList(cur.list, items) }) }
    }),
  clear: (paneId) =>
    set((s) => {
      if (!s.chats[paneId]) return s
      const chats = { ...s.chats }
      delete chats[paneId]
      return { chats }
    }),
}))

export const chatStore = useChatStore

/** One pane's chat (a stable empty one while none arrived). */
export function selectPaneChat(s: ChatState, paneId: string | null): PaneChat {
  return (paneId && s.chats[paneId]) || EMPTY_PANE
}
