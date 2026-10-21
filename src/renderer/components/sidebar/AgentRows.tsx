import { useEffect, useState } from 'react'
import type { AgentPreset } from '@shared/types'
import { AGENT_ROWS_MAX, pickAgentRows } from '@shared/agents'
import { displayStatus } from '@shared/status'
import { useLang, useT } from '@/i18n'
import { agentPhrase, agentTitle, type AgentEntry } from '@/lib/agentNav'
import { revealPane } from '@/lib/revealPane'
import { iconFor } from '@/lib/icons'
import { cn } from '@/lib/cn'
import { Tooltip } from '@/components/ui/Tooltip'
import { StatusGlyph, STATUS_TIP_DELAY, type GlyphKind } from '@/components/ui/StatusDot'
import { useStatusLines } from '@/lib/statusLineStore'
import { useAppStore } from '@/lib/store'
import { CountdownChip, paneCacheDeadline } from '@/components/agents/CacheChip'
import { GitCounts } from '@/components/git/GitChip'
import { useGitStore } from '@/lib/gitStore'
import { chipBranch, chipDirty, compactChip, paneGitKey, paneOwnRepo, repoName } from '@/lib/gitChip'
import type { GitSummary } from '@shared/git-types'

/** Ages on the rows move on their own this often. */
const AGE_TICK_MS = 30_000

/** Re-render every `ms` so relative ages stay current. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

/** Glyph of an entry: not started shows the dotted ring. */
export function glyphOf(e: AgentEntry): GlyphKind {
  if (e.sleeping) return 'sleeping'
  if (e.notStarted || !e.status) return 'notStarted'
  // v2.3: an action main marked as answered shows what the agent does now.
  const s = displayStatus(e.status)
  return s.waiting && s.state === 'working' ? 'waiting' : s.state
}

/**
 * Agent rows under one workspace of the expanded sidebar (E5-FR-19): one 36 px
 * row per agent console with its glyph, title (bold while unread) and what it
 * is doing. With 7 or more, the 6 most urgent in layout order plus "+N more".
 * A click or Enter reveals the console.
 */
export function AgentRows({
  entries,
  presets,
  topicAsTitle,
  wsGit,
  gitOn = false,
}: {
  entries: AgentEntry[]
  presets: readonly AgentPreset[]
  topicAsTitle: boolean
  /** The workspace's own git summary; a console in another repo shows its own on its row. */
  wsGit?: GitSummary
  gitOn?: boolean
}) {
  const t = useT()
  const lang = useLang()
  const now = useNow(AGE_TICK_MS)
  const [expanded, setExpanded] = useState(false)
  // `snaos status` lines (E8-FR-19) replace the phrase on the second line.
  const statusLines = useStatusLines((s) => s.lines)
  // Claude cache countdown (E5-FR-28): on a row it takes the place of the age.
  const cacheTimer = useAppStore((s) => s.settings.agents?.cacheTimer)
  const gitSummaries = useGitStore((s) => s.summaries)
  if (entries.length === 0) return null
  const { shown, hidden } = expanded ? { shown: entries, hidden: 0 } : pickAgentRows(entries)

  return (
    <div className="mb-1 mt-0.5 space-y-px pl-5" data-agent-rows>
      {shown.map((e) => {
        const info = e.status ?? e.session
        const title = agentTitle(e.pane, presets, info, topicAsTitle)
        const deadline = paneCacheDeadline(e.status, cacheTimer)
        const cache = deadline !== null && deadline > Date.now() ? deadline : null
        const phrase = agentPhrase(e, t, lang, now, cache === null)
        const statusLine = statusLines[e.id]
        const detailed = e.status?.detail?.text && !phrase.includes(e.status.detail.text) ? `${phrase}\n${e.status.detail.text}` : phrase
        const full = statusLine ? `${statusLine}\n${detailed}` : detailed
        const Icon = iconFor(e.pane.icon)
        // The console's own repo when it is not the workspace's (a folder of many repos).
        const ownGit = gitOn ? paneOwnRepo(gitSummaries[paneGitKey(e.id)], wsGit) : null
        return (
          <Tooltip
            key={e.id}
            delay={STATUS_TIP_DELAY}
            side="right"
            className="flex w-full min-w-0"
            label={
              <span className="flex flex-col">
                <span>{title}</span>
                {ownGit && (
                  <span className="font-normal text-text-secondary" data-agent-git-tip>
                    {`${repoName(ownGit.repoRoot)} · ${compactChip(ownGit)}`}
                  </span>
                )}
                {full.split('\n').map((line, i) => (
                  <span key={i} className="font-normal text-text-secondary">
                    {line}
                  </span>
                ))}
              </span>
            }
          >
            <button
              type="button"
              data-agent-row={e.id}
              data-agent-state={glyphOf(e)}
              onClick={() => revealPane(e.id)}
              className="flex h-9 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-card/60 focus-visible:bg-card/60 focus-visible:outline-none"
            >
              <StatusGlyph kind={glyphOf(e)} unread={e.unread} size={13} noTooltip />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-1">
                  <Icon size={11} className="shrink-0" style={{ color: e.pane.color }} />
                  <span className={cn('truncate text-[12px] leading-4', e.unread ? 'font-semibold text-text-primary' : 'text-text-primary/90')}>{title}</span>
                  {ownGit && (
                    <span className="ml-auto min-w-0 max-w-[65%] shrink truncate pl-1 text-[10.5px] leading-4 text-text-secondary" data-agent-git={e.id}>
                      {repoName(ownGit.repoRoot)}
                      {' · '}
                      <span className="font-mono">{chipBranch(ownGit)}</span>
                      {chipDirty(ownGit) && (
                        <>
                          {' '}
                          <GitCounts summary={ownGit} />
                        </>
                      )}
                    </span>
                  )}
                </span>
                <span className="flex min-w-0 items-center gap-1">
                  <span className="block min-w-0 flex-1 truncate text-[11px] leading-4 text-text-secondary" {...(statusLine ? { 'data-agent-status-line': '' } : {})}>{statusLine ?? phrase}</span>
                  {cache !== null && <CountdownChip deadline={cache} />}
                </span>
              </span>
            </button>
          </Tooltip>
        )
      })}
      {(hidden > 0 || (expanded && entries.length > AGENT_ROWS_MAX)) && (
        <button
          type="button"
          data-agent-rows-more
          onClick={() => setExpanded((v) => !v)}
          className="flex h-6 w-full items-center rounded-md px-2 text-left text-[11px] text-text-secondary transition-colors hover:bg-card/60 hover:text-text-primary"
        >
          {expanded ? t('agents.row.less') : t('agents.row.more', { count: hidden })}
        </button>
      )}
    </div>
  )
}
