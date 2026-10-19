import { useEffect, useState, type DragEvent } from 'react'
import {
  ArchiveRestore,
  ArchiveX,
  Clock,
  ClipboardCopy,
  Eraser,
  GitBranch,
  GripVertical,
  History,
  Maximize2,
  Minimize2,
  Minus,
  Paintbrush,
  Pencil,
  Play,
  RotateCw,
  SquarePen,
  X,
} from 'lucide-react'
import { motion } from 'framer-motion'
import type { AgentPreset, Pane, Workspace } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { isPaneMounted } from '@/lib/mounting'
import { resolveLaunch } from '@/lib/launch'
import { getPtyId } from '@/lib/ptyRegistry'
import { clearSavedScrollback } from '@/lib/scrollback'
import { redrawPane } from '@/lib/redrawRegistry'
import { copyLastOutput, hasLastOutput } from '@/lib/shellMarksRegistry'
import { focusPane } from '@/lib/focus'
import { isBracketedPaste, pasteToPane } from '@/lib/pasteRegistry'
import { isAgentPane } from '@/lib/agentPane'
import { buildDropPayload, type DropMode } from '@/lib/dropPaths'
import { INTERNAL_PATH_MIME, parseInternalPath } from '@/lib/dragNonce'
import { isPathDrag, nextDragDepth, type DragHoverEvent } from '@/lib/dropHover'
import { iconFor } from '@/lib/icons'
import { Tooltip } from '@/components/ui/Tooltip'
import { PaneStatusDot } from '@/components/ui/StatusDot'
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu'
import { ScheduleDialog } from '@/components/layout/ScheduleDialog'
import { scheduleNextLabel } from '@/lib/scheduleFormat'
import { TerminalPane } from '@/components/terminal/TerminalPane'
import { PaneErrorBoundary } from '@/components/common/ErrorBoundary'
import { ResumeChip } from '@/components/agents/ResumeChip'
import { SleepingOverlay } from '@/components/agents/SleepingOverlay'
import { CacheChip } from '@/components/agents/CacheChip'
import { useAgentStore } from '@/lib/agentStore'
import { useGitStore } from '@/lib/gitStore'
import { workspaceGitKey } from '@/lib/gitChip'
import { useWorktreeStore } from '@/lib/worktreeStore'
import { templateFromPane, worktreeOffer } from '@/lib/worktrees'
import { PaneWorktreeChip } from '@/components/git/PaneWorktreeChip'
import { WorktreeMissingCard } from '@/components/layout/WorktreeMissingCard'
import { RepoSetupPlaceholder } from '@/components/layout/RepoSetupPlaceholder'
import { reopenClosedConsole, restartClean, restartFresh, restartFromButton, restartResume, resumeMenuState } from '@/lib/agentLaunch'
import { useLang, useT } from '@/i18n'
import { cn } from '@/lib/cn'
import { PaneStatusLine } from './PaneStatusLine'

interface PaneCellProps {
  workspace: Workspace
  pane: Pane
  presets: AgentPreset[]
  /** Whether the owning workspace is the visible one. */
  workspaceActive: boolean
  /** Currently maximized pane id in this workspace (null = none). */
  maximizedId: string | null
  /** Pane ids minimized (collapsed to the strip) in this workspace. */
  minimizedIds: string[]
  index: number
  isDragging: boolean
  draggable: boolean
  onToggleMax: () => void
  onToggleMin: () => void
  onClose: () => void
  onDragStartCell: () => void
  onDragEnterCell: () => void
  onDragEndCell: () => void
}

