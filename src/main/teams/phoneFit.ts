/**
 * Teams replies as they leave the machine for the phone (app 2.7.0, E10 B8, design 6.2 and 7.4). Pure, no Node beyond
 * Buffer: TeamService.remoteView runs every phone `teamReq` through phoneTeamReply and every phone ctl through
 * teamCtlRequest / teamCtlResult; the tests drive these functions directly.
 *
 *  - Every string of a reply is masked like the desktop's run rows (TeamService hands `mask`: redactCredentials and
 *    the live tokens of the app), since a frame to the phone leaves the PC.
 *  - The desktop-only fields never travel: a list item's repoRoot, takeovers and workspaceId (PhoneTeamListItem), a
 *    task worktree's path, and the `current` task of a conflict (the phone reloads).
 *  - Every teamRes fits TEAM_FRAME_MAX_BYTES with its envelope, measured as the JSON the socket sends with the widest
 *    request id: a task body is cut to TEAM_PHONE_BODY_MAX, a plan to TEAM_PHONE_PLAN_MAX, a hire diff to
 *    TEAM_PHONE_HIRE_LINES lines (each marked truncated). Lists that page keep their newest rows and move their cursor
 *    to the oldest row kept (task comments, the Lead thread, a run page by whole lines), so "Ver anteriores" reads what
 *    was left out. A board page of a column is asked again with a smaller `limit` (its cursor stays the one views.ts
 *    mints). Past that, the longest texts are cut until the frame fits; a reply that still would not fit answers
 *    `too_big` (SessionManager measures the real envelope once more).
 *  - The last pass never cuts what the user decides on (Tanda B close): a pending permission's rules and denied
 *    commands, a final OK's summary, an open card's question and options. When the frame cannot fit with them whole,
 *    the row whose long texts weigh the most goes read only (ApprovalView.pcOnly or CardView.pcOnly: the phone shows
 *    "En la PC" and no Aprobar nor answer) and only then are its texts cut, marked `truncated` on the payload or the
 *    card ("Sigue en la PC"; so is a cut of those texts on a row already decided). A row with nothing to cut never
 *    goes read only.
 */
import { chatMessageOffset, type ChatMessage } from '@shared/chat-types'
import type { RemoteCommandResult } from '@shared/ipc-contract'
import { PROTOCOL_VERSION } from '@shared/remote-protocol'
import {
  TEAM_FRAME_MAX_BYTES,
  TEAM_PHONE_BODY_MAX,
  TEAM_PHONE_HIRE_LINES,
  TEAM_PHONE_PLAN_MAX,
  type ApprovalPayloadView,
  type ApprovalView,
  type CardView,
  type PhoneTeamListItem,
  type PhoneTeamOp,
  type PhoneTeamRequest,
  type TaskDetail,
  type TaskSummary,
  type TeamCtlAction,
  type TeamListItem,
  type TeamReply,
  type TeamRequest,
} from '@shared/team-protocol'
import type { TeamFileDiff } from '@shared/teamDiff'
import { shrinkMessage } from '../chat/chatFrames'
import { cutAt } from '../chat/chatText'

/** Masks one text the way it may leave the machine. */
export type PhoneMask = (text: string) => string

/** The widest request id the schema lets in (gitReqId, 64 ASCII): a fit holds for any id. */
const WIDEST_ID = 'x'.repeat(64)
/** The widest board cursor a refit can mint (`done.<ms>.<n>`, `todo.<rank>.<ms>.<n>`), with room to spare. */
const WIDEST_CURSOR = 'x'.repeat(64)
/** A blocked text on a board row (the row shows a line; the task screen gets it whole). */
export const PHONE_BLOCKED_ROW_MAX = 500
/** One line of a hire diff (a role file line can be the whole 64 KB file). */
export const PHONE_HIRE_LINE_MAX = 500
/** Times a board page of a column is asked again with a smaller limit before it is cut here. */
const BOARD_REFIT_TRIES = 3
/** Strings shorter than this are never cut by the last pass (ids, cursors, enums, hashes). */
const SLOT_MIN = 64
/** The last pass never cuts a text below this many characters. */
const SLOT_FLOOR = SLOT_MIN / 2
/** Passes of the last pass: each one cuts about what is over, so a few do (a marker it adds, a narrower tail). */
const SHRINK_PASSES = 64
/** Keys the last pass never cuts, whatever their length. */
const SLOT_SKIP: ReadonlySet<string> = new Set(['id', 'cursor', 'commentsCursor', 'teamId', 'taskId', 'runId', 'agentId', 'approvalId', 'cardId'])
/** Detail codes a ctl ack names after its error (`bad_request:nothingToGrant`): the phone has its own words for them. */
export const PHONE_CTL_DETAILS: readonly string[] = ['nothingToGrant', 'grantsFull', 'secret']

