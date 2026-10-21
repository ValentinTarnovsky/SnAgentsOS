/**
 * Bottom-sheet showing the desktop's live usage bars (Claude session/weekly,
 * Codex, custom token counters), mirrored into the state snapshot. Read-only;
 * it refreshes live as new snapshots arrive while the sheet is open.
 *
 * App 2.3.0: the Claude group names the active account (its label or role,
 * never the email) and offers "Use <other>" (ctl claudeAccountUse) when a
 * second account is saved, only with a desktop >= 2.3.0 (an older one strikes
 * the unknown ctl kind).
 *
 * App 2.4.0: a desktop >= 2.4.0 lists every other account (`others`, by
 * priority). One other keeps the single "Use <name>" button; more open a
 * picker sheet. Both send `claudeAccountUse { id }`; an older desktop gets
 * `{ role }` as before.
 */
import { useRef, useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { ArrowLeftRight, Check, Loader2 } from 'lucide-react'
import type { RemoteCtlAction, RemoteUsageRow, RemoteUsageSnapshot } from '@shared/remote-protocol'
import type { ClaudeAccountRole, UsageOtherAccount } from '@shared/claude-accounts'
import { APP_2_4_0, appVersionAtLeast } from '@shared/agentTune'
import { visibleUsageRows } from '@shared/usageRows'
import { Sheet } from './Sheet'
import { store, useRemoteStore } from '../lib/store'
import { client } from '../lib/client'
import { t, type MobileMessageKey } from '../lib/i18n'

export const PROVIDER_ORDER = ['claude', 'codex', 'custom'] as const

export const PROVIDER_LABEL: Record<(typeof PROVIDER_ORDER)[number], MobileMessageKey> = {
  claude: 'usage.claude',
  codex: 'usage.codex',
  custom: 'usage.custom',
}

/** Bar fill color by utilization, matching the desktop UsageMeter thresholds. */
export function barColor(percent: number): string {
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

/**
 * Display label: localized session/weekly chosen by the window's kind (what it
 * is, not its id or position), else the row's own. Per-model weekly buckets
 * (Opus, Sonnet) keep the label that names their model.
 */
export function rowLabel(row: RemoteUsageRow): string {
  if (/^claude\.(opus|sonnet)7d$/.test(row.id)) return row.label
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

const ROLE_LABEL: Record<ClaudeAccountRole, MobileMessageKey> = {
  primary: 'usage.rolePrimary',
  secondary: 'usage.roleSecondary',
}

/**
 * An account's label, else "Account N" by its rank (a 2.4.0 desktop), else
 * its role name (2.3.0). The snapshot never carries an email.
 */
export function accountLabel(a: { label: string; role: ClaudeAccountRole; rank?: number }): string {
  const label = a.label.trim()
  if (label) return label
  return typeof a.rank === 'number' ? t('usage.accountN', { n: a.rank + 1 }) : t(ROLE_LABEL[a.role])
}

const ACCOUNT_ERRORS: Record<string, MobileMessageKey> = {
  rate: 'usage.accountRate',
  locked: 'usage.accountLocked',
  unknown_live_account: 'usage.accountUnknown',
  identity_failed: 'usage.accountUnknown',
}

type ActiveAccount = NonNullable<RemoteUsageSnapshot['activeAccount']>
type AccountTarget = { id: string; role: ClaudeAccountRole; rank?: number; label: string }

/**
 * The ctl for a switch: by id to a desktop >= 2.4.0, by role to a 2.3.0 one
 * (only its `other`, whose role names it).
 */
export function accountUseAction(target: AccountTarget, appVersion: string | undefined): Extract<RemoteCtlAction, { kind: 'claudeAccountUse' }> {
  return appVersionAtLeast(appVersion, APP_2_4_0) ? { kind: 'claudeAccountUse', id: target.id } : { kind: 'claudeAccountUse', role: target.role }
}

/** The accounts the phone can offer: every other one (2.4.0), else the single `other` (2.3.0). */
export function accountChoices(account: ActiveAccount, appVersion: string | undefined): UsageOtherAccount[] {
  if (appVersionAtLeast(appVersion, APP_2_4_0) && account.others?.length) return account.others
  const o = account.other
  if (!o) return []
  // A 2.3.0 snapshot has no rank: an unlabeled account keeps its role name, not "Account N".
  const label = o.label.trim() || (typeof o.rank === 'number' ? '' : t(ROLE_LABEL[o.role]))
  return [{ id: o.id, rank: o.rank ?? (o.role === 'primary' ? 0 : 1), role: o.role, label, ready: true }]
}

/**
 * The picker of a desktop with more than two accounts: every account by
 * priority (the active one marked). A sibling of the usage sheet, never its
 * child: that panel scrolls and animates, which would clip a fixed child.
 */
function AccountPickerSheet({ open, onClose, account, choices, busyId, onPick }: {
  open: boolean
  onClose: () => void
  account: ActiveAccount
  choices: UsageOtherAccount[]
  busyId: string | null
  onPick: (a: UsageOtherAccount) => void
}): ReactNode {
  const rows = [{ id: account.id, rank: account.rank ?? 0, role: account.role, label: account.label, ready: true, active: true }, ...choices.map((c) => ({ ...c, active: false }))].sort(
    (a, b) => a.rank - b.rank,
  )
  return (
    <Sheet open={open} onClose={onClose} title={t('usage.pickAccount')}>
      <p className="mb-3 px-1 text-xs text-text-secondary">{t('usage.pickAccountHint')}</p>
      <div data-usage-account-picker className="flex flex-col gap-1.5">
        {rows.map((r) => (
          <button
            key={r.id}
            type="button"
            data-usage-pick-account={r.id}
            data-usage-pick-rank={r.rank}
            disabled={r.active || !r.ready || busyId !== null}
            onClick={() => onPick(r)}
            className="flex min-h-11 items-center gap-2.5 rounded-btn border border-border bg-bg-secondary px-3 py-2 text-left text-sm text-text-primary disabled:opacity-60"
          >
            <span className="shrink-0 text-xs font-semibold tabular-nums text-text-secondary">#{r.rank + 1}</span>
            <span className="min-w-0 flex-1 truncate">{accountLabel(r)}</span>
            {r.active ? (
              <span className="flex shrink-0 items-center gap-1 text-xs text-accent-violet">
                <Check size={13} />
                {t('usage.accountInUse')}
              </span>
            ) : !r.ready ? (
              <span className="shrink-0 text-xs text-text-secondary">{t('usage.accountNotReady')}</span>
            ) : busyId === r.id ? (
              <Loader2 size={13} className="shrink-0 animate-spin" />
            ) : null}
          </button>
        ))}
      </div>
    </Sheet>
  )
}

/** One account switch at a time (ctl claudeAccountUse), with its toast. Resolves true on success. */
function useAccountSwitch(appVersion: string | undefined): { busyId: string | null; use: (target: UsageOtherAccount) => Promise<boolean> } {
  const [busyId, setBusyId] = useState<string | null>(null)
  const inFlight = useRef(false)
  const use = async (target: UsageOtherAccount): Promise<boolean> => {
    if (inFlight.current || !target.ready) return false
    inFlight.current = true
    setBusyId(target.id)
    const res = await client.sendCtl(accountUseAction(target, appVersion))
    inFlight.current = false
    setBusyId(null)
    store.getState().setToast(res.ok ? t('usage.accountSwitched', { name: accountLabel(target) }) : t(ACCOUNT_ERRORS[res.error ?? ''] ?? 'usage.accountFailed'))
    return res.ok
  }
  return { busyId, use }
}

/** The Claude group's account line: "Use <other>" with one other account, "Change account" (the picker) with more. */
function AccountLine({ account, choices, busyId, onUse, onPick }: {
  account: ActiveAccount
  choices: UsageOtherAccount[]
  busyId: string | null
  onUse: (a: UsageOtherAccount) => void
  onPick: () => void
}): ReactNode {
  const single = choices.length === 1 ? choices[0] : null
  const btnCls = 'flex h-9 shrink-0 items-center gap-1.5 rounded-btn border border-border bg-bg-secondary px-3 text-xs font-medium text-text-primary disabled:opacity-60'
  return (
    <div data-usage-account={account.role} data-usage-account-id={account.id} className="mb-1.5 flex items-center justify-between gap-2 px-1">
      <span className="min-w-0 truncate text-xs text-text-secondary">{t('usage.account', { name: accountLabel(account) })}</span>
      {single && (
        <button
          type="button"
          data-usage-use-account={single.role}
          data-usage-use-account-id={single.id}
          disabled={busyId !== null || !single.ready}
          onClick={() => onUse(single)}
          className={btnCls}
        >
          {busyId ? <Loader2 size={13} className="animate-spin" /> : <ArrowLeftRight size={13} />}
          {t('usage.useAccount', { name: accountLabel(single) })}
        </button>
      )}
      {choices.length > 1 && (
        <button type="button" data-usage-change-account disabled={busyId !== null} onClick={onPick} className={btnCls}>
          {busyId ? <Loader2 size={13} className="animate-spin" /> : <ArrowLeftRight size={13} />}
          {t('usage.changeAccount')}
        </button>
      )}
    </div>
  )
}

export function UsageSheet({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  // A window the plan does not have (nodata beside an answered sibling) is not shown.
  const rows = visibleUsageRows(useRemoteStore((s) => s.snapshot?.usage?.rows) ?? [])
  const account = useRemoteStore((s) => s.snapshot?.usage?.activeAccount)
  const appVersion = useRemoteStore((s) => s.appVersion)
  const { busyId, use } = useAccountSwitch(appVersion)
  const [picking, setPicking] = useState(false)
  // An older desktop strikes the unknown ctl kind: no switch at all before 2.3.0.
  const choices = account && appVersionAtLeast(appVersion) ? accountChoices(account, appVersion) : []

  return (
    <>
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
                  {provider === 'claude' && account && (
                    <AccountLine account={account} choices={choices} busyId={busyId} onUse={(a) => void use(a)} onPick={() => setPicking(true)} />
                  )}
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
      {account && choices.length > 1 && (
        <AccountPickerSheet
          open={open && picking}
          onClose={() => setPicking(false)}
          account={account}
          choices={choices}
          busyId={busyId}
          onPick={(a) => {
            void use(a).then((ok) => {
              if (ok) setPicking(false)
            })
          }}
        />
      )}
    </>
  )
}
