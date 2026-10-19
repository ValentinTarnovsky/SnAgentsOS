/**
 * Key groups that answer one AskUserQuestion of Claude Code from the phone
 * (E2-FR-20, 21): the TUI is driven with the same keys a person would type,
 * sent as plain `input` frames one group every ANSWER_STEP_MS. No new WS
 * message: the desktop only sees keystrokes.
 *
 * The sequence follows the approach the E2 PRD takes from Orca's native chat
 * ask flow (an independent implementation, no code copied):
 *  - single select: the option digit ("1".."8"); the TUI marks it and moves on;
 *  - multi select: one digit per checked option (each a group of its own, so
 *    Ink never reads "13" as one paste), then KEY_NEXT to the next tab;
 *  - "Other" (Type something): its digit, String(options.length + 1), the free
 *    text raw (sanitizeAskFreeText) and Enter as three groups. With the cap of
 *    ASK_MAX_OPTIONS it is at most "9", never "10" (read by the TUI as "1");
 *  - an unanswered question of a multi question ask: KEY_NEXT skips its tab;
 *  - the review tab at the end (any multi question ask, or a lone multi
 *    select question): KEY_SUBMIT ("1. Submit answers"). A lone single select
 *    question submits with its digit and has no review tab.
 *
 * The key constants live here so a TUI change is a one-line fix; the manual
 * check of R22-15 confirms them against Claude 2.1.x.
 */
import type { RemotePending } from './types'

/** One group every second: 500 ms for the TUI to submit plus 500 ms of slack. */
export const ANSWER_STEP_MS = 1000
/** A single select tap moves to the next question after this delay. */
export const ASK_AUTO_ADVANCE_MS = 200
/** Longer sequences are left to the terminal ("Answer in the terminal"). */
export const MAX_ANSWER_GROUPS = 24
export const ASK_MAX_OPTIONS = 8
export const ASK_MAX_QUESTIONS = 8
export const ASK_LABEL_MAX = 200
export const ASK_DESCRIPTION_MAX = 500
/** The "Other" text field caps at this many characters. */
export const ASK_OTHER_MAX = 2000

/** Next question tab (right arrow). */
export const KEY_NEXT = '\x1b[C'
/** Confirms the "Other" text. */
export const KEY_ENTER = '\r'
/** "1. Submit answers" on the review tab. */
export const KEY_SUBMIT = '1'

export type AskQuestion = NonNullable<RemotePending['questions']>[number]

/** What the user picked for one question: option indexes (0 based) and the "Other" text. */
export interface AskSelection {
  options: number[]
  /** Set (non blank after sanitizing) when "Other" is picked. */
  other?: string
}

/** A group of keys written as one `input` frame: `raw` keys or the free `text`. */
export type AnswerKeyGroup = { raw: string } | { text: string }

/** The bytes a group writes to the pty. */
export function groupData(group: AnswerKeyGroup): string {
  return 'raw' in group ? group.raw : group.text
}

/**
 * The "Other" text as it can be typed into the TUI: no ESC or other control
 * characters (C0, DEL, C1), line breaks turned into spaces, at most
 * ASK_OTHER_MAX characters, trimmed.
 */
export function sanitizeAskFreeText(text: string): string {
  return text
    .replace(/\r\n|[\r\n\u2028\u2029]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .slice(0, ASK_OTHER_MAX)
    .trim()
}

/** The phone can build an answer for these questions (E2-FR-17 limits). */
export function askQuestionsValid(questions: RemotePending['questions']): questions is AskQuestion[] {
  if (!Array.isArray(questions) || questions.length === 0 || questions.length > ASK_MAX_QUESTIONS) return false
  return questions.every(
    (q) =>
      !!q &&
      typeof q.question === 'string' &&
      Array.isArray(q.options) &&
      q.options.length > 0 &&
      q.options.length <= ASK_MAX_OPTIONS &&
      q.options.every(
        (o) =>
          !!o &&
          typeof o.label === 'string' &&
          o.label.length <= ASK_LABEL_MAX &&
          (o.description === undefined || (typeof o.description === 'string' && o.description.length <= ASK_DESCRIPTION_MAX)),
      ),
  )
}

/** The question has a usable answer in `sel`. */
export function selectionAnswered(question: AskQuestion, sel: AskSelection | undefined): boolean {
  if (!sel) return false
  const other = sel.other !== undefined && sanitizeAskFreeText(sel.other) !== ''
  const picked = sel.options.filter((i) => Number.isInteger(i) && i >= 0 && i < question.options.length)
  return question.multiSelect ? picked.length > 0 || other : picked.length === 1 || (picked.length === 0 && other)
}

/**
 * The key groups for `selections` (one per question, same order), or [] when
 * they cannot be answered from the phone: invalid questions, an option out of
 * range, a single select with more than one pick, or nothing answered (a lone
 * question must be answered; a multi question ask needs at least one). The
 * caller compares the length with MAX_ANSWER_GROUPS before sending.
 */
export function buildAskAnswerKeys(pending: Pick<RemotePending, 'questions'>, selections: readonly (AskSelection | undefined)[]): AnswerKeyGroup[] {
  const questions = pending.questions
  if (!askQuestionsValid(questions)) return []
  const groups: AnswerKeyGroup[] = []
  let answered = 0
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    const sel = selections[i]
    const n = q.options.length
    if (sel && sel.options.some((k) => !Number.isInteger(k) || k < 0 || k >= n)) return []
    const picks = sel ? [...new Set(sel.options)].sort((a, b) => a - b) : []
    const other = sel?.other !== undefined ? sanitizeAskFreeText(sel.other) : ''
    if (!q.multiSelect && (picks.length > 1 || (picks.length === 1 && other))) return []
    if (picks.length === 0 && !other) {
      // Unanswered: skip its tab (only a multi question ask can leave one out).
      if (questions.length === 1) return []
      groups.push({ raw: KEY_NEXT })
      continue
    }
    answered++
    for (const k of picks) groups.push({ raw: String(k + 1) })
    if (other) groups.push({ raw: String(n + 1) }, { text: other }, { raw: KEY_ENTER })
    if (q.multiSelect) groups.push({ raw: KEY_NEXT })
  }
  if (answered === 0) return []
  const lone = questions.length === 1
  if (!lone || questions[0].multiSelect) groups.push({ raw: KEY_SUBMIT })
  return groups
}
