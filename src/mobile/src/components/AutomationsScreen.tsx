/**
 * Automations (E8-FR-32, v3.1), a pushed screen opened from the Home header
 * (while the PC has one) and from Settings. One card per schedule (a console
 * can hold several since app 2.7.0), in the desktop's order: workspace /
 * console, repeat rule (a cron rule shows its expression), next run (or
 * "Paused"), the last result, the Active switch (`scheduleToggle`) and "Run
 * now" (`scheduleRun`, the desktop's manual run: it waits for a free agent
 * and never moves the next run). Both carry the card's `scheduleId` when the
 * desktop sent one; an older desktop acts on the console's only schedule.
 * Editing stays on the PC.
 *
 * The switch flips at once and holds that value until the desktop's next
 * snapshot agrees or the ack fails (then it snaps back with a toast). "Run
 * now" spins until the ack; the desktop's `runPending` then shows "Waiting..."
 * for as long as its run waits for the agent.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { Clock, Loader2, Play } from 'lucide-react'
import { PushScreen } from './PushScreen'
import { store, useRemoteStore } from '../lib/store'
import { client } from '../lib/client'
import { historyAgo } from '../lib/history'
import { STATUS_TICK_MS } from '../lib/statusText'
import {
  automationErrorText,
  automationKey,
  automationRows,
  closeAutomations,
  nextText,
  recurrenceText,
  RUN_STATUS_KEY,
  useAutomationsStore,
  type AutomationRow,
} from '../lib/automations'
import { t } from '../lib/i18n'

function ActiveSwitch({ checked, busy, onChange }: { checked: boolean; busy: boolean; onChange: (on: boolean) => void }): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={t('auto.active')}
      data-auto-toggle
      disabled={busy}
      onClick={() => onChange(!checked)}
      className="flex min-h-11 items-center gap-2 rounded-btn px-2 text-xs text-text-secondary active:bg-card disabled:opacity-60"
    >
      <span>{t('auto.active')}</span>
      <span className={clsx('relative h-6 w-10 shrink-0 rounded-full transition-colors', checked ? 'bg-accent-violet' : 'bg-border')}>
        <span className={clsx('absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
      </span>
    </button>
  )
}

function AutomationCard({
  row,
  now,
  enabled,
  toggling,
  running,
  onToggle,
  onRun,
}: {
  row: AutomationRow
  now: number
  enabled: boolean
  toggling: boolean
  running: boolean
  onToggle: (on: boolean) => void
  onRun: () => void
}): ReactNode {
  const { schedule, workspaceName, paneTitle } = row
  const pending = !!schedule.runPending
  const last = schedule.lastRun
  return (
    <div
      data-auto-row={schedule.paneId}
      data-auto-schedule={schedule.scheduleId}
      data-enabled={enabled}
      className="flex flex-col gap-1 rounded-card border border-border bg-bg-secondary px-3 pb-1 pt-2.5"
    >
      {/* A long workspace name gives way before the console title (desktop table rule). */}
      <div className="flex min-w-0 text-sm" title={`${workspaceName} / ${paneTitle}`}>
        <span data-auto-ws className="min-w-0 truncate text-text-secondary">{workspaceName}</span>
        <span className="shrink-0 whitespace-pre text-text-secondary">{' / '}</span>
        <span data-auto-pane className="min-w-0 max-w-[60%] shrink-0 truncate font-medium text-text-primary">{paneTitle}</span>
      </div>
      <div className="flex flex-wrap gap-x-2 text-[11px] leading-snug text-text-secondary">
        {/* A long cron expression wraps instead of widening the card. */}
        <span data-auto-rec className="min-w-0 break-words">{recurrenceText(schedule)}</span>
        <span aria-hidden>·</span>
        <span data-auto-next className={enabled ? 'text-text-primary' : undefined}>
          {nextText({ enabled, dueAt: schedule.dueAt }, now)}
        </span>
        <span aria-hidden>·</span>
        <span data-auto-last>{last ? t('auto.last', { status: t(RUN_STATUS_KEY[last.status]), age: historyAgo(last.at, now) }) : t('auto.never')}</span>
      </div>
      <div className="flex items-center justify-end gap-1">
        <ActiveSwitch checked={enabled} busy={toggling} onChange={onToggle} />
        <button
          type="button"
          data-auto-run={schedule.paneId}
          data-pending={pending || undefined}
          disabled={running || pending}
          aria-busy={running || undefined}
          title={pending ? t('auto.waitingHint') : undefined}
          onClick={onRun}
          className="flex min-h-11 items-center gap-1.5 rounded-btn border border-border px-3 text-xs font-medium text-text-primary active:bg-card disabled:opacity-70"
        >
          {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} className={pending ? 'animate-pulse text-accent-violet' : undefined} />}
          {pending ? t('auto.waiting') : t('auto.runNow')}
        </button>
      </div>
    </div>
  )
}

