import { useState, type ReactNode } from 'react'
import { ArrowLeftRight, ChevronDown, ChevronUp, RefreshCw, Settings as SettingsIcon } from 'lucide-react'
import type { UsageRow } from '@shared/ipc-contract'
import type { ClaudeAccountsState } from '@shared/claude-accounts'
import { visibleUsageRows } from '@shared/usageRows'
import { useAppStore } from '@/lib/store'
import { useUsageStore } from '@/lib/usageStore'
import { accountName, switchAccount, useAccountsStore } from '@/lib/accountsStore'
import { useT, type MessageKey, type TFn } from '@/i18n'
import { iconFor, type IconComponent } from '@/lib/icons'
import { Tooltip } from '@/components/ui/Tooltip'
import { UsageMeter } from '@/components/ui/UsageMeter'
import { UsageRing } from '@/components/ui/UsageRing'
import { ContextMenu } from '@/components/ui/ContextMenu'
import { cn } from '@/lib/cn'

const ClaudeIcon = iconFor('claude')
const CodexIcon = iconFor('openai')

type Services = 'operational' | 'degraded' | 'down'

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}

export function fmtReset(iso: string): string {
  const d = new Date(iso)
  const t = d.getTime()
  if (!Number.isFinite(t)) return ''
  if (t - Date.now() <= 0) return ''
  return t - Date.now() < 24 * 3600_000
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

export function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** Labels follow what the window IS (its kind), never the row id or its position in the plan. */
const KIND_LABEL_KEYS: Partial<Record<UsageRow['kind'], MessageKey>> = {
  '5h': 'aiusage.session',
  '7d': 'aiusage.weekly',
}
/** Per-model weekly buckets share kind '7d' but name their model. */
const MODEL_LABEL_KEYS: Record<string, MessageKey> = {
  'claude.opus7d': 'aiusage.weeklyOpus',
  'claude.sonnet7d': 'aiusage.weeklySonnet',
}

export interface RowView {
  label: string
  percent: number | null
  valueText: string
  subText?: string
  /** Tooltip: set when main is holding the last good value through a failed poll. */
  title?: string
  muted: boolean
}

export function viewRow(row: UsageRow, t: TFn): RowView {
  const labelKey = MODEL_LABEL_KEYS[row.id] ?? KIND_LABEL_KEYS[row.kind]
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
    title: row.stale ? t('aiusage.stale') : row.partial ? t('aiusage.partial') : undefined,
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
  extra,
  status,
  children,
}: {
  icon?: IconComponent
  title: string
  badge?: string
  /** Inline control after the badge (the Claude account chip). */
  extra?: ReactNode
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
        {extra}
        {status && <StatusDot status={status} />}
      </div>
      <div className="space-y-1.5 pl-0.5">{children}</div>
    </div>
  )
}

export interface AccountChipView {
  /** The active account's name, or "Unsaved login". */
  label: string
  /** Tooltip and menu name. */
  title: string
  /** "Use <other>" rows, one per other saved account, by priority. */
  items: Array<{ id: string; rank: number; label: string; disabled: boolean; hint?: string }>
  manage: string
}

/**
 * The Claude account chip of the usage panel (app 2.3.0): shown once an
 * account is saved, with a quick switch to every other one (app 2.4.0: all
 * of them, by priority) and a way to Settings. Pure, for the tests.
 */
export function accountChipView(state: ClaudeAccountsState | null, t: TFn): AccountChipView | null {
  if (!state || !state.supported || state.accounts.length === 0) return null
  const active = state.accounts.find((a) => a.id === state.activeId) ?? null
  const label = active ? accountName(active, t) : t('claudeaccounts.chip.other')
  const unknownLive = state.liveIdentity === 'unknown'
  const items = state.accounts
    .filter((a) => a.id !== active?.id)
    .map((a) => ({
      id: a.id,
      rank: a.rank,
      label: t('claudeaccounts.chip.use', { name: accountName(a, t) }),
      disabled: a.needsRecapture || unknownLive,
      hint: a.needsRecapture ? t('claudeaccounts.err.locked') : unknownLive ? t('claudeaccounts.err.unknownLive') : undefined,
    }))
  return { label, title: t('claudeaccounts.chip.title', { name: label }), items, manage: t('claudeaccounts.chip.manage') }
}

/** The chip itself: a click opens one "Use <name>" per other account and "Manage accounts". */
export function AccountChip() {
  const t = useT()
  const state = useAccountsStore((s) => s.state)
  const busy = useAccountsStore((s) => s.busy)
  const openSettings = useAppStore((s) => s.openSettings)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const view = accountChipView(state, t)
  if (!view) return null
  return (
    <>
      <button
        type="button"
        data-usage-account
        aria-haspopup="menu"
        aria-label={view.title}
        title={view.title}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setMenu({ x: r.left, y: r.bottom + 4 })
        }}
        className="flex min-w-0 max-w-[8rem] items-center gap-0.5 rounded border border-border px-1 py-px text-[9px] text-text-secondary transition-colors hover:border-accent-violet/40 hover:text-text-primary"
      >
        <span className="truncate">{view.label}</span>
        <ChevronDown size={9} className="shrink-0" />
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={view.title}
          onClose={() => setMenu(null)}
          items={[
            ...view.items.map((i) => ({
              label: i.label,
              icon: ArrowLeftRight,
              disabled: i.disabled || busy,
              hint: i.hint,
              onClick: () => void switchAccount(i.id),
            })),
            { label: view.manage, icon: SettingsIcon, separated: view.items.length > 0, onClick: () => openSettings('claudeaccounts') },
          ]}
        />
      )}
    </>
  )
}

/** A row's label, value, reset and stale note, for the tooltip of a ring or a compact row. */
export function tipOf(v: RowView): string {
  return [v.label, v.valueText, v.subText, v.title].filter(Boolean).join(' · ')
}

