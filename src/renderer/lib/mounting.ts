/**
 * The single workspace-mounting primitive (D4). A workspace's consoles (and
 * their ptys) only exist while it is mounted, and it stays mounted once it is:
 *  - 'full': every console is live (the workspace was activated at least once),
 *  - string[]: only these pane ids are live (partial mount, e.g. a scheduled
 *    prompt or an interrupted agent firing in a workspace never opened); the
 *    rest render the "console not started" placeholder,
 *  - absent: not mounted, nothing renders and nothing spawns.
 * Transient: never persisted. Pure helpers so tests can drive them directly.
 */
export type MountState = 'full' | string[]
export type MountedWorkspaces = Record<string, MountState>

export interface EnsureMountedOpts {
  /** Mount only these panes (ignored when the workspace is already 'full'). */
  only?: string[]
}

/**
 * Next map after mounting `wsId`. Returns the same reference when nothing
 * changes so store updates can bail out without a set(). `paneIds` are the
 * workspace's current panes; ids outside it are ignored.
 */
export function withMounted(
  map: MountedWorkspaces,
  wsId: string,
  paneIds: readonly string[],
  opts?: EnsureMountedOpts,
): MountedWorkspaces {
  const current = map[wsId]
  if (current === 'full') return map
  if (!opts?.only) return { ...map, [wsId]: 'full' }
  const known = new Set(paneIds)
  const have = current ?? []
  const add = opts.only.filter((id, i, all) => known.has(id) && !have.includes(id) && all.indexOf(id) === i)
  if (add.length === 0) return map
  return { ...map, [wsId]: [...have, ...add] }
}

/** Next map after a workspace is deleted (the only way it ever unmounts). */
export function withoutMounted(map: MountedWorkspaces, wsId: string): MountedWorkspaces {
  if (!(wsId in map)) return map
  const next = { ...map }
  delete next[wsId]
  return next
}

/** True when the workspace renders at all (full or partial). */
export function isWorkspaceMounted(map: MountedWorkspaces, wsId: string): boolean {
  return map[wsId] !== undefined
}

/** True when this console should run its terminal instead of the placeholder. */
export function isPaneMounted(map: MountedWorkspaces, wsId: string, paneId: string): boolean {
  const state = map[wsId]
  return state === 'full' || (state !== undefined && state.includes(paneId))
}
