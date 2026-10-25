import { randomBytes } from 'crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { z } from 'zod'
import { FAILURE_KINDS, type FailureKind } from '@shared/failure'
import type { TeamScope } from '@shared/team-protocol'
import {
  emptyRuntime,
  LEAD_THREAD,
  RUN_ACTIVE,
  RUNS_META_MAX,
  TASK_FIELDS,
  TASK_ID_RE,
  TASK_PRIORITIES,
  TEAM_GEN_RE,
  TEAM_STATE_VERSION,
  type Run,
  type TaskField,
  type TaskPriority,
  type TeamRuntime,
  type TrustedDefinition,
} from '@shared/teams'
import type { DeadlineTimer } from '../DeadlineTimer'
import { writeAtomicSync } from '../fsAtomic'
import { openSystemCard } from './flow/agents'
import { assertInvariants } from './flow/invariants'
import type { FlowResult } from './flow/types'

/** Debounce of a dirty commit before the state files are written (design 3.3 rule 6). */
export const TEAM_FLUSH_MS = 250

/** The sync file calls TeamStore makes; tests pass a fake. */
export interface SyncFs {
  readFileSync(p: string, enc: 'utf8'): string
  writeFileSync(p: string, data: string | Uint8Array, opts?: { mode?: number }): void
  renameSync(from: string, to: string): void
  mkdirSync(p: string, opts: { recursive: true }): unknown
  rmSync(p: string, opts: { force: true; recursive?: boolean }): void
  appendFileSync(p: string, data: string, enc: 'utf8'): void
  statSync(p: string): { size: number }
}

const nodeSyncFs: SyncFs = { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, appendFileSync, statSync }

export interface TeamStoreDeps {
  /** dataDir()/teams/<teamId>. */
  dir: () => string
  emit: (scopes: TeamScope[], hint?: { taskId?: string; runId?: string }) => void
  /** The TeamService timer (key `flush:<teamId>`); never disposed here. */
  timer: DeadlineTimer<string>
  /** TeamService enabled and not frozen; false -> every commit flushes at once (Labs off, quitting). */
  live: () => boolean
  now: () => number
  fs?: SyncFs
  log: (line: string) => void
  /** Tests: deep-freeze `rt` and throw on a broken invariant after every commit and at load. */
  strict?: boolean
  /** Mints `TeamRuntime.gen` for a new runtime (default 8 random hex). */
  newGen?: () => string
  /** B2: the reaper of runs found active at load (reapOnLoad), applied before the invariants. */
  reap?: (rt: TeamRuntime, recent: readonly Run[]) => FlowResult<{ reaped: Run[] }>
}

// ---- load schema (main only): salvage per field and per element ----------------------------------

