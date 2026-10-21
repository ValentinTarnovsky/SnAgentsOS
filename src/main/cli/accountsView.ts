/**
 * `snaos account` over AccountService (app 2.3.0, 4b). Every field is picked
 * by name from the service's views, so the CLI never gets a token, a raw
 * credentials blob or an email (the desktop's Settings is the only place an
 * email shows); a label holding an `@` comes as '' (the slot is shown), the
 * same rule as the phone. Switches always carry reason 'cli'. Types only from
 * the service: tests load this file without Electron.
 */
import type { AccountsOpRes, ClaudeAccountView, ClaudeAccountWindowView, ClaudeAccountsState } from '@shared/claude-accounts'
import type { ClaudeAccountsSettings } from '@shared/types'
import type { CtlAccountInfo, CtlAccountStatus, CtlAccountWindow } from '@shared/ctl-protocol'
import type { CtlAccountsView } from './handlers'

/** The AccountService surface the adapter reads. */
export interface AccountsSource {
  status(): ClaudeAccountsState
  settings(): ClaudeAccountsSettings
  switchTo(idOrRole: string, reason: 'cli'): Promise<AccountsOpRes>
}

function windowOf(w: ClaudeAccountWindowView | undefined): CtlAccountWindow {
  return {
    percent: typeof w?.percent === 'number' && Number.isFinite(w.percent) ? w.percent : null,
    resetsAt: typeof w?.resetsAt === 'string' ? w.resetsAt : null,
    source: w?.source ?? 'none',
  }
}

export function ctlAccount(v: ClaudeAccountView): CtlAccountInfo {
  return {
    id: v.id,
    provider: 'claude',
    slot: v.role,
    label: typeof v.label === 'string' && !v.label.includes('@') ? v.label : '',
    plan: typeof v.subscriptionType === 'string' && v.subscriptionType ? v.subscriptionType : null,
    active: v.active === true,
    ready: !v.needsRecapture,
    fiveHour: windowOf(v.usage?.fiveHour),
    sevenDay: windowOf(v.usage?.sevenDay),
  }
}

export function ctlAccountStatus(s: ClaudeAccountsState, cfg: ClaudeAccountsSettings): CtlAccountStatus {
  const accounts = (s.accounts ?? []).map(ctlAccount)
  return {
    supported: s.supported === true,
    live: s.liveIdentity,
    ...(s.liveUnverified === true ? { unverified: true as const } : {}),
    active: accounts.find((a) => a.id === s.activeId) ?? null,
    accounts,
    lastSwitch: s.lastSwitch ? { at: s.lastSwitch.at, from: s.lastSwitch.from, to: s.lastSwitch.to, reason: s.lastSwitch.reason } : null,
    auto: { enabled: cfg.autoSwitch === true, switchAtPercent: cfg.switchAtPercent, paused: s.autoPaused ?? null },
  }
}

export function ctlAccountsView(src: AccountsSource): CtlAccountsView {
  return {
    status: async () => ctlAccountStatus(src.status(), src.settings()),
    switchTo: async (id, reason) => {
      const r = await src.switchTo(id, reason)
      return r.ok ? { ok: true } : { ok: false, ...(r.error ? { error: r.error } : {}) }
    },
  }
}
