import type { ReactNode } from 'react'
import { RefreshCw } from 'lucide-react'
import type { UsageRow } from '@shared/ipc-contract'
import { useAppStore } from '@/lib/store'
import { useUsageStore } from '@/lib/usageStore'
import { useT, type MessageKey, type TFn } from '@/i18n'
import { iconFor, type IconComponent } from '@/lib/icons'
import { Tooltip } from '@/components/ui/Tooltip'
import { UsageMeter } from '@/components/ui/UsageMeter'
import { UsageRing } from '@/components/ui/UsageRing'
import { cn } from '@/lib/cn'

const ClaudeIcon = iconFor('claude')
const CodexIcon = iconFor('openai')

type Services = 'operational' | 'degraded' | 'down'

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}

function fmtReset(iso: string): string {
  const d = new Date(iso)
  const t = d.getTime()
  if (!Number.isFinite(t)) return ''
  if (t - Date.now() <= 0) return ''
  return t - Date.now() < 24 * 3600_000
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

const ROW_LABEL_KEYS: Record<string, MessageKey> = {
  'claude.5h': 'aiusage.session',
  'claude.7d': 'aiusage.weekly',
  'claude.opus7d': 'aiusage.weeklyOpus',
  'claude.sonnet7d': 'aiusage.weeklySonnet',
  'codex.5h': 'aiusage.session',
  'codex.7d': 'aiusage.weekly',
}

export interface RowView {
  label: string
  percent: number | null
  valueText: string
  subText?: string
  muted: boolean
}

export function viewRow(row: UsageRow, t: TFn): RowView {
  const labelKey = ROW_LABEL_KEYS[row.id]
  const label = labelKey ? t(labelKey) : row.label
  if (row.status !== 'ok') {
    const valueText = t(
      row.status === 'expired'
        ? 'aiusage.expired'
        : row.status === 'error'
          ? 'aiusage.error'
          : row.status === 'loading'
            ? 'aiusage.loading'
            : 'aiusage.noData',
    )
    return { label, percent: null, valueText, muted: true }
  }
  const valueText =
    row.provider === 'custom'
      ? row.limit
        ? `${fmtTokens(row.used ?? 0)} / ${fmtTokens(row.limit)}`
        : fmtTokens(row.used ?? 0)
      : `${Math.round(row.percent ?? 0)}%`
  const when = row.resetsAt ? fmtReset(row.resetsAt) : ''
  return {
    label,
    percent: row.percent,
    valueText,
    subText: when ? t('aiusage.resets', { when }) : undefined,
    muted: false,
  }
}

function StatusDot({ status }: { status: Services }) {
  const color = status === 'operational' ? '#22c55e' : status === 'degraded' ? '#f59e0b' : '#ef4444'
  return <span className="ml-auto h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
}

function Group({
  icon: Icon,
  title,
  badge,
  status,
  children,
}: {
  icon?: IconComponent
  title: string
  badge?: string
  status?: Services | null
  children: ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        {Icon && <Icon size={12} className="shrink-0 text-text-secondary" />}
        <span className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary/70">
          {title}
        </span>
        {badge && (
          <span className="rounded bg-card px-1 py-px text-[9px] uppercase text-text-secondary">
            {badge}
          </span>
        )}
        {status && <StatusDot status={status} />}
      </div>
      <div className="space-y-1.5 pl-0.5">{children}</div>
    </div>
  )
}

/** Always-expanded live usage bars docked at the bottom of the sidebar. */
export function UsageBars() {
  const t = useT()
  const usage = useAppStore((s) => s.settings.usage)
  const collapsed = useAppStore((s) => s.sidebarCollapsed)
  const snapshot = useUsageStore((s) => s.snapshot)
  const refreshing = useUsageStore((s) => s.refreshing)
  const refresh = useUsageStore((s) => s.refresh)

  if (!usage.enabled) return null

  const rows = snapshot?.rows ?? []
  const claude = rows.filter((r) => r.provider === 'claude')
  const codex = rows.filter((r) => r.provider === 'codex')
  const custom = rows.filter((r) => r.provider === 'custom')
  const codexPlan = codex.find((r) => r.planType)?.planType ?? undefined
  const claudePlan = claude.find((r) => r.planType)?.planType ?? undefined
  const services = usage.showStatus ? (snapshot?.services ?? null) : null

  if (collapsed) {
    const groups: Array<{ Icon?: IconComponent; list: UsageRow[] }> = [
      { Icon: ClaudeIcon, list: claude },
      { Icon: CodexIcon, list: codex },
      { Icon: undefined, list: custom },
    ].filter((g) => g.list.length > 0)
    if (groups.length === 0) return null
    return (
      <div className="shrink-0 space-y-3 border-t border-border px-2 py-3">
        {groups.map((g, gi) => (
          <div key={gi} className="flex flex-col items-center gap-1.5">
            {g.Icon && <g.Icon size={13} className="text-text-secondary" />}
            {g.list.map((r) => {
              const v = viewRow(r, t)
              return (
                <Tooltip key={r.id} label={`${v.label} · ${v.valueText}`} side="right">
                  <div className="flex justify-center">
                    <UsageRing percent={v.percent} muted={v.muted} size={36} />
                  </div>
                </Tooltip>
              )
            })}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="shrink-0 border-t border-border px-2.5 py-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary/60">
          {t('aiusage.title')}
        </span>
        <button
          onClick={() => void refresh()}
          title={t('aiusage.refresh')}
          className="rounded p-0.5 text-text-secondary transition-colors hover:text-text-primary"
        >
          <RefreshCw size={12} className={cn(refreshing && 'animate-spin')} />
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="px-0.5 py-1 text-[10px] text-text-secondary/70">{t('aiusage.empty')}</p>
      ) : (
        <div className="space-y-2.5">
          {claude.length > 0 && (
            <Group icon={ClaudeIcon} title={t('aiusage.claude')} badge={claudePlan} status={services}>
              {claude.map((r) => (
                <UsageMeter key={r.id} {...viewRow(r, t)} />
              ))}
            </Group>
          )}
          {codex.length > 0 && (
            <Group icon={CodexIcon} title={t('aiusage.codex')} badge={codexPlan}>
              {codex.map((r) => (
                <UsageMeter key={r.id} {...viewRow(r, t)} />
              ))}
            </Group>
          )}
          {custom.length > 0 && (
            <Group title={t('aiusage.custom')}>
              {custom.map((r) => (
                <UsageMeter key={r.id} {...viewRow(r, t)} />
              ))}
            </Group>
          )}
        </div>
      )}

      {snapshot && rows.length > 0 && (
        <div className="mt-2 text-right text-[9px] text-text-secondary/50">
          {t('aiusage.updated', { time: fmtClock(snapshot.updatedAt) })}
        </div>
      )}
    </div>
  )
}
