/**
 * The Tablero of a team (app 2.7.0, E10 B3): the board page main answers
 * (`board`: every non-done task plus the newest done, older done pages with
 * "Ver más"), the task the drawer shows (`task`, with "Ver anteriores" for its
 * comments) and the user's writes: drag and "Mover a" (`moveTask`, or
 * `updateTask {priority}` for a band inside the same column), field edits
 * (`updateTask` with the task's `rev` as `baseRev`), comments, "Soltar
 * fijado" (`releaseOwned`), Retomar of a stopped task (`resumeTask`, B4)
 * and new tasks (`createTask`). Main owns every
 * state and marks each field a user write touches `userOwned`; this store
 * only mirrors its answers. A move shows at once (optimistic) and the reply's
 * task replaces it; a refusal rolls it back. Never persisted.
 */
import { create } from 'zustand'
import type { BoardColumn, TaskField, TaskPriority } from '@shared/teams'
import type { CommentView, TaskDetail, TaskDraft, TaskPatch, TaskSummary, TeamFail } from '@shared/team-protocol'
import { dropVerdict, type BoardFilter } from '@shared/teamBoard'
import { onTeamChanged, openTaskDrawer, teamReq, useTeamsStore } from '@/lib/teamsStore'

export interface TeamBoardData {
  rev: number
  /** The first page: every live task that is not done, plus the newest done ones. */
  first: TaskSummary[]
  /** Older done tasks loaded with "Ver más" (kept across reloads of the first page). */
  olderDone: TaskSummary[]
  doneCursor: string | null
  doneComplete: boolean
  counts: Record<BoardColumn, number>
  cancelled: number
}

export interface TaskEntry {
  detail?: TaskDetail
  loading: boolean
  failed: boolean
  /** Comments of the pages before the detail's own ("Ver anteriores"), oldest first. */
  older: CommentView[]
  olderCursor: string | null | undefined
  olderLoading: boolean
  olderFailed: boolean
}

/** What a move shows before main answers. */
export type OptimisticTask = Partial<Pick<TaskSummary, 'state' | 'phase' | 'priority' | 'column'>>

export interface NewTaskState {
  teamId: string
  busy: boolean
  error?: TeamFail
}

interface BoardState {
  pages: Record<string, TeamBoardData>
  failed: Record<string, true>
  moreLoading: Record<string, true>
  /** `${teamId}/${taskId}` -> the drawer's task. */
  tasks: Record<string, TaskEntry>
  /** `${teamId}/${taskId}` -> a move on its way to main. */
  optimistic: Record<string, OptimisticTask>
  filter: Record<string, BoardFilter>
  newTask: NewTaskState | null
}

const EMPTY: BoardState = { pages: {}, failed: {}, moreLoading: {}, tasks: {}, optimistic: {}, filter: {}, newTask: null }

export const useBoardStore = create<BoardState>(() => ({ ...EMPTY }))

export function taskKey(teamId: string, taskId: string): string {
  return `${teamId}/${taskId}`
}

/** Every task of a loaded board, once by id (the first page wins over an older done page). */
export function boardTasks(data: TeamBoardData | undefined): TaskSummary[] {
  if (!data) return []
  if (data.olderDone.length === 0) return data.first
  const ids = new Set(data.first.map((x) => x.id))
  return [...data.first, ...data.olderDone.filter((x) => !ids.has(x.id))]
}

/** The tasks with the moves on their way applied (same objects when nothing is pending: TaskCard is memoized). */
export function withOptimistic(teamId: string, tasks: TaskSummary[], optimistic: Record<string, OptimisticTask>): TaskSummary[] {
  const prefix = `${teamId}/`
  if (!Object.keys(optimistic).some((k) => k.startsWith(prefix))) return tasks
  return tasks.map((x) => {
    const o = optimistic[prefix + x.id]
    return o ? { ...x, ...o } : x
  })
}

