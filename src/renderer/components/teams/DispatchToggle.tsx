import { useEffect, useState } from 'react'
import { ListChecks } from 'lucide-react'
import { ensureNeeds, openDispatchQueue, pendingQueue, setAutoDispatch, useNeedsStore } from '@/lib/teams/needs'
import { toast } from '@/lib/toast'
import { useT, type TFn } from '@/i18n'
import { cn } from '@/lib/cn'
import { Tooltip } from '@/components/ui/Tooltip'
import { Toggle } from '@/components/settings/ui'

/** Wide enough for the switch's label beside it; narrower (zoom), the switch alone and a tooltip names it. */
const WIDE_QUERY = '(min-width: 1024px)'

function wideNow(query: string): boolean {
  return typeof window === 'undefined' || typeof window.matchMedia !== 'function' || window.matchMedia(query).matches
}

/** Follows `query` (WIDE_QUERY by default) through the media query's own change event (no polling). The header's AutopilotToggle shares it. */
export function useWide(query: string = WIDE_QUERY): boolean {
  const [wide, setWide] = useState(() => wideNow(query))
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(query)
    const on = (): void => setWide(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return wide
}

const PENDING_BTN =
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-btn border border-state-action/60 bg-state-action/15 px-2.5 text-xs font-medium text-state-action transition-colors hover:bg-state-action/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-violet/60'

/**
 * Turns a team's autonomy on or off (the header switch and the sidebar
 * kebab) and says what that means now, which is the hint the switch has no
 * room for: on, runs start on their own within the caps; off, each one waits
 * for the user's OK in Te necesita. True once main applied it.
 */
export async function switchAutoDispatch(teamId: string, on: boolean, t: TFn): Promise<boolean> {
  const fail = await setAutoDispatch(teamId, on)
  if (fail) {
    toast.error(t('teams.dispatch.toggleFailed'), { dedupeKey: `team-autodispatch:${teamId}` })
    return false
  }
  toast.info(t(on ? 'teams.dispatch.onToast' : 'teams.dispatch.offToast'), { dedupeKey: `team-autodispatch:${teamId}` })
  return true
}

/**
 * "Despacho automático" in the team header (app 2.7.0, E10 B4): the switch
 * (`settings {autoDispatch}`; off by default) and, while it is off and runs
 * wait for the user's OK, "N por despachar", which opens Te necesita on its
 * "Por despachar" section. The count is the needs view's (the rank 3 rows of
 * teamNeedsRows), pulled once here and kept current by the needs sync.
 */
export function DispatchToggle({ teamId, on }: { teamId: string; on: boolean }) {
  const t = useT()
  const wide = useWide()
  const [busy, setBusy] = useState(false)
  const pending = useNeedsStore((s) => pendingQueue(s.needs[teamId]).length)
  useEffect(() => {
    ensureNeeds(teamId)
  }, [teamId])
  const label = t('teams.dispatch.auto')
  const flip = (next: boolean): void => {
    setBusy(true)
    void switchAutoDispatch(teamId, next, t).then(() => setBusy(false))
  }
  const sw = <Toggle checked={on} onChange={flip} disabled={busy} ariaLabel={label} />
  return (
    <div data-team-autodispatch={on ? 'on' : 'off'} className="flex shrink-0 items-center gap-1.5">
      {!on && pending > 0 && (
        <button type="button" data-dispatch-pending={pending} onClick={() => openDispatchQueue(teamId)} className={PENDING_BTN}>
          <ListChecks size={13} aria-hidden />
          {t('teams.dispatch.pending', { count: pending })}
        </button>
      )}
      {wide ? (
        // The visible label names the switch (a click on it flips the switch too); no tooltip over a labelled control.
        <label className={cn('flex cursor-pointer items-center gap-1.5 whitespace-nowrap px-1 text-xs text-text-secondary', busy && 'cursor-default')}>
          <span>{label}</span>
          {sw}
        </label>
      ) : (
        <Tooltip label={label} side="bottom" className="shrink-0 px-1">
          {sw}
        </Tooltip>
      )}
    </div>
  )
}
