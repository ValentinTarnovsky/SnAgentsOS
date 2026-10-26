/**
 * Routines, team notes and run silence of a team (app 2.7.0, E10 B7): the
 * routines main reads from the trusted definition (`routines`, read only: they
 * are edited in the repo's `routines/<id>.md` and a change goes through
 * trust), "Correr ahora" (`routineRun`: main applies every gate but the
 * autonomy one and answers `deferred` with its reason), the notes the Lead
 * writes with `snaos team note` (`notes`, `note`: the daily summary among
 * them, never the workspace notes) and "Ignorar el silencio de esta corrida"
 * (`runSilenceAck`: main ignores the rest of that run's silence; the chip goes
 * at once). Nothing here starts a console, writes to a pty or sends Enter
 * anywhere. Main owns every state; this store keeps the last answer per team
 * and refetches through onTeamChanged (the core's policy: only the team on
 * screen). Never persisted.
 */
import { create } from 'zustand'
import type { Language, PaneSilence } from '@shared/types'
import type { RoutineView, RunView, TeamError, TeamFail, TeamReply } from '@shared/team-protocol'
import type { WsNoteMeta } from '@shared/ws-notes'
import { onTeamChanged, teamReq, useTeamsStore } from '@/lib/teamsStore'
import type { MessageKey, TFn } from '@/i18n'
import { deferText, loadRoster } from './roster'

/** One note as main answered it (`note`). */
export interface TeamNoteDoc {
  title: string
  text: string
  updatedAt: number
}

export interface NoteEntry {
  doc?: TeamNoteDoc
  loading: boolean
  /** The last pull did not come; `not_found` when main no longer has the note. */
  failed?: TeamError
}

export interface RoutinesState {
  /** teamId -> the routines main last answered, in the definition's order. */
  routines: Record<string, RoutineView[]>
  /** Teams whose last routines pull did not come (the panel offers Retry). */
  routinesFailed: Record<string, true>
  /** teamId -> the team notes main last answered. */
  notes: Record<string, WsNoteMeta[]>
  notesFailed: Record<string, true>
  /** noteKey(teamId, noteId) -> one note, for the drawer. */
  docs: Record<string, NoteEntry>
  /** routineKey(teamId, routineId) -> a "Correr ahora" on its way to main (its button waits). */
  busy: Record<string, true>
  /** runId -> its silence was ignored here: the chip goes before main's next view says so. */
  acked: Record<string, true>
}

const EMPTY: RoutinesState = { routines: {}, routinesFailed: {}, notes: {}, notesFailed: {}, docs: {}, busy: {}, acked: {} }

export const useRoutinesStore = create<RoutinesState>(() => ({ ...EMPTY }))

export function routineKey(teamId: string, routineId: string): string {
  return `${teamId}/${routineId}`
}

export function noteKey(teamId: string, noteId: string): string {
  return `${teamId}/${noteId}`
}

/** Per team (or note), the newest pull: an older answer that lands late is dropped. */
const routinesSeq = new Map<string, number>()
const notesSeq = new Map<string, number>()
const docSeq = new Map<string, number>()
/** Bumped by every initRoutinesSync and its teardown: an answer from an older life is dropped. */
let generation = 0

function without<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map
  const next = { ...map }
  delete next[key]
  return next
}

function bump(seqs: Map<string, number>, key: string): number {
  const n = (seqs.get(key) ?? 0) + 1
  seqs.set(key, n)
  return n
}

/** Pulls one team's routines. Null when they did not come (the store keeps the last answer it had). */
export async function loadRoutines(teamId: string): Promise<RoutineView[] | null> {
  const n = bump(routinesSeq, teamId)
  const gen = generation
  const res = await teamReq({ op: 'routines', teamId })
  if (gen !== generation || routinesSeq.get(teamId) !== n) return useRoutinesStore.getState().routines[teamId] ?? null
  if (!res.ok) {
    useRoutinesStore.setState((s) => ({ routinesFailed: { ...s.routinesFailed, [teamId]: true } }))
    return null
  }
  const list = Array.isArray(res.routines) ? res.routines : []
  useRoutinesStore.setState((s) => ({ routines: { ...s.routines, [teamId]: list }, routinesFailed: without(s.routinesFailed, teamId) }))
  return list
}