/** The task as main last described it (the board page), for baseRev and the drawer title. */
export function summaryOf(teamId: string, taskId: string): TaskSummary | undefined {
  const data = useBoardStore.getState().pages[teamId]
  return data?.first.find((x) => x.id === taskId) ?? data?.olderDone.find((x) => x.id === taskId)
}

/**
 * The agent "Ejecutar ahora" runs a task with: the one main's runManual takes
 * for the task's phase (app 2.7.0, E10 B4). Its assignee in Por hacer, in
 * planning and in executing; its QA agent in qa (`reviewInfo.qaAgentId`, so
 * a card knows it once its detail was loaded). Undefined where main would
 * answer `conflict`: a task blocked (a stopped one has Retomar in its drawer),
 * done or cancelled, or in a phase that waits on the user or on integrating.
 */
export function runNowAgentOf(task: Pick<TaskSummary, 'state' | 'phase' | 'assignee'>, qaAgentId?: string): string | undefined {
  if (task.state === 'done' || task.state === 'cancelled' || task.state === 'blocked') return undefined
  if (task.state === 'todo' || task.phase === 'planning' || task.phase === 'executing') return task.assignee
  return task.phase === 'qa' ? qaAgentId : undefined
}

/** The QA agent of a task as its loaded detail names it (TaskSummary does not carry it). */
export function qaAgentOf(teamId: string, taskId: string): string | undefined {
  return useBoardStore.getState().tasks[taskKey(teamId, taskId)]?.detail?.reviewInfo.qaAgentId
}

/** Fields of TaskDetail that a TaskSummary does not have. */
const DETAIL_ONLY = ['body', 'plan', 'reviewInfo', 'worktree', 'commentsCursor', 'commentsArchived', 'runs', 'approvals', 'cards', 'grants', 'integrate', 'integratedInfo', 'truncated'] as const

/**
 * The summary of a detail (the board card of a task main answered in full),
 * with the card's comment count: main counts every comment of the task in
 * `TaskSummary.comments`, the detail holds only the newest page of them.
 */
export function summaryFromDetail(d: TaskDetail, comments: number): TaskSummary {
  const out: Record<string, unknown> = { ...d, comments }
  for (const k of DETAIL_ONLY) delete out[k]
  return out as unknown as TaskSummary
}

/** Every comment of a detail that holds them all (no older page left in the runtime): its page plus the archived ones. */
function allCommentsOf(d: TaskDetail): number | null {
  return d.commentsCursor === null && Array.isArray(d.comments) ? d.comments.length + (d.commentsArchived ?? 0) : null
}

// ---- sequences (an older answer that lands late is dropped) -----------------------------------------------

const boardSeq = new Map<string, number>()
const taskSeq = new Map<string, number>()
const olderSeq = new Map<string, number>()
let generation = 0

function patchEntry(key: string, next: Partial<TaskEntry>): void {
  useBoardStore.setState((s) => {
    const cur = s.tasks[key] ?? { loading: false, failed: false, older: [], olderCursor: undefined, olderLoading: false, olderFailed: false }
    return { tasks: { ...s.tasks, [key]: { ...cur, ...next } } }
  })
}

/** Puts one task as main answered it in the board (a new one goes in the first page). */
function applySummary(teamId: string, task: TaskSummary): void {
  useBoardStore.setState((s) => {
    const data = s.pages[teamId]
    if (!data) return {}
    const inFirst = data.first.some((x) => x.id === task.id)
    const inOlder = data.olderDone.some((x) => x.id === task.id)
    const first = inFirst ? data.first.map((x) => (x.id === task.id ? task : x)) : inOlder ? data.first : [...data.first, task]
    const olderDone = inOlder ? data.olderDone.map((x) => (x.id === task.id ? task : x)) : data.olderDone
    return { pages: { ...s.pages, [teamId]: { ...data, first, olderDone } } }
  })
}

function applyDetail(teamId: string, detail: TaskDetail): void {
  patchEntry(taskKey(teamId, detail.id), { detail, loading: false, failed: false })
  // The card keeps the count main gave it (the next board page brings a new one); a task with no card yet joins
  // the board only when its detail holds every comment, else its count would be the page's.
  const comments = summaryOf(teamId, detail.id)?.comments ?? allCommentsOf(detail)
  if (comments !== null) applySummary(teamId, summaryFromDetail(detail, comments))
}

