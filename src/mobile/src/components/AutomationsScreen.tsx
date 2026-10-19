/**
 * Automations (E8-FR-32, v3.1), a pushed screen opened from the Home header
 * (while the PC has one) and from Settings. One card per console with a
 * schedule, in the desktop's order: workspace / console, repeat rule, next run
 * (or "Paused"), the last result, the Active switch (`scheduleToggle`) and
 * "Run now" (`scheduleRun`, the desktop's manual run: it waits for a free
 * agent and never moves the next run). Editing stays on the PC.
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
  const last = schedule.last
  return (
    <div
      data-auto-row={schedule.paneId}
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
        <span data-auto-rec>{recurrenceText(schedule)}</span>
        <span aria-hidden>·</span>
        <span data-auto-next className={enabled ? 'text-text-primary' : undefined}>
          {nextText({ enabled, dueAt: schedule.dueAt })}
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
  // Switch values the desktop has not confirmed yet, by pane.
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
      for (const paneId of Object.keys(prev)) {
        const sched = snapshot?.schedules?.find((s) => s.paneId === paneId)
        if (!sched || sched.enabled === prev[paneId]) {
          delete next[paneId]
          changed = true
        }
      }
      return changed ? next : prev
    })
    setNow(Date.now())
  }, [snapshot])

  const patch = (set: typeof setRunning, paneId: string, on: boolean): void =>
    set((prev) => {
      const next = { ...prev }
      if (on) next[paneId] = true
      else delete next[paneId]
      return next
    })

  const toggle = async (row: AutomationRow, enabled: boolean): Promise<void> => {
    const { workspaceId, paneId } = row.schedule
    setOverrides((prev) => ({ ...prev, [paneId]: enabled }))
    patch(setToggling, paneId, true)
    const res = await client.sendCtl({ kind: 'scheduleToggle', workspaceId, paneId, enabled })
    patch(setToggling, paneId, false)
    if (res.ok) return
    setOverrides((prev) => {
      const next = { ...prev }
      delete next[paneId]
      return next
    })
    store.getState().setToast(automationErrorText(res.error))
  }

  const run = async (row: AutomationRow): Promise<void> => {
    const { workspaceId, paneId } = row.schedule
    // A second tap before the re-render must not ask twice.
    if (inFlight.current.has(paneId)) return
    inFlight.current.add(paneId)
    patch(setRunning, paneId, true)
    const res = await client.sendCtl({ kind: 'scheduleRun', workspaceId, paneId })
    inFlight.current.delete(paneId)
    patch(setRunning, paneId, false)
    store.getState().setToast(res.ok ? t('auto.runStarted', { pane: row.paneTitle }) : automationErrorText(res.error))
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
        const paneId = row.schedule.paneId
        return (
          <AutomationCard
            key={paneId}
            row={row}
            now={now}
            enabled={overrides[paneId] ?? row.schedule.enabled}
            toggling={!!toggling[paneId]}
            running={!!running[paneId]}
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
