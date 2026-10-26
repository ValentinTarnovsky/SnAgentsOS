/**
 * Runtime validation of every Teams request (app 2.7.0, Tanda B): the
 * `teams:req` invoke of the renderer and the phone `teamReq` subset. Imported
 * by the MAIN process only, like remote-protocol-schemas.ts: zod stays out of
 * the renderer and the phone bundles (the desktop trusts nobody).
 *
 * One plain `z.object` per op (zod 3.25, v3 API: a discriminated union takes
 * objects only, refinements live on fields). The phone union reuses the very
 * same objects, so the subset never drifts. Ids by the regexes of teams.ts,
 * texts by its caps; single-line texts refuse every control character, bodies
 * allow only `\n` and `\t`.
 */
import { z } from 'zod'
import { CLAUDE_EFFORTS, isClaudeModel } from './agentTune'
import { CODEX_EFFORTS, CODEX_MODEL_RE, ROLE_NAME_MAX, ROLES_MAX, VERIFY_COMMAND_MAX, validBranchName } from './teamDefinition'
import type { PhoneTeamRequest, TeamCtlAction, TeamRequest } from './team-protocol'
import {
  AGENT_ID_RE,
  APPROVAL_ID_RE,
  BLOCKED_BY_MAX,
  BOARD_COLUMNS,
  CARD_ID_RE,
  CARD_OPTIONS_MAX,
  CARD_TEXT_ANSWER_MAX,
  COMMENT_TEXT_MAX,
  DECIDE_NOTE_MAX,
  GOAL_MAX,
  QUEUE_ID_RE,
  REPO_ID_RE,
  ROLE_COUNT_MAX,
  ROLE_ID_RE,
  ROLE_KINDS,
  ROUTINE_ID_RE,
  RULES_MAX,
  RUN_ID_RE,
  RUN_NOW_PROMPT_MAX,
  TASK_BODY_MAX,
  TASK_FIELDS,
  TASK_ID_RE,
  TASK_PRIORITIES,
  TASK_TITLE_MAX,
  TEAM_ID_RE,
  TEAM_NAME_MAX,
  type BoardColumn,
  type CardAction,
  type RoleKind,
  type TaskField,
  type TaskPriority,
} from './teams'
import { WS_NOTE_ID_RE } from './ws-notes'

// ---- leaves ------------------------------------------------------------------------------------

/** C0, DEL, C1 and the Unicode line/paragraph separators: never inside a one-line value. */
const LINE_BAD_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
/** C0 except tab and newline, and DEL: never inside a body. */
const BODY_BAD_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/
/** Absolute on any desktop OS: a drive letter, a UNC share or a POSIX root (main re-checks with path.isAbsolute). */
const ABSOLUTE_RE = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/
/** Cursors main hands out (comment ids, task ids, offsets): plain ASCII. */
const CURSOR_RE = /^[A-Za-z0-9_.:-]{1,64}$/
const SHA256_RE = /^[0-9a-f]{64}$/
/** A full commit sha (SHA-1 or SHA-256 repositories). */
const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

const line = (max: number) => z.string().max(max).refine((s) => !LINE_BAD_RE.test(s), 'control character')
const body = (max: number) => z.string().max(max).refine((s) => !BODY_BAD_RE.test(s), 'control character')
const enumOf = <T extends string>(values: readonly T[]) => z.enum(values as unknown as [T, ...T[]])

const teamId = z.string().regex(TEAM_ID_RE)
const taskId = z.string().regex(TASK_ID_RE)
const agentId = z.string().regex(AGENT_ID_RE)
const runId = z.string().regex(RUN_ID_RE)
const repoId = z.string().regex(REPO_ID_RE)
/** Pane and workspace ids of the app config (B9 takeover): bounded, one line. */
const configId = line(128).pipe(z.string().min(1))
/** `setupProbe.dir` and `repoRoot`: absolute, <= 4096, no NUL (validRepoDir); main resolves the git main root. */
const repoDir = z
  .string()
  .min(1)
  .max(4096)
  .refine((d) => !d.includes('\0') && ABSOLUTE_RE.test(d), 'absolute path')
