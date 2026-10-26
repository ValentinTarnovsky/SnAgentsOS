import { useEffect, useRef, useState } from 'react'
import { labOn } from '@shared/labs'
import { useAppStore } from '@/lib/store'
import { useAgentStore } from '@/lib/agentStore'
import { closeTeams, loadTeamView, teamsOverlayActive, useTeamsStore } from '@/lib/teamsStore'
import { useTeamSetupStore } from '@/lib/teams/setup'
import { useTeamTrustStore } from '@/lib/teams/trust'
import { useBoardStore } from '@/lib/teams/board'
import { useT } from '@/i18n'
import { Button } from '@/components/ui/Button'
import { TeamHeader, TeamPlainHeader } from './TeamHeader'
import { TeamBanner } from './TeamBanner'
import { TeamTabs, TEAM_TABPANEL_ID, teamTabId } from './TeamTabs'
import { TeamPicker } from './TeamPicker'
import { NeedsYouTab } from './NeedsYouTab'
import { AgentsRoster } from './AgentsRoster'
import { AgentChatDrawer } from './AgentChatDrawer'
import { TeamBoard } from './TeamBoard'
import { TaskDrawer } from './TaskDrawer'
import { TeamNoteDrawer } from './TeamNoteDrawer'

/**
 * The Teams overlay (app 2.7.0, E10 B1; Labs teams), over the workspace area
 * inside <main> like the shared view: WorkspaceHost stays mounted underneath
 * (no pty remounts) and, while this shows, reports no visible pane, focuses
 * nothing and the pane shortcuts are swallowed (useGlobalKeys). It sits after
 * SharedWorkspaceHost (it covers a shared view) and before AgentsBoard (the
 * board replaces it: both are agentStore views). `data-team-host` marks the
 * area whose focus is the overlay's (the guard in teamsStore).
 *
 * Esc closes it from anywhere while it shows (a document listener, not only
 * the section's own keys: a click that unmounts the focused button leaves the
 * focus on body), unless something else takes that Esc first: a drawer or a
 * dialog inside (defaultPrevented), a modal or a menu, a console, an input
 * outside the overlay. The keyboard comes back to the overlay whenever it is
 * left nowhere: a body swap (picker, team, Retry) or a dialog that closes.
 */
export function TeamHost() {
  const teamsOn = useAppStore((s) => labOn(s.settings, 'teams'))
  const open = useAgentStore((s) => s.view === 'teams')
  if (!teamsOn || !open) return null
  return <HostBody />
}

/** A dialog of the app or of Teams is up: it owns the keyboard (and its Esc). */
function dialogUp(): boolean {
  const app = useAppStore.getState()
  if (app.paletteOpen || app.settingsOpen || app.wizardOpen || app.globalPromptOpen) return true
  if (useTeamSetupStore.getState().open || useTeamTrustStore.getState().teamId !== null || useBoardStore.getState().newTask !== null) return true
  return !!document.querySelector('[aria-modal="true"], [role="menu"]')
}

/** The focused element is gone or nothing has the focus. */
function focusLost(): boolean {
  const a = document.activeElement
  return !a || a === document.body || !a.isConnected
}

/** An Esc that belongs to what it was typed in: a console, a dialog or a menu, an editable field outside the overlay. */
function ownEsc(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement) || target === document.body) return false
  if (target.closest('.xterm, [role="dialog"], [role="menu"]')) return true
  if (target.closest('[data-team-host]')) return false
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
}