/**
 * "Correr ahora": main fires the routine now as its schedule would (a wake of
 * its role's agent, or a task for it) and answers with the run or the task it
 * made, always one of them. Every gate but the autonomy one applies: a run
 * that cannot start now answers `deferred` with its reason (a CLI that is off
 * is `cliOff`). The routine's button waits while the request is on its way.
 */
export async function runRoutine(teamId: string, routineId: string): Promise<TeamReply<'routineRun'>> {
  const key = routineKey(teamId, routineId)
  useRoutinesStore.setState((s) => ({ busy: { ...s.busy, [key]: true } }))
  const res = await teamReq({ op: 'routineRun', teamId, routineId })
  useRoutinesStore.setState((s) => ({ busy: without(s.busy, key) }))
  if (res.ok) {
    void loadRoutines(teamId)
    if (res.runId) void loadRoster(teamId)
  }
  return res
}

/** Pulls one team's notes (newest first is the panel's order). Null when they did not come. */
export async function loadNotes(teamId: string): Promise<WsNoteMeta[] | null> {
  const n = bump(notesSeq, teamId)
  const gen = generation
  const res = await teamReq({ op: 'notes', teamId })
  if (gen !== generation || notesSeq.get(teamId) !== n) return useRoutinesStore.getState().notes[teamId] ?? null
  if (!res.ok) {
    useRoutinesStore.setState((s) => ({ notesFailed: { ...s.notesFailed, [teamId]: true } }))
    return null
  }
  const list = Array.isArray(res.notes) ? res.notes : []
  useRoutinesStore.setState((s) => ({ notes: { ...s.notes, [teamId]: list }, notesFailed: without(s.notesFailed, teamId) }))
  return list
}

/** Pulls one note for the drawer. Null when it did not come (the entry says why). */
export async function loadNote(teamId: string, noteId: string): Promise<TeamNoteDoc | null> {
  const key = noteKey(teamId, noteId)
  const n = bump(docSeq, key)
  const gen = generation
  useRoutinesStore.setState((s) => ({ docs: { ...s.docs, [key]: { doc: s.docs[key]?.doc, loading: true } } }))
  const res = await teamReq({ op: 'note', teamId, noteId })
  if (gen !== generation || docSeq.get(key) !== n) return useRoutinesStore.getState().docs[key]?.doc ?? null
  if (!res.ok) {
    useRoutinesStore.setState((s) => ({ docs: { ...s.docs, [key]: { ...(s.docs[key] ?? {}), loading: false, failed: res.error } } }))
    return null
  }
  const doc: TeamNoteDoc = {
    title: typeof res.title === 'string' ? res.title : '',
    text: typeof res.text === 'string' ? res.text : '',
    updatedAt: typeof res.updatedAt === 'number' ? res.updatedAt : 0,
  }
  useRoutinesStore.setState((s) => ({ docs: { ...s.docs, [key]: { doc, loading: false } } }))
  return doc
}

/** A note of the open team in the drawer (TeamNoteDrawer, over any tab). */
export function openTeamNote(noteId: string): void {
  useTeamsStore.setState({ drawer: { kind: 'note', noteId } })
}

/**
 * "Ignorar el silencio de esta corrida": main ignores the rest of that run's
 * silence (no chip, no stalled card from it). The chip goes at once; a refusal
 * brings it back. Null once main took it.
 */
export async function ackRunSilence(teamId: string, runId: string): Promise<TeamFail | null> {
  useRoutinesStore.setState((s) => ({ acked: { ...s.acked, [runId]: true } }))
  const res = await teamReq({ op: 'runSilenceAck', teamId, runId })
  if (!res.ok) {
    useRoutinesStore.setState((s) => ({ acked: without(s.acked, runId) }))
    return res
  }
  void loadRoster(teamId)
  return null
}

/** The silence a run's chip shows: main's, unless the user ignored it here. */
export function useRunSilence(run: Pick<RunView, 'id' | 'silence'> | undefined): PaneSilence | undefined {
  const acked = useRoutinesStore((s) => (run ? !!s.acked[run.id] : false))
  return run && !acked ? run.silence : undefined
}

// ---- words (pure over the values handed in) ----------------------------------------------------------

