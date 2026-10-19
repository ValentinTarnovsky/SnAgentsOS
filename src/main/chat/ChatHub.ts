/**
 * Connects the phones' Chat view to transcript watchers (E3 M12, FR-25..35).
 *
 *  - `chatSub` locates the console's transcript and answers a first
 *    `chatPage`; without one, a page whose only item is the FR-33 notice.
 *    A watcher opens only on a chatSub (FR-35: no setting, nothing opens
 *    otherwise) and closes 30s after its last reader left.
 *  - `chatMore` answers the page before the phone's cursor.
 *  - New lines go to every reader as `chatAppend`, split under 48KB; a file
 *    that shrinks or is replaced, or an assignment that changes (/clear, a
 *    resume, the hooks starting to report), sends a new first page, and an
 *    assignment that is lost sends the notice (StatusManager.onTranscriptChange).
 *  - At most 4 watchers stay open (LRU, idle ones go first).
 *  - A transcript that is coming (`pending`: a new console, or a /clear,
 *    before the first message) answers an empty first page instead of the
 *    notice, so the phone stays in Chat, and is located again every second
 *    while someone reads; after 10 minutes the wait ends with the notice.
 *
 * RemoteManager hands it to SessionManager; it never sees sockets, only an
 * owner object (the session) and the function that sends to it.
 */
import type { ChatMessage, ChatUnavailableReason } from '@shared/chat-types'
import type { AgentProvider } from '@shared/types'
import { decodeClaude } from './decodeClaude'
import { decodeCodex } from './decodeCodex'
import { splitAppend } from './chatFrames'
import { pathKey, type LocateResult } from './TranscriptLocator'
import { TranscriptWatcher, type ChatPageData, type TranscriptDecoder, type TranscriptWatcherDeps } from './TranscriptWatcher'

/** A watcher with no reader closes after this (FR-35). */
export const CHAT_CLOSE_DELAY_MS = 30 * 1000
/** Open watchers at most (NFR). */
export const CHAT_MAX_WATCHERS = 4
/** A pending transcript is located again this often while a phone reads. */
export const CHAT_PENDING_POLL_MS = 1000
/** A pending transcript that never appears gives up after this (then the notice). */
export const CHAT_PENDING_MAX_MS = 10 * 60 * 1000

/** The chat frames a session sends (SessionManager adds `v`). */
export type ChatFrame =
  | { type: 'chatPage'; paneId: string; items: ChatMessage[]; cursor: string | null; done: boolean }
  | { type: 'chatAppend'; paneId: string; items: ChatMessage[] }

export type ChatSend = (frame: ChatFrame) => void

/** What SessionManager calls (wired through RemoteManager). */
export interface ChatHooks {
  sub(owner: object, paneId: string, send: ChatSend): void
  unsub(owner: object, paneId: string): void
  more(owner: object, paneId: string, before: number, send: ChatSend): void
  /** The session's socket is gone: every chat of it ends. */
  closed(owner: object): void
}

export interface ChatHubDeps {
  locate: (paneId: string) => Promise<LocateResult>
  /** Injectable for tests. */
  createWatcher?: (deps: TranscriptWatcherDeps) => TranscriptWatcher
  closeDelayMs?: number
  maxWatchers?: number
  pendingPollMs?: number
  pendingMaxMs?: number
  now?: () => number
}

interface Reader {
  send: ChatSend
  /** Got its first page: appends go to it from here on. */
  live: boolean
}

interface PaneChat {
  paneId: string
  readers: Map<object, Reader>
  path: string | null
  provider: AgentProvider | null
  unavailable: ChatUnavailableReason | null
  watcher: TranscriptWatcher | null
  closeTimer: ReturnType<typeof setTimeout> | null
  /** Bumped by every (re)locate: stale async results are dropped. */
  gen: number
  locating: Promise<void> | null
  /** A re-locate in flight (transcriptChanged): a new reader waits for it. */
  relocating: Promise<void> | null
  /** Readers with a chatMore in flight: a repeat waits for the answer (one scan at a time each). */
  moreBusy: Set<object>
  usedAt: number
  /** When the transcript started to be pending (null: not pending). */
  pendingSince: number | null
  pollTimer: ReturnType<typeof setTimeout> | null
}

