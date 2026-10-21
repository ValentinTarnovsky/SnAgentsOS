import { useMemo } from 'react'
import { ArrowLeft, Share2, Unplug } from 'lucide-react'
import type { ShareLinkView } from '@shared/share-guest'
import type { ShareState } from '@shared/share-protocol'
import { GRID_COLS, gridForCount } from '@/components/layout/gridTemplates'
import { effectivePerm, linkLive, orderedPanes, useShareGuestStore } from '@/lib/shareGuestStore'
import { useShareExtrasStore, withPendingPanes } from '@/lib/shareGuestExtras'
import { Tooltip } from '@/components/ui/Tooltip'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'
import { LinkStatusPanel } from './LinkStatusPanel'
import { SharedPaneCell } from './SharedPaneCell'
import { SharedDrawer, SharedExtrasBar } from './SharedWorkspaceExtras'
import { linkDotClass, linkStatusText, PERM_KEY, SCOPE_KEY } from './shareLabels'

/** Matches TilingGrid's gap (gap-1.5). */
const GRID_GAP = 'gap-1.5'

const headerBtn =
  'inline-flex h-8 items-center gap-1.5 rounded-btn border border-border px-2.5 text-xs text-text-primary transition-colors hover:border-accent-violet/40 hover:bg-card'

/**
 * A joined share drawn over the local grid (app 2.4.0, item 8, S3): header
 * with host, scope, permission and state, then its consoles in a grid of its
 * own built only from the pure gridTemplates helpers. The extras of a full
 * control workspace (S5: New console, Chat, Notes, Changes) show with the
 * session's caps; a console a createPane ack named shows before the host's
 * next state lists it.
 */
export function SharedWorkspaceView({ link, state }: { link: ShareLinkView; state: ShareState | undefined }) {
  const t = useT()
  const leave = useShareGuestStore((s) => s.leave)
  const maximizedId = useShareGuestStore((s) => s.maximized[link.id] ?? null)
  const perm = effectivePerm(link, state)
  const hostLabel = link.host?.label ?? link.hostLabel
  const live = linkLive(link)
  const pending = useShareExtrasStore((s) => s.pendingPanes[link.id])
  const panes = useMemo(() => (state ? withPendingPanes(orderedPanes(state), state.caps.createPane ? pending : undefined) : []), [state, pending])
  const max = maximizedId && panes.some((p) => p.id === maximizedId) ? maximizedId : null
  const cols = max ? 1 : GRID_COLS[gridForCount(Math.max(1, panes.length))]
  const statusText = linkStatusText(link, t)

  return (
    <div className="flex h-full w-full flex-col bg-bg-primary" data-shared-view={link.id}>
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Share2 size={15} className="shrink-0 text-text-secondary" />
          <span className="shrink-0 truncate text-sm font-medium text-text-primary" data-shared-host>
            {hostLabel}
          </span>
          <span className="min-w-0 truncate text-xs text-text-secondary" data-shared-scope>
            {t(SCOPE_KEY[state?.scope.kind ?? link.scope.kind])}: {state?.title || link.scope.label}
          </span>
          <span data-shared-perm={perm} className="shrink-0 rounded border border-border px-1.5 text-[10px] leading-4 text-text-secondary">
            {t(PERM_KEY[perm])}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-text-secondary" data-shared-status={link.status}>
            <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full', linkDotClass(link))} />
            <span className="truncate">{statusText}</span>
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {state && <SharedExtrasBar link={link} state={state} panes={panes} />}
          {live ? (
            <button
              type="button"
              data-shared-disconnect
              className={headerBtn}
              onClick={() => {
                void window.snApi.share.guest.disconnect(link.id)
              }}
            >
              <Unplug size={15} />
              {t('shareGuest.view.disconnect')}
            </button>
          ) : null}
          <Tooltip label={t('shareGuest.view.close')} side="bottom">
            <button type="button" aria-label={t('shareGuest.view.close')} data-shared-close onClick={leave} className="rounded p-1.5 text-text-secondary transition-colors hover:bg-card hover:text-text-primary">
              <ArrowLeft size={15} />
            </button>
          </Tooltip>
        </div>
      </div>

      {!live || !state ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <LinkStatusPanel link={link} />
        </div>
      ) : (
        // overflow-clip: a drawer sliding in is clipped here without making this box a scroll container.
        <div className="relative flex min-h-0 w-full flex-1 flex-col overflow-clip">
          {panes.length === 0 ? (
            <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-text-secondary" data-shared-empty>
              {t('shareGuest.view.empty')}
            </div>
          ) : (
            <div className="flex min-h-0 w-full flex-1 flex-col p-1.5">
              <div className={cn('grid min-h-0 w-full flex-1', GRID_GAP)} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoRows: '1fr' }}>
                {panes.map((p) => (
                  <SharedPaneCell
                    key={p.id}
                    linkId={link.id}
                    pane={p}
                    state={state}
                    perm={perm}
                    hostLabel={hostLabel}
                    maximized={max === p.id}
                    hidden={max !== null && max !== p.id}
                  />
                ))}
              </div>
            </div>
          )}
          <SharedDrawer link={link} state={state} panes={panes} hostLabel={hostLabel} />
        </div>
      )}
    </div>
  )
}
