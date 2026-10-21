import { Suspense, lazy, useState } from 'react'
import { ChevronDown, FolderTree, GitBranch, Megaphone, NotebookPen, Plus, Share2 } from 'lucide-react'
import type { AgentPreset, Workspace } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { iconFor } from '@/lib/icons'
import { TilingGrid } from '@/components/layout/TilingGrid'
import { WorkspaceGitLabel } from '@/components/git/WorkspaceGitLabel'
import { ChangesPanel } from '@/components/changes/ChangesPanel'
import { RaceBar } from './RaceBar'
import { useGitStore } from '@/lib/gitStore'
import { workspaceOfKey } from '@/lib/changes'
import { useT } from '@/i18n'
import { Tooltip } from '@/components/ui/Tooltip'
import { ActionTooltipLabel, useActionKeys } from '@/components/ui/KeyHint'
import { ariaKeyshortcuts } from '@/lib/keymap'
import { workspaceGitKey } from '@/lib/gitChip'
import { useWorktreeStore } from '@/lib/worktreeStore'
import { templateFromPreset, worktreeOffer } from '@/lib/worktrees'
import { cn } from '@/lib/cn'
import { toggleSidePanel, useSidePanels } from '@/lib/sidePanels'
import { openShareDialog, useShareHostStore, workspaceShared } from '@/lib/shareHostStore'

// The Notes and Files drawers (v2.2, E9) carry the code editor: loaded on first open.
const NotesPanel = lazy(() => import('@/components/notes/NotesPanel'))
const FilesPanel = lazy(() => import('@/components/files/FilesPanel'))

