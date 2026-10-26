import { ipcMain, type WebContents } from 'electron'
import { CH } from '@shared/ipc-channels'
import type { ChatFrameEvt, ChatIpcError, ChatPageRes } from '@shared/ipc-contract'
import { normalizeLabs } from '@shared/labs'
import { findPaneInConfig } from '@shared/paneConfig'
import type { ConfigFile } from '@shared/types'
import type { ChatHooks, ChatSend } from '../chat/ChatHub'

/** A chat:sub or chat:more without its page by then answers `timeout`. */
export const CHAT_IPC_WAIT_MS = 10 * 1000
/** Chats one window reads at once (a phone session reads 8 at most). */
export const CHAT_DESKTOP_MAX_SUBS = 16
/** A chat:sub while the lab is off waits this long for the CONFIG_SAVE that turns it on (the renderer saves 400 ms after a change). */
export const CHAT_LAB_GRACE_MS = 2 * 1000
const PANE_ID_MAX = 64
const BEFORE_RE = /^\d{1,15}$/

export interface ChatIpcDeps {
  hub: ChatHooks
  /** The config main holds (configStore.load()): the lab at boot and the known panes. */
  config: () => ConfigFile | null
  /** A console with a live pty (one the renderer may not have saved yet). */
  running: (paneId: string) => boolean
  /** Test seam. */
  waitMs?: number
}

export interface ChatIpc {
  /** CONFIG_SAVE: labs.consoleChat again; on lets the chat:subs waiting for it through, off drops every reader of every window. */
  setConfig(config: unknown): void
}

/** One invoke waiting for its page: settles once (page, error or timeout). */
interface Waiter {
  settle(res: ChatPageRes): void
  promise: Promise<ChatPageRes>
}

/** A pane one window reads: the send registered in ChatHub and the chat:sub calls waiting for a first page. */
interface Reading {
  send: ChatSend
  waiters: Set<Waiter>
}

/** The ChatHub owner of one window (a fresh one after a reload). */
interface Owner {
  wc: WebContents
  reading: Map<string, Reading>
  /** The chat:more in flight per pane. */
  more: Map<string, Waiter>
}

const refuse = (error: ChatIpcError): ChatPageRes => ({ ok: false, error })
const CLOSED = refuse('closed')

function paneIdOf(raw: unknown): string | null {
  const paneId = raw && typeof raw === 'object' ? (raw as { paneId?: unknown }).paneId : undefined
  return typeof paneId === 'string' && paneId.length > 0 && paneId.length <= PANE_ID_MAX ? paneId : null
}

function labOf(config: unknown): boolean {
  const settings = config && typeof config === 'object' ? (config as { settings?: unknown }).settings : null
  return normalizeLabs(settings && typeof settings === 'object' ? (settings as { labs?: unknown }).labs : null).consoleChat
}

/**
 * Desktop console chat (app 2.7.0, A7; settings.labs.consoleChat): a window
 * reads a console's chat through ChatHub exactly like a phone session or a
 * Share guest does, so the LRU, the watcher cap and the 30s close hold as is.
 *
 *  - ONE owner per webContents: a repeated chat:sub is a fresh first page and
 *    one chat:unsub ends it (two views of a pane refcount in the renderer).
 *  - chat:sub and chat:more answer their page as the invoke result (10s at
 *    most); appends and resets go out as chat:frame to that window only, and
 *    so does ChatHub's `paused` notice (its watcher went to another chat).
 *  - The lab comes from main's config (at boot, then each CONFIG_SAVE through
 *    normalizeLabs), never from a flag in a chat request: while it is off
 *    everything answers `disabled`, and turning it off drops every reader.
 *    The renderer shows a chat as soon as its own settings turn the lab on
 *    but saves them 400 ms later, so a chat:sub ahead of that save waits for
 *    it (2s at most) before it answers `disabled`; a chat:unsub of that pane
 *    meanwhile makes it answer `closed` without registering a reader.
 *    The pane must be a console main knows (config or a live pty).
 *  - A reload, a crash or a closed window drops all the readers of the window.
 *  - Read only: nothing here writes to a pty.
 */
