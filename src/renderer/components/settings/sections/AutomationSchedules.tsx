import { useEffect, useState } from 'react'
import { Pencil, Play } from 'lucide-react'
import type { Pane, PaneSchedule } from '@shared/types'
import { isScheduleEnabled, paneSchedules, recentRuns, scheduleKey } from '@shared/schedule'
import { useAppStore } from '@/lib/store'
import { isManualRunPending, runScheduleNow, cancelScheduleRun, RUN_STATUS_KEY, setScheduleEnabled, useScheduleRuntime } from '@/lib/usePaneScheduler'
import { formatWhen, recurrenceLabel } from '@/lib/scheduleFormat'
import { formatSince } from '@/lib/formatSince'
import { ScheduleDialog } from '@/components/layout/ScheduleDialog'
import { useLang, useT } from '@/i18n'
import { cn } from '@/lib/cn'
import { inputCls, SettingRow, Toggle, ToggleRow } from '../ui'

const clampInt = (raw: string, min: number, max: number, fallback: number): number => {
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

/** The schedule values of Settings > Automation (E8-FR-29..31). */
export function ScheduleSettings() {
  const t = useT()
  const automation = useAppStore((s) => s.settings.automation)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const patch = (p: Partial<typeof automation>): void =>
    updateSettings({ automation: { ...useAppStore.getState().settings.automation, ...p } })
  return (
    <div className="space-y-5">
      <SettingRow searchId="automation.scheduleGrace" title={t('settings.automation.scheduleGrace')} description={t('settings.automation.scheduleGraceHint')}>
        <input
          type="number"
          min={0}
          max={1440}
          data-automation-grace
          className={cn(inputCls, 'w-28')}
          value={automation.scheduleGraceMin}
          onChange={(e) => patch({ scheduleGraceMin: clampInt(e.target.value, 0, 1440, 120) })}
        />
      </SettingRow>
      <SettingRow searchId="automation.scheduleMaxWait" title={t('settings.automation.scheduleMaxWait')} description={t('settings.automation.scheduleMaxWaitHint')}>
        <input
          type="number"
          min={1}
          max={240}
          data-automation-maxwait
          className={cn(inputCls, 'w-28')}
          value={automation.scheduleMaxWaitMin}
          onChange={(e) => patch({ scheduleMaxWaitMin: clampInt(e.target.value, 1, 240, 30) })}
        />
      </SettingRow>
      <ToggleRow
        searchId="automation.scheduleNotify"
        title={t('settings.automation.scheduleNotify')}
        description={t('settings.automation.scheduleNotifyHint')}
        checked={automation.scheduleNotify}
        onChange={(v) => patch({ scheduleNotify: v })}
      />
    </div>
  )
}

interface ScheduledPane {
  workspaceId: string
  workspaceName: string
  pane: Pane
  schedule: PaneSchedule
}

/**
 * Settings > Automation table (E8-FR-32): every schedule (app 2.7.0: a
 * console can hold several, one row each), in sidebar order, with its repeat
 * rule, next run (or "Paused"), last result, the Active switch, "Run now" and
 * "Edit" (the console's own dialog, open on that schedule).
 */
export function AutomationsTable() {
  const t = useT()
  const lang = useLang()
  const workspaces = useAppStore((s) => s.workspaces)
  const runtime = useScheduleRuntime()
  const [editing, setEditing] = useState<ScheduledPane | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  const rows: ScheduledPane[] = []
  for (const ws of workspaces) {
    for (const pane of ws.panes) {
      for (const schedule of paneSchedules(pane)) rows.push({ workspaceId: ws.id, workspaceName: ws.name, pane, schedule })
    }
  }

  return (
    <div className="space-y-2">
      <div>
        <div className="text-sm font-medium text-text-primary">{t('automation.schedules.title')}</div>
        <p className="mt-0.5 text-xs text-text-secondary">{t('automation.schedules.hint')}</p>
      </div>
      {rows.length === 0 ? (
        <p data-automation-empty className="rounded-btn border border-dashed border-border px-3 py-4 text-center text-xs text-text-secondary">
          {t('automation.schedules.empty')}
        </p>
      ) : (
        <div role="table" aria-label={t('automation.schedules.title')} data-automation-table className="divide-y divide-border rounded-btn border border-border">
          {rows.map((row) => {
            const { workspaceName, pane, schedule: sched } = row
            const active = isScheduleEnabled(sched)
            const last = recentRuns(sched.history)[0]
            const pending = isManualRunPending(runtime, pane.id, sched.id)
            return (
              <div
                role="row"
                key={scheduleKey(pane.id, sched.id)}
                data-automation-row={pane.id}
                data-automation-schedule={sched.id}
                className="flex items-center gap-3 px-3 py-2"
              >
                <div role="cell" className="min-w-0 flex-1">
                  {/* A long workspace name gives way before the console title. */}
                  <div className="flex min-w-0 text-sm" title={`${workspaceName} / ${pane.title}`}>
                    <span className="min-w-0 truncate text-text-secondary">{workspaceName}</span>
                    <span className="shrink-0 whitespace-pre text-text-secondary">{' / '}</span>
                    <span className="min-w-0 max-w-[60%] shrink-0 truncate text-text-primary">{pane.title}</span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-text-secondary">
                    {/* A long cron expression wraps instead of running under the buttons. */}
                    <span data-automation-rec className="min-w-0 break-words">{recurrenceLabel(sched, t, lang)}</span>
                    <span aria-hidden>·</span>
                    <span data-automation-next className={active ? 'text-text-primary' : undefined}>
                      {active ? formatWhen(sched.dueAt, lang, now) : t('schedule.paused')}
                    </span>
                    <span aria-hidden>·</span>
                    <span data-automation-last>
                      {last ? `${t(RUN_STATUS_KEY[last.status])} ${formatSince(last.at, now, lang)}` : t('automation.schedules.never')}
                    </span>
                  </div>
                </div>
                <div role="cell" className="flex shrink-0 items-center gap-1.5">
                  <span data-automation-toggle title={t('automation.schedules.toggle')}>
                    <Toggle checked={active} onChange={(v) => setScheduleEnabled(pane.id, sched.id, v)} />
                  </span>
                  <button
                    type="button"
                    data-automation-run={pane.id}
                    onClick={() => (pending ? cancelScheduleRun(pane.id, sched.id) : runScheduleNow(pane.id, sched.id))}
                    title={pending ? t('schedule.runNowCancel') : undefined}
                    className="flex items-center gap-1 rounded-btn border border-border px-2 py-1 text-xs text-text-primary transition-colors hover:bg-bg-secondary"
                  >
                    <Play size={12} className={pending ? 'animate-pulse text-accent-violet' : undefined} />
                    {pending ? t('schedule.runNowWaiting') : t('schedule.runNow')}
                  </button>
                  <button
                    type="button"
                    data-automation-edit={pane.id}
                    onClick={() => setEditing(row)}
                    aria-label={t('automation.schedules.edit')}
                    title={t('automation.schedules.edit')}
                    className="rounded-btn border border-border p-1.5 text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
                  >
                    <Pencil size={12} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
      {editing && (
        <ScheduleDialog
          workspaceId={editing.workspaceId}
          paneId={editing.pane.id}
          paneTitle={`${editing.workspaceName} / ${editing.pane.title}`}
          scheduleId={editing.schedule.id}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
