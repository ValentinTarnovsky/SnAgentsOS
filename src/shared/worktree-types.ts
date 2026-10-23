/**
 * Isolated worktree per console (E7-FR-27..32, FR-36). Pure types and
 * validators, no imports: types.ts, ipc-contract.ts, main and the renderer all
 * import this file. Main validates every request again; the renderer only
 * uses these to disable a button early.
 */

/** `pane.worktree` (schema 13, shared contract shape). baseRef, linkedPaths and createdAt live only in main's worktrees.json. */
export interface PaneWorktree {
  repoRoot: string
  path: string
  /** 'sn/<slug>' */
  branch: string
  /** Full sha of the base commit. */
  base: string
}

/** A slug the user may type after `sn/`. */
export const WORKTREE_SLUG_RE = /^[a-z0-9-]{1,40}$/
/** Branches the app creates (and is the only kind it ever deletes). */
export const WORKTREE_BRANCH_RE = /^sn\/[a-z0-9-]{1,40}$/
/** PtyManager's typed spawn failure for a cwd that no longer exists (E7-FR-36). */
export const CWD_MISSING = 'cwd_missing' as const

/** A commit sha (abbreviated or full). */
export const SHA_RE = /^[0-9a-f]{7,64}$/i

export function isValidSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && WORKTREE_SLUG_RE.test(slug)
}

/**
 * `git:worktreeAdd` (contract name, E7 shape). `repoCwd` may be any folder of
 * the repo, or a linked worktree of it: main resolves the main checkout.
 * `base` is an optional commit (the race of E7-FR-34 starts N worktrees from
 * one sha); default HEAD.
 */
export interface WorktreeAddReq {
  repoCwd: string
  slug: string
  base?: string
  copyEnv: boolean
  linkNodeModules: boolean
}

export type WorktreeAddError = 'not_repo' | 'unborn' | 'branch_exists' | 'path_exists' | 'bad_slug' | 'root_inside_repo' | 'timeout' | 'git_error'

export type WorktreeAddRes = { ok: true; worktree: PaneWorktree } | { ok: false; error: WorktreeAddError; detail?: string }

/** `git:worktreeProbe` (amendment): what the launch dialog shows before creating. */
export type WorktreeProbeRes =
  | { ok: true; repoName: string; head: string; headShort: string }
  | { ok: false; error: 'not_repo' | 'unborn' | 'git_error' }

/** A git operation left half-done in a worktree: deleting it would throw that state away. */
export type WorktreeInProgress = 'rebase' | 'merge' | 'cherry-pick' | 'revert' | 'bisect'

/** `git:worktreeInspect` (amendment): the close dialog (FR-30) and the missing card (FR-36). */
export interface WorktreeInspectRes {
  exists: boolean
  dirtyFiles: number
  /** With the folder gone and the branch alive, these two are read in the repo from `tip`. */
  commitsAhead: number
  mergedIntoHead: boolean
  /** Set when git could not read the state (status or rev-list failed, base unknown): treat it as work that may be lost. */
  incomplete?: true
  /**
   * Only alongside `incomplete`: git status did answer, so `dirtyFiles` is a
   * real count (the gap was elsewhere: rev-list, an unknown base...) and the
   * delete still sends it as `expectDirty`. Absent with `incomplete`: the
   * count is unknown and is not sent (main then does not re-count files).
   */
  dirtyRead?: true
  /**
   * Only alongside `exists` and `incomplete`: the folder is on disk but git no
   * longer reads it as its own checkout (its `.git` went: a delete that stopped
   * half-way, 'busy', or one by hand). Nothing in it can be counted, so it is
   * never "gone": the delete asks for the checkbox and sends `ackIncomplete`.
   * A console does not start there (the missing card shows, as for a gone folder).
   */
  noCheckout?: true
  /**
   * Full sha the recorded branch points at (the worktree HEAD when main has no
   * record), also for a folder deleted by hand. Sent back as `expectTip`.
   */
  tip?: string
  /** Branch checked out in the folder ('sn/<slug>'), '' when HEAD is detached. Absent when unknown or the folder is gone. */
  headBranch?: string
  /** A rebase, merge, cherry-pick, revert or bisect left half-done in the folder. */
  inProgress?: WorktreeInProgress
}

/** `git:worktreeRemove`: the renderer sends the path and the pane, main completes the rest from its manifest. */
export interface WorktreeRemoveReq {
  path: string
  paneId?: string
  deleteBranch: boolean
  /**
   * `tip` of the inspect the user saw. Main deletes the branch only while it
   * still points there (compare-and-delete); a moved tip is 'changed'.
   */
  expectTip?: string
  /**
   * `dirtyFiles` of that inspect, whenever git status was read (also when the
   * inspect was `incomplete` for another reason, see `dirtyRead`): more
   * uncommitted files once the pty is gone is 'changed'.
   */
  expectDirty?: number
  /**
   * The user ticked "may lose work" on an `incomplete` inspect. Main needs it
   * to delete a folder git no longer reads as its own checkout (`noCheckout`)
   * that its own half-done delete in this session did not leave: nothing there
   * can be re-counted, so without it the answer is 'changed'/'unreadable'.
   */
  ackIncomplete?: boolean
}

/**
 * 'changed': the worktree moved on since the inspect the caller sent (tip,
 * new uncommitted files, an operation started) or, with neither expectation,
 * the delete would lose work nobody confirmed. Nothing was deleted, except
 * when the detail is 'tip_after_delete' (the folder went, the branch stayed).
 */
export type WorktreeRemoveError = 'not_managed' | 'unlink_failed' | 'busy' | 'git_error' | 'changed'

export type WorktreeRemoveRes = { ok: true } | { ok: false; error: WorktreeRemoveError; detail?: string }

/** One row of Settings > Git > Worktrees (FR-31). `repoRoot`/`base` let "Open a console here" rebuild `pane.worktree`. */
export interface WorktreeListEntry {
  path: string
  branch: string
  repoName: string
  /** null when the folder is gone or git could not read it. */
  dirty: boolean | null
  /** In the manifest (validated): only these can be deleted. */
  managed: boolean
  exists: boolean
  repoRoot?: string
  base?: string
}

export interface WorktreeListRes {
  entries: WorktreeListEntry[]
}

/** pane.worktree from a list row ("Open a console here"), or null when the row lacks what the pane needs. */
export function paneWorktreeOf(e: WorktreeListEntry): PaneWorktree | null {
  if (!e.managed || !e.repoRoot || !e.base || !WORKTREE_BRANCH_RE.test(e.branch) || !SHA_RE.test(e.base)) return null
  return { repoRoot: e.repoRoot, path: e.path, branch: e.branch, base: e.base }
}
