import { useEffect } from 'react'
import { useAppStore } from '@/lib/store'
import { useAgentStore } from '@/lib/agentStore'
import { playStatusSound } from '@/lib/sound'
import { visiblePaneIds } from '@shared/status'
import { revealPane } from './revealPane'
import { dismissAgentCardsInView, onAgentStatus } from './agentNotice'
import { AGENT_END_OTHER_CAP_MS, hasPromptMarks, whenPromptReturns } from './shellReady'
import { applyAgentRename } from './agentRename'

/**
 * Wires the Claude status feature on the renderer side. Mounted once inside
 * AppBody, which only renders after hydration, so the first setConfig push
 * carries the persisted settings and never bounces the main-side HookServer
 * with defaults.
 */
export function useStatusEvents(): void {
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const workspaces = useAppStore((s) => s.workspaces)
  const minimized = useAppStore((s) => s.minimized)
  const maximized = useAppStore((s) => s.maximized)
  const notifications = useAppStore((s) => s.settings.notifications)
  // app 2.7.0 (E10 B1): the Teams overlay covers the grid, so no console is in view under it.
  const teamsActive = useAgentStore((s) => s.view === 'teams')

  // Status updates pushed by main. The notify flag carries main's already
  // debounced notification decision, so the sound can never diverge from the
  // desktop toast. `delivery: 'inApp'` turns it into an in-app card instead of
  // the OS notification (E4-FR-07); the sound is unchanged.
  useEffect(() => {
    const changed = new Set<string>()
    let alive = true
    const unsubscribe = window.snApi.status.onState((evt) => {
      changed.add(evt.paneId)
      useAppStore.getState().setPaneStatus(evt)
      const cfg = useAppStore.getState().settings.notifications
      if (evt.notify && cfg.sound) playStatusSound(cfg.soundId, cfg.volume)
      onAgentStatus(evt)
    })
    void window.snApi.status.snapshot().then(events => {
      if (!alive) return
      for (const paneId of Object.keys(useAppStore.getState().paneStatus)) {
        if (!changed.has(paneId) && !events.some(e => e.paneId === paneId)) useAppStore.getState().setPaneStatus({ paneId, state: null, precise: false, notify: false })
      }
      for (const evt of events) if (!changed.has(evt.paneId)) useAppStore.getState().setPaneStatus({ ...evt, notify: false })
    }).catch(() => {})
    return () => { alive = false; unsubscribe() }
  }, [])

  // Claude's main session ended with /exit: offer "resume / new" (E6-FR-22).
  // The chip is drawn by the pane; the setting only hides it, so turning it
  // back on later never shows a stale chip from long ago.
  useEffect(() => {
    const waits = new Map<string, () => void>()
    const off = window.snApi.status.onSessionEnd((evt) => {
      if (useAppStore.getState().settings.terminalAgentEndChip === false) return
      waits.get(evt.paneId)?.()
      waits.delete(evt.paneId)
      // v2.2: `other` is a catch-all (a driver's `claude -p` ending inside a
      // script that keeps running): with shell integration the offer waits
      // for the shell prompt to come back, and never shows without it.
      if (evt.reason === 'other' && hasPromptMarks(evt.paneId)) {
        waits.set(evt.paneId, whenPromptReturns(evt.paneId, evt.at, AGENT_END_OTHER_CAP_MS, () => {
          waits.delete(evt.paneId)
          useAppStore.getState().setAgentEnded(evt)
        }))
        return
      }
      useAppStore.getState().setAgentEnded(evt)
    })
    return () => {
      off()
      for (const cancel of waits.values()) cancel()
    }
  }, [])

  // v2.4: the agent's `/rename` renames its console (agents.syncAgentRename).
  useEffect(() => window.snApi.status.onAgentRename((evt) => { applyAgentRename(evt) }), [])

  // A status notification was clicked: reveal that console (E5-FR-04).
  useEffect(() => {
    return window.snApi.status.onReveal((paneId) => {
      revealPane(paneId)
    })
  }, [])

  // Regaining focus while a workspace is on screen acknowledges its consoles (not under Teams).
  useEffect(() => {
    const onFocus = (): void => {
      const s = useAppStore.getState()
      if (s.activeWorkspaceId && useAgentStore.getState().view !== 'teams') s.markWorkspaceSeen(s.activeWorkspaceId)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  // Tell main which consoles are actually in view (active workspace minus
  // minimized; none under the Teams overlay): its notification rule treats
  // everything else as unseen.
  useEffect(() => {
    const ws = workspaces.find((w) => w.id === activeWorkspaceId)
    const viewed = teamsActive ? [] : visiblePaneIds(ws, activeWorkspaceId ? minimized[activeWorkspaceId] ?? [] : [], activeWorkspaceId ? maximized[activeWorkspaceId] : null)
    window.snApi.status.setViewed(viewed)
    if (!teamsActive && activeWorkspaceId && document.hasFocus()) {
      useAppStore.getState().markWorkspaceSeen(activeWorkspaceId)
      dismissAgentCardsInView(viewed)
    }
  }, [activeWorkspaceId, workspaces, minimized, maximized, teamsActive])

  // Keep main's notify rules + HookServer lifecycle in sync with settings.
  useEffect(() => {
    window.snApi.status.setConfig(notifications)
  }, [notifications])
}
