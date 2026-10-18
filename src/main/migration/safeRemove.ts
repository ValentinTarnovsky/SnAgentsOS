import { promises as nodeFsp, type Stats } from 'fs'
import { basename, dirname, join, parse, resolve } from 'path'
import { isInside, isSameOrInside, overlaps, samePath } from './pathUtil'
import { isoStamp } from './legacyMarker'

/**
 * Deletion primitives of the legacy cleanup (E0-FR-30). Shared with the
 * worktree removal of a later epic. Rules:
 *  - a link (symlink or junction; Node reports both as symbolic links) is
 *    removed as a link and never entered, and a link as the target itself is
 *    refused (skipped: reparsePoint);
 *  - the target and its realpath are checked against the guards: never a
 *    system or profile root, never inside / containing / equal to the current
 *    data folders, never equal to or containing the running exe folder;
 *  - a path that needs elevation is skipped before anything is touched: the
 *    app never asks for UAC;
 *  - files in use or read-only get 3 retries of 200 ms (chmod 0o666 on EPERM)
 *    and then the item is deferred; what was already deleted stays deleted,
 *    so every call is idempotent and the next one continues.
 * Implemented by hand rather than rm({ recursive }) so the no-follow rule is
 * explicit and testable.
 */

export interface PathGuard {
  /** Drive roots, home, %APPDATA%, %LOCALAPPDATA%, os.tmpdir(), ~/.claude, Programs: never these exact paths. */
  forbiddenExact: string[]
  /** dataDir(), userData: not equal, not containing, not inside. */
  forbiddenTree: string[]
  /** dirname(process.execPath), PORTABLE_EXECUTABLE_DIR, app.getAppPath(): not equal, not containing. */
  forbiddenContain: string[]
  /** When set (dev cleanup on a fake tree), every target must be strictly inside one of these. */
  allowedRoots?: string[]
}

export type RemoveResult = 'done' | 'absent' | { deferred: string } | { skipped: string }

export type RemoveFs = Pick<typeof nodeFsp, 'lstat' | 'readdir' | 'unlink' | 'rmdir' | 'chmod' | 'rename' | 'realpath' | 'readFile' | 'stat'>

export interface ElevationContext {
  platform: NodeJS.Platform
  /** %ProgramFiles%, %ProgramFiles(x86)%, %ProgramW6432%. */
  programFiles: string[]
  /** Owner uid of a path (macOS /Applications check); null when unknown. */
  ownerUid?: (p: string) => number | null
  uid?: number
}

export interface RemoveOptions {
  fs?: RemoveFs
  elevation?: ElevationContext
  /** Retries after the first failed unlink/rmdir (default 3). */
  retries?: number
  /** Wait between retries in ms (default 200). */
  delayMs?: number
  now?: () => number
  /**
   * Runs right after the tombstone rename, before anything is deleted (and is
   * the test seam for a crash there, which leaves only the tombstone). A
   * returned deferred or skipped result stops the removal: the folder is
   * renamed back to its own name when possible and that result is returned.
   */
  afterRename?: (tombstone: string) => void | RemoveResult | Promise<void | RemoveResult>
}

const RETRY = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'])

function code(err: unknown): string {
  const c = (err as { code?: unknown })?.code
  return typeof c === 'string' && c ? c : 'error'
}

export function defaultElevation(): ElevationContext {
  const env = process.env
  return {
    platform: process.platform,
    programFiles: [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432].filter((p): p is string => !!p),
    uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
  }
}

/**
 * True for paths only an administrator may delete: under Program Files on
 * Windows, a foreign bundle under /Applications on macOS, system prefixes on
 * Linux. Such items end skipped: needsElevation, never deferred forever and
 * never a UAC prompt. (A legacy install registered in HKLM is decided by the
 * inventory item, which knows the hive.)
 */
export function needsElevation(target: string, ctx: ElevationContext = defaultElevation()): boolean {
  if (ctx.platform === 'win32') return ctx.programFiles.some((pf) => isSameOrInside(target, pf))
  if (ctx.platform === 'darwin') {
    if (!isSameOrInside(target, '/Applications')) return false
    const owner = ctx.ownerUid?.(target) ?? null
    return owner === null || ctx.uid === undefined || owner !== ctx.uid
  }
  return ['/usr', '/opt', '/etc', '/bin', '/sbin', '/lib'].some((p) => isSameOrInside(target, p))
}

