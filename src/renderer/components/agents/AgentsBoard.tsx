import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronDown, ChevronRight, Timer, X } from 'lucide-react'
import { formatAgeShort } from '@shared/agents'
import { formatCountdown } from '@shared/hibernation'
import { useAppStore } from '@/lib/store'
import { useAgentStore } from '@/lib/agentStore'
import { agentPhrase, agentTitle, allAgents, navInputFrom, type AgentEntry } from '@/lib/agentNav'
import { BOARD_COLUMNS, boardColumns, firstCard, moveSelection, navigableColumns, type BoardColumnId } from '@/lib/agentsBoard'
import { revealPane } from '@/lib/revealPane'
import { focusPane, getFocusedPane } from '@/lib/focus'
import { iconFor } from '@/lib/icons'
import { cn } from '@/lib/cn'
import { useLang, useT, type MessageKey } from '@/i18n'
import { StatusGlyph } from '@/components/ui/StatusDot'
import { glyphOf, useNow } from '@/components/sidebar/AgentRows'
import { CacheChip, paneCacheDeadline, useCountdown } from './CacheChip'

/** Ages on the cards move on their own this often. */
const AGE_TICK_MS = 30_000

const COLUMN_TITLE: Record<BoardColumnId, MessageKey> = {
  waiting: 'agents.board.waiting',
  working: 'agents.board.working',
  done: 'agents.board.done',
  idle: 'agents.board.idle',
}

/** Closes the board and gives the keyboard back to the console that had it. */
function closeBoard(): void {
  useAgentStore.getState().setView('grid')
  const paneId = getFocusedPane()
  if (paneId) setTimeout(() => focusPane(paneId), 0)
}

/** Opens a card's console on the grid. */
function pick(paneId: string): void {
  useAgentStore.getState().setView('grid')
  revealPane(paneId)
}

/** "Cache 4:12" in the header: the most urgent countdown, ticking until the last one ends. */
function UrgentCache({ deadlines }: { deadlines: number[] }) {
  const t = useT()
  const last = deadlines.length > 0 ? Math.max(...deadlines) : null
  const now = useCountdown(last)
  const live = deadlines.filter((d) => d > now)
  if (live.length === 0) return null
  const left = Math.min(...live) - now
  return (
    <span data-board-cache className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-text-secondary">
      <Timer size={12} aria-hidden />
      {t('agents.board.cache', { time: formatCountdown(left) })}
    </span>
  )
}

