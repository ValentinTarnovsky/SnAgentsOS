import { create } from 'zustand'
import type {
  ShareExpiryChoice,
  ShareHostError,
  ShareHostGrantView,
  ShareHostPaneGuests,
  ShareHostState,
} from '@shared/ipc-contract'
import type { Language, SharePerm, ShareRights, ShareSettings } from '@shared/types'
import type { MessageKey, TFn } from '@/i18n'

/**
 * Share, host side (app 2.4.0, item 8, stage S4): the renderer mirror of
 * main's ShareHost. Main is authoritative: this store only holds the last
 * ShareHostState and share:panes it pushed, which dialog is open, and the
 * approvals answered here (hidden until main drops them). Every action goes
 * through window.snApi.share.host by id; nothing here is persisted.
 */

/** The neutral state until main answers (encryption assumed on so the password field does not flash a warning). */
export const EMPTY_SHARE_HOST: ShareHostState = {
  enabled: false,
  port: 4527,
  listening: 'off',
  pausedAll: false,
  encryption: true,
  endpoints: [],
  grants: [],
  approvals: [],
}

/** What the Share dialog was opened on. */
export type ShareDialogScope = { kind: 'pane'; paneId: string; workspaceId: string } | { kind: 'workspace'; workspaceId: string }

export const SHARE_PERMS: readonly SharePerm[] = ['view', 'type', 'full']
export const SHARE_EXPIRIES: readonly ShareExpiryChoice[] = ['never', '1h', '8h', '24h']

export const PERM_KEY: Record<SharePerm, MessageKey> = {
  view: 'shareHost.perm.view',
  type: 'shareHost.perm.type',
  full: 'shareHost.perm.full',
}

export const PERM_HINT_KEY: Record<SharePerm, MessageKey> = {
  view: 'shareHost.perm.viewHint',
  type: 'shareHost.perm.typeHint',
  full: 'shareHost.perm.fullHint',
}

export const EXPIRY_KEY: Record<ShareExpiryChoice, MessageKey> = {
  never: 'shareHost.expiry.never',
  '1h': 'shareHost.expiry.1h',
  '8h': 'shareHost.expiry.8h',
  '24h': 'shareHost.expiry.24h',
}

export const ENDPOINT_KIND_KEY: Record<'ts' | 'lan' | 'loop', MessageKey> = {
  ts: 'remote.kind.tailscale',
  lan: 'remote.kind.lan',
  loop: 'shareHost.kind.loop',
}

const ERROR_KEY: Record<ShareHostError, MessageKey> = {
  not_found: 'shareHost.err.notFound',
  invalid: 'shareHost.err.invalid',
  limit: 'shareHost.err.limit',
  encryption_unavailable: 'shareHost.err.encryption',
  no_endpoint: 'shareHost.err.noEndpoint',
  scope_gone: 'shareHost.err.scopeGone',
}

export function shareErrorKey(error: ShareHostError | string | undefined): MessageKey {
  return (error && ERROR_KEY[error as ShareHostError]) || 'shareHost.err.invalid'
}

/**
 * The listener error in the UI language. Main reports EADDRINUSE / EACCES as
 * fixed English text (ShareHost.startListener); anything else is shown as is.
 */
export function listenErrorText(t: TFn, state: ShareHostState): string | null {
  if (state.listening !== 'error' || !state.error) return null
  if (/already in use/i.test(state.error)) return t('shareHost.listen.inUse', { port: state.port })
  if (/elevated privileges/i.test(state.error)) return t('shareHost.listen.denied', { port: state.port })
  return state.error
}

/** The rights a share gives, as one line in the UI language: "Consoles, Chat, Notes (read)". */
export function shareRightsSummary(t: TFn, r: ShareRights): string {
  const parts: string[] = []
  if (r.consoles) parts.push(t('shareHost.rights.consoles'))
  if (r.chat) parts.push(t('shareHost.rights.chat'))
  if (r.changes) parts.push(t('shareHost.rights.changes'))
  if (r.notes !== 'off') parts.push(t(r.notes === 'write' ? 'shareHost.rights.sumNotesWrite' : 'shareHost.rights.sumNotesRead'))
  if (r.files === 'read') parts.push(t('shareHost.rights.sumFiles'))
  return parts.length > 0 ? parts.join(', ') : t('shareHost.rights.none')
}

/** Password rule of main (SHARE_LIMITS.passwordMin/Max): '' means no password. */
export const SHARE_PASSWORD_MIN = 8
export const SHARE_PASSWORD_MAX = 128

export function passwordProblem(pw: string): MessageKey | null {
  if (pw === '') return null
  if (pw.length < SHARE_PASSWORD_MIN) return 'shareHost.password.short'
  if (pw.length > SHARE_PASSWORD_MAX) return 'shareHost.password.long'
  return null
}