const cursor = z.string().regex(CURSOR_RE)
const priority = enumOf<TaskPriority>(TASK_PRIORITIES)
const isolation = z.enum(['worktree', 'main'])
const taskField = enumOf<TaskField>(TASK_FIELDS)
const blockedBy = z.array(taskId).max(BLOCKED_BY_MAX)
const CARD_ACTIONS: readonly CardAction[] = ['retry', 'resume', 'toTodo', 'cancelTask', 'stopRun', 'keepWaiting', 'dropBlocker', 'resumeTeam', 'newSession', 'killOrphan', 'dismiss']

// ---- composite values --------------------------------------------------------------------------

/** One role row of the setup dialog: model and effort from the provider's allowlist. */
const roleDraft = z
  .object({
    id: z.string().regex(ROLE_ID_RE),
    name: line(ROLE_NAME_MAX).pipe(z.string().min(1)),
    kind: enumOf<RoleKind>(ROLE_KINDS),
    provider: z.enum(['claude', 'codex']),
    model: z.string().max(64).optional(),
    effort: z.string().max(16).optional(),
    permission: z.enum(['total', 'readonly']),
    count: z.number().int().min(1).max(ROLE_COUNT_MAX),
    enabled: z.boolean(),
  })
  .superRefine((r, ctx) => {
    if (r.model !== undefined && !(r.provider === 'claude' ? isClaudeModel(r.model) : CODEX_MODEL_RE.test(r.model))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['model'], message: 'model' })
    }
    const efforts: readonly string[] = r.provider === 'claude' ? CLAUDE_EFFORTS : CODEX_EFFORTS
    if (r.effort !== undefined && !efforts.includes(r.effort)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['effort'], message: 'effort' })
    }
  })

/** The setup draft, fully bounded; the definition rules (one lead, reserved ids) are main's parser's issues. */
const setupDraft = z.object({
  lang: z.enum(['es', 'en']),
  name: line(TEAM_NAME_MAX).pipe(z.string().min(1)),
  goal: body(GOAL_MAX),
  rules: body(RULES_MAX).optional(),
  baseBranch: z.string().refine(validBranchName, 'branch').optional(),
  maxConcurrent: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  leadApprovesSmallPlans: z.boolean(),
  verify: line(VERIFY_COMMAND_MAX).optional(),
  roles: z
    .array(roleDraft)
    .max(ROLES_MAX)
    .refine((roles) => new Set(roles.map((r) => r.id)).size === roles.length, 'duplicate role id'),
  dailySummary: z.boolean(),
})

const cardAnswer = z.object({
  choices: z.array(z.number().int().min(0).max(CARD_OPTIONS_MAX - 1)).max(CARD_OPTIONS_MAX).optional(),
  text: body(CARD_TEXT_ANSWER_MAX).optional(),
  confirm: z.boolean().optional(),
  action: enumOf<CardAction>(CARD_ACTIONS).optional(),
})

const taskDraft = z.object({
  title: line(TASK_TITLE_MAX).pipe(z.string().min(1)),
  body: body(TASK_BODY_MAX).optional(),
  assignee: agentId.optional(),
  repoId: repoId.optional(),
  isolation: isolation.optional(),
  blockedBy: blockedBy.optional(),
  priority: priority.optional(),
  needsPlan: z.boolean().optional(),
})

const taskPatch = z.object({
  title: line(TASK_TITLE_MAX).pipe(z.string().min(1)).optional(),
  body: body(TASK_BODY_MAX).optional(),
  assignee: agentId.nullable().optional(),
  priority: priority.optional(),
  blockedBy: blockedBy.optional(),
  isolation: isolation.optional(),
  needsPlan: z.boolean().optional(),
  repoId: repoId.optional(),
})

// ---- one object per op -------------------------------------------------------------------------

const op = <O extends string, S extends z.ZodRawShape>(name: O, shape: S) => z.object({ op: z.literal(name), ...shape })

