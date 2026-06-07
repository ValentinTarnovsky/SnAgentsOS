/**
 * Tracks the most recently focused console pane and exposes a way to refocus a
 * pane's terminal from elsewhere (command palette, snippets, workspace switch),
 * so the user can keep typing right after an action without clicking back into
 * the console.
 */
let lastFocusedPaneId: string | null = null
const focusers = new Map<string, () => void>()
/** workspaceId -> last pane the user focused inside it (drives switch focus). */
const lastFocusedByWorkspace = new Map<string, string>()

export function setFocusedPane(paneId: string, workspaceId?: string): void {
  lastFocusedPaneId = paneId
  if (workspaceId) lastFocusedByWorkspace.set(workspaceId, paneId)
}

export function getFocusedPane(): string | null {
  return lastFocusedPaneId
}

/** The pane the user last focused in a given workspace, if we've seen one. */
export function getLastFocusedPaneForWorkspace(workspaceId: string): string | null {
  return lastFocusedByWorkspace.get(workspaceId) ?? null
}

/** Register a pane's terminal focus fn (called by useXterm on mount). */
export function registerFocuser(paneId: string, focus: () => void): void {
  focusers.set(paneId, focus)
}

export function unregisterFocuser(paneId: string): void {
  focusers.delete(paneId)
}

/** Focus a pane's terminal, if it's mounted. */
export function focusPane(paneId: string): void {
  focusers.get(paneId)?.()
}

/**
 * Focus a pane's terminal as soon as its focuser is registered. On the first
 * switch to a workspace the target pane mounts a frame or two later, so we
 * retry on animation frames until the focuser shows up (or we give up). Returns
 * a cancel fn so a rapid re-switch never lands focus on the wrong workspace.
 */
export function focusPaneWhenReady(paneId: string, maxAttempts = 20): () => void {
  let raf = 0
  let cancelled = false
  const tick = (attempts: number): void => {
    if (cancelled) return
    const focus = focusers.get(paneId)
    if (focus) {
      focus()
      return
    }
    if (attempts <= 0) return
    raf = requestAnimationFrame(() => tick(attempts - 1))
  }
  // Defer the first attempt a frame: lets the workspace's display:block apply
  // and lets a triggering button click finish stealing focus first, so our
  // focus() is the one that sticks.
  raf = requestAnimationFrame(() => tick(maxAttempts))
  return () => {
    cancelled = true
    if (raf) cancelAnimationFrame(raf)
  }
}
