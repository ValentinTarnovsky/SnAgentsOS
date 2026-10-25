/**
 * Renderer side of the worktree per console (E7-FR-27..32, 36): when the
 * entries show, the default slug, the pane a created worktree becomes, and
 * the close routing. Main validates everything again; this only decides what
 * the UI offers. No React here, so scripts/test-worktrees.cjs runs it in a vm.
 */
import type { AgentPreset, ConnectionProfile, Pane, PaneWorktree, Workspace } from '@shared/types'
import type { GitError, GitSummary } from '@shared/git-types'
import { CWD_MISSING, isValidSlug, type WorktreeInspectRes, type WorktreeListEntry, type WorktreeRemoveReq } from '@shared/worktree-types'
import { resolveLaunch } from './launch'
import { useAppStore } from './store'
import { useWorktreeStore, type PaneTemplate, type WorktreeLaunchRequest } from './worktreeStore'

/** gridForCount stops at 12 consoles. */
export const MAX_PANES = 12

export type WorktreeBlock = 'worktree.full' | 'worktree.notRepo' | 'worktree.unborn'

export interface WorktreeOffer {
  /** False for consoles on a connection profile: the agent works on another host. */
  show: boolean
  /** Why the entry is disabled (tooltip key), when known up front. */
  blocked?: WorktreeBlock
  /** The repo folder the worktree comes from. */
  repoCwd: string
}

/** `claude-3f2a`: the preset or pane name as a slug plus 4 random hex digits, always a valid slug. */
export function defaultSlug(name: string, rand: () => number = Math.random): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30)
      .replace(/-+$/, '') || 'console'
  const hex = Math.floor(rand() * 0x10000)
    .toString(16)
    .padStart(4, '0')
    .slice(-4)
  return `${base}-${hex}`
}

export function templateFromPreset(preset: AgentPreset): PaneTemplate {
  return { name: preset.name, type: preset.type, presetId: preset.id, color: preset.color, icon: preset.icon }
}

/** "Duplicate in worktree": same agent and command as the pane, a fresh worktree. */
export function templateFromPane(pane: Pane, presets: AgentPreset[]): PaneTemplate {
  const preset = pane.presetId ? presets.find((p) => p.id === pane.presetId) : undefined
  return {
    name: preset?.name ?? pane.title.split(' · ')[0] ?? pane.title,
    type: pane.type,
    ...(pane.presetId ? { presetId: pane.presetId } : {}),
    ...(pane.command ? { command: pane.command } : {}),
    color: pane.color,
    icon: pane.icon,
    ...(pane.fontSize ? { fontSize: pane.fontSize } : {}),
  }
}

/**
 * Whether (and how) a worktree entry shows: (a) a preset of the workspace's
 * "+ New console" (pane null), (b) "Duplicate in worktree" of a pane, (c) the
 * palette. The repo state comes from the git chip of the workspace when the
 * repo folder is the workspace cwd; otherwise the dialog's probe tells.
 */
export function worktreeOffer(
  ws: Workspace,
  pane: Pane | null,
  presets: AgentPreset[],
  connections: ConnectionProfile[],
  git: { summary?: GitSummary; error?: GitError },
): WorktreeOffer {
  let repoCwd = ws.cwd
  let hasSetup: boolean
  if (pane) {
    const launch = resolveLaunch(pane, ws, presets, connections)
    repoCwd = launch.cwd
    hasSetup = !!launch.setup
  } else {
    const setup = ws.setupId ? connections.find((c) => c.id === ws.setupId)?.steps : undefined
    hasSetup = !!setup && setup.length > 0
  }
  if (hasSetup) return { show: false, repoCwd }
  if (ws.panes.length >= MAX_PANES) return { show: true, blocked: 'worktree.full', repoCwd }
  if (!repoCwd) return { show: true, blocked: 'worktree.notRepo', repoCwd }
  if (repoCwd === ws.cwd) {
    if (git.error === 'not_repo') return { show: true, blocked: 'worktree.notRepo', repoCwd }
    if (git.summary?.unborn) return { show: true, blocked: 'worktree.unborn', repoCwd }
  }
  return { show: true, repoCwd }
}

