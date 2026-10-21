import { create } from 'zustand'
import { rankOfRole, type AccountsOpError, type ClaudeAccountRole, type ClaudeAccountsEvent, type ClaudeAccountsState } from '@shared/claude-accounts'
import type { ClaudeAccountsSettings } from '@shared/types'
import { translate, type MessageKey, type TFn } from '@/i18n'
import { useAppStore } from './store'
import { toast } from './toast'

/**
 * Claude multi-account (app 2.3.0): the renderer's view of main's account
 * state (accounts:getState / accounts:changed). Main owns the accounts and the
 * logins; nothing here ever holds a token.
 */
interface AccountsStoreState {
  state: ClaudeAccountsState | null
  /** An account operation is in flight (buttons lock). */
  busy: boolean
}

export const useAccountsStore = create<AccountsStoreState>(() => ({ state: null, busy: false }))

/** The account's label, or "Account N" (1-based rank; a bare 2.3.0 role names rank 0 / 1). */
export function accountName(a: { label: string; rank?: number; role?: ClaudeAccountRole } | null | undefined, t: TFn): string {
  if (!a) return ''
  const rank = typeof a.rank === 'number' ? a.rank : a.role ? rankOfRole(a.role) : 0
  return a.label.trim() || t('claudeaccounts.accountN', { n: rank + 1 })
}

const ERROR_KEY: Record<AccountsOpError, MessageKey> = {
  not_found: 'claudeaccounts.err.notFound',
  unknown_live_account: 'claudeaccounts.err.unknownLive',
  no_login: 'claudeaccounts.err.noLogin',
  encryption_unavailable: 'claudeaccounts.err.encryption',
  locked: 'claudeaccounts.err.locked',
  identity_failed: 'claudeaccounts.err.identity',
  duplicate: 'claudeaccounts.err.duplicate',
  role_taken: 'claudeaccounts.err.limit',
  limit_reached: 'claudeaccounts.err.limit',
  busy: 'claudeaccounts.err.busy',
  io: 'claudeaccounts.err.io',
  unsupported: 'claudeaccounts.err.unsupported',
  bad_request: 'claudeaccounts.err.generic',
}

/** The message of a failed account operation. */
export function accountsErrorText(error: string | undefined, t: TFn): string {
  return t(ERROR_KEY[error as AccountsOpError] ?? 'claudeaccounts.err.generic')
}

const tNow: TFn = (key, vars) => translate(useAppStore.getState().settings.language, key, vars)

/**
 * Run one account operation: lock the buttons, keep the returned state and
 * toast the error. Resolves true on success.
 */
export async function runAccountsOp(op: () => Promise<{ ok: boolean; error?: string; state: ClaudeAccountsState }>): Promise<boolean> {
  if (useAccountsStore.getState().busy) return false
  useAccountsStore.setState({ busy: true })
  try {
    const res = await op()
    if (res?.state) useAccountsStore.setState({ state: res.state })
    if (!res?.ok) toast.error(accountsErrorText(res?.error, tNow))
    return !!res?.ok
  } catch {
    toast.error(tNow('claudeaccounts.err.generic'))
    return false
  } finally {
    useAccountsStore.setState({ busy: false })
  }
}

/** Switch the live Claude login to a saved account by id (the desktop UI's `manual` reason). */
export function switchAccount(id: string): Promise<boolean> {
  return runAccountsOp(() => window.snApi.accounts.switchTo(id, 'manual'))
}

/** The ids in the new order after moving `id` by `delta` places (null: it cannot move). */
export function movedOrder(ids: string[], id: string, delta: number): string[] | null {
  const i = ids.indexOf(id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= ids.length || delta === 0) return null
  const next = [...ids]
  next.splice(i, 1)
  next.splice(j, 0, id)
  return next
}

/** Move a saved account up (-1) or down (+1) in the priority order (accounts:reorder). */
export function moveAccount(id: string, delta: number): Promise<boolean> {
  const ids = useAccountsStore.getState().state?.accounts.map((a) => a.id) ?? []
  const next = movedOrder(ids, id, delta)
  if (!next) return Promise.resolve(false)
  return runAccountsOp(() => window.snApi.accounts.reorder(next))
}

/** Pull main's state once (a section mount, the chip). */
export function refreshAccountsState(): void {
  void window.snApi.accounts
    .getState()
    .then((s) => useAccountsStore.setState({ state: s }))
    .catch(() => undefined)
}

/** The toast a main event deserves in the app, or null (the phone's own switch has its remote notice). */
export function accountsEventToast(e: ClaudeAccountsEvent, state: ClaudeAccountsState | null, t: TFn): { kind: 'info' | 'warning' | 'error'; text: string } | null {
  const name = (id: string | undefined): string => {
    const a = state?.accounts.find((x) => x.id === id)
    return a ? accountName(a, t) : t('claudeaccounts.unknownName')
  }
  switch (e.kind) {
    case 'switched':
      if (e.reason === 'phone') return null
      if (e.reason === 'external') return { kind: 'info', text: t('toast.accounts.external', { to: name(e.to) }) }
      if (e.reason === 'auto_return') return { kind: 'info', text: t('toast.accounts.return', { to: name(e.to) }) }
      if (e.auto) return { kind: 'info', text: t('toast.accounts.auto', { to: name(e.to), from: name(e.from), percent: e.percent ?? 0 }) }
      return { kind: 'info', text: t('toast.accounts.switched', { to: name(e.to) }) }
    case 'allExhausted':
      return { kind: 'warning', text: t('toast.accounts.allExhausted', { active: name(e.from) }) }
    case 'unknownAccount':
      return { kind: 'warning', text: t('toast.accounts.unknown') }
    case 'conflict':
      return { kind: 'warning', text: t('toast.accounts.conflict', { account: name(e.from) }) }
    case 'rollback':
      return { kind: 'warning', text: t('toast.accounts.rollback', { failed: name(e.from), to: name(e.to) }) }
    case 'locked':
      return { kind: 'error', text: t('toast.accounts.locked', { account: name(e.to) }) }
    case 'loggedOut':
      return { kind: 'error', text: t('toast.accounts.loggedOut', { account: name(e.from) }) }
  }
  return null
}

let wired = false

/** Wire main's state and event streams and pull the first state (idempotent). */
export function initAccountsEvents(): () => void {
  if (wired) return () => undefined
  wired = true
  const api = window.snApi.accounts
  const offChanged = api.onChanged((s) => useAccountsStore.setState({ state: s }))
  const offEvent = api.onEvent((e) => {
    const shown = accountsEventToast(e, useAccountsStore.getState().state, tNow)
    if (shown) toast[shown.kind](shown.text)
  })
  refreshAccountsState()
  return () => {
    wired = false
    offChanged()
    offEvent()
  }
}

/** The policy settings main got last (JSON), so an unchanged render sends nothing. */
let lastSynced = ''

/** Push settings.claudeAccounts to main whenever it changes. */
export function syncAccountsConfig(cfg: ClaudeAccountsSettings): void {
  const key = JSON.stringify(cfg)
  if (key === lastSynced) return
  lastSynced = key
  window.snApi.accounts.setConfig(cfg)
}