const num = z.number().finite()
const int = z.number().int().min(0)
const str = z.string()
const provider = z.enum(['claude', 'codex'])
const roleKind = z.enum(['lead', 'dev', 'qa', 'research', 'custom'])
const profile = z.enum(['total', 'readonly', 'custom'])
const runMode = z.enum(['plan', 'exec', 'qa', 'lead', 'free'])
const wakeReason = z.enum([
  'assigned', 'comment', 'planApproved', 'planRejected', 'review', 'changes', 'finalRejected', 'rebase', 'answer', 'grant',
  'unblocked', 'continuation', 'retry', 'interrupted', 'context', 'routine', 'userMessage', 'kickoff', 'triage', 'leadApproval', 'manual',
])
const cardReason = z.enum([
  'noProgress', 'qaRounds', 'qaNoVerdict', 'interrupted', 'failure', 'timeout', 'stalled', 'depCancelled', 'unblockLimit',
  'cwdMissing', 'sessionConflict', 'auth', 'billing', 'stateReset', 'spawnFailed', 'cliOff', 'orphan',
])
const cardAction = z.enum(['retry', 'resume', 'toTodo', 'cancelTask', 'stopRun', 'keepWaiting', 'dropBlocker', 'resumeTeam', 'newSession', 'killOrphan', 'dismiss'])
const taskState = z.enum(['todo', 'doing', 'review', 'done', 'blocked', 'cancelled'])
const taskPhase = z.enum(['none', 'planning', 'planApproval', 'executing', 'qa', 'userOk', 'integrating'])
const priority = z.enum(TASK_PRIORITIES as unknown as [TaskPriority, ...TaskPriority[]])
const taskField = z.enum(TASK_FIELDS as unknown as [TaskField, ...TaskField[]])
const vars = z.record(z.union([str, num]))
const failure = z.object({ kind: z.enum(FAILURE_KINDS as unknown as [FailureKind, ...FailureKind[]]), until: num.optional(), code: str.optional() }).passthrough()
const actor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), via: z.enum(['desktop', 'phone']) }),
  z.object({ kind: z.literal('agent'), agentId: str, runId: str, roleKind }),
  z.object({ kind: z.literal('system') }),
])
const wakeMark = z.object({
  agentId: str, mode: runMode, reason: wakeReason, since: num,
  notBefore: num.optional(), refs: z.array(str).optional(), bypassCooldown: z.literal(true).optional(), detail: str.optional(),
}).passthrough()
const session = z.object({
  provider, sessionId: str.min(1), cwd: str, createdAt: num, turns: int, sysHash: str,
  costTotal: num.optional(),
  tokensTotal: z.object({ input: num, output: num, cacheRead: num, cacheWrite: num, reasoning: num.optional() }).optional(),
  baseStale: z.literal(true).optional(), lastRunId: str.optional(),
}).passthrough()
const takeover = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('stopping'), at: num, runId: str, sessionKey: str }).passthrough(),
  z.object({ phase: z.literal('bindPending'), at: num, sessionKey: str, sessionId: str, provider, cwd: str, workspaceId: str.optional() }).passthrough(),
  z.object({ phase: z.literal('bound'), at: num, sessionKey: str, sessionId: str, provider, cwd: str, paneId: str, workspaceId: str }).passthrough(),
  z.object({ phase: z.literal('releasing'), at: num, sessionKey: str, sessionId: str, provider, cwd: str, paneId: str, workspaceId: str }).passthrough(),
])
const agent = z.object({
  id: str, roleId: str, roleKind, provider,
  status: z.enum(['idle', 'running', 'takenOver']),
  paused: z.boolean(),
  retired: z.literal(true).optional(),
  runId: str.optional(),
  sessions: z.record(session),
  next: wakeMark.optional(),
  interrupts: int,
  takeover: takeover.optional(),
}).passthrough()
const blockedReason = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('deps') }),
  z.object({ kind: z.literal('user'), text: str.optional(), by: z.literal('lead').optional() }),
  z.object({ kind: z.literal('stopped'), runId: str }),
  z.object({ kind: z.literal('card'), cardId: str, why: cardReason }),
])
const task = z.object({
  id: z.string().regex(TASK_ID_RE), rev: int,
  title: str, body: str, state: taskState, phase: taskPhase, priority,
  assignee: str.optional(), repoId: str, isolation: z.enum(['worktree', 'main']), needsPlan: z.boolean(),
  frozen: z.literal(true).optional(),
  worktree: z.object({ path: str, branch: str, base: str, baseBranch: str, slug: str, createdAt: num, owner: str }).passthrough().optional(),
  blockedBy: z.array(str), parentId: str.optional(),
  createdBy: actor, createdAt: num, updatedAt: num, stateSince: num,
  plan: z.object({ rev: int, text: str, status: z.enum(['pending', 'approved', 'rejected']), small: z.boolean(), at: num, approvalId: str.optional(), decidedBy: actor.optional() }).passthrough().optional(),
  review: z.object({ round: int, max: int, lastVerdict: z.enum(['approve', 'changes']).optional(), qaAgentId: str.optional() }).passthrough(),
  userOwned: z.array(taskField),
  counters: z.object({ noProgress: int, continuations: int, retries: int, interrupts: int, unblockWakes: int, unblockWindowStart: num }).passthrough(),
  cooldownUntil: num.optional(),
  next: wakeMark.optional(),
  blocked: z.object({ reason: blockedReason, resume: z.object({ state: taskState, phase: taskPhase }), at: num }).optional(),
  grants: z.array(z.object({ roleId: str, tool: str, at: num, approvalId: str }).passthrough()).optional(),
  integrate: z.object({
    state: z.enum(['idle', 'running', 'failed']), attempt: int,
    step: z.enum(['preflight', 'temp', 'merge', 'verify', 'land', 'cleanup']).optional(),
    error: str.optional(), files: z.array(str).optional(), tail: str.optional(), at: num,
  }).passthrough().optional(),
  integrated: z.object({ mergeSha: str, base: str, at: num, landed: z.enum(['ffOnly', 'updateRef', 'alreadyMerged']) }).optional(),
  triagedAt: num.optional(),
}).passthrough()
const comment = z.object({
  id: str, target: str, author: actor, kind: z.enum(['comment', 'review', 'system', 'answer']), at: num, text: str,
  sys: z.object({ key: str, vars: vars.optional() }).optional(),
  forAgent: str.optional(), deliveredRunId: str.optional(),
}).passthrough()
const approvalBase = {
  id: str, taskId: str.optional(), state: z.enum(['pending', 'applying', 'approved', 'rejected', 'cancelled']),
  decider: z.enum(['user', 'lead']), createdAt: num, createdBy: actor, decidedAt: num.optional(), decidedBy: actor.optional(),
  note: str.optional(), error: str.optional(), leadSeenRunId: str.optional(),
}
const approval = z.discriminatedUnion('kind', [
  z.object({ ...approvalBase, kind: z.literal('plan'), payload: z.object({ planRev: int, small: z.boolean() }) }).passthrough(),
  z.object({ ...approvalBase, kind: z.literal('final'), payload: z.object({ hasWorktree: z.boolean(), summary: str }) }).passthrough(),
  z.object({ ...approvalBase, kind: z.literal('hire'), payload: z.object({ roleId: str, text: str, sha256: str, baseDefHash: str, replaces: z.boolean() }) }).passthrough(),
  z.object({ ...approvalBase, kind: z.literal('permission'), payload: z.object({ roleId: str, runId: str, tools: z.array(str) }) }).passthrough(),
  z.object({ ...approvalBase, kind: z.literal('integrate'), payload: z.object({ branch: str, base: str }) }).passthrough(),
])
const cardAnswer = z.object({
  choices: z.array(int).optional(), text: str.optional(), confirm: z.boolean().optional(), action: cardAction.optional(), by: actor, at: num,
})
const card = z.object({
  id: str, taskId: str.optional(), kind: z.enum(['choice', 'text', 'confirm']), question: str, options: z.array(str), multi: z.boolean(),
  state: z.enum(['open', 'answered', 'dismissed']),
  from: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('agent'), agentId: str, runId: str, tool: z.enum(['ask', 'needs']) }),
    z.object({ kind: z.literal('system'), why: cardReason, runId: str.optional(), actions: z.array(cardAction), vars: vars.optional() }),
  ]),
  answer: cardAnswer.optional(), consumedRunId: str.optional(), createdAt: num,
}).passthrough()
const queueItem = z.object({
  id: str, agentId: str, taskId: str.optional(), sessionKey: str, mode: runMode, reason: wakeReason, refs: z.array(str).optional(),
  createdAt: num, approvedAt: num.optional(), approvedBy: actor.optional(),
}).passthrough()
const run = z.object({
  id: str, agentId: str, roleId: str, roleKind, taskId: str.optional(), sessionKey: str,
  provider, model: str.optional(), effort: str.optional(), profile,
  sessionId: str.optional(), resumed: z.boolean(), cwd: str, repoId: str,
  mode: runMode, trigger: z.object({ reason: wakeReason, refs: z.array(str).optional(), by: z.enum(['user', 'agent', 'system']) }),
  continuationOf: str.optional(),
  state: z.enum(['queued', 'starting', 'running', 'stopping', 'succeeded', 'failed', 'cancelled', 'interrupted', 'takenOver']),
  stopReason: z.enum(['user', 'takeover', 'timeout', 'concluded', 'labsOff', 'cliOff', 'deleted', 'taskMoved', 'sessionConflict', 'shutdown', 'paused']).optional(),
  interruptCause: z.enum(['shutdown', 'crash', 'labsOff', 'cliOff', 'sessionConflict']).optional(),
  reachedRunning: z.boolean(), resultSeen: z.boolean(), pid: int.optional(),
  queuedAt: num, startedAt: num.optional(), firstLineAt: num.optional(), resultAt: num.optional(), endedAt: num.optional(), lastLineAt: num.optional(),
  treeBefore: z.object({ head: str, status: str }).optional(), treeMoved: z.boolean().optional(),
  exit: z.object({ code: num.nullable(), signal: str.nullable() }).optional(),
  failure: failure.optional(),
  outcome: z.enum(['concluded', 'progress', 'planOnly', 'empty', 'failed']).optional(),
  usage: z.object({ inputTokens: num, outputTokens: num, cacheReadTokens: num, cacheWriteTokens: num, estimated: z.literal(true) }).passthrough().optional(),
  context: z.object({ pct: num, used: num, window: num, exact: z.boolean() }).passthrough().optional(),
  digest: z.object({ tools: num, families: z.record(num), files: z.array(str) }).passthrough().optional(),
  summary: str.optional(),
  concludedBy: z.object({ tool: z.enum(['ask', 'needs', 'plan', 'review', 'verdict', 'done', 'approvePlan', 'hire']), at: num }).optional(),
  delivered: z.object({ comments: z.array(str), cards: z.array(str), approvals: z.array(str) }).optional(),
  denials: z.array(z.object({ tool: str, count: int })).optional(),
  logBytes: int.optional(), logTruncated: z.literal(true).optional(), silenceAckedAt: num.optional(),
}).passthrough()
const pause = z.object({ reason: z.enum(['user', 'auth', 'billing']), at: num, cardId: str.optional(), failure: failure.optional() })
const nextIds = z.object({ task: int.min(1), comment: int.min(1), approval: int.min(1), card: int.min(1), queue: int.min(1) })
const routineState = z.object({
  lastScheduledFor: num.optional(), lastFiredAt: num.optional(), lastRunId: str.optional(), lastTaskId: str.optional(), skippedFor: num.optional(),
}).passthrough()