function setOptimistic(key: string, o: OptimisticTask | null): void {
  useBoardStore.setState((s) => {
    if (!o) {
      if (!s.optimistic[key]) return {}
      const optimistic = { ...s.optimistic }
      delete optimistic[key]
      return { optimistic }
    }
    return { optimistic: { ...s.optimistic, [key]: o } }
  })
}

/** A refusal that carries the task as main has it now (`conflict {current}`): the board and the drawer show it. */
function applyFailure(teamId: string, fail: TeamFail): void {
  if (fail.error === 'conflict' && fail.current && typeof fail.current === 'object' && typeof fail.current.id === 'string') applyDetail(teamId, fail.current)
}

// ---- reads ------------------------------------------------------------------------------------------------

/** Pulls the first page of a board (older done pages already loaded stay). Null when it did not come. */
export async function loadBoard(teamId: string): Promise<TeamBoardData | null> {
  const n = (boardSeq.get(teamId) ?? 0) + 1
  boardSeq.set(teamId, n)
  const gen = generation
  const res = await teamReq({ op: 'board', teamId })
  if (gen !== generation || boardSeq.get(teamId) !== n) return useBoardStore.getState().pages[teamId] ?? null
  if (!res.ok) {
    useBoardStore.setState((s) => ({ failed: { ...s.failed, [teamId]: true } }))
    return null
  }
  const page = res.page
  const first = Array.isArray(page.tasks) ? page.tasks : []
  let data: TeamBoardData | null = null
  useBoardStore.setState((s) => {
    const prev = s.pages[teamId]
    const ids = new Set(first.map((x) => x.id))
    // A task that leaves Hecho is a live one, so the first page has it: the older pages stay valid. A newly done task
    // pushes the oldest done one out of the first page; with older pages held it joins them (newer than all of them,
    // so the held cursor still follows), else the new page's cursor reaches it.
    const held = prev?.olderDone ?? []
    const pushed = held.length > 0 ? (prev?.first ?? []).filter((x) => x.state === 'done' && !ids.has(x.id)) : []
    const olderDone = [...pushed, ...held].filter((x) => !ids.has(x.id))
    const keep = olderDone.length > 0 ? prev : undefined
    data = {
      rev: page.rev,
      first,
      olderDone,
      doneCursor: keep ? keep.doneCursor : page.cursor,
      doneComplete: keep ? keep.doneComplete : page.cursor === null || page.done === true,
      counts: page.counts,
      cancelled: typeof page.cancelled === 'number' ? page.cancelled : 0,
    }
    const failed = { ...s.failed }
    delete failed[teamId]
    return { pages: { ...s.pages, [teamId]: data }, failed }
  })
  return data
}

/** "Ver más" of Hecho: the done page after the oldest one held. */
export async function loadMoreDone(teamId: string): Promise<TeamFail | null> {
  const s = useBoardStore.getState()
  const data = s.pages[teamId]
  if (!data || data.doneComplete || !data.doneCursor || s.moreLoading[teamId]) return null
  const gen = generation
  useBoardStore.setState((st) => ({ moreLoading: { ...st.moreLoading, [teamId]: true } }))
  const res = await teamReq({ op: 'board', teamId, column: 'done', cursor: data.doneCursor })
  if (gen !== generation) return null
  useBoardStore.setState((st) => {
    const moreLoading = { ...st.moreLoading }
    delete moreLoading[teamId]
    const cur = st.pages[teamId]
    // A reload of the first page meanwhile keeps the older pages, so this one still joins them (by id once).
    if (!res.ok || !cur) return { moreLoading }
    const held = new Set([...cur.first, ...cur.olderDone].map((x) => x.id))
    const more = (Array.isArray(res.page.tasks) ? res.page.tasks : []).filter((x) => !held.has(x.id))
    return {
      moreLoading,
      pages: { ...st.pages, [teamId]: { ...cur, olderDone: [...cur.olderDone, ...more], doneCursor: res.page.cursor, doneComplete: res.page.cursor === null || res.page.done === true } },
    }
  })
  return res.ok ? null : res
}