/** The first page of a chat whose transcript is not written yet. */
export function emptyPage(paneId: string): Extract<ChatFrame, { type: 'chatPage' }> {
  return { type: 'chatPage', paneId, items: [], cursor: null, done: true }
}

/** The FR-33 notice as a chatPage. */
export function noticePage(paneId: string, code: ChatUnavailableReason): Extract<ChatFrame, { type: 'chatPage' }> {
  return { type: 'chatPage', paneId, items: [{ id: 'notice', role: 'system', ts: null, blocks: [{ t: 'notice', code }] }], cursor: null, done: true }
}

export function decoderFor(provider: AgentProvider): TranscriptDecoder {
  return provider === 'codex' ? decodeCodex : decodeClaude
}

let useSeq = 0

export class ChatHub implements ChatHooks {
  private readonly panes = new Map<string, PaneChat>()

  constructor(private readonly deps: ChatHubDeps) {}

  // --- ChatHooks ---------------------------------------------------------------

  sub(owner: object, paneId: string, send: ChatSend): void {
    const pc = this.paneOf(paneId)
    this.cancelClose(pc)
    pc.usedAt = ++useSeq
    // A repeated chatSub (a resync) is a fresh first page for that reader.
    pc.readers.set(owner, { send, live: false })
    void this.deliverFirst(pc, owner)
  }

  unsub(owner: object, paneId: string): void {
    const pc = this.panes.get(paneId)
    if (!pc || !pc.readers.delete(owner)) return
    if (pc.readers.size === 0) this.scheduleClose(pc)
  }

  more(owner: object, paneId: string, before: number, send: ChatSend): void {
    const pc = this.panes.get(paneId)
    if (!pc || !pc.readers.has(owner) || pc.moreBusy.has(owner)) return
    pc.usedAt = ++useSeq
    pc.moreBusy.add(owner)
    void this.answerMore(pc, owner, before, send).finally(() => pc.moreBusy.delete(owner))
  }

  /** One chatMore: the page before `before`, or the notice when the chat is gone. */
  private async answerMore(pc: PaneChat, owner: object, before: number, send: ChatSend): Promise<void> {
    await this.ensure(pc)
    if (!pc.readers.has(owner)) return
    if (!pc.watcher) {
      send(pc.pendingSince !== null ? emptyPage(pc.paneId) : noticePage(pc.paneId, pc.unavailable ?? 'noTranscript'))
      return
    }
    try {
      const page = await pc.watcher.pageBefore(before)
      if (pc.readers.has(owner)) send({ type: 'chatPage', paneId: pc.paneId, ...page })
    } catch {
      // An unreadable file reads as no chat rather than a hung spinner.
      if (pc.readers.has(owner)) send(noticePage(pc.paneId, 'noTranscript'))
    }
  }

  closed(owner: object): void {
    for (const pc of this.panes.values()) {
      if (pc.readers.delete(owner) && pc.readers.size === 0) this.scheduleClose(pc)
    }
  }

  // --- Assignment changes ----------------------------------------------------------

  /** StatusManager.onTranscriptChange: re-locate a pane someone reads. */
  transcriptChanged(paneId: string): void {
    const pc = this.panes.get(paneId)
    if (!pc || pc.readers.size === 0) return
    void this.relocate(pc)
  }

  /** Transcript paths already held, for the locator's "not claimed by another console". */
  claims(): Map<string, string> {
    const out = new Map<string, string>()
    for (const pc of this.panes.values()) if (pc.path) out.set(pathKey(pc.path), pc.paneId)
    return out
  }

  /** Open watchers right now (tests, diagnostics). */
  get openWatchers(): number {
    let n = 0
    for (const pc of this.panes.values()) if (pc.watcher) n++
    return n
  }

  /** The path a pane's chat reads, or null. */
  pathOf(paneId: string): string | null {
    return this.panes.get(paneId)?.path ?? null
  }

  dispose(): void {
    for (const pc of this.panes.values()) {
      this.cancelClose(pc)
      this.cancelPoll(pc)
      pc.watcher?.close()
      pc.watcher = null
    }
    this.panes.clear()
  }

  // --- Internals ------------------------------------------------------------------

  private paneOf(paneId: string): PaneChat {
    let pc = this.panes.get(paneId)
    if (!pc) {
      pc = { paneId, readers: new Map(), path: null, provider: null, unavailable: null, watcher: null, closeTimer: null, gen: 0, locating: null, relocating: null, moreBusy: new Set(), usedAt: 0, pendingSince: null, pollTimer: null }
      this.panes.set(paneId, pc)
    }
    return pc
  }