/** `items` element by element: a bad one is dropped and named in `repaired`. */
function salvageArray<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown, label: string, repaired: string[]): T[] {
  if (!Array.isArray(value)) {
    if (value !== undefined) repaired.push(label)
    return []
  }
  const out: T[] = []
  value.forEach((v, i) => {
    const p = schema.safeParse(v)
    if (p.success) out.push(p.data)
    else repaired.push(`${label}[${i}]`)
  })
  return out
}

/** A record entry by entry. */
function salvageRecord<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown, label: string, repaired: string[]): Record<string, T> {
  const out: Record<string, T> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (value !== undefined) repaired.push(label)
    return out
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const p = schema.safeParse(v)
    if (p.success) out[k] = p.data
    else repaired.push(`${label}.${k}`)
  }
  return out
}

function field<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown, fallback: T, label: string, repaired: string[]): T {
  const p = schema.safeParse(value)
  if (p.success) return p.data
  if (value !== undefined) repaired.push(label)
  return fallback
}

/**
 * A parsed state.json as a TeamRuntime, field by field (design 3.3 rule 7): a
 * bad field falls back to its empty value, a bad element of a list or map is
 * dropped, and every fix is named. The ids counters are raised above every id
 * kept, so a salvaged runtime never mints an id twice.
 */