function isFsRoot(p: string): boolean {
  const r = parse(p)
  return samePath(r.root, p)
}

/**
 * True when the path breaks a guard. The forbidden lists are checked on every
 * spelling in `paths` (lexical and realpath). allowedRoots is checked on
 * `allowedCheck`, which callers set to the realpath alone: the lexical form may
 * use an 8.3 short name (C:\Users\RUNNER~1) that no allowed spelling matches,
 * and the realpath is where the delete actually lands.
 */
export function violatesGuard(paths: string[], guard: PathGuard, allowedCheck: string[] = paths): boolean {
  return (
    paths.some(
      (p) =>
        isFsRoot(p) ||
        guard.forbiddenExact.some((x) => samePath(p, x)) ||
        guard.forbiddenTree.some((x) => overlaps(p, x)) ||
        guard.forbiddenContain.some((x) => isSameOrInside(x, p)),
    ) ||
    (guard.allowedRoots !== undefined && allowedCheck.some((p) => !guard.allowedRoots!.some((r) => isInside(p, r))))
  )
}

async function realOf(fsx: RemoveFs, p: string): Promise<string> {
  try {
    return await fsx.realpath(p)
  } catch {
    return p
  }
}

/**
 * Every guard path in its written form and in its realpath form. userData,
 * dataDir() or the exe folder may be spelled through a junction, a symlink, a
 * subst drive or an 8.3 short name (C:\Users\TARNO~1): compared only as
 * written, a target reached by its real path would slip past them.
 */
export async function expandGuard(guard: PathGuard, fsx: RemoveFs = nodeFsp): Promise<PathGuard> {
  // A guard path that does not exist yet resolves through its nearest existing ancestor.
  const realDeep = async (p: string): Promise<string> => {
    const rest: string[] = []
    let cur = resolve(p)
    for (;;) {
      try {
        return join(await fsx.realpath(cur), ...rest.reverse())
      } catch {
        const parent = dirname(cur)
        if (parent === cur) return p
        rest.push(basename(cur))
        cur = parent
      }
    }
  }
  const both = async (list: string[]): Promise<string[]> => {
    const out = new Set(list)
    for (const p of list) out.add(await realDeep(p))
    return [...out]
  }
  return {
    forbiddenExact: await both(guard.forbiddenExact),
    forbiddenTree: await both(guard.forbiddenTree),
    forbiddenContain: await both(guard.forbiddenContain),
    ...(guard.allowedRoots ? { allowedRoots: await both(guard.allowedRoots) } : {}),
  }
}

/** lstat + link/elevation/guard checks shared by both entry points. */
async function precheck(target: string, guard: PathGuard, o: RemoveOptions): Promise<RemoveResult | Stats> {
  const fsx = o.fs ?? nodeFsp
  let st: Stats
  try {
    st = await fsx.lstat(target)
  } catch (err) {
    return code(err) === 'ENOENT' ? 'absent' : { deferred: code(err) }
  }
  if (st.isSymbolicLink()) return { skipped: 'reparsePoint' }
  if (needsElevation(target, o.elevation)) return { skipped: 'needsElevation' }
  const real = await realOf(fsx, target)
  if (violatesGuard([target, real], await expandGuard(guard, fsx), [real])) return { skipped: 'guard' }
  return st
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve()
}

async function withRetries(o: RemoveOptions, op: () => Promise<void>, onEperm?: () => Promise<void>): Promise<void> {
  const retries = o.retries ?? 3
  let chmodDone = false
  for (let i = 0; ; i++) {
    try {
      await op()
      return
    } catch (err) {
      const c = code(err)
      if (c === 'ENOENT') return
      if (i >= retries || !RETRY.has(c)) throw err
      if (c === 'EPERM' && onEperm && !chmodDone) {
        chmodDone = true
        await onEperm().catch(() => {})
      }
      await sleep(o.delayMs ?? 200)
    }
  }
}