/** The screen body, mountable without the PushScreen chrome (tests). */
export function AutomationsBody(): ReactNode {
  const snapshot = useRemoteStore((s) => s.snapshot)
  const rows = automationRows(snapshot)
  // Switch values the desktop has not confirmed yet, by `automationKey`.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const [toggling, setToggling] = useState<Record<string, boolean>>({})
  const [running, setRunning] = useState<Record<string, boolean>>({})
  const inFlight = useRef(new Set<string>())
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), STATUS_TICK_MS)
    return () => clearInterval(id)
  }, [])

  // A snapshot that agrees with an override (or drops its schedule) retires it.
  useEffect(() => {
    setOverrides((prev) => {
      const next = { ...prev }
      let changed = false
      for (const key of Object.keys(prev)) {
        const sched = snapshot?.schedules?.find((s) => automationKey(s) === key)
        if (!sched || sched.enabled === prev[key]) {
          delete next[key]
          changed = true
        }
      }
      return changed ? next : prev
    })
    setNow(Date.now())
  }, [snapshot])

  const patch = (set: typeof setRunning, key: string, on: boolean): void =>
    set((prev) => {
      const next = { ...prev }
      if (on) next[key] = true
      else delete next[key]
      return next
    })

  const toggle = async (row: AutomationRow, enabled: boolean): Promise<void> => {
    const { workspaceId, paneId, scheduleId } = row.schedule
    const key = automationKey(row.schedule)
    setOverrides((prev) => ({ ...prev, [key]: enabled }))
    patch(setToggling, key, true)
    const res = await client.sendCtl({ kind: 'scheduleToggle', workspaceId, paneId, ...(scheduleId ? { scheduleId } : {}), enabled })
    patch(setToggling, key, false)
    if (res.ok) return
    setOverrides((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
    store.getState().setToast(automationErrorText('scheduleToggle', res.error))
  }

  const run = async (row: AutomationRow): Promise<void> => {
    const { workspaceId, paneId, scheduleId } = row.schedule
    const key = automationKey(row.schedule)
    // A second tap before the re-render must not ask twice.
    if (inFlight.current.has(key)) return
    inFlight.current.add(key)
    patch(setRunning, key, true)
    const res = await client.sendCtl({ kind: 'scheduleRun', workspaceId, paneId, ...(scheduleId ? { scheduleId } : {}) })
    inFlight.current.delete(key)
    patch(setRunning, key, false)
    store.getState().setToast(res.ok ? t('auto.runStarted', { pane: row.paneTitle }) : automationErrorText('scheduleRun', res.error))
  }

  if (rows.length === 0) {
    return (
      <div data-auto-empty className="flex flex-col items-center gap-3 px-4 py-10 text-center">
        <Clock size={28} className="text-text-secondary" />
        <p className="text-sm leading-relaxed text-text-secondary">{t('auto.empty')}</p>
      </div>
    )
  }
  return (
    <div data-auto-list className="flex flex-col gap-2">
      {rows.map((row) => {
        const key = automationKey(row.schedule)
        return (
          <AutomationCard
            key={key}
            row={row}
            now={now}
            enabled={overrides[key] ?? row.schedule.enabled}
            toggling={!!toggling[key]}
            running={!!running[key]}
            onToggle={(on) => void toggle(row, on)}
            onRun={() => void run(row)}
          />
        )
      })}
    </div>
  )
}

export function AutomationsScreen(): ReactNode {
  const open = useAutomationsStore((s) => s.open)
  return (
    <PushScreen id="automations" open={open} onClose={closeAutomations} title={t('auto.title')}>
      <AutomationsBody />
    </PushScreen>
  )
}
