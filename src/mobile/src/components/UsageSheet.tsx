/**
 * Bottom-sheet showing the desktop's live usage bars (Claude session/weekly,
 * Codex, custom token counters), mirrored into the state snapshot. Read-only;
 * it refreshes live as new snapshots arrive while the sheet is open.
 */
import { type ReactNode } from 'react'
import { clsx } from 'clsx'
import type { RemoteUsageRow } from '@shared/remote-protocol'
import { Sheet } from './Sheet'
import { useRemoteStore } from '../lib/store'
import { t, type MobileMessageKey } from '../lib/i18n'

const PROVIDER_ORDER = ['claude', 'codex', 'custom'] as const

const PROVIDER_LABEL: Record<(typeof PROVIDER_ORDER)[number], MobileMessageKey> = {
  claude: 'usage.claude',
  codex: 'usage.codex',
  custom: 'usage.custom',
}

/** Bar fill color by utilization, matching the desktop UsageMeter thresholds. */
function barColor(percent: number): string {
  if (percent >= 85) return 'bg-red-400'
  if (percent >= 60) return 'bg-amber-400'
  return 'bg-green-400'
}

/** Compact number: 1234 -> 1.2K, 1_200_000 -> 1.2M. */
function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/** Compact time-until an ISO instant: 45m / 3h / 2d (null when past/invalid). */
function fmtUntil(iso: string): string | null {
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return null
  const ms = ts - Date.now()
  if (ms <= 0) return null
  const min = Math.round(ms / 60000)
  if (min < 60) return `${Math.max(1, min)}m`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h`
  return `${Math.round(hr / 24)}d`
}

/** Display label: localized session/weekly for quota rows, else the row's own. */
function rowLabel(row: RemoteUsageRow): string {
  if (row.kind === '5h') return t('usage.session')
  if (row.kind === '7d') return t('usage.weekly')
  return row.label
}

function valueText(row: RemoteUsageRow): string {
  if (row.status === 'expired') return t('usage.expired')
  if (row.status === 'error') return t('usage.error')
  if (row.status === 'loading') return t('usage.loading')
  if (row.percent != null) return `${Math.round(row.percent)}%`
  if (row.used != null) {
    return row.limit != null ? `${fmtNum(row.used)} / ${fmtNum(row.limit)}` : fmtNum(row.used)
  }
  return '-'
}

function UsageRowView({ row }: { row: RemoteUsageRow }): ReactNode {
  const muted = row.status !== 'ok'
  const pct = row.percent != null ? Math.max(0, Math.min(100, row.percent)) : null
  const reset = row.resetsAt ? fmtUntil(row.resetsAt) : null
  return (
    <div className="rounded-btn border border-border bg-bg-secondary px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-sm text-text-primary">{rowLabel(row)}</span>
          {row.planType && (
            <span className="shrink-0 rounded bg-card px-1.5 py-0.5 text-[10px] font-medium uppercase text-text-secondary">
              {row.planType}
            </span>
          )}
        </div>
        <span className={clsx('shrink-0 text-xs font-medium', muted ? 'text-text-secondary' : 'text-text-primary')}>
          {valueText(row)}
        </span>
      </div>
      {pct != null && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-primary">
          <div
            className={clsx('h-full rounded-full transition-all', muted ? 'bg-border' : barColor(pct))}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {reset && <div className="mt-1 text-[10px] text-text-secondary">{t('usage.resets', { t: reset })}</div>}
    </div>
  )
}

export function UsageSheet({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const rows = useRemoteStore((s) => s.snapshot?.usage?.rows) ?? []

  return (
    <Sheet open={open} onClose={onClose} title={t('usage.title')}>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-text-secondary">{t('usage.none')}</p>
      ) : (
        <div className="flex flex-col gap-4">
          {PROVIDER_ORDER.map((provider) => {
            const group = rows.filter((r) => r.provider === provider)
            if (group.length === 0) return null
            return (
              <div key={provider}>
                <div className="mb-1.5 px-1 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                  {t(PROVIDER_LABEL[provider])}
                </div>
                <div className="flex flex-col gap-1.5">
                  {group.map((row) => (
                    <UsageRowView key={row.id} row={row} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Sheet>
  )
}