function BoardCard({ entry, selected, onSelect, setRef }: { entry: AgentEntry; selected: boolean; onSelect: () => void; setRef: (el: HTMLButtonElement | null) => void }) {
  const t = useT()
  const lang = useLang()
  const now = useNow(AGE_TICK_MS)
  const presets = useAppStore((s) => s.presets)
  const topicAsTitle = useAppStore((s) => s.settings.agents?.topicAsTitle !== false)
  const Icon = iconFor(entry.pane.icon)
  const title = agentTitle(entry.pane, presets, entry.status ?? entry.session, topicAsTitle)
  return (
    <button
      ref={setRef}
      type="button"
      data-board-card={entry.id}
      data-board-state={glyphOf(entry)}
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      onFocus={onSelect}
      onClick={() => pick(entry.id)}
      className={cn(
        'flex w-full min-w-0 flex-col gap-1 rounded-card border bg-card/70 px-3 py-2 text-left transition-colors hover:border-accent-violet/50 focus-visible:outline-none',
        selected ? 'border-accent-violet ring-1 ring-accent-violet/40' : 'border-border',
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <StatusGlyph kind={glyphOf(entry)} unread={entry.unread} size={13} />
        <Icon size={12} className="shrink-0" style={{ color: entry.pane.color }} />
        <span className={cn('min-w-0 flex-1 truncate text-[13px] leading-5', entry.unread ? 'font-semibold text-text-primary' : 'text-text-primary/90')}>{title}</span>
        <CacheChip paneId={entry.id} />
        {entry.stateSince > 0 && <span className="shrink-0 text-[11px] text-text-secondary">{formatAgeShort(now - entry.stateSince, lang)}</span>}
      </span>
      <span className="truncate text-[11px] text-text-secondary">{entry.ws.name}</span>
      <span data-board-detail className="line-clamp-2 break-words text-[12px] leading-4 text-text-secondary">
        {agentPhrase(entry, t, lang, now, false)}
      </span>
    </button>
  )
}

/**
 * Agents board (E5-FR-27): four columns over the workspace area, "Waiting
 * on you", "Working", "Done" and "Idle" (collapsed with its count). Opened
 * with Ctrl+Shift+A or the sidebar header button. Click or Enter reveals the
 * console and goes back to the grid, the arrows walk the cards, Esc goes back.
 * The terminals stay mounted underneath: the board only covers them.
 */
export function AgentsBoard() {
  const open = useAgentStore((s) => s.view === 'board')
  if (!open) return null
  return <BoardBody />
}

function BoardBody() {
  const t = useT()
  const workspaces = useAppStore((s) => s.workspaces)
  const paneStatus = useAppStore((s) => s.paneStatus)
  const paneAttention = useAppStore((s) => s.paneAttention)
  const mountedWorkspaces = useAppStore((s) => s.mountedWorkspaces)
  const presets = useAppStore((s) => s.presets)
  const agentSettings = useAppStore((s) => s.settings.agents)
  const sessions = useAgentStore((s) => s.sessions)
  const sleeping = useAgentStore((s) => s.sleeping)
  const [idleOpen, setIdleOpen] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const cards = useRef(new Map<string, HTMLButtonElement>())
  const rootRef = useRef<HTMLDivElement | null>(null)

  const entries = useMemo(
    () => allAgents(navInputFrom({ workspaces, paneStatus, paneAttention, mountedWorkspaces, presets, settings: { agents: agentSettings } }, { sessions, sleeping })),
    [workspaces, paneStatus, paneAttention, mountedWorkspaces, presets, agentSettings, sessions, sleeping],
  )
  const cols = useMemo(() => boardColumns(entries), [entries])
  const columns = useMemo(() => navigableColumns(cols, idleOpen), [cols, idleOpen])
  const current = selected && columns.some((c) => c.includes(selected)) ? selected : firstCard(columns)
  const deadlines = entries
    .map((e) => paneCacheDeadline(e.status, agentSettings?.cacheTimer))
    .filter((d): d is number => d !== null)

  // The keyboard lands on the board when it opens (the first card, or the board itself).
  useEffect(() => {
    const first = firstCard(navigableColumns(boardColumns(entries), false))
    if (first) cards.current.get(first)?.focus()
    else rootRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const select = (id: string | null): void => {
    if (!id) return
    setSelected(id)
    cards.current.get(id)?.focus()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.ctrlKey || e.altKey || e.metaKey) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeBoard()
      return
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      e.stopPropagation()
      select(moveSelection(columns, current, e.key))
    }
  }

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      role="dialog"
      aria-label={t('agents.board.title')}
      data-agents-board
      onKeyDown={onKeyDown}
      className="absolute inset-0 z-30 flex flex-col bg-bg-primary/95 backdrop-blur-sm outline-none"
    >
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-4">
        <h2 className="text-sm font-semibold text-text-primary">{t('agents.board.title')}</h2>
        <span className="text-xs text-text-secondary">{t('agents.board.count', { count: entries.length })}</span>
        <UrgentCache deadlines={deadlines} />
        <button
          type="button"
          data-board-close
          aria-label={t('agents.board.close')}
          title={t('agents.board.close')}
          onClick={closeBoard}
          className="ml-auto rounded p-1 text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
        >
          <X size={15} />
        </button>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-4 gap-3 overflow-hidden p-3">
        {BOARD_COLUMNS.map((id) => {
          const list = cols[id]
          const collapsed = id === 'idle' && !idleOpen
          return (
            <section key={id} data-board-column={id} aria-label={t(COLUMN_TITLE[id])} className="flex min-h-0 min-w-0 flex-col rounded-card border border-border bg-bg-secondary/60">
              <h3 className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                {id === 'idle' ? (
                  <button
                    type="button"
                    data-board-idle-toggle
                    aria-expanded={idleOpen}
                    onClick={() => setIdleOpen((v) => !v)}
                    className="flex min-w-0 items-center gap-1 uppercase hover:text-text-primary"
                  >
                    {idleOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    {t(COLUMN_TITLE[id])}
                  </button>
                ) : (
                  <span className="truncate">{t(COLUMN_TITLE[id])}</span>
                )}
                <span data-board-count={id} className="ml-auto rounded-full border border-border px-1.5 text-[10px] font-medium normal-case">
                  {list.length}
                </span>
              </h3>
              {!collapsed && (
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
                  {list.length === 0 ? (
                    <p className="px-1 py-2 text-center text-[11px] text-text-secondary/70">{t('agents.board.empty')}</p>
                  ) : (
                    list.map((e) => (
                      <BoardCard
                        key={e.id}
                        entry={e}
                        selected={e.id === current}
                        onSelect={() => setSelected(e.id)}
                        setRef={(el) => {
                          if (el) cards.current.set(e.id, el)
                          else cards.current.delete(e.id)
                        }}
                      />
                    ))
                  )}
                </div>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