const FAIL_KEY: Partial<Record<TeamError, MessageKey>> = {
  untrusted: 'teams.routine.fail.untrusted',
  // Main's coalesce rule: the routine's previous fire still has its run, its wake (maybe in Por despachar) or its task pending.
  busy: 'teams.routine.fail.busy',
  // The routine's agent has a run of its own (or is still stopping one).
  running: 'teams.routine.fail.running',
  stopping: 'teams.routine.fail.running',
  not_found: 'teams.routine.fail.not_found',
  cap: 'teams.routine.fail.cap',
  disabled: 'teams.routine.fail.disabled',
  unsupported: 'teams.routine.fail.unsupported',
}

/**
 * What a refused "Correr ahora" says: the defer reason (with its time), or the failure in the catalog's words (never
 * main's detail). A CLI that is off comes back as `deferred` {cliOff}: it says how to turn it on, not "Ahora no".
 */
export function routineFailText(f: TeamFail, t: TFn, lang: Language, now: number): string {
  if (f.error === 'deferred' && f.defer?.reason === 'cliOff') return t('teams.routine.fail.cli_off')
  if (f.error === 'deferred' && f.defer) return deferText(f.defer, t, lang, now)
  const key = FAIL_KEY[f.error]
  return key ? t(key) : t('teams.routine.fail.other')
}

/** A first line `# <heading>`, after any blank lines (four leading spaces would make it code, not a heading). */
const FIRST_HEADING_RE = /^(?:[ \t]*\r?\n)*[ ]{0,3}#[ \t]+([^\r\n]*)(?:\r?\n|$)/

/**
 * The text a note's drawer renders under its title: a first `# <title>` line whose heading is the note's title (main
 * reads the title back from it: `snaos team note --title` writes it so) is not repeated. The heading is compared the
 * way main's noteTitle reads it (emphasis marks dropped, spaces folded) but never clipped: a heading past the 80
 * characters of a title stays, and so does any other first line.
 */
export function noteBody(text: string, title: string): string {
  const want = title.trim()
  const m = want ? FIRST_HEADING_RE.exec(text) : null
  if (!m) return text
  const heading = m[1].replace(/[*_`~>]/g, '').replace(/\s+/g, ' ').trim()
  return heading === want ? text.slice(m[0].length).replace(/^(?:[ \t]*\r?\n)+/, '') : text
}

// ---- sync ------------------------------------------------------------------------------------------------

/** Folds the scopes of one `teams:changed` (the core hands them over one by one) into one pull. */
const SCOPE_FOLD_MS = 16

/**
 * Keeps what a panel loaded current while the lab is on (startTeams): a
 * `routines` or `team` change of the team on screen (a fire, a trust that
 * re-reads the definition) pulls its routines again, a `notes` change its
 * notes and the note its drawer shows; `disabled` clears everything. Only
 * what some view loaded is refetched.
 */
export function initRoutinesSync(): () => void {
  generation++
  const gen = generation
  const dueRoutines = new Set<string>()
  const dueNotes = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  const off = onTeamChanged((e) => {
    if (e.scopes.includes('disabled')) {
      useRoutinesStore.setState({ ...EMPTY })
      return
    }
    if (e.teamId !== useTeamsStore.getState().openTeamId) return
    const s = useRoutinesStore.getState()
    if (e.scopes.some((x) => x === 'routines' || x === 'team') && (s.routines[e.teamId] || s.routinesFailed[e.teamId])) dueRoutines.add(e.teamId)
    if (e.scopes.includes('notes')) dueNotes.add(e.teamId)
    if ((dueRoutines.size === 0 && dueNotes.size === 0) || timer) return
    timer = setTimeout(() => {
      timer = null
      if (gen !== generation) return
      const routines = [...dueRoutines]
      const notes = [...dueNotes]
      dueRoutines.clear()
      dueNotes.clear()
      for (const id of routines) void loadRoutines(id)
      const st = useRoutinesStore.getState()
      for (const id of notes) {
        if (st.notes[id] || st.notesFailed[id]) void loadNotes(id)
        // The note on screen comes again too (the Lead rewrote today's summary).
        const d = useTeamsStore.getState().drawer
        if (d?.kind === 'note' && useTeamsStore.getState().openTeamId === id) void loadNote(id, d.noteId)
      }
    }, SCOPE_FOLD_MS)
  })
  return () => {
    off()
    if (timer) clearTimeout(timer)
    generation++
    routinesSeq.clear()
    notesSeq.clear()
    docSeq.clear()
    useRoutinesStore.setState({ ...EMPTY })
  }
}