/** UTF-8 bytes of the teamRes frame that carries `res`, with the widest id. */
export function teamResBytes(res: unknown): number {
  return Buffer.byteLength(JSON.stringify({ v: PROTOCOL_VERSION, type: 'teamRes', id: WIDEST_ID, res }))
}

/** Bytes one more row adds to a JSON array (its JSON and, after the first, a comma). */
function rowBytes(row: unknown, index: number): number {
  return Buffer.byteLength(JSON.stringify(row)) + (index > 0 ? 1 : 0)
}

/** A deep copy with every string masked (object keys stay: they are ids and field names). */
export function maskDeep<T>(value: T, mask: PhoneMask): T {
  if (typeof value === 'string') return mask(value) as unknown as T
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, mask)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = maskDeep(v, mask)
    return out as T
  }
  return value
}

// ---- views as the phone gets them -------------------------------------------------------------------

/** The sidebar row minus the desktop fields. */
export function phoneListItem(t: TeamListItem): PhoneTeamListItem {
  const { repoRoot: _root, takeovers: _takeovers, workspaceId: _ws, ...item } = t
  return item
}

/** A board row: its blocked text cut to one row's worth. */
function phoneSummary<T extends Pick<TaskSummary, 'blocked'>>(t: T, blockedMax: number): T {
  if (t.blocked?.text !== undefined && t.blocked.text.length > blockedMax) t.blocked.text = cutAt(t.blocked.text, blockedMax)
  return t
}

/** A hire diff cut to TEAM_PHONE_HIRE_LINES lines of PHONE_HIRE_LINE_MAX each, marked truncated when anything went. */
function phoneDiff(diff: TeamFileDiff): void {
  let left = TEAM_PHONE_HIRE_LINES
  let cut = false
  const hunks: TeamFileDiff['hunks'] = []
  for (const h of diff.hunks) {
    if (left <= 0) {
      cut = true
      break
    }
    const lines = h.lines.slice(0, left).map((l) => {
      if (l.length <= PHONE_HIRE_LINE_MAX) return l
      cut = true
      return cutAt(l, PHONE_HIRE_LINE_MAX)
    })
    if (lines.length < h.lines.length) cut = true
    left -= lines.length
    hunks.push({ ...h, lines })
  }
  diff.hunks = hunks
  if (cut) diff.truncated = true
}

/** An approval's bodies cut for the phone: a plan text to TEAM_PHONE_PLAN_MAX, a hire diff to its lines. */
function phoneApproval(a: ApprovalView): void {
  const p = a.payload
  if (p.kind === 'plan' && p.text.length > TEAM_PHONE_PLAN_MAX) {
    p.text = cutAt(p.text, TEAM_PHONE_PLAN_MAX)
    p.truncated = true
  }
  if (p.kind === 'hire') phoneDiff(p.diff)
}

// ---- the last pass: cut the longest texts -----------------------------------------------------------

interface Slot { len: number; set: (text: string) => void; get: () => string }

/** True for a TeamFileDiff (its texts mark the diff truncated). */
function isDiff(o: Record<string, unknown>): boolean {
  return typeof o.rel === 'string' && Array.isArray(o.hunks) && typeof o.status === 'string'
}

/** The marker a cut `text` of this object sets: a plan payload, a PlanView or a chat block carries `truncated`. */
function ownsTruncated(o: Record<string, unknown>, key: string): boolean {
  return key === 'text' && ('planRev' in o || ('status' in o && 'small' in o) || 't' in o)
}

/** The approval or card that goes read only on the phone (ApprovalView.pcOnly, CardView.pcOnly). */
type DecisionRow = Pick<ApprovalView | CardView, 'pcOnly'>
/** What holds the texts and their `truncated` mark: a final or permission payload, a card. */
type DecisionOn = Pick<Extract<ApprovalPayloadView, { kind: 'final' | 'permission' }> | CardView, 'truncated'>

