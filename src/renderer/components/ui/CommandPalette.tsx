import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArchiveRestore, BellRing, Bot, FileDiff, FolderTree, GitBranch, LayoutDashboard, Megaphone, NotebookPen, Palette, PanelLeft, Plus, Search, Settings, Type } from 'lucide-react'
import { formatAgeShort } from '@shared/agents'
import { visiblePaneIds } from '@shared/status'
import { useAppStore } from '@/lib/store'
import { runQuickCommand } from '@/lib/quickCommands'
import { useAgentStore } from '@/lib/agentStore'
import { reopenClosedConsole } from '@/lib/agentLaunch'
import { useLang, useT } from '@/i18n'
import { iconFor, type IconComponent } from '@/lib/icons'
import { THEME_LIST } from '@/themes'
import { cn } from '@/lib/cn'
import { formatAccel, resolveKeymap, type ActionId } from '@/lib/keymap'
import { getFocusedPane } from '@/lib/focus'
import { revealPane } from '@/lib/revealPane'
import { goToNextWaiting } from '@/lib/useGlobalKeys'
import { agentPhrase, agentTitle, allAgents, navInputFrom, paletteWaiting, type AgentEntry } from '@/lib/agentNav'
import { StatusGlyph } from '@/components/ui/StatusDot'
import { glyphOf, useNow } from '@/components/sidebar/AgentRows'
import { orderQuickCommands } from '@shared/quickCommands'
import { openChangesPanel } from '@/lib/changesPanel'
import { openSidePanel } from '@/lib/sidePanels'
import { useGitStore } from '@/lib/gitStore'
import { workspaceGitKey } from '@/lib/gitChip'
import { useWorktreeStore } from '@/lib/worktreeStore'
import { templateFromPreset, worktreeOffer } from '@/lib/worktrees'
import { toast } from '@/lib/toast'

interface Command {
  id: string
  label: string
  hint?: string
  icon?: IconComponent
  /** Bound keymap action: its accelerator shows on the row (E5-FR-18). */
  action?: ActionId
  /**
   * Longer free text (an agent's topic and first prompt) the query must
   * contain as a substring: a fuzzy subsequence over a 200 char prompt would
   * match nearly any query.
   */
  search?: string
  /** Console rows (E5-FR-16) show its live glyph. */
  paneId?: string
  run: () => void
}

/** Case-insensitive subsequence match (fuzzy). */
function matches(needle: string, hay: string): boolean {
  if (!needle) return true
  let i = 0
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++
  }
  return i === needle.length
}

/**
 * The console the user is looking at (focused and visible in the active
 * workspace): left out of "Waiting for you".
 */
function lookedAtPane(): string | null {
  const s = useAppStore.getState()
  const focused = getFocusedPane()
  const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId)
  if (!focused || !ws) return null
  return visiblePaneIds(ws, s.minimized[ws.id] ?? [], s.maximized[ws.id]).includes(focused) ? focused : null
}

/** "Waiting for you" ids, frozen when the palette opens (E5-FR-15). */
function computeWaiting(): string[] {
  return paletteWaiting(allAgents(navInputFrom(useAppStore.getState(), useAgentStore.getState())), lookedAtPane())
}

