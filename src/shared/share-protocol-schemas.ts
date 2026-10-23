/**
 * Runtime validation of Share frames, both directions (app 2.4.0, item 8).
 * Main only: the host parses every guest frame (`parseShareClientMsg`) and
 * the guest main parses every host frame (`parseShareHostMsg`) before any of
 * it reaches the renderer, because each end treats the other as untrusted.
 * Every object is strict (an unknown key is a malformed frame) and every
 * number, string and list is bounded (SHARE_LIMITS).
 *
 * A frame whose `t` is a well-formed name this build does not know parses as
 * `{ ok: false, unknown: true }`: the host answers `err{unsupported}` with no
 * strike, the guest ignores it. Anything else that fails is malformed.
 */
import { z } from 'zod'
import { FILE_REL_MAX, inGitDir, isSafeRel, shareFileNameOk } from './files'
import {
  SHARE_LIMITS,
  type ShareClientMsg,
  type ShareHandshakeMsg,
  type ShareHostMsg,
} from './share-protocol'

export type ShareParse<T> = { ok: true; msg: T } | { ok: false; unknown: boolean }

/** C0, DEL, C1 and the Unicode line/paragraph separators. */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
/** Bidi overrides and zero-width characters a label could use to hide its text. */
const INVISIBLE_RE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/

/** One-line display text: bounded, no control or invisible characters. */
const text = (max: number) =>
  z.string().max(max).refine((s) => !CONTROL_RE.test(s) && !INVISIBLE_RE.test(s), 'text')
/** Pane, preset and session ids: whatever the host config holds, bounded and one line. */
const id = z.string().min(1).max(128).refine((s) => !CONTROL_RE.test(s), 'id')
/** Request ids echoed in answers: plain ASCII. */
const reqId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const b64u32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const b64u16 = z.string().regex(/^[A-Za-z0-9_-]{22}$/)
/** The guest static key sealed in hs1: 32 bytes plus the 16-byte tag. */
const b64u48 = z.string().regex(/^[A-Za-z0-9_-]{64}$/)
const version = z.number().int().min(1).max(1000)
const seq = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const epoch = z.number().int().min(0).max(8.64e15)
const cols = z.number().int().min(SHARE_LIMITS.colsMin).max(SHARE_LIMITS.colsMax)
const rows = z.number().int().min(SHARE_LIMITS.rowsMin).max(SHARE_LIMITS.rowsMax)
const exitCode = z.number().int().min(-(2 ** 31)).max(2 ** 32)
const perm = z.enum(['view', 'type', 'full'])
const paneType = z.enum(['shell', 'claude', 'codex', 'custom'])
const scopeKind = z.enum(['pane', 'workspace'])
const platform = z.enum(['win32', 'darwin', 'linux'])
const color = z.string().max(32).refine((s) => !CONTROL_RE.test(s), 'color')
const icon = z.string().max(64).refine((s) => !CONTROL_RE.test(s), 'icon')
const noteId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
/** v2: a path inside the scoped workspace's folder ('' = its root), never into `.git`. */
const fileRel = z
  .string()
  .max(FILE_REL_MAX)
  .refine((rel) => isSafeRel(rel) && !inGitDir(rel), 'file path')
const noteRev = z.string().max(64)
const noteText = z.string().max(SHARE_LIMITS.noteTextMax)
const gitPath = z
  .string()
  .min(1)
  .max(1024)
  .refine((f) => !CONTROL_RE.test(f) && !/^([a-zA-Z]:|[\\/])/.test(f) && !f.split(/[\\/]/).includes('..'), 'relative path')

// --- Handshake ---

const handshakeSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hs1'), sv: version, min: version, e: b64u32, s: b64u48 }).strict(),
  z.object({ t: z.literal('hs2'), sv: version, e: b64u32 }).strict(),
  z.object({ t: z.literal('hsErr'), code: z.enum(['version', 'bad_msg']), min: version, max: version, app: text(SHARE_LIMITS.appMax).optional() }).strict(),
])

// --- Guest -> host ---

