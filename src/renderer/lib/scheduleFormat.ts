/**
 * Display text of pane automations (E8-FR-28..32), shared by the pane header
 * clock, the schedule dialog and Settings > Automation. Pure: no store.
 */
import type { Language, PaneSchedule, ScheduleRecurrence } from '@shared/types'
import { isScheduleEnabled, recurrenceOf, WEEK_ORDER } from '@shared/schedule'
import type { MessageKey, TFn } from '@/i18n'

export type RecurrenceKind = ScheduleRecurrence['kind']

/** Chip order of the dialog. */
export const RECURRENCE_KINDS: readonly RecurrenceKind[] = ['once', 'daily', 'weekdays', 'weekly', 'hourly']

export const RECURRENCE_KEY: Record<RecurrenceKind, MessageKey> = {
  once: 'schedule.rec.once',
  daily: 'schedule.rec.daily',
  weekdays: 'schedule.rec.weekdays',
  weekly: 'schedule.rec.weekly',
  hourly: 'schedule.rec.hourly',
}

/** One-letter day toggles, by `Date.getDay()` (0 = Sunday). */
export const DAY_LETTER_KEY: Record<number, MessageKey> = {
  0: 'schedule.day.0',
  1: 'schedule.day.1',
  2: 'schedule.day.2',
  3: 'schedule.day.3',
  4: 'schedule.day.4',
  5: 'schedule.day.5',
  6: 'schedule.day.6',
}

const weekdayFormats = new Map<string, Intl.DateTimeFormat>()

function weekdayFormat(lang: Language, style: 'short' | 'long'): Intl.DateTimeFormat {
  const key = `${lang}:${style}`
  let f = weekdayFormats.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(lang, { weekday: style })
    weekdayFormats.set(key, f)
  }
  return f
}

/** Weekday name of a `getDay()` number ("lun" / "Mon"), lower-case dot-free in Spanish. */
export function weekdayName(day: number, lang: Language, style: 'short' | 'long' = 'short'): string {
  // 2024-01-07 was a Sunday: + day gives that weekday at local noon.
  return weekdayFormat(lang, style).format(new Date(2024, 0, 7 + day, 12)).replace(/\.$/, '')
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** "lun 09:00" / "Mon 09:00" for an epoch-ms time (local clock). */
export function formatWhen(at: number, lang: Language): string {
  const d = new Date(at)
  return `${weekdayName(d.getDay(), lang)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** "Lun-Vie", "Semanal: lun, mie", "Cada hora (:15)". */
export function recurrenceLabel(schedule: Pick<PaneSchedule, 'recurrence' | 'time'>, t: TFn, lang: Language): string {
  const rec = recurrenceOf(schedule)
  if (rec.kind === 'weekly') {
    const days = WEEK_ORDER.filter((d) => rec.days.includes(d)).map((d) => weekdayName(d, lang))
    return t('schedule.rec.weeklyDays', { days: days.join(', ') })
  }
  if (rec.kind === 'hourly') return t('schedule.rec.hourlyAt', { minute: schedule.time.split(':')[1] ?? '00' })
  return t(RECURRENCE_KEY[rec.kind])
}

/**
 * The header clock tooltip and the table's "next run" (E8-FR-28):
 * "Proxima: lun 09:00 (Lun-Vie)" while active, "Pausada" when paused.
 */
export function scheduleNextLabel(schedule: PaneSchedule, t: TFn, lang: Language): string {
  if (!isScheduleEnabled(schedule)) return t('schedule.paused')
  return t('schedule.next', { when: formatWhen(schedule.dueAt, lang), rec: recurrenceLabel(schedule, t, lang) })
}
