import type { RemoteStateSnapshot, RemoteWorkspaceInfo } from '@shared/remote-protocol'
import { resolveTokens } from '@/themes'
import { type AppState, useAppStore } from './store'
import { getPtyId, onPtyRegistryChange } from './ptyRegistry'
import { useUsageStore } from './usageStore'

/** Build the compact desktop-state mirror pushed to phones. */
function buildSnapshot(state: AppState): RemoteStateSnapshot {
  const workspaces: RemoteWorkspaceInfo[] = state.workspaces.map((ws) => ({
    id: ws.id,
    name: ws.name,
    layoutOrder: ws.layout?.order ?? ws.panes.map((p) => p.id),
    panes: ws.panes.map((pane) => ({
      id: pane.id,
      title: pane.title,
      type: pane.type,
      color: pane.color,
      icon: pane.icon,
      // main overrides this authoritatively; it's a best-effort hint here.
      running: getPtyId(pane.id) != null,
    })),
  }))
  return {
    workspaces,
    activeWorkspaceId: state.activeWorkspaceId,
    themeTokens: resolveTokens(state.settings.theme, state.settings.customColors),
    themeName: state.settings.theme,
    language: state.settings.language,
    fontFamily: state.settings.fontFamily,
    fontSize: state.settings.fontSize,
    snippets: state.snippets,
    keyButtons: state.keyButtons,
    // Fields are structurally identical to RemoteUsageSnapshot; passthrough.
    usage: useUsageStore.getState().snapshot ?? null,
  }
}

/** The store slices that affect the snapshot; compared by reference to gate pushes. */
function relevant(s: AppState): unknown[] {
  return [
    s.workspaces,
    s.activeWorkspaceId,
    s.settings.theme,
    s.settings.customColors,
    s.settings.language,
    s.settings.fontFamily,
    s.settings.fontSize,
    s.snippets,
    s.keyButtons,
  ]
}

/**
 * Push a debounced compact state snapshot to main whenever the mirrored slices
 * (workspaces, active id, theme/language/font) or the pty registry (a pane's
 * `running` flag) change. Pushes once immediately. Returns a stop function.
 */
export function startRemoteSnapshotSync(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let prev = relevant(useAppStore.getState())

  const push = (): void => {
    timer = null
    window.snApi.remote.pushState(buildSnapshot(useAppStore.getState()))
  }
  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(push, 100)
  }

  const unsubStore = useAppStore.subscribe((state) => {
    const next = relevant(state)
    if (next.some((v, i) => v !== prev[i])) {
      prev = next
      schedule()
    }
  })
  const unsubPty = onPtyRegistryChange(schedule)
  // Usage lives in its own store; it only mutates when the snapshot changes, so
  // subscribing directly (no reference gate) won't over-fire.
  const unsubUsage = useUsageStore.subscribe(schedule)

  // Seed main with the current state right away (post-hydrate).
  window.snApi.remote.pushState(buildSnapshot(useAppStore.getState()))

  return () => {
    if (timer) clearTimeout(timer)
    unsubStore()
    unsubPty()
    unsubUsage()
  }
}
