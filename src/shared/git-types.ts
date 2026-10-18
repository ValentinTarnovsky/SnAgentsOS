/**
 * Git read model shared by main, the renderer and the phone (E7). Pure types,
 * no imports: ipc-contract.ts, types.ts and remote-protocol.ts all import this
 * file, and remote-protocol.ts must stay free of Node, DOM and zod.
 */

export type GitArea = 'staged' | 'unstaged' | 'untracked' | 'conflict'

export type GitError = 'not_repo' | 'git_missing' | 'git_old' | 'unsafe_repo' | 'timeout' | 'git_error'

/** One file in one area. Paths are relative to the repo root, with '/'. */
export interface GitFileEntry {
  path: string
  oldPath?: string
  area: GitArea
  status: 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '?'
  added: number | null
  removed: number | null
  binary: boolean
}

export interface GitDiffLine {
  kind: 'ctx' | 'add' | 'del' | 'meta'
  oldNo?: number
  newNo?: number
  text: string
}

export interface GitDiffHunk {
  header: string
  oldStart: number
  newStart: number
  lines: GitDiffLine[]
  continued?: boolean
}

/**
 * A directory the renderer wants watched. `key` is `ws:<workspaceId>` for a
 * workspace cwd or `pane:<paneId>` for a pane worktree. Only `active` targets
 * (the active workspace and its worktrees) are polled.
 */
export interface GitTarget {
  key: string
  cwd: string
  workspaceId: string
  paneId?: string
  active: boolean
}

/** Chip summary of one target (E7-FR-05). Desktop only: `repoRoot` never goes to the phone. */
export interface GitSummary {
  repoRoot: string
  /** Branch name, or null when detached (then `headShort` is the label). */
  branch: string | null
  detached: boolean
  /** Repository without commits: counts come from the index plus the working tree. */
  unborn: boolean
  headShort: string
  upstream: string | null
  ahead: number
  behind: number
  /** Distinct changed paths. */
  files: number
  /** Lines against HEAD plus untracked lines. */
  added: number
  removed: number
  /** The untracked line count was cut short by its budget. */
  approx: boolean
  staged: number
  unstaged: number
  untracked: number
  conflicts: number
  op: 'merge' | 'rebase' | 'cherry-pick' | null
  /** More than 5000 status entries. */
  truncated: boolean
  /** When the summary last CHANGED (tooltip "Last change"), epoch ms. */
  updatedAt: number
}

/** `git:update` payload (main -> renderer), sent only when a summary changes by value. */
export interface GitUpdateEvt {
  key: string
  cwd: string
  summary: GitSummary | null
  error?: GitError
}

/** `git:info` result: which git the app found on PATH. */
export interface GitInfoRes {
  available: boolean
  version?: string
  path?: string
  tooOld?: boolean
}

/** Chip shown on the phone (contract `RemoteWorkspaceInfo.git`). No paths. */
export interface RemoteGitChip {
  /** Branch, or the short sha when detached. */
  branch: string
  ahead: number
  behind: number
  added: number
  removed: number
  files: number
}
