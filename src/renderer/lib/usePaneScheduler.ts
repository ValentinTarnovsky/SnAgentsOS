import { useEffect } from 'react'
import { create } from 'zustand'
import type { PtyPromptResultEvt } from '@shared/ipc-contract'
import type { AgentPreset, Pane, PaneSchedule, ScheduleRun, ScheduleRunStatus } from '@shared/types'
import { afterRun, decide, isScheduleEnabled, nextOccurrence, scheduleKey, withEnabled, type ScheduleAgentSignal } from '@shared/schedule'
import { SCHEDULE_WAKE_LEAD_MS } from '@shared/hibernation'
import { PROMPT_READY_TIMEOUT_MS } from '@shared/initialPrompt'
import { translate, type MessageKey } from '@/i18n'
import { useAppStore, type AppState } from './store'
import { getPtyId } from './ptyRegistry'
import { isPaneMounted } from './mounting'
import { useAgentStore } from './agentStore'
import { isWaking, wakePane } from './hibernation'
import { toast } from './toast'

/** Kept for callers of the one-shot era; the rule now lives in @shared/schedule. */
export { nextOccurrence }

/** Ticker period. Chromium may slow it while the window is hidden (E8 risk 7). */
export const SCHEDULER_TICK_MS = 1000
/**
 * A prompt handed to an unspawned console reports back on pty:promptResult
 * within the gate's 20 s once the pty exists; past this, the spawn never came
 * (failed, held, worktree missing) and the run is logged as not delivered.
 */
export const PENDING_DELIVERY_TIMEOUT_MS = PROMPT_READY_TIMEOUT_MS + 70_000
/**
 * After one schedule's prompt went into a console, its other schedules hold
 * this long (app 2.7.0): the agent's status takes a moment to report the turn
 * that prompt started, and a second schedule due at the same time must not
 * read the stale idle and type into it.
 */
export const SCHEDULE_SETTLE_MS = 5_000

type Trigger = ScheduleRun['trigger']

/** A run already on its way (submit in flight, or a prompt waiting for a spawn). */
export interface ScheduleInflight {
  paneId: string
  scheduleId: string
  trigger: Trigger
  /** Occurrence it serves (manual: when it was asked for). */
  scheduledFor: number
  via: 'submit' | 'pending'
  startedAt: number
}

/** A "Run now" request (E8-FR-31): the text it sends and its own wait clock. */
export interface ManualRun {
  paneId: string
  scheduleId: string
  text: string
  askedAt: number
  since?: number
}

/**
 * Transient scheduler state (never persisted): pending "Run now" requests and
 * runs in flight, per schedule, keyed `paneId#scheduleId` (`scheduleKey`,
 * app 2.7.0). The dialog reads it for its "Waiting..." button.
 */
interface ScheduleRuntimeState {
  manual: Record<string, ManualRun>
  inflight: Record<string, ScheduleInflight>
}

export const useScheduleRuntime = create<ScheduleRuntimeState>(() => ({ manual: {}, inflight: {} }))

function patchRuntime(key: keyof ScheduleRuntimeState, runKey: string, value: ManualRun | ScheduleInflight | null): void {
  useScheduleRuntime.setState((s) => {
    const next = { ...s[key] } as Record<string, ManualRun | ScheduleInflight>
    if (value) next[runKey] = value
    else if (runKey in next) delete next[runKey]
    else return {}
    return { [key]: next } as Partial<ScheduleRuntimeState>
  })
}

/** True while one schedule's "Run now" waits for a free agent or is being sent. */
export function isManualRunPending(state: ScheduleRuntimeState, paneId: string, scheduleId: string): boolean {
  const key = scheduleKey(paneId, scheduleId)
  return key in state.manual || state.inflight[key]?.trigger === 'manual'
}

/** A run of any of the console's schedules is on its way: the pty and the pending-prompt slot are per console. */
function paneInflight(state: ScheduleRuntimeState, paneId: string): boolean {
  for (const run of Object.values(state.inflight)) if (run.paneId === paneId) return true
  return false
}

/** Claude Code or Codex by the pane's type or its preset (E8-FR-29). */
export function isAgentKind(pane: Pick<Pane, 'type' | 'presetId'>, presets: readonly AgentPreset[]): boolean {
  if (pane.type === 'claude' || pane.type === 'codex') return true
  const preset = pane.presetId ? presets.find((p) => p.id === pane.presetId) : undefined
  return preset?.type === 'claude' || preset?.type === 'codex'
}