export function salvageRuntime(raw: Record<string, unknown>, teamId: string, gen: string): { rt: TeamRuntime; repaired: string[] } {
  const repaired: string[] = []
  const base = emptyRuntime(teamId, typeof raw.gen === 'string' && TEAM_GEN_RE.test(raw.gen) ? raw.gen : gen)
  if (base.gen !== raw.gen) repaired.push('gen')
  if (raw.teamId !== teamId) repaired.push('teamId')
  const comments: TeamRuntime['comments'] = {}
  if (raw.comments && typeof raw.comments === 'object' && !Array.isArray(raw.comments)) {
    for (const [target, list] of Object.entries(raw.comments as Record<string, unknown>)) {
      if (target !== LEAD_THREAD && !TASK_ID_RE.test(target)) {
        repaired.push(`comments.${target}`)
        continue
      }
      const kept = salvageArray(comment, list, `comments.${target}`, repaired).filter((c) => c.target === target) as TeamRuntime['comments'][string]
      if (kept.length > 0) comments[target] = kept
    }
  } else if (raw.comments !== undefined) repaired.push('comments')
  const rt: TeamRuntime = {
    ...base,
    rev: field(int, raw.rev, 0, 'rev', repaired),
    autoDispatch: field(z.boolean(), raw.autoDispatch, false, 'autoDispatch', repaired),
    paused: field(pause.nullable(), raw.paused, null, 'paused', repaired) as TeamRuntime['paused'],
    verifyConfirmed: salvageRecord(z.object({ command: str, sha256: str, at: num }), raw.verifyConfirmed, 'verifyConfirmed', repaired),
    agents: salvageArray(agent, raw.agents, 'agents', repaired) as TeamRuntime['agents'],
    tasks: salvageArray(task, raw.tasks, 'tasks', repaired) as unknown as TeamRuntime['tasks'],
    comments,
    approvals: salvageArray(approval, raw.approvals, 'approvals', repaired) as unknown as TeamRuntime['approvals'],
    cards: salvageArray(card, raw.cards, 'cards', repaired) as TeamRuntime['cards'],
    queue: salvageArray(queueItem, raw.queue, 'queue', repaired) as TeamRuntime['queue'],
    activeRuns: (salvageArray(run, raw.activeRuns, 'activeRuns', repaired) as unknown as Run[]).filter((r) => {
      if (RUN_ACTIVE.includes(r.state)) return true
      repaired.push(`activeRuns.${r.id}`)
      return false
    }),
    providerBlockedUntil: salvageRecord(num, raw.providerBlockedUntil, 'providerBlockedUntil', repaired),
    nextIds: field(nextIds, raw.nextIds, base.nextIds, 'nextIds', repaired),
    routines: salvageRecord(routineState, raw.routines, 'routines', repaired),
    archivedTasks: salvageRecord(z.enum(['done', 'cancelled']), raw.archivedTasks, 'archivedTasks', repaired),
  }
  if (typeof raw.goalSeenHash === 'string') rt.goalSeenHash = raw.goalSeenHash
  if (typeof raw.workspaceId === 'string') rt.workspaceId = raw.workspaceId
  if (Array.isArray(raw.needsSeen)) rt.needsSeen = raw.needsSeen.filter((x): x is string => typeof x === 'string')
  for (const k of Object.keys(rt.providerBlockedUntil)) {
    if (k !== 'claude' && k !== 'codex') {
      delete (rt.providerBlockedUntil as Record<string, number>)[k]
      repaired.push(`providerBlockedUntil.${k}`)
    }
  }
  // Counters above every id kept (a dropped nextIds must not reuse ids).
  const maxOf = (ids: Iterable<string>): number => {
    let m = 0
    for (const id of ids) {
      const n = Number(id.slice(id.indexOf('-') + 1))
      if (Number.isInteger(n) && n > m) m = n
    }
    return m
  }
  const raise = (key: keyof TeamRuntime['nextIds'], ids: Iterable<string>): void => {
    const need = maxOf(ids) + 1
    if (rt.nextIds[key] < need) {
      rt.nextIds = { ...rt.nextIds, [key]: need }
      repaired.push(`nextIds.${key}`)
    }
  }
  raise('task', [...rt.tasks.map((t) => t.id), ...Object.keys(rt.archivedTasks)])
  raise('comment', Object.values(rt.comments).flatMap((l) => l.map((c) => c.id)))
  raise('approval', rt.approvals.map((a) => a.id))
  raise('card', rt.cards.map((c) => c.id))
  raise('queue', rt.queue.map((q) => q.id))
  return { rt, repaired }
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k])
  }
  return v
}

