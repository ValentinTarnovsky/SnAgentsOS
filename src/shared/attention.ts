/**
 * "Needs you" (app 2.7.0): the one rule the desktop sidebar badge, the
 * palette's "Waiting for you", next waiting (Ctrl+Shift+J) and the phone's
 * Home count with, so every surface shows the same consoles in the same order.
 * Pure, no Node or DOM imports: main, renderer and mobile share it.
 *
 * A console needs the user when it is awake (not sleeping, not "not started"),
 * not `muted`, and any of:
 * - `needs` is set (`snaos needs "<action>"`): rank 1, like an open request,
 *   whatever its state (working included);
 * - main's `attention` is true: an open request nobody answered, or a done or
 *   error nobody saw;
 * - without `attention` (an older main, legacy fixtures): state `action`, or
 *   open requests (`pendingCount > 0`);
 * - `marked`: the desktop's local mark (`paneAttention`, `snaos notify`). Only
 *   the renderer has it, so it is the one input the phone never passes.
 * `muted` (silenced until the state changes; main resets it on the next
 * transition) leaves the console out, `needs` and `marked` included.
 *
 * The rules this replaces, where they disagreed:
 * - sidebar badge, `needsUser(status) || paneAttention`: the same set, plus a
 *   legacy `action` without `pendingCount`; a dormant console no longer counts
 *   (the badge read every pane, sleeping ones too);
 * - next waiting, `rank 1 || (rank 2 && unread)`: the same set whenever main
 *   sends `attention`, plus a `marked` console it skipped (working, idle or an
 *   answered action; the badge counted it); a legacy `error` without
 *   `attention` no longer counts (the badge and the phone never did);
 * - palette "Waiting for you" listed every agent console (working and idle
 *   too): now only these;
 * - phone, `waitsOnUser` (action only): now also a done or error nobody saw.
 *
 * Callers hand in one AttentionItem per pane, every pane and not only agent
 * rows, so a marked plain shell counts wherever the badge counts it: the badge
 * the panes of one workspace, the palette and next waiting those of every
 * workspace (status from paneStatus, `marked` from paneAttention, `dormant` for
 * a sleeping or not started console), the phone its snapshot's panes with the
 * live status map.
 *
 * Order: compareAgents. rank = agentRank(state, attention), or 1 with `needs`;
 * unread = attention true or `marked`; stateSince = status.stateSince ??
 * status.updatedAt ?? 0, or `needs.at` when `needs` is what lifted the console
 * to rank 1 (it waits since the agent asked).
 */
import { agentRank, compareAgents, type RankedPane } from './agents'
import { needsUser, waitsOnUser } from './status'
import type { ClaudePaneState } from './types'

/** `snaos needs "<action>"` as main publishes it (PaneStatusEvt.needs, A3). */
export interface PaneNeeds {
  text: string
  /** Epoch ms (desktop clock) when the agent asked. */
  at: number
}

/**
 * The status fields the rule reads. PaneStatusEvt, the renderer's PaneStatus
 * and RemotePaneStatus all fit; `needs` and `muted` are the optional A3 fields.
 */
export interface AttentionStatus {
  state: ClaudePaneState | null
  attention?: boolean
  pendingCount?: number
  stateSince?: number
  updatedAt?: number
  needs?: PaneNeeds
  /** Silenced until the state changes (main's mutedSeq === stateSeq). */
  muted?: boolean
}

/** One console as a surface hands it in, in that surface's own order. */
export interface AttentionItem {
  paneId: string
  workspaceId: string
  /** Its live status; absent, null or state null = no agent status. */
  status?: AttentionStatus | null
  /** Desktop only: the renderer's local mark (paneAttention). */
  marked?: boolean
  /** Sleeping (hibernated) or not started yet: no live agent, never counts. */
  dormant?: boolean
}

/** A console that needs the user, ranked; `id` is its paneId. */
export interface NeedsYouRow<T extends AttentionItem = AttentionItem> extends RankedPane {
  item: T
}

export interface NeedsYouOptions {
  /** A console left out (the palette skips the one the user is looking at). */
  exclude?: string | null
}

function liveStatus(s: AttentionStatus | null | undefined): AttentionStatus | undefined {
  return s && s.state != null ? s : undefined
}

/** True when this console needs the user (the rule in the header). */
export function needsYou(item: AttentionItem): boolean {
  if (item.dormant) return false
  const s = liveStatus(item.status)
  if (s?.muted === true) return false
  return item.marked === true || !!s?.needs || needsUser(s) || waitsOnUser(s)
}

function rowOf<T extends AttentionItem>(item: T): NeedsYouRow<T> {
  const s = liveStatus(item.status)
  const own = agentRank(s?.state, s?.attention)
  const since = s ? (s.stateSince ?? s.updatedAt ?? 0) : 0
  const askedAt = s?.needs?.at
  const lifted = !!s?.needs && own !== 1
  return {
    id: item.paneId,
    rank: s?.needs ? 1 : own,
    unread: s?.attention === true || item.marked === true,
    stateSince: lifted && typeof askedAt === 'number' && Number.isFinite(askedAt) ? askedAt : since,
    item,
  }
}

/** The consoles that need the user, most urgent first (compareAgents). */
export function needsYouRows<T extends AttentionItem>(items: readonly T[], opts: NeedsYouOptions = {}): NeedsYouRow<T>[] {
  const out: NeedsYouRow<T>[] = []
  for (const item of items) if (item.paneId !== opts.exclude && needsYou(item)) out.push(rowOf(item))
  return out.sort(compareAgents)
}

/** How many consoles need the user: needsYouRows(items, opts).length without the sort. */
export function needsYouCount(items: readonly AttentionItem[], opts: NeedsYouOptions = {}): number {
  let n = 0
  for (const item of items) if (item.paneId !== opts.exclude && needsYou(item)) n++
  return n
}
