import { useState } from 'react'
import { setAutopilot } from '@/lib/teams/needs'
import { toast } from '@/lib/toast'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'
import { Tooltip } from '@/components/ui/Tooltip'
import { Toggle } from '@/components/settings/ui'
import { useWide } from './DispatchToggle'

/** The second labelled switch of the header needs more room than auto dispatch's: narrower, the switch alone and a tooltip. */
const WIDE_QUERY = '(min-width: 1200px)'

/**
 * "Piloto automático" in the team header (app 2.9.0): the switch
 * (`settings {autopilot}`; off by default). On, main approves what Te
 * necesita would ask (plans, final OKs, permissions, hires), answers an
 * agent's question with the option it recommends and integrates a clean
 * merge, a failed one going back to its Dev; turning it on turns auto
 * dispatch on too. The toast says what changed.
 */
export function AutopilotToggle({ teamId, on }: { teamId: string; on: boolean }) {
  const t = useT()
  const wide = useWide(WIDE_QUERY)
  const [busy, setBusy] = useState(false)
  const label = t('teams.autopilot.label')
  const flip = (next: boolean): void => {
    setBusy(true)
    void setAutopilot(teamId, next).then((fail) => {
      setBusy(false)
      if (fail) toast.error(t('teams.autopilot.toggleFailed'), { dedupeKey: `team-autopilot:${teamId}` })
      else toast.info(t(next ? 'teams.autopilot.onToast' : 'teams.autopilot.offToast'), { dedupeKey: `team-autopilot:${teamId}` })
    })
  }
  const sw = <Toggle checked={on} onChange={flip} disabled={busy} ariaLabel={label} />
  return (
    <div data-team-autopilot={on ? 'on' : 'off'} className="flex shrink-0 items-center">
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
