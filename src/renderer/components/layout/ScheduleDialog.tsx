import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Clock, Play, Plus, Trash2 } from 'lucide-react'
import type { PaneSchedule, ScheduleRecurrence } from '@shared/types'
import { CRON_EXPR_MAX, CRON_MIN_INTERVAL_MIN, nextRuns, parseCron } from '@shared/cron'
import {
  cronRuleError,
  formatRunDate,
  isScheduleEnabled,
  nextDue,
  nextScheduleId,
  PANE_SCHEDULES_MAX,
  parseTime,
  recentRuns,
  recurrenceOf,
  SCHEDULE_HISTORY_SHOWN,
  validWeeklyDays,
  waitsForIdle,
  WEEK_ORDER,
} from '@shared/schedule'
import { useAppStore } from '@/lib/store'
import { cancelScheduleRun, isManualRunPending, runScheduleNow, RUN_REASON_KEY, RUN_STATUS_KEY, setScheduleEnabled, useScheduleRuntime } from '@/lib/usePaneScheduler'
import { DAY_LETTER_KEY, formatWhen, RECURRENCE_KEY, RECURRENCE_KINDS, recurrenceLabel, weekdayName, type RecurrenceKind } from '@/lib/scheduleFormat'
import { formatSince } from '@/lib/formatSince'
import { Toggle } from '@/components/settings/ui'
import { Tooltip } from '@/components/ui/Tooltip'
import { useLang, useT, type MessageKey } from '@/i18n'
import { cn } from '@/lib/cn'

interface ScheduleDialogProps {
  workspaceId: string
  paneId: string
  paneTitle: string
  /** The schedule to open on (the header clock's next run, a Settings row); else the console's first. */
  scheduleId?: string
  onClose: () => void
}

const NO_SCHEDULES: PaneSchedule[] = []

const pad = (n: number): string => String(n).padStart(2, '0')