const clientCore = z.discriminatedUnion('t', [
  z
    .object({
      t: z.literal('hello'),
      sid: b64u16,
      guestName: z.string().max(SHARE_LIMITS.guestNameMax * 2),
      app: text(SHARE_LIMITS.appMax),
      proof: b64u32,
      ticket: b64u32.optional(),
      pw: b64u32.optional(),
    })
    .strict(),
  z.object({ t: z.literal('password'), proof: b64u32 }).strict(),
  z.object({ t: z.literal('sub'), paneId: id }).strict(),
  z.object({ t: z.literal('unsub'), paneId: id }).strict(),
  z.object({ t: z.literal('resync'), paneId: id }).strict(),
  z
    .object({
      t: z.literal('input'),
      paneId: id,
      data: z.string().min(1).max(SHARE_LIMITS.inputMax),
      seq,
      paste: z
        .object({ id: z.number().int().min(0).max(2 ** 31), part: z.number().int().min(0).max(SHARE_LIMITS.pasteParts - 1), last: z.boolean() })
        .strict()
        .optional(),
    })
    .strict(),
  z.object({ t: z.literal('chatSub'), paneId: id }).strict(),
  z.object({ t: z.literal('chatUnsub'), paneId: id }).strict(),
  z.object({ t: z.literal('chatMore'), paneId: id, before: z.string().regex(/^\d{1,15}$/) }).strict(),
  z
    .object({
      t: z.literal('gitReq'),
      id: reqId,
      op: z.enum(['status', 'diff']),
      path: gitPath.optional(),
      staged: z.boolean().optional(),
      page: z.number().int().min(0).max(999).optional(),
    })
    .strict(),
  z.object({ t: z.literal('filesReq'), id: reqId, op: z.enum(['list', 'read']), rel: fileRel }).strict(),
  z.object({ t: z.literal('filesWatch'), on: z.boolean() }).strict(),
  z.object({ t: z.literal('ping'), ts: z.number().finite() }).strict(),
  z.object({ t: z.literal('bye') }).strict(),
])

/** ctl has two shapes under one `t`, so it sits outside the discriminated union. */
const ctlSchema = z.union([
  z
    .object({
      t: z.literal('ctl'),
      id: reqId,
      op: z.literal('createPane'),
      presetId: id.optional(),
      paneType: z.enum(['shell', 'claude', 'codex']).optional(),
    })
    .strict(),
  z.object({ t: z.literal('ctl'), id: reqId, op: z.literal('closePane'), paneId: id }).strict(),
])
/** notesReq has one shape per op (list and read are v1; write, create and delete v2). */
const notesReqSchema = z.union([
  z.object({ t: z.literal('notesReq'), id: reqId, op: z.literal('list'), noteId: noteId.optional() }).strict(),
  z.object({ t: z.literal('notesReq'), id: reqId, op: z.literal('read'), noteId }).strict(),
  z.object({ t: z.literal('notesReq'), id: reqId, op: z.literal('write'), noteId, text: noteText, baseRev: noteRev.optional() }).strict(),
  z.object({ t: z.literal('notesReq'), id: reqId, op: z.literal('create'), text: noteText.optional() }).strict(),
  z.object({ t: z.literal('notesReq'), id: reqId, op: z.literal('delete'), noteId }).strict(),
])
const clientSchema = z.union([clientCore, ctlSchema, notesReqSchema])

// --- Host -> guest ---

const agentStatus = z
  .object({
    state: z.enum(['idle', 'working', 'done', 'action', 'error', 'unknown']),
    precise: z.boolean().optional(),
    provider: z.enum(['claude', 'codex']).optional(),
    hosted: z.literal(true).optional(),
    stateSince: epoch,
    activity: text(120).optional(),
    model: text(64).optional(),
    effort: text(16).optional(),
  })
  .strict()

const paneInfo = z
  .object({
    id,
    title: text(SHARE_LIMITS.titleMax),
    type: paneType,
    color,
    icon,
    running: z.boolean(),
    exitCode: exitCode.optional(),
    status: agentStatus.optional(),
  })
  .strict()

const caps = z
  .object({
    createPane: z.boolean(),
    closePane: z.boolean(),
    chat: z.boolean(),
    notes: z.boolean(),
    git: z.boolean(),
    notesWrite: z.boolean().optional(),
    files: z.boolean().optional(),
  })
  .strict()

const shareState = z
  .object({
    scope: z.object({ kind: scopeKind, label: text(SHARE_LIMITS.labelMax) }).strict(),
    perm,
    title: text(SHARE_LIMITS.titleMax),
    layoutOrder: z.array(id).max(SHARE_LIMITS.panesMax),
    panes: z.array(paneInfo).max(SHARE_LIMITS.panesMax),
    terminalUnicode11: z.boolean(),
    hostPlatform: platform,
    caps,
    presets: z
      .array(z.object({ id, name: text(SHARE_LIMITS.labelMax), type: paneType, icon, color }).strict())
      .max(SHARE_LIMITS.presetsMax)
      .optional(),
  })
  .strict()

