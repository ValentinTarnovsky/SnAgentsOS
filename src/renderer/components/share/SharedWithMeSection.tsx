import { useState, type MouseEvent } from 'react'
import { MoreVertical, Plug, Plus, Share2, Trash2, Unplug } from 'lucide-react'
import type { ShareLinkView } from '@shared/share-guest'
import { useAppStore } from '@/lib/store'
import { useAgentStore } from '@/lib/agentStore'
import { effectivePerm, linkLive, orderedPanes, paneStatusOf, toPaneStatus, useShareGuestStore } from '@/lib/shareGuestStore'
import { iconFor } from '@/lib/icons'
import { StatusDot } from '@/components/ui/StatusDot'
import { Tooltip } from '@/components/ui/Tooltip'
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'
import { linkDotClass, linkStatusText, PERM_KEY } from './shareLabels'

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-violet/60'

/** Open a link's view; an idle or ended link dials first (the view shows the wait). */
function openLink(link: ShareLinkView, paneId?: string): void {
  useAgentStore.getState().setView('grid')
  if (link.status === 'idle' || link.status === 'ended') void window.snApi.share.guest.connect(link.id)
  useShareGuestStore.getState().activate(link.id, paneId)
}

/**
 * "Shared with me" in the sidebar (app 2.4.0, item 8, S3), after the
 * workspace list and above the phone indicator: one row per joined share
 * (host, scope, permission chip, state dot), its consoles with their agent
 * dot, and "Join a share...". These are not workspaces: nothing here is in
 * the app store's workspaces, the config, the phone snapshot or the CLI.
 */