/** Default the time picker to ~5 minutes out so "now" never auto-fires. */
function defaultTime(): string {
  const d = new Date(Date.now() + 5 * 60_000)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The editor's fields for one schedule; a new one starts once, ~5 min out, active. */
interface Draft {
  time: string
  prompt: string
  kind: RecurrenceKind
  /** Weekly days: the current rule's, else today. */
  days: number[]
  /** The "Advanced (cron)" expression, kept while another chip is picked. */
  cron: string
  waitIdle: boolean
  enabled: boolean
}

function draftOf(schedule: PaneSchedule | undefined): Draft {
  const rec = schedule ? recurrenceOf(schedule) : null
  return {
    time: schedule?.time ?? defaultTime(),
    prompt: schedule?.prompt ?? '',
    kind: rec?.kind ?? 'once',
    days: rec?.kind === 'weekly' ? [...rec.days] : [new Date().getDay()],
    cron: rec?.kind === 'cron' ? rec.expr : '',
    waitIdle: schedule ? waitsForIdle(schedule) : true,
    enabled: schedule ? isScheduleEnabled(schedule) : true,
  }
}

/** The rule the editor describes; `once` is stored as an absent recurrence, cron trimmed to single spaces. */
function buildRecurrence(d: Draft): ScheduleRecurrence | undefined {
  if (d.kind === 'once') return undefined
  if (d.kind === 'weekly') return { kind: 'weekly', days: WEEK_ORDER.filter((x) => d.days.includes(x)) }
  if (d.kind === 'cron') return { kind: 'cron', expr: parseCron(d.cron)?.expr ?? d.cron.trim() }
  return { kind: d.kind }
}

/** What the chips say as a cron line: where an empty "Advanced (cron)" field starts. */
function cronFromChips(d: Draft): string {
  const t = parseTime(d.time) ?? { h: 9, m: 0 }
  if (d.kind === 'hourly') return `${t.m} * * * *`
  if (d.kind === 'weekdays') return `${t.m} ${t.h} * * 1-5`
  if (d.kind === 'weekly' && d.days.length > 0) return `${t.m} ${t.h} * * ${WEEK_ORDER.filter((x) => d.days.includes(x)).join(',')}`
  return `${t.m} ${t.h} * * *`
}

type CronError = NonNullable<ReturnType<typeof cronRuleError>>

const CRON_ERROR_KEY: Record<CronError, MessageKey> = {
  invalid: 'schedule.cron.errParse',
  never: 'schedule.cron.errImpossible',
  interval: 'schedule.cron.errInterval',
}

/**
 * Per-console automations (E8-FR-28..31; app 2.7.0: up to PANE_SCHEDULES_MAX
 * per console). The list on top holds the console's schedules, each with its
 * rule and next run, its own Active switch and Delete (both act at once,
 * like the Settings table); picking one loads it into the editor, "Add
 * schedule" starts a new one. The editor: time, repeat chips (once, daily,
 * Mon-Fri, weekly with day toggles, hourly at a minute, "Advanced (cron)"
 * with inline validation and the next 3 runs), the prompt, "wait for the
 * agent to be free", the last runs and "Run now". Saving recomputes the next
 * run and resets a pending wait; the history is kept. Mounted only while open.
 */
export function ScheduleDialog({
  workspaceId,
  paneId,
  paneTitle,
  scheduleId,
  onClose,
}: ScheduleDialogProps) {
  const t = useT()
  const lang = useLang()
  const setPaneSchedule = useAppStore((s) => s.setPaneSchedule)
  // The live list (history, next runs and switches move while the dialog is open).
  const schedules = useAppStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.panes.find((p) => p.id === paneId)?.schedules) ?? NO_SCHEDULES
  const graceMin = useAppStore((s) => s.settings.automation?.scheduleGraceMin ?? 120)
  // The schedule in the editor; null = a new one, not saved yet.
  const [selected, setSelected] = useState<string | null>(() =>
    schedules.find((s) => s.id === scheduleId)?.id ?? schedules[0]?.id ?? null,
  )
  const live = selected === null ? undefined : schedules.find((s) => s.id === selected)
  const [draft, setDraft] = useState<Draft>(() => draftOf(live))
  const runPending = useScheduleRuntime((s) => selected !== null && isManualRunPending(s, paneId, selected))
  const [showAll, setShowAll] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const promptRef = useRef<HTMLTextAreaElement>(null)

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

  const edit = (patch: Partial<Draft>): void => setDraft((d) => ({ ...d, ...patch }))
  const select = (id: string | null): void => {
    setSelected(id)
    setDraft(draftOf(id === null ? undefined : schedules.find((s) => s.id === id)))
    setShowAll(false)
    promptRef.current?.focus()
  }

  // A schedule deleted elsewhere (Settings, the phone) while it is open here.
  useEffect(() => {
    if (selected !== null && !live) select(schedules[0]?.id ?? null)
  })

  // Inline cron check, on an edit of the field or the chip only: never per
  // tick (cronMinIntervalOk is not cheap), so the 3 runs are as of that edit.
  const cronCheck = useMemo(() => {
    if (draft.kind !== 'cron' || !draft.cron.trim()) return null
    const at = Date.now()
    const error = cronRuleError(draft.cron, at)
    return { error, runs: error ? [] : nextRuns(draft.cron, at, 3) }
  }, [draft.kind, draft.cron])

  const newId = selected === null ? nextScheduleId(schedules) : null
  const id = selected ?? newId
  const parsed = parseTime(draft.time)
  const ruleOk =
    draft.kind === 'cron'
      ? cronCheck !== null && cronCheck.error === null
      : parsed !== null && (draft.kind !== 'weekly' || validWeeklyDays(draft.days))
  const canSave = id !== null && ruleOk && draft.prompt.trim().length > 0

  const save = (): void => {
    if (!canSave || id === null) return
    const recurrence = buildRecurrence(draft)
    // A saved schedule's Active switch is its list row's, which acts at once.
    const enabled = live ? isScheduleEnabled(live) : draft.enabled
    const next: PaneSchedule = {
      id,
      time: draft.time,
      prompt: draft.prompt.trim(),
      dueAt: nextDue({ time: draft.time, recurrence }, Date.now()),
      ...(recurrence ? { recurrence } : {}),
      ...(draft.waitIdle ? {} : { waitIdle: false }),
      ...(enabled ? {} : { enabled: false }),
      ...(live?.history?.length ? { history: live.history } : {}),
    }
    setPaneSchedule(workspaceId, paneId, id, next)
    onClose()
  }
  const remove = (sid: string): void => {
    cancelScheduleRun(paneId, sid)
    setPaneSchedule(workspaceId, paneId, sid, null)
    if (sid === selected) select(schedules.find((s) => s.id !== sid)?.id ?? null)
  }
  const runNow = (): void => {
    if (selected === null) return
    if (runPending) cancelScheduleRun(paneId, selected)
    else runScheduleNow(paneId, selected, draft.prompt)
  }

  const pickKind = (kind: RecurrenceKind): void =>
    setDraft((d) => ({ ...d, kind, cron: kind === 'cron' && !d.cron.trim() ? cronFromChips(d) : d.cron }))
  const toggleDay = (day: number): void =>
    setDraft((d) => ({ ...d, days: d.days.includes(day) ? d.days.filter((x) => x !== day) : [...d.days, day] }))

  // Hourly picks only the minute; the hour part of `time` is kept as is.
  const minute = parsed ? parsed.m : 0
  const setMinute = (raw: string): void => {
    const m = Math.min(59, Math.max(0, Number.parseInt(raw, 10) || 0))
    edit({ time: `${pad(parsed ? parsed.h : 0)}:${pad(m)}` })
  }

  const runs = recentRuns(live?.history)
  const shown = showAll ? runs : runs.slice(0, SCHEDULE_HISTORY_SHOWN)
  const full = schedules.length >= PANE_SCHEDULES_MAX
  const chipCls = (on: boolean): string =>
    cn(
      'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
      on ? 'border-accent-violet bg-accent-violet/15 text-text-primary' : 'border-border text-text-secondary hover:bg-bg-secondary hover:text-text-primary',
    )
  const itemCls = (on: boolean): string =>
    cn('flex items-center gap-2 rounded-btn border px-2.5 py-1.5', on ? 'border-accent-violet/50 bg-accent-violet/10' : 'border-border')

  return createPortal(
    <div className="fixed inset-0 z-[75] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="schedule-dialog-title"
        data-schedule-dialog={paneId}
        data-schedule-editing={selected ?? 'new'}
        className="relative z-10 flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-modal border border-border bg-card shadow-[0_20px_48px_-12px_rgba(0,0,0,0.6)]"
      >
        <div className="min-h-0 space-y-4 overflow-y-auto p-5">
          <div className="flex items-center gap-2">
            <Clock size={16} className="text-accent-violet" />
            <h2 id="schedule-dialog-title" className="text-sm font-semibold text-text-primary">{t('schedule.title')}</h2>
          </div>
          <p className="-mt-1 truncate text-xs text-text-secondary">{paneTitle}</p>

          {schedules.length > 0 && (
            <div className="space-y-1.5">
              <span className="block text-xs font-medium text-text-secondary">{t('schedule.list')}</span>
              <ul data-schedule-list className="space-y-1">
                {schedules.map((s) => {
                  const on = isScheduleEnabled(s)
                  return (
                    <li key={s.id} data-schedule-item={s.id} data-enabled={on} className={itemCls(s.id === selected)}>
                      <button
                        type="button"
                        aria-pressed={s.id === selected}
                        data-schedule-select={s.id}
                        onClick={() => select(s.id)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <span data-schedule-item-rec className="block truncate text-xs text-text-primary">{recurrenceLabel(s, t, lang)}</span>
                        <span data-schedule-item-next className="block truncate text-[11px] text-text-secondary">
                          {on ? formatWhen(s.dueAt, lang) : t('schedule.paused')}
                        </span>
                      </button>
                      <span data-schedule-item-toggle>
                        <Toggle checked={on} onChange={(v) => setScheduleEnabled(paneId, s.id, v)} ariaLabel={t('schedule.enabled')} />
                      </span>
                      <Tooltip label={t('schedule.delete')}>
                        <button
                          type="button"
                          aria-label={t('schedule.delete')}
                          data-schedule-delete={s.id}
                          onClick={() => remove(s.id)}
                          className="rounded-btn p-1.5 text-text-secondary transition-colors hover:bg-red-400/10 hover:text-red-400"
                        >
                          <Trash2 size={13} />
                        </button>
                      </Tooltip>
                    </li>
                  )
                })}
                {selected === null && (
                  <li data-schedule-item="new" className={cn(itemCls(true), 'text-xs text-text-primary')}>
                    {t('schedule.newItem')}
                  </li>
                )}
              </ul>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-schedule-add
                  disabled={full || selected === null}
                  onClick={() => select(null)}
                  className="flex items-center gap-1.5 rounded-btn border border-border px-2.5 py-1 text-xs text-text-primary transition-colors hover:bg-bg-secondary disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Plus size={13} />
                  {t('schedule.add')}
                </button>
                {full && <span data-schedule-full className="text-xs text-text-secondary">{t('schedule.addMax', { max: PANE_SCHEDULES_MAX })}</span>}
              </div>
            </div>
          )}

          <div className="space-y-2">
            <span className="block text-xs font-medium text-text-secondary">{t('schedule.repeat')}</span>
            <div role="radiogroup" aria-label={t('schedule.repeat')} className="flex flex-wrap gap-1.5">
              {[...RECURRENCE_KINDS.filter((k) => k !== 'cron'), 'cron' as const].map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={draft.kind === k}
                  data-schedule-kind={k}
                  onClick={() => pickKind(k)}
                  className={chipCls(draft.kind === k)}
                >
                  {k === 'cron' ? t('schedule.cron.advanced') : t(RECURRENCE_KEY[k])}
                </button>
              ))}
            </div>
            {draft.kind === 'weekly' && (
              <div data-schedule-days className="flex gap-1">
                {WEEK_ORDER.map((d) => (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={draft.days.includes(d)}
                    aria-label={weekdayName(d, lang, 'long')}
                    data-schedule-day={d}
                    onClick={() => toggleDay(d)}
                    className={cn(chipCls(draft.days.includes(d)), 'h-7 w-7 px-0 text-center')}
                  >
                    {t(DAY_LETTER_KEY[d])}
                  </button>
                ))}
              </div>
            )}
            {draft.kind === 'weekly' && draft.days.length === 0 && (
              <p data-schedule-days-error className="text-xs text-red-400">{t('schedule.daysRequired')}</p>
            )}
          </div>

          {draft.kind === 'cron' ? (
            <div className="space-y-1.5">
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-text-secondary">{t('schedule.cron.label')}</span>
                <input
                  type="text"
                  spellCheck={false}
                  autoComplete="off"
                  maxLength={CRON_EXPR_MAX}
                  data-schedule-cron
                  aria-invalid={cronCheck?.error ? true : undefined}
                  aria-describedby="schedule-cron-hint"
                  value={draft.cron}
                  onChange={(e) => edit({ cron: e.target.value })}
                  className={cn(
                    'w-full rounded-btn border bg-bg-primary px-3 py-2 font-mono text-sm text-text-primary outline-none',
                    cronCheck?.error ? 'border-red-400/60 focus:border-red-400' : 'border-border focus:border-accent-violet/60',
                  )}
                />
              </label>
              <p id="schedule-cron-hint" className="text-xs text-text-secondary/80">{t('schedule.cron.hint')}</p>
              {cronCheck?.error && (
                <p data-schedule-cron-error={cronCheck.error} className="text-xs text-red-400">
                  {t(CRON_ERROR_KEY[cronCheck.error], { min: CRON_MIN_INTERVAL_MIN })}
                </p>
              )}
              {cronCheck && !cronCheck.error && (
                <div data-schedule-cron-runs className="text-xs">
                  <span className="text-text-secondary">{t('schedule.cron.next')}</span>
                  <ul className="mt-0.5 space-y-0.5">
                    {cronCheck.runs.map((at) => (
                      <li key={at} data-schedule-cron-run={at} className="tabular-nums text-text-primary">{formatRunDate(at, lang)}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : draft.kind === 'hourly' ? (
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
                value={draft.time}
                onChange={(e) => edit({ time: e.target.value })}
                className="w-full rounded-btn border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-violet/60"
              />
            </label>
          )}

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-text-secondary">{t('schedule.prompt')}</span>
            <textarea
              ref={promptRef}
              autoFocus
              rows={4}
              data-schedule-prompt
              value={draft.prompt}
              onChange={(e) => edit({ prompt: e.target.value })}
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
              checked={draft.waitIdle}
              onChange={(e) => edit({ waitIdle: e.target.checked })}
              className="mt-0.5 accent-[var(--color-accent-violet)]"
            />
            <span className="min-w-0">
              {t('schedule.waitIdle')}
              <span className="block text-text-secondary/80">{t('schedule.waitIdleHint')}</span>
            </span>
          </label>

          {!live && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-text-primary">{t('schedule.enabled')}</span>
              <span data-schedule-enabled>
                <Toggle checked={draft.enabled} onChange={(v) => edit({ enabled: v })} />
              </span>
            </div>
          )}

          <p className="text-xs text-text-secondary/80">{t('schedule.hint', { grace: graceMin })}</p>

          {live && (
            <div data-schedule-history className="space-y-1.5 border-t border-border pt-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-text-secondary">{t('schedule.history')}</span>
                <button
                  type="button"
                  data-schedule-run-now
                  disabled={!runPending && !draft.prompt.trim()}
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

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-bg-secondary/40 px-5 py-3">
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
            {live ? t('schedule.update') : t('schedule.save')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