/** One ring with its row's details in the tooltip. */
function RingCell({ row, t, size, side }: { row: UsageRow; t: TFn; size: number; side: 'right' | 'top' }) {
  const v = viewRow(row, t)
  return (
    <Tooltip label={tipOf(v)} side={side}>
      <div className="flex flex-col items-center gap-0.5" data-usage-ring={row.id}>
        <UsageRing percent={v.percent} muted={v.muted} size={size} />
      </div>
    </Tooltip>
  )
}

/**
 * Live usage docked at the bottom of the sidebar: grouped bars, or folded down
 * to a compact list, one line per metric (`settings.usage.collapsed`); a column
 * of rings in the collapsed rail.
 */
export function UsageBars() {
  const t = useT()
  const usage = useAppStore((s) => s.settings.usage)
  const collapsed = useAppStore((s) => s.sidebarCollapsed)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const folded = usage.collapsed === true
  const setFolded = (next: boolean): void => updateSettings({ usage: { ...useAppStore.getState().settings.usage, collapsed: next } })
  const snapshot = useUsageStore((s) => s.snapshot)
  const refreshing = useUsageStore((s) => s.refreshing)
  const refresh = useUsageStore((s) => s.refresh)
  const accountsState = useAccountsStore((s) => s.state)

  if (!usage.enabled) return null

  // A window the plan does not have (nodata beside an answered sibling) is not shown.
  const rows = visibleUsageRows(snapshot?.rows ?? [])
  const claude = rows.filter((r) => r.provider === 'claude')
  const codex = rows.filter((r) => r.provider === 'codex')
  const custom = rows.filter((r) => r.provider === 'custom')
  const codexPlan = codex.find((r) => r.planType)?.planType ?? undefined
  const claudePlan = claude.find((r) => r.planType)?.planType ?? undefined
  const services = usage.showStatus ? (snapshot?.services ?? null) : null
  const chip = accountChipView(accountsState, t)

  if (collapsed) {
    const groups: Array<{ Icon?: IconComponent; list: UsageRow[] }> = [
      { Icon: ClaudeIcon, list: claude },
      { Icon: CodexIcon, list: codex },
      { Icon: undefined, list: custom },
    ].filter((g) => g.list.length > 0)
    if (groups.length === 0) return null
    return (
      <div className="shrink-0 space-y-2 border-t border-border px-2 py-2.5" data-usage-rail>
        {groups.map((g, gi) => (
          <div key={gi} className="flex flex-col items-center gap-1">
            {g.Icon &&
              (g.Icon === ClaudeIcon && chip ? (
                // Rail: the Claude mark names the active account in its tooltip.
                <Tooltip label={`${t('aiusage.claude')} · ${chip.label}`} side="right">
                  <span data-usage-account-rail className="flex">
                    <g.Icon size={12} className="text-text-secondary" />
                  </span>
                </Tooltip>
              ) : (
                <g.Icon size={12} className="text-text-secondary" />
              ))}
            {g.list.map((r) => (
              <RingCell key={r.id} row={r} t={t} size={30} side="right" />
            ))}
          </div>
        ))}
      </div>
    )
  }

  const header = (
    <div className={cn('flex items-center gap-1', !folded && 'mb-1.5')}>
      <span className="mr-auto text-[10px] font-semibold uppercase tracking-wider text-text-secondary/60">
        {t('aiusage.title')}
      </span>
      {/* Folded: the account chip rides in the header (the Claude group header is gone). */}
      {folded && <AccountChip />}
      <button
        onClick={() => void refresh()}
        title={t('aiusage.refresh')}
        className="rounded p-0.5 text-text-secondary transition-colors hover:text-text-primary"
      >
        <RefreshCw size={12} className={cn(refreshing && 'animate-spin')} />
      </button>
      <button
        onClick={() => setFolded(!folded)}
        data-usage-fold={folded ? 'folded' : 'open'}
        aria-expanded={!folded}
        title={folded ? t('aiusage.expand') : t('aiusage.collapse')}
        className="rounded p-0.5 text-text-secondary transition-colors hover:text-text-primary"
      >
        {folded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
    </div>
  )

  // Folded: one line per metric (provider icon, label, thin bar, percent); the details come back with the chevron.
  if (folded) {
    const compactRows: Array<{ row: UsageRow; Icon?: IconComponent }> = [
      ...claude.map((row) => ({ row, Icon: ClaudeIcon })),
      ...codex.map((row) => ({ row, Icon: CodexIcon })),
      ...custom.map((row) => ({ row, Icon: undefined })),
    ]
    return (
      <div className="shrink-0 border-t border-border px-2.5 py-2" data-usage-folded>
        {header}
        {compactRows.length > 0 && (
          <div className="mt-1.5 flex flex-col gap-1">
            {compactRows.map(({ row, Icon }) => {
              const v = viewRow(row, t)
              // The stale note rides in the tooltip with the rest, not as a second native title.
              return (
                <Tooltip key={row.id} label={tipOf(v)} side="top" className="w-full min-w-0">
                  <div data-usage-row={row.id} className="w-full min-w-0">
                    <UsageMeter {...v} title={undefined} variant="row" icon={Icon} />
                  </div>
                </Tooltip>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="shrink-0 border-t border-border px-2.5 py-2.5">
      {header}

      {rows.length === 0 ? (
        <p className="px-0.5 py-1 text-[10px] text-text-secondary/70">{t('aiusage.empty')}</p>
      ) : (
        <div className="space-y-2.5">
          {claude.length > 0 && (
            <Group icon={ClaudeIcon} title={t('aiusage.claude')} badge={claudePlan} extra={<AccountChip />} status={services}>
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
