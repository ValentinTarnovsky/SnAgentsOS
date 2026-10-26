import { useEffect, useMemo, useRef, useState } from 'react'
import { ListChecks, Play, X } from 'lucide-react'
import type { Language } from '@shared/types'
import type { AgentView, QueueItemView, TeamFail, TeamNeedsView, TeamView } from '@shared/team-protocol'
import { teamNeedsRows } from '@shared/teamNeeds'
import { priorityKey } from '@shared/teamBoard'
import { openTaskDrawer } from '@/lib/teamsStore'
import { busyKey, dispatchQueued, queueFocused, useNeedsStore } from '@/lib/teams/needs'
import { MODE_KEY, TRIGGER_KEY, agentLabel, deferReason, useRosterStore } from '@/lib/teams/roster'
import { clockTime } from '@/lib/statusSignals'
import { toast } from '@/lib/toast'
import { useLang, useT, type TFn } from '@/i18n'
import { cn } from '@/lib/cn'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { RUN_CHIP, RUN_CHIP_NEUTRAL, SMALL_BTN, SMALL_BTN_QUIET, SMALL_BTN_TEXT } from './RunHeader'

/** Despachar todo asks first above this many runs. */
const CONFIRM_ALL_ABOVE = 5
const NO_AGENTS: readonly AgentView[] = []
const SECTION_TITLE = 'text-[11px] font-semibold uppercase tracking-wide text-text-secondary outline-none'

/**
 * What a queued run waits for, in words (never main's code): an item still
 * waiting for the user says what would hold it once dispatched (the gates
 * after the autonomy one, decision 18), an approved one what holds it now.
 */
export function queueLine(item: Pick<QueueItemView, 'approved' | 'defer'>, t: TFn, lang: Language, now: number): string {
  // Autonomy off is this row itself (it waits for the user's OK), never a reason shown on it.
  const d = item.defer && item.defer.reason !== 'autonomyOff' ? item.defer : undefined
  const reason = d ? deferReason(d, t) : ''
  const time = d?.until && d.until > now ? clockTime(d.until, lang, now) : null
  if (item.approved) {
    if (!reason) return t('teams.dispatch.starting')
    return time ? t('teams.dispatch.waitingUntil', { reason, time }) : t('teams.dispatch.waiting', { reason })
  }
  if (!reason) return t('teams.dispatch.ready')
  return time ? t('teams.dispatch.deferredUntil', { reason, time }) : t('teams.dispatch.deferred', { reason })
}

/** A refused Despachar, Descartar or Despachar todo in the catalog's words. */
function dispatchFailText(f: TeamFail, kind: 'go' | 'drop' | 'all', t: TFn): string {
  if (f.error === 'not_found') return t('teams.dispatch.gone')
  if (f.error === 'untrusted') return t('teams.run.fail.untrusted')
  if (f.error === 'disabled') return t('teams.run.fail.disabled')
  return t(kind === 'all' ? 'teams.dispatch.allFailed' : kind === 'go' ? 'teams.dispatch.failed' : 'teams.dispatch.dropFailed')
}

/** Scrolls the nearest scrolling ancestor so `el` sits at its top; nothing else moves (no scrollIntoView). */
function revealAtTop(el: HTMLElement): void {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY
    if (oy !== 'auto' && oy !== 'scroll') continue
    p.scrollTop += el.getBoundingClientRect().top - p.getBoundingClientRect().top - 8
    return
  }
}

