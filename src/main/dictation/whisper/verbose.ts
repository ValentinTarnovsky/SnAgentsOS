/**
 * whisper-server `response_format=verbose_json` parsing (app 2.5.0). Pure.
 * The shape (measured on b5454): `{text, segments:[{id, text, tokens[],
 * words:[{word, probability}], temperature, avg_logprob, no_speech_prob}],
 * language, ...}`; silence with `vad=true` gives `{"text":"","segments":[]}`.
 * Fields are lenient: a bad number is left out, a segment without text is
 * skipped, and a body that is not JSON (or too big) gives null.
 */
import { z } from 'zod'

export const VERBOSE_MAX_BODY = 1_000_000
export const VERBOSE_MAX_SEGMENTS = 200
const MAX_WORDS = 2000

export interface VerboseSegment {
  text: string
  avgLogprob?: number
  noSpeechProb?: number
  /** Mean of `words[].probability`, when there is at least one. */
  meanP?: number
}

const num = z.number().finite().optional().catch(undefined)
const wordSchema = z.object({ probability: z.number().finite().min(0).max(1) }).passthrough()
const segmentSchema = z
  .object({
    text: z.string(),
    avg_logprob: num,
    no_speech_prob: num,
    words: z.array(z.unknown()).optional().catch(undefined),
  })
  .passthrough()
const bodySchema = z.object({ text: z.string().optional().catch(undefined), segments: z.array(z.unknown()).optional().catch(undefined) }).passthrough()

export function parseVerbose(body: string): VerboseSegment[] | null {
  if (typeof body !== 'string' || body.length > VERBOSE_MAX_BODY) return null
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return null
  }
  const doc = bodySchema.safeParse(raw)
  if (!doc.success) return null
  if (!doc.data.segments) {
    // No segment list: fall back on the top-level text, if any.
    const text = doc.data.text
    if (text === undefined) return null
    return text.trim() ? [{ text }] : []
  }
  const out: VerboseSegment[] = []
  for (const item of doc.data.segments.slice(0, VERBOSE_MAX_SEGMENTS)) {
    const seg = segmentSchema.safeParse(item)
    if (!seg.success) continue
    const s: VerboseSegment = { text: seg.data.text }
    if (seg.data.avg_logprob !== undefined) s.avgLogprob = seg.data.avg_logprob
    if (seg.data.no_speech_prob !== undefined) s.noSpeechProb = seg.data.no_speech_prob
    let sum = 0
    let n = 0
    for (const w of (seg.data.words ?? []).slice(0, MAX_WORDS)) {
      const word = wordSchema.safeParse(w)
      if (!word.success) continue
      sum += word.data.probability
      n++
    }
    if (n > 0) s.meanP = sum / n
    out.push(s)
  }
  return out
}