type ReadRes = { kind: 'missing' } | { kind: 'corrupt' } | { kind: 'ok'; value: unknown }

/** Read errors that say nothing about the content (a lock, a full handle table): the load fails, the file is kept. */
const TRANSIENT_READ = new Set(['EBUSY', 'EPERM', 'EACCES', 'EAGAIN', 'EMFILE', 'ENFILE'])

function readJson(fs: SyncFs, file: string): ReadRes {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { kind: 'missing' }
    // Never reset a team over a file that could not be read this time (design 3.3 rule 7 resets on a parse failure).
    if (code && TRANSIENT_READ.has(code)) throw new Error(`${basename(file)} unreadable ${code}`)
    return { kind: 'corrupt' }
  }
  try {
    return { kind: 'ok', value: JSON.parse(text.replace(/^\uFEFF/, '')) }
  } catch {
    return { kind: 'corrupt' }
  }
}

/** Files of the archive (append only): `tasks`, a task id or the Lead thread. */
const ARCHIVE_FILE_RE = /^(?:tasks|lead|t-[0-9]{1,5})$/

/**
 * The runtime of one team (app 2.7.0, E10 B, design 3.3), held only by
 * TeamService: every mutation is `commit(reducer(store.rt, ...))`, synchronous,
 * so a reducer and its commit are atomic. A commit bumps `rt.rev` (and the
 * `rev` of each task object that changed), emits, and schedules one write 250 ms
 * later on the shared timer (`flush:<teamId>`), or writes at once while the
 * service is not live. A flush writes `runs.json` before `state.json`, each
 * tmp + rename, UTF-8 without BOM; a load lets a run that is terminal in
 * runs.json win over its active copy in state.json.
 */
