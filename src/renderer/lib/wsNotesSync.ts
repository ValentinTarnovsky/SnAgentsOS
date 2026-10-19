import { useAppStore } from './store'

let stop: (() => void) | null = null

/**
 * Workspace notes (v2.2, E9) follow the workspaces: after a real config load
 * the notes of workspaces that no longer exist go to the notes trash, and so
 * do those of a workspace deleted while the app runs. Returns a stop function.
 */
export function startWsNotesSync(opts: { prune: boolean }): () => void {
  if (stop) return () => undefined
  const api = window.snApi.wsNotes
  if (opts.prune) api.prune(useAppStore.getState().workspaces.map((w) => w.id))
  const off = useAppStore.subscribe((state, prev) => {
    if (state.workspaces === prev.workspaces) return
    const alive = new Set(state.workspaces.map((w) => w.id))
    if (prev.workspaces.some((w) => !alive.has(w.id))) api.prune([...alive])
  })
  stop = () => {
    off()
    stop = null
  }
  return stop
}
