import type { ClaudePaneState, PaneStatus } from '@shared/types'
import { useAppStore, type AppState } from './store'
import { useGitStore } from './gitStore'
import { agentFinished, buildGitTargets, gitChipEnabled, gitKeysForPane } from './gitChip'

/**
 * Keeps main's GitService fed (E7-FR-06): the watched targets (derived from
 * the workspaces and the active one), settings.gitChip, and the "agent just
 * finished" nudges (FR-06c). Main's summaries land in useGitStore. Started
 * once the config is hydrated; returns a stop function.
 */
export function startGitSync(): () => void {
  const api = window.snApi.git
  const offUpdate = api.onUpdate((evt) => useGitStore.getState().apply(evt))

  let lastTargets = ''
  const pushTargets = (s: AppState): void => {
    const targets = buildGitTargets(s.workspaces, s.activeWorkspaceId)
    const json = JSON.stringify(targets)
    if (json === lastTargets) return
    lastTargets = json
    api.setWatch(targets)
    useGitStore.getState().retain(new Set(targets.map((t) => t.key)))
  }

  let lastChip: boolean | null = null
  const pushConfig = (s: AppState): void => {
    const on = gitChipEnabled(s.settings)
    if (on === lastChip) return
    lastChip = on
    api.setConfig({ gitChip: on })
  }

  const states = (status: Record<string, PaneStatus>): Map<string, ClaudePaneState> => {
    const m = new Map<string, ClaudePaneState>()
    for (const [id, st] of Object.entries(status)) m.set(id, st.state)
    return m
  }
  let prevStatus = useAppStore.getState().paneStatus
  let prevStates = states(prevStatus)
  const nudgeFinished = (s: AppState): void => {
    if (s.paneStatus === prevStatus) return
    prevStatus = s.paneStatus
    const next = states(s.paneStatus)
    const keys = new Set<string>()
    for (const ws of s.workspaces) {
      for (const pane of ws.panes) {
        if (agentFinished(prevStates.get(pane.id), next.get(pane.id))) for (const k of gitKeysForPane(ws, pane)) keys.add(k)
      }
    }
    prevStates = next
    if (keys.size) api.refresh({ keys: [...keys], reason: 'agent' })
  }

  const initial = useAppStore.getState()
  pushConfig(initial)
  pushTargets(initial)
  void useGitStore.getState().loadInfo()

  let prevWorkspaces = initial.workspaces
  let prevActive = initial.activeWorkspaceId
  let prevSettings = initial.settings
  const unsub = useAppStore.subscribe((s) => {
    if (s.workspaces !== prevWorkspaces || s.activeWorkspaceId !== prevActive) {
      prevWorkspaces = s.workspaces
      prevActive = s.activeWorkspaceId
      pushTargets(s)
    }
    if (s.settings !== prevSettings) {
      prevSettings = s.settings
      pushConfig(s)
    }
    nudgeFinished(s)
  })

  return () => {
    unsub()
    offUpdate()
  }
}

/** Ask main for a fresh summary of these targets now (chip click, manual refresh). */
export function refreshGit(keys?: string[]): void {
  window.snApi.git.refresh({ ...(keys ? { keys } : {}), reason: 'manual' })
}