function HostBody() {
  const t = useT()
  const openTeamId = useTeamsStore((s) => s.openTeamId)
  const team = useTeamsStore((s) => (s.openTeamId ? s.list.find((x) => x.id === s.openTeamId) : undefined))
  const ready = useTeamsStore((s) => s.ready)
  const view = useTeamsStore((s) => (s.openTeamId ? s.views[s.openTeamId] : undefined))
  const tab = useTeamsStore((s) => s.tab)
  const drawer = useTeamsStore((s) => s.drawer)
  const rootRef = useRef<HTMLElement | null>(null)
  // The team whose `get` did not come (the body offers a retry).
  const [failed, setFailed] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  // The keyboard lands on the overlay when it opens, so Esc and Tab work before any click,
  // and comes back to it after every render that left it nowhere: a dialog over it closed,
  // or the body swapped (the picker button, a picker card or Retry unmounted under the focus).
  const dialogOpen = useAppStore((s) => s.paletteOpen || s.settingsOpen || s.wizardOpen || s.globalPromptOpen)
  const setupOpen = useTeamSetupStore((s) => s.open)
  const trustOpen = useTeamTrustStore((s) => s.teamId !== null)
  const newTaskOpen = useBoardStore((s) => s.newTask !== null)
  const opening = useRef(true)
  useEffect(() => {
    if (dialogOpen || setupOpen || trustOpen || newTaskOpen) return
    if (opening.current || focusLost()) rootRef.current?.focus({ preventScroll: true })
    opening.current = false
  })

  // A portaled dialog or menu that closes (a ConfirmDialog, the kebab menu) leaves the focus on body
  // without a render here: its node leaving <body> brings the keyboard back.
  useEffect(() => {
    const obs = new MutationObserver((records) => {
      if (!records.some((r) => r.removedNodes.length > 0)) return
      if (teamsOverlayActive() && focusLost() && !dialogUp()) rootRef.current?.focus({ preventScroll: true })
    })
    obs.observe(document.body, { childList: true })
    return () => obs.disconnect()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return
      if (!teamsOverlayActive() || dialogUp() || ownEsc(e.target)) return
      e.preventDefault()
      closeTeams()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!openTeamId) return
    let alive = true
    setFailed(null)
    void loadTeamView(openTeamId).then((v) => {
      if (alive && !v) setFailed(openTeamId)
    })
    return () => {
      alive = false
    }
  }, [openTeamId, attempt])

  let body
  if (!openTeamId || (ready && !team)) body = <TeamPicker />
  else if (!team) {
    body = (
      <>
        <TeamPlainHeader title={t('teams.host.pickTitle')} />
        <p className="p-6 text-sm text-text-secondary">{t('teams.host.loading')}</p>
      </>
    )
  } else {
    const trust = view?.trust ?? team.trust
    body = (
      <>
        <TeamHeader team={team} view={view} />
        <TeamBanner teamId={team.id} trust={trust} issues={view?.defIssues ?? []} />
        <TeamTabs tab={tab} running={view?.running ?? team.running} needs={view?.needsCount ?? team.needsCount} />
        {/* The body is the parent of the team drawers (RightDrawer closes on clicks in its parent). */}
        <div role="tabpanel" id={TEAM_TABPANEL_ID} aria-labelledby={teamTabId(tab)} data-team-body={tab} className="relative min-h-0 flex-1">
          {/* The board scrolls inside itself (each column on its own); the other tabs scroll here. */}
          <div className={view && tab === 'board' ? 'h-full overflow-hidden p-4' : 'h-full overflow-y-auto p-6'}>
            {view ? (
              tab === 'agents' ? (
                <AgentsRoster teamId={team.id} />
              ) : tab === 'board' ? (
                <TeamBoard teamId={team.id} view={view} />
              ) : (
                <NeedsYouTab teamId={team.id} view={view} />
              )
            ) : failed === team.id ? (
              <div className="flex flex-col items-start gap-3" data-team-load-failed>
                <p className="text-sm text-text-secondary">{t('teams.host.loadFailed')}</p>
                <Button variant="ghost" size="sm" onClick={() => setAttempt((n) => n + 1)}>
                  {t('teams.host.retry')}
                </Button>
              </div>
            ) : (
              <p className="text-sm text-text-secondary">{t('teams.host.loading')}</p>
            )}
          </div>
          {/* B2: an agent's runs and its "Ejecutar ahora" composer, over any tab. */}
          {view && drawer?.kind === 'agent' && <AgentChatDrawer key={drawer.agentId} teamId={team.id} view={view} drawer={drawer} />}
          {/* B3: one task, over any tab; a click on another card switches it in place (keepOpenOn). */}
          {view && drawer?.kind === 'task' && <TaskDrawer teamId={team.id} view={view} taskId={drawer.taskId} />}
          {/* B7: one team note (the Lead's), over any tab; a click on another note of the panel switches it in place. */}
          {view && drawer?.kind === 'note' && <TeamNoteDrawer teamId={team.id} noteId={drawer.noteId} />}
        </div>
      </>
    )
  }

  return (
    <section
      ref={rootRef}
      data-team-host={openTeamId ?? ''}
      role="region"
      aria-label={t('teams.host.label')}
      tabIndex={-1}
      className="absolute inset-0 z-30 flex flex-col bg-bg-primary outline-none"
    >
      {body}
    </section>
  )
}
