import type { ClaudePaneState, PaneStatus } from '@shared/types'
import { useAppStore, type AppState } from './store'
import { useGitStore } from './gitStore'
import { agentFinished, buildGitTargets, gitChipEnabled, gitKeysForPane } from './gitChip'
import { setKnownPathResolver } from './dragNonce'
import { isListedPath } from './changes'

/**
 * Keeps main's GitService fed (E7-FR-06): the watched targets (derived from
 * the workspaces and the active one), settings.gitChip, and the "agent just
 * finished" nudges (FR-06c). Main's summaries land in useGitStore. Started
 * once the config is hydrated; returns a stop function.
 */
export function startGitSync(): () => void {
  const api = window.snApi.git
  const offUpdate = api.onUpdate((evt) => useGitStore.getState().apply(evt))
  // E7-FR-04: an in-app path drag is only accepted for a file the Changes panel lists right now.
  setKnownPathResolver((abs) => {
    const g = useGitStore.getState()
    return isListedPath(abs, g.files, g.summaries)
  })

  let lastTargets = ''
  let watched = new Set<string>()
  const pushTargets = (s: AppState): void => {
    // Each console's own folder: its agent's (hook cwd) first, else its shell's (OSC 7).
    const paneCwds: Record<string, string> = { ...s.paneCwd }
    for (const [id, st] of Object.entries(s.paneStatus)) if (st.cwd) paneCwds[id] = st.cwd
    const targets = buildGitTargets(s.workspaces, s.activeWorkspaceId, paneCwds, window.snApi.platform)
    const json = JSON.stringify(targets)
    if (json === lastTargets) return
    lastTargets = json
    watched = new Set(targets.map((t) => t.key))
    api.setWatch(targets)
    useGitStore.getState().retain(watched)
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
        if (agentFinished(prevStates.get(pane.id), next.get(pane.id))) for (const k of gitKeysForPane(ws, pane, watched)) keys.add(k)
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
  let prevCwd = initial.paneCwd
  let prevCwdStatus = initial.paneStatus
  const unsub = useAppStore.subscribe((s) => {
    if (s.workspaces !== prevWorkspaces || s.activeWorkspaceId !== prevActive || s.paneCwd !== prevCwd || s.paneStatus !== prevCwdStatus) {
      prevWorkspaces = s.workspaces
      prevActive = s.activeWorkspaceId
      prevCwd = s.paneCwd
      prevCwdStatus = s.paneStatus
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
    setKnownPathResolver(null)
  }
}

/** Ask main for a fresh summary of these targets now (chip click, manual refresh). */
export function refreshGit(keys?: string[]): void {
  window.snApi.git.refresh({ ...(keys ? { keys } : {}), reason: 'manual' })
}
