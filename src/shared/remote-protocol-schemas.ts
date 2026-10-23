/**
 * Runtime validation for messages arriving from phone clients over the
 * embedded WebSocket server. Imported by the MAIN process only - keep zod out
 * of the mobile bundle (the phone trusts the desktop; the desktop trusts
 * nobody).
 */
import { z } from 'zod'
import type { RemoteClientMsg } from './remote-protocol'
import { WS_NOTE_ID_RE, WS_NOTE_PHONE_MAX } from './ws-notes'
import { isClaudeModel } from './agentTune'
import { ACCOUNT_ID_RE } from './claude-accounts'

const hex32 = z.string().regex(/^[0-9a-f]{64}$/)
const id = z.string().min(1).max(128)

// --- E7-FR-22..25 (R30-09a): git API and inline review notes ---------------

/** C0, DEL, C1 and the Unicode line/paragraph separators. */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
/**
 * A gitReq id is echoed in every gitRes: plain ASCII keeps its JSON size
 * fixed, so the 48KB page budget holds for any id the schema lets in.
 */
const gitReqId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
/** Workspace and note ids of notesReq: they name a folder and a file under dataDir()/notes. */
const noteId = z.string().regex(WS_NOTE_ID_RE)
/** A note's file: repo-relative, no `..` segment, no control character. */
const noteFile = z
  .string()
  .min(1)
  .max(1024)
  .refine((f) => !CONTROL_RE.test(f) && !/^([a-zA-Z]:|[\\/])/.test(f) && !f.split(/[\\/]/).includes('..'), 'relative path')
const reviewNotePayload = z.object({
  file: noteFile,
  lines: z.string().regex(/^(\d{1,8}(-\d{1,8})?)?$/),
  comment: z.string().min(1).max(4000),
})

const ctlActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('switchWorkspace'), workspaceId: id }),
  z.object({
    kind: z.literal('createPane'),
    workspaceId: id,
    presetId: id.optional(),
    paneType: z.enum(['shell', 'claude', 'codex', 'custom']).optional(),
    // E2-FR-11: the initial prompt, same bound as globalPrompt.
    prompt: z.string().max(16384).optional(),
    // E3-FR-39: the id format and its presence in the history are main's to
    // judge (ack notFound), so an unknown id never counts as a malformed frame.
    resume: z.object({ provider: z.enum(['claude', 'codex']), sessionId: z.string().min(1).max(128) }).optional(),
  }),
  z.object({ kind: z.literal('closePane'), workspaceId: id, paneId: id }),
  z.object({ kind: z.literal('restartPane'), workspaceId: id, paneId: id, resume: z.boolean().optional() }),
  z.object({ kind: z.literal('globalPrompt'), workspaceId: id, text: z.string().max(16384) }),
  z.object({
    kind: z.literal('setTheme'),
    theme: z.enum(['midnight', 'light', 'nord', 'dracula', 'solarized', 'custom']),
  }),
  z.object({
    kind: z.literal('renamePane'),
    workspaceId: id,
    paneId: id,
    title: z.string().min(1).max(200),
  }),
  // E8-FR-07. The renderer requires paneId for a `send` command (bad_request).
  z.object({ kind: z.literal('runQuickCommand'), workspaceId: id, paneId: id.optional(), id }),
  // E2 Home (R22-14). The scheme of openUrl is the executor's to judge: a
  // refused link answers ctlAck `denied_url` (contract) instead of dropping
  // the frame as malformed, which would cost the phone a strike and no ack.
  z.object({ kind: z.literal('mountWorkspace'), workspaceId: id }),
  z.object({ kind: z.literal('revealPane'), paneId: id }),
  z.object({ kind: z.literal('openUrl'), url: z.string().min(1).max(2048) }),
  // E2-FR-28..30. Main re-validates the path against the root the renderer resolves.
  z.object({ kind: z.literal('openPath'), workspaceId: id, paneId: id, path: z.string().min(1).max(4096) }),
  // E6-FR-24 (R22-20): pane membership and the stale check are the executor's.
  z.object({ kind: z.literal('agentResume'), workspaceId: id, paneId: id, mode: z.enum(['resume', 'new']) }),
  // E3-FR-20 (R30-04): a grid out of range is a malformed frame (bad_msg,
  // one strike); the phone never builds one because phoneGrid clamps.
  z.object({
    kind: z.literal('fitPane'),
    workspaceId: id,
    paneId: id,
    cols: z.number().int().min(20).max(500),
    rows: z.number().int().min(8).max(300),
  }),
  z.object({ kind: z.literal('releaseFit'), paneId: id }),
  // E7-FR-25 (R30-09a): the whole frame stays under MAX_PAYLOAD (64KB), so the
  // phone splits a bigger batch over several ctl.
  z.object({
    kind: z.literal('sendReviewNotes'),
    workspaceId: id,
    paneId: id,
    notes: z.array(reviewNotePayload).min(1).max(50),
    enter: z.boolean(),
  }),
  // E8-FR-32 (v3.1, R31-00): pane membership and the schedule itself are the
  // executor's to check (ack not_found / no_schedule). scheduleRun carries no
  // text: a stray field is stripped, never sent.
  z.object({ kind: z.literal('scheduleRun'), workspaceId: id, paneId: id }),
  z.object({ kind: z.literal('scheduleToggle'), workspaceId: id, paneId: id, enabled: z.boolean() }),
  // app 2.3.0: only allowlisted values (the phone never builds another one);
  // the provider and the Enter gate are the executor's and main's to judge.
  z.object({
    kind: z.literal('agentTune'),
    workspaceId: id,
    paneId: id,
    set: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('model'), value: z.string().max(64).refine(isClaudeModel, 'model') }),
      z.object({ kind: z.literal('effort'), value: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'auto']) }),
      z.object({ kind: z.literal('ultracode'), on: z.boolean() }),
      z.object({ kind: z.literal('picker') }),
    ]),
    enter: z.boolean(),
  }),
  // app 2.3.0: Claude account switch from the phone (main re-validates the role).
  // app 2.4.0: or by id. A discriminatedUnion member takes no .refine, so
  // "exactly one of role and id" is checked by the executor (bad_target).
  z.object({ kind: z.literal('claudeAccountUse'), role: z.enum(['primary', 'secondary']).optional(), id: z.string().regex(ACCOUNT_ID_RE).optional() }),
  // app 2.4.0: an option of Claude's menu from the Chat view. Main re-reads
  // the screen and compares the label before it writes the digit (no Enter).
  z.object({
    kind: z.literal('answerMenu'),
    paneId: id,
    pendingId: z.string().min(1).max(200),
    n: z.number().int().min(1).max(9),
    label: z.string().min(1).max(160),
  }),
  // app 2.7.0 (A3): status marks, handled in main (StatusManager). Only the
  // pane id travels; main says whether the mark applies (ack not_found).
  z.object({ kind: z.literal('markRead'), paneId: id }),
  z.object({ kind: z.literal('mutePane'), paneId: id, muted: z.boolean() }),
  z.object({ kind: z.literal('silenceAck'), paneId: id }),
])

