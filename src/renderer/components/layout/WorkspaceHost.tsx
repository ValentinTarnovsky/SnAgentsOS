import { useEffect, useState } from 'react'
import { useAppStore } from '@/lib/store'
import { WorkspaceView } from '@/components/workspace/WorkspaceView'

/**
 * Keeps every visited workspace MOUNTED so its terminals (and ptys) survive
 * workspace switches — the inactive ones are just hidden with `display:none`.
 * A workspace mounts the first time it becomes active and is never unmounted
 * afterwards (until it's deleted), so we don't spawn every workspace's shells
 * at startup.
 */
export function WorkspaceHost() {
  const workspaces = useAppStore((s) => s.workspaces)
  const activeId = useAppStore((s) => s.activeWorkspaceId)
  const [mounted, setMounted] = useState<Set<string>>(() =>
    new Set(activeId ? [activeId] : []),
  )

  useEffect(() => {
    if (activeId && !mounted.has(activeId)) {
      setMounted((prev) => new Set(prev).add(activeId))
    }
  }, [activeId, mounted])

  // Tell main which panes are visible so hidden workspaces throttle output (S4).
  const activeWs = workspaces.find((w) => w.id === activeId)
  const activePaneKey = activeWs ? activeWs.panes.map((p) => p.id).join(',') : ''
  useEffect(() => {
    window.snApi.pty.setActive(activePaneKey ? activePaneKey.split(',') : [])
  }, [activePaneKey])

  return (
    <div className="relative h-full w-full">
      {workspaces
        .filter((w) => mounted.has(w.id))
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
