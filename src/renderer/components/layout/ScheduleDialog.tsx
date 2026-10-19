import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Clock, Play } from 'lucide-react'
import type { PaneSchedule, ScheduleRecurrence } from '@shared/types'
import { isScheduleEnabled, nextDue, parseTime, recentRuns, recurrenceOf, SCHEDULE_HISTORY_SHOWN, validWeeklyDays, waitsForIdle, WEEK_ORDER } from '@shared/schedule'
import { useAppStore } from '@/lib/store'
import { cancelScheduleRun, isManualRunPending, runScheduleNow, RUN_REASON_KEY, RUN_STATUS_KEY, useScheduleRuntime } from '@/lib/usePaneScheduler'
import { DAY_LETTER_KEY, RECURRENCE_KEY, RECURRENCE_KINDS, scheduleNextLabel, weekdayName, type RecurrenceKind } from '@/lib/scheduleFormat'
import { formatSince } from '@/lib/formatSince'
import { Toggle } from '@/components/settings/ui'
import { useLang, useT } from '@/i18n'
import { cn } from '@/lib/cn'

interface ScheduleDialogProps {
  workspaceId: string
  paneId: string
  paneTitle: string
  schedule?: PaneSchedule
  onClose: () => void
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Default the time picker to ~5 minutes out so "now" never auto-fires. */
function defaultTime(): string {
  const d = new Date(Date.now() + 5 * 60_000)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Days a new weekly rule starts with: the current one, else today. */
function initialDays(schedule: PaneSchedule | undefined): number[] {
  const rec = schedule ? recurrenceOf(schedule) : null
  return rec?.kind === 'weekly' ? [...rec.days] : [new Date().getDay()]
}

/** The rule the chips describe; `once` is stored as an absent recurrence. */
function buildRecurrence(kind: RecurrenceKind, days: number[]): ScheduleRecurrence | undefined {
  if (kind === 'once') return undefined
  if (kind === 'weekly') return { kind, days: WEEK_ORDER.filter((d) => days.includes(d)) }
  return { kind }
}

/**
 * Per-console automation (E8-FR-28..31): time, repeat chips (once, daily,
 * Mon-Fri, weekly with day toggles, hourly at a minute), the prompt, "wait
 * for the agent to be free", the Active switch, the last runs and "Run now".
 * Saving recomputes the next run and resets a pending wait; the history is
 * kept. Mounted only while open, so its state always reflects the schedule.
 */
export function ScheduleDialog({
  workspaceId,
  paneId,
  paneTitle,
  schedule,
  onClose,
}: ScheduleDialogProps) {
  const t = useT()
  const lang = useLang()
  const setPaneSchedule = useAppStore((s) => s.setPaneSchedule)
  // The live schedule (history and next run move while the dialog is open).
  const live = useAppStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.panes.find((p) => p.id === paneId)?.schedule) ?? schedule
  const graceMin = useAppStore((s) => s.settings.automation?.scheduleGraceMin ?? 120)
  const runPending = useScheduleRuntime((s) => isManualRunPending(s, paneId))
  const [time, setTime] = useState(schedule?.time ?? defaultTime())
  const [prompt, setPrompt] = useState(schedule?.prompt ?? '')
  const [kind, setKind] = useState<RecurrenceKind>(schedule ? recurrenceOf(schedule).kind : 'once')
  const [days, setDays] = useState<number[]>(() => initialDays(schedule))
  const [waitIdle, setWaitIdle] = useState(schedule ? waitsForIdle(schedule) : true)
  const [enabled, setEnabled] = useState(schedule ? isScheduleEnabled(schedule) : true)
  const [showAll, setShowAll] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  // Relative times of the history stay fresh while the dialog is open.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  // Esc closes only this dialog, never a Settings modal behind it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const parsed = parseTime(time)
  const canSave = parsed !== null && prompt.trim().length > 0 && (kind !== 'weekly' || validWeeklyDays(days))

  const save = (): void => {
    if (!canSave) return
    const recurrence = buildRecurrence(kind, days)
    const next: PaneSchedule = {
      time,
      prompt: prompt.trim(),
      dueAt: nextDue({ time, recurrence }, Date.now()),
      ...(recurrence ? { recurrence } : {}),
      ...(waitIdle ? {} : { waitIdle: false }),
      ...(enabled ? {} : { enabled: false }),
      ...(live?.history?.length ? { history: live.history } : {}),
    }
    setPaneSchedule(workspaceId, paneId, next)
    onClose()
  }
  const remove = (): void => {
    cancelScheduleRun(paneId)
    setPaneSchedule(workspaceId, paneId, null)
    onClose()
  }
  const runNow = (): void => {
    if (runPending) cancelScheduleRun(paneId)
    else runScheduleNow(paneId, prompt)
  }

  const toggleDay = (d: number): void =>
    setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]))

  // Hourly picks only the minute; the hour part of `time` is kept as is.
  const minute = parsed ? parsed.m : 0
  const setMinute = (raw: string): void => {
    const m = Math.min(59, Math.max(0, Number.parseInt(raw, 10) || 0))
    setTime(`${pad(parsed ? parsed.h : 0)}:${pad(m)}`)
  }

  const runs = recentRuns(live?.history)
  const shown = showAll ? runs : runs.slice(0, SCHEDULE_HISTORY_SHOWN)
  const chipCls = (on: boolean): string =>
    cn(
      'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
      on ? 'border-accent-violet bg-accent-violet/15 text-text-primary' : 'border-border text-text-secondary hover:bg-bg-secondary hover:text-text-primary',
    )

  return createPortal(
    <div className="fixed inset-0 z-[75] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="schedule-dialog-title"
        data-schedule-dialog={paneId}
        className="relative z-10 flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-modal border border-border bg-card shadow-[0_20px_48px_-12px_rgba(0,0,0,0.6)]"
      >
        <div className="min-h-0 space-y-4 overflow-y-auto p-5">
          <div className="flex items-center gap-2">
            <Clock size={16} className="text-accent-violet" />
            <h2 id="schedule-dialog-title" className="text-sm font-semibold text-text-primary">{t('schedule.title')}</h2>
          </div>
          <p className="-mt-1 truncate text-xs text-text-secondary">{paneTitle}</p>

          {live && (
            <div
              data-schedule-next
              className={cn(
                'flex items-center gap-2 rounded-btn border px-3 py-2 text-xs',
                isScheduleEnabled(live)
                  ? 'border-accent-violet/30 bg-accent-violet/10 text-text-primary'
                  : 'border-border bg-bg-secondary/60 text-text-secondary',
              )}
            >
              <Clock size={13} className={cn('shrink-0', isScheduleEnabled(live) ? 'text-accent-violet' : 'text-text-secondary/60')} />
              <span className="min-w-0 truncate">{scheduleNextLabel(live, t, lang)}</span>
            </div>
          )}

          <div className="space-y-2">
            <span className="block text-xs font-medium text-text-secondary">{t('schedule.repeat')}</span>
            <div role="radiogroup" aria-label={t('schedule.repeat')} className="flex flex-wrap gap-1.5">
              {RECURRENCE_KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={kind === k}
                  data-schedule-kind={k}
                  onClick={() => setKind(k)}
                  className={chipCls(kind === k)}
                >
                  {t(RECURRENCE_KEY[k])}
                </button>
              ))}
            </div>
            {kind === 'weekly' && (
              <div data-schedule-days className="flex gap-1">
                {WEEK_ORDER.map((d) => (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={days.includes(d)}
                    aria-label={weekdayName(d, lang, 'long')}
                    data-schedule-day={d}
                    onClick={() => toggleDay(d)}
                    className={cn(chipCls(days.includes(d)), 'h-7 w-7 px-0 text-center')}
                  >
                    {t(DAY_LETTER_KEY[d])}
                  </button>
                ))}
              </div>
            )}
            {kind === 'weekly' && days.length === 0 && (
              <p data-schedule-days-error className="text-xs text-red-400">{t('schedule.daysRequired')}</p>
            )}
          </div>

          {kind === 'hourly' ? (
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-text-secondary">{t('schedule.minute')}</span>
              <input
                type="number"
                min={0}
                max={59}
                data-schedule-minute
                value={minute}
                onChange={(e) => setMinute(e.target.value)}
                className="w-28 rounded-btn border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-violet/60"
              />
            </label>
          ) : (
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-text-secondary">{t('schedule.time')}</span>
              <input
                type="time"
                data-schedule-time
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="w-full rounded-btn border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-violet/60"
              />
            </label>
          )}

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-text-secondary">{t('schedule.prompt')}</span>
            <textarea
              autoFocus
              rows={4}
              data-schedule-prompt
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  save()
                }
              }}
              placeholder={t('schedule.promptPlaceholder')}
              className="w-full resize-none rounded-btn border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-violet/60"
            />
          </label>

          <label className="flex cursor-pointer items-start gap-2 text-xs text-text-primary">
            <input
              type="checkbox"
              data-schedule-wait
              checked={waitIdle}
              onChange={(e) => setWaitIdle(e.target.checked)}
              className="mt-0.5 accent-[var(--color-accent-violet)]"
            />
            <span className="min-w-0">
              {t('schedule.waitIdle')}
              <span className="block text-text-secondary/80">{t('schedule.waitIdleHint')}</span>
            </span>
          </label>

          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-text-primary">{t('schedule.enabled')}</span>
            <span data-schedule-enabled>
              <Toggle checked={enabled} onChange={setEnabled} />
            </span>
          </div>

          <p className="text-xs text-text-secondary/80">{t('schedule.hint', { grace: graceMin })}</p>

          {live && (
            <div data-schedule-history className="space-y-1.5 border-t border-border pt-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-text-secondary">{t('schedule.history')}</span>
                <button
                  type="button"
                  data-schedule-run-now
                  disabled={!runPending && !prompt.trim()}
                  onClick={runNow}
                  title={runPending ? t('schedule.runNowCancel') : undefined}
                  className="flex shrink-0 items-center gap-1.5 rounded-btn border border-border px-2.5 py-1 text-xs text-text-primary transition-colors hover:bg-bg-secondary disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Play size={12} className={runPending ? 'animate-pulse text-accent-violet' : undefined} />
                  {runPending ? t('schedule.runNowWaiting') : t('schedule.runNow')}
                </button>
              </div>
              {runs.length === 0 ? (
                <p className="text-xs text-text-secondary/70">{t('schedule.historyEmpty')}</p>
              ) : (
                <ul className="space-y-1">
                  {shown.map((r, i) => (
                    <li key={`${r.at}-${i}`} data-schedule-run={r.status} className="flex items-baseline justify-between gap-3 text-xs">
                      <span className="min-w-0 truncate text-text-primary">
                        {t(RUN_STATUS_KEY[r.status])}
                        {r.reason && <span className="text-text-secondary"> - {t(RUN_REASON_KEY[r.reason])}</span>}
                        {r.trigger === 'manual' && <span className="text-text-secondary"> ({t('schedule.manual')})</span>}
                      </span>
                      <span className="shrink-0 text-text-secondary">{formatSince(r.at, now, lang)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {runs.length > SCHEDULE_HISTORY_SHOWN && (
                <button
                  type="button"
                  data-schedule-show-all
                  onClick={() => setShowAll((v) => !v)}
                  className="text-xs text-accent-violet hover:underline"
                >
                  {showAll ? t('schedule.showLess') : t('schedule.showAll', { count: runs.length })}
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border bg-bg-secondary/40 px-5 py-3">
          {schedule ? (
            <button
              onClick={remove}
              data-schedule-remove
              className="rounded-btn border border-red-400/40 px-3 py-2 text-sm font-medium text-red-400 transition-colors hover:bg-red-400/10"
            >
              {t('schedule.remove')}
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-btn border border-border px-4 py-2 text-sm text-text-primary transition-colors hover:bg-card"
            >
              {t('schedule.cancel')}
            </button>
            <button
              onClick={save}
              data-schedule-save
              disabled={!canSave}
              className="rounded-btn bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] px-4 py-2 text-sm font-medium text-white transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {schedule ? t('schedule.update') : t('schedule.save')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