// Chat items: the mobile decoders' caps (chat-types.ts) with headroom, so a
// hostile host cannot hand the guest renderer unbounded structures.
const chatBlock = z.discriminatedUnion('t', [
  z.object({ t: z.literal('text'), text: z.string().max(17 * 1024), truncated: z.boolean().optional() }).strict(),
  z.object({ t: z.literal('thinking'), text: z.string().max(5 * 1024), truncated: z.boolean().optional() }).strict(),
  z.object({ t: z.literal('toolUse'), id: z.string().max(128), name: text(128), summary: z.string().max(256) }).strict(),
  z
    .object({
      t: z.literal('toolResult'),
      toolUseId: z.string().max(128),
      isError: z.boolean(),
      text: z.string().max(5 * 1024),
      truncated: z.boolean().optional(),
      patch: z
        .object({
          filePath: z.string().max(1024).optional(),
          hunks: z
            .array(
              z
                .object({
                  oldStart: z.number().int().min(0),
                  oldLines: z.number().int().min(0),
                  newStart: z.number().int().min(0),
                  newLines: z.number().int().min(0),
                  lines: z.array(z.string().max(4096)).max(400),
                })
                .strict(),
            )
            .max(40),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z.object({ t: z.literal('image'), label: text(128) }).strict(),
  z.object({ t: z.literal('notice'), code: z.enum(['noTranscript', 'ambiguous', 'notLocal']) }).strict(),
])
const chatMessage = z
  .object({
    id: z.string().regex(/^\d{1,15}(?:\.\d{1,6})?$|^[A-Za-z0-9_-]{1,64}$/),
    role: z.enum(['user', 'assistant', 'tool', 'system']),
    ts: epoch.nullable(),
    blocks: z.array(chatBlock).max(64),
    parentId: z.string().max(128).optional(),
  })
  .strict()
const chatItems = z.array(chatMessage).max(64)

const gitFile = z
  .object({
    path: gitPath,
    oldPath: gitPath.optional(),
    area: z.enum(['staged', 'unstaged', 'untracked', 'conflict']),
    status: z.enum(['M', 'A', 'D', 'R', 'C', 'T', 'U', '?']),
    added: z.number().int().min(0).nullable(),
    removed: z.number().int().min(0).nullable(),
    binary: z.boolean(),
  })
  .strict()
const gitChip = {
  branch: text(256),
  ahead: z.number().int().min(0),
  behind: z.number().int().min(0),
  added: z.number().int().min(0),
  removed: z.number().int().min(0),
  files: z.number().int().min(0),
}
const gitChanges = z
  .object({
    summary: z
      .object({
        ...gitChip,
        approx: z.boolean(),
        conflicts: z.number().int().min(0),
        op: z.enum(['merge', 'rebase', 'cherry-pick']).nullable(),
      })
      .strict(),
    files: z.array(gitFile).max(5000),
    total: z.number().int().min(0),
    truncated: z.boolean(),
  })
  .strict()
const gitDiff = z
  .object({
    path: gitPath,
    oldPath: gitPath.optional(),
    area: z.enum(['staged', 'unstaged', 'untracked', 'conflict']),
    diffRev: z.string().max(128),
    binary: z.boolean(),
    tooLarge: z.object({ lines: z.number().int().min(0) }).strict().optional(),
    hunks: z
      .array(
        z
          .object({
            header: z.string().max(1024),
            oldStart: z.number().int().min(0),
            newStart: z.number().int().min(0),
            lines: z
              .array(
                z
                  .object({
                    kind: z.enum(['ctx', 'add', 'del', 'meta']),
                    oldNo: z.number().int().min(0).optional(),
                    newNo: z.number().int().min(0).optional(),
                    text: z.string().max(8192),
                  })
                  .strict(),
              )
              .max(5000),
            continued: z.boolean().optional(),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict()
const gitError = z
  .object({ error: z.enum(['not_found', 'not_repo', 'git_missing', 'git_old', 'unsafe_repo', 'too_large', 'rate', 'timeout', 'git_error']) })
  .strict()

const noteMeta = z
  .object({ id: noteId, title: text(80), updatedAt: epoch, size: z.number().int().min(0), rev: noteRev })
  .strict()
const note = noteMeta.extend({ text: z.string().max(40_000).optional(), readOnly: z.boolean().optional() }).strict()

const fileEntry = z
  .object({
    name: z.string().refine((n) => shareFileNameOk(n), 'file name'),
    kind: z.enum(['file', 'dir']),
    size: z.number().int().min(0),
    mtimeMs: z.number().int().min(-8.64e15).max(8.64e15),
    link: z.boolean().optional(),
  })
  .strict()
const shareFile = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('text'),
      text: z.string().max(SHARE_LIMITS.fileTextMax),
      eol: z.enum(['lf', 'crlf']),
      bom: z.boolean(),
      rev: noteRev,
      size: z.number().int().min(0),
      partial: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('image'),
      // Never SVG: it can carry scripts.
      dataUrl: z
        .string()
        .max(SHARE_LIMITS.fileDataUrlMax)
        .regex(/^data:image\/(png|jpeg|gif|webp|bmp|x-icon);base64,[A-Za-z0-9+/]*={0,2}$/),
      size: z.number().int().min(0),
      rev: noteRev,
    })
    .strict(),
])

const hostSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('ready') }).strict(),
  z
    .object({ t: z.literal('pending'), expiresAt: epoch, password: z.boolean(), salt: b64u16.optional(), passwordFailed: z.boolean().optional() })
    .strict(),
  z.object({ t: z.literal('denied'), reason: z.enum(['denied', 'timeout', 'locked', 'busy', 'limit']) }).strict(),
  z
    .object({
      t: z.literal('welcome'),
      session: z.object({ id }).strict(),
      grant: z.object({ scope: z.object({ kind: scopeKind, label: text(SHARE_LIMITS.labelMax) }).strict() }).strict(),
      perm,
      host: z.object({ label: text(SHARE_LIMITS.hostLabelMax), platform, app: text(SHARE_LIMITS.appMax) }).strict(),
      ticket: b64u32,
      state: shareState,
      limits: z.object({ inputMax: z.number().int().min(1).max(SHARE_LIMITS.inputMax) }).strict(),
    })
    .strict(),
  z.object({ t: z.literal('state'), state: shareState }).strict(),
  z
    .object({
      t: z.literal('replay'),
      paneId: id,
      running: z.boolean(),
      cols,
      rows,
      exitCode: exitCode.optional(),
      data: z.string().max(SHARE_LIMITS.replayChunkMax),
      first: z.boolean(),
      last: z.boolean(),
    })
    .strict(),
  z.object({ t: z.literal('out'), paneId: id, data: z.string().min(1).max(SHARE_LIMITS.outChunkMax) }).strict(),
  z.object({ t: z.literal('exit'), paneId: id, code: exitCode.nullable() }).strict(),
  z.object({ t: z.literal('fit'), paneId: id, cols, rows }).strict(),
  z.object({ t: z.literal('paneStatus'), paneId: id, status: agentStatus.nullable() }).strict(),
  z.object({ t: z.literal('inputLock'), paneId: id, holder: z.enum(['host', 'you', 'other']).nullable() }).strict(),
  z
    .object({
      t: z.literal('inputDenied'),
      paneId: id,
      seq,
      reason: z.enum([
        'view_only',
        'no_send',
        'interrupt',
        'blocked_key',
        'awaiting_host',
        'not_precise',
        'agent_busy',
        'ssh_escape',
        'host_typing',
        'other_typing',
        'paused',
        'rate',
        'out_of_scope',
        'paste_too_large',
        'paste_incomplete',
      ]),
    })
    .strict(),
  z.object({ t: z.literal('permChanged'), perm }).strict(),
  z.object({ t: z.literal('paused'), on: z.boolean() }).strict(),
  z
    .object({
      t: z.literal('ctlAck'),
      id: reqId,
      ok: z.boolean(),
      paneId: id.optional(),
      error: z.enum(['out_of_scope', 'bad_preset', 'rate', 'failed', 'unsupported', 'denied']).optional(),
    })
    .strict(),
  z.object({ t: z.literal('chatPage'), paneId: id, items: chatItems, cursor: z.string().regex(/^\d{1,15}$/).nullable(), done: z.boolean() }).strict(),
  z.object({ t: z.literal('chatAppend'), paneId: id, items: chatItems }).strict(),
  z
    .object({
      t: z.literal('gitRes'),
      id: reqId,
      ok: z.boolean(),
      data: z.union([gitChanges, gitDiff, gitError]),
      page: z.number().int().min(0).max(999),
      done: z.boolean(),
    })
    .strict(),
  z
    .object({
      t: z.literal('notesRes'),
      id: reqId,
      ok: z.boolean(),
      error: z.enum(['not_found', 'invalid', 'too_large', 'conflict', 'io', 'rate']).optional(),
      notes: z.array(noteMeta).max(500).optional(),
      note: note.optional(),
      current: note.optional(),
    })
    .strict(),
  z.object({ t: z.literal('notesChanged'), noteId: noteId.optional(), rev: noteRev.optional() }).strict(),
  z
    .object({
      t: z.literal('filesRes'),
      id: reqId,
      ok: z.boolean(),
      error: z.enum(['no_root', 'not_found', 'denied_path', 'invalid', 'binary', 'too_large', 'conflict', 'exists', 'io', 'rate']).optional(),
      entries: z.array(fileEntry).max(SHARE_LIMITS.filesListMax).optional(),
      truncated: z.boolean().optional(),
      file: shareFile.optional(),
    })
    .strict(),
  z.object({ t: z.literal('filesChanged'), dirs: z.array(fileRel).max(SHARE_LIMITS.filesChangedDirsMax), all: z.literal(true).optional() }).strict(),
  z.object({ t: z.literal('ended'), reason: z.enum(['revoked', 'kicked', 'expired', 'scope_gone', 'host_quit', 'sharing_off']) }).strict(),
  z.object({ t: z.literal('pong'), ts: z.number().finite() }).strict(),
  z.object({ t: z.literal('err'), code: z.enum(['bad_msg', 'out_of_scope', 'unsupported', 'rate', 'paused', 'unauthorized']) }).strict(),
])

const KNOWN_TYPE_RE = /^[A-Za-z][A-Za-z0-9]{0,31}$/

function parseWith<T>(schema: z.ZodTypeAny, known: ReadonlySet<string>, raw: unknown, maxLen: number): ShareParse<T> {
  if (typeof raw !== 'string' || raw.length > maxLen) return { ok: false, unknown: false }
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return { ok: false, unknown: false }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, unknown: false }
  const type = (obj as { t?: unknown }).t
  if (typeof type !== 'string' || !KNOWN_TYPE_RE.test(type)) return { ok: false, unknown: false }
  if (!known.has(type)) return { ok: false, unknown: true }
  const result = schema.safeParse(obj)
  return result.success ? { ok: true, msg: result.data as T } : { ok: false, unknown: false }
}