/** Every connected guest across all grants. */
export function shareGuestCount(state: ShareHostState): number {
  let n = 0
  for (const g of state.grants) n += g.sessions.length
  return n
}

/** The grants created on exactly this scope (a pane grant follows its pane; a workspace grant is by id). */
export function grantsForScope(state: ShareHostState, scope: ShareDialogScope): ShareHostGrantView[] {
  return state.grants.filter((g) =>
    scope.kind === 'pane' ? g.scope.kind === 'pane' && g.scope.paneId === scope.paneId : g.scope.kind === 'workspace' && g.scope.workspaceId === scope.workspaceId,
  )
}

/** Workspaces with a live (not expired) workspace grant: the header button shows it. */
export function workspaceShared(state: ShareHostState, workspaceId: string): boolean {
  return state.grants.some((g) => g.scope.kind === 'workspace' && g.scope.workspaceId === workspaceId && !g.expired)
}

/** `AB12-CD34` of `AB12-CD34-EF56-7890`: enough to tell two devices apart at a glance. */
export function shortFingerprint(fp: string): string {
  return fp.split('-').slice(0, 2).join('-')
}

/** "in 3 hours" / "en 3 horas" for an expiry, from Intl in the UI language. */
export function formatUntil(at: number, now: number, lang: Language): string {
  const f = new Intl.RelativeTimeFormat(lang, { numeric: 'auto', style: 'short' })
  const min = Math.max(0, Math.round((at - now) / 60_000))
  if (min < 60) return f.format(min, 'minute')
  const h = Math.round(min / 60)
  if (h < 48) return f.format(h, 'hour')
  return f.format(Math.round(h / 24), 'day')
}

interface ShareHostStoreState {
  state: ShareHostState
  /** main answered at least once (encryption and endpoints are real). */
  loaded: boolean
  /** share:panes by pane id: the guests of each shared console (ShareHostBanner). */
  panes: Record<string, ShareHostPaneGuests>
  dialog: ShareDialogScope | null
  /** Approval ids answered here, hidden until main's next state drops them. */
  answered: string[]
  openDialog: (scope: ShareDialogScope) => void
  closeDialog: () => void
  /** Allow or Deny one join request (perm and rights: the prompt's dropdown and editor; rights only on a workspace share). */
  resolve: (requestId: string, allow: boolean, perm?: SharePerm, rights?: ShareRights) => void
}

export const useShareHostStore = create<ShareHostStoreState>((set, get) => ({
  state: EMPTY_SHARE_HOST,
  loaded: false,
  panes: {},
  dialog: null,
  answered: [],
  openDialog: (scope) => set({ dialog: scope }),
  closeDialog: () => set({ dialog: null }),
  resolve: (requestId, allow, perm, rights) => {
    if (get().answered.includes(requestId)) return
    window.snApi.share.host.resolve({ requestId, allow, ...(allow && perm ? { perm } : {}), ...(allow && rights ? { rights } : {}) })
    set((s) => ({ answered: [...s.answered, requestId] }))
  },
}))

/** Open the Share dialog on a console or a workspace (pane menu, workspace header, sidebar menu). */
export function openShareDialog(scope: ShareDialogScope): void {
  useShareHostStore.getState().openDialog(scope)
}

function applyState(state: ShareHostState): void {
  useShareHostStore.setState((s) => ({
    state,
    loaded: true,
    // Keep only the answers main still lists: a re-sent prompt with a new id shows again.
    answered: s.answered.filter((id) => state.approvals.some((a) => a.requestId === id)),
  }))
}

function applyPanes(list: ShareHostPaneGuests[]): void {
  const panes: Record<string, ShareHostPaneGuests> = {}
  for (const p of Array.isArray(list) ? list : []) if (p && typeof p.paneId === 'string' && p.guests.length > 0) panes[p.paneId] = p
  useShareHostStore.setState({ panes })
}

let wired = false

/** Wire main's share host streams and pull the first state (idempotent). */
export function initShareHostEvents(): () => void {
  const api = window.snApi?.share?.host
  if (wired || !api) return () => undefined
  wired = true
  const offState = api.onEvent((s) => applyState(s))
  const offPanes = api.onPanes((p) => applyPanes(p))
  void api
    .state()
    .then((s) => applyState(s))
    .catch(() => undefined)
  return () => {
    wired = false
    offState()
    offPanes()
  }
}

/** Push settings.share to main (it starts or stops the listener; no grant = no listener). */
export function syncShareHostConfig(cfg: Pick<ShareSettings, 'enabled' | 'port'>): void {
  window.snApi?.share?.host?.setConfig({ enabled: cfg.enabled === true, port: cfg.port })
}