  /** Locate once (concurrent callers share it) unless a watcher is already open. */
  private ensure(pc: PaneChat): Promise<void> {
    if (pc.watcher) return Promise.resolve()
    if (!pc.locating) {
      pc.locating = this.locateInto(pc).finally(() => {
        pc.locating = null
      })
    }
    return pc.locating
  }

  private async locateInto(pc: PaneChat): Promise<void> {
    const gen = ++pc.gen
    let res: LocateResult
    try {
      res = await this.deps.locate(pc.paneId)
    } catch {
      res = { ok: false, reason: 'noTranscript' }
    }
    if (gen !== pc.gen || !this.panes.has(pc.paneId)) return
    if (!res.ok) {
      pc.path = null
      pc.provider = null
      pc.unavailable = res.reason
      this.notePending(pc, !!res.pending)
      return
    }
    pc.unavailable = null
    pc.pendingSince = null
    pc.path = res.path
    pc.provider = res.provider
    this.open(pc)
  }

  /**
   * Starts (or keeps) the wait of a pending transcript; false when it is not
   * pending, or the wait just ran out (then the notice applies).
   */
  private notePending(pc: PaneChat, pending: boolean): boolean {
    const now = this.deps.now?.() ?? Date.now()
    if (pending && pc.pendingSince === null) pc.pendingSince = now
    if (!pending || now - pc.pendingSince! >= (this.deps.pendingMaxMs ?? CHAT_PENDING_MAX_MS)) {
      pc.pendingSince = null
      this.cancelPoll(pc)
      return false
    }
    return true
  }

  /** Locate a pending transcript again shortly, while someone reads. */
  private schedulePoll(pc: PaneChat): void {
    if (pc.pollTimer) return
    pc.pollTimer = setTimeout(() => {
      pc.pollTimer = null
      if (pc.readers.size === 0 || pc.watcher || pc.pendingSince === null) return
      void this.relocate(pc)
    }, this.deps.pendingPollMs ?? CHAT_PENDING_POLL_MS)
    pc.pollTimer.unref?.()
  }

  private cancelPoll(pc: PaneChat): void {
    if (pc.pollTimer) clearTimeout(pc.pollTimer)
    pc.pollTimer = null
  }

  private open(pc: PaneChat): void {
    if (!pc.path || !pc.provider) return
    this.evictFor(pc)
    const watcherDeps: TranscriptWatcherDeps = {
      path: pc.path,
      decode: decoderFor(pc.provider),
      paneId: pc.paneId,
      onAppend: (items) => this.broadcastAppend(pc, watcher, items),
      onReset: (page) => this.broadcastPage(pc, watcher, page),
    }
    const watcher = this.deps.createWatcher ? this.deps.createWatcher(watcherDeps) : new TranscriptWatcher(watcherDeps)
    pc.watcher = watcher
    watcher.start()
  }

  /** Keep at most CHAT_MAX_WATCHERS open: idle panes go first, then the least recently used. */
  private evictFor(pc: PaneChat): void {
    const max = this.deps.maxWatchers ?? CHAT_MAX_WATCHERS
    const open = [...this.panes.values()].filter((p) => p.watcher && p !== pc)
    while (open.length >= max) {
      open.sort((a, b) => (a.readers.size === 0 ? 0 : 1) - (b.readers.size === 0 ? 0 : 1) || a.usedAt - b.usedAt)
      const victim = open.shift()!
      victim.watcher?.close()
      victim.watcher = null
      if (victim.readers.size === 0) {
        this.cancelClose(victim)
        this.panes.delete(victim.paneId)
      }
    }
  }

  private async deliverFirst(pc: PaneChat, owner: object): Promise<void> {
    await this.ensure(pc)
    // A re-locate that started meanwhile supersedes the locate above (its
    // result was dropped): answer from what the re-locate decides.
    while (!pc.watcher && pc.relocating) await pc.relocating
    const reader = pc.readers.get(owner)
    if (!reader) return
    if (!pc.watcher) {
      if (pc.pendingSince !== null) {
        // The transcript is coming: an empty chat now, the first page when it appears.
        reader.send(emptyPage(pc.paneId))
        reader.live = true
        this.schedulePoll(pc)
        return
      }
      reader.send(noticePage(pc.paneId, pc.unavailable ?? 'noTranscript'))
      return
    }
    try {
      await pc.watcher.firstPage((page) => {
        const r = pc.readers.get(owner)
        if (!r) return
        r.send({ type: 'chatPage', paneId: pc.paneId, ...page })
        r.live = true
      })
    } catch {
      const r = pc.readers.get(owner)
      if (r) r.send(noticePage(pc.paneId, 'noTranscript'))
    }
  }

