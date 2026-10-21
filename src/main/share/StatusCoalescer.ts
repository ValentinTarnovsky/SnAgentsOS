/**
 * Agent status relay of the Share host (app 2.4.0, item 8): the copy of
 * RemoteManager.pushPaneStatus's coalesce (PANE_STATUS_COALESCE_MS, mirror)
 * with an injected send, so a burst of PreToolUse events costs a guest at
 * most 10 frames/s per pane. working/idle/unknown are held up to 100 ms;
 * action, done, error and the clearing null go out at once. Identical
 * consecutive statuses are dropped.
 *
 * `toShareStatus` is the guest's view of a status: RemotePaneStatus without
 * the host-local `pending`, `attention`, `menu`, `reason`, `lastMessage` or
 * account fields, every text bounded like the share schemas.
 */
import { shareText, type ShareAgentStatus } from '@shared/share-protocol'
import type { AgentProvider, ClaudePaneState } from '@shared/types'
import { realShareClock, type ShareClock, type ShareTimer } from './clock'

/** Mirror of RemoteManager's PANE_STATUS_COALESCE_MS. */
export const SHARE_STATUS_COALESCE_MS = 100
const IMMEDIATE_STATES = new Set<ClaudePaneState | null>(['action', 'done', 'error', null])

/** What either status shape (PaneStatusEvt or RemotePaneStatus) carries that a guest may see. */
export interface StatusLike {
  state?: ClaudePaneState | null
  precise?: boolean
  provider?: AgentProvider
  hosted?: boolean
  stateSince?: number
  updatedAt?: number
  activity?: string
  model?: string
  effort?: string
}

export function toShareStatus(evt: StatusLike | null | undefined): ShareAgentStatus | null {
  if (!evt || evt.state == null) return null
  const out: ShareAgentStatus = { state: evt.state, stateSince: Math.max(0, Math.floor(evt.stateSince ?? evt.updatedAt ?? 0)) }
  if (evt.precise === false) out.precise = false
  if (evt.provider === 'claude' || evt.provider === 'codex') out.provider = evt.provider
  if (evt.hosted) out.hosted = true
  const activity = evt.activity ? shareText(evt.activity, 120) : ''
  if (activity) out.activity = activity
  const model = evt.model ? shareText(evt.model, 64) : ''
  if (model) out.model = model
  const effort = evt.effort ? shareText(evt.effort, 16) : ''
  if (effort) out.effort = effort
  return out
}

export class StatusCoalescer {
  private readonly sent = new Map<string, string>()
  private readonly held = new Map<string, ShareAgentStatus | null>()
  private readonly timers = new Map<string, ShareTimer>()

  constructor(
    private readonly send: (paneId: string, status: ShareAgentStatus | null) => void,
    private readonly clock: ShareClock = realShareClock,
  ) {}

  push(paneId: string, status: ShareAgentStatus | null): void {
    if (IMMEDIATE_STATES.has(status?.state ?? null)) {
      this.cancel(paneId)
      this.emit(paneId, status)
      return
    }
    this.held.set(paneId, status)
    if (this.timers.has(paneId)) return
    this.timers.set(
      paneId,
      this.clock.setTimeout(() => {
        this.timers.delete(paneId)
        if (!this.held.has(paneId)) return
        const status = this.held.get(paneId) ?? null
        this.held.delete(paneId)
        this.emit(paneId, status)
      }, SHARE_STATUS_COALESCE_MS),
    )
  }

  /** A state frame just carried this status to every guest: it becomes the dedupe baseline. */
  markSent(paneId: string, status: ShareAgentStatus | null): void {
    this.sent.set(paneId, status ? JSON.stringify(status) : 'null')
  }

  reset(): void {
    for (const t of this.timers.values()) this.clock.clearTimeout(t)
    this.timers.clear()
    this.held.clear()
    this.sent.clear()
  }

  private emit(paneId: string, status: ShareAgentStatus | null): void {
    const key = status ? JSON.stringify(status) : 'null'
    if (this.sent.get(paneId) === key) return
    this.sent.set(paneId, key)
    this.send(paneId, status)
  }

  private cancel(paneId: string): void {
    const t = this.timers.get(paneId)
    if (t !== undefined) this.clock.clearTimeout(t)
    this.timers.delete(paneId)
    this.held.delete(paneId)
  }
}
