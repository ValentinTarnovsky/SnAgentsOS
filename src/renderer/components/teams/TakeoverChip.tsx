import { useEffect, useState } from 'react'
import { ArrowUpRight, SquareTerminal, Undo2, Users } from 'lucide-react'
import { isActiveRun } from '@shared/teams'
import type { AgentView } from '@shared/team-protocol'
import { useT, type TFn } from '@/i18n'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { useAppStore } from '@/lib/store'
import { useTeamsStore } from '@/lib/teamsStore'
import { revealPane } from '@/lib/revealPane'
import {
  askRelease,
  closeReleaseConfirm,
  releaseFailNotice,
  releaseToTeam,
  takeOverAgent,
  takeoverFailText,
  takeoverFailTone,
  takeoverKey,
  useTakeoverStore,
} from '@/lib/teams/takeover'
import { Tooltip } from '@/components/ui/Tooltip'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { SMALL_BTN, SMALL_BTN_TEXT } from './RunHeader'

/** The drawer header's icon buttons (RightDrawer's own look). */
const ICON_BTN =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-btn text-text-secondary transition-colors hover:bg-card hover:text-text-primary disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-violet/60'

/** "Devolver al Equipo" from the chip or the pane menu: mid turn it says to wait (nothing is sent), else it asks first. */
export function requestRelease(paneId: string, t: TFn): void {
  const r = askRelease(paneId)
  if (r === 'busy') toast.warning(t('teams.takeover.releaseBusy'))
  else if (r === 'gone') toast.error(t('teams.takeover.releaseGone'))
}

/**
 * The chip of a console that took over a team agent (app 2.7.0, E10 B9), in
 * the pane header next to the cache chip: "Equipo Front, Dev 2" and the
 * "Devolver al Equipo" button. Null unless the team list names this pane.
 * Its confirm lives outside the header (TakeoverReleaseConfirm), so no click
 * in the dialog reaches the header's double click or middle click.
 */
