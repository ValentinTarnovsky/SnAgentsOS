import { useCallback, useRef } from 'react'
import type { SharePaneInfo, SharePerm, ShareState } from '@shared/share-protocol'
import { paneStatusOf, useShareGuestStore, type ShareNoticeReason } from '@/lib/shareGuestStore'
import { useT } from '@/i18n'
import { GuestShareBanner } from './GuestShareBanner'
import { useRemoteXterm } from './useRemoteXterm'

export interface RemoteTerminalPaneProps {
  linkId: string
  pane: SharePaneInfo
  state: ShareState
  perm: SharePerm
  hostLabel: string
}

/**
 * One shared console in the guest's view (app 2.4.0, item 8, S3): the strip
 * and the host-sized terminal. Mounting subscribes the pane on the host
 * (which keeps it awake), unmounting unsubscribes.
 */
export function RemoteTerminalPane({ linkId, pane, state, perm, hostLabel }: RemoteTerminalPaneProps) {
  const t = useT()
  const termRef = useRef<HTMLDivElement>(null)
  const lock = useShareGuestStore((s) => s.locks[linkId]?.[pane.id] ?? null)
  const paneRef = useRef(pane)
  paneRef.current = pane
  const ctx = useCallback(() => {
    const p = paneRef.current
    const st = paneStatusOf(useShareGuestStore.getState().statuses, linkId, p)
    return {
      agent: p.type === 'claude' || p.type === 'codex' || st?.hosted === true || st?.provider !== undefined,
      state: st?.state ?? null,
      ...(st?.precise === false ? { precise: false } : {}),
    }
  }, [linkId])
  const onRefused = useCallback((reason: ShareNoticeReason) => useShareGuestStore.getState().notice(linkId, paneRef.current.id, reason), [linkId])
  const tRef = useRef(t)
  tRef.current = t
  const exitLine = useCallback((code: number | null) => `\r\n\x1b[2m${tRef.current('shareGuest.term.exited', { code: code ?? '?' })}\x1b[0m\r\n`, [])

  useRemoteXterm(termRef, {
    linkId,
    paneId: pane.id,
    perm,
    lock: lock === 'host' || lock === 'other' ? lock : null,
    hostLabel,
    hostPlatform: state.hostPlatform,
    unicode11: state.terminalUnicode11,
    ctx,
    onRefused,
    exitLine,
  })

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-bg-primary">
      <GuestShareBanner linkId={linkId} paneId={pane.id} perm={perm} hostLabel={hostLabel} />
      <div className="min-h-0 w-full flex-1 p-2">
        <div ref={termRef} data-remote-term={pane.id} data-share-perm={perm} className="h-full w-full overflow-hidden" />
      </div>
    </div>
  )
}
