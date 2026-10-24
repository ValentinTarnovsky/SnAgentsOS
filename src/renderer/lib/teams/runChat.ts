/**
 * The chat of a team run (app 2.7.0, E10 B2): the run's log as a chat list
 * (the console chat's list rules, src/shared/chatRows.ts), read from main's
 * RunLog through `teams:req`, never through ChatHub (decision 49). Also the
 * list of an agent's runs the drawer's picker shows. Never persisted, and
 * nothing here ever writes to a pty.
 *
 *  - `runChatFirst(teamId, runId)` asks main to push this run's new lines
 *    (`watchRun`, one run at a time per window) and then reads its newest
 *    page (`runPage`). Lines pushed while that page is on its way wait and
 *    land after it (an id seen twice replaces its message).
 *  - "Load earlier" is `runPage` with the oldest offset, one at a time; its
 *    page goes in front, never past the memory cap.
 *  - `teams:runAppend` appends only to a run with an entry here (the one on
 *    screen); its state and last line time patch the run's header.
 *  - `runChatForget(runId)` drops the entry and, when it was the watched
 *    run, tells main to stop pushing (`watchRun null`).
 *  - RunLog's cut row comes in English (main keeps the text, like
 *    CHAT_SKIPPED_TEXT: RUN_LOG_CUT_TEXT of src/shared/teams.ts, the one
 *    string both sides use); `wordRunList` words it in the UI language for
 *    the view only, the store keeps what main sent.
 */
import { create } from 'zustand'
import type { ChatMessage } from '@shared/chat-types'
import type { RunView, TeamRunAppendEvt } from '@shared/team-protocol'
import { RUN_LOG_CUT_TEXT } from '@shared/teams'
import { EMPTY_LIST, appendList, prependList, replaceList, type ChatList } from '@/components/chat/chatModel'
import type { ChatScrollerState } from '@/components/chat/ChatScroller'
import { onRunAppend, onTeamChanged, teamReq, useTeamsStore } from '@/lib/teamsStore'

export interface RunChat extends ChatScrollerState {
  teamId: string
  /** The run as main last described it (the page's answer, then the pushed state). */
  run?: RunView
  /** Main still writes to this run's log. */
  live: boolean
}

export const EMPTY_RUN_CHAT: Omit<RunChat, 'teamId'> = { list: EMPTY_LIST, loading: null, failed: null, version: 0, live: false }

/** A system row of a run's chat the view words itself (the log cut), else null; the rest go to the chat's systemKey. */
export function runSystemKey(text: string): 'teams.run.chat.cut' | null {
  return text === RUN_LOG_CUT_TEXT ? 'teams.run.chat.cut' : null
}

/** The list with each cut row worded as `cut`; the same list when it has none (ChatScroller keeps its rows). */
export function wordRunList(list: ChatList, cut: string): ChatList {
  let items: ChatMessage[] | null = null
  for (let i = 0; i < list.items.length; i++) {
    const m = list.items[i]
    if (m.role !== 'system' || !runSystemKey(m.blocks.map((b) => (b.t === 'text' ? b.text : '')).join('\n'))) continue
    items ??= list.items.slice()
    items[i] = { ...m, blocks: [{ t: 'text', text: cut }] }
  }
  return items ? { ...list, items } : list
}

interface RunChatState {
  /** runId -> its chat, while a view reads it. */
  chats: Record<string, RunChat>
  /** `${teamId}/${agentId}` -> the agent's runs, newest first. */
  runs: Record<string, RunView[]>
}

const EMPTY: RunChatState = { chats: {}, runs: {} }

export const useRunChatStore = create<RunChatState>(() => ({ ...EMPTY }))

export function runsKey(teamId: string, agentId: string): string {
  return `${teamId}/${agentId}`
}

/** Per run, the newest first-page read; a page from an older read (or from before a forget) is dropped. */
const firstSeq = new Map<string, number>()
/** Per run, the "Load earlier" in flight; a first page drops it. */
const moreSeq = new Map<string, number>()
/** Per run, the lines pushed while its first page is on its way. */
const waiting = new Map<string, ChatMessage[]>()
/** Per agent, the newest runs pull. */
const runsSeq = new Map<string, number>()
/** The run main pushes lines of (one per window). */
let watched: { teamId: string; runId: string } | null = null
let counter = 0
let generation = 0

function chatOf(runId: string): RunChat | undefined {
  return useRunChatStore.getState().chats[runId]
}

function patchChat(runId: string, next: Partial<RunChat>): void {
  useRunChatStore.setState((s) => {
    const cur = s.chats[runId]
    if (!cur) return {}
    return { chats: { ...s.chats, [runId]: { ...cur, ...next } } }
  })
}

/** Starts reading one run (watch, then its newest page). Idempotent: a second call reads the first page again. */
export function runChatFirst(teamId: string, runId: string): void {
  const n = ++counter
  firstSeq.set(runId, n)
  moreSeq.delete(runId)
  waiting.set(runId, [])
  const gen = generation
  useRunChatStore.setState((s) => {
    const cur = s.chats[runId]
    const base: RunChat = cur && cur.teamId === teamId ? cur : { ...EMPTY_RUN_CHAT, teamId }
    return { chats: { ...s.chats, [runId]: { ...base, loading: 'first', failed: null } } }
  })
  if (watched?.runId !== runId) {
    watched = { teamId, runId }
    void teamReq({ op: 'watchRun', teamId, runId })
  }
  void (async () => {
    const res = await teamReq({ op: 'runPage', teamId, runId })
    if (gen !== generation || firstSeq.get(runId) !== n || !chatOf(runId)) return
    const pushed = waiting.get(runId) ?? []
    waiting.delete(runId)
    if (!res.ok) {
      patchChat(runId, { loading: null, failed: 'first' })
      return
    }
    let list = replaceList({ items: Array.isArray(res.items) ? res.items : [], cursor: res.cursor, done: res.done })
    if (pushed.length) list = appendList(list, pushed)
    const cur = chatOf(runId)
    patchChat(runId, { list, loading: null, failed: null, version: (cur?.version ?? 0) + 1, run: res.run, live: res.live === true })
  })()
}

