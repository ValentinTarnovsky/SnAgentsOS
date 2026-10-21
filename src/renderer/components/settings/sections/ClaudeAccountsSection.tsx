import { useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle, Info, Lock } from 'lucide-react'
import {
  ACCOUNT_LABEL_MAX,
  normalizeAccountsSettings,
  type ClaudeAccountRole,
  type ClaudeAccountView,
  type ClaudeAccountWindowView,
  type ClaudeAccountsState,
} from '@shared/claude-accounts'
import type { ClaudeAccountsSettings } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { accountName, refreshAccountsState, roleName, runAccountsOp, switchAccount, useAccountsStore } from '@/lib/accountsStore'
import { useT, type MessageKey, type TFn } from '@/i18n'
import { cn } from '@/lib/cn'
import { UsageMeter, type UsageMeterProps } from '@/components/ui/UsageMeter'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { fmtClock, fmtReset } from '@/components/sidebar/UsageBars'
import { inputCls, labelCls, SettingRow, ToggleRow } from '../ui'

const ROLES: ClaudeAccountRole[] = ['primary', 'secondary']

const PAUSE_KEY: Record<NonNullable<ClaudeAccountsState['autoPaused']>, MessageKey> = {
  unknownAccount: 'claudeaccounts.paused.unknownAccount',
  noLogin: 'claudeaccounts.paused.noLogin',
  conflict: 'claudeaccounts.paused.conflict',
  locked: 'claudeaccounts.paused.locked',
  refreshFailed: 'claudeaccounts.paused.refreshFailed',
}

const btnCls =
  'rounded-btn border border-border bg-bg-secondary px-2.5 py-1.5 text-xs text-text-primary transition-colors hover:border-accent-violet/40 disabled:cursor-not-allowed disabled:opacity-50'

/** A 5h / 7d window of a saved account as a meter ("as of" for a parked or estimated value). */
export function accountWindowMeter(w: ClaudeAccountWindowView, label: string, t: TFn): UsageMeterProps {
  if (w.percent === null) return { label, percent: null, valueText: t('aiusage.noData'), muted: true }
  const parts: string[] = []
  if (w.source === 'estimated') parts.push(t('claudeaccounts.estimated'))
  else {
    const when = w.resetsAt ? fmtReset(w.resetsAt) : ''
    if (when) parts.push(t('aiusage.resets', { when }))
    if (w.source === 'parked' && w.at) parts.push(t('claudeaccounts.asOf', { time: fmtClock(w.at) }))
  }
  return { label, percent: w.percent, valueText: `${Math.round(w.percent)}%`, subText: parts.join(' · ') || undefined, muted: false }
}

function Banner({ tone, icon, children, attr }: { tone: 'warn' | 'info'; icon?: ReactNode; children: ReactNode; attr: Record<string, string> }) {
  return (
    <div
      {...attr}
      className={cn(
        'flex items-start gap-2.5 rounded-card border px-3 py-2.5 text-xs',
        tone === 'warn' ? 'border-amber-500/40 bg-amber-500/10 text-text-primary' : 'border-border bg-bg-secondary text-text-secondary',
      )}
    >
      <span className={cn('mt-0.5 shrink-0', tone === 'warn' ? 'text-amber-400' : 'text-text-secondary')}>
        {icon ?? (tone === 'warn' ? <AlertTriangle size={14} /> : <Info size={14} />)}
      </span>
      <div className="min-w-0 flex-1 space-y-2">{children}</div>
    </div>
  )
}

/** A number field that commits on blur or Enter, so typing "95" never clamps at "9". */
function NumberField({ label, value, min, max, onCommit, disabled }: { label: string; value: number; min: number; max: number; onCommit: (n: number) => number; disabled?: boolean }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = (): void => {
    const n = Number(draft)
    if (!Number.isFinite(n) || draft.trim() === '') setDraft(String(value))
    // Show what was stored: an unchanged value (150 clamped to 100, returnBelow
    // kept under switchAt) never re-runs the effect above.
    else setDraft(String(onCommit(Math.max(min, Math.min(max, Math.round(n))))))
  }
  return (
    <div>
      <label className={labelCls}>{label}</label>
      <input
        type="number"
        min={min}
        max={max}
        disabled={disabled}
        className={inputCls}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
      />
    </div>
  )
}

