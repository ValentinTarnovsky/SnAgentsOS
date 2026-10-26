/**
 * Agent race (E7-FR-34, 35): one task, up to 4 agents (Claude and Codex),
 * each in its own worktree created from the same base sha, all launched by
 * one explicit Ctrl+Enter. This module owns the race state, the checks the
 * dialog shows, the orchestration (worktrees, consoles, readiness, the prompt
 * with Enter) and the bar's actions. Nothing here ever merges: the user picks
 * a contestant by copying its `git checkout` and discards the others.
 *
 * Readiness per agent, the same rule as the initial prompt gate (PtyManager):
 * only a precise signal may send Enter, so Claude is ready on its SessionStart
 * hook and Codex on the Codex bridge start (a precise idle of that provider).
 * A title-only status is not enough: in a fresh worktree folder it can be
 * Claude's folder trust dialog, which an Enter would answer. Both also need
 * bracketed paste on (the input box is up). Past 20 s the task goes anyway
 * with a warning, pasted without Enter so it waits in the input for the user.
 * The race lives in memory: after a restart the consoles and their worktrees
 * stay, the bar does not.
 */
import { create } from 'zustand'
import type { AgentPreset, Pane, PaneStatus, PaneWorktree, Workspace } from '@shared/types'
import type { WorktreeInspectRes } from '@shared/worktree-types'
import { gridForCount } from '@/components/layout/gridTemplates'
import { translate, type MessageKey } from '@/i18n'
import { useAppStore } from './store'
import { snapshotConfig } from './persist'
import { isBracketedPaste } from './pasteRegistry'
import { deliverPrompt } from './broadcastPrompt'
import { toast } from './toast'
import { ackFields, deleteBlock, deleteNeedsAck, MAX_PANES, paneFromWorktree, removeExpectations, requestClosePane, templateFromPreset, worktreeUsers, type WorktreeDeleteBlock } from './worktrees'

/** Contestants per race (E7-FR-34). */
export const RACE_MAX = 4
/** How long an agent has to get ready before the task goes anyway. */
export const RACE_READY_MS = 20_000
const READY_POLL_MS = 250
/** After the ready signal, a beat for the agent's input box to settle. */
const READY_SETTLE_MS = 400

export type RaceAgent = 'claude' | 'codex'
export const RACE_AGENTS: readonly RaceAgent[] = ['claude', 'codex']
export type RaceCounts = Record<RaceAgent, number>

/** starting: waiting for the agent; sent: the task went with Enter; late: it went past the timeout; failed: nothing reached it. */
export type ContestantState = 'starting' | 'sent' | 'late' | 'failed'

export interface RaceContestant {
  paneId: string
  agent: RaceAgent
  branch: string
  path: string
  state: ContestantState
}

export interface Race {
  id: string
  workspaceId: string
  task: string
  /** Full sha every worktree started from. */
  base: string
  contestants: RaceContestant[]
  createdAt: number
}

interface RaceState {
  /** One race per workspace (the bar sits over that workspace's grid). */
  races: Record<string, Race>
  put: (race: Race) => void
  setState: (workspaceId: string, paneId: string, state: ContestantState) => void
  end: (workspaceId: string) => void
}

export const useRaceStore = create<RaceState>((set, get) => ({
  races: {},
  put: (race) => set((s) => ({ races: { ...s.races, [race.workspaceId]: race } })),
  setState: (workspaceId, paneId, state) => {
    const race = get().races[workspaceId]
    if (!race || !race.contestants.some((c) => c.paneId === paneId && c.state !== state)) return
    const contestants = race.contestants.map((c) => (c.paneId === paneId ? { ...c, state } : c))
    set((s) => ({ races: { ...s.races, [workspaceId]: { ...race, contestants } } }))
  },
  end: (workspaceId) => {
    if (!get().races[workspaceId]) return
    set((s) => {
      const races = { ...s.races }
      delete races[workspaceId]
      return { races }
    })
  },
}))

