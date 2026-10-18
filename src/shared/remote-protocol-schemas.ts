/**
 * Runtime validation for messages arriving from phone clients over the
 * embedded WebSocket server. Imported by the MAIN process only - keep zod out
 * of the mobile bundle (the phone trusts the desktop; the desktop trusts
 * nobody).
 */
import { z } from 'zod'
import type { RemoteClientMsg } from './remote-protocol'

const hex32 = z.string().regex(/^[0-9a-f]{64}$/)
const id = z.string().min(1).max(128)

const ctlActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('switchWorkspace'), workspaceId: id }),
  z.object({
    kind: z.literal('createPane'),
    workspaceId: id,
    presetId: id.optional(),
    paneType: z.enum(['shell', 'claude', 'codex', 'custom']).optional(),
    // E2-FR-11: the initial prompt, same bound as globalPrompt.
    prompt: z.string().max(16384).optional(),
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
  z.object({ v: z.number(), type: z.literal('input'), paneId: id, data: z.string().max(8192) }),
  z.object({ v: z.number(), type: z.literal('ctl'), id, action: ctlActionSchema }),
  z.object({ v: z.number(), type: z.literal('ping'), t: z.number() }),
  z.object({ v: z.number(), type: z.literal('visibility'), visible: z.boolean() }),
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
