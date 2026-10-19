/**
 * Pure helpers of the git chip (E7-FR-05..09): target derivation, chip
 * formatting and the phone's snapshot shape. No React, no store, so
 * scripts/test-git.cjs runs them in a vm.
 */
import type { GitSummary, GitTarget, RemoteGitChip } from '@shared/git-types'
import type { ClaudePaneState, Pane, Workspace } from '@shared/types'
import { samePath } from '@shared/osc7'

export const workspaceGitKey = (workspaceId: string): string => `ws:${workspaceId}`
export const paneGitKey = (paneId: string): string => `pane:${paneId}`

/** settings.gitChip (schema 12): absent counts as on, only an explicit false hides the chips. */
export function gitChipEnabled(settings: object): boolean {
  return (settings as { gitChip?: unknown }).gitChip !== false
}

/** The isolated worktree a pane runs in (schema 13 `pane.worktree`), if any. */
export function paneWorktreePath(pane: Pane): string | null {
  const wt = (pane as { worktree?: { path?: unknown } }).worktree
  return wt && typeof wt.path === 'string' && wt.path ? wt.path : null
}

/**
 * Targets the renderer asks main to watch: every workspace with a cwd
 * (`ws:<id>`), every pane worktree (`pane:<id>`) and every console working
 * in another folder than its workspace (`pane:<id>` on `paneCwds`, the
 * folder its agent or shell reported, else its own `cwd`): a workspace that
 * holds many repos without being one shows each console's repo. Only the
 * active workspace and its consoles are `active` (polled).
 */
export function buildGitTargets(
  workspaces: Workspace[],
  activeWorkspaceId: string | null,
  paneCwds: Readonly<Record<string, string>> = {},
  platform = 'win32',
): GitTarget[] {
  const out: GitTarget[] = []
  for (const ws of workspaces) {
    const active = ws.id === activeWorkspaceId
    if (ws.cwd) out.push({ key: workspaceGitKey(ws.id), cwd: ws.cwd, workspaceId: ws.id, active })
    for (const pane of ws.panes) {
      const worktree = paneWorktreePath(pane)
      const path = worktree ?? paneCwds[pane.id] ?? pane.cwd
      if (!path || (!worktree && ws.cwd && samePath(path, ws.cwd, platform))) continue
      out.push({ key: paneGitKey(pane.id), cwd: path, workspaceId: ws.id, paneId: pane.id, active })
    }
  }
  return out
}

/**
 * The repo a console works in when it is not its workspace's (another repo,
 * or the workspace is no repo at all): the sidebar shows it on the console's
 * row. Null for a console in its workspace's own repo.
 */
export function paneOwnRepo(pane: GitSummary | undefined, ws: GitSummary | undefined): GitSummary | null {
  if (!pane) return null
  return ws && ws.repoRoot === pane.repoRoot ? null : pane
}

/** Last folder of a repo root, the name the sidebar shows ("C:/x/SnKits" gives "SnKits"). */
export function repoName(repoRoot: string): string {
  return repoRoot.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || repoRoot
}

/** Keys an agent pane's work can change: its workspace and its own target (worktree or folder), when watched. */
export function gitKeysForPane(ws: Workspace, pane: Pane, watched?: ReadonlySet<string>): string[] {
  const keys = ws.cwd ? [workspaceGitKey(ws.id)] : []
  if (paneWorktreePath(pane) || watched?.has(paneGitKey(pane.id))) keys.push(paneGitKey(pane.id))
  return keys
}

const FINISHED: ReadonlySet<ClaudePaneState> = new Set(['done', 'idle', 'action'])

/** FR-06c: a pane went from working to done, idle or action. */
export function agentFinished(prev: ClaudePaneState | undefined, next: ClaudePaneState | undefined): boolean {
  return prev === 'working' && next !== undefined && FINISHED.has(next)
}

/** Branch label: the branch, or the short sha when detached (or unborn without a name). */
export function chipBranch(s: GitSummary): string {
  return s.branch ?? s.headShort
}

export function chipDirty(s: GitSummary): boolean {
  return s.files > 0
}

/** "+142" or, when the untracked count was cut short, "+142+". */
export function addedLabel(s: GitSummary): string {
  return `+${s.added}${s.approx ? '+' : ''}`
}

export function removedLabel(s: GitSummary): string {
  return `-${s.removed}`
}

/** Sidebar text after the console count: "main +142 -37", or just the branch when clean. */
export function compactChip(s: GitSummary): string {
  return chipDirty(s) ? `${chipBranch(s)} ${addedLabel(s)} ${removedLabel(s)}` : chipBranch(s)
}

/** Ahead/behind only make sense with an upstream, and only when non zero. */
export function aheadBehind(s: GitSummary): { ahead: number; behind: number } {
  return s.upstream ? { ahead: s.ahead, behind: s.behind } : { ahead: 0, behind: 0 }
}

/** Contract `RemoteWorkspaceInfo.git`: no paths, no repo root (E7-FR-09). */
export function remoteGitChip(s: GitSummary | null | undefined): RemoteGitChip | undefined {
  if (!s) return undefined
  const ab = aheadBehind(s)
  return { branch: chipBranch(s), ahead: ab.ahead, behind: ab.behind, added: s.added, removed: s.removed, files: s.files }
}

/** "hh:mm" of the last change, in the user's locale. */
export function lastChangeTime(at: number, lang: string): string {
  try {
    return new Date(at).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })
  } catch {
    return new Date(at).toTimeString().slice(0, 5)
  }
}