export function registerChatIpc(deps: ChatIpcDeps): ChatIpc {
  const waitMs = deps.waitMs ?? CHAT_IPC_WAIT_MS
  const owners = new Map<WebContents, Owner>()
  const wired = new WeakSet<WebContents>()
  let enabled = labOf(deps.config())
  /** chat:subs that came while the lab is off, each waiting a short while for it to turn on. */
  const labWaits = new Set<(on: boolean) => void>()
  /** Who each of those waits is for: a chat:unsub of that window and pane meanwhile cancels it. */
  const labAsks = new Set<{ wc: WebContents; paneId: string | null; cancelled: boolean }>()

  const labTurnsOn = (): Promise<boolean> =>
    new Promise((resolve) => {
      const done = (on: boolean): void => {
        clearTimeout(timer)
        labWaits.delete(done)
        resolve(on)
      }
      const timer = setTimeout(() => done(false), CHAT_LAB_GRACE_MS)
      timer.unref?.()
      labWaits.add(done)
    })

  const wait = (onDone: (w: Waiter) => void): Waiter => {
    let resolve!: (res: ChatPageRes) => void
    let open = true
    const promise = new Promise<ChatPageRes>((r) => {
      resolve = r
    })
    const w: Waiter = {
      promise,
      settle: (res) => {
        if (!open) return
        open = false
        clearTimeout(timer)
        onDone(w)
        resolve(res)
      },
    }
    const timer = setTimeout(() => w.settle(refuse('timeout')), waitMs)
    timer.unref?.()
    return w
  }

  const known = (paneId: string): boolean => {
    if (deps.running(paneId)) return true
    try {
      return findPaneInConfig(deps.config(), paneId) !== null
    } catch {
      return false
    }
  }

  const live = (owner: Owner): boolean => owners.get(owner.wc) === owner

  const push = (owner: Owner, evt: ChatFrameEvt): void => {
    if (!owner.wc.isDestroyed()) owner.wc.send(CH.CHAT_FRAME, evt)
  }

  const stop = (owner: Owner, paneId: string): void => {
    const reading = owner.reading.get(paneId)
    if (!reading) return
    owner.reading.delete(paneId)
    for (const w of [...reading.waiters]) w.settle(CLOSED)
    owner.more.get(paneId)?.settle(CLOSED)
    deps.hub.unsub(owner, paneId)
  }

  const drop = (owner: Owner | undefined): void => {
    if (!owner || !live(owner)) return
    owners.delete(owner.wc)
    for (const reading of owner.reading.values()) for (const w of [...reading.waiters]) w.settle(CLOSED)
    for (const w of [...owner.more.values()]) w.settle(CLOSED)
    owner.reading.clear()
    deps.hub.closed(owner)
  }

  const watch = (wc: WebContents): void => {
    if (wired.has(wc)) return
    wired.add(wc)
    wc.on('destroyed', () => drop(owners.get(wc)))
    wc.on('render-process-gone', () => drop(owners.get(wc)))
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) drop(owners.get(wc))
    })
  }

  const ownerOf = (wc: WebContents): Owner => {
    let owner = owners.get(wc)
    if (!owner) {
      owner = { wc, reading: new Map(), more: new Map() }
      owners.set(wc, owner)
      watch(wc)
    }
    return owner
  }

  const readingOf = (owner: Owner, paneId: string): Reading => {
    const reading: Reading = {
      waiters: new Set(),
      send: (frame) => {
        if (!enabled || !live(owner) || owner.reading.get(paneId) !== reading) return
        // The first page after a chat:sub answers it; any later one is a reset.
        if (frame.type === 'chatPage' && reading.waiters.size > 0) {
          for (const w of [...reading.waiters]) w.settle({ ok: true, page: frame })
          return
        }
        push(owner, { paneId, frame })
      },
    }
    return reading
  }

  ipcMain.handle(CH.CHAT_SUB, async (e, raw: unknown): Promise<ChatPageRes> => {
    const paneId = paneIdOf(raw)
    if (!enabled) {
      const ask = { wc: e.sender, paneId, cancelled: false }
      labAsks.add(ask)
      const on = await labTurnsOn()
      labAsks.delete(ask)
      if (!on || !enabled) return refuse('disabled')
      // The view went away while this waited: it registers nothing.
      if (ask.cancelled) return CLOSED
    }
    if (paneId === null) return refuse('bad_request')
    if (!known(paneId)) return refuse('unknown_pane')
    // A window already gone would hold a reader no `destroyed` event releases.
    if (e.sender.isDestroyed()) return CLOSED
    const owner = ownerOf(e.sender)
    let reading = owner.reading.get(paneId)
    if (!reading) {
      if (owner.reading.size >= CHAT_DESKTOP_MAX_SUBS) return refuse('limit')
      reading = readingOf(owner, paneId)
      owner.reading.set(paneId, reading)
    }
    const r = reading
    const w = wait((done) => r.waiters.delete(done))
    r.waiters.add(w)
    deps.hub.sub(owner, paneId, r.send)
    return w.promise
  })

  ipcMain.on(CH.CHAT_UNSUB, (e, raw: unknown) => {
    const paneId = paneIdOf(raw)
    if (paneId === null) return
    for (const ask of labAsks) if (ask.wc === e.sender && ask.paneId === paneId) ask.cancelled = true
    const owner = owners.get(e.sender)
    if (owner) stop(owner, paneId)
  })

  ipcMain.handle(CH.CHAT_MORE, async (e, raw: unknown): Promise<ChatPageRes> => {
    if (!enabled) return refuse('disabled')
    const paneId = paneIdOf(raw)
    const before = raw && typeof raw === 'object' ? (raw as { before?: unknown }).before : undefined
    if (paneId === null || typeof before !== 'string' || !BEFORE_RE.test(before)) return refuse('bad_request')
    const offset = Number(before)
    if (!Number.isSafeInteger(offset)) return refuse('bad_request')
    const owner = owners.get(e.sender)
    if (!owner || !owner.reading.has(paneId)) return refuse('not_subscribed')
    if (owner.more.has(paneId)) return refuse('busy')
    const w = wait((done) => {
      if (owner.more.get(paneId) === done) owner.more.delete(paneId)
    })
    owner.more.set(paneId, w)
    deps.hub.more(owner, paneId, offset, (frame) => {
      if (frame.type === 'chatPage' && enabled && live(owner)) w.settle({ ok: true, page: frame })
    })
    return w.promise
  })

  return {
    setConfig(config) {
      enabled = labOf(config)
      if (enabled) for (const done of [...labWaits]) done(true)
      else for (const owner of [...owners.values()]) drop(owner)
    },
  }
}
