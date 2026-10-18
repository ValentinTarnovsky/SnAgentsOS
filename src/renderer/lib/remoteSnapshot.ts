import type { RemotePresetInfo, RemoteStateSnapshot, RemoteWorkspaceInfo } from '@shared/remote-protocol'
import type { GitSummary } from '@shared/git-types'
import { resolveTokens } from '@/themes'
import { type AppState, useAppStore } from './store'
import { getPtyId, onPtyRegistryChange } from './ptyRegistry'
import { useUsageStore } from './usageStore'
import { useAgentStore } from './agentStore'
import { paneResumable } from './agentLaunch'
import { remoteAgentEnded } from './agentEndRun'
import { useGitStore } from './gitStore'
import { gitChipEnabled, remoteGitChip, workspaceGitKey } from './gitChip'
import type { MountedWorkspaces } from './mounting'

/** The presets the phone's console picker lists (E2-FR-10/12): never commands, args or env. */
function remotePresets(presets: AppState['presets']): RemotePresetInfo[] {
  return presets.map((p) => ({ id: p.id, name: p.name, type: p.type, icon: p.icon, color: p.color }))
}

/** Workspaces whose every console is mounted (D4: the 'full' keys); partial mounts do not count. */
export function fullyMountedIds(mounted: MountedWorkspaces, workspaceIds: readonly string[]): string[] {
  return workspaceIds.filter((id) => mounted[id] === 'full')
}

function gitField(summary: GitSummary | undefined): Pick<RemoteWorkspaceInfo, 'git'> {
  const git = remoteGitChip(summary)
  return git ? { git } : {}
}

/** Value signature of what the phone sees of the git summaries (workspace chips only). */
function remoteGitSig(summaries: Record<string, GitSummary>): string {
  const out: Record<string, unknown> = {}
  for (const ws of useAppStore.getState().workspaces) {
    const chip = remoteGitChip(summaries[workspaceGitKey(ws.id)])
    if (chip) out[ws.id] = chip
  }
  return JSON.stringify(out)
}

/** Build the compact desktop-state mirror pushed to phones. */
function buildSnapshot(state: AppState): RemoteStateSnapshot {
  const sessions = useAgentStore.getState().sessions
  const gitSummaries = gitChipEnabled(state.settings) ? useGitStore.getState().summaries : {}
  const workspaces: RemoteWorkspaceInfo[] = state.workspaces.map((ws) => ({
    id: ws.id,
    name: ws.name,
    layoutOrder: ws.layout?.order ?? ws.panes.map((p) => p.id),
    panes: ws.panes.map((pane) => {
      // E6-FR-24: the phone mirrors the desktop's "Claude exited" chip.
      const agentEnded = remoteAgentEnded(state, pane.id)
      return {
        id: pane.id,
        title: pane.title,
        type: pane.type,
        color: pane.color,
        icon: pane.icon,
        // main overrides this authoritatively; it's a best-effort hint here.
        running: getPtyId(pane.id) != null,
        // D10: the phone shows "Relaunch resuming" / "New chat" only when true.
        ...(paneResumable(pane, ws, state.presets, sessions[pane.id]) ? { resumable: true } : {}),
        ...(agentEnded ? { agentEnded } : {}),
      }
    }),
    // E7-FR-09: branch and counts only, never the cwd or the repo root.
    ...gitField(gitSummaries[workspaceGitKey(ws.id)]),
  }))
  return {
    workspaces,
    activeWorkspaceId: state.activeWorkspaceId,
    themeTokens: resolveTokens(state.settings.theme, state.settings.customColors),
    themeName: state.settings.theme,
    language: state.settings.language,
    fontFamily: state.settings.fontFamily,
    fontSize: state.settings.fontSize,
    // E8-FR-07: the phone lists them and runs them by id (runQuickCommand).
    quickCommands: state.quickCommands,
    keyButtons: state.keyButtons,
    // Fields are structurally identical to RemoteUsageSnapshot; passthrough.
    usage: useUsageStore.getState().snapshot ?? null,
    // The phone measures cells with the same table as the desktop (E6-FR-15).
    terminalUnicode: state.settings.terminalUnicode11 === false ? '6' : '11',
    // E2-FR-12: the phone's console picker and its "starts N consoles" confirmation.
    presets: remotePresets(state.presets),
    mountedWorkspaceIds: fullyMountedIds(state.mountedWorkspaces, state.workspaces.map((w) => w.id)),
  }
}

/** The store slices that affect the snapshot; compared by reference to gate pushes. */
function relevant(s: AppState): unknown[] {
  return [
    s.workspaces,
    s.presets,
    s.activeWorkspaceId,
    s.settings.theme,
    s.settings.customColors,
    s.settings.language,
    s.settings.fontFamily,
    s.settings.fontSize,
    s.settings.terminalUnicode11,
    s.quickCommands,
    gitChipEnabled(s.settings),
    s.keyButtons,
    s.mountedWorkspaces,
    // E6-FR-24: the chip's offer and its setting change `agentEnded`.
    s.agentEnded,
    s.settings.terminalAgentEndChip,
  ]
}

/**
 * Push a debounced compact state snapshot to main whenever the mirrored slices
 * (workspaces, active id, theme/language/font) or the pty registry (a pane's
 * `running` flag) change. Pushes once immediately. Returns a stop function.
 */
export function startRemoteSnapshotSync(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let prev = relevant(useAppStore.getState())

  const push = (): void => {
    timer = null
    window.snApi.remote.pushState(buildSnapshot(useAppStore.getState()))
  }
  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(push, 100)
  }

  const unsubStore = useAppStore.subscribe((state) => {
    const next = relevant(state)
    if (next.some((v, i) => v !== prev[i])) {
      prev = next
      schedule()
    }
  })
  const unsubPty = onPtyRegistryChange(schedule)
  // Usage lives in its own store; it only mutates when the snapshot changes, so
  // subscribing directly (no reference gate) won't over-fire.
  const unsubUsage = useUsageStore.subscribe(schedule)
  // Git summaries: gitStore only swaps `summaries` when one changes by value,
  // so a quiet poll never pushes a new state to the phone (E7-FR-09).
  // Only the phone fields of workspace keys count: a staged-only change, a
  // pane worktree or `updatedAt` never reach the phone, so they push nothing.
  let prevGit = useGitStore.getState().summaries
  let prevGitSig = remoteGitSig(prevGit)
  const unsubGit = useGitStore.subscribe((s) => {
    if (s.summaries === prevGit) return
    prevGit = s.summaries
    const sig = remoteGitSig(s.summaries)
    if (sig === prevGitSig) return
    prevGitSig = sig
    schedule()
  })
  // A session becoming (un)resumable changes `resumable`.
  let prevSessions = useAgentStore.getState().sessions
  const unsubAgents = useAgentStore.subscribe((s) => {
    if (s.sessions !== prevSessions) {
      prevSessions = s.sessions
      schedule()
    }
  })

  // Seed main with the current state right away (post-hydrate).
  window.snApi.remote.pushState(buildSnapshot(useAppStore.getState()))

  return () => {
    if (timer) clearTimeout(timer)
    unsubStore()
    unsubPty()
    unsubUsage()
    unsubAgents()
    unsubGit()
  }
}