export class TeamStore {
  private _rt: TeamRuntime
  private ring: Run[]
  private stateDirty = false
  private runsDirty = false
  private _lastBytes = 0
  private def: TrustedDefinition | null
  private readonly fs: SyncFs

  private constructor(
    private readonly deps: TeamStoreDeps,
    readonly teamId: string,
    rt: TeamRuntime,
    ring: Run[],
    def: TrustedDefinition | null,
  ) {
    this.fs = deps.fs ?? nodeSyncFs
    this._rt = deps.strict ? deepFreeze(rt) : rt
    this.ring = ring
    this.def = def
  }

  private get flushKey(): string {
    return `flush:${this.teamId}`
  }

  /**
   * Reads `runs.json` and `state.json` (a missing state is a new team). A
   * state that does not parse is moved to `state.corrupt-<ts>.json` and the
   * team restarts empty with a `stateReset` card; a parseable one is salvaged
   * field by field. A file that cannot be read right now (a lock) throws and
   * stays as it is. Then the B2 reaper (when given) and the invariants
   * (logged; thrown with `strict`).
   */
  static load(deps: TeamStoreDeps, teamId: string, def: TrustedDefinition | null): { store: TeamStore; repaired: string[]; reaped: Run[] } {
    const fs = deps.fs ?? nodeSyncFs
    const dir = deps.dir()
    const repaired: string[] = []
    const now = deps.now()
    const newGen = deps.newGen ?? (() => randomBytes(4).toString('hex'))
    const moveAside = (name: string): void => {
      const stem = name.replace(/\.json$/, '')
      try {
        fs.renameSync(join(dir, name), join(dir, `${stem}.corrupt-${now}.json`))
      } catch {
        /* unreadable and unmovable: overwritten by the next flush */
      }
    }

    let ring: Run[] = []
    const runsRaw = readJson(fs, join(dir, 'runs.json'))
    if (runsRaw.kind === 'ok') {
      const list = (runsRaw.value as { runs?: unknown } | null)?.runs
      const byId = new Map<string, Run>()
      for (const r of salvageArray(run, list, 'runs', repaired) as unknown as Run[]) {
        if (RUN_ACTIVE.includes(r.state)) {
          repaired.push(`runs.${r.id}`)
          continue
        }
        byId.delete(r.id)
        byId.set(r.id, r)
      }
      ring = [...byId.values()].slice(-RUNS_META_MAX)
    } else if (runsRaw.kind === 'corrupt') {
      moveAside('runs.json')
      repaired.push('runs.json')
    }

    let rt: TeamRuntime
    let reset = false
    let fresh = false
    const stateRaw = readJson(fs, join(dir, 'state.json'))
    const value = stateRaw.kind === 'ok' ? stateRaw.value : null
    if (stateRaw.kind === 'missing') {
      rt = emptyRuntime(teamId, newGen())
      fresh = true
    } else if (!value || typeof value !== 'object' || Array.isArray(value) || (value as { v?: unknown }).v !== TEAM_STATE_VERSION) {
      moveAside('state.json')
      rt = emptyRuntime(teamId, newGen())
      reset = true
      repaired.push('state.json')
    } else {
      const s = salvageRuntime(value as Record<string, unknown>, teamId, newGen())
      rt = s.rt
      repaired.push(...s.repaired)
    }

    // A crash between the two writes: the terminal copy in runs.json wins.
    const terminal = new Set(ring.map((r) => r.id))
    if (rt.activeRuns.some((r) => terminal.has(r.id))) {
      const gone = new Set(rt.activeRuns.filter((r) => terminal.has(r.id)).map((r) => r.id))
      rt = {
        ...rt,
        activeRuns: rt.activeRuns.filter((r) => !gone.has(r.id)),
        agents: rt.agents.map((a) => {
          if (!a.runId || !gone.has(a.runId)) return a
          const next = { ...a, status: a.status === 'running' ? ('idle' as const) : a.status }
          delete next.runId
          return next
        }),
      }
      for (const id of gone) repaired.push(`activeRuns.${id} terminal`)
    }

    if (reset) {
      const card = openSystemCard(rt, { why: 'stateReset', actions: ['dismiss'], vars: { what: 'state' } }, { now })
      if (card.ok) rt = card.rt
    }

    let reaped: Run[] = []
    if (deps.reap) {
      const r = deps.reap(rt, ring)
      if (r.ok) {
        rt = r.rt
        reaped = r.result.reaped
      }
    }

    const store = new TeamStore(deps, teamId, rt, ring, def)
    const issues = assertInvariants(rt, def, { recent: ring })
    if (issues.length > 0) {
      if (deps.strict) throw new Error(`team ${teamId} invariants at load: ${issues.join('; ')}`)
      for (const i of issues) deps.log(`invariant ${teamId} ${i}`)
    }
    if (repaired.length > 0) deps.log(`store ${teamId} repaired ${repaired.slice(0, 20).join(',')}${repaired.length > 20 ? ` +${repaired.length - 20}` : ''}`)
    if (fresh || reset || repaired.length > 0 || reaped.length > 0) {
      store.stateDirty = true
      store.runsDirty = runsRaw.kind === 'corrupt' || reaped.length > 0
      store.schedule()
    }
    return { store, repaired, reaped }
  }

