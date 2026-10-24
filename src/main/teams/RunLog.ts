// Adaptado de paperclipai/paperclip (MIT) - packages/adapters/claude-local/src/ui/parse-stdout.ts
/**
 * The log of one team run (app 2.7.0, E10 B2, design 3.3 and 3.5):
 * `teams/<id>/runs/<runId>.jsonl`. Line 1 is the prompt the run got
 * (`snaos.prompt`, the stdin cut at CHAT_TEXT_MAX), then every raw stdout
 * line, appended with a sync write. Past RUN_LOG_MAX_BYTES one `snaos.cut`
 * line is written and the rest lives only in the in-memory ring; at close a
 * `snaos.stderr` line holds the redacted stderr tail.
 *
 * Message ids are VIRTUAL byte offsets: a counter of every byte seen, written
 * or not. Below the cut virtual equals the file offset, so `readPage` and
 * `chatMessageOffset` keep working; past it the ids stay unique and
 * increasing (design 3.5, C2.24). RunLog never registers with ChatHub
 * (decision 49): pages come from `RunLog.page`, live lines from `append`.
 */
import { closeSync, mkdirSync, openSync, writeSync } from 'fs'
import { dirname } from 'path'
import { CHAT_FRAME_MAX_BYTES, CHAT_SKIPPED_TEXT, CHAT_TEXT_MAX, chatMessageOffset, type ChatMessage } from '@shared/chat-types'
import { RUN_LOG_CUT_TEXT, RUN_LOG_MAX_BYTES, RUN_RING_MAX, teamPaneId, type RunMode, type WakeReason } from '@shared/teams'
import type { AgentProvider } from '@shared/types'
import { FrameBudget, shrinkMessage } from '../chat/chatFrames'
import { decodeClaude } from '../chat/decodeClaude'
import { decodeCodexExec } from '../chat/decodeCodexExec'
import { MAX_RECORD_BYTES, readPage, type TranscriptDecoder } from '../chat/TranscriptWatcher'

type Rec = Record<string, unknown>