function findSchedule(paneId: string, scheduleId: string): { wsId: string; pane: Pane; sched: PaneSchedule } | null {
  for (const ws of useAppStore.getState().workspaces) {
    const pane = ws.panes.find((p) => p.id === paneId)
    if (!pane) continue
    const sched = pane.schedules?.find((s) => s.id === scheduleId)
    return sched ? { wsId: ws.id, pane, sched } : null
  }
  return null
}

export const RUN_STATUS_KEY: Record<ScheduleRunStatus, MessageKey> = {
  sent: 'schedule.status.sent',
  sent_unconfirmed: 'schedule.status.sent_unconfirmed',
  skipped_busy: 'schedule.status.skipped_busy',
  missed: 'schedule.status.missed',
  failed: 'schedule.status.failed',
}

export const RUN_REASON_KEY: Record<NonNullable<ScheduleRun['reason']>, MessageKey> = {
  agent_not_running: 'schedule.reason.agent_not_running',
  multiline_unsafe: 'schedule.reason.multiline_unsafe',
  not_delivered: 'schedule.reason.not_delivered',
  enter_held: 'schedule.reason.enter_held',
}

/** Desktop notification per run, opt-in (`scheduleNotify`, E8-FR-31). */
function notifyRun(paneTitle: string, run: ScheduleRun): void {
  const { settings } = useAppStore.getState()
  if (!settings.automation?.scheduleNotify) return
  const lang = settings.language
  const status = translate(lang, RUN_STATUS_KEY[run.status])
  const body = run.reason ? `${status} - ${translate(lang, RUN_REASON_KEY[run.reason])}` : status
  try {
    new Notification(translate(lang, 'schedule.notify.title', { pane: paneTitle }), { body, silent: true })
  } catch {
    /* notifications unavailable: the history still has the run */
  }
}

/** The last prompt a schedule put into each console, and when (SCHEDULE_SETTLE_MS). */
const lastSentAt = new Map<string, { at: number; scheduleId: string }>()

/**
 * Logs one run on the schedule's current version and ends whatever the
 * runtime held for it. The schedule is re-read here: it may have been edited
 * (a new `dueAt` is kept) or deleted (nothing to log) while the run was in
 * flight.
 */
function finishRun(paneId: string, scheduleId: string, trigger: Trigger, scheduledFor: number, status: ScheduleRunStatus, reason: ScheduleRun['reason'], now: number): void {
  const key = scheduleKey(paneId, scheduleId)
  patchRuntime('inflight', key, null)
  if (trigger === 'manual') patchRuntime('manual', key, null)
  if (status === 'sent' || status === 'sent_unconfirmed') lastSentAt.set(paneId, { at: now, scheduleId })
  const found = findSchedule(paneId, scheduleId)
  if (!found) return
  const run: ScheduleRun = { at: now, scheduledFor, trigger, status, ...(reason ? { reason } : {}) }
  useAppStore.getState().setPaneSchedule(found.wsId, paneId, scheduleId, afterRun(found.sched, run, now, scheduledFor))
  if (reason === 'multiline_unsafe') {
    toast.warning(translate(useAppStore.getState().settings.language, 'quick.toast.multiline'), { dedupeKey: 'schedule' })
  }
  notifyRun(found.pane.title, run)
}

/**
 * Send through the shared delivery path (E8-FR-02a): the Enter goes 150 ms
 * after the text drained; multi-line text without bracketed paste is refused.
 * `userGate`: `decide` only saw the renderer's status, so main checks
 * `typingBlocked` again on its own status. A console that already waits on
 * the user gets nothing (`awaiting_user`, logged as `skipped_busy`); one that
 * starts waiting between the text and the deferred Enter keeps the text typed
 * and never gets the Enter (`enter_held`, logged as `failed` / `enter_held`).
 */