const CLIENT_TYPES = new Set([
  'hello', 'password', 'sub', 'unsub', 'resync', 'input', 'ctl', 'chatSub', 'chatUnsub', 'chatMore', 'gitReq', 'notesReq',
  'filesReq', 'filesWatch', 'ping', 'bye',
])
const HOST_TYPES = new Set([
  'ready', 'pending', 'denied', 'welcome', 'state', 'replay', 'out', 'exit', 'fit', 'paneStatus', 'inputLock', 'inputDenied',
  'permChanged', 'paused', 'ctlAck', 'chatPage', 'chatAppend', 'gitRes', 'notesRes', 'notesChanged', 'filesRes', 'filesChanged',
  'ended', 'pong', 'err',
])
const HANDSHAKE_TYPES = new Set(['hs1', 'hs2', 'hsErr'])

/** One decrypted guest frame (host side). */
export function parseShareClientMsg(raw: unknown): ShareParse<ShareClientMsg> {
  return parseWith<ShareClientMsg>(clientSchema, CLIENT_TYPES, raw, SHARE_LIMITS.guestFrameMax)
}

/** One decrypted host frame (guest side): a violation drops the frame and closes the link. */
export function parseShareHostMsg(raw: unknown): ShareParse<ShareHostMsg> {
  return parseWith<ShareHostMsg>(hostSchema, HOST_TYPES, raw, SHARE_LIMITS.hostFrameMax)
}

/** One cleartext handshake frame (either side); an unknown type is malformed here. */
export function parseShareHandshake(raw: unknown): ShareHandshakeMsg | null {
  const r = parseWith<ShareHandshakeMsg>(handshakeSchema, HANDSHAKE_TYPES, raw, 4096)
  return r.ok ? r.msg : null
}