  get rt(): Readonly<TeamRuntime> {
    return this._rt
  }

  /** Bytes of the last state.json written (growth caps, design 3.3 rule 5). */
  get lastBytes(): number {
    return this._lastBytes
  }

  /** The trusted definition the invariants read (TeamService sets it at every trust). */
  setDef(def: TrustedDefinition | null): void {
    this.def = def
  }

  /**
   * Applies an ok reducer result: rev + 1, `rev` + 1 of every task object
   * that changed, the write scheduled (or done at once while not live), the
   * scopes emitted. A failed result, or one that changed nothing (the same
   * `rt`), passes through untouched.
   */
  commit<R>(res: FlowResult<R>, scopes: TeamScope[], hint?: { taskId?: string; runId?: string }): FlowResult<R> {
    if (!res.ok || res.rt === this._rt) return res
    const prev = this._rt
    let tasks = res.rt.tasks
    if (tasks !== prev.tasks) {
      const before = new Map(prev.tasks.map((t) => [t.id, t]))
      tasks = tasks.map((t) => {
        const p = before.get(t.id)
        return !p || p === t ? t : { ...t, rev: p.rev + 1 }
      })
    }
    const next: TeamRuntime = { ...res.rt, tasks, rev: prev.rev + 1 }
    if (this.deps.strict) {
      const issues = assertInvariants(next, this.def, { recent: this.ring, prev })
      if (issues.length > 0) throw new Error(`team ${this.teamId} invariants: ${issues.join('; ')}`)
      deepFreeze(next)
    }
    this._rt = next
    this.stateDirty = true
    this.schedule()
    this.deps.emit(scopes, hint)
    return { ...res, rt: next }
  }

