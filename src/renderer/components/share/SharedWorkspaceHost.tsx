import { useShareGuestStore } from '@/lib/shareGuestStore'
import { SharedWorkspaceView } from './SharedWorkspaceView'

/**
 * The shared workspace overlay (app 2.4.0, item 8, S3), absolutely over the
 * local grid inside <main>, also when there is no local workspace at all.
 * WorkspaceHost stays mounted underneath (no local pty remounts) and, while
 * this shows, reports no visible pane and focuses nothing. The terminals
 * mount only while a link is shown, so the host keeps a console awake only
 * while a guest really looks at it. z-30 covers the local header menus and
 * drawers (z-20/z-30, earlier in the DOM); the agents board (z-30, later)
 * still opens over it. `data-shared-workspace` marks the area
 * whose focus is the guest's (shareGuestStore's overlay guard).
 */
export function SharedWorkspaceHost() {
  const activeLinkId = useShareGuestStore((s) => s.activeLinkId)
  const link = useShareGuestStore((s) => (s.activeLinkId ? s.links[s.activeLinkId] : undefined))
  const state = useShareGuestStore((s) => (s.activeLinkId ? s.states[s.activeLinkId] : undefined))
  if (!activeLinkId || !link) return null
  return (
    <div className="absolute inset-0 z-30 bg-bg-primary" data-shared-workspace={activeLinkId}>
      <SharedWorkspaceView key={activeLinkId} link={link} state={state} />
    </div>
  )
}