/** Pulls one task in full for the drawer. Null when it did not come (the entry keeps what it had). */
export async function loadTask(teamId: string, taskId: string): Promise<TaskDetail | null> {
  const key = taskKey(teamId, taskId)
  const n = (taskSeq.get(key) ?? 0) + 1
  taskSeq.set(key, n)
  const gen = generation
  patchEntry(key, { loading: true })
  const res = await teamReq({ op: 'task', teamId, taskId })
  if (gen !== generation || taskSeq.get(key) !== n) return useBoardStore.getState().tasks[key]?.detail ?? null
  if (!res.ok) {
    patchEntry(key, { loading: false, failed: true, ...(res.error === 'not_found' ? { detail: undefined } : {}) })
    return null
  }
  const detail = res.task
  // Earlier pages loaded before stay, minus what the newest page now holds.
  const ids = new Set(detail.comments.map((c) => c.id))
  const older = (useBoardStore.getState().tasks[key]?.older ?? []).filter((c) => !ids.has(c.id))
  patchEntry(key, { older, ...(older.length === 0 ? { olderCursor: undefined } : {}) })
  applyDetail(teamId, detail)
  return detail
}

/** "Ver anteriores": the comments before the oldest one held. */
export async function loadOlderComments(teamId: string, taskId: string): Promise<void> {
  const key = taskKey(teamId, taskId)
  const entry = useBoardStore.getState().tasks[key]
  const cursor = entry?.older.length ? entry.olderCursor : entry?.detail?.commentsCursor
  if (!entry || entry.olderLoading || !cursor) return
  const n = (olderSeq.get(key) ?? 0) + 1
  olderSeq.set(key, n)
  const gen = generation
  patchEntry(key, { olderLoading: true, olderFailed: false })
  const res = await teamReq({ op: 'task', teamId, taskId, commentsBefore: cursor })
  if (gen !== generation || olderSeq.get(key) !== n) return
  if (!res.ok) {
    patchEntry(key, { olderLoading: false, olderFailed: true })
    return
  }
  const cur = useBoardStore.getState().tasks[key]
  const held = new Set([...(cur?.older ?? []), ...(cur?.detail?.comments ?? [])].map((c) => c.id))
  const page = res.task.comments.filter((c) => !held.has(c.id))
  patchEntry(key, { older: [...page, ...(cur?.older ?? [])], olderCursor: res.task.commentsCursor, olderLoading: false })
}

// ---- writes -----------------------------------------------------------------------------------------------

function refusal(detail: string): TeamFail {
  return { ok: false, error: 'bad_request', detail }
}

/**
 * Drag or "Mover a": what the drop means (dropVerdict) goes to main. Another
 * column is `moveTask` (main stops the task's run first only with `stopRun`,
 * else it answers `running`); a band inside the same column is
 * `updateTask {priority}`. Optimistic: the card moves now, the reply's task
 * replaces it, a refusal puts it back. Null once main applied it.
 */
export async function moveTask(teamId: string, task: TaskSummary, to: BoardColumn, band?: TaskPriority, stopRun?: boolean): Promise<TeamFail | null> {
  const v = dropVerdict(task, to, band)
  if (!v.ok) return refusal(v.reason)
  const base = summaryOf(teamId, task.id) ?? task
  const key = taskKey(teamId, task.id)
  const target = v.patch.to
  setOptimistic(key, {
    ...(target ? { state: target, column: target, phase: target === 'blocked' ? base.phase : 'none' } : {}),
    ...(v.patch.priority ? { priority: v.patch.priority } : {}),
  })
  if (target) {
    const res = await teamReq({
      op: 'moveTask',
      teamId,
      taskId: task.id,
      baseRev: base.rev,
      to: target,
      ...(v.patch.priority ? { priority: v.patch.priority } : {}),
      ...(stopRun ? { stopRun: true } : {}),
    })
    setOptimistic(key, null)
    if (!res.ok) {
      applyFailure(teamId, res)
      return res
    }
    applySummary(teamId, res.task)
    refreshOpenTask(teamId, task.id)
    return null
  }
  const res = await teamReq({ op: 'updateTask', teamId, taskId: task.id, baseRev: base.rev, patch: { priority: v.patch.priority } })
  setOptimistic(key, null)
  if (!res.ok) {
    applyFailure(teamId, res)
    return res
  }
  applyDetail(teamId, res.task)
  return null
}