export function SharedWithMeSection() {
  const t = useT()
  const collapsed = useAppStore((s) => s.sidebarCollapsed)
  const order = useShareGuestStore((s) => s.order)
  const links = useShareGuestStore((s) => s.links)
  const states = useShareGuestStore((s) => s.states)
  const statuses = useShareGuestStore((s) => s.statuses)
  const activeLinkId = useShareGuestStore((s) => s.activeLinkId)
  const persisted = useShareGuestStore((s) => s.persisted)
  const openJoin = useShareGuestStore((s) => s.openJoin)
  const [menu, setMenu] = useState<{ x: number; y: number; linkId: string } | null>(null)
  const [forget, setForget] = useState<string | null>(null)

  if (!window.snApi?.share?.guest) return null
  const rows = order.map((id) => links[id]).filter((l): l is ShareLinkView => !!l)

  const openMenu = (e: MouseEvent, linkId: string): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, linkId })
  }
  const menuItems = (linkId: string): ContextMenuItem[] => {
    const link = links[linkId]
    if (!link) return []
    const active = link.status !== 'idle' && link.status !== 'ended'
    return [
      active
        ? { label: t('shareGuest.menu.disconnect'), icon: Unplug, onClick: () => void window.snApi.share.guest.disconnect(linkId) }
        : { label: t('shareGuest.menu.connect'), icon: Plug, onClick: () => void window.snApi.share.guest.connect(linkId) },
      { label: t('shareGuest.menu.forget'), icon: Trash2, danger: true, separated: true, onClick: () => setForget(linkId) },
    ]
  }

  const joinBtn = (
    <button
      type="button"
      data-share-join
      onClick={() => openJoin()}
      aria-label={collapsed ? t('shareGuest.join') : undefined}
      className={cn(
        'flex w-full items-center overflow-hidden rounded-btn py-1.5 text-xs text-text-secondary transition-colors hover:bg-card hover:text-text-primary',
        FOCUS_RING,
        collapsed ? 'justify-center px-0' : 'gap-2 px-[11px]',
      )}
    >
      <Plus size={13} className="shrink-0" />
      {!collapsed && <span className="truncate">{t('shareGuest.join')}</span>}
    </button>
  )

  return (
    <section data-shared-with-me className="max-h-[40%] shrink-0 overflow-y-auto overflow-x-hidden border-t border-border px-2 py-2">
      {!collapsed && (
        <div className="px-[11px] pb-1 text-[11px] font-semibold uppercase tracking-wider text-text-secondary/60">{t('shareGuest.section')}</div>
      )}
      {rows.map((link) => {
        const state = states[link.id]
        const perm = effectivePerm(link, state)
        const status = linkStatusText(link, t)
        const active = link.id === activeLinkId
        const label = `${link.host?.label ?? link.hostLabel} · ${state?.title || link.scope.label}`
        const panes = state && linkLive(link) ? orderedPanes(state) : []
        return (
          <div key={link.id} data-shared-link={link.id} data-shared-link-status={link.status}>
            <div
              onContextMenu={(e) => openMenu(e, link.id)}
              className={cn('group relative flex items-center rounded-btn', active ? 'bg-card' : 'hover:bg-card/60')}
            >
              {active && <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r bg-accent-violet" />}
              <Tooltip label={collapsed ? `${label} · ${status}` : ''} side="right" className="min-w-0 flex-1">
                <button
                  type="button"
                  data-shared-link-open={link.id}
                  onClick={() => openLink(link)}
                  className={cn(
                    'flex min-w-0 flex-1 items-center overflow-hidden rounded-btn py-2 text-left text-sm',
                    FOCUS_RING,
                    collapsed ? 'justify-center px-0' : 'gap-2 px-[11px]',
                    active ? 'text-text-primary' : 'text-text-secondary',
                  )}
                >
                  <span className="relative shrink-0">
                    <Share2 size={16} className="shrink-0" />
                    {collapsed && <span aria-hidden className={cn('absolute -bottom-0.5 -right-1.5 h-[7px] w-[7px] rounded-full', linkDotClass(link))} />}
                  </span>
                  {!collapsed && (
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span role="img" aria-label={status} title={status} data-shared-link-dot className={cn('h-2 w-2 shrink-0 rounded-full', linkDotClass(link))} />
                        <span className="truncate">{link.host?.label ?? link.hostLabel}</span>
                        <span data-shared-link-perm={perm} className="ml-auto shrink-0 rounded border border-border px-1 text-[10px] leading-4 text-text-secondary">
                          {t(PERM_KEY[perm])}
                        </span>
                      </span>
                      <span className="block truncate text-[11px] text-text-secondary" title={persisted ? undefined : t('shareGuest.notPersisted')}>
                        {state?.title || link.scope.label}
                        {link.status !== 'connected' ? ` · ${status}` : ''}
                      </span>
                    </span>
                  )}
                </button>
              </Tooltip>
              {!collapsed && (
                <button
                  type="button"
                  onClick={(e) => openMenu(e, link.id)}
                  aria-label={t('shareGuest.menu.more')}
                  className="mr-1 shrink-0 rounded p-1 text-text-secondary opacity-0 transition-opacity hover:bg-bg-secondary hover:text-text-primary focus:opacity-100 group-hover:opacity-100"
                >
                  <MoreVertical size={15} />
                </button>
              )}
            </div>
            {!collapsed && panes.length > 0 && (
              <div className="mb-1 ml-4 space-y-px border-l border-border/60 pl-1.5">
                {panes.map((p) => {
                  const Icon = iconFor(p.icon)
                  return (
                    <button
                      key={p.id}
                      type="button"
                      data-shared-pane-row={p.id}
                      onClick={() => openLink(link, p.id)}
                      className={cn('flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs text-text-secondary transition-colors hover:bg-card/60 hover:text-text-primary', FOCUS_RING)}
                    >
                      <Icon size={13} className="shrink-0" style={{ color: p.color }} />
                      <StatusDot status={toPaneStatus(paneStatusOf(statuses, link.id, p))} size={6} />
                      <span className="min-w-0 truncate">{p.title}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
      {collapsed ? <Tooltip label={t('shareGuest.join')} side="right" className="w-full">{joinBtn}</Tooltip> : joinBtn}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.linkId)} onClose={() => setMenu(null)} />}
      {forget && (
        <ConfirmDialog
          open
          title={t('shareGuest.forget.title')}
          message={t('shareGuest.forget.msg', { host: links[forget]?.host?.label ?? links[forget]?.hostLabel ?? '' })}
          confirmLabel={t('shareGuest.menu.forget')}
          cancelLabel={t('common.cancel')}
          danger
          onConfirm={() => {
            void window.snApi.share.guest.forget(forget)
            setForget(null)
          }}
          onCancel={() => setForget(null)}
        />
      )}
    </section>
  )
}