async function removeEntry(p: string, st: Stats, o: RemoveOptions, errors: string[]): Promise<void> {
  const fsx = o.fs ?? nodeFsp
  try {
    if (st.isSymbolicLink()) {
      // The link itself, never what it points to. A directory junction needs rmdir on some systems.
      await withRetries(o, async () => {
        try {
          await fsx.unlink(p)
        } catch (err) {
          if (code(err) === 'EPERM' || code(err) === 'EISDIR') await fsx.rmdir(p)
          else throw err
        }
      })
    } else if (st.isDirectory()) {
      for (const name of await fsx.readdir(p)) {
        const child = join(p, String(name))
        let cst: Stats
        try {
          cst = await fsx.lstat(child)
        } catch (err) {
          if (code(err) !== 'ENOENT') errors.push(code(err))
          continue
        }
        await removeEntry(child, cst, o, errors)
      }
      await withRetries(o, () => fsx.rmdir(p))
    } else {
      await withRetries(o, () => fsx.unlink(p), () => fsx.chmod(p, 0o666))
    }
  } catch (err) {
    errors.push(code(err))
  }
}

export async function safeRemoveTree(target: string, guard: PathGuard, o: RemoveOptions = {}): Promise<RemoveResult> {
  const pre = await precheck(target, guard, o)
  if (!(typeof pre === 'object' && 'isDirectory' in pre)) return pre
  const errors: string[] = []
  await removeEntry(target, pre, o, errors)
  return errors.length > 0 ? { deferred: errors[0] } : 'done'
}

/**
 * Two-step removal for folders with data (L01, L02, L18): an atomic rename to
 * <target>.deleting-<ISO> in the same parent, then safeRemoveTree of the
 * tombstone. A legacy folder never stays half-deleted under its own name, so
 * detection (which ignores tombstones) can never migrate from a partial copy.
 * A rename refused because something is in use defers without touching
 * anything; a read-only medium is skipped: readOnly.
 */
export async function tombstoneAndRemove(target: string, guard: PathGuard, o: RemoveOptions = {}): Promise<RemoveResult> {
  const fsx = o.fs ?? nodeFsp
  const pre = await precheck(target, guard, o)
  if (!(typeof pre === 'object' && 'isDirectory' in pre)) return pre
  const tombstone = `${target}.deleting-${isoStamp((o.now ?? Date.now)())}`
  try {
    await fsx.rename(target, tombstone)
  } catch (err) {
    const c = code(err)
    return c === 'EROFS' ? { skipped: 'readOnly' } : { deferred: c }
  }
  const stop = await o.afterRename?.(tombstone)
  if (stop && typeof stop === 'object') {
    // Back under its own name, so detection and the next pass see the folder as it was.
    await fsx.rename(tombstone, target).catch(() => {})
    return stop
  }
  return safeRemoveTree(tombstone, guard, o)
}

/**
 * Finishes tombstones a crash left next to target (<name>.deleting-*). A crash
 * may have come between the rename and the checks that run before deleting,
 * so secure (when given) runs on each tombstone first, and a deferred or
 * skipped answer keeps that tombstone.
 */
export async function removeTombstones(
  target: string,
  guard: PathGuard,
  o: RemoveOptions = {},
  secure?: (tombstone: string) => Promise<void | RemoveResult>,
): Promise<RemoveResult> {
  const fsx = o.fs ?? nodeFsp
  const prefix = `${basename(target)}.deleting-`.toLowerCase()
  let names: string[]
  try {
    names = (await fsx.readdir(dirname(target))).map(String)
  } catch (err) {
    return code(err) === 'ENOENT' ? 'absent' : { deferred: code(err) }
  }
  const results: RemoveResult[] = []
  for (const n of names) {
    if (!n.toLowerCase().startsWith(prefix)) continue
    const tomb = join(dirname(target), n)
    const stop = secure ? await secure(tomb) : undefined
    results.push(stop && typeof stop === 'object' ? stop : await safeRemoveTree(tomb, guard, o))
  }
  return combineResults(results)
}

/** deferred beats skipped beats done beats absent. */
export function combineResults(results: RemoveResult[]): RemoveResult {
  const deferred = results.find((r) => typeof r === 'object' && 'deferred' in r)
  if (deferred) return deferred
  const skipped = results.find((r) => typeof r === 'object' && 'skipped' in r)
  if (skipped) return skipped
  return results.includes('done') ? 'done' : 'absent'
}
