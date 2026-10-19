/**
 * "Against base" reads for a worktree console (E7-FR-35): what an agent did
 * since the commit its worktree started from, committed or not. The race bar
 * shows the `+a -d N files` of each contestant and the Changes panel lists
 * and diffs the same set ("against base" mode).
 *
 * Tracked changes come from `git diff <base>` (the working tree against the
 * base commit, so commits on the branch and uncommitted edits both count);
 * untracked files come from the target's cached status list, counted with the
 * same untracked line cache the chip uses. The base is always a full sha the
 * renderer took from `pane.worktree.base`: hex only, so it can never be read
 * as an option, and git refuses an unknown one (git_error).
 */
import type { GitBaseStat, GitFileEntry, GitSummary } from '@shared/git-types'
import type { GitRunner } from './gitExec'
import { parseNumstatZ, type NumstatEntry } from './porcelain'

/** A full commit id (sha1 or sha256). Abbreviations are refused: they could become ambiguous later. */
export const BASE_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

export function isBaseSha(v: unknown): v is string {
  return typeof v === 'string' && BASE_SHA_RE.test(v)
}

export interface NameStatusEntry {
  status: GitFileEntry['status']
  path: string
  oldPath?: string
}

const STATUS_LETTERS: ReadonlySet<string> = new Set(['M', 'A', 'D', 'R', 'C', 'T', 'U'])

/**
 * `git diff -z --name-status [-M]`: `X\0path\0`, or for a rename or copy
 * `R100\0old\0new\0`. Unknown letters (X, B) are skipped with their path.
 */
export function parseNameStatusZ(out: string): NameStatusEntry[] {
  const res: NameStatusEntry[] = []
  const recs = out.split('\0')
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i]
    if (!rec) continue
    const letter = rec[0]
    if (letter === 'R' || letter === 'C') {
      const oldPath = recs[i + 1]
      const path = recs[i + 2]
      i += 2
      if (oldPath === undefined || path === undefined || !path) continue
      res.push({ status: letter, path, oldPath })
      continue
    }
    const path = recs[i + 1]
    i += 1
    if (path === undefined || !path || !STATUS_LETTERS.has(letter)) continue
    res.push({ status: letter as GitFileEntry['status'], path })
  }
  return res
}

const FLAGS = ['--no-ext-diff', '--no-textconv', '-z']

/**
 * Every file that differs from `base`: tracked ones as area `unstaged`
 * (working tree against the base) with their `+a -d`, then the untracked
 * files of `statusFiles` with their cached line count (null when not counted
 * or binary). GitArea stays the contract's four values: the panel labels the
 * tracked section "Against base" in this mode.
 */
export async function listAgainstBase(
  repoRoot: string,
  base: string,
  statusFiles: readonly GitFileEntry[],
  runner: Pick<GitRunner, 'run'>,
  untrackedLines: (rel: string) => number | null | undefined,
): Promise<GitFileEntry[]> {
  if (!isBaseSha(base)) throw new Error('bad base')
  const opts = { cwd: repoRoot }
  const [names, nums] = await Promise.all([
    // `--` ends the revisions: a file named like the sha can never make it ambiguous.
    runner.run(['diff', ...FLAGS, '--name-status', '-M', base, '--'], opts).then(parseNameStatusZ),
    runner.run(['diff', ...FLAGS, '--numstat', '-M', base, '--'], opts).then(parseNumstatZ),
  ])
  const byPath = new Map<string, NumstatEntry>()
  for (const n of nums) byPath.set(n.path, n)
  const out: GitFileEntry[] = names.map((e) => {
    const n = byPath.get(e.path)
    return {
      path: e.path,
      ...(e.oldPath ? { oldPath: e.oldPath } : {}),
      area: 'unstaged',
      status: e.status,
      added: n ? n.added : null,
      removed: n ? n.removed : null,
      binary: n ? n.binary : false,
    }
  })
  const seen = new Set(out.map((f) => f.path))
  for (const f of statusFiles) {
    if (f.area !== 'untracked' || seen.has(f.path)) continue
    const lines = untrackedLines(f.path)
    out.push({ ...f, added: lines === undefined ? null : (lines ?? null), removed: lines === undefined || lines === null ? null : 0, binary: lines === null })
  }
  return out
}

/** Totals of a base list (binaries add 0 lines). */
export function sumBase(files: readonly GitFileEntry[], summary: Pick<GitSummary, 'approx' | 'truncated'>): GitBaseStat {
  let added = 0
  let removed = 0
  let approx = summary.approx || summary.truncated
  for (const f of files) {
    added += f.added ?? 0
    removed += f.removed ?? 0
    if (f.area === 'untracked' && f.added === null && !f.binary) approx = true
  }
  return { added, removed, files: new Set(files.map((f) => f.path)).size, approx }
}