function LabelField({ account, disabled }: { account: ClaudeAccountView; disabled: boolean }) {
  const t = useT()
  const [draft, setDraft] = useState(account.label)
  useEffect(() => setDraft(account.label), [account.label])
  const commit = (): void => {
    if (draft.trim() === account.label) return
    void runAccountsOp(() => window.snApi.accounts.rename(account.id, draft))
  }
  return (
    <input
      data-account-label
      className={cn(inputCls, 'h-8 flex-1 text-[13px]')}
      maxLength={ACCOUNT_LABEL_MAX}
      placeholder={t('claudeaccounts.labelPlaceholder')}
      aria-label={t('claudeaccounts.labelPlaceholder')}
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
}

function SlotCard({ role, state, busy, onRemove }: { role: ClaudeAccountRole; state: ClaudeAccountsState; busy: boolean; onRemove: (a: ClaudeAccountView) => void }) {
  const t = useT()
  const acc = state.accounts.find((a) => a.role === role) ?? null
  const capture = (): void => void runAccountsOp(() => window.snApi.accounts.capture({ role }))

  if (!acc) {
    return (
      <div data-account-slot={role} data-account-empty className="space-y-2.5 rounded-card border border-dashed border-border bg-bg-secondary/50 p-3.5">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">{roleName(role, t)}</div>
        <p className="text-sm text-text-primary">{t('claudeaccounts.empty')}</p>
        <p className="text-xs text-text-secondary">{t('claudeaccounts.emptySteps')}</p>
        <button type="button" data-account-capture className={btnCls} disabled={busy} onClick={capture}>
          {state.liveIdentity === 'unknown' && state.liveEmail ? t('claudeaccounts.captureAs', { email: state.liveEmail }) : t('claudeaccounts.capture')}
        </button>
      </div>
    )
  }

  const name = accountName(acc, t)
  return (
    <div
      data-account-slot={role}
      data-account-id={acc.id}
      className={cn('space-y-3 rounded-card border bg-bg-secondary p-3.5', acc.active ? 'border-accent-violet/50' : 'border-border')}
    >
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">{roleName(role, t)}</span>
        <LabelField account={acc} disabled={busy} />
        {acc.subscriptionType && (
          <span data-account-plan className="shrink-0 rounded bg-card px-1.5 py-0.5 text-[10px] font-medium uppercase text-text-secondary">
            {acc.subscriptionType}
          </span>
        )}
        {acc.active && (
          <span data-account-active className="shrink-0 rounded-full bg-accent-violet/20 px-2 py-0.5 text-[10px] font-semibold text-accent-violet">
            {t('claudeaccounts.active')}
          </span>
        )}
      </div>
      <div className="text-xs text-text-secondary">
        <span data-account-email className="text-text-primary">{acc.email ?? name}</span>
        {acc.organizationName && <span> · {acc.organizationName}</span>}
        <span> · {t('claudeaccounts.capturedAt', { date: new Date(acc.capturedAt).toLocaleDateString() })}</span>
        {!acc.identityConfirmed && <p className="mt-1 text-[11px] text-text-secondary/80">{t('claudeaccounts.unconfirmed')}</p>}
      </div>
      {acc.needsRecapture && (
        <Banner tone="warn" icon={<Lock size={14} />} attr={{ 'data-account-needs-recapture': acc.id }}>
          <p>{t('claudeaccounts.needsRecapture')}</p>
        </Banner>
      )}
      <div className="grid grid-cols-2 gap-3">
        <UsageMeter {...accountWindowMeter(acc.usage.fiveHour, t('aiusage.session'), t)} />
        <UsageMeter {...accountWindowMeter(acc.usage.sevenDay, t('aiusage.weekly'), t)} />
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-account-use
          className={btnCls}
          disabled={busy || acc.active || acc.needsRecapture || state.liveIdentity === 'unknown'}
          onClick={() => void switchAccount(role)}
        >
          {t('claudeaccounts.use')}
        </button>
        <button type="button" data-account-recapture className={btnCls} disabled={busy} title={t('claudeaccounts.recaptureHint')} onClick={capture}>
          {t('claudeaccounts.recapture')}
        </button>
        {role === 'secondary' && (
          <button type="button" data-account-primary className={btnCls} disabled={busy} onClick={() => void runAccountsOp(() => window.snApi.accounts.setPrimary(acc.id))}>
            {t('claudeaccounts.makePrimary')}
          </button>
        )}
        <button type="button" data-account-remove className={cn(btnCls, 'hover:border-red-400/50 hover:text-red-400')} disabled={busy} onClick={() => onRemove(acc)}>
          {t('claudeaccounts.remove')}
        </button>
      </div>
    </div>
  )
}

/** The unsaved live login: save it in an empty slot or replace a saved one. */
function UnknownLoginBanner({ state, busy, onReplace }: { state: ClaudeAccountsState; busy: boolean; onReplace: (role: ClaudeAccountRole) => void }) {
  const t = useT()
  return (
    <Banner tone="warn" attr={{ 'data-accounts-unknown': '' }}>
      <p className="font-medium">{t('claudeaccounts.unknown.title')}</p>
      {state.liveEmail && <p>{t('claudeaccounts.unknown.email', { email: state.liveEmail })}</p>}
      <p className="text-text-secondary">{t('claudeaccounts.unknown.hint')}</p>
      <div className="flex flex-wrap gap-2">
        {ROLES.map((role) => {
          const taken = state.accounts.some((a) => a.role === role)
          return taken ? (
            <button key={role} type="button" data-accounts-replace={role} className={btnCls} disabled={busy} onClick={() => onReplace(role)}>
              {t('claudeaccounts.replace', { role: roleName(role, t) })}
            </button>
          ) : (
            <button key={role} type="button" data-accounts-save-as={role} className={btnCls} disabled={busy} onClick={() => void runAccountsOp(() => window.snApi.accounts.capture({ role }))}>
              {t('claudeaccounts.saveAs', { role: roleName(role, t) })}
            </button>
          )
        })}
      </div>
    </Banner>
  )
}

export function ClaudeAccountsSection() {
  const t = useT()
  const state = useAccountsStore((s) => s.state)
  const busy = useAccountsStore((s) => s.busy)
  const cfg = useAppStore((s) => s.settings.claudeAccounts)
  const usageEnabled = useAppStore((s) => s.settings.usage.enabled)
  const workspaces = useAppStore((s) => s.workspaces)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [removing, setRemoving] = useState<ClaudeAccountView | null>(null)
  const [replacing, setReplacing] = useState<ClaudeAccountRole | null>(null)

  // A live section: pull main's state when it opens (the stream keeps it fresh).
  useEffect(() => refreshAccountsState(), [])

  const patch = (p: Partial<ClaudeAccountsSettings>): void =>
    updateSettings({ claudeAccounts: normalizeAccountsSettings({ ...useAppStore.getState().settings.claudeAccounts, ...p }) })
  /** Store one number and return the value that was stored (after normalizing). */
  const patchNum = (field: 'switchAtPercent' | 'minDwellMinutes' | 'returnBelowPercent' | 'returnMarginMinutes' | 'deferMaxMinutes', n: number): number => {
    patch({ [field]: n })
    return useAppStore.getState().settings.claudeAccounts[field]
  }

  const nameOf = (id: string | null | undefined): string => {
    const a = state?.accounts.find((x) => x.id === id)
    return a ? accountName(a, t) : t('claudeaccounts.unknownName')
  }
  const paneTitle = (id: string): string => workspaces.flatMap((w) => w.panes).find((p) => p.id === id)?.title ?? id

  const supported = !!state?.supported
  const autoAvailable = supported && usageEnabled && (state?.accounts.length ?? 0) >= 2
  const replaceAcc = replacing ? state?.accounts.find((a) => a.role === replacing) : undefined

  return (
    <div className="space-y-6">
      <p className="text-xs text-text-secondary">{t('claudeaccounts.hint')}</p>

      {!state ? (
        <p className="text-xs text-text-secondary">{t('claudeaccounts.loading')}</p>
      ) : !state.supported ? (
        <Banner tone="warn" attr={{ 'data-accounts-unsupported': state.unsupportedReason ?? '' }}>
          <p>{t(state.unsupportedReason === 'keychain' ? 'claudeaccounts.unsupported.keychain' : 'claudeaccounts.unsupported.encryption')}</p>
        </Banner>
      ) : (
        <>
          {state.liveIdentity === 'unknown' && <UnknownLoginBanner state={state} busy={busy} onReplace={setReplacing} />}
          {state.liveUnverified && (
            <Banner tone="info" attr={{ 'data-accounts-unverified': '' }}>
              <p>{t('claudeaccounts.unverified')}</p>
            </Banner>
          )}
          {state.autoPaused && (
            <Banner tone="warn" attr={{ 'data-accounts-paused': state.autoPaused }}>
              <p className="font-medium">{t('claudeaccounts.paused.title')}</p>
              <p>{t(PAUSE_KEY[state.autoPaused])}</p>
              <button type="button" data-accounts-resume className={btnCls} disabled={busy} onClick={() => void runAccountsOp(() => window.snApi.accounts.resumeAuto())}>
                {t('claudeaccounts.resume')}
              </button>
            </Banner>
          )}
          {state.lastSwitch?.reason === 'rollback' && (
            <Banner tone="warn" attr={{ 'data-accounts-rollback': '' }}>
              <p>{t('claudeaccounts.rollback', { failed: nameOf(state.lastSwitch.from), to: nameOf(state.lastSwitch.to) })}</p>
            </Banner>
          )}
          {state.blocked === 'allExhausted' && (
            <Banner tone="info" attr={{ 'data-accounts-blocked': '' }}>
              <p>{t('claudeaccounts.blocked', { active: nameOf(state.activeId) })}</p>
            </Banner>
          )}
          {state.pending && (
            <Banner tone="info" attr={{ 'data-accounts-pending': '' }}>
              <p>{t('claudeaccounts.pending', { to: nameOf(state.pending.to) })}</p>
            </Banner>
          )}
          {!state.liveSwitch && state.restartNeeded.length > 0 && (
            <Banner tone="info" attr={{ 'data-accounts-restart': '' }}>
              <p>{t('claudeaccounts.restartNeeded', { panes: state.restartNeeded.map(paneTitle).join(', ') })}</p>
            </Banner>
          )}
          <div className="space-y-3">
            {ROLES.map((role) => (
              <SlotCard key={role} role={role} state={state} busy={busy} onRemove={setRemoving} />
            ))}
          </div>
        </>
      )}

      {/* Automatic switching (off by default); the terms note is always shown. */}
      <section className="space-y-4 border-t border-border pt-5">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{t('claudeaccounts.autoSection')}</h4>
        <p data-accounts-tos className="rounded-btn border border-border bg-bg-secondary px-3 py-2 text-xs text-text-secondary">
          {t('claudeaccounts.tos')}
        </p>
        <ToggleRow
          checked={cfg.autoSwitch}
          onChange={(v) => patch({ autoSwitch: v })}
          disabled={!autoAvailable}
          searchId="claudeaccounts.auto"
          title={t('claudeaccounts.auto')}
          description={t('claudeaccounts.autoHint')}
        />
        {!autoAvailable && (
          <p data-accounts-auto-unavailable className="text-xs text-amber-400">
            {t('claudeaccounts.autoUnavailable')}
          </p>
        )}
        <div className={cn('space-y-4', (!autoAvailable || !cfg.autoSwitch) && 'opacity-60')}>
          <SettingRow searchId="claudeaccounts.switchAt" title={t('claudeaccounts.switchAt')} description={t('claudeaccounts.switchAtHint')}>
            <div className="grid grid-cols-2 gap-3">
              <NumberField label={t('claudeaccounts.switchAtField')} value={cfg.switchAtPercent} min={50} max={100} onCommit={(n) => patchNum('switchAtPercent', n)} />
              <NumberField label={t('claudeaccounts.minDwell')} value={cfg.minDwellMinutes} min={0} max={240} onCommit={(n) => patchNum('minDwellMinutes', n)} />
            </div>
          </SettingRow>
          <ToggleRow
            checked={cfg.returnToPrimary}
            onChange={(v) => patch({ returnToPrimary: v })}
            searchId="claudeaccounts.return"
            title={t('claudeaccounts.return')}
            description={t('claudeaccounts.returnHint')}
          />
          <div className={cn('grid grid-cols-2 gap-3', !cfg.returnToPrimary && 'pointer-events-none opacity-50')}>
            <NumberField label={t('claudeaccounts.returnBelow')} value={cfg.returnBelowPercent} min={0} max={99} onCommit={(n) => patchNum('returnBelowPercent', n)} />
            <NumberField label={t('claudeaccounts.returnMargin')} value={cfg.returnMarginMinutes} min={0} max={120} onCommit={(n) => patchNum('returnMarginMinutes', n)} />
          </div>
          <ToggleRow
            checked={cfg.deferWhileWorking}
            onChange={(v) => patch({ deferWhileWorking: v })}
            searchId="claudeaccounts.defer"
            title={t('claudeaccounts.defer')}
            description={t('claudeaccounts.deferHint')}
          />
          <div className={cn('grid grid-cols-2 gap-3', !cfg.deferWhileWorking && 'pointer-events-none opacity-50')}>
            <NumberField label={t('claudeaccounts.deferMax')} value={cfg.deferMaxMinutes} min={0} max={60} onCommit={(n) => patchNum('deferMaxMinutes', n)} />
          </div>
          <ToggleRow
            checked={cfg.pollParked}
            onChange={(v) => patch({ pollParked: v })}
            searchId="claudeaccounts.pollParked"
            title={t('claudeaccounts.pollParked')}
            description={t('claudeaccounts.pollParkedHint')}
          />
          <ToggleRow
            checked={cfg.alertOnSwitch}
            onChange={(v) => patch({ alertOnSwitch: v })}
            searchId="claudeaccounts.alertOnSwitch"
            title={t('claudeaccounts.alertOnSwitch')}
            description={t('claudeaccounts.alertOnSwitchHint')}
          />
        </div>
      </section>

      <ConfirmDialog
        open={removing !== null}
        title={t('claudeaccounts.removeTitle', { name: removing ? accountName(removing, t) : '' })}
        message={t('claudeaccounts.removeMessage')}
        confirmLabel={t('claudeaccounts.remove')}
        cancelLabel={t('common.cancel')}
        danger
        onConfirm={() => {
          const acc = removing
          setRemoving(null)
          if (acc) void runAccountsOp(() => window.snApi.accounts.remove(acc.id))
        }}
        onCancel={() => setRemoving(null)}
      />
      <ConfirmDialog
        open={replacing !== null}
        title={t('claudeaccounts.replaceTitle', { name: replaceAcc ? accountName(replaceAcc, t) : '' })}
        message={t('claudeaccounts.replaceMessage', { name: replaceAcc ? accountName(replaceAcc, t) : '' })}
        confirmLabel={t('claudeaccounts.replace', { role: replacing ? roleName(replacing, t) : '' })}
        cancelLabel={t('common.cancel')}
        danger
        onConfirm={() => {
          const role = replacing
          setReplacing(null)
          if (role) void runAccountsOp(() => window.snApi.accounts.capture({ role, replace: true }))
        }}
        onCancel={() => setReplacing(null)}
      />
    </div>
  )
}
