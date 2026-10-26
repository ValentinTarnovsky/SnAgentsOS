/**
 * The conversation with the Lead of a team (app 2.7.0, E10 B3): the thread
 * main keeps as `comments['lead']` (`lead`, the newest page; "Ver anteriores"
 * pages with `before`) and the user's messages (`leadSay`, a comment main
 * queues for the Lead's next run: nothing here starts a run, writes to a pty
 * or sends Enter anywhere). Main-authored lines come as `sys` and are worded
 * from `teams.sys.*`. Never persisted.
 */
import { create } from 'zustand'
import { isActiveRun } from '@shared/teams'
import type { CommentView, LeadView, TeamFail } from '@shared/team-protocol'
import { onTeamChanged, teamReq, useTeamsStore } from '@/lib/teamsStore'
import { useRosterStore } from './roster'

export interface LeadThread extends LeadView {
  loading: boolean
  failed: boolean
  /** Messages of the pages before the newest one, oldest first. */
  older: CommentView[]
  olderCursor: string | null | undefined
  olderLoading: boolean
  olderFailed: boolean
}

interface LeadState {
  /** teamId -> the thread as main last answered it. */
  threads: Record<string, LeadThread>
}

const EMPTY: LeadState = { threads: {} }

export const useLeadStore = create<LeadState>(() => ({ ...EMPTY }))

const BLANK: LeadThread = { messages: [], cursor: null, agent: null, loading: false, failed: false, older: [], olderCursor: undefined, olderLoading: false, olderFailed: false }

const seq = new Map<string, number>()
const olderSeq = new Map<string, number>()
let generation = 0

function patchThread(teamId: string, next: Partial<LeadThread>): void {
  useLeadStore.setState((s) => ({ threads: { ...s.threads, [teamId]: { ...(s.threads[teamId] ?? BLANK), ...next } } }))
}

/** The number of a comment id (`m-12` -> 12), for a stable order when two share a time. */
function idNum(id: string): number {
  const n = Number(id.slice(2))
  return Number.isFinite(n) ? n : 0
}

/** Every message of a thread, oldest first, once by id. */
export function threadMessages(th: LeadThread | undefined): CommentView[] {
  if (!th) return []
  const byId = new Map<string, CommentView>()
  for (const m of [...th.older, ...th.messages]) byId.set(m.id, m)
  return [...byId.values()].sort((a, b) => a.at - b.at || idNum(a.id) - idNum(b.id))
}

/**
 * Pulls the newest page of the thread, or with `older` the page before the
 * oldest message held. Null when it did not come.
 */
export async function loadLead(teamId: string, older?: boolean): Promise<LeadThread | null> {
  const gen = generation
  if (older) {
    const th = useLeadStore.getState().threads[teamId]
    const before = th?.older.length ? th.olderCursor : th?.cursor
    if (!th || th.olderLoading || !before) return th ?? null
    const n = (olderSeq.get(teamId) ?? 0) + 1
    olderSeq.set(teamId, n)
    patchThread(teamId, { olderLoading: true, olderFailed: false })
    const res = await teamReq({ op: 'lead', teamId, before })
    if (gen !== generation || olderSeq.get(teamId) !== n) return useLeadStore.getState().threads[teamId] ?? null
    if (!res.ok) {
      patchThread(teamId, { olderLoading: false, olderFailed: true })
      return null
    }
    const cur = useLeadStore.getState().threads[teamId] ?? BLANK
    const held = new Set([...cur.older, ...cur.messages].map((m) => m.id))
    const page = (Array.isArray(res.lead.messages) ? res.lead.messages : []).filter((m) => !held.has(m.id))
    patchThread(teamId, { older: [...page, ...cur.older], olderCursor: res.lead.cursor, olderLoading: false })
    return useLeadStore.getState().threads[teamId] ?? null
  }
  const n = (seq.get(teamId) ?? 0) + 1
  seq.set(teamId, n)
  patchThread(teamId, { loading: true })
  const res = await teamReq({ op: 'lead', teamId })
  if (gen !== generation || seq.get(teamId) !== n) return useLeadStore.getState().threads[teamId] ?? null
  if (!res.ok) {
    patchThread(teamId, { loading: false, failed: true })
    return null
  }
  const messages = Array.isArray(res.lead.messages) ? res.lead.messages : []
  const ids = new Set(messages.map((m) => m.id))
  // Earlier pages loaded before stay, minus what the newest page now holds.
  const kept = (useLeadStore.getState().threads[teamId]?.older ?? []).filter((m) => !ids.has(m.id))
  patchThread(teamId, {
    messages,
    cursor: res.lead.cursor,
    agent: res.lead.agent ?? null,
    loading: false,
    failed: false,
    older: kept,
    ...(kept.length === 0 ? { olderCursor: undefined } : {}),
  })
  return useLeadStore.getState().threads[teamId] ?? null
}

/** A message for the Lead: main stores it in the thread for its next run. Null once main took it. */
export async function sayToLead(teamId: string, text: string): Promise<TeamFail | null> {
  const res = await teamReq({ op: 'leadSay', teamId, text })
  if (!res.ok) return res
  const th = useLeadStore.getState().threads[teamId] ?? BLANK
  if (!th.messages.some((m) => m.id === res.comment.id)) patchThread(teamId, { messages: [...th.messages, res.comment] })
  return null
}

/** Folds the scopes of one `teams:changed` (the core hands them over one by one) into one pull. */
const SCOPE_FOLD_MS = 16

/**
 * Keeps a loaded thread current while the lab is on: a `lead` change of the
 * team on screen pulls it again, and so does a run change while a message
 * waits for the Lead or the Lead runs (delivery, its reply at the end of the
 * run); `disabled` clears everything. Whether the Lead is working comes from
 * the roster, which follows every run change already.
 */
export function initLeadSync(): () => void {
  generation++
  const gen = generation
  const due = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  const off = onTeamChanged((e) => {
    if (e.scopes.includes('disabled')) {
      useLeadStore.setState({ ...EMPTY })
      return
    }
    const th = useLeadStore.getState().threads[e.teamId]
    if (e.teamId !== useTeamsStore.getState().openTeamId || !th) return
    // A run change matters while a message waits for the Lead (its delivery) or the Lead runs (its reply at the end).
    const lead = useRosterStore.getState().rosters[e.teamId]?.agents.find((a) => a.kind === 'lead')
    const watching = threadMessages(th).some((m) => m.queued) || !!(lead?.run && isActiveRun(lead.run.state))
    if (!e.scopes.includes('lead') && !(watching && e.scopes.includes('run'))) return
    due.add(e.teamId)
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      if (gen !== generation) return
      const ids = [...due]
      due.clear()
      for (const id of ids) void loadLead(id)
    }, SCOPE_FOLD_MS)
  })
  return () => {
    off()
    if (timer) clearTimeout(timer)
    generation++
    seq.clear()
    olderSeq.clear()
    useLeadStore.setState({ ...EMPTY })
  }
}
