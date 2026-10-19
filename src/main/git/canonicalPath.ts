/**
 * The spelling git uses for a folder. `git rev-parse --show-toplevel`,
 * `git worktree list` and the `.git` file of a linked worktree all name the
 * realpath: an 8.3 short name (C:\Users\RUNNER~1) is expanded, a junction,
 * symlink or subst drive is resolved, and macOS's /var is /private/var. A path
 * the user or the settings spell another way must be brought to that form
 * before it is compared with anything git printed, or one folder reads as two.
 */
import { realpathSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'

export type RealpathFn = (p: string) => string

/**
 * realpath of `p`, or of its nearest existing ancestor with the rest appended
 * (a worktree root or a deleted worktree may not exist). Never creates
 * anything; with no existing ancestor at all it is `resolve(p)`.
 */
export function canonicalPath(p: string, realpath: RealpathFn = realpathSync.native): string {
  const rest: string[] = []
  let cur = resolve(p)
  for (;;) {
    try {
      return rest.length ? join(realpath(cur), ...rest.reverse()) : realpath(cur)
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return resolve(p)
      rest.push(basename(cur))
      cur = parent
    }
  }
}