function submitRun(paneId: string, scheduleId: string, ptyId: string, text: string, trigger: Trigger, scheduledFor: number, now: number): void {
  patchRuntime('inflight', scheduleKey(paneId, scheduleId), { paneId, scheduleId, trigger, scheduledFor, via: 'submit', startedAt: now })
  const finish = (status: ScheduleRunStatus, reason?: ScheduleRun['reason']): void => finishRun(paneId, scheduleId, trigger, scheduledFor, status, reason, Date.now())
  void window.snApi.pty
    .submit({ ptyId, paneId, text, enter: true, origin: 'auto', userGate: true })
    .then(
      (res) => {
        if (res.ok) finish('sent')
        else if (res.error === 'awaiting_user') finish('skipped_busy')
        else if (res.error === 'enter_held') finish('failed', 'enter_held')
        else finish('failed', res.error === 'multiline_unsafe' ? 'multiline_unsafe' : 'not_delivered')
      },
      () => finish('failed', 'not_delivered'),
    )
}

/**
 * Outcome of a prompt handed to an unspawned agent console (E8-FR-30): argv
 * or a gate with a precise ready signal count as sent; inserted without
 * Enter is `sent_unconfirmed`; anything else was not delivered. The event
 * names only the console: at most one of its schedules hands a prompt over
 * at a time.
 */
export function handleSchedulePromptResult(evt: PtyPromptResultEvt, now: number = Date.now()): void {
  const run = Object.values(useScheduleRuntime.getState().inflight).find((r) => r.paneId === evt.paneId && r.via === 'pending')
  if (!run) return
  const finish = (status: ScheduleRunStatus, reason?: ScheduleRun['reason']): void => finishRun(run.paneId, run.scheduleId, run.trigger, run.scheduledFor, status, reason, now)
  if (evt.result === 'sent_argv' || evt.result === 'sent_gate') finish('sent')
  else if (evt.result === 'inserted_unconfirmed') finish('sent_unconfirmed')
  else finish('failed', 'not_delivered')
}

/** Starts the wait clock of a run that cannot be sent yet (persisted for scheduled runs). */
function startWait(wsId: string, paneId: string, sched: PaneSchedule, manual: ManualRun | undefined, now: number): void {
  if (manual) {
    if (manual.since === undefined) patchRuntime('manual', scheduleKey(paneId, sched.id), { ...manual, since: now })
    return
  }
  if (sched.waitingSince === undefined) useAppStore.getState().setPaneSchedule(wsId, paneId, sched.id, { ...sched, waitingSince: now })
}

/** What one tick knows about a console, shared by all its schedules. */
interface PaneTick {
  wsId: string
  pane: Pane
  ptyId: string | null
  agent: boolean
  sleeping: boolean
  live: boolean
  status: ScheduleAgentSignal | null | undefined
  graceMin: number
  maxWaitMin: number
}

/**
 * A scheduled occurrence that comes due while its console is held (a "Run
 * now", another schedule's run on its way or just sent) starts its own wait
 * clock, so it is served (or skipped as busy) afterwards instead of logged as
 * missed once the grace is over.
 */
function holdScheduled(t: PaneTick, sched: PaneSchedule, now: number): void {
  if (sched.waitingSince !== undefined) return
  const scheduled = decide({ schedule: sched, now, status: t.status, agent: t.agent, live: !!t.ptyId, graceMin: t.graceMin, maxWaitMin: t.maxWaitMin })
  if (scheduled === 'idle' || scheduled === 'missed') return
  const cur = findSchedule(t.pane.id, sched.id)?.sched
  if (cur && cur.dueAt === sched.dueAt && cur.waitingSince === undefined) {
    useAppStore.getState().setPaneSchedule(t.wsId, t.pane.id, sched.id, { ...cur, waitingSince: now })
  }
}

/**
 * One schedule of a console that is not held. True when a prompt is now on
 * its way into the console (submitted, or handed to its spawn), which holds
 * the console's other schedules.
 */
