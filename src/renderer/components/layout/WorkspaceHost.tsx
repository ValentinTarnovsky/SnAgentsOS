import { useEffect } from 'react'
import { useAppStore } from '@/lib/store'
import { WorkspaceView } from '@/components/workspace/WorkspaceView'
import { focusWorkspaceConsole } from '@/lib/focusWorkspace'
import { isWorkspaceMounted } from '@/lib/mounting'

/**
 * Keeps every visited workspace MOUNTED so its terminals (and ptys) survive
 * workspace switches, the inactive ones are just hidden with `display:none`.
 * A workspace mounts the first time it becomes active and is never unmounted
 * afterwards (until it's deleted), so we don't spawn every workspace's shells
 * at startup. The mounted set lives in the store (`mountedWorkspaces`, D4) so
 * other features can mount a workspace, or just some of its consoles, without
 * activating it (`ensureMounted`).
 */
export function WorkspaceHost() {
  const workspaces = useAppStore((s) => s.workspaces)
  const activeId = useAppStore((s) => s.activeWorkspaceId)
  const mounted = useAppStore((s) => s.mountedWorkspaces)
  const ensureMounted = useAppStore((s) => s.ensureMounted)

  // The store already mounts on activation; this keeps any other path that
  // sets the active id honest (no-op when it is already 'full').
  useEffect(() => {
    if (activeId) ensureMounted(activeId)
  }, [activeId, ensureMounted])

  // Tell main which panes are visible so hidden workspaces throttle output (S4).
  const activeWs = workspaces.find((w) => w.id === activeId)
  const activePaneKey = activeWs ? activeWs.panes.map((p) => p.id).join(',') : ''
  useEffect(() => {
    window.snApi.pty.setActive(activePaneKey ? activePaneKey.split(',') : [])
  }, [activePaneKey])

  // Auto-focus the active workspace's last-used console whenever we switch to it
  // (sidebar click, Alt+1..9, next/prev, quick-flip, programmatic). Without this
  // focus stays on the sidebar and the first keystrokes go nowhere. Skipped while
  // a modal/palette is open so we don't yank focus out of its input.
  const paletteOpen = useAppStore((s) => s.paletteOpen)
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  const wizardOpen = useAppStore((s) => s.wizardOpen)
  useEffect(() => {
    if (!activeId || paletteOpen || settingsOpen || wizardOpen) return
    return focusWorkspaceConsole(activeId)
  }, [activeId, paletteOpen, settingsOpen, wizardOpen])

  return (
    <div className="relative h-full w-full">
      {workspaces
        .filter((w) => w.id === activeId || isWorkspaceMounted(mounted, w.id))
        .map((w) => (
          <div
            key={w.id}
            className="absolute inset-0"
            style={{ display: w.id === activeId ? 'block' : 'none' }}
          >
            <WorkspaceView workspace={w} isActive={w.id === activeId} />
          </div>
        ))}
    </div>
  )
}
