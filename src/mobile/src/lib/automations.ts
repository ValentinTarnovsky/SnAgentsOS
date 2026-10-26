/**
 * The phone's Automations section (E8-FR-32, v3.1) and the workspace note
 * line (E8-FR-11): whether the screen is open, and the pure helpers its rows
 * and the note line use. The desktop owns the schedules; the phone lists
 * `snapshot.schedules` and sends `scheduleToggle` / `scheduleRun`.
 */
import { create } from 'zustand'
import type { RemoteScheduleInfo, RemoteStateSnapshot } from '@shared/remote-protocol'
import type { ScheduleRunStatus, WorkspaceTaskState } from '@shared/types'
import { formatRunWhen, scheduleKey, WEEK_ORDER } from '@shared/schedule'
import { getLang, t, type MobileMessageKey } from './i18n'
import { isNoReply } from './pending'

interface AutomationsState {
  open: boolean
  setOpen: (open: boolean) => void
}

export const useAutomationsStore = create<AutomationsState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))

export function openAutomations(): void {
  useAutomationsStore.getState().setOpen(true)
}

export function closeAutomations(): void {
  useAutomationsStore.getState().setOpen(false)
}

/** One row of the section: the schedule plus the names it shows. */
export interface AutomationRow {
  schedule: RemoteScheduleInfo
  workspaceName: string
  paneTitle: string
}

/**
 * The row's identity: a console can hold several schedules (app 2.7.0). An
 * older desktop sends no `scheduleId` and one schedule per console, so the
 * console id alone stays unique there.
 */
export function automationKey(schedule: Pick<RemoteScheduleInfo, 'paneId' | 'scheduleId'>): string {
  return scheduleKey(schedule.paneId, schedule.scheduleId ?? '')
}

/**
 * The rows in the desktop's order (sidebar order, then each console's
 * schedules in order). A schedule whose console is no longer in the snapshot
 * is dropped; an older desktop (no `schedules`) lists nothing.
 */
export function automationRows(snapshot: RemoteStateSnapshot | null): AutomationRow[] {
  if (!snapshot?.schedules) return []
  const rows: AutomationRow[] = []
  for (const schedule of snapshot.schedules) {
    const ws = snapshot.workspaces.find((w) => w.id === schedule.workspaceId)
    const pane = ws?.panes.find((p) => p.id === schedule.paneId)
    if (!ws || !pane) continue
    rows.push({ schedule, workspaceName: ws.name, paneTitle: pane.title })
  }
  return rows
}

export const RUN_STATUS_KEY: Record<ScheduleRunStatus, MobileMessageKey> = {
  sent: 'auto.status.sent',
  sent_unconfirmed: 'auto.status.sent_unconfirmed',
  skipped_busy: 'auto.status.skipped_busy',
  missed: 'auto.status.missed',
  failed: 'auto.status.failed',
}

export const TASK_STATE_KEY: Record<WorkspaceTaskState, MobileMessageKey> = {
  todo: 'task.todo',
  doing: 'task.doing',
  review: 'task.review',
  done: 'task.done',
}

const weekdayFormats = new Map<string, Intl.DateTimeFormat>()

/** Short weekday name of a `getDay()` number ("lun" / "Mon"), dot-free. */
export function weekdayName(day: number): string {
  const lang = getLang()
  let f = weekdayFormats.get(lang)
  if (!f) {
    f = new Intl.DateTimeFormat(lang, { weekday: 'short' })
    weekdayFormats.set(lang, f)
  }
  // 2024-01-07 was a Sunday: + day gives that weekday at local noon.
  return f.format(new Date(2024, 0, 7 + day, 12)).replace(/\.$/, '')
}

/**
 * "lun 09:00" / "Mon 09:00" within the next 6 days, else with its date
 * ("dom, 1 nov, 09:00") and the year when it is another: the desktop table's
 * rule (`formatRunWhen`), on the phone clock.
 */
export function formatWhen(at: number, now: number = Date.now()): string {
  return formatRunWhen(at, getLang(), now)
}

/** "Lun-Vie", "Semanal: lun, mie", "Cada hora a los :15", "Cron: 0 9 * * 1-5". */
export function recurrenceText(schedule: Pick<RemoteScheduleInfo, 'recurrence' | 'time' | 'cron'>): string {
  const rec = schedule.recurrence
  // A cron rule (app 2.7.0) shows its expression, from `cron` when the
  // desktop sends it beside the recurrence.
  if (schedule.cron) return t('auto.cron.rule', { expr: schedule.cron })
  switch (rec.kind) {
    case 'cron':
      return t('auto.cron.rule', { expr: rec.expr })
    case 'weekly':
      return t('auto.rec.weeklyDays', { days: WEEK_ORDER.filter((d) => rec.days.includes(d)).map(weekdayName).join(', ') })
    case 'hourly':
      return t('auto.rec.hourlyAt', { minute: schedule.time.split(':')[1] ?? '00' })
    case 'daily':
      return t('auto.rec.daily')
    case 'weekdays':
      return t('auto.rec.weekdays')
    default:
      return t('auto.rec.once')
  }
}

/** "Next: Mon 09:00" ("Next: Sun, Nov 1, 09:00" 6 or more days away) while active, "Paused" otherwise. */
export function nextText(schedule: Pick<RemoteScheduleInfo, 'enabled' | 'dueAt'>, now: number = Date.now()): string {
  return schedule.enabled ? t('auto.next', { when: formatWhen(schedule.dueAt, now) }) : t('auto.paused')
}

/**
 * The toast of a failed scheduleRun / scheduleToggle ack. For a run,
 * `no_schedule` also covers an empty saved prompt; both ctl sit behind the
 * session's token bucket (`rate`, CONTRATOS v3.1), worded like every other
 * request the PC did not answer.
 */
export function automationErrorText(kind: 'scheduleRun' | 'scheduleToggle', error: string | undefined): string {
  if (error === 'not_found') return t('auto.gone')
  if (isNoReply(error)) return t('pending.noReply')
  if (error === 'no_schedule') return t(kind === 'scheduleRun' ? 'auto.noPrompt' : 'auto.gone')
  return t('auto.failed')
}
