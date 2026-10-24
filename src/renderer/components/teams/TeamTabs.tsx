import { useRef, type KeyboardEvent } from 'react'
import { setTeamTab, TEAM_TABS, type TeamTab } from '@/lib/teamsStore'
import { useT, type MessageKey } from '@/i18n'
import { cn } from '@/lib/cn'
import { AttentionBadge } from '@/components/sidebar/AttentionBadge'

const TAB_KEY: Record<TeamTab, MessageKey> = {
  board: 'teams.tab.board',
  agents: 'teams.tab.agents',
  needs: 'teams.tab.needs',
}

/** Id of a tab button and of the panel it controls (aria-labelledby / aria-controls). */
export function teamTabId(tab: TeamTab): string {
  return `team-tab-${tab}`
}
export const TEAM_TABPANEL_ID = 'team-tabpanel'

/**
 * Tablero | Agentes | Te necesita (app 2.7.0, E10 B1): an ARIA tab strip
 * (Left/Right move and select, Home/End jump), the choice remembered per team.
 * Agentes counts the agents running (neutral pill), Te necesita the rows that
 * need the user (the red pill, the sidebar badge's number).
 */
export function TeamTabs({ tab, running, needs }: { tab: TeamTab; running: number; needs: number }) {
  const t = useT()
  const refs = useRef(new Map<TeamTab, HTMLButtonElement>())
  const go = (next: TeamTab): void => {
    setTeamTab(next)
    refs.current.get(next)?.focus()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.ctrlKey || e.altKey || e.metaKey) return
    const i = TEAM_TABS.indexOf(tab)
    let next: TeamTab | null = null
    if (e.key === 'ArrowRight') next = TEAM_TABS[(i + 1) % TEAM_TABS.length]
    else if (e.key === 'ArrowLeft') next = TEAM_TABS[(i - 1 + TEAM_TABS.length) % TEAM_TABS.length]
    else if (e.key === 'Home') next = TEAM_TABS[0]
    else if (e.key === 'End') next = TEAM_TABS[TEAM_TABS.length - 1]
    if (!next) return
    e.preventDefault()
    e.stopPropagation()
    go(next)
  }
  return (
    <div role="tablist" aria-label={t('teams.tab.label')} onKeyDown={onKeyDown} className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-border bg-bg-secondary/60">
      {TEAM_TABS.map((id) => {
        const selected = id === tab
        const count = id === 'agents' ? running : id === 'needs' ? needs : 0
        return (
          <button
            key={id}
            ref={(el) => {
              if (el) refs.current.set(id, el)
              else refs.current.delete(id)
            }}
            type="button"
            role="tab"
            id={teamTabId(id)}
            aria-selected={selected}
            aria-controls={TEAM_TABPANEL_ID}
            tabIndex={selected ? 0 : -1}
            data-team-tab={id}
            onClick={() => go(id)}
            className={cn(
              'flex shrink-0 items-center gap-1.5 whitespace-nowrap border-r border-border px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-violet/60',
              selected ? 'bg-bg-primary font-medium text-text-primary' : 'text-text-secondary hover:text-text-primary',
            )}
          >
            {t(TAB_KEY[id])}
            {id === 'needs' ? (
              <AttentionBadge count={count} marker="data-team-tab-count" />
            ) : count > 0 ? (
              <span data-team-tab-count={count} className="rounded-full border border-border px-1.5 text-[10px] font-medium leading-4 text-text-secondary">
                {count}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