function tickSchedule(t: PaneTick, sched: PaneSchedule, manual: ManualRun | undefined, woke: { done: boolean }, now: number): boolean {
  const { pane, wsId, ptyId, agent } = t
  const trigger: Trigger = manual ? 'manual' : 'scheduled'
  const decision = decide({
    schedule: sched,
    now,
    trigger,
    manualSince: manual?.since,
    status: t.status,
    agent,
    live: t.live,
    graceMin: t.graceMin,
    maxWaitMin: t.maxWaitMin,
  })
  // A sleeping console wakes (resuming its chat) when a run is 30 s away or due, never for a missed one.
  if (t.sleeping && decision !== 'missed' && (manual || (isScheduleEnabled(sched) && sched.dueAt - now <= SCHEDULE_WAKE_LEAD_MS))) {
    if (!woke.done) wakePane(pane.id)
    woke.done = true
    if (decision === 'idle') return false
  }
  const scheduledFor = manual ? manual.askedAt : sched.dueAt
  let sent = false
  switch (decision) {
    case 'idle':
      break
    case 'fire':
      if (ptyId) {
        submitRun(pane.id, sched.id, ptyId, manual ? manual.text : sched.prompt, trigger, scheduledFor, now)
        sent = true
      }
      break
    case 'missed':
      finishRun(pane.id, sched.id, 'scheduled', sched.dueAt, 'missed', undefined, now)
      break
    case 'skip_busy':
      finishRun(pane.id, sched.id, trigger, scheduledFor, 'skipped_busy', undefined, now)
      break
    case 'fail_no_agent':
      finishRun(pane.id, sched.id, trigger, scheduledFor, 'failed', agent ? 'agent_not_running' : 'not_delivered', now)
      break
    case 'wait': {
      const cur = useAppStore.getState()
      const mounted = isPaneMounted(cur.mountedWorkspaces, wsId, pane.id)
      if (!ptyId && !mounted) {
        if (agent && !cur.pendingPrompts[pane.id]) {
          cur.setPendingPrompt(pane.id, { text: manual ? manual.text : sched.prompt, enter: true, source: 'schedule', createdAt: now })
          patchRuntime('inflight', scheduleKey(pane.id, sched.id), { paneId: pane.id, scheduleId: sched.id, trigger, scheduledFor, via: 'pending', startedAt: now })
          cur.ensureMounted(wsId, { only: [pane.id] })
          sent = true
          break
        }
        cur.ensureMounted(wsId, { only: [pane.id] })
      }
      startWait(wsId, pane.id, sched, manual, now)
      break
    }
  }
  // A "Run now" holds its own schedule's occurrence.
  if (manual) holdScheduled(t, sched, now)
  return sent
}

/**
 * One scheduler pass over every console (exported for tests). Each schedule
 * of a console is its own (app 2.7.0, up to 8): pending "Run now" requests
 * go first, then the scheduled occurrences in stored order, and `decide` says
 * what to do with the pane's live agent state. One prompt at a time per
 * console: while one schedule's run is on its way, or for SCHEDULE_SETTLE_MS
 * after one went in, the others only start their wait clocks. A due console
 * whose workspace is not mounted mounts alone (E8-FR-30), without activating
 * the workspace or starting its other consoles: an agent console gets the
 * prompt as its initial prompt (argv, or the gate's precise ready signal), a
 * shell console is written to once its pty exists.
 */
export function schedulerTick(now: number = Date.now()): void {
  const runtime = useScheduleRuntime.getState()
  // A prompt handed to a spawn that never came: give up and log it.
  for (const run of Object.values(runtime.inflight)) {
    if (run.via !== 'pending' || now - run.startedAt < PENDING_DELIVERY_TIMEOUT_MS) continue
    const { pendingPrompts, setPendingPrompt } = useAppStore.getState()
    if (pendingPrompts[run.paneId]?.source === 'schedule') setPendingPrompt(run.paneId, null)
    finishRun(run.paneId, run.scheduleId, run.trigger, run.scheduledFor, 'failed', 'not_delivered', now)
  }
  // "Run now" requests for a schedule (or pane) that is gone.
  for (const [key, m] of Object.entries(runtime.manual)) {
    if (!findSchedule(m.paneId, m.scheduleId)) patchRuntime('manual', key, null)
  }
  for (const [paneId, sent] of lastSentAt) if (!settling(sent.at, now)) lastSentAt.delete(paneId)

  // Read after the passes above, which may have rewritten schedules. Each
  // pane is visited once and only writes its own schedules, so the snapshot
  // stays current for the pane being handled; mount state is re-read per pane.
  const app = useAppStore.getState()
  const automation = app.settings.automation
  const graceMin = automation?.scheduleGraceMin ?? 120
  const maxWaitMin = automation?.scheduleMaxWaitMin ?? 30
  for (const ws of app.workspaces) {
    for (const pane of ws.panes) {
      if (pane.schedules?.length) tickPane(app, ws.id, pane, pane.schedules, graceMin, maxWaitMin, now)
    }
  }
}

