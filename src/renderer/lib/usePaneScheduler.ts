import { useEffect } from 'react'
import { create } from 'zustand'
import type { PtyPromptResultEvt } from '@shared/ipc-contract'
import type { AgentPreset, Pane, PaneSchedule, ScheduleRun, ScheduleRunStatus } from '@shared/types'
import { afterRun, decide, isScheduleEnabled, nextOccurrence, withEnabled } from '@shared/schedule'
import { SCHEDULE_WAKE_LEAD_MS } from '@shared/hibernation'
import { PROMPT_READY_TIMEOUT_MS } from '@shared/initialPrompt'
import { translate, type MessageKey } from '@/i18n'
import { useAppStore } from './store'
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

type Trigger = ScheduleRun['trigger']

/** A run already on its way (submit in flight, or a prompt waiting for a spawn). */
export interface ScheduleInflight {
  trigger: Trigger
  /** Occurrence it serves (manual: when it was asked for). */
  scheduledFor: number
  via: 'submit' | 'pending'
  startedAt: number
}

/** A "Run now" request (E8-FR-31): the text it sends and its own wait clock. */
export interface ManualRun {
  text: string
  askedAt: number
  since?: number
}

/**
 * Transient scheduler state (never persisted): pending "Run now" requests and
 * runs in flight, per pane. The dialog reads it for its "Waiting..." button.
 */
interface ScheduleRuntimeState {
  manual: Record<string, ManualRun>
  inflight: Record<string, ScheduleInflight>
}

export const useScheduleRuntime = create<ScheduleRuntimeState>(() => ({ manual: {}, inflight: {} }))

function patchRuntime(key: keyof ScheduleRuntimeState, paneId: string, value: ManualRun | ScheduleInflight | null): void {
  useScheduleRuntime.setState((s) => {
    const next = { ...s[key] } as Record<string, ManualRun | ScheduleInflight>
    if (value) next[paneId] = value
    else if (paneId in next) delete next[paneId]
    else return {}
    return { [key]: next } as Partial<ScheduleRuntimeState>
  })
}

/** True while a pane's "Run now" waits for a free agent or is being sent. */
export function isManualRunPending(state: ScheduleRuntimeState, paneId: string): boolean {
  return paneId in state.manual || state.inflight[paneId]?.trigger === 'manual'
}

/** Claude Code or Codex by the pane's type or its preset (E8-FR-29). */
export function isAgentKind(pane: Pick<Pane, 'type' | 'presetId'>, presets: readonly AgentPreset[]): boolean {
  if (pane.type === 'claude' || pane.type === 'codex') return true
  const preset = pane.presetId ? presets.find((p) => p.id === pane.presetId) : undefined
  return preset?.type === 'claude' || preset?.type === 'codex'
}

