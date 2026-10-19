/**
 * Reads one transcript for the phone's Chat view (E3 M12, FR-26/30):
 *
 *  - pages: read backwards from a line boundary in 256KB chunks until 50
 *    messages or 48KB serialized, scanning 8MB at most (then `done:false`
 *    with the cursor where it stopped). The cursor is the byte offset of the
 *    oldest line read; a `before` from the phone is clamped to [0, size] and
 *    moved to the next line start;
 *  - tail: only complete lines past the last offset, the rest buffered; a
 *    record over 2MB (MAX_RECORD_BYTES, Orca's transcript tail reader) is
 *    dropped as a "record skipped" system row;
 *  - watch: fs.watch with a 150ms debounce plus a 2s safety poll (Windows
 *    loses events). A file that shrinks or is replaced resets the chat: a new
 *    first page instead of an append.
 *
 * Every read is async through a file handle, so a 50MB transcript never
 * blocks the main thread. Operations run one at a time per watcher, which
 * keeps a page and the tail offset consistent (no line both paged and appended).
 */
import { open, stat, type FileHandle } from 'fs/promises'
import { watch, type FSWatcher } from 'fs'
import { CHAT_SKIPPED_TEXT, type ChatMessage } from '@shared/chat-types'
import { FrameBudget, shrinkMessage } from './chatFrames'

/** Decodes one parsed transcript record that starts at byte `offset`. */
export type TranscriptDecoder = (record: unknown, offset: number) => ChatMessage[]

/** A record longer than this is dropped (Orca's transcript tail reader). */
export const MAX_RECORD_BYTES = 2 * 1024 * 1024
/** Backward read chunk. */
export const READ_CHUNK = 256 * 1024
/** Bytes one page scans at most (FR-26). */
export const PAGE_SCAN_MAX = 8 * 1024 * 1024
/** A skipped giant record may be scanned past up to this, so the cursor always moves. */
const GIANT_SCAN_MAX = 64 * 1024 * 1024
/** fs.watch debounce and safety poll. */
export const WATCH_DEBOUNCE_MS = 150
export const WATCH_POLL_MS = 2000
/** More than this appended at once reads as a reset (a new first page). */
const APPEND_MAX = PAGE_SCAN_MAX

const NL = 0x0a

export interface ChatPageData {
  items: ChatMessage[]
  /** Byte offset of the oldest line read; null with nothing before it. */
  cursor: string | null
  done: boolean
}

interface PageResult extends ChatPageData {
  /** Offset just past the last complete line (the tail starts here). */
  liveEnd: number
}

function skippedMessage(offset: number): ChatMessage {
  return { id: String(offset), role: 'system', ts: null, blocks: [{ t: 'text', text: CHAT_SKIPPED_TEXT }] }
}

function decodeLine(buf: Buffer, offset: number, decode: TranscriptDecoder): ChatMessage[] {
  const text = buf.toString('utf8').trim()
  if (!text) return []
  let record: unknown
  try {
    record = JSON.parse(text)
  } catch {
    return []
  }
  try {
    return decode(record, offset)
  } catch {
    return []
  }
}

/** The first line start at or after `pos` (0 stays 0, size stays size). */
async function alignForward(fh: FileHandle, pos: number, size: number): Promise<number> {
  if (pos <= 0) return 0
  if (pos >= size) return size
  const one = Buffer.alloc(1)
  await fh.read(one, 0, 1, pos - 1)
  if (one[0] === NL) return pos
  let at = pos
  const buf = Buffer.alloc(64 * 1024)
  while (at < size) {
    const len = Math.min(buf.length, size - at)
    const { bytesRead } = await fh.read(buf, 0, len, at)
    if (bytesRead <= 0) break
    const i = buf.subarray(0, bytesRead).indexOf(NL)
    if (i >= 0) return at + i + 1
    at += bytesRead
  }
  return size
}

export interface PageOptions {
  /** null = the newest page (from the end of the file). */
  before: number | null
  /** For the frame overhead of the budget. */
  paneId: string
  maxBytes?: number
  scanMax?: number
}

/**
 * One page of `path` ending at `before` (or at the last complete line),
 * oldest message first. Lines decode newest first and the page stops at 50
 * messages, at the frame budget or after scanning `scanMax` bytes.
 */