export function PaneCell({
  workspace,
  pane,
  presets,
  workspaceActive,
  maximizedId,
  minimizedIds,
  isDragging,
  draggable,
  onToggleMax,
  onToggleMin,
  onClose,
  onDragStartCell,
  onDragEnterCell,
  onDragEndCell,
}: PaneCellProps) {
  const t = useT()
  const lang = useLang()
  const Icon = iconFor(pane.icon)
  const connections = useAppStore((s) => s.connections)
  const { cwd, initialCommand, setup, launchKind } = resolveLaunch(pane, workspace, presets, connections)
  // E6-FR-32: the configured default shell for this OS (main falls back to the
  // OS default, with a warning line, when it does not exist). Read at mount.
  const shell = useAppStore((s) => {
    const p = window.snApi.platform
    return p === 'win32' || p === 'darwin' || p === 'linux' ? s.settings.defaultShell[p] : undefined
  })

  const isMax = maximizedId === pane.id
  const isMin = minimizedIds.includes(pane.id)
  const hidden = (maximizedId !== null && !isMax) || isMin
  const cellVisible = workspaceActive && !hidden

  const renamePane = useAppStore((s) => s.renamePane)
  // Resume entries (E5-FR-09): from main's session record and the integrations.
  const settings = useAppStore((s) => s.settings)
  const session = useAgentStore((s) => s.sessions[pane.id])
  const closedCount = useAgentStore((s) => s.closedStack.length)
  // Held back by the "resume interrupted chats?" dialog (E5-FR-12).
  const gated = useAgentStore((s) => !!s.gated[pane.id])
  // Put to sleep by hibernation (E5-FR-25): the overlay stands in for the terminal.
  const sleepInfo = useAgentStore((s) => s.sleeping[pane.id])
  // Agent topic (or first prompt) after the title, dimmed (E5-FR-21).
  const liveTopic = useAppStore((s) => s.paneStatus[pane.id]?.topic || s.paneStatus[pane.id]?.firstPrompt)
  const topicRaw = liveTopic || session?.topic || session?.firstPrompt
  const topic = topicRaw && topicRaw !== pane.title ? topicRaw : undefined
  const resume = resumeMenuState({ workspaces: [workspace], presets, settings }, session ? { [pane.id]: session } : {}, pane.id)
  const epoch = useAppStore((s) => s.paneEpoch[pane.id] ?? 0)
  // The shell ended on its own (E6-FR-17/38): gray "exited" tag in the header.
  const exited = useAppStore((s) => s.paneExit[pane.id] !== undefined)
  // Partial mount (D4): a console outside the mounted list shows a placeholder
  // instead of spawning. The visible workspace always counts as mounted.
  const mounted = useAppStore(
    (s) => workspaceActive || isPaneMounted(s.mountedWorkspaces, workspace.id, pane.id),
  )
  const ensureMounted = useAppStore((s) => s.ensureMounted)
  // E8-FR-25: held back until the repo setup console exits with 0.
  const held = useAppStore((s) => s.heldPanes[pane.id])

  // Worktree console (E7-FR-27..36): "Duplicate in worktree" uses the pane's
  // resolved cwd; a pane on a connection profile never offers it.
  const wsGitSummary = useGitStore((s) => s.summaries[workspaceGitKey(workspace.id)])
  const wsGitError = useGitStore((s) => s.errors[workspaceGitKey(workspace.id)])
  const openWorktreeLaunch = useWorktreeStore((s) => s.openLaunch)
  const offer = worktreeOffer(workspace, pane, presets, connections, { summary: wsGitSummary, error: wsGitError })
  const wt = pane.worktree
  const wtMissing = useWorktreeStore((s) => !!s.missing[pane.id])
  // FR-36: before a worktree console spawns (mount, remount, restart clean),
  // ask main whether its folder still exists; the terminal waits for the answer.
  const [wtChecked, setWtChecked] = useState<string | null>(null)
  const wtCheckKey = wt && mounted ? `${wt.path}|${epoch}` : null
  useEffect(() => {
    if (!wt || !wtCheckKey) return
    let live = true
    const done = (exists: boolean): void => {
      if (!live) return
      if (exists) useWorktreeStore.getState().clearMissing(pane.id)
      else useWorktreeStore.getState().markMissing(pane.id)
      setWtChecked(wtCheckKey)
    }
    window.snApi.git
      .worktreeInspect({ path: wt.path, base: wt.base })
      .then((r) => done(r.exists))
      .catch(() => done(true))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wtCheckKey])
  const wtPending = !!wt && wtCheckKey !== null && wtChecked !== wtCheckKey
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [nameVal, setNameVal] = useState(pane.title)
  const [scheduling, setScheduling] = useState(false)
  // E8-FR-28: the clock is lit only for an active schedule; a paused one
  // (or a fired one-shot) is dimmed and its tooltip says "Paused".
  const hasSchedule = pane.schedule != null
  const isScheduled = hasSchedule && pane.schedule!.enabled !== false
  const scheduleTip = pane.schedule ? scheduleNextLabel(pane.schedule, t, lang) : t('pane.schedule')

  const startRename = (): void => {
    setNameVal(pane.title)
    setRenaming(true)
  }
  const commitRename = (): void => {
    renamePane(workspace.id, pane.id, nameVal)
    setRenaming(false)
  }

  // Drop feedback (E7-FR-03): a depth counter of dragenter/dragleave, so the
  // overlay stays put while the pointer crosses the header or the xterm canvas.
  const [dragDepth, setDragDepth] = useState(0)
  const dropHover = dragDepth > 0
  const stepDrag = (event: DragHoverEvent): void => setDragDepth((d) => nextDragDepth(d, event))
  useEffect(() => {
    if (!dropHover) return
    // A drag that ends elsewhere (Esc, drop on another target) may never send
    // the last dragleave here; any window-level end clears the overlay.
    const reset = (): void => setDragDepth(0)
    window.addEventListener('dragend', reset, true)
    window.addEventListener('drop', reset, true)
    return () => {
      window.removeEventListener('dragend', reset, true)
      window.removeEventListener('drop', reset, true)
    }
  }, [dropHover])

  // Drop file(s)/folder(s) onto the console (E7-FR-01..02): paste the path(s)
  // in the format the console understands. An agent pane gets images it can
  // attach as [Image #N], a bracketed-paste shell gets escaped paths, a plain
  // console keeps the 1.14.1 quoted write. Never a `cd`, never an Enter.
  const onDropFolder = (e: DragEvent): void => {
    const files = e.dataTransfer.files
    const internal = e.dataTransfer.types.includes(INTERNAL_PATH_MIME)
    if ((!files || files.length === 0) && !internal) return
    e.preventDefault()
    e.stopPropagation()
    stepDrag('reset')
    let paths: string[]
    if (files && files.length > 0) {
      paths = Array.from(files)
        .map((f) => window.snApi.filePath(f))
        .filter(Boolean)
    } else {
      // In-app path drag: nonce + currently listed path, else ignored silently.
      const path = parseInternalPath(e.dataTransfer.getData(INTERNAL_PATH_MIME))
      paths = path ? [path] : []
    }
    if (paths.length === 0) return
    const ptyId = getPtyId(pane.id)
    if (!ptyId) return
    const bracketed = isBracketedPaste(pane.id)
    if (bracketed === null) return // no xterm mounted: nothing to paste into
    const status = useAppStore.getState().paneStatus[pane.id]
    const mode: DropMode = !bracketed ? 'plain' : isAgentPane(pane, status, bracketed) ? 'agent' : 'safe'
    const payload = buildDropPayload(paths, mode)
    if (!payload) return
    if (payload.kind === 'paste') {
      // One xterm paste per part: an agent sees each image as its own paste.
      for (const part of payload.parts) {
        if (!pasteToPane(pane.id, part)) return
      }
    } else {
      window.snApi.pty.write({ ptyId, data: payload.text })
    }
    const target = pane.id
    requestAnimationFrame(() => focusPane(target))
  }

  const menuItems: ContextMenuItem[] = [
    { label: t('ctx.rename'), icon: Pencil, onClick: startRename },
    {
      label: isMax ? t('pane.restore') : t('pane.maximize'),
      icon: isMax ? Minimize2 : Maximize2,
      onClick: onToggleMax,
    },
    { label: t('pane.minimize'), icon: Minus, onClick: onToggleMin },
    {
      label: hasSchedule ? t('schedule.edit') : t('pane.schedule'),
      icon: Clock,
      onClick: () => setScheduling(true),
    },
    ...(offer.show
      ? [
          {
            label: t('worktree.duplicate'),
            icon: GitBranch,
            disabled: !!offer.blocked,
            hint: offer.blocked ? t(offer.blocked) : undefined,
            onClick: () => openWorktreeLaunch({ workspaceId: workspace.id, repoCwd: offer.repoCwd, template: templateFromPane(pane, presets) }),
          },
        ]
      : []),
    ...(resume.show
      ? [
          {
            label: t('agents.restartResume'),
            icon: History,
            disabled: !resume.canResume,
            hint: resume.reason ? t(resume.reason) : undefined,
            onClick: () => restartResume(pane.id),
          },
          { label: t('agents.restartFresh'), icon: SquarePen, onClick: () => restartFresh(pane.id) },
        ]
      : [{ label: t('pane.restart'), icon: RotateCw, onClick: () => restartFromButton(pane.id) }]),
    // The pre-2.0 restart: remount with an empty screen (E6-FR-18).
    { label: t('pane.restartClean'), icon: Eraser, onClick: () => restartClean(pane.id) },
    { label: t('pane.redraw'), icon: Paintbrush, onClick: () => redrawPane(pane.id) },
    // E6-FR-29: enabled once a command has both its start (C) and end (D) marks.
    { label: t('pane.copyLastOutput'), icon: ClipboardCopy, disabled: !hasLastOutput(pane.id), onClick: () => void copyLastOutput(pane.id) },
    // Deletes the saved file now; the screen keeps what it shows (E6-FR-12).
    ...(settings.persistScrollback && settings.terminalSnapshotMode !== 'off'
      ? [{ label: t('pane.clearSavedHistory'), icon: ArchiveX, onClick: () => clearSavedScrollback(pane.id) }]
      : []),
    ...(closedCount > 0
      ? [{ label: t('agents.reopenClosed'), icon: ArchiveRestore, separated: true, onClick: () => void reopenClosedConsole() }]
      : []),
    { label: t('pane.close'), icon: X, danger: true, separated: true, onClick: onClose },
  ]
  const restartTip = resume.show && resume.button === 'resume' ? t('agents.restartTipResume') : t('pane.restart')

  return (
    <motion.div
      // "position" (not full `layout`) animates only the cell's position, never
      // its size via a CSS transform. A scale transform would make xterm's fit
      // measure a transient wrong width on mount → the narrow-column glitch.
      layout="position"
      transition={{ type: 'spring', stiffness: 500, damping: 40 }}
      onDragOver={(e) => {
        e.preventDefault()
        if (isPathDrag(e.dataTransfer.types)) e.dataTransfer.dropEffect = 'copy'
      }}
      onDragEnter={(e) => {
        if (isPathDrag(e.dataTransfer.types)) stepDrag('enter')
        onDragEnterCell()
      }}
      onDragLeave={(e) => {
        if (isPathDrag(e.dataTransfer.types)) stepDrag('leave')
      }}
      onDrop={onDropFolder}
      data-drop-hover={dropHover || undefined}
      data-pane-cell={pane.id}
      className={cn(
        'relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border bg-bg-primary',
        hidden && 'hidden',
        isDragging ? 'border-accent-violet opacity-40' : 'border-border',
      )}
    >
      <header
        draggable={draggable && !renaming}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          onDragStartCell()
        }}
        onDragEnd={onDragEndCell}
        onAuxClick={(e) => {
          if (e.button === 1) {
            e.preventDefault()
            onClose()
          }
        }}
        onDoubleClick={onToggleMax}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
        className={cn(
          'flex h-8 shrink-0 items-center gap-1.5 border-b border-border bg-card/50 px-2',
          draggable && !renaming ? 'cursor-grab active:cursor-grabbing' : 'cursor-default',
        )}
      >
        {draggable && <GripVertical size={13} className="shrink-0 text-text-secondary/40" />}
        <Icon size={13} className="shrink-0" style={{ color: pane.color }} />
        <PaneStatusDot paneId={pane.id} />
        {renaming ? (
          <input
            autoFocus
            value={nameVal}
            onChange={(e) => setNameVal(e.target.value)}
            onBlur={commitRename}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') setRenaming(false)
            }}
            className="min-w-0 flex-1 rounded border border-accent-violet/50 bg-bg-primary px-1.5 py-0.5 text-xs text-text-primary outline-none"
          />
        ) : (
          // The topic gives way first: it shrinks to nothing before the title truncates.
          <span className="flex min-w-0 flex-1 items-baseline overflow-hidden text-xs" title={topic ? `${pane.title} · ${topic}` : undefined}>
            <span className="min-w-0 truncate font-medium text-text-secondary">{pane.title}</span>
            <PaneStatusLine paneId={pane.id} />
            {topic && (
              <span data-pane-topic className="min-w-0 truncate whitespace-pre text-text-secondary/60 [flex-shrink:9999]">
                {` · ${topic}`}
              </span>
            )}
          </span>
        )}
        {wt && <PaneWorktreeChip pane={pane} />}
        <CacheChip paneId={pane.id} />
        {exited && (
          <span
            data-pane-exited
            className="shrink-0 rounded border border-border px-1 text-[10px] font-medium uppercase leading-4 text-text-secondary/80"
          >
            {t('pane.exited')}
          </span>
        )}
        <Tooltip label={scheduleTip}>
          <button
            draggable={false}
            aria-label={scheduleTip}
            data-pane-clock={isScheduled ? 'active' : hasSchedule ? 'paused' : 'none'}
            onClick={() => setScheduling(true)}
            className={cn(
              'rounded p-1 transition-colors hover:bg-bg-secondary',
              isScheduled
                ? 'text-accent-violet hover:text-accent-violet'
                : hasSchedule
                  ? 'text-accent-violet/40 hover:text-accent-violet/70'
                  : 'text-text-secondary hover:text-text-primary',
            )}
          >
            <Clock size={13} />
          </button>
        </Tooltip>
        <Tooltip label={restartTip}>
          <button
            draggable={false}
            aria-label={restartTip}
            onClick={() => restartFromButton(pane.id)}
            className="rounded p-1 text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
          >
            <RotateCw size={13} />
          </button>
        </Tooltip>
        <Tooltip label={t('pane.minimize')}>
          <button
            draggable={false}
            onClick={onToggleMin}
            className="rounded p-1 text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
          >
            <Minus size={13} />
          </button>
        </Tooltip>
        <Tooltip label={isMax ? t('pane.restore') : t('pane.maximize')}>
          <button
            draggable={false}
            onClick={onToggleMax}
            className="rounded p-1 text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
          >
            {isMax ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
        </Tooltip>
        <Tooltip label={t('pane.close')}>
          <button
            draggable={false}
            onClick={onClose}
            className="rounded p-1 text-text-secondary transition-colors hover:bg-red-400/10 hover:text-red-400"
          >
            <X size={13} />
          </button>
        </Tooltip>
      </header>
      <div className="relative min-h-0 flex-1">
        <ResumeChip paneId={pane.id} />
        {gated && (
          <div
            data-pane-gated={pane.id}
            className="absolute inset-0 z-[5] flex items-center justify-center gap-2 bg-bg-primary px-4 text-center text-xs text-text-secondary"
          >
            <History size={13} className="shrink-0 text-accent-violet" />
            <span>{t('agents.modal.gated')}</span>
          </div>
        )}
        {held ? (
          <RepoSetupPlaceholder paneId={pane.id} held={held} />
        ) : wt && wtMissing ? (
          <WorktreeMissingCard workspace={workspace} pane={pane} presets={presets} />
        ) : wtPending ? (
          <div data-pane-worktree-checking={pane.id} className="flex h-full items-center justify-center text-xs text-text-secondary">
            {t('worktree.checking')}
          </div>
        ) : sleepInfo ? (
          <SleepingOverlay paneId={pane.id} workspaceId={workspace.id} info={sleepInfo} />
        ) : mounted ? (
          // A render failure swaps only the terminal for a fallback; the pty
          // keeps running and [Reload console] reattaches (E4-FR-19).
          <PaneErrorBoundary paneId={pane.id} epoch={epoch}>
            <TerminalPane
              key={epoch}
              paneId={pane.id}
              workspaceId={workspace.id}
              cwd={cwd}
              shell={shell}
              initialCommand={initialCommand}
              launchKind={launchKind}
              setup={setup}
              fontSize={pane.fontSize}
              isActive={cellVisible}
            />
          </PaneErrorBoundary>
        ) : (
          <div
            data-pane-placeholder={pane.id}
            className="flex h-full flex-col items-center justify-center gap-2 text-xs text-text-secondary"
          >
            <span>{t('pane.notStarted')}</span>
            <button
              onClick={() => ensureMounted(workspace.id, { only: [pane.id] })}
              className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-text-primary transition-colors hover:bg-bg-secondary"
            >
              <Play size={12} />
              {t('pane.start')}
            </button>
          </div>
        )}
      </div>

      {dropHover && (
        <div
          aria-hidden
          data-drop-overlay
          className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-lg border-2 border-accent-violet bg-accent-violet/10"
        >
          <span className="rounded-md border border-accent-violet/40 bg-card px-3 py-1.5 text-xs font-medium text-text-primary shadow-lg">
            {t('drop.hint')}
          </span>
        </div>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}

      {scheduling && (
        <ScheduleDialog
          workspaceId={workspace.id}
          paneId={pane.id}
          paneTitle={pane.title}
          schedule={pane.schedule}
          onClose={() => setScheduling(false)}
        />
      )}
    </motion.div>
  )
}
