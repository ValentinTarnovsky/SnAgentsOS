/**
 * The answers of a share guest's Files drawer (app 2.6.0) fitted to one host
 * frame. A folder list or a text file can still outgrow SHARE_LIMITS.
 * hostFrameMax once framed (JSON escapes a control character to six bytes),
 * and HostSessions drops a frame past it: a list is cut (`truncated`), a text
 * is cut on a whole character (`partial`), an image that does not fit is
 * `too_large`.
 */
import { SHARE_LIMITS, type ShareFilesReply } from '@shared/share-protocol'

/** Room for one filesRes in a host frame, its envelope (`t`, `id`) and slack aside. */
export const SHARE_FILES_REPLY_BUDGET = SHARE_LIMITS.hostFrameMax - 4096

const framed = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8')

/** The first `n` UTF-16 units, without splitting a surrogate pair. */
function cut(text: string, n: number): string {
  if (n >= text.length) return text
  const code = text.charCodeAt(n - 1)
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n)
}

/** The largest n in [0, max] with fits(n), fits being monotone (fits(0) assumed). */
function largest(max: number, fits: (n: number) => boolean): number {
  let lo = 0
  let hi = max
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fits(mid)) lo = mid
    else hi = mid - 1
  }
  return lo
}

export function fitFilesReply(reply: ShareFilesReply, budget = SHARE_FILES_REPLY_BUDGET): ShareFilesReply {
  if (framed(reply) <= budget) return reply
  if (reply.entries) {
    const all = reply.entries
    const n = largest(all.length, (k) => framed({ ...reply, entries: all.slice(0, k), truncated: true }) <= budget)
    return { ...reply, entries: all.slice(0, n), truncated: true }
  }
  const file = reply.file
  if (file?.kind === 'text') {
    const n = largest(file.text.length, (k) => framed({ ...reply, file: { ...file, text: cut(file.text, k), partial: true } }) <= budget)
    return { ...reply, file: { ...file, text: cut(file.text, n), partial: true } }
  }
  return { ok: false, error: 'too_large' }
}
