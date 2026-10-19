import { useState } from 'react'
import { ChevronDown, GitBranch, Megaphone, Plus } from 'lucide-react'
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
  // E7-FR-27a: each preset can also start in an isolated worktree of workspace.cwd.
  const connections = useAppStore((s) => s.connections)
  const wsGitSummary = useGitStore((s) => s.summaries[workspaceGitKey(workspace.id)])
  const wsGitError = useGitStore((s) => s.errors[workspaceGitKey(workspace.id)])
  const openWorktreeLaunch = useWorktreeStore((s) => s.openLaunch)
  const offer = worktreeOffer(workspace, null, presets, connections, { summary: wsGitSummary, error: wsGitError })

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

          <div className="relative">
            <button
              onClick={() => setOpen((v) => !v)}
              className="flex items-center gap-1.5 rounded-btn border border-border bg-card px-2.5 py-1.5 text-xs text-text-primary transition-colors hover:border-accent-violet/40"
            >
              <Plus size={14} className="text-accent-violet" />
              {t('workspace.newConsole')}
              <ChevronDown size={13} className="text-text-secondary" />
            </button>

            {open && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
                <div className="absolute right-0 z-20 mt-1.5 w-60 overflow-hidden rounded-card border border-border bg-card py-1 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.6)]">
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

      <div className="relative min-h-0 flex-1">
        <TilingGrid workspace={workspace} isActive={isActive} />
        {changesKey && <ChangesPanel key={workspace.id} workspace={workspace} targetKey={changesKey} base={panelBase} />}
      </div>
    </div>
  )
}