/** The pane fields a created worktree gives a console. */
export function paneFromWorktree(template: PaneTemplate, wt: PaneWorktree): Partial<Pane> {
  const slug = wt.branch.replace(/^sn\//, '')
  return {
    type: template.type,
    ...(template.presetId ? { presetId: template.presetId } : {}),
    ...(template.command ? { command: template.command } : {}),
    title: `${template.name} · ${slug}`,
    color: template.color,
    icon: template.icon,
    ...(template.fontSize ? { fontSize: template.fontSize } : {}),
    cwd: wt.path,
    worktree: { ...wt },
  }
}

/**
 * Puts a created worktree to use: a new console in the workspace, or (the
 * missing card's "Recreate") the same console moved onto it. Returns the pane id.
 */
export function applyCreatedWorktree(req: WorktreeLaunchRequest, wt: PaneWorktree): string {
  const store = useAppStore.getState()
  if (req.replacePaneId) {
    store.setPaneWorktree(req.workspaceId, req.replacePaneId, wt)
    store.renamePane(req.workspaceId, req.replacePaneId, `${req.template.name} · ${wt.branch.replace(/^sn\//, '')}`)
    useWorktreeStore.getState().clearMissing(req.replacePaneId)
    return req.replacePaneId
  }
  return store.addPane(req.workspaceId, paneFromWorktree(req.template, wt))
}

/**
 * Close the way the user does (X, middle click, menu, the exit card): a
 * worktree console asks Keep / Delete first (E7-FR-30); any other closes.
 * The phone's closePane never comes here: it always keeps the worktree (FR-32).
 */
export function requestClosePane(workspaceId: string, paneId: string): void {
  const store = useAppStore.getState()
  const pane = store.workspaces.find((w) => w.id === workspaceId)?.panes.find((p) => p.id === paneId)
  if (!pane) return
  const wt = pane.worktree
  if (wt) useWorktreeStore.getState().openClose({ workspaceId, paneId, path: wt.path, branch: wt.branch, base: wt.base })
  else store.closePane(workspaceId, paneId)
}

/** A failed spawn/restart whose message is PtyManager's typed cwd_missing. */
export function isCwdMissing(message: string | undefined): boolean {
  return !!message && message.includes(`${CWD_MISSING}:`)
}

/**
 * A spawn or restart failed. When it is the typed cwd_missing of a worktree
 * console, the pane swaps its terminal for the FR-36 card (main refused to
 * spawn, so nothing ran in a stale folder).
 */
export function noteSpawnFailure(paneId: string, message: string | undefined): void {
  if (!isCwdMissing(message)) return
  const hasWorktree = useAppStore.getState().workspaces.some((w) => w.panes.some((p) => p.id === paneId && p.worktree))
  if (hasWorktree) useWorktreeStore.getState().markMissing(paneId)
}

/** The checkbox of the close dialog is required when deleting loses work. */
export function deleteNeedsAck(info: { dirtyFiles: number; commitsAhead: number; mergedIntoHead: boolean; incomplete?: boolean }): boolean {
  return info.incomplete === true || info.dirtyFiles > 0 || (info.commitsAhead > 0 && !info.mergedIntoHead)
}

export type WorktreeDeleteBlock = 'inProgress' | 'branchMismatch'

/**
 * Why Delete is not offered at all: a rebase, merge, cherry-pick, revert or
 * bisect left half-done, or the folder has another branch (or a detached HEAD)
 * checked out instead of the recorded `branch`. Main refuses both too.
 */
export function deleteBlock(info: Pick<WorktreeInspectRes, 'exists' | 'inProgress' | 'headBranch'>, branch: string): WorktreeDeleteBlock | null {
  if (!info.exists) return null
  if (info.inProgress) return 'inProgress'
  if (info.headBranch !== undefined && info.headBranch !== branch) return 'branchMismatch'
  return null
}

/**
 * What a delete sends back to main from the inspect the user saw, so main can
 * refuse ('changed') when the worktree moved on since: the tip always when
 * known, the dirty count whenever git status answered. `incomplete` alone is
 * not enough to drop it (a missing base or a failed rev-list leave the count
 * real, and files written after the inspect must still be 'changed'); only an
 * unread status (`incomplete` without `dirtyRead`, or the dialog's own
 * fallback) skips it, so a status that keeps failing never loops on
 * 'changed': the re-inspect reads it as unknown and the "may lose work"
 * checkbox confirms it instead.
 */
export function removeExpectations(info: WorktreeInspectRes): Pick<WorktreeRemoveReq, 'expectTip' | 'expectDirty'> {
  const dirtyKnown = !info.incomplete || info.dirtyRead === true
  return {
    ...(info.tip ? { expectTip: info.tip } : {}),
    ...(info.exists && dirtyKnown ? { expectDirty: info.dirtyFiles } : {}),
  }
}

/**
 * The user's "may lose work" on an `incomplete` inspect, sent only when the
 * checkbox was ticked: main needs it to delete a folder git no longer reads
 * as its own checkout (`noCheckout`), never infers it.
 */
export function ackFields(info: WorktreeInspectRes, acked: boolean): Pick<WorktreeRemoveReq, 'ackIncomplete'> {
  return info.incomplete && acked ? { ackIncomplete: true } : {}
}

/** Commits deleting the branch would lose (merged ones survive in the repo HEAD). */
export function lostCommits(info: { commitsAhead: number; mergedIntoHead: boolean }): number {
  return info.mergedIntoHead ? 0 : info.commitsAhead
}

/** Comparable spelling of a worktree path (separators, case, trailing slash). */
export function worktreePathKey(p: string): string {
  return p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
}

/**
 * The worktrees no console references (FR-31): a deleted workspace's ones land here. A team task's worktree is
 * never one (app 2.7.0, decision 63): its team owns it, and main refuses to delete it from here.
 */
export function orphanWorktrees(entries: WorktreeListEntry[], workspaces: Workspace[]): WorktreeListEntry[] {
  const used = new Set<string>()
  for (const w of workspaces) for (const p of w.panes) if (p.worktree?.path) used.add(worktreePathKey(p.worktree.path))
  return entries.filter((e) => !e.teamOwned && !used.has(worktreePathKey(e.path)))
}

/**
 * How many consoles other than `exceptPaneId` (any workspace) run in the
 * worktree at `path` (app 2.7.0, A9): the close dialog offers no Delete while
 * one does, since main only kills the closing console's shell.
 */
export function worktreeUsers(workspaces: readonly Workspace[], path: string, exceptPaneId?: string): number {
  const key = worktreePathKey(path)
  let n = 0
  for (const w of workspaces) for (const p of w.panes) if (p.id !== exceptPaneId && p.worktree?.path && worktreePathKey(p.worktree.path) === key) n++
  return n
}

/**
 * "New console in this worktree" (app 2.7.0, A9): the same agent, command and
 * look as `pane` (what Duplicate gives) on the same worktree and folder, local
 * like the pane even when the workspace has a connection profile.
 */
export function paneInWorktree(pane: Pane, ws: Workspace, presets: AgentPreset[]): Partial<Pane> | null {
  const wt = pane.worktree
  if (!wt) return null
  return { ...paneFromWorktree(templateFromPane(pane, presets), wt), cwd: pane.cwd ?? wt.path, ...(ws.setupId ? { setupId: '' } : {}) }
}

export { isValidSlug }