function tickPane(app: AppState, wsId: string, pane: Pane, schedules: readonly PaneSchedule[], graceMin: number, maxWaitMin: number, now: number): void {
  const ptyId = getPtyId(pane.id) ?? null
  // A console woken from sleep is not live for a prompt until its resumed agent is ready (E5-FR-26).
  const sleeping = !!useAgentStore.getState().sleeping[pane.id]
  // App 2.7.0 (A3): a `bare` status (only a `snaos needs`, no agent track) is no agent state:
  // an agent console with it waits as `no_agent` instead of reading a free idle.
  const raw = app.paneStatus[pane.id]
  const t: PaneTick = {
    wsId,
    pane,
    ptyId,
    agent: isAgentKind(pane, app.presets),
    sleeping,
    live: !!ptyId && !sleeping && !isWaking(pane.id),
    status: raw?.bare ? undefined : raw,
    graceMin,
    maxWaitMin,
  }
  const manualOf = (s: PaneSchedule): ManualRun | undefined => useScheduleRuntime.getState().manual[scheduleKey(pane.id, s.id)]
  // Stable: the "Run now" requests first, each group in stored order.
  const order = [...schedules.filter((s) => manualOf(s)), ...schedules.filter((s) => !manualOf(s))]
  let busy = paneInflight(useScheduleRuntime.getState(), pane.id)
  const sent = lastSentAt.get(pane.id)
  const woke = { done: false }
  for (const sched of order) {
    // Its own run is on its way: nothing to decide until it reports back.
    if (useScheduleRuntime.getState().inflight[scheduleKey(pane.id, sched.id)]) continue
    if (busy || (sent && sent.scheduleId !== sched.id && settling(sent.at, now))) {
      holdScheduled(t, sched, now)
      continue
    }
    if (tickSchedule(t, sched, manualOf(sched), woke, now)) busy = true
  }
}

/** Within SCHEDULE_SETTLE_MS of a prompt that went in (either way: a clock set back by hours ends it). */
function settling(at: number, now: number): boolean {
  return now - at < SCHEDULE_SETTLE_MS && at - now < SCHEDULE_SETTLE_MS
}

/**
 * "Run now" (E8-FR-31) of one schedule: fires through the same path with
 * trigger 'manual', honoring "wait for the agent to be free", and never moves
 * `dueAt`. `text` defaults to the saved prompt. False when the pane has no
 * schedule with that id.
 */
export function runScheduleNow(paneId: string, scheduleId: string, text?: string): boolean {
  const sched = findSchedule(paneId, scheduleId)?.sched
  if (!sched) return false
  const prompt = text?.trim() || sched.prompt
  if (!prompt) return false
  const key = scheduleKey(paneId, scheduleId)
  const rt = useScheduleRuntime.getState()
  if (rt.manual[key] || rt.inflight[key]) return true
  patchRuntime('manual', key, { paneId, scheduleId, text: prompt, askedAt: Date.now() })
  schedulerTick()
  return true
}

/** Cancels a schedule's "Run now" that is still waiting (nothing was sent yet). */
export function cancelScheduleRun(paneId: string, scheduleId: string): void {
  patchRuntime('manual', scheduleKey(paneId, scheduleId), null)
}

/** The "Active" switch of one schedule (E8-FR-28): pauses without deleting; resuming re-arms. */
export function setScheduleEnabled(paneId: string, scheduleId: string, enabled: boolean): void {
  const found = findSchedule(paneId, scheduleId)
  if (!found) return
  useAppStore.getState().setPaneSchedule(found.wsId, paneId, scheduleId, withEnabled(found.sched, enabled, Date.now()))
}

/**
 * Drives every console's scheduled prompts (E8-FR-28..31): one 1 s ticker
 * over all panes and their schedules plus the initial prompt outcomes of
 * consoles it mounted.
 */
export function usePaneScheduler(): void {
  useEffect(() => {
    const id = setInterval(() => schedulerTick(), SCHEDULER_TICK_MS)
    const off = window.snApi.pty.onPromptResult((evt) => handleSchedulePromptResult(evt))
    return () => {
      clearInterval(id)
      off()
    }
  }, [])
}