// ---- checks the dialog shows ------------------------------------------------

export function raceTotal(counts: RaceCounts): number {
  return counts.claude + counts.codex
}

/** 1..4 contestants, no negative or fractional count. */
export function raceCountsOk(counts: RaceCounts): boolean {
  const ok = (n: number): boolean => Number.isInteger(n) && n >= 0
  const total = raceTotal(counts)
  return ok(counts.claude) && ok(counts.codex) && total >= 1 && total <= RACE_MAX
}

/** "This workspace" is offered only when every contestant fits next to the consoles already there. */
export function raceFitsHere(paneCount: number, counts: RaceCounts): boolean {
  const total = raceTotal(counts)
  return total >= 1 && total <= MAX_PANES - paneCount
}

/** The presets a race launches: the default agent preset when it has that type, else the first of the type. */
export function racePresets(s: { presets: AgentPreset[]; settings: { automation?: { defaultAgentPresetId?: string } } }): Partial<Record<RaceAgent, AgentPreset>> {
  const preferred = s.settings.automation?.defaultAgentPresetId
  const pick = (type: RaceAgent): AgentPreset | undefined =>
    (preferred ? s.presets.find((p) => p.id === preferred && p.type === type) : undefined) ?? s.presets.find((p) => p.type === type)
  const out: Partial<Record<RaceAgent, AgentPreset>> = {}
  for (const a of RACE_AGENTS) {
    const p = pick(a)
    if (p) out[a] = p
  }
  return out
}

/** Starting counts: Claude x2 + Codex x1 when both exist, else up to 2 of the one there is. */
export function defaultRaceCounts(presets: Partial<Record<RaceAgent, AgentPreset>>): RaceCounts {
  if (presets.claude && presets.codex) return { claude: 2, codex: 1 }
  return { claude: presets.claude ? 2 : 0, codex: presets.codex ? 2 : 0 }
}

/** "Race - <first words>": the task's first 5 words, at most 32 characters, on one line. */
export function raceWorkspaceName(task: string, prefix: string): string {
  const words = task.replace(/\s+/g, ' ').trim().split(' ').slice(0, 5).join(' ')
  const cut = words.length > 32 ? `${words.slice(0, 31).trimEnd()}…` : words
  return cut ? `${prefix} - ${cut}` : prefix
}

/** `race-claude-1-3f2a`: always a valid worktree slug. */
export function raceSlug(agent: RaceAgent, index: number, rand: () => number = Math.random): string {
  const hex = Math.floor(rand() * 0x10000).toString(16).padStart(4, '0').slice(-4)
  return `race-${agent}-${index + 1}-${hex}`
}

/** Whether a contestant's agent is up (see the module comment): a precise idle of its own provider plus bracketed paste. */
export function raceReady(agent: RaceAgent, status: Pick<PaneStatus, 'provider' | 'precise' | 'state'> | null | undefined, bracketed: boolean | null): boolean {
  if (bracketed !== true || !status || status.precise !== true) return false
  return status.provider === agent && (status.state === 'idle' || status.state === 'done')
}

/** What "Copy git checkout" puts on the clipboard. */
export function checkoutCommand(branch: string): string {
  return `git checkout ${branch}`
}

/** The contestants still on screen: their console exists and still runs in the race's worktree. */
export function liveContestants(race: Race, ws: Workspace | undefined): RaceContestant[] {
  if (!ws) return []
  return race.contestants.filter((c) => ws.panes.some((p) => p.id === c.paneId && p.worktree?.path === c.path))
}

// ---- orchestration -----------------------------------------------------------

export type StartRaceError = 'not_found' | 'no_task' | 'bad_counts' | 'no_preset' | 'full' | 'remote' | 'not_repo' | 'unborn' | 'worktree'