export function WorkspaceView({
  workspace,
  isActive,
}: {
  workspace: Workspace
  isActive: boolean
}) {
  const t = useT()
  const addPane = useAppStore((s) => s.addPane)
  const presets = useAppStore((s) => s.presets)
  const setGlobalPromptOpen = useAppStore((s) => s.setGlobalPromptOpen)
  const minimizedIds = useAppStore((s) => s.minimized[workspace.id]) ?? []
  const activeCount = workspace.panes.filter((p) => !minimizedIds.includes(p.id)).length
  const [open, setOpen] = useState(false)
  const promptKeys = useActionKeys('globalPrompt')
  // Changes panel (E7-FR-11): over this grid while this workspace is active and owns the panel's target.
  const panelTarget = useGitStore((s) => s.panel?.targetKey ?? null)
  const panelBase = useGitStore((s) => s.panel?.base)
  const ownsPanel = useAppStore((s) => panelTarget != null && workspaceOfKey(s.workspaces, panelTarget) === workspace.id)
  const changesKey = isActive && ownsPanel ? panelTarget : null
  // Notes / Files (v2.2): over this grid while this workspace is active and owns the drawer.
  const side = useSidePanels((s) => s.open[workspace.id] ?? null)
  const sideKind = isActive ? side : null
  const filesKeys = useActionKeys('toggleFiles')
  const notesKeys = useActionKeys('toggleNotes')
  // E7-FR-27a: each preset can also start in an isolated worktree of workspace.cwd.
  const connections = useAppStore((s) => s.connections)
  const wsGitSummary = useGitStore((s) => s.summaries[workspaceGitKey(workspace.id)])
  const wsGitError = useGitStore((s) => s.errors[workspaceGitKey(workspace.id)])
  const openWorktreeLaunch = useWorktreeStore((s) => s.openLaunch)
  const offer = worktreeOffer(workspace, null, presets, connections, { summary: wsGitSummary, error: wsGitError })
  const shared = useShareHostStore((s) => workspaceShared(s.state, workspace.id))

  const launch = (preset: AgentPreset): void => {
    addPane(workspace.id, {
      type: preset.type,
      presetId: preset.id,
      title: preset.name,
      color: preset.color,
      icon: preset.icon,
    })
    setOpen(false)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-sm font-medium text-text-primary">{workspace.name}</span>
          <WorkspaceGitLabel workspace={workspace} />
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* Share (app 2.4.0, item 8): the whole workspace; lit while a workspace share exists. */}
          <Tooltip label={t('shareHost.header.share')} side="bottom">
            <button
              onClick={() => openShareDialog({ kind: 'workspace', workspaceId: workspace.id })}
              aria-label={t('shareHost.header.share')}
              data-share-workspace-button={shared ? 'shared' : ''}
              className={cn(
                'flex h-[30px] w-[30px] items-center justify-center rounded-btn border transition-colors',
                shared ? 'border-accent-violet/60 bg-accent-violet/15 text-text-primary' : 'border-border bg-card text-text-secondary hover:border-accent-violet/40 hover:text-text-primary',
              )}
            >
              <Share2 size={15} />
            </button>
          </Tooltip>
          <Tooltip label={<ActionTooltipLabel label={t('files.title')} action="toggleFiles" />} side="bottom">
            <button
              onClick={() => toggleSidePanel('files')}
              aria-label={t('files.title')}
              aria-pressed={sideKind === 'files'}
              aria-keyshortcuts={filesKeys.length > 0 ? ariaKeyshortcuts(filesKeys) : undefined}
              data-files-button
              className={cn(
                'flex h-[30px] w-[30px] items-center justify-center rounded-btn border transition-colors',
                sideKind === 'files' ? 'border-accent-violet/60 bg-accent-violet/15 text-text-primary' : 'border-border bg-card text-text-secondary hover:border-accent-violet/40 hover:text-text-primary',
              )}
            >
              <FolderTree size={15} />
            </button>
          </Tooltip>
          <Tooltip label={<ActionTooltipLabel label={t('wsnotes.title')} action="toggleNotes" />} side="bottom">
            <button
              onClick={() => toggleSidePanel('notes')}
              aria-label={t('wsnotes.title')}
              aria-pressed={sideKind === 'notes'}
              aria-keyshortcuts={notesKeys.length > 0 ? ariaKeyshortcuts(notesKeys) : undefined}
              data-notes-button
              className={cn(
                'flex h-[30px] w-[30px] items-center justify-center rounded-btn border transition-colors',
                sideKind === 'notes' ? 'border-accent-violet/60 bg-accent-violet/15 text-text-primary' : 'border-border bg-card text-text-secondary hover:border-accent-violet/40 hover:text-text-primary',
              )}
            >
              <NotebookPen size={15} />
            </button>
          </Tooltip>
          <Tooltip label={<ActionTooltipLabel label={t('globalPrompt.button')} action="globalPrompt" />} side="bottom">
            <button
              onClick={() => setGlobalPromptOpen(true)}
              disabled={activeCount === 0}
              aria-keyshortcuts={promptKeys.length > 0 ? ariaKeyshortcuts(promptKeys) : undefined}
              data-global-prompt-button
              className="flex items-center gap-1.5 rounded-btn border border-border bg-card px-2.5 py-1.5 text-xs text-text-primary transition-colors hover:border-accent-violet/40 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Megaphone size={14} className="text-accent-violet" />
              {t('globalPrompt.button')}
            </button>
          </Tooltip>

          {/* z-30 lifts the menu and its backdrop over the z-20 drawers below (v2.2.1). */}
          <div className="relative z-30">
            <button
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              data-new-console-button
              className="flex items-center gap-1.5 rounded-btn border border-border bg-card px-2.5 py-1.5 text-xs text-text-primary transition-colors hover:border-accent-violet/40"
            >
              <Plus size={14} className="text-accent-violet" />
              {t('workspace.newConsole')}
              <ChevronDown size={13} className="text-text-secondary" />
            </button>

            {open && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
                <div data-new-console-menu className="absolute right-0 z-20 mt-1.5 w-60 overflow-hidden rounded-card border border-border bg-card py-1 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.6)]">
                  {presets.map((preset) => {
                    const Icon = iconFor(preset.icon)
                    return (
                      <div key={preset.id} className="flex w-full items-center transition-colors hover:bg-bg-secondary">
                        <button
                          onClick={() => launch(preset)}
                          className="flex min-w-0 flex-1 items-center gap-2.5 py-2 pl-3 pr-1 text-left text-sm text-text-primary"
                        >
                          <Icon size={15} style={{ color: preset.color }} className="shrink-0" />
                          <span className="min-w-0 flex-1 truncate">{preset.name}</span>
                        </button>
                        {offer.show && (
                          <Tooltip label={offer.blocked ? t(offer.blocked) : t('worktree.newInWorktree')} side="left">
                            <button
                              data-worktree-launch-preset={preset.id}
                              aria-label={`${preset.name}: ${t('worktree.newInWorktree')}`}
                              aria-disabled={offer.blocked ? true : undefined}
                              onClick={() => {
                                if (offer.blocked) return
                                setOpen(false)
                                openWorktreeLaunch({ workspaceId: workspace.id, repoCwd: offer.repoCwd, template: templateFromPreset(preset) })
                              }}
                              className={cn(
                                'mr-1.5 shrink-0 rounded p-1.5 transition-colors',
                                offer.blocked ? 'cursor-not-allowed text-text-secondary/40' : 'text-text-secondary hover:bg-card hover:text-accent-violet',
                              )}
                            >
                              <GitBranch size={14} />
                            </button>
                          </Tooltip>
                        )}
                      </div>
                    )
                  })}
                  {presets.length === 0 && (
                    <p className="px-3 py-2 text-xs text-text-secondary">{t('workspace.noPresets')}</p>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* E7-FR-35: the race over this grid, when one runs here. */}
      <RaceBar workspace={workspace} />

      {/* overflow-clip: a drawer sliding in from translateX(100%) is clipped here without making this
          box a scroll container, so focus() or scrollIntoView inside a drawer cannot shift the app shell. */}
      <div className="relative min-h-0 flex-1 overflow-clip">
        <TilingGrid workspace={workspace} isActive={isActive} />
        {changesKey && <ChangesPanel key={workspace.id} workspace={workspace} targetKey={changesKey} base={panelBase} />}
        <Suspense fallback={null}>
          {sideKind === 'notes' && <NotesPanel key={workspace.id} workspace={workspace} />}
          {sideKind === 'files' && <FilesPanel key={workspace.id} workspace={workspace} />}
        </Suspense>
      </div>
    </div>
  )
}