export async function readPage(path: string, decode: TranscriptDecoder, opts: PageOptions): Promise<PageResult> {
  const fh = await open(path, 'r')
  try {
    const { size } = await fh.stat()
    const fromEnd = opts.before === null
    const end = fromEnd ? size : await alignForward(fh, Math.min(Math.max(0, opts.before ?? 0), size), size)
    const scanMax = opts.scanMax ?? PAGE_SCAN_MAX
    const budget = new FrameBudget('chatPage', opts.paneId, opts.maxBytes)
    const single = FrameBudget.single('chatPage', opts.paneId, opts.maxBytes)
    const lines: ChatMessage[][] = []
    let liveEnd: number | null = fromEnd ? null : end
    let pos = end
    let carry: Buffer = Buffer.alloc(0)
    let giant = false
    let scanned = 0
    let lowest = end
    let stopped = false

    /** One complete line, newest first; false = the page is full. */
    const take = (msgs: ChatMessage[], offset: number): boolean => {
      if (msgs.length) {
        const fitted = msgs.map((m) => shrinkMessage(m, single))
        if (!budget.fits(fitted)) {
          if (budget.count > 0) return false
          // A lone line that still does not fit: keep what does.
          const some: ChatMessage[] = []
          for (const m of fitted) {
            if (!budget.fits([...some, m])) break
            some.push(m)
          }
          budget.add(some)
          lines.push(some)
          lowest = offset
          return false
        }
        budget.add(fitted)
        lines.push(fitted)
      }
      lowest = offset
      return budget.count < 50
    }

    while (pos > 0 && !stopped) {
      if (scanned >= (giant ? GIANT_SCAN_MAX : scanMax)) break
      const start = Math.max(0, pos - READ_CHUNK)
      const buf = Buffer.alloc(pos - start)
      await fh.read(buf, 0, buf.length, start)
      scanned += buf.length
      pos = start
      let data = carry.length ? Buffer.concat([buf, carry]) : buf
      if (liveEnd === null) {
        // The newest page: whatever follows the last newline is a line still being written.
        const last = data.lastIndexOf(NL)
        if (last < 0) {
          carry = data.length > MAX_RECORD_BYTES ? Buffer.alloc(0) : data
          continue
        }
        liveEnd = start + last + 1
        lowest = liveEnd
        data = data.subarray(0, last + 1)
      }
      // data ends with the newline of its newest line.
      let hi = data.length - 1
      for (;;) {
        const prev = hi > 0 ? data.lastIndexOf(NL, hi - 1) : -1
        if (prev < 0 && start > 0) break // its start is in an older chunk
        const lineStart = prev + 1
        const offset = start + lineStart
        const tooBig = giant || hi - lineStart > MAX_RECORD_BYTES
        const msgs = tooBig ? [skippedMessage(offset)] : decodeLine(data.subarray(lineStart, hi), offset, decode)
        giant = false
        if (!take(msgs, offset)) {
          stopped = true
          break
        }
        if (prev < 0) break
        hi = prev
      }
      if (stopped) break
      if (start > 0) {
        const head = data.subarray(0, hi + 1)
        if (head.length > MAX_RECORD_BYTES) {
          // A record over 2MB: keep only its newline and find where it starts.
          giant = true
          carry = Buffer.from([NL])
        } else {
          carry = Buffer.from(head)
        }
      }
    }
    const items = lines.reverse().flat()
    // Every line down to byte 0 was read: nothing before this page.
    const finished = (!stopped && pos === 0) || lowest === 0
    return { items, cursor: finished ? null : String(lowest), done: finished, liveEnd: liveEnd ?? (pos === 0 ? 0 : end) }
  } finally {
    await fh.close()
  }
}

/**
 * Complete lines in [from, size) of `path`, oldest first, and the offset just
 * past the last one. A record over 2MB becomes a "record skipped" row.
 */
export async function readAppend(path: string, from: number, decode: TranscriptDecoder): Promise<{ items: ChatMessage[]; next: number; size: number }> {
  const fh = await open(path, 'r')
  try {
    const { size } = await fh.stat()
    const items: ChatMessage[] = []
    let at = from
    let carry: Buffer = Buffer.alloc(0)
    let carryAt = from
    let skipping = false
    let next = from
    while (at < size) {
      const buf = Buffer.alloc(Math.min(READ_CHUNK, size - at))
      const { bytesRead } = await fh.read(buf, 0, buf.length, at)
      if (bytesRead <= 0) break
      const chunk = buf.subarray(0, bytesRead)
      let lineStart = 0
      for (;;) {
        const nl = chunk.indexOf(NL, lineStart)
        if (nl < 0) break
        if (skipping) {
          items.push(skippedMessage(carryAt))
          skipping = false
        } else {
          const line = carry.length ? Buffer.concat([carry, chunk.subarray(lineStart, nl)]) : chunk.subarray(lineStart, nl)
          if (line.length > MAX_RECORD_BYTES) items.push(skippedMessage(carryAt))
          else items.push(...decodeLine(line, carryAt, decode))
        }
        carry = Buffer.alloc(0)
        lineStart = nl + 1
        next = at + lineStart
        carryAt = next
      }
      if (lineStart < chunk.length && !skipping) {
        carry = Buffer.concat([carry, chunk.subarray(lineStart)])
        if (carry.length > MAX_RECORD_BYTES) {
          skipping = true
          carry = Buffer.alloc(0)
        }
      }
      at += bytesRead
    }
    return { items, next, size }
  } finally {
    await fh.close()
  }
}