/** "Cancelar tarea" (after its confirm): the task leaves the board; with a live run main stops it first. */
export async function cancelTask(teamId: string, task: TaskSummary, stopRun: boolean): Promise<TeamFail | null> {
  const base = summaryOf(teamId, task.id) ?? task
  const key = taskKey(teamId, task.id)
  setOptimistic(key, { state: 'cancelled', phase: 'none', column: null })
  const res = await teamReq({ op: 'moveTask', teamId, taskId: task.id, baseRev: base.rev, to: 'cancelled', ...(stopRun ? { stopRun: true } : {}) })
  setOptimistic(key, null)
  if (!res.ok) {
    applyFailure(teamId, res)
    return res
  }
  applySummary(teamId, res.task)
  refreshOpenTask(teamId, task.id)
  return null
}

/** A field edit of the drawer with the task's rev. `conflict` brings the current task (the drawer keeps the draft). */
export async function saveTask(teamId: string, taskId: string, baseRev: number, patch: TaskPatch): Promise<TeamFail | null> {
  const res = await teamReq({ op: 'updateTask', teamId, taskId, baseRev, patch })
  if (!res.ok) {
    applyFailure(teamId, res)
    return res
  }
  applyDetail(teamId, res.task)
  return null
}

/** "Soltar fijado": main hands the fields back to the Lead. */
export async function releaseOwned(teamId: string, taskId: string, fields: TaskField[]): Promise<TeamFail | null> {
  if (fields.length === 0) return null
  const res = await teamReq({ op: 'releaseOwned', teamId, taskId, fields })
  if (!res.ok) return res
  applySummary(teamId, res.task)
  refreshOpenTask(teamId, taskId)
  return null
}

/**
 * Retomar of a task the user stopped (decision 38, `resumeTask`): main puts it
 * back in the pair it was stopped in (T17) with a retry for the agent of that
 * phase; a task that is no longer stopped answers `conflict` and the drawer
 * reads it again, so it shows how the task is now. Null once main applied it.
 */
export async function resumeTask(teamId: string, taskId: string): Promise<TeamFail | null> {
  const res = await teamReq({ op: 'resumeTask', teamId, taskId })
  if (!res.ok) {
    applyFailure(teamId, res)
    if (res.error === 'conflict' && !res.current) refreshOpenTask(teamId, taskId)
    return res
  }
  applySummary(teamId, res.task)
  refreshOpenTask(teamId, taskId)
  return null
}

/** A user comment on a task: main picks its recipient (queued until their next run). */
export async function addComment(teamId: string, taskId: string, text: string): Promise<TeamFail | null> {
  const res = await teamReq({ op: 'comment', teamId, taskId, text })
  if (!res.ok) return res
  const key = taskKey(teamId, taskId)
  const entry = useBoardStore.getState().tasks[key]
  if (entry?.detail && !entry.detail.comments.some((c) => c.id === res.comment.id)) {
    patchEntry(key, { detail: { ...entry.detail, comments: [...entry.detail.comments, res.comment] } })
  }
  const sum = summaryOf(teamId, taskId)
  if (sum) applySummary(teamId, { ...sum, comments: sum.comments + 1, queued: sum.queued + (res.comment.queued ? 1 : 0) })
  return null
}