/**
 * Texts the user decides on (Tanda B close): `keys` of `on` (a final or permission payload, a card). While `live` (a
 * pending approval, an open card) they are kept whole until `row` (its approval or card) goes `pcOnly`; any cut of
 * them marks `on` truncated, live or not.
 */
interface Decision { row: DecisionRow; on: DecisionOn; keys: readonly string[]; live: boolean }

/**
 * The decisions of a reply's approvals and cards: a permission's rules and denied commands, a final OK's summary, a
 * card's question and options. A plan travels cut to TEAM_PHONE_PLAN_MAX and marked (its row still decides); a system
 * card's words are main's.
 */
function decisionsOf(approvals: readonly ApprovalView[], cards: readonly CardView[]): Decision[] {
  const out: Decision[] = []
  for (const a of approvals) {
    const p = a.payload
    const live = a.state === 'pending'
    if (p.kind === 'permission') out.push({ row: a, on: p, keys: ['tools', 'denied'], live })
    else if (p.kind === 'final') out.push({ row: a, on: p, keys: ['summary'], live })
  }
  for (const c of cards) if (!c.system) out.push({ row: c, on: c, keys: ['question', 'options'], live: c.state === 'open' })
  return out
}

/** The decisions of one op's reply (Te necesita and the task carry approvals and cards). */
function replyDecisions(op: PhoneTeamOp, res: TeamReply): Decision[] {
  if (!res.ok) return []
  if (op === 'needs') {
    const n = (res as Extract<TeamReply<'needs'>, { ok: true }>).needs
    return decisionsOf(n.approvals, n.cards)
  }
  if (op === 'task') {
    const t = (res as Extract<TeamReply<'task'>, { ok: true }>).task
    return decisionsOf(t.approvals, t.cards)
  }
  return []
}

/**
 * Every string of SLOT_MIN or more characters, with how to cut it and what it marks. A live decision's texts are left
 * out while its row is not `pcOnly`; a cut of a decision's text marks its holder `truncated`. The keys are matched on
 * the object that holds them, so a rule inside `tools` (an array) is skipped as a whole.
 */
function slotsOf(root: unknown, decisions: readonly Decision[]): Slot[] {
  const out: Slot[] = []
  const held = new Map<object, Decision>(decisions.map((d) => [d.on, d]))
  const walk = (v: unknown, mark: (() => void) | null): void => {
    if (Array.isArray(v)) {
      v.forEach((x, i) => {
        if (typeof x === 'string') {
          if (x.length >= SLOT_MIN) out.push({ len: x.length, get: () => v[i] as string, set: (t) => { v[i] = t; mark?.() } })
        } else walk(x, mark)
      })
      return
    }
    if (!v || typeof v !== 'object') return
    const o = v as Record<string, unknown>
    const own = isDiff(o) ? () => { o.truncated = true } : mark
    const d = held.get(o)
    for (const [k, x] of Object.entries(o)) {
      const decided = d !== undefined && d.keys.includes(k)
      if (decided && d.live && !d.row.pcOnly) continue
      const m = decided || ownsTruncated(o, k) ? () => { o.truncated = true } : own
      if (typeof x === 'string') {
        if (x.length < SLOT_MIN || SLOT_SKIP.has(k)) continue
        out.push({ len: x.length, get: () => o[k] as string, set: (t) => { o[k] = t; m?.() } })
      } else walk(x, decided ? m : own)
    }
  }
  walk(root, null)
  return out
}

/** Bytes one string takes inside the frame's JSON (its escapes counted, its quotes not). */
function textBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text)) - 2
}

/**
 * Bytes of a decision's texts the last pass could cut, those of SLOT_MIN or more characters (which goes read only
 * first): a permission of many short rules weighs nothing here, since going read only frees nothing of it.
 */
function decisionBytes(d: Decision): number {
  const o = d.on as Record<string, unknown>
  let n = 0
  for (const k of d.keys) {
    const v = o[k]
    for (const s of Array.isArray(v) ? v : [v]) if (typeof s === 'string' && s.length >= SLOT_MIN) n += textBytes(s)
  }
  return n
}

