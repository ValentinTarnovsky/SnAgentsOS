/**
 * "Te necesita" of a team on the phone (app 2.7.0, E10 B8): the rows of
 * teamNeedsRows (src/shared/teamNeeds.ts, the one rule the desktop's badge,
 * tab and rows and the Home card count with), grouped by rank: what stops
 * the team, the decisions, and the runs waiting to be dispatched (with
 * "Despachar todo"). Each row is a NeedCard. A row the PC accepted an answer
 * for hides at once; the needs view the PC answers next is the truth.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { CheckCheck, Loader2, Send } from 'lucide-react'
import type { TeamNeedsView } from '@shared/team-protocol'
import { teamNeedsRows, type TeamNeedRow } from '@shared/teamNeeds'
import { PushScreen } from '../PushScreen'
import { NoReply } from '../NoReply'
import { ConfirmSheet, type ConfirmState } from '../ConfirmSheet'
import { NeedCard } from './NeedCard'
import { GHOST_BTN, LoadFailed, Spinner, loadStatusOf, useTeamChange, type Load } from './TeamBits'
import { dispatchFailText, refusalOf, refusalOfAck, replyOf, visibleName } from './teamText'
import { client } from '../../lib/client'
import { closeTeamNeeds, useTeamsUi } from '../../lib/teamsStore'
import { useRemoteStore } from '../../lib/store'
import { t, type MobileMessageKey } from '../../lib/i18n'

/**
 * The needs view of a team, reloaded when the PC says its needs changed, and
 * the rows hidden after an accepted answer until a needs view read after it
 * lands (an older read in flight must not bring them back).
 */
export function useTeamNeeds(teamId: string): {
  needs: Load<TeamNeedsView>
  rows: TeamNeedRow[]
  hide: (ids: readonly string[]) => void
  reload: () => Promise<void>
} {
  const [needs, setNeeds] = useState<Load<TeamNeedsView>>({ status: 'loading', value: null })
  const [hidden, setHidden] = useState<Record<string, number>>({})
  const seq = useRef(0)

  const reload = useCallback(async (): Promise<void> => {
    const n = ++seq.current
    const out = await client.requestTeam({ op: 'needs', teamId })
    if (n !== seq.current) return
    const ok = replyOf(out)
    if (!ok) {
      const status = loadStatusOf(refusalOf(out))
      setNeeds((cur) => ({ status, value: status === 'gone' ? null : cur.value }))
      return
    }
    setNeeds({ status: 'ok', value: ok.needs })
    // A row hidden before this read started is up to this read now.
    setHidden((cur) => {
      const next: Record<string, number> = {}
      for (const [id, at] of Object.entries(cur)) if (at > n) next[id] = at
      return next
    })
  }, [teamId])

  useEffect(() => {
    void reload()
  }, [reload])
  useTeamChange(teamId, 'needs', undefined, () => void reload())

  const hide = useCallback(
    (ids: readonly string[]): void => {
      // Keyed by the next read's seq: only a read started after the answer can show these rows again.
      const at = seq.current + 1
      setHidden((cur) => {
        const next = { ...cur }
        for (const id of ids) next[id] = at
        return next
      })
      void reload()
    },
    [reload],
  )

  const rows = needs.value ? teamNeedsRows(needs.value).filter((r) => hidden[r.id] === undefined) : []
  return { needs, rows, hide, reload }
}

const GROUP_KEY: Record<TeamNeedRow['rank'], MobileMessageKey> = {
  1: 'teams.need.group.block',
  2: 'teams.need.group.decisions',
  3: 'teams.dispatch.title',
}

export function TeamNeedsBody({ teamId }: { teamId: string }): ReactNode {
  const { needs, rows, hide, reload } = useTeamNeeds(teamId)
  const autoDispatch = useTeamsUi((s) => s.list?.find((x) => x.id === teamId)?.autoDispatch)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [allBusy, setAllBusy] = useState(false)
  const [allFail, setAllFail] = useState<string | null>(null)

  if (needs.status === 'gone') return <p className="py-8 text-center text-sm text-text-secondary">{t('teams.board.gone')}</p>
  if (!needs.value) {
    if (needs.status === 'loading') return <Spinner />
    if (needs.status === 'noReply') return <NoReply onRetry={() => void reload()} />
    return <LoadFailed text={t('teams.dispatch.loadFailed')} onRetry={() => void reload()} />
  }
  const view = needs.value
  const dispatchRows = rows.filter((r) => r.kind === 'dispatch')

  // "Despachar todo": the count is the rows shown (the PC answers only the newly approved ids).
  const dispatchAll = (): void => {
    const ids = dispatchRows.map((r) => r.id)
    setConfirm({
      message: t('teams.dispatch.allConfirm', { count: ids.length }),
      onConfirm: () => {
        setAllBusy(true)
        setAllFail(null)
        void client.sendTeamCtl({ kind: 'teamDispatch', teamId, queueId: 'all', go: true }).then((res) => {
          setAllBusy(false)
          if (!res.ok) {
            setAllFail(dispatchFailText(refusalOfAck(res.error), true, true))
            return
          }
          useRemoteStore.getState().setToast(t('teams.dispatch.allDone', { count: ids.length }))
          hide(ids)
        })
      },
    })
  }

  const groups = ([1, 2, 3] as const).map((rank) => ({ rank, rows: rows.filter((r) => r.rank === rank) })).filter((g) => g.rows.length > 0)
  return (
    <div data-team-needs={teamId} data-needs-count={rows.length} className="flex min-w-0 flex-col gap-4 pb-6">
      {needs.status === 'noReply' && <NoReply onRetry={() => void reload()} />}
      {rows.length === 0 && (
        <div data-needs-empty className="flex flex-col items-center gap-2 px-6 py-8 text-center">
          <CheckCheck size={26} className="text-text-secondary/60" aria-hidden />
          <p className="text-sm text-text-secondary">{t('teams.need.empty')}</p>
        </div>
      )}
      {groups.map((g) => (
        <section key={g.rank} data-need-group={g.rank} className="flex min-w-0 flex-col gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="min-w-0 flex-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">{t(GROUP_KEY[g.rank])}</h2>
            {g.rank === 3 && g.rows.length > 1 && (
              <button type="button" data-dispatch-all disabled={allBusy} onClick={dispatchAll} className={GHOST_BTN}>
                {allBusy ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
                {t('teams.dispatch.all')}
              </button>
            )}
          </div>
          {g.rank === 3 && autoDispatch === false && <p className="px-1 text-[11px] text-text-secondary">{t('teams.dispatch.hintOff')}</p>}
          {g.rank === 3 && allFail && (
            <p role="alert" data-need-error className="px-1 text-xs text-state-error">
              {allFail}
            </p>
          )}
          {g.rows.map((row) => (
            <NeedCard key={row.id} teamId={teamId} row={row} needs={view} onDone={(id) => hide([id])} />
          ))}
        </section>
      ))}
      <ConfirmSheet state={confirm} onClose={() => setConfirm(null)} />
    </div>
  )
}

export function TeamNeedsScreen(): ReactNode {
  const teamId = useTeamsUi((s) => s.needsFor)
  const name = useTeamsUi((s) => (s.needsFor ? s.list?.find((x) => x.id === s.needsFor)?.name : undefined))
  const title = name ? `${t('teams.need.title')} - ${visibleName(name)}` : t('teams.need.title')
  return (
    <PushScreen id="team-needs" open={teamId != null} onClose={closeTeamNeeds} title={title} toastBottom={16}>
      {teamId && <TeamNeedsBody key={teamId} teamId={teamId} />}
    </PushScreen>
  )
}
