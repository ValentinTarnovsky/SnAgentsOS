/**
 * The phone's Automations section (E8-FR-32, v3.1) and the workspace note
 * line (E8-FR-11): whether the screen is open, and the pure helpers its rows
 * and the note line use. The desktop owns the schedules; the phone lists
 * `snapshot.schedules` and sends `scheduleToggle` / `scheduleRun`.
 */
import { create } from 'zustand'
import type { RemoteScheduleInfo, RemoteStateSnapshot } from '@shared/remote-protocol'
import type { ScheduleRunStatus, WorkspaceTaskState } from '@shared/types'
import { WEEK_ORDER } from '@shared/schedule'
import { getLang, t, type MobileMessageKey } from './i18n'

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
 * The rows in the desktop's order (sidebar order). A schedule whose console
 * is no longer in the snapshot is dropped; an older desktop (no `schedules`)
 * lists nothing.
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

const pad = (n: number): string => String(n).padStart(2, '0')

/** "lun 09:00" / "Mon 09:00", the desktop table's format (phone clock). */
export function formatWhen(at: number): string {
  const d = new Date(at)
  return `${weekdayName(d.getDay())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** "Lun-Vie", "Semanal: lun, mie", "Cada hora a los :15". */
export function recurrenceText(schedule: Pick<RemoteScheduleInfo, 'recurrence' | 'time'>): string {
  const rec = schedule.recurrence
  switch (rec.kind) {
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

/** "Next: Mon 09:00" while active, "Paused" otherwise. */
export function nextText(schedule: Pick<RemoteScheduleInfo, 'enabled' | 'dueAt'>): string {
  return schedule.enabled ? t('auto.next', { when: formatWhen(schedule.dueAt) }) : t('auto.paused')
}

/** The toast of a failed scheduleRun / scheduleToggle ack. */
export function automationErrorText(error: string | undefined): string {
  if (error === 'not_found' || error === 'no_schedule') return t('auto.gone')
  if (error === 'no_prompt') return t('auto.noPrompt')
  return t('auto.failed')
}