/**
 * Cuts the longest texts of `root` down to one shared length, just enough for the bytes over `max` (each text at its
 * own bytes per character), until `bytes()` is at most `max`; never a text below SLOT_FLOOR characters, never a text of
 * `decisions` while its row can still be decided. When the rest is cut and it still does not fit, the decision whose
 * texts a cut frees the most goes `pcOnly` (read only on the phone) and its texts are cut too, one decision at a time;
 * one none of whose texts got cut arrives whole and stays decidable. False when only short strings are left and it
 * still does not fit.
 */
export function shrinkTexts(root: unknown, bytes: () => number, max: number, decisions: readonly Decision[] = []): boolean {
  if (cutLongest(root, bytes, max, decisions)) return true
  const open = decisions
    .filter((d) => d.live && !d.row.pcOnly)
    .map((d) => ({ d, n: decisionBytes(d) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
  for (const { d } of open) {
    d.row.pcOnly = true
    const fits = cutLongest(root, bytes, max, decisions)
    if (!d.on.truncated) delete d.row.pcOnly
    if (fits) return true
  }
  return false
}

/** shrinkTexts' water level over the texts slotsOf lets it cut. */
function cutLongest(root: unknown, bytes: () => number, max: number, decisions: readonly Decision[]): boolean {
  for (let pass = 0; pass < SHRINK_PASSES; pass++) {
    const over = bytes() - max
    if (over <= 0) return true
    const slots = slotsOf(root, decisions).sort((a, b) => b.len - a.len)
    if (!slots.length) return false
    // The water level: cutting every text past `cap` to `cap` frees about `over` bytes. For the k longest texts and a
    // level between the next one's length and the k-th's, the bytes freed are sum(f * len) - level * sum(f), with f
    // a text's bytes per character.
    let weight = 0
    let weighted = 0
    let cap = SLOT_FLOOR
    for (let k = 0; k < slots.length; k++) {
      const f = textBytes(slots[k].get()) / slots[k].len
      weight += f
      weighted += f * slots[k].len
      const level = Math.floor((weighted - over) / weight)
      if (level >= (k + 1 < slots.length ? slots[k + 1].len : 0)) {
        cap = Math.max(SLOT_FLOOR, level)
        break
      }
    }
    let cut = false
    for (const s of slots) {
      if (s.len <= cap) continue
      s.set(cutAt(s.get(), cap))
      cut = true
    }
    if (!cut) return false
  }
  return bytes() <= max
}

// ---- lists that page --------------------------------------------------------------------------------

/**
 * How many of the newest rows of `rows` fit: `fixed` is the frame with an empty list. At least one when there is a
 * row (the last pass cuts its texts).
 */
function newestThatFit(rows: readonly unknown[], fixed: number, max: number): number {
  let used = fixed
  let n = 0
  for (let i = rows.length - 1; i >= 0; i--) {
    const b = rowBytes(rows[i], n)
    if (used + b > max) break
    used += b
    n++
  }
  return rows.length > 0 ? Math.max(1, n) : 0
}

/** The task drawer: body and plan cut, the path dropped, the newest comments that fit (the cursor moves with them). */
function fitTask(task: TaskDetail, wrap: (t: TaskDetail) => unknown, max: number): void {
  if (task.worktree) delete task.worktree.path
  const truncated: NonNullable<TaskDetail['truncated']> = { ...(task.truncated ?? {}) }
  if (task.body.length > TEAM_PHONE_BODY_MAX) {
    task.body = cutAt(task.body, TEAM_PHONE_BODY_MAX)
    truncated.body = true
  }
  if (task.plan && task.plan.text.length > TEAM_PHONE_PLAN_MAX) {
    task.plan.text = cutAt(task.plan.text, TEAM_PHONE_PLAN_MAX)
    task.plan.truncated = true
    truncated.plan = true
  }
  for (const a of task.approvals) phoneApproval(a)
  if (Object.keys(truncated).length) task.truncated = truncated
  const all = task.comments
  const fixed = teamResBytes(wrap({ ...task, comments: [], commentsCursor: WIDEST_CURSOR, truncated: { ...truncated, comments: 999 } }))
  const keep = newestThatFit(all, fixed, max)
  if (keep < all.length) {
    task.comments = all.slice(all.length - keep)
    task.commentsCursor = task.comments[0].id
    task.truncated = { ...(task.truncated ?? {}), comments: (task.truncated?.comments ?? 0) + all.length - keep }
  }
  const body = task.body.length
  const plan = task.plan?.text.length
  shrinkTexts(task, () => teamResBytes(wrap(task)), max, decisionsOf(task.approvals, task.cards))
  if (task.body.length < body) task.truncated = { ...(task.truncated ?? {}), body: true }
  if (task.plan && plan !== undefined && task.plan.text.length < plan) task.truncated = { ...(task.truncated ?? {}), plan: true }
}

/** Groups of rows that share their transcript line (chatMessageOffset), oldest first; null for a row without one. */
function lineOf(m: ChatMessage): number | null {
  return chatMessageOffset(m.id)
}

/**
 * A run page: the newest whole lines that fit, the cursor at the oldest line kept (`done` false then). A lone row that
 * still does not fit is shrunk (shrinkMessage: its patch, then its longest text, marked truncated).
 */
function fitRunPage(res: Extract<TeamReply<'runPage'>, { ok: true }>, max: number): void {
  const fixed = teamResBytes({ ...res, items: [], cursor: WIDEST_CURSOR, done: false })
  const items = res.items
  const sameLine = (i: number): boolean => lineOf(items[i]) !== null && lineOf(items[i]) === lineOf(items[i - 1])
  let start = items.length - newestThatFit(items, fixed, max)
  // Never between two rows of one line (the next page asks `before` that line), never at a row without a line.
  let next = start
  while (next > 0 && next < items.length && sameLine(next)) next++
  // The newest line alone does not fit: keep that whole line (the last pass cuts its texts), never every line.
  if (next >= items.length) while (start > 0 && sameLine(start)) start--
  else start = next
  if (start > 0 && start < items.length) {
    const at = lineOf(items[start])
    if (at !== null && at > 0) {
      res.items = items.slice(start)
      res.cursor = String(at)
      res.done = false
    }
  }
  if (res.items.length === 1 && teamResBytes(res) > max) {
    const room = max - fixed
    if (room > 0) res.items = [shrinkMessage(res.items[0], room)]
  }
}

/**
 * The reply of one phone op as the phone gets it (see the header). `res` is TeamService's answer to `op` from origin
 * phone; the result is a new object.
 */
export function fitPhoneReply(op: PhoneTeamOp, res: TeamReply, mask: PhoneMask, max: number = TEAM_FRAME_MAX_BYTES): TeamReply {
  const out = maskDeep(res, mask)
  if (!out.ok) {
    delete out.current
  } else {
    switch (op) {
      case 'list': {
        const r = out as Extract<TeamReply<'list'>, { ok: true }>
        r.teams = r.teams.map(phoneListItem) as TeamListItem[]
        while (r.teams.length > 0 && teamResBytes(r) > max) r.teams.pop()
        break
      }
      case 'board': {
        const page = (out as Extract<TeamReply<'board'>, { ok: true }>).page
        page.tasks = page.tasks.map((t) => phoneSummary(t, PHONE_BLOCKED_ROW_MAX))
        if (teamResBytes(out) > max) {
          // A page that still does not fit (a page without a column, or the column grew between two asks) keeps the
          // rows that fit in its order and no cursor: the phone pages by column.
          const fixed = teamResBytes({ ...out, page: { ...page, tasks: [], cursor: null, done: false } })
          let used = fixed
          let n = 0
          for (const t of page.tasks) {
            const b = rowBytes(t, n)
            if (used + b > max) break
            used += b
            n++
          }
          // A lone row that does not fit loses nothing here: the last pass cuts its texts and the cursor stays.
          const keep = Math.max(1, n)
          if (keep < page.tasks.length) {
            page.tasks = page.tasks.slice(0, keep)
            page.cursor = null
            page.done = false
          }
        }
        break
      }
      case 'task': {
        const r = out as Extract<TeamReply<'task'>, { ok: true }>
        fitTask(r.task, (task) => ({ ...r, task }), max)
        break
      }
      case 'needs': {
        const r = out as Extract<TeamReply<'needs'>, { ok: true }>
        for (const a of r.needs.approvals) phoneApproval(a)
        break
      }
      case 'runPage':
        fitRunPage(out as Extract<TeamReply<'runPage'>, { ok: true }>, max)
        break
      case 'createTask': {
        const r = out as Extract<TeamReply<'createTask'>, { ok: true }>
        r.task = phoneSummary(r.task, PHONE_BLOCKED_ROW_MAX)
        break
      }
      case 'lead': {
        const r = out as Extract<TeamReply<'lead'>, { ok: true }>
        const all = r.lead.messages
        const fixed = teamResBytes({ ...r, lead: { ...r.lead, messages: [], cursor: WIDEST_CURSOR } })
        const keep = newestThatFit(all, fixed, max)
        if (keep < all.length) {
          r.lead.messages = all.slice(all.length - keep)
          r.lead.cursor = r.lead.messages[0].id
        }
        break
      }
      case 'comment':
      case 'leadSay':
        break
    }
  }
  if (teamResBytes(out) <= max) return out
  if (shrinkTexts(out, () => teamResBytes(out), max, replyDecisions(op, out))) return out
  return { ok: false, error: 'too_big' }
}

/** How many rows of a board page fit (after the phone's cuts), at least one; the page as it would travel. */
function boardFitCount(res: Extract<TeamReply<'board'>, { ok: true }>, mask: PhoneMask, max: number): number {
  const page = maskDeep(res.page, mask)
  const tasks = page.tasks.map((t) => phoneSummary(t, PHONE_BLOCKED_ROW_MAX))
  let used = teamResBytes({ ...res, page: { ...page, tasks: [], cursor: WIDEST_CURSOR, done: false } })
  let n = 0
  for (const t of tasks) {
    const b = rowBytes(t, n)
    if (used + b > max) break
    used += b
    n++
  }
  return Math.max(1, n)
}

/**
 * One phone teamReq (TeamService.remoteView.request): `ask` is TeamService.request with origin phone. A board page of
 * a column that would not fit is asked again with the `limit` that fits, so its cursor is the one views.ts mints;
 * then fitPhoneReply.
 */
export async function phoneTeamReply(req: PhoneTeamRequest, ask: (r: PhoneTeamRequest) => Promise<TeamReply>, mask: PhoneMask, max: number = TEAM_FRAME_MAX_BYTES): Promise<TeamReply> {
  let res = await ask(req)
  if (req.op === 'board' && req.column !== undefined) {
    for (let i = 0; i < BOARD_REFIT_TRIES && res.ok; i++) {
      const page = (res as Extract<TeamReply<'board'>, { ok: true }>).page
      const fit = boardFitCount(res as Extract<TeamReply<'board'>, { ok: true }>, mask, max)
      if (fit >= page.tasks.length) break
      res = await ask({ ...req, limit: fit })
    }
  }
  return fitPhoneReply(req.op, res, mask, max)
}

// ---- the three phone ctls ---------------------------------------------------------------------------

/** The TeamRequest of a phone ctl (decide, answer, dispatch), copied field by field. */
export function teamCtlRequest(a: TeamCtlAction): Extract<TeamRequest, { op: 'decide' | 'answer' | 'dispatch' }> {
  switch (a.kind) {
    case 'teamDecide':
      // rev (Tanda B close): the permission approval the phone showed; main answers conflict {stale} when it grew since.
      return { op: 'decide', teamId: a.teamId, approvalId: a.approvalId, decision: a.decision, ...(a.note !== undefined ? { note: a.note } : {}), ...(a.rev !== undefined ? { rev: a.rev } : {}) }
    case 'teamAnswer':
      return { op: 'answer', teamId: a.teamId, cardId: a.cardId, answer: a.answer }
    case 'teamDispatch':
      return { op: 'dispatch', teamId: a.teamId, queueId: a.queueId, go: a.go }
  }
}

/**
 * The ctlAck of a phone ctl: ok, or the TeamError code; a conflict names its reason after a colon
 * (`conflict:already_decided`, `conflict:stale`) and a detail the phone words names it too (`bad_request:nothingToGrant`,
 * `bad_request:grantsFull`, `bad_request:secret`). Never any text of the reply.
 */
export function teamCtlResult(res: TeamReply): RemoteCommandResult {
  if (res.ok) return { id: '', ok: true }
  if (res.error === 'conflict' && res.reason) return { id: '', ok: false, error: `conflict:${res.reason}` }
  if (res.detail && PHONE_CTL_DETAILS.includes(res.detail)) return { id: '', ok: false, error: `${res.error}:${res.detail}` }
  return { id: '', ok: false, error: res.error }
}