/** "Load earlier": the page before the oldest message held. */
export function runChatMore(runId: string): void {
  const chat = chatOf(runId)
  if (!chat || chat.loading || !chat.list.cursor || chat.list.done || chat.list.capped) return
  if (!/^\d{1,15}$/.test(chat.list.cursor)) return
  const n = ++counter
  moreSeq.set(runId, n)
  const first = firstSeq.get(runId)
  const gen = generation
  const before = chat.list.cursor
  patchChat(runId, { loading: 'more', failed: null })
  void (async () => {
    const res = await teamReq({ op: 'runPage', teamId: chat.teamId, runId, before })
    if (gen !== generation || moreSeq.get(runId) !== n || firstSeq.get(runId) !== first) return
    moreSeq.delete(runId)
    const cur = chatOf(runId)
    if (!cur) return
    if (!res.ok) {
      patchChat(runId, { loading: null, failed: 'more' })
      return
    }
    patchChat(runId, {
      list: prependList(cur.list, { items: Array.isArray(res.items) ? res.items : [], cursor: res.cursor, done: res.done }),
      loading: null,
      failed: null,
      run: res.run,
      live: res.live === true,
    })
  })()
}

/** Stops reading one run: the entry goes, and main stops pushing when it was the watched run. */
export function runChatForget(runId: string): void {
  firstSeq.delete(runId)
  moreSeq.delete(runId)
  waiting.delete(runId)
  useRunChatStore.setState((s) => {
    if (!s.chats[runId]) return {}
    const chats = { ...s.chats }
    delete chats[runId]
    return { chats }
  })
  if (watched?.runId === runId) {
    const { teamId } = watched
    watched = null
    void teamReq({ op: 'watchRun', teamId, runId: null })
  }
}

/** The runs of one agent (newest first), for the drawer's picker; each held chat gets its newer view. */
export async function loadRuns(teamId: string, agentId: string): Promise<RunView[] | null> {
  const key = runsKey(teamId, agentId)
  const n = (runsSeq.get(key) ?? 0) + 1
  runsSeq.set(key, n)
  const gen = generation
  const res = await teamReq({ op: 'runs', teamId, agentId })
  if (gen !== generation || runsSeq.get(key) !== n) return useRunChatStore.getState().runs[key] ?? null
  if (!res.ok) return null
  const runs = Array.isArray(res.runs) ? res.runs : []
  useRunChatStore.setState((s) => {
    let chats = s.chats
    for (const r of runs) {
      const cur = chats[r.id]
      if (cur && cur.teamId === teamId) chats = { ...chats, [r.id]: { ...cur, run: r } }
    }
    return { runs: { ...s.runs, [key]: runs }, chats }
  })
  return runs
}

function onAppend(e: TeamRunAppendEvt): void {
  if (!e || typeof e.runId !== 'string') return
  const chat = chatOf(e.runId)
  if (!chat || chat.teamId !== e.teamId) return
  const items = Array.isArray(e.items) ? e.items : []
  const held = waiting.get(e.runId)
  if (held) held.push(...items)
  const run = chat.run
    ? { ...chat.run, ...(e.state ? { state: e.state } : {}), ...(typeof e.lastLineAt === 'number' ? { lastLineAt: e.lastLineAt } : {}) }
    : undefined
  patchChat(e.runId, { ...(held || items.length === 0 ? {} : { list: appendList(chat.list, items) }), ...(run ? { run } : {}) })
}

/**
 * The pushed lines of the watched run, and the drawer's runs list kept
 * current: a change of the agents or of a run of the team on screen pulls the
 * open agent's runs again (once per tick); `disabled` clears everything.
 */
export function initRunChatSync(): () => void {
  generation++
  const gen = generation
  let timer: ReturnType<typeof setTimeout> | null = null
  const offAppend = onRunAppend(onAppend)
  const offChanged = onTeamChanged((e) => {
    if (e.scopes.includes('disabled')) {
      watched = null
      useRunChatStore.setState({ ...EMPTY })
      return
    }
    if (!e.scopes.some((s) => s === 'agents' || s === 'run')) return
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      if (gen !== generation) return
      // Only the team on screen gets here (the core's refetch policy), and only its open drawer reads runs.
      const { drawer, openTeamId } = useTeamsStore.getState()
      if (drawer?.kind !== 'agent' || !openTeamId) return
      void loadRuns(openTeamId, drawer.agentId)
    }, 0)
  })
  return () => {
    offAppend()
    offChanged()
    if (timer) clearTimeout(timer)
    generation++
    watched = null
    firstSeq.clear()
    moreSeq.clear()
    waiting.clear()
    runsSeq.clear()
    useRunChatStore.setState({ ...EMPTY })
  }
}
