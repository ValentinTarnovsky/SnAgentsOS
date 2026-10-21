import { useEffect, useRef, useState, type FocusEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileOutput,
  LayoutDashboard,
  MoreVertical,
  RefreshCcw,
  Pencil,
  Plus,
  Settings,
  Share2,
  Star,
  StarOff,
  StickyNote,
  Trash2,
} from 'lucide-react'
import { useAppStore } from '@/lib/store'
import { useT } from '@/i18n'
import { Tooltip } from '@/components/ui/Tooltip'
import { ActionTooltipLabel, KeyHint, useActionKeys } from '@/components/ui/KeyHint'
import { ariaKeyshortcuts } from '@/lib/keymap'
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { UsageBars } from '@/components/sidebar/UsageBars'
import { RemoteIndicator } from '@/components/sidebar/RemoteIndicator'
import { SharedWithMeSection } from '@/components/share/SharedWithMeSection'
import { ShareHostIndicator } from '@/components/sidebar/ShareHostIndicator'
import { openShareDialog } from '@/lib/shareHostStore'
import { iconFor } from '@/lib/icons'
import { focusWorkspaceConsole } from '@/lib/focusWorkspace'
import { cn } from '@/lib/cn'
import { StatusDot } from '@/components/ui/StatusDot'
import { aggregateStatus, displayStatus, needsUser } from '@shared/status'
import type { PaneStatus, Workspace } from '@shared/types'
import { useAgentStore } from '@/lib/agentStore'
import { navInputFrom, workspaceAgents } from '@/lib/agentNav'
import { formatSince, STATUS_LABEL_KEY } from '@/lib/formatSince'
import { dropWorkspace, freezeSidebarOrder, releaseSidebarOrder, sidebarOrder, useSidebarFreeze } from '@/lib/sidebarOrder'
import { useLang, type MessageKey } from '@/i18n'
import { AgentRows } from '@/components/sidebar/AgentRows'
import { ExitedDot, allExited, exitedLines } from '@/components/sidebar/ExitedDot'
import { SidebarGitSuffix } from '@/components/git/SidebarGitSuffix'
import { useGitStore } from '@/lib/gitStore'
import { compactChip, gitChipEnabled, paneGitKey, workspaceGitKey } from '@/lib/gitChip'
import { NoteInlineEditor, TASK_LABEL_KEY, TaskStateChip, WorkspaceNotePopover } from '@/components/sidebar/WorkspaceNotePopover'
import { openRepoExport, reloadFromRepo } from '@/lib/repoConfigFlow'
import { PANE_DRAG_MIME, isPaneDrag, paneDragId } from '@/lib/paneDrag'
import { revealPane } from '@/lib/revealPane'

interface MenuState {
  x: number
  y: number
  wsId: string
}

/** Discord-style unread pill: how many consoles in this workspace await the user. */
function AttentionBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null
  return (
    <span
      data-attention-badge={count}
      className={cn(
        'flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-[#EF4444] px-1 text-[11px] font-semibold leading-none text-white',
        className,
      )}
    >
      {count > 9 ? '9+' : count}
    </span>
  )
}

/** DataTransfer type of a workspace row being dragged to reorder. */
const WS_DRAG_MIME = 'application/x-snaos-workspace'

/** Keyboard focus ring of the sidebar's buttons, in place of Chromium's white default. */
const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-violet/60'

/** Most console lines in a workspace's combined tooltip before "+N" (E4-FR-11). */
const TIP_MAX_LINES = 8

const SUMMARY_KEY: Record<PaneStatus['state'], MessageKey> = {
  working: 'sidebar.sum.working',
  action: 'sidebar.sum.action',
  done: 'sidebar.sum.done',
  error: 'sidebar.sum.error',
  idle: 'sidebar.sum.idle',
  unknown: 'sidebar.sum.unknown',
}
const SUMMARY_ORDER: PaneStatus['state'][] = ['action', 'error', 'working', 'done', 'idle', 'unknown']