/** Ctrl/Cmd+K fuzzy launcher for switching workspaces and running actions. */
export function CommandPalette() {
  const t = useT()
  const lang = useLang()
  const open = useAppStore((s) => s.paletteOpen)
  const setOpen = useAppStore((s) => s.setPaletteOpen)
  const workspaces = useAppStore((s) => s.workspaces)
  const presets = useAppStore((s) => s.presets)
  const connections = useAppStore((s) => s.connections)
  const quickCommands = useAppStore((s) => s.quickCommands)
  const activeId = useAppStore((s) => s.activeWorkspaceId)
  const setActive = useAppStore((s) => s.setActive)
  const setWizardOpen = useAppStore((s) => s.setWizardOpen)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const addPane = useAppStore((s) => s.addPane)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const setGlobalPromptOpen = useAppStore((s) => s.setGlobalPromptOpen)
  const keymapOverrides = useAppStore((s) => s.settings.keymap)
  const paneStatus = useAppStore((s) => s.paneStatus)
  const paneAttention = useAppStore((s) => s.paneAttention)
  const mountedWorkspaces = useAppStore((s) => s.mountedWorkspaces)
  const agentSettings = useAppStore((s) => s.settings.agents)
  const sessions = useAgentStore((s) => s.sessions)
  const sleeping = useAgentStore((s) => s.sleeping)
  const canReopen = useAgentStore((s) => s.closedStack.length > 0)

  const [query, setQuery] = useState('')
  const [idx, setIdx] = useState(0)
  // The order is frozen when the palette opens; glyphs keep updating live.
  const [wasOpen, setWasOpen] = useState(false)
  const [frozen, setFrozen] = useState<string[]>([])
  if (open !== wasOpen) {
    setWasOpen(open)
    setFrozen(open ? computeWaiting() : [])
  }

  const keymap = useMemo(() => resolveKeymap(keymapOverrides), [keymapOverrides])
  const topicAsTitle = agentSettings?.topicAsTitle !== false
  const entries = useMemo(() => {
    if (!open) return new Map<string, AgentEntry>()
    const input = navInputFrom({ workspaces, paneStatus, paneAttention, mountedWorkspaces, presets, settings: { agents: agentSettings } }, { sessions, sleeping })
    return new Map(allAgents(input).map((e) => [e.id, e]))
  }, [open, workspaces, paneStatus, paneAttention, mountedWorkspaces, presets, agentSettings, sessions, sleeping])
  // Closed consoles (or ones whose agent went away) drop out of the frozen list.
  const waiting = query.trim() ? [] : frozen.map((id) => entries.get(id)).filter((e): e is AgentEntry => !!e)

  const commands = useMemo<Command[]>(() => {
    const cmds: Command[] = [
      { id: 'new-ws', label: t('sidebar.newWorkspace'), hint: t('palette.general'), icon: Plus, action: 'newWorkspace', run: () => setWizardOpen(true) },
      { id: 'settings', label: t('sidebar.settings'), hint: t('palette.general'), icon: Settings, action: 'openSettings', run: () => setSettingsOpen(true) },
      { id: 'toggle-sidebar', label: t('palette.toggleSidebar'), hint: t('palette.general'), icon: PanelLeft, action: 'toggleSidebar', run: () => toggleSidebar() },
      { id: 'next-waiting', label: t('keys.nextWaiting'), hint: t('palette.console'), icon: BellRing, action: 'nextWaiting', run: () => void goToNextWaiting() },
      // E5-FR-27: the agents board over the workspace area.
      { id: 'agents-board', label: t('agents.board.toggle'), hint: t('palette.general'), icon: LayoutDashboard, action: 'agentsBoard', run: () => useAgentStore.getState().setView('board') },
    ]
    if (canReopen) {
      // E5-FR-14: the last closed console, same id and place, resuming its chat.
      cmds.push({ id: 'reopen-closed', label: t('agents.reopenClosed'), hint: t('palette.console'), icon: ArchiveRestore, action: 'reopenClosedPane', run: () => void reopenClosedConsole() })
    }
    for (const w of workspaces) {
      cmds.push({ id: `ws-${w.id}`, label: w.name, hint: t('palette.workspace'), icon: iconFor(w.panes[0]?.icon), run: () => setActive(w.id) })
    }
    if (activeId) {
      cmds.push({
        id: 'global-prompt',
        label: t('globalPrompt.title'),
        hint: t('palette.console'),
        icon: Megaphone,
        action: 'globalPrompt',
        run: () => setGlobalPromptOpen(true),
      })
      // E7-FR-11: the Changes panel of the active workspace.
      cmds.push({ id: 'view-changes', label: t('changes.viewChanges'), hint: t('palette.workspace'), icon: FileDiff, action: 'toggleChanges', run: () => openChangesPanel() })
      // v2.2 (E9): the Files and Notes drawers of the active workspace.
      cmds.push({ id: 'view-files', label: t('files.paletteOpen'), hint: t('palette.workspace'), icon: FolderTree, action: 'toggleFiles', run: () => openSidePanel('files') })
      cmds.push({ id: 'view-notes', label: t('wsnotes.paletteOpen'), hint: t('palette.workspace'), icon: NotebookPen, action: 'toggleNotes', run: () => openSidePanel('notes') })
      for (const p of presets) {
        cmds.push({
          id: `pane-${p.id}`,
          label: `${t('palette.newConsole')}: ${p.name}`,
          hint: t('palette.console'),
          icon: iconFor(p.icon),
          run: () => addPane(activeId, { type: p.type, presetId: p.id, title: p.name, color: p.color, icon: p.icon }),
        })
      }
      // E7-FR-27c: the same presets in an isolated worktree of the workspace cwd.
      const ws = workspaces.find((w) => w.id === activeId)
      const git = useGitStore.getState()
      const offer = ws ? worktreeOffer(ws, null, presets, connections, { summary: git.summaries[workspaceGitKey(ws.id)], error: git.errors[workspaceGitKey(ws.id)] }) : null
      if (ws && offer?.show) {
        for (const p of presets) {
          cmds.push({
            id: `wt-${p.id}`,
            label: `${t('worktree.paletteNew')}: ${p.name}`,
            hint: offer.blocked ? t(offer.blocked) : t('palette.console'),
            icon: GitBranch,
            run: () => {
              if (offer.blocked) toast.warning(t(offer.blocked))
              else useWorktreeStore.getState().openLaunch({ workspaceId: ws.id, repoCwd: offer.repoCwd, template: templateFromPreset(p) })
            },
          })
        }
      }
    }
    // E8-FR-06: globals and the active workspace's own, run like the popover.
    for (const qc of orderQuickCommands(quickCommands, activeId)) {
      cmds.push({
        id: `qc-${qc.id}`,
        label: `${t('palette.run')}: ${qc.name}`,
        hint: t('palette.quickCommand'),
        icon: qc.action === 'agent' ? Bot : Type,
        run: () => void runQuickCommand(qc),
      })
    }
    for (const th of THEME_LIST) {
      cmds.push({ id: `theme-${th.name}`, label: `${t('palette.theme')}: ${th.label}`, hint: t('palette.appearance'), icon: Palette, run: () => updateSettings({ theme: th.name }) })
    }
    return cmds
  }, [workspaces, presets, connections, quickCommands, activeId, canReopen, t, setActive, setWizardOpen, setSettingsOpen, toggleSidebar, addPane, updateSettings, setGlobalPromptOpen])

  // E5-FR-16: with a query every console is searchable by title, workspace,
  // its agent's topic and first prompt.
  const consoleCommands = useMemo<Command[]>(() => {
    if (!query.trim()) return []
    const out: Command[] = []
    for (const w of workspaces) {
      for (const p of w.panes) {
        const info = paneStatus[p.id] ?? sessions[p.id]
        const label = `${t('palette.consoleItem')}: ${p.title} · ${w.name}`
        out.push({
          id: `console-${p.id}`,
          label,
          search: [info?.topic, info?.firstPrompt].filter(Boolean).join('\n'),
          hint: t('palette.console'),
          icon: iconFor(p.icon),
          paneId: p.id,
          run: () => void revealPane(p.id),
        })
      }
    }
    return out
  }, [query, workspaces, paneStatus, sessions, t])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return [...consoleCommands, ...commands].filter((c) => matches(q, c.label.toLowerCase()) || !!c.search?.toLowerCase().includes(q))
  }, [commands, consoleCommands, query])

  useEffect(() => {
    setIdx(0)
  }, [query, open])

  const now = useNow(30_000)

  if (!open) return null

  const total = waiting.length + filtered.length
  const close = (): void => {
    setQuery('')
    setOpen(false)
  }
  const reveal = (paneId: string): void => {
    close()
    revealPane(paneId)
  }
  const runAt = (i: number): void => {
    if (i < waiting.length) {
      reveal(waiting[i].id)
      return
    }
    const c = filtered[i - waiting.length]
    if (!c) return
    close()
    c.run()
  }

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-start justify-center p-6 pt-[12vh]">
      <div className="absolute inset-0 bg-black/50" onClick={close} />
      <div className="relative z-10 flex w-full max-w-lg flex-col overflow-hidden rounded-modal border border-border bg-card shadow-[0_20px_48px_-12px_rgba(0,0,0,0.6)]">
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search size={16} className="shrink-0 text-text-secondary" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Ctrl+1..6 picks a "Waiting for you" row (E5-FR-15).
              if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
                e.preventDefault()
                const row = waiting[Number(e.key) - 1]
                if (row) reveal(row.id)
                return
              }
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setIdx((n) => Math.min(n + 1, total - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setIdx((n) => Math.max(n - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                runAt(idx)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                close()
              }
            }}
            placeholder={t('palette.placeholder')}
            className="h-11 min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-secondary"
          />
        </div>
        <div className="max-h-[50vh] overflow-y-auto py-1">
          {waiting.length > 0 && (
            <div role="group" aria-label={t('palette.waiting')} data-palette-waiting>
              <p className="px-4 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary/70">{t('palette.waiting')}</p>
              {waiting.map((e, i) => {
                const Icon = iconFor(e.pane.icon)
                const title = agentTitle(e.pane, presets, e.status ?? e.session, topicAsTitle)
                return (
                  <button
                    key={e.id}
                    data-palette-pane={e.id}
                    onMouseEnter={() => setIdx(i)}
                    onClick={() => runAt(i)}
                    className={cn(
                      'flex w-full flex-col gap-0.5 px-4 py-1.5 text-left text-sm transition-colors',
                      i === idx ? 'bg-bg-secondary' : 'hover:bg-bg-secondary/50',
                    )}
                  >
                    <span className="flex w-full min-w-0 items-center gap-2">
                      <StatusGlyph kind={glyphOf(e)} unread={e.unread} size={14} />
                      <Icon size={14} className="shrink-0" style={{ color: e.pane.color }} />
                      <span className={cn('min-w-0 max-w-[60%] shrink-0 truncate text-text-primary', e.unread && 'font-semibold')}>{title}</span>
                      <span className="min-w-0 flex-1 truncate text-xs text-text-secondary/70">· {e.ws.name}</span>
                      <span className="shrink-0 pl-2 text-[11px] tabular-nums text-text-secondary">
                        {e.stateSince ? formatAgeShort(now - e.stateSince, lang) : ''}
                      </span>
                      <kbd className="shrink-0 rounded border border-border px-1 font-mono text-[10px] text-text-secondary">Ctrl+{i + 1}</kbd>
                    </span>
                    <span className="block truncate pl-[44px] text-xs text-text-secondary">{agentPhrase(e, t, lang, now, false)}</span>
                  </button>
                )
              })}
              <div className="mx-4 my-1 border-t border-border" />
            </div>
          )}
          {total === 0 && (
            <p className="px-4 py-6 text-center text-sm text-text-secondary">{t('palette.empty')}</p>
          )}
          {filtered.map((c, j) => {
            const i = j + waiting.length
            const Icon = c.icon
            const entry = c.paneId ? entries.get(c.paneId) : undefined
            return (
              <button
                key={c.id}
                data-palette-cmd={c.id}
                onMouseEnter={() => setIdx(i)}
                onClick={() => runAt(i)}
                className={cn(
                  'flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors',
                  i === idx ? 'bg-bg-secondary' : 'hover:bg-bg-secondary/50',
                )}
              >
                {entry && <StatusGlyph kind={glyphOf(entry)} unread={entry.unread} size={13} />}
                {Icon && <Icon size={15} className="shrink-0 text-text-secondary" />}
                <span className="min-w-0 flex-1 truncate text-text-primary">{c.label}</span>
                {c.action && (
                  <kbd className="shrink-0 rounded border border-border px-1 font-mono text-[10px] text-text-secondary">{formatAccel(keymap[c.action])}</kbd>
                )}
                {c.hint && <span className="shrink-0 text-[11px] text-text-secondary">{c.hint}</span>}
              </button>
            )
          })}
        </div>
      </div>
    </div>,
    document.body,
  )
}