/** The open drawer's task, read again after a write that answered only its summary. */
function refreshOpenTask(teamId: string, taskId: string): void {
  const s = useTeamsStore.getState()
  if (s.openTeamId === teamId && s.drawer?.kind === 'task' && s.drawer.taskId === taskId) void loadTask(teamId, taskId)
}

export function setBoardFilter(teamId: string, patch: BoardFilter): void {
  useBoardStore.setState((s) => ({ filter: { ...s.filter, [teamId]: { ...(s.filter[teamId] ?? {}), ...patch } } }))
}

// ---- new task -------------------------------------------------------------------------------------------

/** "Nueva tarea" (header, palette, empty board): the dialog over the team. */
export function openNewTask(teamId: string): void {
  useBoardStore.setState({ newTask: { teamId, busy: false } })
}

export function closeNewTask(): void {
  if (useBoardStore.getState().newTask) useBoardStore.setState({ newTask: null })
}

/**
 * Creates a task with what the user filled (main marks those fields userOwned,
 * so the dialog sends only the fields the user touched). The id once created
 * (the drawer opens on it); else null and the dialog shows `newTask.error`.
 */
export async function createTask(teamId: string, draft: TaskDraft): Promise<string | null> {
  useBoardStore.setState((s) => (s.newTask?.teamId === teamId ? { newTask: { teamId, busy: true } } : {}))
  const res = await teamReq({ op: 'createTask', teamId, task: draft })
  if (!res.ok) {
    useBoardStore.setState((s) => (s.newTask?.teamId === teamId ? { newTask: { teamId, busy: false, error: res } } : {}))
    return null
  }
  applySummary(teamId, res.task)
  useBoardStore.setState((s) => (s.newTask?.teamId === teamId ? { newTask: null } : {}))
  if (useTeamsStore.getState().openTeamId === teamId) openTaskDrawer(res.task.id)
  return res.task.id
}

// ---- sync ---------------------------------------------------------------------------------------------------

/** One `teams:changed` hands its scopes over one by one (the core's debounce): a pull waits this long to fold them. */
const SCOPE_FOLD_MS = 16

/**
 * Keeps the board and the drawer's task current while the lab is on: a
 * `board` change of the team on screen pulls its board again while the
 * Tablero shows (a run start or end too while a card shows a live run); a
 * `task` change of the drawer's task, or a run change while it is open, pulls
 * that task; `disabled` clears everything.
 */
export function initBoardSync(): () => void {
  generation++
  const gen = generation
  const boards = new Set<string>()
  const tasks = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  const off = onTeamChanged((e) => {
    if (e.scopes.includes('disabled')) {
      useBoardStore.setState({ ...EMPTY })
      return
    }
    const { openTeamId, tab, drawer } = useTeamsStore.getState()
    if (e.teamId !== openTeamId) return
    const st = useBoardStore.getState()
    const data = st.pages[e.teamId]
    if (data && tab === 'board') {
      const liveCard = e.scopes.includes('run') && boardTasks(data).some((x) => x.run)
      if (e.scopes.includes('board') || liveCard) boards.add(e.teamId)
    }
    if (drawer?.kind === 'task' && st.tasks[taskKey(e.teamId, drawer.taskId)]) {
      if ((e.scopes.includes('task') && e.taskId === drawer.taskId) || e.scopes.includes('run')) tasks.add(taskKey(e.teamId, drawer.taskId))
    }
    if ((boards.size === 0 && tasks.size === 0) || timer) return
    timer = setTimeout(() => {
      timer = null
      if (gen !== generation) return
      const b = [...boards]
      const k = [...tasks]
      boards.clear()
      tasks.clear()
      for (const id of b) void loadBoard(id)
      for (const key of k) {
        const i = key.indexOf('/')
        void loadTask(key.slice(0, i), key.slice(i + 1))
      }
    }, SCOPE_FOLD_MS)
  })
  return () => {
    off()
    if (timer) clearTimeout(timer)
    generation++
    boardSeq.clear()
    taskSeq.clear()
    olderSeq.clear()
    useBoardStore.setState({ ...EMPTY })
  }
}