// B1
const listReq = op('list', {})
const getReq = op('get', { teamId })
const setupProbeReq = op('setupProbe', { dir: repoDir })
const setupPreviewReq = op('setupPreview', { repoRoot: repoDir, draft: setupDraft })
const setupWriteReq = op('setupWrite', { repoRoot: repoDir, draft: setupDraft, previewHash: z.string().regex(SHA256_RE) })
const adoptReq = op('adopt', { repoRoot: repoDir, sha256: z.string().regex(SHA256_RE) })
const trustDiffReq = op('trustDiff', { teamId })
const trustReq = op('trust', { teamId, sha256: z.string().regex(SHA256_RE) })
const removeReq = op('remove', { teamId })
const settingsReq = op('settings', { teamId, patch: z.object({ autoDispatch: z.boolean().optional(), paused: z.boolean().optional() }) })
const revealReq = op('reveal', { teamId, what: z.enum(['definition', 'data']) })
// B2
const rosterReq = op('roster', { teamId })
const runNowReq = op('runNow', { teamId, agentId, taskId: taskId.optional(), prompt: body(RUN_NOW_PROMPT_MAX).optional() })
const stopReq = op('stop', { teamId, runId })
const pauseAgentReq = op('pauseAgent', { teamId, agentId, on: z.boolean() })
const runsReq = op('runs', { teamId, agentId: agentId.optional(), taskId: taskId.optional(), before: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional() })
const runPageReq = op('runPage', { teamId, runId, before: z.string().regex(/^\d{1,15}$/).optional() })
const watchRunReq = op('watchRun', { teamId, runId: runId.nullable() })
// B3
const boardReq = op('board', { teamId, column: enumOf<BoardColumn>(BOARD_COLUMNS).optional(), cursor: cursor.optional(), limit: z.number().int().min(1).max(500).optional() })
const taskReq = op('task', { teamId, taskId, commentsBefore: cursor.optional() })
const createTaskReq = op('createTask', { teamId, task: taskDraft })
const updateTaskReq = op('updateTask', { teamId, taskId, baseRev: z.number().int().min(0), patch: taskPatch })
const moveTaskReq = op('moveTask', {
  teamId,
  taskId,
  baseRev: z.number().int().min(0),
  to: z.enum(['todo', 'blocked', 'done', 'cancelled']),
  priority: priority.optional(),
  stopRun: z.boolean().optional(),
  text: body(COMMENT_TEXT_MAX).optional(),
})
const releaseOwnedReq = op('releaseOwned', { teamId, taskId, fields: z.array(taskField).min(1).max(TASK_FIELDS.length) })
const commentReq = op('comment', { teamId, taskId, text: body(COMMENT_TEXT_MAX).pipe(z.string().min(1)) })
const leadReq = op('lead', { teamId, before: cursor.optional() })
const leadSayReq = op('leadSay', { teamId, text: body(COMMENT_TEXT_MAX).pipe(z.string().min(1)) })
// B4
const dispatchReq = op('dispatch', { teamId, queueId: z.union([z.string().regex(QUEUE_ID_RE), z.literal('all')]), go: z.boolean() })
const kickoffReq = op('kickoff', { teamId })
const resumeTaskReq = op('resumeTask', { teamId, taskId })
// B5
const needsReq = op('needs', { teamId })
// rev (B close): the permission approval's rev the user saw; a missing or older rev answers conflict {stale} (other kinds ignore it)
const approvalRev = z.number().int().positive().optional()
const decideReq = op('decide', { teamId, approvalId: z.string().regex(APPROVAL_ID_RE), decision: z.enum(['approve', 'reject']), note: body(DECIDE_NOTE_MAX).optional(), rev: approvalRev })
const answerReq = op('answer', { teamId, cardId: z.string().regex(CARD_ID_RE), answer: cardAnswer })
// B6
const integratePreviewReq = op('integratePreview', { teamId, taskId })
const integrateReq = op('integrate', { teamId, taskId, expectTip: z.string().regex(FULL_SHA_RE) })
const askRebaseReq = op('askRebase', { teamId, taskId, why: z.enum(['conflict', 'verify']) })
const confirmVerifyReq = op('confirmVerify', { teamId, repoId, command: line(VERIFY_COMMAND_MAX).pipe(z.string().min(1)) })
const removeWorktreeReq = op('removeWorktree', { teamId, taskId })
// B7
const routinesReq = op('routines', { teamId })
const routineRunReq = op('routineRun', { teamId, routineId: z.string().regex(ROUTINE_ID_RE) })
const notesReq = op('notes', { teamId })
const noteReq = op('note', { teamId, noteId: z.string().regex(WS_NOTE_ID_RE) })
const runSilenceAckReq = op('runSilenceAck', { teamId, runId })
// B9
const takeoverReq = op('takeover', { teamId, agentId })
const takeoverBoundReq = op('takeoverBound', { teamId, agentId, paneId: configId, workspaceId: configId })
const takeoverAbortReq = op('takeoverAbort', { teamId, agentId })
const releaseReq = op('release', { teamId, agentId })