export interface StartRaceReq {
  workspaceId: string
  task: string
  counts: RaceCounts
  destination: 'here' | 'new'
}

export interface RaceOutcome {
  sent: number
  late: number
  failed: number
}

export type StartRaceRes =
  | { ok: true; workspaceId: string; paneIds: string[]; done: Promise<RaceOutcome> }
  | { ok: false; error: StartRaceError; detail?: string }

export interface RaceTiming {
  readyMs?: number
  pollMs?: number
  settleMs?: number
  rand?: () => number
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function lang() {
  return useAppStore.getState().settings.language
}

/** One contestant per slot, Claude first, in the order the counters show. */
function slotsOf(counts: RaceCounts): RaceAgent[] {
  const out: RaceAgent[] = []
  for (const a of RACE_AGENTS) for (let i = 0; i < counts[a]; i++) out.push(a)
  return out
}

/**
 * Starts a race from the workspace's folder (Ctrl+Enter in the dialog is the
 * consent). Every check runs before the first worktree; worktrees are all or
 * nothing (a failure removes the ones this call created and adds no console).
 * Resolves once the consoles exist; `done` settles when every task went out.
 */
export async function startRace(req: StartRaceReq, timing: RaceTiming = {}): Promise<StartRaceRes> {
  const s = useAppStore.getState()
  const ws = s.workspaces.find((w) => w.id === req.workspaceId)
  if (!ws) return { ok: false, error: 'not_found' }
  const task = req.task.trim()
  if (!task) return { ok: false, error: 'no_task' }
  if (!raceCountsOk(req.counts)) return { ok: false, error: 'bad_counts' }
  const presets = racePresets(s)
  const slots = slotsOf(req.counts)
  if (slots.some((a) => !presets[a])) return { ok: false, error: 'no_preset' }
  const setup = ws.setupId ? s.connections.find((c) => c.id === ws.setupId)?.steps : undefined
  if (setup && setup.length > 0) return { ok: false, error: 'remote' }
  if (req.destination === 'here' && !raceFitsHere(ws.panes.length, req.counts)) return { ok: false, error: 'full' }
  if (!ws.cwd) return { ok: false, error: 'not_repo' }

  const git = window.snApi.git
  const probe = await git.worktreeProbe(ws.cwd).catch(() => ({ ok: false as const, error: 'git_error' as const }))
  if (!probe.ok) return { ok: false, error: probe.error === 'unborn' ? 'unborn' : 'not_repo' }
  const base = probe.head

  const created: PaneWorktree[] = []
  const rollback = async (): Promise<void> => {
    // Fresh worktrees, but main still compares against what is there (a copied .env that is not ignored counts as a file).
    for (const wt of created.reverse()) await git.worktreeRemove({ path: wt.path, deleteBranch: true, ...removeExpectations(await inspect(wt)) }).catch(() => undefined)
  }
  for (let i = 0; i < slots.length; i++) {
    let res = null as Awaited<ReturnType<typeof git.worktreeAdd>> | null
    // A taken slug (a leftover branch) gets one more random suffix; the existing branch is never touched.
    for (let attempt = 0; attempt < 2; attempt++) {
      const slug = raceSlug(slots[i], i, timing.rand)
      res = await git.worktreeAdd({ repoCwd: ws.cwd, slug, base, copyEnv: true, linkNodeModules: false }).catch((e) => ({ ok: false as const, error: 'git_error' as const, detail: String(e) }))
      if (res.ok || res.error !== 'branch_exists') break
    }
    if (!res || !res.ok) {
      await rollback()
      return { ok: false, error: 'worktree', detail: res && !res.ok ? (res.detail ?? res.error) : undefined }
    }
    created.push(res.worktree)
  }

  // The worktrees took a while: the workspace may be gone, or (this workspace) filled up meanwhile.
  const now = useAppStore.getState().workspaces.find((w) => w.id === ws.id)
  const lost: StartRaceError | null = !now ? 'not_found' : req.destination === 'here' && !raceFitsHere(now.panes.length, req.counts) ? 'full' : null
  if (lost) {
    await rollback()
    return { ok: false, error: lost }
  }

  const templates = slots.map((a) => templateFromPreset(presets[a] as AgentPreset))
  let workspaceId = ws.id
  let paneIds: string[]
  if (req.destination === 'new') {
    workspaceId = useAppStore.getState().createWorkspaceFull({
      name: raceWorkspaceName(task, translate(lang(), 'race.workspacePrefix')),
      cwd: ws.cwd,
      grid: gridForCount(slots.length),
      panes: created.map((wt, i) => {
        const p = paneFromWorktree(templates[i], wt)
        return { type: templates[i].type, presetId: templates[i].presetId, title: p.title as string, color: templates[i].color, icon: templates[i].icon, cwd: wt.path, worktree: wt }
      }),
    })
    paneIds = (useAppStore.getState().workspaces.find((w) => w.id === workspaceId)?.panes ?? []).map((p) => p.id)
  } else {
    const add = useAppStore.getState().addPane
    paneIds = created.map((wt, i) => add(ws.id, paneFromWorktree(templates[i], wt)))
  }

  const contestants: RaceContestant[] = created.map((wt, i) => ({ paneId: paneIds[i], agent: slots[i], branch: wt.branch, path: wt.path, state: 'starting' }))
  useRaceStore.getState().put({ id: `race-${Date.now().toString(36)}`, workspaceId, task, base, contestants, createdAt: Date.now() })

  const done = Promise.all(contestants.map((c) => sendWhenReady(workspaceId, c, task, timing))).then((states) => {
    const outcome: RaceOutcome = {
      sent: states.filter((x) => x === 'sent').length,
      late: states.filter((x) => x === 'late').length,
      failed: states.filter((x) => x === 'failed').length,
    }
    const l = lang()
    if (outcome.failed > 0) toast.error(translate(l, 'race.toast.failed', { count: outcome.failed }), { dedupeKey: `race:${workspaceId}` })
    else if (outcome.late > 0) toast.warning(translate(l, 'race.toast.late', { count: outcome.late }), { dedupeKey: `race:${workspaceId}` })
    else toast.success(translate(l, 'race.toast.sent', { count: outcome.sent }), { dedupeKey: `race:${workspaceId}` })
    return outcome
  })
  return { ok: true, workspaceId, paneIds, done }
}

/** Waits for one contestant's agent and sends it the task with Enter. */
async function sendWhenReady(workspaceId: string, c: RaceContestant, task: string, timing: RaceTiming): Promise<ContestantState> {
  const readyMs = timing.readyMs ?? RACE_READY_MS
  const pollMs = timing.pollMs ?? READY_POLL_MS
  const exists = (): boolean => useAppStore.getState().workspaces.some((w) => w.id === workspaceId && w.panes.some((p) => p.id === c.paneId))
  const ready = (): boolean => raceReady(c.agent, useAppStore.getState().paneStatus[c.paneId], isBracketedPaste(c.paneId))
  const finish = (state: ContestantState): ContestantState => {
    useRaceStore.getState().setState(workspaceId, c.paneId, state)
    return state
  }
  const deadline = Date.now() + readyMs
  while (!ready() && Date.now() < deadline) {
    await sleep(pollMs)
    if (!exists()) return finish('failed')
  }
  const late = !ready()
  if (!late) await sleep(timing.settleMs ?? READY_SETTLE_MS)
  if (!exists()) return finish('failed')
  // Late: never an Enter (it could answer a trust or login screen); the task waits in the input,
  // whole with bracketed paste on, else on one line.
  const agent = !late || isBracketedPaste(c.paneId) === true
  if (!deliverPrompt(c.paneId, task, { agent, enter: !late })) return finish('failed')
  return finish(late ? 'late' : 'sent')
}

// ---- the bar's actions ---------------------------------------------------------

function paneOf(workspaceId: string, paneId: string): Pane | undefined {
  return useAppStore.getState().workspaces.find((w) => w.id === workspaceId)?.panes.find((p) => p.id === paneId)
}

/** The other consoles (any workspace) in a contestant's worktree, a "New console in this worktree" (app 2.7.0, A9). */
function sharedBy(wt: PaneWorktree, paneId: string): number {
  return worktreeUsers(useAppStore.getState().workspaces, wt.path, paneId)
}

async function inspect(wt: PaneWorktree): Promise<WorktreeInspectRes> {
  try {
    return await window.snApi.git.worktreeInspect({ path: wt.path, base: wt.base })
  } catch {
    // Unknown is not clean: it goes through the dialog.
    return { exists: true, dirtyFiles: 0, commitsAhead: 0, mergedIntoHead: false, incomplete: true }
  }
}

/**
 * [Discard] (E7-FR-35 with FR-30): a clean contestant (nothing uncommitted,
 * no commit over the base) is deleted with its branch at once; anything else
 * opens the close dialog of FR-30 with its checkbox. So does one whose
 * worktree another console also runs in (app 2.7.0, A9): the dialog says why
 * and only offers Keep. Returns what happened.
 */
export async function discardContestant(workspaceId: string, paneId: string): Promise<'removed' | 'dialog' | 'error'> {
  const wt = paneOf(workspaceId, paneId)?.worktree
  if (!wt) return 'error'
  if (sharedBy(wt, paneId) > 0) {
    requestClosePane(workspaceId, paneId)
    return 'dialog'
  }
  const info = await inspect(wt)
  if (!info.exists || deleteNeedsAck(info) || deleteBlock(info, wt.branch) || sharedBy(wt, paneId) > 0) {
    requestClosePane(workspaceId, paneId)
    return 'dialog'
  }
  const res = await removeContestant(workspaceId, paneId, wt, info, { quiet: true })
  if (res === 'changed' || res === 'shared') {
    // It moved on after the inspect (a late commit or file), or main saw another console on it: the dialog reads it again.
    requestClosePane(workspaceId, paneId)
    return 'dialog'
  }
  return res === 'removed' ? 'removed' : 'error'
}

/**
 * Deletes one contestant against the inspect `info` it was judged on (main
 * answers 'changed' if it moved on since, 'shared' while another console of
 * the saved config runs in it). `quiet`: those two go back to the caller
 * without a toast.
 */
async function removeContestant(workspaceId: string, paneId: string, wt: PaneWorktree, info: WorktreeInspectRes, o: { quiet?: boolean; acked?: boolean } = {}): Promise<'removed' | 'changed' | 'shared' | 'error'> {
  let ok = false
  let detail = ''
  let refused: 'changed' | 'shared' | null = null
  // The config to main first (a send, it lands before the invoke): its 'shared' check reads the
  // saved consoles, which the debounced save keeps up to 400 ms behind (a console just closed).
  try {
    if (useAppStore.getState().hydrated) window.snApi.config.save(snapshotConfig())
  } catch {
    /* the debounced save still goes */
  }
  try {
    const res = await window.snApi.git.worktreeRemove({ path: wt.path, paneId, deleteBranch: true, ...removeExpectations(info), ...ackFields(info, o.acked === true) })
    ok = res.ok
    if (!res.ok) {
      refused = res.error === 'changed' || res.error === 'shared' ? res.error : null
      detail = refused ? translate(lang(), refused === 'shared' ? 'worktree.rmErr.shared' : 'worktree.rmErr.changed') : (res.detail ?? res.error)
    }
  } catch (e) {
    detail = String((e as Error)?.message ?? e)
  }
  if (refused && o.quiet) return refused
  if (!ok) {
    toast.error(translate(lang(), 'race.toast.discardFailed', { branch: wt.branch, detail }), { dedupeKey: `race-discard:${paneId}` })
    return refused ?? 'error'
  }
  // Deleted for good: not on the reopen stack.
  useAppStore.getState().removePane(workspaceId, paneId)
  return 'removed'
}

/** What "Keep this one" shows for each of the other contestants before deleting them. */
export interface KeepPlanRow {
  paneId: string
  branch: string
  info: WorktreeInspectRes
  /** Other consoles running in its worktree (app 2.7.0, A9); absent: none. */
  shared?: number
}

export async function planKeep(workspaceId: string, keepPaneId: string): Promise<KeepPlanRow[]> {
  const race = useRaceStore.getState().races[workspaceId]
  const ws = useAppStore.getState().workspaces.find((w) => w.id === workspaceId)
  if (!race || !ws) return []
  const rows: KeepPlanRow[] = []
  for (const c of liveContestants(race, ws)) {
    if (c.paneId === keepPaneId) continue
    const wt = paneOf(workspaceId, c.paneId)?.worktree
    if (!wt) continue
    const info = await inspect(wt)
    const shared = sharedBy(wt, c.paneId)
    rows.push({ paneId: c.paneId, branch: c.branch, info, ...(shared > 0 ? { shared } : {}) })
  }
  return rows
}

/** Why "Keep this one" leaves a contestant in place. */
export type KeepBlock = WorktreeDeleteBlock | 'shared'

/**
 * Why "Keep this one" leaves a contestant in place (FR-30): another console
 * running in its worktree (A9), a half-done git operation or another branch
 * checked out in its folder, as the close dialog blocks Delete. Main would
 * refuse it anyway.
 */
export function keepBlock(row: KeepPlanRow): KeepBlock | null {
  if ((row.shared ?? 0) > 0) return 'shared'
  return deleteBlock(row.info, row.branch)
}

/**
 * Whether "Keep this one" needs the checkbox (some other contestant would
 * lose work), and how much. A gone folder still counts the commits its branch
 * delete drops; a blocked contestant is not deleted, so it counts nothing.
 */
export function keepLoss(rows: readonly KeepPlanRow[]): { needsAck: boolean; files: number; commits: number } {
  let files = 0
  let commits = 0
  let needsAck = false
  for (const r of rows) {
    if (keepBlock(r)) continue
    if (deleteNeedsAck(r.info)) needsAck = true
    files += r.info.dirtyFiles
    commits += r.info.mergedIntoHead ? 0 : r.info.commitsAhead
  }
  return { needsAck, files, commits }
}

/**
 * Deletes the other contestants (worktree and branch) against the inspect the
 * user confirmed; the kept one is untouched. One that moved on since stays
 * (main answers 'changed', a toast says so), and so does a blocked one
 * (keepBlock), never sent to main, or one another console opened on after
 * the plan was read (a toast says so). Returns how many went.
 */
export async function discardOthers(workspaceId: string, rows: readonly KeepPlanRow[]): Promise<number> {
  let n = 0
  for (const r of rows) {
    if (keepBlock(r)) continue
    const wt = paneOf(workspaceId, r.paneId)?.worktree
    if (!wt) continue
    if (sharedBy(wt, r.paneId) > 0) {
      const l = lang()
      toast.error(translate(l, 'race.toast.discardFailed', { branch: wt.branch, detail: translate(l, 'worktree.rmErr.shared') }), { dedupeKey: `race-discard:${r.paneId}` })
      continue
    }
    // Only called once the keep dialog was confirmed, with its checkbox whenever keepLoss asked for it.
    if ((await removeContestant(workspaceId, r.paneId, wt, r.info, { acked: true })) === 'removed') n++
  }
  return n
}

/** i18n key of a contestant's state glyph label. */
export function stateKey(state: ContestantState): MessageKey {
  return `race.state.${state}` as MessageKey
}