export function TakeoverChip({ paneId }: { paneId: string }) {
  const t = useT()
  const ref = useTeamsStore((s) => s.takeovers[paneId])
  const releasing = useTakeoverStore((s) => !!s.releasing[paneId])
  if (!ref) return null
  const label = t('teams.takeover.chip', { team: ref.teamName, agent: ref.agentName })
  return (
    // Like the branch chip, the label gives way before the title does (down to nothing); the button always stays.
    <span
      data-takeover-chip={paneId}
      data-takeover-agent={ref.agentId}
      className="flex min-w-[24px] max-w-[220px] items-center gap-0.5 overflow-hidden rounded border border-border pl-1 text-[10px] leading-4 text-text-secondary [flex-shrink:999]"
    >
      <Tooltip label={t('teams.takeover.chipTip', { team: ref.teamName, agent: ref.agentName })} side="bottom" className="flex min-w-0 items-center gap-1 overflow-hidden">
        <Users size={10} className="shrink-0" aria-hidden />
        <span data-takeover-label className="min-w-0 truncate">
          {label}
        </span>
      </Tooltip>
      <Tooltip label={t('teams.takeover.release')} side="bottom" className="flex shrink-0">
        <button
          type="button"
          draggable={false}
          data-takeover-release={paneId}
          aria-label={t('teams.takeover.release')}
          disabled={releasing}
          onClick={(e) => {
            e.stopPropagation()
            requestRelease(paneId, t)
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          className="flex rounded p-0.5 transition-colors hover:bg-bg-secondary hover:text-text-primary disabled:pointer-events-none disabled:opacity-50"
        >
          <Undo2 size={13} />
        </button>
      </Tooltip>
    </span>
  )
}

/**
 * The confirm of "Devolver al Equipo" for one console: main closes it (after
 * checking it is not mid turn) and the agent goes back to its team, whose
 * next run continues this conversation. Mounted once per pane cell.
 */
export function TakeoverReleaseConfirm({ paneId }: { paneId: string }) {
  const t = useT()
  const ref = useTeamsStore((s) => s.takeovers[paneId])
  const open = useTakeoverStore((s) => s.confirm === paneId)
  // The team let go of the console meanwhile (closed by hand, Labs off): nothing is left to confirm.
  useEffect(() => {
    if (open && !ref) closeReleaseConfirm()
  }, [open, ref])
  const agent = ref?.agentName ?? ''
  return (
    <ConfirmDialog
      open={open && !!ref}
      title={t('teams.takeover.releaseTitle', { agent })}
      message={t('teams.takeover.releaseMsg', { agent })}
      confirmLabel={t('teams.takeover.releaseYes')}
      cancelLabel={t('common.cancel')}
      danger
      onConfirm={() => {
        closeReleaseConfirm()
        // The name of this render: by the reply (notHeld) the team list may no longer name the console.
        void releaseToTeam(paneId).then((fail) => {
          if (!fail) return
          const { tone, text } = releaseFailNotice(fail, agent, t)
          toast[tone](text)
        })
      }}
      onCancel={closeReleaseConfirm}
    />
  )
}

/**
 * "Tomar el control" of an agent (its card, `card`; its drawer header,
 * `icon`), or "Ir a la consola" once a console holds it. A running agent asks
 * first (its run stops); an idle one opens at once. While this takeover is on
 * its way (a run stopping, the console binding) it waits, disabled. A takeover
 * still waiting for a console this window is not opening (the stop outlived
 * main's wait, a restart) can be asked again: main hands its session to that
 * retry (K2). Nothing for a retired agent, nor for any other takeover phase.
 */
export function TakeoverButton({ teamId, agent: a, name, variant }: { teamId: string; agent: AgentView; name: string; variant: 'card' | 'icon' }) {
  const t = useT()
  const [asking, setAsking] = useState(false)
  const taking = useTakeoverStore((s) => !!s.taking[takeoverKey(teamId, a.id)])
  const consolePane = a.takeover?.paneId
  const paneHere = useAppStore((s) => !!consolePane && s.workspaces.some((w) => w.panes.some((p) => p.id === consolePane)))
  if (consolePane && paneHere) {
    const label = t('teams.takeover.goConsole')
    const go = (): void => void revealPane(consolePane)
    return variant === 'icon' ? (
      <Tooltip label={label} side="bottom">
        <button type="button" data-agent-goto-console={a.id} aria-label={label} onClick={go} className={ICON_BTN}>
          <ArrowUpRight size={15} />
        </button>
      </Tooltip>
    ) : (
      <button type="button" data-agent-goto-console={a.id} onClick={go} className={cn(SMALL_BTN, SMALL_BTN_TEXT)}>
        <ArrowUpRight size={13} aria-hidden />
        {label}
      </button>
    )
  }
  const waiting = a.takeover?.phase === 'bindPending'
  if (a.retired || ((a.takeover || a.status === 'takenOver') && !waiting && !taking)) return null
  const running = !waiting && !!a.run && isActiveRun(a.run.state)
  const take = (): void => {
    void takeOverAgent(teamId, a.id).then((fail) => {
      if (!fail) return
      toast[takeoverFailTone(fail)](takeoverFailText(fail, name, t))
    })
  }
  const label = taking ? t('teams.takeover.taking') : t('teams.takeover.take')
  const onClick = (): void => (running ? setAsking(true) : take())
  return (
    <>
      {variant === 'icon' ? (
        <Tooltip label={t('teams.takeover.takeTip', { agent: name })} side="bottom">
          <button type="button" data-agent-takeover={a.id} aria-label={label} disabled={taking} onClick={onClick} className={ICON_BTN}>
            <SquareTerminal size={15} />
          </button>
        </Tooltip>
      ) : (
        <Tooltip label={t('teams.takeover.takeTip', { agent: name })} className="flex shrink-0">
          <button type="button" data-agent-takeover={a.id} disabled={taking} onClick={onClick} className={cn(SMALL_BTN, SMALL_BTN_TEXT)}>
            <SquareTerminal size={13} aria-hidden />
            {label}
          </button>
        </Tooltip>
      )}
      <ConfirmDialog
        open={asking}
        title={t('teams.takeover.confirmTitle', { agent: name })}
        message={t('teams.takeover.confirmMsg', { agent: name })}
        confirmLabel={t('teams.takeover.confirmYes')}
        cancelLabel={t('common.cancel')}
        danger
        onConfirm={() => {
          setAsking(false)
          take()
        }}
        onCancel={() => setAsking(false)}
      />
    </>
  )
}