/**
 * Combined status tooltip of a workspace (E4-FR-11): its name (collapsed
 * sidebar only), a summary ("3 working, 1 waiting") and one line per console
 * with a state, up to 8 plus "+N". Built when it opens.
 */
function WorkspaceTip({ ws, paneStatus, showName, extra = [], meta = [] }: { ws: Workspace; paneStatus: Record<string, PaneStatus>; showName: boolean; extra?: string[]; meta?: string[] }) {
  const t = useT()
  const lang = useLang()
  const [now] = useState(() => Date.now())
  // v2.3: counted as the dot shows them (an answered action reads working).
  const withStatus = ws.panes.flatMap((p) => (paneStatus[p.id] ? [{ p, st: displayStatus(paneStatus[p.id]) }] : []))
  const counts = new Map<PaneStatus['state'], number>()
  for (const { st } of withStatus) counts.set(st.state, (counts.get(st.state) ?? 0) + 1)
  const summary = SUMMARY_ORDER.filter((st) => counts.get(st))
    .map((st) => t(SUMMARY_KEY[st], { count: counts.get(st) ?? 0 }))
    .join(', ')
  const lines = withStatus.slice(0, TIP_MAX_LINES).map(({ p, st }) => {
    return [p.title, t(STATUS_LABEL_KEY[st.state]), st.stateSince ? formatSince(st.stateSince, now, lang) : '']
      .filter(Boolean)
      .join(' - ')
  })
  return (
    <span className="flex flex-col" data-workspace-tip>
      {showName && <span>{ws.name}</span>}
      {/* Task state and note (E8-FR-10), collapsed sidebar only. */}
      {meta.map((line, i) => (
        <span key={`m${i}`} className="font-normal text-text-secondary" data-tip-meta>
          {line}
        </span>
      ))}
      {summary && <span className={showName ? 'font-normal' : undefined}>{summary}</span>}
      {lines.map((line, i) => (
        <span key={i} className="font-normal text-text-secondary">
          {line}
        </span>
      ))}
      {withStatus.length > TIP_MAX_LINES && (
        <span className="font-normal text-text-secondary">+{withStatus.length - TIP_MAX_LINES}</span>
      )}
      {/* "<pane>: exited" lines (E6-FR-38). */}
      {extra.map((line, i) => (
        <span key={`x${i}`} className="font-normal text-text-secondary">
          {line}
        </span>
      ))}
    </span>
  )
}

