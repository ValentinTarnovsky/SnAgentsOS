import type { RemotePaneInfo, RemotePresetInfo, RemoteScheduleInfo, RemoteStateSnapshot, RemoteWorkspaceInfo } from '@shared/remote-protocol'
import type { GitSummary } from '@shared/git-types'
import type { Workspace } from '@shared/types'
import { isScheduleEnabled, paneSchedules, recentRuns, recurrenceOf, waitsForIdle } from '@shared/schedule'
import { isTaskState, normalizeWorkspaceNote } from '@shared/workspaceNote'
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
import { useStatusLines } from './statusLineStore'
import { isManualRunPending, useScheduleRuntime } from './usePaneScheduler'
import { liveSidebarOrder, useSidebarFreeze } from './sidebarOrder'

/** Longest `snaos status` line the phone gets (E8-FR-19, same cap as the CLI). */
export const REMOTE_STATUS_LINE_MAX = 120

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

/** E8-FR-11 (v3.1): the note and task state the phone shows, normalized again on the way out. */
function noteFields(ws: Workspace): Pick<RemoteWorkspaceInfo, 'note' | 'taskState'> {
  const note = normalizeWorkspaceNote(ws.note)
  return { ...(note ? { note } : {}), ...(isTaskState(ws.taskState) ? { taskState: ws.taskState } : {}) }
}

/** E8-FR-19 (v3.1): one line, control characters out, at most 120. */
function statusLineField(line: string | undefined): Pick<RemotePaneInfo, 'statusLine'> {
  if (typeof line !== 'string') return {}
  // eslint-disable-next-line no-control-regex
  const text = line.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, REMOTE_STATUS_LINE_MAX)
  return text ? { statusLine: text } : {}
}

/**
 * E8-FR-32 (v3.1): every console automation in sidebar order, for the phone's
 * Automations section. The prompt and the history stay on the desktop; only
 * the last run travels. App 2.7.0: one info per schedule of a console (in its
 * stored order), with its `scheduleId` and, for a cron rule, `cron`.
 * Exported for tests.
 */
export function remoteSchedules(workspaces: readonly Workspace[], pendingRun: (paneId: string, scheduleId: string) => boolean): RemoteScheduleInfo[] {
  const out: RemoteScheduleInfo[] = []
  for (const ws of workspaces) {
    for (const pane of ws.panes) {
      for (const sched of paneSchedules(pane)) {
        const last = recentRuns(sched.history)[0]
        const recurrence = recurrenceOf(sched)
        out.push({
          workspaceId: ws.id,
          paneId: pane.id,
          scheduleId: sched.id,
          time: sched.time,
          recurrence,
          ...(recurrence.kind === 'cron' ? { cron: recurrence.expr } : {}),
          dueAt: sched.dueAt,
          enabled: isScheduleEnabled(sched),
          waitIdle: waitsForIdle(sched),
          ...(last ? { lastRun: { at: last.at, status: last.status, trigger: last.trigger } } : {}),
          ...(pendingRun(pane.id, sched.id) ? { runPending: true } : {}),
        })
      }
    }
  }
  return out
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

/**
 * The workspaces in the order the sidebar shows them (favorites first, the
 * manual drag order or the smart order and its freeze), so the phone lists
 * them exactly like the desktop.
 */
function phoneOrder(state: AppState): Workspace[] {
  return liveSidebarOrder(state, useAgentStore.getState())
}

/** Value signature of the sidebar order: a smart reorder pushes, a status change that keeps the order does not. */
function orderSig(state: AppState): string {
  return phoneOrder(state).map((w) => w.id).join(',')
}

/** Build the compact desktop-state mirror pushed to phones. */
function buildSnapshot(state: AppState): RemoteStateSnapshot {
  const sessions = useAgentStore.getState().sessions
  const gitSummaries = gitChipEnabled(state.settings) ? useGitStore.getState().summaries : {}
  const statusLines = useStatusLines.getState().lines
  const runtime = useScheduleRuntime.getState()
  const ordered = phoneOrder(state)
  const workspaces: RemoteWorkspaceInfo[] = ordered.map((ws) => ({
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
        ...statusLineField(statusLines[pane.id]),
      }
    }),
    // E7-FR-09: branch and counts only, never the cwd or the repo root.
    ...gitField(gitSummaries[workspaceGitKey(ws.id)]),
    ...noteFields(ws),
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
    mountedWorkspaceIds: fullyMountedIds(state.mountedWorkspaces, ordered.map((w) => w.id)),
    schedules: remoteSchedules(ordered, (paneId, scheduleId) => isManualRunPending(runtime, paneId, scheduleId)),
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
    s.settings.agents?.sidebarSort,
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

  // The sidebar order also moves with the agent states (smart order) and the
  // sidebar freeze, which live in other stores: compared by value.
  let prevOrder = orderSig(useAppStore.getState())
  const checkOrder = (): void => {
    const sig = orderSig(useAppStore.getState())
    if (sig === prevOrder) return
    prevOrder = sig
    schedule()
  }

  const unsubStore = useAppStore.subscribe((state) => {
    const next = relevant(state)
    if (next.some((v, i) => v !== prev[i])) {
      prev = next
      schedule()
    }
    checkOrder()
  })
  const unsubFreeze = useSidebarFreeze.subscribe(checkOrder)
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
    checkOrder()
  })

  // v3.1: a `snaos status` line (E8-FR-19) and a pending "Run now" (E8-FR-32)
  // live in their own transient stores; both only swap state on a change.
  const unsubLines = useStatusLines.subscribe(schedule)
  let prevRunPending = runPendingSig()
  const unsubRuntime = useScheduleRuntime.subscribe(() => {
    const sig = runPendingSig()
    if (sig === prevRunPending) return
    prevRunPending = sig
    schedule()
  })

  // Seed main with the current state right away (post-hydrate).
  window.snApi.remote.pushState(buildSnapshot(useAppStore.getState()))

  return () => {
    if (timer) clearTimeout(timer)
    unsubStore()
    unsubFreeze()
    unsubPty()
    unsubUsage()
    unsubAgents()
    unsubGit()
    unsubLines()
    unsubRuntime()
  }
}

/** Schedules (`paneId#scheduleId`) whose "Run now" is pending: the only part of the scheduler runtime the phone sees. */
function runPendingSig(): string {
  const runtime = useScheduleRuntime.getState()
  const ids = new Set([...Object.keys(runtime.manual), ...Object.keys(runtime.inflight).filter((id) => runtime.inflight[id].trigger === 'manual')])
  return [...ids].sort().join(',')
}