/** Every op of TeamRequest (B1..B9); the IPC register parses with it before TeamService.request. */
export const teamRequestSchema = z.discriminatedUnion('op', [
  listReq, getReq, setupProbeReq, setupPreviewReq, setupWriteReq, adoptReq, trustDiffReq, trustReq, removeReq, settingsReq, revealReq,
  rosterReq, runNowReq, stopReq, pauseAgentReq, runsReq, runPageReq, watchRunReq,
  boardReq, taskReq, createTaskReq, updateTaskReq, moveTaskReq, releaseOwnedReq, commentReq, leadReq, leadSayReq,
  dispatchReq, kickoffReq, resumeTaskReq,
  needsReq, decideReq, answerReq,
  integratePreviewReq, integrateReq, askRebaseReq, confirmVerifyReq, removeWorktreeReq,
  routinesReq, routineRunReq, notesReq, noteReq, runSilenceAckReq,
  takeoverReq, takeoverBoundReq, takeoverAbortReq, releaseReq,
])

/** PHONE_TEAM_OPS, built from the same objects as the desktop union (B8 nests it under `teamReq.req`). */
export const phoneTeamRequestSchema = z.discriminatedUnion('op', [
  listReq, boardReq, taskReq, needsReq, runPageReq, createTaskReq, commentReq, leadSayReq, leadReq,
])

/** The three phone ctl actions (B8 adds them to ctlActionSchema of remote-protocol-schemas.ts). */
export const teamCtlActionSchemas = [
  z.object({ kind: z.literal('teamDecide'), teamId, approvalId: z.string().regex(APPROVAL_ID_RE), decision: z.enum(['approve', 'reject']), note: body(DECIDE_NOTE_MAX).optional(), rev: approvalRev }),
  z.object({ kind: z.literal('teamAnswer'), teamId, cardId: z.string().regex(CARD_ID_RE), answer: cardAnswer }),
  z.object({ kind: z.literal('teamDispatch'), teamId, queueId: z.union([z.string().regex(QUEUE_ID_RE), z.literal('all')]), go: z.boolean() }),
] as const

/** A raw `teams:req` payload as a TeamRequest, or null (the caller answers bad_request). */
export function parseTeamRequest(raw: unknown): TeamRequest | null {
  const p = teamRequestSchema.safeParse(raw)
  return p.success ? (p.data as TeamRequest) : null
}

// Compile-time drift guards: each schema's output and its protocol type are mutually assignable.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Holds<T extends true> = T
export type TeamRequestSchemaHolds = Holds<Same<z.infer<typeof teamRequestSchema>, TeamRequest>>
export type PhoneTeamRequestSchemaHolds = Holds<Same<z.infer<typeof phoneTeamRequestSchema>, PhoneTeamRequest>>
export type TeamCtlActionSchemaHolds = Holds<Same<z.infer<(typeof teamCtlActionSchemas)[number]>, TeamCtlAction>>