export function Sidebar() {
  const t = useT()
  const {
    workspaces,
    activeWorkspaceId,
    sidebarCollapsed,
    paneAttention,
    paneStatus,
    mountedWorkspaces,
    presets,
    agentSettings,
    setActive,
    setWorkspaceOrder,
    deleteWorkspace,
    renameWorkspace,
    toggleFavorite,
    toggleAgentsCollapsed,
    toggleSidebar,
    setSettingsOpen,
    setWizardOpen,
  } = useAppStore(
    useShallow((s) => ({
      workspaces: s.workspaces,
      activeWorkspaceId: s.activeWorkspaceId,
      sidebarCollapsed: s.sidebarCollapsed,
      paneAttention: s.paneAttention,
      paneStatus: s.paneStatus,
      mountedWorkspaces: s.mountedWorkspaces,
      presets: s.presets,
      agentSettings: s.settings.agents,
      setActive: s.setActive,
      setWorkspaceOrder: s.setWorkspaceOrder,
      deleteWorkspace: s.deleteWorkspace,
      renameWorkspace: s.renameWorkspace,
      toggleFavorite: s.toggleFavorite,
      toggleAgentsCollapsed: s.toggleAgentsCollapsed,
      toggleSidebar: s.toggleSidebar,
      setSettingsOpen: s.setSettingsOpen,
      setWizardOpen: s.setWizardOpen,
    })),
  )
  const sessions = useAgentStore((s) => s.sessions)
  const sleeping = useAgentStore((s) => s.sleeping)
  // Agents board (E5-FR-27): the header button toggles it like Ctrl+Shift+A.
  const boardOpen = useAgentStore((s) => s.view === 'board')
  const boardKeys = useActionKeys('agentsBoard')
  // Consoles whose shell ended on its own (E6-FR-38).
  const paneExit = useAppStore((s) => s.paneExit)
  // Git chip on the second line (E7-FR-08), hidden with settings.gitChip off.
  const gitOn = useAppStore((s) => gitChipEnabled(s.settings))
  const gitSummaries = useGitStore((s) => s.summaries)
  // Agent rows (E5-FR-19): expanded sidebar only, unless turned off.
  const rowsOn = !sidebarCollapsed && agentSettings?.sidebarAgentRows !== false
  const navInput = navInputFrom(
    { workspaces, paneStatus, paneAttention, mountedWorkspaces, presets, settings: { agents: agentSettings } },
    { sessions, sleeping },
  )

  const [menu, setMenu] = useState<MenuState | null>(null)
  // Workspace row under a console being dragged by its header.
  const [paneDropWs, setPaneDropWs] = useState<string | null>(null)
  // Workspace reorder by drag (manual order only): the dragged row and the gap
  // it would land in. Rows never move during the drag, only a line shows the
  // gap, and the order changes once on drop.
  const wsDragId = useRef<string | null>(null)
  const [wsDrop, setWsDrop] = useState<{ id: string; after: boolean } | null>(null)
  useEffect(() => {
    if (!paneDropWs && !wsDrop) return
    const reset = (): void => {
      setPaneDropWs(null)
      setWsDrop(null)
      wsDragId.current = null
    }
    window.addEventListener('dragend', reset, true)
    window.addEventListener('drop', reset, true)
    return () => {
      window.removeEventListener('dragend', reset, true)
      window.removeEventListener('drop', reset, true)
    }
  }, [paneDropWs, wsDrop])
  const [confirmWs, setConfirmWs] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  // Note and task state (E8-FR-10): the popover and the inline editor.
  const [notePopover, setNotePopover] = useState<MenuState | null>(null)
  const [noteEditingId, setNoteEditingId] = useState<string | null>(null)
  const setWorkspaceNote = useAppStore((s) => s.setWorkspaceNote)
  /** Pending console focus of the last row click; a double click cancels it for the inline editor. */
  const rowFocusCancel = useRef<(() => void) | null>(null)

  const onNew = (): void => setWizardOpen(true)
  // Shortcut chips from the live keymap (E4-FR-30): a rebind shows at once.
  const newKeys = useActionKeys('newWorkspace')
  const settingsKeys = useActionKeys('openSettings')
  const sidebarKeys = useActionKeys('toggleSidebar')

  // Favorites float to the top (stable within each group); Alt+1..9 use the same
  // order. Smart (E5-FR-22) ranks by the most demanding agent and holds still
  // while the pointer is over the sidebar or the focus is inside it.
  const frozen = useSidebarFreeze((s) => s.frozen)
  const smart = agentSettings?.sidebarSort === 'smart'
  const sorted = sidebarOrder(workspaces, smart ? { sort: 'smart', nav: navInput, frozen } : undefined)
  // Drag to reorder only in manual order: the smart order places rows itself.
  const reorderable = !smart && workspaces.length > 1
  const shownIds = useRef<string[]>([])
  shownIds.current = sorted.map((w) => w.id)
  const hovering = useRef(false)
  const focusInside = useRef(false)
  const syncFreeze = (): void => {
    if (hovering.current || focusInside.current) freezeSidebarOrder(shownIds.current)
    else releaseSidebarOrder()
  }
  useEffect(() => () => releaseSidebarOrder(), [])
  const onBlurAside = (e: FocusEvent<HTMLElement>): void => {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    focusInside.current = false
    syncFreeze()
  }

  const openMenu = (e: { clientX: number; clientY: number }, wsId: string): void => {
    setMenu({ x: e.clientX, y: e.clientY, wsId })
  }

  const startRename = (wsId: string): void => {
    const ws = workspaces.find((w) => w.id === wsId)
    setRenameValue(ws?.name ?? '')
    setRenamingId(wsId)
  }

  const commitRename = (): void => {
    if (renamingId) renameWorkspace(renamingId, renameValue)
    setRenamingId(null)
  }

  const menuItems = (wsId: string): ContextMenuItem[] => {
    const ws = workspaces.find((w) => w.id === wsId)
    return [
      {
        label: ws?.favorite ? t('ctx.unfavorite') : t('ctx.favorite'),
        icon: ws?.favorite ? StarOff : Star,
        onClick: () => toggleFavorite(wsId),
      },
      { label: t('ctx.rename'), icon: Pencil, onClick: () => startRename(wsId) },
      { label: t('note.menu'), icon: StickyNote, onClick: () => setNotePopover(menu ? { ...menu, wsId } : { x: 80, y: 80, wsId }) },
      // Share (app 2.4.0, item 8): the Share dialog on the whole workspace.
      { label: t('shareHost.menu.shareWorkspace'), icon: Share2, onClick: () => openShareDialog({ kind: 'workspace', workspaceId: wsId }) },
      // Per-repo .snagentsos.json (E8-FR-26/27): reload only for a workspace made or exported with one.
      ...(ws?.cwd
        ? [
            { label: t('repo.export.menu'), icon: FileOutput, separated: true, onClick: () => openRepoExport(wsId) },
            ...(ws.repoConfig ? [{ label: t('repo.reload.menu'), icon: RefreshCcw, onClick: () => void reloadFromRepo(wsId, t) }] : []),
          ]
        : []),
      {
        label: t('ctx.delete'),
        icon: Trash2,
        danger: true,
        separated: true,
        onClick: () => setConfirmWs(wsId),
      },
    ]
  }

  return (
    <aside
      data-sidebar
      data-sidebar-frozen={frozen ? '' : undefined}
      onPointerEnter={() => {
        hovering.current = true
        syncFreeze()
      }}
      onPointerLeave={() => {
        hovering.current = false
        syncFreeze()
      }}
      onFocus={() => {
        focusInside.current = true
        syncFreeze()
      }}
      onBlur={onBlurAside}
      className={cn(
        'flex h-full shrink-0 flex-col overflow-hidden border-r border-border bg-bg-secondary transition-[width] duration-200 ease-out',
        sidebarCollapsed ? 'w-[60px]' : 'w-[260px]',
      )}
    >
      <div
        className={cn(
          'flex h-11 shrink-0 items-center px-3',
          sidebarCollapsed ? 'justify-center' : 'justify-between',
        )}
      >
        {!sidebarCollapsed && (
          <span className="pl-1 text-[11px] font-semibold uppercase tracking-wider text-text-secondary/60">
            {t('sidebar.header')}
          </span>
        )}
        <Tooltip label={<ActionTooltipLabel label={sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')} action="toggleSidebar" />} side="right">
          <button
            onClick={toggleSidebar}
            data-sidebar-toggle
            aria-label={sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')}
            aria-keyshortcuts={sidebarKeys.length > 0 ? ariaKeyshortcuts(sidebarKeys) : undefined}
            className={cn(
              'rounded-lg border border-border/70 bg-card/40 p-1 text-text-secondary transition-colors hover:border-accent-violet/40 hover:bg-card hover:text-text-primary',
              FOCUS_RING,
            )}
          >
            {sidebarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
        </Tooltip>
      </div>

      {/* New workspace and the agents board (E5-FR-27) share a row; collapsed they stack. */}
      <div className={cn('flex gap-1.5 px-2 pb-2 pt-1', sidebarCollapsed ? 'flex-col items-center' : 'items-stretch')}>
        <Tooltip label={sidebarCollapsed ? <ActionTooltipLabel label={t('sidebar.newWorkspace')} action="newWorkspace" /> : ''} side="right">
          <button
            onClick={onNew}
            data-sidebar-new
            aria-label={sidebarCollapsed ? t('sidebar.newWorkspace') : undefined}
            aria-keyshortcuts={newKeys.length > 0 ? ariaKeyshortcuts(newKeys) : undefined}
            className={cn(
              'group relative flex items-center justify-center overflow-hidden rounded-btn border border-accent-violet/30 bg-accent-violet/10 text-sm font-medium text-text-primary transition-colors hover:border-accent-violet/50 hover:bg-accent-violet/20',
              FOCUS_RING,
              sidebarCollapsed ? 'h-9 w-10 gap-0' : 'min-w-0 flex-1 gap-2 px-3 py-2',
            )}
          >
            <Plus size={16} className="shrink-0 text-accent-violet" />
            <span
              className={cn(
                'overflow-hidden whitespace-nowrap transition-all duration-200',
                sidebarCollapsed ? 'max-w-0 opacity-0' : 'max-w-[170px] opacity-100',
              )}
            >
              {t('sidebar.newWorkspace')}
            </span>
            {!sidebarCollapsed && (
              <KeyHint keys={newKeys} className="absolute right-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
            )}
          </button>
        </Tooltip>
        <Tooltip label={<ActionTooltipLabel label={t('agents.board.toggle')} action="agentsBoard" />} side="right" className="shrink-0">
          <button
            type="button"
            data-agents-board-toggle
            aria-pressed={boardOpen}
            aria-label={t('agents.board.toggle')}
            aria-keyshortcuts={boardKeys.length > 0 ? ariaKeyshortcuts(boardKeys) : undefined}
            onClick={() => useAgentStore.getState().setView(boardOpen ? 'grid' : 'board')}
            className={cn(
              'flex items-center justify-center rounded-btn border transition-colors',
              FOCUS_RING,
              sidebarCollapsed ? 'h-9 w-10' : 'w-9',
              boardOpen
                ? 'border-accent-violet/60 bg-accent-violet/15 text-text-primary'
                : 'border-border/70 bg-card/40 text-text-secondary hover:border-accent-violet/40 hover:bg-card hover:text-text-primary',
            )}
          >
            <LayoutDashboard size={16} />
          </button>
        </Tooltip>
      </div>

      <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overflow-x-hidden px-2">
        {sorted.map((w) => {
          const active = w.id === activeWorkspaceId
          const WsIcon = iconFor(w.panes[0]?.icon)
          const renaming = renamingId === w.id
          // One per console that needs the user, however many requests it holds.
          // v2.3: main's attention when it sends one (an answered request no longer counts).
          const attentionCount = w.panes.filter((p) => needsUser(paneStatus[p.id]) || paneAttention[p.id]).length
          const status = aggregateStatus(w.panes.map(p => displayStatus(paneStatus[p.id])))
          const exited = exitedLines(w.panes, paneExit, t)
          const statusLabel = w.panes.filter(p => paneStatus[p.id]).map(p => `${p.title}: ${t(`status.${displayStatus(paneStatus[p.id]).state}`)}`).concat(exited).join(', ')
          // Gray dot when no agent state is shown and every console has exited (E6-FR-38).
          const exitedDot = !status && allExited(w.panes, paneExit)
          const exitedLabel = exited.join('\n')
          const agents = rowsOn ? workspaceAgents(w, navInput) : []
          const git = gitOn ? gitSummaries[workspaceGitKey(w.id)] : undefined
          const gitLine = git ? compactChip(git) : null
          // A workspace that is no repo but holds several (one per console): how many its consoles work in.
          const repoCount = gitOn && !git ? new Set(w.panes.map((p) => gitSummaries[paneGitKey(p.id)]?.repoRoot).filter(Boolean)).size : 0
          // E8-FR-10: the note replaces the console count; state and note join the collapsed tooltip.
          const noteEditing = noteEditingId === w.id && !sidebarCollapsed
          const meta = [w.taskState ? t(TASK_LABEL_KEY[w.taskState]) : '', w.note ?? ''].filter(Boolean)
          return (
            <div
              key={w.id}
              data-sidebar-ws={w.id}
              className="relative"
              onDragOver={(e) => {
                const dragId = wsDragId.current
                if (!dragId || !e.dataTransfer.types.includes(WS_DRAG_MIME)) return
                const dragged = workspaces.find((x) => x.id === dragId)
                // Favorites and plain workspaces reorder only among themselves.
                if (!dragged || !!dragged.favorite !== !!w.favorite) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                const r = e.currentTarget.getBoundingClientRect()
                const after = e.clientY > r.top + r.height / 2
                if (wsDrop?.id !== w.id || wsDrop.after !== after) setWsDrop({ id: w.id, after })
              }}
              onDrop={(e) => {
                const dragId = wsDragId.current
                if (!dragId || !wsDrop || !e.dataTransfer.types.includes(WS_DRAG_MIME)) return
                e.preventDefault()
                const target = sorted.findIndex((x) => x.id === wsDrop.id)
                const next = target === -1 ? null : dropWorkspace(sorted, dragId, target + (wsDrop.after ? 1 : 0))
                if (next) setWorkspaceOrder(next)
                setWsDrop(null)
                wsDragId.current = null
              }}
            >
              {wsDrop?.id === w.id && (
                <span
                  aria-hidden
                  data-ws-drop-line={wsDrop.after ? 'after' : 'before'}
                  className={cn('pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded bg-accent-violet', wsDrop.after ? '-bottom-px' : '-top-px')}
                />
              )}
              <div
                draggable={reorderable && renamingId !== w.id && noteEditingId !== w.id}
                onDragStart={(e) => {
                  // Only the row itself: the agent rows below are not handles.
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData(WS_DRAG_MIME, w.id)
                  wsDragId.current = w.id
                }}
                onDragEnd={() => {
                  wsDragId.current = null
                  setWsDrop(null)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  openMenu(e, w.id)
                }}
                // A console dragged by its header onto another workspace moves there (session only).
                onDragOver={(e) => {
                  if (!isPaneDrag(e.dataTransfer.types) || w.panes.some((p) => p.id === paneDragId())) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  if (paneDropWs !== w.id) setPaneDropWs(w.id)
                }}
                onDragLeave={(e) => {
                  if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
                  if (paneDropWs === w.id) setPaneDropWs(null)
                }}
                onDrop={(e) => {
                  const paneId = e.dataTransfer.getData(PANE_DRAG_MIME)
                  setPaneDropWs(null)
                  if (!paneId) return
                  e.preventDefault()
                  // After the drag settles: the source cell unmounts with the move.
                  setTimeout(() => {
                    if (useAppStore.getState().movePaneToWorkspace(paneId, w.id)) revealPane(paneId)
                  }, 0)
                }}
                data-pane-drop={paneDropWs === w.id || undefined}
                className={cn(
                  'group relative flex items-center rounded-btn',
                  paneDropWs === w.id ? 'bg-accent-violet/15 ring-1 ring-accent-violet/60' : active ? 'bg-card' : 'hover:bg-card/60',
                )}
              >
                {active && (
                  <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r bg-accent-violet" />
                )}

                {noteEditing && !renaming ? (
                  <div className="flex min-w-0 flex-1 items-start gap-2 px-[11px] py-2" data-note-editing={w.id}>
                    <WsIcon size={16} className="mt-0.5 shrink-0 text-accent-violet" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-text-primary">{w.name}</span>
                      <NoteInlineEditor
                        initial={w.note ?? ''}
                        onCommit={(note) => {
                          setWorkspaceNote(w.id, note)
                          setNoteEditingId(null)
                        }}
                        onCancel={() => setNoteEditingId(null)}
                      />
                    </span>
                  </div>
                ) : renaming && !sidebarCollapsed ? (
                  <div className="flex min-w-0 flex-1 items-center gap-2 px-[11px] py-2">
                    <WsIcon size={16} className="shrink-0 text-accent-violet" />
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename()
                        if (e.key === 'Escape') setRenamingId(null)
                      }}
                      className="min-w-0 flex-1 rounded border border-accent-violet/50 bg-bg-primary px-1.5 py-0.5 text-sm text-text-primary outline-none"
                    />
                  </div>
                ) : (
                  <Tooltip
                    label={sidebarCollapsed ? (status ? <WorkspaceTip ws={w} paneStatus={paneStatus} showName meta={meta} extra={gitLine ? [gitLine, ...exited] : exited} /> : gitLine || meta.length > 0 ? <span className="flex flex-col"><span>{w.name}</span>{meta.map((line, i) => <span key={i} className="font-normal text-text-secondary" data-tip-meta>{line}</span>)}{gitLine && <span className="font-normal text-text-secondary">{gitLine}</span>}</span> : w.name) : ''}
                    side="right"
                    delay={sidebarCollapsed && status ? 200 : undefined}
                    className="min-w-0 flex-1"
                  >
                    <button
                      // No dot to hover (no agent state, not every console exited):
                      // the "<pane>: exited" lines go on the row itself (E6-FR-38).
                      title={!sidebarCollapsed && !status && !exitedDot && exitedLabel ? exitedLabel : undefined}
                      onClick={() => {
                        useAgentStore.getState().setView('grid')
                        setActive(w.id)
                        // Move focus into the workspace's console right away, even
                        // when re-clicking the already-active one, so the click
                        // never leaves focus parked on this sidebar button.
                        rowFocusCancel.current?.()
                        rowFocusCancel.current = focusWorkspaceConsole(w.id)
                      }}
                      className={cn(
                        'flex min-w-0 flex-1 items-center overflow-hidden rounded-btn py-2 text-left text-sm',
                        FOCUS_RING,
                        // Collapsed, the icon alone is centered on the rail's axis.
                        sidebarCollapsed ? 'justify-center gap-0 px-0' : 'gap-2 px-[11px]',
                        active ? 'text-text-primary' : 'text-text-secondary',
                      )}
                    >
                      <span className="relative shrink-0">
                      <WsIcon
                        size={16}
                        className="shrink-0"
                        style={{ color: active ? (w.panes[0]?.color ?? '#6366f1') : undefined }}
                      />
                      {/* Beside the glyph, with no backing disc: an opaque cutout bit the icon's corner (v2.2.1). */}
                      {sidebarCollapsed && (status || exitedDot) && <span className="pointer-events-none absolute -bottom-0.5 -right-2 flex" data-rail-status>{status ? <StatusDot status={status} label={statusLabel} size={7} noTooltip /> : <ExitedDot label={exitedLabel} size={7} />}</span>}
                      </span>
                      <span
                        className={cn(
                          'min-w-0 transition-opacity duration-150',
                          sidebarCollapsed ? 'pointer-events-none w-0 flex-none overflow-hidden opacity-0' : 'flex-1 opacity-100',
                        )}
                      >
                        <span className="flex items-center gap-1">
                          {!sidebarCollapsed && (exitedDot ? <ExitedDot label={exitedLabel} /> : <StatusDot status={status} label={statusLabel} tip={<WorkspaceTip ws={w} paneStatus={paneStatus} showName={false} extra={exited} />} />)}
                          <span className="truncate">{w.name}</span>
                          {w.favorite && (
                            <Star size={11} className="shrink-0 fill-amber-400 text-amber-400" />
                          )}
                          {w.taskState && !sidebarCollapsed && <TaskStateChip state={w.taskState} />}
                        </span>
                        <span
                          className="flex min-w-0 text-[11px] text-text-secondary"
                          data-ws-second-line={w.id}
                          onDoubleClick={(e) => {
                            if (sidebarCollapsed) return
                            e.preventDefault()
                            e.stopPropagation()
                            // The clicks before it queued a console focus: keep the editor's.
                            rowFocusCancel.current?.()
                            rowFocusCancel.current = null
                            setNoteEditingId(w.id)
                          }}
                        >
                          {w.note ? (
                            <span className={cn('min-w-0 truncate', git ? 'max-w-[70%] shrink' : 'max-w-full')} title={w.note} data-ws-note>
                              {w.note}
                            </span>
                          ) : (
                            <span className="max-w-full shrink-0 truncate">
                              {w.panes.length === 1
                                ? t('sidebar.consoleOne', { count: w.panes.length })
                                : t('sidebar.consoleMany', { count: w.panes.length })}
                            </span>
                          )}
                          {git && <SidebarGitSuffix summary={git} />}
                          {repoCount > 0 && (
                            <span className="min-w-0 truncate pl-1" data-sidebar-repos={repoCount}>
                              {'· '}
                              {repoCount === 1 ? t('sidebar.reposOne', { count: repoCount }) : t('sidebar.reposMany', { count: repoCount })}
                            </span>
                          )}
                        </span>
                      </span>
                    </button>
                  </Tooltip>
                )}

                {!sidebarCollapsed && !renaming && !noteEditing && (
                  <AttentionBadge count={attentionCount} className="mr-1" />
                )}
                {rowsOn && !renaming && agents.length > 0 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleAgentsCollapsed(w.id)
                    }}
                    aria-label={w.agentsCollapsed ? t('agents.row.expand') : t('agents.row.collapse')}
                    aria-expanded={!w.agentsCollapsed}
                    data-agents-chevron={w.id}
                    className="shrink-0 rounded p-1 text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
                  >
                    {w.agentsCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  </button>
                )}
                {sidebarCollapsed && (
                  <AttentionBadge
                    count={attentionCount}
                    className="pointer-events-none absolute right-0.5 top-0.5"
                  />
                )}
                {!sidebarCollapsed && !renaming && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      openMenu(e, w.id)
                    }}
                    aria-label={t('ctx.moreActions')}
                    className="mr-1 shrink-0 rounded p-1 text-text-secondary opacity-0 transition-opacity hover:bg-bg-secondary hover:text-text-primary focus:opacity-100 group-hover:opacity-100"
                  >
                    <MoreVertical size={15} />
                  </button>
                )}
              </div>
              {rowsOn && !w.agentsCollapsed && (
                <AgentRows entries={agents} presets={presets} topicAsTitle={agentSettings?.topicAsTitle !== false} wsGit={git} gitOn={gitOn} />
              )}
            </div>
          )
        })}
      </nav>

      {/* Shared with me (app 2.4.0): joined shares, never workspaces of this store. */}
      <SharedWithMeSection />
      <ShareHostIndicator />
      <RemoteIndicator />
      <UsageBars />

      <div className="shrink-0 border-t border-border p-2">
        <Tooltip label={sidebarCollapsed ? <ActionTooltipLabel label={t('sidebar.settings')} action="openSettings" /> : ''} side="right" className="w-full">
          <button
            onClick={() => setSettingsOpen(true)}
            data-sidebar-settings
            aria-label={sidebarCollapsed ? t('sidebar.settings') : undefined}
            aria-keyshortcuts={settingsKeys.length > 0 ? ariaKeyshortcuts(settingsKeys) : undefined}
            className={cn(
              'group flex w-full items-center overflow-hidden rounded-btn py-2 text-sm text-text-secondary transition-colors hover:bg-card hover:text-text-primary',
              FOCUS_RING,
              sidebarCollapsed ? 'justify-center gap-0 px-0' : 'gap-2 px-[11px]',
            )}
          >
            <Settings size={16} className="shrink-0" />
            <span
              className={cn(
                'overflow-hidden whitespace-nowrap transition-opacity duration-150',
                sidebarCollapsed ? 'pointer-events-none w-0 opacity-0' : 'opacity-100',
              )}
            >
              {t('sidebar.settings')}
            </span>
            {!sidebarCollapsed && (
              <KeyHint keys={settingsKeys} className="ml-auto opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
            )}
          </button>
        </Tooltip>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.wsId)}
          onClose={() => setMenu(null)}
        />
      )}

      {notePopover && (
        <WorkspaceNotePopover
          wsId={notePopover.wsId}
          x={notePopover.x}
          y={notePopover.y}
          onClose={() => setNotePopover(null)}
        />
      )}

      {confirmWs && (
        <ConfirmDialog
          open
          title={t('confirm.deleteWorkspaceTitle')}
          message={t('confirm.deleteWorkspaceMsg', {
            name: workspaces.find((w) => w.id === confirmWs)?.name ?? '',
          })}
          confirmLabel={t('confirm.deleteYes')}
          cancelLabel={t('confirm.deleteNo')}
          danger
          onConfirm={() => {
            deleteWorkspace(confirmWs)
            setConfirmWs(null)
          }}
          onCancel={() => setConfirmWs(null)}
        />
      )}
    </aside>
  )
}
