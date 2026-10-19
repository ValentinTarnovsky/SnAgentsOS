/**
 * Inline usage on Home (E2-FR-14): when the snapshot carries usage, one
 * compact card per provider with whichever quota bars it has (session and/or
 * weekly: a weekly-only plan has just one; same thresholds as UsageSheet). A
 * tap anywhere opens the full UsageSheet.
 */
import type { ReactNode } from 'react'
import { clsx } from 'clsx'
import type { RemoteUsageRow } from '@shared/remote-protocol'
import { isQuotaKind, visibleUsageRows } from '@shared/usageRows'
import { barColor, PROVIDER_LABEL, PROVIDER_ORDER, rowLabel } from '../UsageSheet'
import { useRemoteStore } from '../../lib/store'
import { t } from '../../lib/i18n'

function MiniBar({ row }: { row: RemoteUsageRow }): ReactNode {
  const pct = row.percent != null ? Math.max(0, Math.min(100, row.percent)) : null
  const muted = row.status !== 'ok' || pct == null
  return (
    <span data-usage-bar={row.kind} className="flex min-w-0 flex-1 items-center gap-1.5">
      <span className="max-w-[4.5rem] shrink-0 truncate text-[10px] font-medium text-text-secondary">{rowLabel(row)}</span>
      <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-bg-primary">
        <span className={clsx('block h-full rounded-full', muted ? 'bg-border' : barColor(pct))} style={{ width: `${pct ?? 0}%` }} />
      </span>
      <span className="w-8 shrink-0 text-right text-[10px] text-text-secondary">{pct != null ? `${Math.round(pct)}%` : '-'}</span>
    </span>
  )
}

export function UsageCards({ onOpen }: { onOpen: () => void }): ReactNode {
  const rows = useRemoteStore((s) => s.snapshot?.usage?.rows)
  const quota = visibleUsageRows(rows ?? []).filter((r) => isQuotaKind(r.kind))
  if (quota.length === 0) return null
  return (
    <section data-home-usage className="mb-4">
      <button
        onClick={onOpen}
        aria-label={t('usage.title')}
        className="flex w-full flex-col gap-2 rounded-card border border-border bg-bg-secondary px-3 py-2.5 text-left active:bg-card"
      >
        {PROVIDER_ORDER.map((provider) => {
          const group = quota.filter((r) => r.provider === provider)
          if (group.length === 0) return null
          return (
            <span key={provider} data-usage-provider={provider} className="flex items-center gap-3">
              <span className="w-14 shrink-0 truncate text-xs font-semibold text-text-primary">{t(PROVIDER_LABEL[provider])}</span>
              {group.map((row) => (
                <MiniBar key={row.id} row={row} />
              ))}
            </span>
          )
        })}
      </button>
    </section>
  )
}