export const remoteClientMsgSchema = z.discriminatedUnion('type', [
  z.object({ v: z.number(), type: z.literal('hello'), deviceId: id.optional(), clientNonce: hex32 }),
  z.object({
    v: z.number(),
    type: z.literal('pair'),
    code: z.string().min(1).max(16),
    deviceName: z.string().min(1).max(48),
  }),
  z.object({ v: z.number(), type: z.literal('auth'), deviceId: id, hmac: hex32 }),
  z.object({ v: z.number(), type: z.literal('sub'), paneId: id }),
  z.object({ v: z.number(), type: z.literal('unsub'), paneId: id }),
  z.object({ v: z.number(), type: z.literal('input'), paneId: id, data: z.string().max(8192), submit: z.boolean().optional() }),
  z.object({ v: z.number(), type: z.literal('ctl'), id, action: ctlActionSchema }),
  z.object({ v: z.number(), type: z.literal('ping'), t: z.number() }),
  z.object({ v: z.number(), type: z.literal('visibility'), visible: z.boolean() }),
  // E3-FR-36; behind the per-session bucket by name (SessionManager).
  z.object({ v: z.number(), type: z.literal('historyReq'), id, query: z.string().max(200).optional(), workspaceId: id.optional() }),
  // E7-FR-22/23 (R30-09a). A diff without `path` answers not_found, not bad_msg.
  z.object({
    v: z.number(),
    type: z.literal('gitReq'),
    id: gitReqId,
    workspaceId: id,
    op: z.enum(['status', 'diff']),
    path: z.string().min(1).max(1024).optional(),
    staged: z.boolean().optional(),
    page: z.number().int().min(0).max(999).optional(),
  }),
  // v2.2 (E9): workspace notes; ids are folder-safe, the text fits one frame.
  z.object({
    v: z.number(),
    type: z.literal('notesReq'),
    id: gitReqId,
    workspaceId: noteId,
    op: z.enum(['list', 'read', 'write', 'create', 'delete']),
    noteId: noteId.optional(),
    text: z.string().max(WS_NOTE_PHONE_MAX).optional(),
    baseRev: z.string().max(64).optional(),
  }),
  // app 2.7.0 (A3): the full ExitPlanMode plan; behind the bucket by name and
  // a per-session window (SessionManager). `requestId` as answerMenu's pendingId.
  z.object({ v: z.number(), type: z.literal('planReq'), id: gitReqId, paneId: id, requestId: z.string().min(1).max(200).optional() }),
  // E3 M12 Chat view (R30-05); behind the per-session bucket by name. Main
  // clamps `before` to [0, size] and aligns it to the next line start.
  z.object({ v: z.number(), type: z.literal('chatSub'), paneId: id }),
  z.object({ v: z.number(), type: z.literal('chatUnsub'), paneId: id }),
  z.object({ v: z.number(), type: z.literal('chatMore'), paneId: id, before: z.string().regex(/^\d{1,15}$/) }),
])

/** Parse one raw WS frame into a validated client message, or null. */
export function parseRemoteClientMsg(raw: unknown): RemoteClientMsg | null {
  if (typeof raw !== 'string' || raw.length > 64 * 1024) return null
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  const result = remoteClientMsgSchema.safeParse(obj)
  return result.success ? (result.data as RemoteClientMsg) : null
}
