/**
 * Consoles a `snaos kill` (without --close) stopped (app 2.3.0). The kill drops
 * the pty, and a later mount (a workspace shown for the first time since a
 * reload, a remount) would otherwise find nothing to reattach and spawn a new
 * shell, maybe resuming the agent. A stopped console mounts with its exit card
 * instead, and only an explicit restart (the card, the header, the phone,
 * `snaos restart`) clears the mark and starts it again. Kept in sessionStorage
 * so a window reload keeps it; an app restart starts every console as usual.
 */
const KEY = 'snagentsos.stoppedPanes'

let cache: Set<string> | null = null

function load(): Set<string> {
  if (cache) return cache
  cache = new Set()
  try {
    const list = JSON.parse(sessionStorage.getItem(KEY) ?? '[]') as unknown
    if (Array.isArray(list)) for (const id of list) if (typeof id === 'string') cache.add(id)
  } catch {
    /* blocked or corrupt storage: the in-memory set still works */
  }
  return cache
}

function persist(set: Set<string>): void {
  try {
    if (set.size === 0) sessionStorage.removeItem(KEY)
    else sessionStorage.setItem(KEY, JSON.stringify([...set]))
  } catch {
    /* blocked storage */
  }
}

export function markStopped(paneId: string): void {
  const set = load()
  if (set.has(paneId)) return
  set.add(paneId)
  persist(set)
}

export function isStopped(paneId: string): boolean {
  return load().has(paneId)
}

export function clearStopped(paneId: string): void {
  const set = load()
  if (!set.delete(paneId)) return
  persist(set)
}
