import { randomUUID } from 'crypto'
import type { WebContents } from 'electron'
import { CH } from '@shared/ipc-channels'
import type { RemoteCommand, RemoteCommandResult } from '@shared/ipc-contract'
import type { CtlErrorCode, CtlRendererOp } from '@shared/ctl-protocol'

/** Renderer answer to one op: `data` on success, an error code otherwise. */
export type BusResult = { ok: true; data?: unknown } | { ok: false; error: CtlErrorCode; message?: string }

export interface RendererBus {
  request(op: CtlRendererOp): Promise<BusResult>
}

/** How long the renderer has to answer one op (RemoteManager uses 10 s for phones). */
export const BUS_TIMEOUT_MS = 5000

const KNOWN: readonly CtlErrorCode[] = ['bad_request', 'not_found', 'not_running', 'ssh_protected', 'busy', 'internal']

/**
 * Request/response to the renderer, which owns the workspace model (E8 Group
 * C). Rides the remote control relay (CONTRATOS: the CLI reuses
 * remote:controlCmd / remote:controlResult): the action is `{ kind: 'cli',
 * op }`, which the phone's schema never accepts, and results are matched by
 * id (RemoteManager ignores ids it did not send, and so does this bus).
 * No renderer (a reload) answers `desktop_unavailable` (exit 5).
 */
export class IpcRendererBus implements RendererBus {
  private readonly pending = new Map<string, { resolve: (r: BusResult) => void; timer: ReturnType<typeof setTimeout> }>()

  constructor(private readonly getSender: () => WebContents | null, private readonly timeoutMs = BUS_TIMEOUT_MS) {}

  request(op: CtlRendererOp): Promise<BusResult> {
    const wc = this.getSender()
    if (!wc || wc.isDestroyed()) return Promise.resolve({ ok: false, error: 'desktop_unavailable' })
    const id = `cli-${randomUUID()}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, error: 'desktop_unavailable', message: 'the desktop did not answer' })
      }, this.timeoutMs)
      this.pending.set(id, { resolve, timer })
      const cmd: RemoteCommand = { id, action: { kind: 'cli', op } }
      wc.send(CH.REMOTE_CONTROL_CMD, cmd)
    })
  }

  /** remote:controlResult listener; results of phone commands are not ours and are ignored. */
  onResult(res: RemoteCommandResult): void {
    const entry = res && typeof res.id === 'string' ? this.pending.get(res.id) : undefined
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(res.id)
    if (res.ok) entry.resolve({ ok: true, data: res.data })
    else {
      const error = (KNOWN as readonly string[]).includes(res.error ?? '') ? (res.error as CtlErrorCode) : 'internal'
      entry.resolve({ ok: false, error, message: res.error })
    }
  }

  /** Fails every pending op (the window went away). */
  dispose(): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.resolve({ ok: false, error: 'desktop_unavailable' })
      this.pending.delete(id)
    }
  }
}