function findPane(paneId: string): { wsId: string; pane: Pane } | null {
  for (const ws of useAppStore.getState().workspaces) {
    const pane = ws.panes.find((p) => p.id === paneId)
    if (pane) return { wsId: ws.id, pane }
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

/**
 * Logs one run on the pane's current schedule and ends whatever the runtime
 * held for it. The schedule is re-read here: it may have been edited (a new
 * `dueAt` is kept) or deleted (nothing to log) while the run was in flight.
 */
function finishRun(paneId: string, trigger: Trigger, scheduledFor: number, status: ScheduleRunStatus, reason: ScheduleRun['reason'], now: number): void {
  patchRuntime('inflight', paneId, null)
  if (trigger === 'manual') patchRuntime('manual', paneId, null)
  const found = findPane(paneId)
  const current = found?.pane.schedule
  if (!found || !current) return
  const run: ScheduleRun = { at: now, scheduledFor, trigger, status, ...(reason ? { reason } : {}) }
  useAppStore.getState().setPaneSchedule(found.wsId, paneId, afterRun(current, run, now, scheduledFor))
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
function submitRun(paneId: string, ptyId: string, text: string, trigger: Trigger, scheduledFor: number, now: number): void {
  patchRuntime('inflight', paneId, { trigger, scheduledFor, via: 'submit', startedAt: now })
  void window.snApi.pty
    .submit({ ptyId, paneId, text, enter: true, origin: 'auto', userGate: true })
    .then(
      (res) => {
        const at = Date.now()
        if (res.ok) finishRun(paneId, trigger, scheduledFor, 'sent', undefined, at)
        else if (res.error === 'awaiting_user') finishRun(paneId, trigger, scheduledFor, 'skipped_busy', undefined, at)
        else if (res.error === 'enter_held') finishRun(paneId, trigger, scheduledFor, 'failed', 'enter_held', at)
        else finishRun(paneId, trigger, scheduledFor, 'failed', res.error === 'multiline_unsafe' ? 'multiline_unsafe' : 'not_delivered', at)
      },
      () => finishRun(paneId, trigger, scheduledFor, 'failed', 'not_delivered', Date.now()),
    )
}

/**
 * Outcome of a prompt handed to an unspawned agent console (E8-FR-30): argv
 * or a gate with a precise ready signal count as sent; inserted without
 * Enter is `sent_unconfirmed`; anything else was not delivered.
 */
export function handleSchedulePromptResult(evt: PtyPromptResultEvt, now: number = Date.now()): void {
  const run = useScheduleRuntime.getState().inflight[evt.paneId]
  if (!run || run.via !== 'pending') return
  if (evt.result === 'sent_argv' || evt.result === 'sent_gate') finishRun(evt.paneId, run.trigger, run.scheduledFor, 'sent', undefined, now)
  else if (evt.result === 'inserted_unconfirmed') finishRun(evt.paneId, run.trigger, run.scheduledFor, 'sent_unconfirmed', undefined, now)
  else finishRun(evt.paneId, run.trigger, run.scheduledFor, 'failed', 'not_delivered', now)
}

/** Starts the wait clock of a run that cannot be sent yet (persisted for scheduled runs). */
function startWait(wsId: string, paneId: string, sched: PaneSchedule, manual: ManualRun | undefined, now: number): void {
  if (manual) {
    if (manual.since === undefined) patchRuntime('manual', paneId, { ...manual, since: now })
    return
  }
  if (sched.waitingSince === undefined) useAppStore.getState().setPaneSchedule(wsId, paneId, { ...sched, waitingSince: now })
}

/**
 * One scheduler pass over every console (exported for tests). Per pane with a
 * schedule: a pending "Run now" goes first, else the schedule itself; `decide`
 * says what to do with the pane's live agent state. A due console whose
 * workspace is not mounted mounts alone (E8-FR-30), without activating the
 * workspace or starting its other consoles: an agent console gets the prompt
 * as its initial prompt (argv, or the gate's precise ready signal), a shell
 * console is written to once its pty exists.
 */
export function schedulerTick(now: number = Date.now()): void {
  const runtime = useScheduleRuntime.getState()
  // A prompt handed to a spawn that never came: give up and log it.
  for (const [paneId, run] of Object.entries(runtime.inflight)) {
    if (run.via !== 'pending' || now - run.startedAt < PENDING_DELIVERY_TIMEOUT_MS) continue
    const { pendingPrompts, setPendingPrompt } = useAppStore.getState()
    if (pendingPrompts[paneId]?.source === 'schedule') setPendingPrompt(paneId, null)
    finishRun(paneId, run.trigger, run.scheduledFor, 'failed', 'not_delivered', now)
  }
  // "Run now" requests for a pane (or schedule) that is gone.
  for (const paneId of Object.keys(runtime.manual)) {
    if (!findPane(paneId)?.pane.schedule) patchRuntime('manual', paneId, null)
  }

  // Read after the pass above, which may have rewritten schedules. Each pane
  // is visited once and only writes its own schedule, so the snapshot stays
  // current for the pane being handled; mount state is re-read per pane.
  const app = useAppStore.getState()
  const automation = app.settings.automation
  const graceMin = automation?.scheduleGraceMin ?? 120
  const maxWaitMin = automation?.scheduleMaxWaitMin ?? 30
  for (const ws of app.workspaces) {
    for (const pane of ws.panes) {
      const sched = pane.schedule
      if (!sched) continue
      const rt = useScheduleRuntime.getState()
      if (rt.inflight[pane.id]) continue
      const manual = rt.manual[pane.id]
      const trigger: Trigger = manual ? 'manual' : 'scheduled'
      const ptyId = getPtyId(pane.id)
      const agent = isAgentKind(pane, app.presets)
      // A console woken from sleep is not live for a prompt until its resumed agent is ready (E5-FR-26).
      const sleeping = !!useAgentStore.getState().sleeping[pane.id]
      const live = !!ptyId && !sleeping && !isWaking(pane.id)
      const decision = decide({
        schedule: sched,
        now,
        trigger,
        manualSince: manual?.since,
        status: app.paneStatus[pane.id],
        agent,
        live,
        graceMin,
        maxWaitMin,
      })
      // A sleeping console wakes (resuming its chat) when its run is 30 s away or due, never for a missed one.
      if (sleeping && decision !== 'missed' && (manual || (isScheduleEnabled(sched) && sched.dueAt - now <= SCHEDULE_WAKE_LEAD_MS))) {
        wakePane(pane.id)
        if (decision === 'idle') continue
      }
      const scheduledFor = manual ? manual.askedAt : sched.dueAt
      switch (decision) {
        case 'idle':
          break
        case 'fire':
          if (ptyId) submitRun(pane.id, ptyId, manual ? manual.text : sched.prompt, trigger, scheduledFor, now)
          break
        case 'missed':
          finishRun(pane.id, 'scheduled', sched.dueAt, 'missed', undefined, now)
          break
        case 'skip_busy':
          finishRun(pane.id, trigger, scheduledFor, 'skipped_busy', undefined, now)
          break
        case 'fail_no_agent':
          finishRun(pane.id, trigger, scheduledFor, 'failed', agent ? 'agent_not_running' : 'not_delivered', now)
          break
        case 'wait': {
          const cur = useAppStore.getState()
          const mounted = isPaneMounted(cur.mountedWorkspaces, ws.id, pane.id)
          if (!ptyId && !mounted) {
            if (agent && !cur.pendingPrompts[pane.id]) {
              app.setPendingPrompt(pane.id, { text: manual ? manual.text : sched.prompt, enter: true, source: 'schedule', createdAt: now })
              patchRuntime('inflight', pane.id, { trigger, scheduledFor, via: 'pending', startedAt: now })
              app.ensureMounted(ws.id, { only: [pane.id] })
              break
            }
            app.ensureMounted(ws.id, { only: [pane.id] })
          }
          startWait(ws.id, pane.id, sched, manual, now)
          break
        }
      }
      // A "Run now" holds the pane: a scheduled occurrence that comes due
      // meanwhile starts its own wait clock, so it is served (or skipped as
      // busy) afterwards instead of logged as missed once the grace is over.
      if (manual && sched.waitingSince === undefined) {
        const scheduled = decide({ schedule: sched, now, status: app.paneStatus[pane.id], agent, live: !!ptyId, graceMin, maxWaitMin })
        const cur = findPane(pane.id)?.pane.schedule
        if (scheduled !== 'idle' && scheduled !== 'missed' && cur && cur.dueAt === sched.dueAt && cur.waitingSince === undefined) {
          useAppStore.getState().setPaneSchedule(ws.id, pane.id, { ...cur, waitingSince: now })
        }
      }
    }
  }
}

/**
 * "Run now" (E8-FR-31): fires through the same path with trigger 'manual',
 * honoring "wait for the agent to be free", and never moves `dueAt`. `text`
 * defaults to the saved prompt. False when the pane has no schedule.
 */
export function runScheduleNow(paneId: string, text?: string): boolean {
  const sched = findPane(paneId)?.pane.schedule
  if (!sched) return false
  const prompt = text?.trim() || sched.prompt
  if (!prompt) return false
  const rt = useScheduleRuntime.getState()
  if (rt.manual[paneId] || rt.inflight[paneId]) return true
  patchRuntime('manual', paneId, { text: prompt, askedAt: Date.now() })
  schedulerTick()
  return true
}

/** Cancels a "Run now" that is still waiting (nothing was sent yet). */
export function cancelScheduleRun(paneId: string): void {
  patchRuntime('manual', paneId, null)
}

/** The "Active" switch (E8-FR-28): pauses without deleting; resuming re-arms. */
export function setScheduleEnabled(paneId: string, enabled: boolean): void {
  const found = findPane(paneId)
  if (!found?.pane.schedule) return
  useAppStore.getState().setPaneSchedule(found.wsId, paneId, withEnabled(found.pane.schedule, enabled, Date.now()))
}

/**
 * Drives every console's scheduled prompt (E8-FR-28..31): one 1 s ticker over
 * all panes plus the initial prompt outcomes of consoles it mounted.
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