function QueueRow({ teamId, item, title, agent, now }: { teamId: string; item: QueueItemView; title?: string; agent: string; now: number }) {
  const t = useT()
  const lang = useLang()
  const goBusy = useNeedsStore((s) => !!s.busy[busyKey(teamId, item.id)] || !!s.busy[busyKey(teamId, 'all')])
  const send = (go: boolean): void => {
    void dispatchQueued(teamId, item.id, go).then((res) => {
      if (!res.ok) toast.error(dispatchFailText(res, go ? 'go' : 'drop', t))
    })
  }
  const reason = item.defer && item.defer.reason !== 'autonomyOff' && deferReason(item.defer, t) ? item.defer.reason : 'none'
  return (
    <li
      // A row waiting for the user's OK is a "Te necesita" row (rank 3); an approved one only waits its turn.
      {...(item.approved ? {} : { 'data-team-need': item.id, 'data-need-kind': 'dispatch' })}
      data-dispatch-row={item.id}
      data-dispatch-approved={item.approved ? 'true' : 'false'}
      className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2 rounded-card border border-border bg-card/40 px-3 py-2.5"
    >
      <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span data-dispatch-agent className="min-w-0 truncate text-sm font-medium text-text-primary">
            {agent}
          </span>
          <span data-dispatch-mode={item.mode} className={cn(RUN_CHIP, RUN_CHIP_NEUTRAL, 'shrink-0')}>
            {t(MODE_KEY[item.mode])}
          </span>
          {item.priority !== 'normal' && (
            <span data-dispatch-priority={item.priority} className={cn(RUN_CHIP, RUN_CHIP_NEUTRAL, 'shrink-0')}>
              {t(priorityKey(item.priority))}
            </span>
          )}
        </div>
        {item.taskId ? (
          <button
            type="button"
            data-dispatch-task={item.taskId}
            onClick={() => openTaskDrawer(item.taskId as string)}
            className="min-w-0 self-start truncate rounded text-left text-xs text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-violet/60"
          >
            <span className="font-mono text-text-secondary">{item.taskId}</span>
            {title ? ` ${title}` : ''}
          </button>
        ) : (
          <span className="text-xs text-text-secondary">{t('teams.dispatch.noTask')}</span>
        )}
        <p className="min-w-0 text-[11px] text-text-secondary">
          {t('teams.run.trigger', { reason: t(TRIGGER_KEY[item.reason]) })} · {t('teams.dispatch.since', { time: clockTime(item.at, lang, now) })}
        </p>
        <p data-dispatch-defer={reason} className="min-w-0 text-xs text-text-primary/90">
          {queueLine(item, t, lang, now)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {!item.approved && (
          <button type="button" data-dispatch-go={item.id} disabled={goBusy} onClick={() => send(true)} className={cn(SMALL_BTN, SMALL_BTN_TEXT)}>
            <Play size={13} aria-hidden />
            {t('teams.dispatch.go')}
          </button>
        )}
        <button type="button" data-dispatch-drop={item.id} disabled={goBusy} onClick={() => send(false)} className={cn(SMALL_BTN, SMALL_BTN_QUIET)}>
          <X size={13} aria-hidden />
          {t('teams.dispatch.drop')}
        </button>
      </div>
    </li>
  )
}

/**
 * "Por despachar" of Te necesita (app 2.7.0, E10 B4): the runs the team wants
 * that wait for the user's OK (autonomy off), in the one "Te necesita" order
 * (teamNeedsRows rank 3: oldest first, then priority), each with its agent,
 * mode, task, why it was asked and what would hold it once dispatched; then
 * the ones already dispatched that wait their turn (caps, a session, a
 * folder). Despachar / Descartar per row, Despachar todo (asks first above 5
 * runs). The header's "N por despachar" brings the keyboard here.
 */
export function DispatchQueue({ teamId, view, needs }: { teamId: string; view: TeamView; needs: TeamNeedsView }) {
  const t = useT()
  const agents = useRosterStore((s) => s.rosters[teamId]?.agents) ?? NO_AGENTS
  const allBusy = useNeedsStore((s) => !!s.busy[busyKey(teamId, 'all')])
  const focus = useNeedsStore((s) => s.focusQueue === teamId)
  const [askAll, setAskAll] = useState(false)
  const headRef = useRef<HTMLHeadingElement | null>(null)
  const names = useMemo(() => new Map(agents.map((a) => [a.id, agentLabel(a)])), [agents])
  const { pending, approved } = useMemo(() => {
    const byId = new Map(needs.queue.map((q) => [q.id, q]))
    const order = teamNeedsRows(needs).filter((r) => r.kind === 'dispatch')
    return {
      pending: order.map((r) => byId.get(r.id)).filter((q): q is QueueItemView => !!q),
      approved: needs.queue.filter((q) => q.approved).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1)),
    }
  }, [needs])
  const now = Date.now()

  // The header's count opened this: the section heading takes the keyboard once (focus without a page scroll).
  useEffect(() => {
    if (!focus) return
    const el = headRef.current
    if (!el) return
    revealAtTop(el)
    el.focus({ preventScroll: true })
    queueFocused(teamId)
  }, [focus, teamId])

  const runAll = (): void => {
    // Main's `approved` names only the items this call approved; the toast still counts the rows shown waiting.
    const shown = new Set(pending.map((q) => q.id))
    void dispatchQueued(teamId, 'all', true).then((res) => {
      if (!res.ok) toast.error(dispatchFailText(res, 'all', t))
      else toast.success(t('teams.dispatch.allDone', { count: res.approved.filter((id) => shown.has(id)).length }))
    })
  }
  const row = (q: QueueItemView) => (
    <QueueRow key={q.id} teamId={teamId} item={q} title={q.taskId ? needs.tasks[q.taskId]?.title : undefined} agent={names.get(q.agentId) ?? q.agentId} now={now} />
  )
  const titleId = `team-dispatch-${teamId}`

  return (
    <section data-dispatch-queue={teamId} aria-labelledby={titleId} className="flex flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <ListChecks size={13} className="shrink-0 text-text-secondary" aria-hidden />
        <h3 ref={headRef} id={titleId} tabIndex={-1} data-dispatch-title className={SECTION_TITLE}>
          {t('teams.dispatch.title')}
        </h3>
        {pending.length > 0 && (
          <span data-dispatch-count={pending.length} className="rounded-full border border-border px-1.5 text-[10px] font-medium leading-4 text-text-secondary">
            {pending.length}
          </span>
        )}
        {pending.length >= 2 && (
          <button
            type="button"
            data-dispatch-all={pending.length}
            disabled={allBusy}
            onClick={() => (pending.length > CONFIRM_ALL_ABOVE ? setAskAll(true) : runAll())}
            className={cn(SMALL_BTN, SMALL_BTN_TEXT, 'ml-auto')}
          >
            <Play size={13} aria-hidden />
            {t('teams.dispatch.all')}
          </button>
        )}
      </div>
      <p data-dispatch-hint={view.autoDispatch ? 'on' : 'off'} className="-mt-1 text-xs text-text-secondary">
        {t(view.autoDispatch ? 'teams.dispatch.hintOn' : 'teams.dispatch.hintOff')}
      </p>
      {pending.length === 0 && approved.length === 0 && (
        <p data-dispatch-empty className="text-sm text-text-secondary">
          {t('teams.dispatch.empty')}
        </p>
      )}
      {pending.length > 0 && <ul className="flex flex-col gap-2">{pending.map(row)}</ul>}
      {approved.length > 0 && (
        <div data-dispatch-approved-list className="flex flex-col gap-2">
          <h4 className="text-xs font-medium text-text-secondary">{t('teams.dispatch.approvedTitle')}</h4>
          <ul className="flex flex-col gap-2">{approved.map(row)}</ul>
        </div>
      )}
      <ConfirmDialog
        open={askAll}
        title={t('teams.dispatch.allTitle', { count: pending.length })}
        message={t('teams.dispatch.allMsg', { max: view.maxConcurrent })}
        confirmLabel={t('teams.dispatch.all')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => {
          setAskAll(false)
          runAll()
        }}
        onCancel={() => setAskAll(false)}
      />
    </section>
  )
}
