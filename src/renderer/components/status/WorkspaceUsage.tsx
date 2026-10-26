import { useMemo } from 'react'
import type { Workspace } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { useLang, useT } from '@/i18n'
import { formatCost, formatTokens, sumUsage, usageLines } from '@/lib/statusSignals'
import { Tooltip } from '@/components/ui/Tooltip'

/**
 * What the consoles of one workspace spent (app 2.7.0, A6): the sum of
 * their `usage` (ConsoleLedger), added up here in the renderer and never in
 * main, as "Uso estimado: 1,2 M tokens · 1,75 US$". Nothing shows until a
 * console reports usage. Always an estimate: the tokens come from the
 * agents' own records and the cost from the agent or the rate card.
 */
export function WorkspaceUsage({ workspace }: { workspace: Workspace }) {
  const t = useT()
  const lang = useLang()
  const paneStatus = useAppStore((s) => s.paneStatus)
  const total = useMemo(() => sumUsage(workspace.panes.map((p) => paneStatus[p.id]?.usage)), [workspace.panes, paneStatus])
  if (!total) return null
  const tokens = formatTokens(total.tokens, lang)
  const text =
    total.costUSD === undefined
      ? t('status.usage.totalNoCost', { tokens })
      : t(total.unknownCost ? 'status.usage.totalAtLeast' : 'status.usage.total', { tokens, cost: formatCost(total.costUSD, lang) })
  return (
    <Tooltip
      side="bottom"
      className="min-w-0 shrink self-center"
      label={
        <span className="flex flex-col" data-workspace-usage-tip>
          <span>{t('status.usage.wsTip', { count: total.consoles })}</span>
          {usageLines(total, t, lang).map((line, i) => (
            <span key={i} className="font-normal text-text-secondary">
              {line}
            </span>
          ))}
        </span>
      }
    >
      <span
        data-workspace-usage={workspace.id}
        className="min-w-0 truncate rounded border border-border px-1.5 text-[11px] leading-5 tabular-nums text-text-secondary"
      >
        {text}
      </span>
    </Tooltip>
  )
}
