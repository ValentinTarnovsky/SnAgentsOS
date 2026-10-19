/**
 * The 48KB budget of every chat frame (E3-FR-02). A page stops adding
 * messages before it would pass it, an append splits into several frames, and
 * a single message that does not fit even alone is shrunk: its patch first
 * (hunks from the end, then lines), then its longest text, each cut marked
 * `truncated`. Sizes are UTF-8 bytes of the JSON the socket sends.
 */
import {
  CHAT_FRAME_MAX_BYTES,
  CHAT_PAGE_MAX_MESSAGES,
  type ChatBlock,
  type ChatMessage,
} from '@shared/chat-types'
import { PROTOCOL_VERSION } from '@shared/remote-protocol'
import { cutAt } from './chatText'

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}

/**
 * Bytes of a chat frame with an empty `items`, using the widest cursor and
 * `done` so the figure holds for any page.
 */
export function frameOverhead(type: 'chatPage' | 'chatAppend', paneId: string): number {
  const frame =
    type === 'chatPage'
      ? { v: PROTOCOL_VERSION, type, paneId, items: [], cursor: '999999999999999', done: false }
      : { v: PROTOCOL_VERSION, type, paneId, items: [] }
  return jsonBytes(frame)
}

type ResultBlock = Extract<ChatBlock, { t: 'toolResult' }>

/** Drop one unit of patch: the last hunk's last line, or the last empty hunk. */
function trimPatch(block: ResultBlock): boolean {
  const hunks = block.patch?.hunks
  if (!hunks || hunks.length === 0) {
    if (block.patch) delete block.patch
    return false
  }
  const last = hunks[hunks.length - 1]
  if (hunks.length > 1) hunks.pop()
  else if (last.lines.length > 1) last.lines.length = Math.max(1, Math.floor(last.lines.length / 2))
  else delete block.patch
  block.truncated = true
  return true
}

/** The block whose text is longest, for halving. */
function longestText(blocks: ChatBlock[]): Extract<ChatBlock, { text: string }> | null {
  let best: Extract<ChatBlock, { text: string }> | null = null
  for (const b of blocks) {
    if ((b.t === 'text' || b.t === 'thinking' || b.t === 'toolResult') && b.text.length > 0) {
      if (!best || b.text.length > best.text.length) best = b
    }
  }
  return best
}

/** A copy of `msg` that serializes to at most `max` bytes (the budget left for one item). */
export function shrinkMessage(msg: ChatMessage, max: number): ChatMessage {
  if (jsonBytes(msg) <= max) return msg
  const copy: ChatMessage = JSON.parse(JSON.stringify(msg))
  // Patches go first: the text preview still tells what happened.
  for (const b of copy.blocks) {
    if (b.t !== 'toolResult') continue
    while (b.patch && jsonBytes(copy) > max && trimPatch(b)) {
      /* trim until it fits or the patch is gone */
    }
  }
  for (let guard = 0; jsonBytes(copy) > max && guard < 64; guard++) {
    const b = longestText(copy.blocks)
    if (!b) break
    b.text = cutAt(b.text, Math.floor(b.text.length / 2))
    b.truncated = true
  }
  // Still too big (hundreds of tool summaries): keep what fits.
  while (jsonBytes(copy) > max && copy.blocks.length > 1) copy.blocks.pop()
  return copy
}

/** Builds pages and appends under the budget, newest-first or oldest-first. */
export class FrameBudget {
  private used: number
  private readonly max: number
  count = 0

  constructor(type: 'chatPage' | 'chatAppend', paneId: string, maxBytes = CHAT_FRAME_MAX_BYTES) {
    this.used = frameOverhead(type, paneId)
    this.max = maxBytes
  }

  /** Bytes one more item may take (its JSON plus the separating comma). */
  get room(): number {
    return this.max - this.used - (this.count > 0 ? 1 : 0)
  }

  /** True when `msgs` fit together (and under the message cap when `capped`). */
  fits(msgs: ChatMessage[], capped = true): boolean {
    if (capped && this.count + msgs.length > CHAT_PAGE_MAX_MESSAGES) return false
    let bytes = 0
    let n = this.count
    for (const m of msgs) {
      bytes += jsonBytes(m) + (n > 0 ? 1 : 0)
      n++
    }
    return this.used + bytes <= this.max
  }

  add(msgs: ChatMessage[]): void {
    for (const m of msgs) {
      this.used += jsonBytes(m) + (this.count > 0 ? 1 : 0)
      this.count++
    }
  }

  /** The largest a lone item may be in an empty frame of this kind. */
  static single(type: 'chatPage' | 'chatAppend', paneId: string, maxBytes = CHAT_FRAME_MAX_BYTES): number {
    return maxBytes - frameOverhead(type, paneId)
  }
}

/** Splits appended messages (oldest first) into frames of at most 48KB each. */
export function splitAppend(paneId: string, items: ChatMessage[], maxBytes = CHAT_FRAME_MAX_BYTES): ChatMessage[][] {
  const out: ChatMessage[][] = []
  const single = FrameBudget.single('chatAppend', paneId, maxBytes)
  let cur: ChatMessage[] = []
  let budget = new FrameBudget('chatAppend', paneId, maxBytes)
  for (const raw of items) {
    const msg = shrinkMessage(raw, single)
    if (!budget.fits([msg], false) && cur.length) {
      out.push(cur)
      cur = []
      budget = new FrameBudget('chatAppend', paneId, maxBytes)
    }
    budget.add([msg])
    cur.push(msg)
  }
  if (cur.length) out.push(cur)
  return out
}
