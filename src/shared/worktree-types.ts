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

/** `git:worktreeInspect` (amendment): the close dialog (FR-30) and the missing card (FR-36). */
export interface WorktreeInspectRes {
  exists: boolean
  dirtyFiles: number
  commitsAhead: number
  mergedIntoHead: boolean
}

/** `git:worktreeRemove`: the renderer sends the path and the pane, main completes the rest from its manifest. */
export interface WorktreeRemoveReq {
  path: string
  paneId?: string
  deleteBranch: boolean
}

export type WorktreeRemoveError = 'not_managed' | 'unlink_failed' | 'busy' | 'git_error'

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