function isRec(v: unknown): v is Rec {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * A `claude -p --output-format stream-json` record through the transcript
 * decoder: subagent lines carry `parent_tool_use_id` (the transcript's
 * `isSidechain`), and the tool result extras come as `tool_use_result`.
 */
export function decodeClaudeStream(record: unknown, offset: number): ChatMessage[] {
  if (!isRec(record)) return []
  return decodeClaude({ ...record, isSidechain: record.parent_tool_use_id != null, toolUseResult: record.toolUseResult ?? record.tool_use_result }, offset)
}

function systemRow(offset: number, text: string): ChatMessage {
  return { id: String(offset), role: 'system', ts: null, blocks: [{ t: 'text', text }] }
}

function tsOf(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

/** snaos.prompt -> user message; snaos.cut and snaos.stderr -> system rows; else the provider decoder. */
export function runDecoder(provider: AgentProvider): TranscriptDecoder {
  const inner: TranscriptDecoder = provider === 'codex' ? decodeCodexExec : decodeClaudeStream
  return (record, offset) => {
    if (isRec(record) && typeof record.type === 'string' && record.type.startsWith('snaos.')) {
      if (record.type === 'snaos.prompt') {
        const text = typeof record.text === 'string' ? record.text : ''
        return text ? [{ id: String(offset), role: 'user', ts: tsOf(record.at), blocks: [{ t: 'text', text: text.slice(0, CHAT_TEXT_MAX), truncated: text.length > CHAT_TEXT_MAX || undefined }] }] : []
      }
      if (record.type === 'snaos.cut') return [systemRow(offset, RUN_LOG_CUT_TEXT)]
      if (record.type === 'snaos.stderr') {
        const tail = typeof record.tail === 'string' ? record.tail.trim() : ''
        return tail ? [systemRow(offset, `stderr:\n${tail.slice(-CHAT_TEXT_MAX)}`)] : []
      }
      return []
    }
    return inner(record, offset)
  }
}

/** Drops a `truncated: undefined` left by the prompt row (JSON-equal pages across reads). */
function clean(msgs: ChatMessage[]): ChatMessage[] {
  for (const m of msgs) for (const b of m.blocks) if ('truncated' in b && b.truncated === undefined) delete (b as { truncated?: boolean }).truncated
  return msgs
}

export class RunLog {
  private fd: number | null = null
  /** Every byte seen so far (written or not): the next line's id. */
  private virtual = 0
  /** Bytes in the file. */
  private written = 0
  private _cutAt: number | null = null
  private readonly maxBytes: number
  private readonly ringMax: number
  private readonly decode: TranscriptDecoder
  private readonly _ring: ChatMessage[] = []

  constructor(private readonly o: { file: string; provider: AgentProvider; runId: string; now: () => number; maxBytes?: number; ring?: number }) {
    this.maxBytes = o.maxBytes ?? RUN_LOG_MAX_BYTES
    this.ringMax = o.ring ?? RUN_RING_MAX
    this.decode = runDecoder(o.provider)
    try {
      mkdirSync(dirname(o.file), { recursive: true })
      this.fd = openSync(o.file, 'w')
    } catch {
      // No log file (a full disk, a lock): the run still works, its chat lives in the ring only.
      this.fd = null
      this._cutAt = 0
    }
  }

  /** The virtual offset of the first byte not written to the file (null before the cut). */
  get cutAt(): number | null {
    return this._cutAt
  }

  /** Bytes in the file (Run.logBytes). */
  get bytes(): number {
    return this.written
  }

  /** The newest messages kept in memory (oldest first). */
  get ring(): readonly ChatMessage[] {
    return this._ring
  }

  /** Line 1: the stdin the run got, as the first user message of its chat. */
  writePrompt(stdin: string, meta: { mode: RunMode; trigger: WakeReason }): ChatMessage[] {
    const line = JSON.stringify({ type: 'snaos.prompt', at: new Date(this.o.now()).toISOString(), mode: meta.mode, trigger: meta.trigger, text: stdin.slice(0, CHAT_TEXT_MAX) })
    return this.line(line, true)
  }

  /**
   * One raw stdout line (no trailing newline) at the next virtual offset. A
   * line over MAX_RECORD_BYTES is written as it is (offsets stay aligned and
   * `readPage` skips it itself) while the ring keeps a "record skipped" row.
   */
  append(raw: string): ChatMessage[] {
    return this.line(raw, false)
  }

  /** The redacted stderr tail at close: in the file unless it was cut, always in the ring. */
  writeStderr(tail: string): void {
    if (!tail.trim()) return
    const line = JSON.stringify({ type: 'snaos.stderr', tail })
    if (this._cutAt === null) {
      this.line(line, true)
      return
    }
    const offset = this.virtual
    this.virtual += Buffer.byteLength(line, 'utf8') + 1
    this.remember(this.decodeLine(line, offset))
  }

  close(): void {
    if (this.fd === null) return
    try {
      closeSync(this.fd)
    } catch {
      /* already closed */
    }
    this.fd = null
  }

  private line(raw: string, own: boolean): ChatMessage[] {
    const text = raw + '\n'
    const size = Buffer.byteLength(text, 'utf8')
    // Past the cap: one cut line first (it takes its own virtual bytes), then this line in the ring only.
    if (this._cutAt === null && this.fd !== null && !own && this.written + size > this.maxBytes) this.cut()
    const offset = this.virtual
    this.virtual += size
    if (this._cutAt === null && this.fd !== null) {
      try {
        writeSync(this.fd, text)
        this.written += size
      } catch {
        this._cutAt = this.written
      }
    }
    const msgs = size > MAX_RECORD_BYTES ? [systemRow(offset, CHAT_SKIPPED_TEXT)] : this.decodeLine(raw, offset)
    return this.remember(msgs)
  }

  /** Writes the one `snaos.cut` line at the next virtual offset; from here on lines live in the ring only. */
  private cut(): void {
    const at = this.virtual
    const text = JSON.stringify({ type: 'snaos.cut', at }) + '\n'
    const size = Buffer.byteLength(text, 'utf8')
    this.virtual += size
    try {
      if (this.fd !== null) writeSync(this.fd, text)
      this.written += size
    } catch {
      /* the cut stands; the file simply ends earlier */
    }
    this._cutAt = this.written
    this.remember(this.decode({ type: 'snaos.cut', at }, at))
  }

  private decodeLine(raw: string, offset: number): ChatMessage[] {
    const text = raw.trim()
    if (!text || text[0] !== '{') return []
    try {
      return clean(this.decode(JSON.parse(text), offset))
    } catch {
      return []
    }
  }

  private remember(msgs: ChatMessage[]): ChatMessage[] {
    if (!msgs.length) return msgs
    this._ring.push(...msgs)
    if (this._ring.length > this.ringMax) this._ring.splice(0, this._ring.length - this.ringMax)
    return msgs
  }

  /**
   * One page of a run's chat, oldest first. While the run is live its ring
   * serves what it covers (`before` past the ring's oldest message, or the
   * newest page); below that, and for a finished run, `readPage` reads the
   * file. A `before` past the cut is clamped to the cut.
   */
  static async page(
    file: string,
    provider: AgentProvider,
    runId: string,
    before: number | null,
    maxBytes: number = CHAT_FRAME_MAX_BYTES,
    ring?: readonly ChatMessage[] | null,
    cutAt?: number | null,
  ): Promise<{ items: ChatMessage[]; cursor: string | null; done: boolean }> {
    const paneId = teamPaneId(runId)
    const offsetOf = (m: ChatMessage): number => chatMessageOffset(m.id) ?? 0
    if (ring && ring.length && (before === null || before > offsetOf(ring[0]))) {
      const budget = new FrameBudget('chatPage', paneId, maxBytes)
      const single = FrameBudget.single('chatPage', paneId, maxBytes)
      const picked: ChatMessage[] = []
      let i = ring.length - 1
      while (i >= 0 && before !== null && offsetOf(ring[i]) >= before) i--
      let reachedOldest = false
      for (; i >= 0; i--) {
        const m = shrinkMessage(ring[i], single)
        if (!budget.fits([m])) break
        budget.add([m])
        picked.unshift(m)
        if (i === 0) reachedOldest = true
      }
      const oldest = picked.length ? offsetOf(picked[0]) : before ?? 0
      let cursor: number | null = reachedOldest ? offsetOf(ring[0]) : oldest
      // Past the cut the gap between the cut and the ring is gone: continue from the file end.
      if (reachedOldest && cutAt !== null && cutAt !== undefined && cursor > cutAt) cursor = cutAt
      if (cursor !== null && cursor <= 0) cursor = null
      return { items: picked, cursor: cursor === null ? null : String(cursor), done: cursor === null }
    }
    let from = before
    if (from !== null && cutAt !== null && cutAt !== undefined && from > cutAt) from = cutAt
    try {
      const page = await readPage(file, runDecoder(provider), { before: from, paneId, maxBytes })
      return { items: clean(page.items), cursor: page.cursor, done: page.done }
    } catch {
      return { items: [], cursor: null, done: true }
    }
  }
}