  /** The runs ring (runs.json), newest last. */
  recentRuns(limit?: number): readonly Run[] {
    return limit === undefined ? this.ring : this.ring.slice(-limit)
  }

  /**
   * A run that left `activeRuns` joins the ring (by id, newest last, at most
   * RUNS_META_MAX). Called by the run end right after its commit, so one flush
   * writes runs.json then state.json.
   */
  recordRun(r: Run): void {
    const next = this.ring.filter((x) => x.id !== r.id)
    next.push(this.deps.strict ? deepFreeze({ ...r }) : r)
    this.ring = next.length > RUNS_META_MAX ? next.slice(-RUNS_META_MAX) : next
    this.runsDirty = true
    this.schedule()
  }

  /** Appends rows to `archive/<file>.jsonl` (archived tasks and comments). */
  appendArchive(file: 'tasks' | string, rows: unknown[]): void {
    if (!ARCHIVE_FILE_RE.test(file) || rows.length === 0) return
    const dir = join(this.deps.dir(), 'archive')
    try {
      this.fs.mkdirSync(dir, { recursive: true })
      this.fs.appendFileSync(join(dir, `${file}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    } catch (err) {
      this.deps.log(`store ${this.teamId} archive ${file} failed ${(err as NodeJS.ErrnoException).code ?? 'error'}`)
    }
  }

  /** The notices baseline (design 3.1): written with the state, no rev, no emit. */
  setNeedsSeen(ids: readonly string[]): void {
    const cur = this._rt.needsSeen
    if (cur && cur.length === ids.length && cur.every((id, i) => id === ids[i])) return
    const next = { ...this._rt, needsSeen: [...ids] }
    this._rt = this.deps.strict ? deepFreeze(next) : next
    this.stateDirty = true
    this.schedule()
  }

  /** Writes what is dirty now, runs.json first; idempotent. A failed write stays dirty for the next one. */
  flushSync(): void {
    this.deps.timer.clear(this.flushKey)
    if (!this.stateDirty && !this.runsDirty) return
    const dir = this.deps.dir()
    const fs = { writeFileSync: this.fs.writeFileSync, renameSync: this.fs.renameSync, rmSync: this.fs.rmSync }
    try {
      this.fs.mkdirSync(dir, { recursive: true })
      if (this.runsDirty) {
        writeAtomicSync(join(dir, 'runs.json'), JSON.stringify({ v: 1, runs: this.ring }) + '\n', {}, fs)
        this.runsDirty = false
      }
      if (this.stateDirty) {
        const text = JSON.stringify(this._rt) + '\n'
        writeAtomicSync(join(dir, 'state.json'), text, {}, fs)
        this._lastBytes = Buffer.byteLength(text, 'utf8')
        this.stateDirty = false
      }
    } catch (err) {
      this.deps.log(`store ${this.teamId} flush failed ${(err as NodeJS.ErrnoException).code ?? 'error'}`)
    }
  }

  /** flushSync and the flush key cleared; the shared timer is never disposed here. */
  dispose(): void {
    this.flushSync()
    this.deps.timer.clear(this.flushKey)
  }

  private schedule(): void {
    if (!this.deps.live()) {
      this.flushSync()
      return
    }
    if (!this.deps.timer.has(this.flushKey)) this.deps.timer.set(this.flushKey, this.deps.now() + TEAM_FLUSH_MS)
  }
}
