/**
 * Home, the first screen of the live phase (E2-FR-01..15, 47, 50, 51). Header:
 * the wordmark, the connection dot with the PC name (snapshot.hostName), Usage
 * and Settings. Body: the Resume card, inline usage, then one collapsible
 * section per workspace in snapshot order, or the "no workspaces" hero. The
 * FAB opens the console picker. Every tap on a console is phone-only
 * navigation (client.requestOpen): the desktop never changes workspace, and a
 * stopped console of a workspace it has not mounted asks first.
 *
 * The workspace kebab (E2-FR-09) offers New console here, Prompt to every
 * console (that workspace only), Quick Commands (E2-FR-51) and Show on the PC
 * (an explicit switchWorkspace, which also brings the window up).
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { Gauge, Megaphone, MonitorUp, Plus, Settings as SettingsIcon, Zap } from 'lucide-react'
import { BRAND } from '@shared/brand'
import { Sheet } from './Sheet'
import { ActionList } from './ActionList'
import { UsageSheet } from './UsageSheet'
import { GlobalPromptSheet } from './GlobalPromptSheet'
import { QuickCommandsSheet } from './QuickCommandsSheet'
import { PaneActionList } from './PaneActionList'
import { DOT_COLOR, StatusBanner, useConnectionHealth } from './StatusBanner'
import { WorkspaceSection } from './home/WorkspaceSection'
import { ResumeCard } from './home/ResumeCard'
import { UsageCards } from './home/UsageCards'
import { NoWorkspaces } from './home/EmptyStates'
import { Fab, FAB_CLEARANCE_PX } from './home/Fab'
import { NewConsoleSheet } from './home/NewConsoleSheet'
import { ToastStack } from './ToastStack'
import { useRemoteStore } from '../lib/store'
import { client } from '../lib/client'
import { openDiagnostics } from '../lib/connLog'
import { rowShowsTime, STATUS_TICK_MS } from '../lib/statusText'
import { isWorkspaceMounted, type PaneRef } from '../lib/workspace'
import { t } from '../lib/i18n'

function HomeHeader({ onUsage, onSettings }: { onUsage: () => void; onSettings: () => void }): ReactNode {
  const { tier } = useConnectionHealth()
  const hostName = useRemoteStore((s) => s.snapshot?.hostName)
  return (
    <header
      className="flex shrink-0 items-center gap-2 border-b border-border bg-bg-secondary px-3 py-2"
      style={{ paddingTop: 'max(env(safe-area-inset-top), 8px)' }}
    >
      <span data-wordmark className="shrink-0 text-sm font-bold tracking-tight text-text-primary">
        {BRAND.productName}
      </span>
      {/* The dot and the PC name; with a banner up a tap opens Diagnostics (E2-FR-02, 36). */}
      <button
        type="button"
        data-host
        data-action="host-diagnostics"
        disabled={tier === 'ok'}
        onClick={openDiagnostics}
        aria-label={tier === 'ok' ? undefined : t('diag.open')}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-btn py-1 pl-1 text-left enabled:active:bg-card"
      >
        <span data-tier={tier} className={clsx('h-2.5 w-2.5 shrink-0 rounded-full', DOT_COLOR[tier])} />
        <span data-host-name className="truncate text-xs text-text-secondary">{hostName || t('home.thisPc')}</span>
      </button>
      <button
        data-home-usage-btn
        onClick={onUsage}
        className="flex h-10 w-10 items-center justify-center rounded-btn text-text-secondary active:bg-card"
        aria-label={t('act.usage')}
      >
        <Gauge size={20} />
      </button>
      <button
        data-home-settings
        onClick={onSettings}
        className="flex h-10 w-10 items-center justify-center rounded-btn text-text-secondary active:bg-card"
        aria-label={t('act.settings')}
      >
        <SettingsIcon size={20} />
      </button>
    </header>
  )
}