  private relocate(pc: PaneChat): Promise<void> {
    const run = this.relocateNow(pc).finally(() => {
      if (pc.relocating === run) pc.relocating = null
    })
    pc.relocating = run
    return run
  }

  private async relocateNow(pc: PaneChat): Promise<void> {
    const before = pc.path
    const wasUnavailable = pc.unavailable
    const wasPending = pc.pendingSince !== null
    const gen = ++pc.gen
    let res: LocateResult
    try {
      res = await this.deps.locate(pc.paneId)
    } catch {
      res = { ok: false, reason: 'noTranscript' }
    }
    if (gen !== pc.gen || pc.readers.size === 0) return
    if (res.ok && before && pathKey(res.path) === pathKey(before) && pc.watcher) return
    if (!res.ok) {
      const pending = this.notePending(pc, !!res.pending)
      if (!before) {
        pc.unavailable = res.reason
        if (pending) {
          // Still waiting for the first message: the readers already have an empty chat.
          if (!wasPending) for (const r of pc.readers.values()) { r.send(emptyPage(pc.paneId)); r.live = true }
          this.schedulePoll(pc)
          return
        }
        if (!wasPending && wasUnavailable === res.reason) return
        // The wait ran out (or stopped being a wait): FR-33 notice.
        for (const r of pc.readers.values()) r.send(noticePage(pc.paneId, res.reason))
        return
      }
      pc.watcher?.close()
      pc.watcher = null
      pc.path = null
      pc.provider = null
      pc.unavailable = res.reason
      for (const r of pc.readers.values()) {
        if (pending) {
          // A new session (/clear, a resume) whose file is not written yet: an empty chat.
          r.send(emptyPage(pc.paneId))
          r.live = true
        } else {
          // FR-33: the chat open on the phone lost its transcript.
          r.send(noticePage(pc.paneId, res.reason))
        }
      }
      if (pending) this.schedulePoll(pc)
      return
    }
    pc.watcher?.close()
    pc.watcher = null
    pc.pendingSince = null
    this.cancelPoll(pc)
    pc.path = res.path
    pc.provider = res.provider
    pc.unavailable = null
    this.open(pc)
    // FR-30: another session (/clear, a resume): a new first page for everyone.
    for (const owner of [...pc.readers.keys()]) {
      const r = pc.readers.get(owner)
      if (r) r.live = false
      void this.deliverFirst(pc, owner)
    }
  }

  private broadcastAppend(pc: PaneChat, watcher: TranscriptWatcher, items: ChatMessage[]): void {
    if (pc.watcher !== watcher) return
    const frames = splitAppend(pc.paneId, items)
    for (const r of pc.readers.values()) {
      if (!r.live) continue
      for (const chunk of frames) r.send({ type: 'chatAppend', paneId: pc.paneId, items: chunk })
    }
  }

  private broadcastPage(pc: PaneChat, watcher: TranscriptWatcher, page: ChatPageData): void {
    if (pc.watcher !== watcher) return
    for (const r of pc.readers.values()) {
      if (r.live) r.send({ type: 'chatPage', paneId: pc.paneId, ...page })
    }
  }

  private scheduleClose(pc: PaneChat): void {
    this.cancelClose(pc)
    pc.closeTimer = setTimeout(() => {
      pc.closeTimer = null
      if (pc.readers.size > 0) return
      this.cancelPoll(pc)
      pc.watcher?.close()
      pc.watcher = null
      pc.gen++
      this.panes.delete(pc.paneId)
    }, this.deps.closeDelayMs ?? CHAT_CLOSE_DELAY_MS)
    pc.closeTimer.unref?.()
  }

  private cancelClose(pc: PaneChat): void {
    if (pc.closeTimer) clearTimeout(pc.closeTimer)
    pc.closeTimer = null
  }
}
