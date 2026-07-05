import { useEffect } from 'react'
import { useAppStore } from '@/lib/store'
import { playStatusSound } from '@/lib/sound'

/**
 * Wires the Claude status feature on the renderer side. Mounted once inside
 * AppBody, which only renders after hydration, so the first setConfig push
 * carries the persisted settings and never bounces the main-side HookServer
 * with defaults.
 */
export function useStatusEvents(): void {
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const workspaces = useAppStore((s) => s.workspaces)
  const minimized = useAppStore((s) => s.minimized)
  const notifications = useAppStore((s) => s.settings.notifications)

  // Status updates pushed by main. The notify flag carries main's already
  // debounced notification decision, so the sound can never diverge from the
  // desktop toast.
  useEffect(() => {
    return window.snApi.status.onState((evt) => {
      useAppStore.getState().setPaneStatus(evt)
      const cfg = useAppStore.getState().settings.notifications
      if (evt.notify && cfg.sound) playStatusSound(cfg.soundId, cfg.volume)
    })
  }, [])

  // A status notification was clicked: reveal that console.
  useEffect(() => {
    return window.snApi.status.onReveal((paneId) => {
      const s = useAppStore.getState()
      const ws = s.workspaces.find((w) => w.panes.some((p) => p.id === paneId))
      if (!ws) return
      if (s.activeWorkspaceId !== ws.id) s.setActive(ws.id)
      if ((s.minimized[ws.id] ?? []).includes(paneId)) s.toggleMinimize(ws.id, paneId)
      s.clearPaneAttention(paneId)
    })
  }, [])

  // Regaining focus while a workspace is on screen acknowledges its consoles.
  useEffect(() => {
    const onFocus = (): void => {
      const s = useAppStore.getState()
      if (s.activeWorkspaceId) s.markWorkspaceSeen(s.activeWorkspaceId)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  // Tell main which consoles are actually in view (active workspace minus
  // minimized): its notification rule treats everything else as unseen.
  useEffect(() => {
    const ws = workspaces.find((w) => w.id === activeWorkspaceId)
    const hidden = new Set(activeWorkspaceId ? (minimized[activeWorkspaceId] ?? []) : [])
    const viewed = ws ? ws.panes.map((p) => p.id).filter((id) => !hidden.has(id)) : []
    window.snApi.status.setViewed(viewed)
  }, [activeWorkspaceId, workspaces, minimized])

  // Keep main's notify rules + HookServer lifecycle in sync with settings.
  useEffect(() => {
    window.snApi.status.setConfig(notifications)
  }, [notifications])
}