export function HomeScreen(): ReactNode {
  const snapshot = useRemoteStore((s) => s.snapshot)
  const paneStatus = useRemoteStore((s) => s.paneStatus)
  const lastViewedAt = useRemoteStore((s) => s.lastViewedAt)
  const collapsed = useRemoteStore((s) => s.homeCollapsed)
  const toggleCollapsed = useRemoteStore((s) => s.toggleCollapsed)
  const setScreen = useRemoteStore((s) => s.setScreen)
  const viewedPaneId = useRemoteStore((s) => s.activePaneId)
  const [usageOpen, setUsageOpen] = useState(false)
  const [newFor, setNewFor] = useState<{ workspaceId: string | null } | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [promptFor, setPromptFor] = useState<string | null>(null)
  const [quickFor, setQuickFor] = useState<string | null>(null)
  const [actions, setActions] = useState<PaneRef | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // One 30s clock for every relative time on Home, only while one shows.
  const ticking = useMemo(
    () => !!snapshot && snapshot.workspaces.some((ws) => ws.panes.some((p) => rowShowsTime(paneStatus[p.id]))),
    [snapshot, paneStatus],
  )
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), STATUS_TICK_MS)
    return () => clearInterval(id)
  }, [ticking])
  useEffect(() => setNow(Date.now()), [paneStatus])

  const onOpen = useCallback((paneId: string) => void client.requestOpen(paneId), [])
  const onActions = useCallback((workspaceId: string, paneId: string) => setActions({ workspaceId, paneId }), [])
  const onNew = useCallback((workspaceId: string) => setNewFor({ workspaceId }), [])
  const onMenu = useCallback((workspaceId: string) => setMenuFor(workspaceId), [])

  const menuWs = menuFor && snapshot ? snapshot.workspaces.find((w) => w.id === menuFor) : undefined
  const showOnPc = (workspaceId: string): void => {
    void client.sendCtl({ kind: 'switchWorkspace', workspaceId }).then((res) => {
      if (!res.ok) useRemoteStore.getState().setToast(t('toast.actionFailed'))
    })
  }

  return (
    <div data-home className="flex flex-col overflow-hidden bg-bg-primary" style={{ height: 'var(--vvh, 100dvh)' }}>
      <HomeHeader onUsage={() => setUsageOpen(true)} onSettings={() => setScreen('settings')} />
      <main className="relative min-h-0 flex-1">
        <StatusBanner />
        <div
          data-scrollable
          data-home-list
          className="h-full overflow-y-auto px-3 pt-3"
          style={{ paddingBottom: `calc(${FAB_CLEARANCE_PX}px + env(safe-area-inset-bottom))` }}
        >
          {snapshot && snapshot.workspaces.length > 0 ? (
            <>
              <ResumeCard now={now} onOpen={onOpen} onActions={onActions} />
              <UsageCards onOpen={() => setUsageOpen(true)} />
              {snapshot.workspaces.map((ws) => (
                <WorkspaceSection
                  key={ws.id}
                  ws={ws}
                  statuses={paneStatus}
                  lastViewedAt={lastViewedAt}
                  collapsed={collapsed.includes(ws.id)}
                  onPc={ws.id === snapshot.activeWorkspaceId}
                  mounted={isWorkspaceMounted(snapshot, ws.id)}
                  viewedPaneId={viewedPaneId}
                  now={now}
                  onToggle={toggleCollapsed}
                  onMenu={onMenu}
                  onNew={onNew}
                  onOpen={onOpen}
                  onActions={onActions}
                />
              ))}
            </>
          ) : (
            snapshot && <NoWorkspaces />
          )}
        </div>
        <ToastStack bottom={FAB_CLEARANCE_PX} notices />
      </main>

      {snapshot && snapshot.workspaces.length > 0 && <Fab onClick={() => setNewFor({ workspaceId: null })} />}

      <NewConsoleSheet open={newFor != null} onClose={() => setNewFor(null)} workspaceId={newFor?.workspaceId ?? null} />
      <UsageSheet open={usageOpen} onClose={() => setUsageOpen(false)} />
      <PaneActionList target={actions} onClose={() => setActions(null)} />
      <Sheet open={menuWs != null} onClose={() => setMenuFor(null)} title={menuWs?.name ?? t('home.wsMenu')}>
        <div data-ws-actions={menuFor ?? ''}>
          <ActionList
            items={[
              { id: 'newHere', icon: <Plus size={16} />, label: t('home.newHere'), onSelect: () => { const id = menuFor; setMenuFor(null); if (id) setNewFor({ workspaceId: id }) } },
              { id: 'promptAll', icon: <Megaphone size={16} />, label: t('home.promptAll'), onSelect: () => { setPromptFor(menuFor); setMenuFor(null) } },
              { id: 'quick', icon: <Zap size={16} />, label: t('quick.title'), onSelect: () => { setQuickFor(menuFor); setMenuFor(null) } },
              { id: 'showOnPc', icon: <MonitorUp size={16} />, label: t('home.showOnPc'), onSelect: () => { const id = menuFor; setMenuFor(null); if (id) showOnPc(id) } },
            ]}
          />
        </div>
      </Sheet>
      <GlobalPromptSheet open={promptFor != null} onClose={() => setPromptFor(null)} workspaceId={promptFor} />
      <QuickCommandsSheet open={quickFor != null} onClose={() => setQuickFor(null)} workspaceId={quickFor} />
    </div>
  )
}