export interface TranscriptWatcherDeps {
  path: string
  decode: TranscriptDecoder
  /** Frame overhead of the pages this watcher builds. */
  paneId: string
  /** New complete lines (oldest first); never empty. */
  onAppend: (items: ChatMessage[]) => void
  /** The file shrank or was replaced: a new first page for everyone (FR-30). */
  onReset: (page: ChatPageData) => void
  /** Injectable for tests: fs.watch. */
  watchFile?: (path: string, onChange: () => void) => { close(): void } | null
  debounceMs?: number
  pollMs?: number
}

function defaultWatch(path: string, onChange: () => void): FSWatcher | null {
  try {
    const w = watch(path, { persistent: false }, () => onChange())
    w.on('error', () => undefined)
    return w
  } catch {
    return null
  }
}

/** One open transcript: pages on demand and a live tail. */
export class TranscriptWatcher {
  readonly path: string
  private offset = -1
  private identity = ''
  private queue: Promise<unknown> = Promise.resolve()
  private fsw: { close(): void } | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private debounce: ReturnType<typeof setTimeout> | null = null
  private closed = false

  constructor(private readonly deps: TranscriptWatcherDeps) {
    this.path = deps.path
  }

  /** Start watching (idempotent). */
  start(): void {
    if (this.closed || this.poll) return
    this.fsw = (this.deps.watchFile ?? defaultWatch)(this.path, () => this.kick())
    this.poll = setInterval(() => void this.check(), this.deps.pollMs ?? WATCH_POLL_MS)
    this.poll.unref?.()
  }

  close(): void {
    this.closed = true
    this.fsw?.close()
    this.fsw = null
    if (this.poll) clearInterval(this.poll)
    this.poll = null
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = null
  }

  get isClosed(): boolean {
    return this.closed
  }

  /**
   * The newest page as of the tail offset. The first call establishes the
   * offset; later ones first hand the pending tail to the current readers,
   * so the page ends exactly where the next append begins. `deliver` runs
   * inside the same serialized step, before any later append: the caller
   * registers its reader there and never sees a line twice or misses one.
   */
  firstPage(deliver?: (page: ChatPageData) => void): Promise<ChatPageData> {
    return this.run(async () => {
      let page: ChatPageData
      if (this.offset < 0) {
        page = await this.reload()
      } else {
        await this.catchUp(true)
        const read = await readPage(this.path, this.deps.decode, { before: this.offset, paneId: this.deps.paneId })
        page = { items: read.items, cursor: read.cursor, done: read.done }
      }
      deliver?.(page)
      return page
    })
  }

  /** The page before `before` (FR-26). */
  pageBefore(before: number): Promise<ChatPageData> {
    return this.run(async () => {
      const limit = this.offset >= 0 ? Math.min(before, this.offset) : before
      const page = await readPage(this.path, this.deps.decode, { before: limit, paneId: this.deps.paneId })
      return { items: page.items, cursor: page.cursor, done: page.done }
    })
  }

  /** Look for new lines now (also what the watch and the poll call). */
  check(): Promise<void> {
    return this.run(() => this.catchUp(true)) as Promise<void>
  }

  private kick(): void {
    if (this.closed) return
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.debounce = null
      void this.check()
    }, this.deps.debounceMs ?? WATCH_DEBOUNCE_MS)
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async reload(): Promise<ChatPageData> {
    const page = await readPage(this.path, this.deps.decode, { before: null, paneId: this.deps.paneId })
    this.offset = page.liveEnd
    this.identity = await this.idOf()
    return { items: page.items, cursor: page.cursor, done: page.done }
  }

  private async idOf(): Promise<string> {
    try {
      const st = await stat(this.path)
      return `${st.dev}:${st.ino}:${Math.floor(st.birthtimeMs)}`
    } catch {
      return ''
    }
  }

  /** Read what was appended since the offset; `emit` sends it (and resets) to the hub. */
  private async catchUp(emit = false): Promise<void> {
    if (this.closed || this.offset < 0) return
    let size: number
    try {
      size = (await stat(this.path)).size
    } catch {
      return
    }
    const id = await this.idOf()
    if (size < this.offset || (id && this.identity && id !== this.identity) || size - this.offset > APPEND_MAX) {
      const page = await this.reload()
      if (emit && !this.closed) this.deps.onReset(page)
      return
    }
    if (size === this.offset) return
    const { items, next } = await readAppend(this.path, this.offset, this.deps.decode)
    this.offset = next
    if (emit && items.length && !this.closed) this.deps.onAppend(items)
  }
}
