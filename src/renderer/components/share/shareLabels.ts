import type { ShareLinkEndReason, ShareLinkStatus, ShareLinkView, SharePreviewError } from '@shared/share-guest'
import type { SharePerm, ShareScopeKind } from '@shared/share-protocol'
import type { MessageKey, TFn } from '@/i18n'
import type { ShareNoticeReason } from '@/lib/shareGuestStore'

/** i18n keys of every guest-side share state (app 2.4.0, item 8, S3). */
export const PERM_KEY: Record<SharePerm, MessageKey> = {
  view: 'shareGuest.perm.view',
  type: 'shareGuest.perm.type',
  full: 'shareGuest.perm.full',
}

export const SCOPE_KEY: Record<ShareScopeKind, MessageKey> = {
  pane: 'shareGuest.scope.pane',
  workspace: 'shareGuest.scope.workspace',
}

export const STATUS_KEY: Record<ShareLinkStatus, MessageKey> = {
  idle: 'shareGuest.status.idle',
  connecting: 'shareGuest.status.connecting',
  waiting_approval: 'shareGuest.status.waiting_approval',
  password_required: 'shareGuest.status.password_required',
  connected: 'shareGuest.status.connected',
  paused: 'shareGuest.status.paused',
  reconnecting: 'shareGuest.status.reconnecting',
  ended: 'shareGuest.status.ended',
}

export const END_KEY: Record<ShareLinkEndReason, MessageKey> = {
  revoked: 'shareGuest.end.revoked',
  kicked: 'shareGuest.end.kicked',
  expired: 'shareGuest.end.expired',
  scope_gone: 'shareGuest.end.scope_gone',
  host_quit: 'shareGuest.end.host_quit',
  sharing_off: 'shareGuest.end.sharing_off',
  denied: 'shareGuest.end.denied',
  timeout: 'shareGuest.end.timeout',
  locked: 'shareGuest.end.locked',
  busy: 'shareGuest.end.busy',
  limit: 'shareGuest.end.limit',
  bad_invite: 'shareGuest.end.bad_invite',
  version: 'shareGuest.end.version',
  identity_mismatch: 'shareGuest.end.identity_mismatch',
  protocol: 'shareGuest.end.protocol',
}

export const DENY_KEY: Record<ShareNoticeReason, MessageKey> = {
  view_only: 'shareGuest.deny.view_only',
  no_send: 'shareGuest.deny.no_send',
  interrupt: 'shareGuest.deny.interrupt',
  blocked_key: 'shareGuest.deny.blocked_key',
  awaiting_host: 'shareGuest.deny.awaiting_host',
  not_precise: 'shareGuest.deny.not_precise',
  agent_busy: 'shareGuest.deny.agent_busy',
  ssh_escape: 'shareGuest.deny.ssh_escape',
  host_typing: 'shareGuest.deny.host_typing',
  other_typing: 'shareGuest.deny.other_typing',
  paused: 'shareGuest.deny.paused',
  rate: 'shareGuest.deny.rate',
  out_of_scope: 'shareGuest.deny.out_of_scope',
  paste_too_large: 'shareGuest.deny.paste_too_large',
  paste_incomplete: 'shareGuest.deny.paste_incomplete',
  offline: 'shareGuest.deny.offline',
}

export const JOIN_ERR_KEY: Record<SharePreviewError | 'limit' | 'unavailable', MessageKey> = {
  format: 'shareGuest.join.err.format',
  version: 'shareGuest.join.err.version',
  too_long: 'shareGuest.join.err.too_long',
  bad_key: 'shareGuest.join.err.bad_key',
  endpoint: 'shareGuest.join.err.endpoint',
  self: 'shareGuest.join.err.self',
  limit: 'shareGuest.join.err.limit',
  unavailable: 'shareGuest.join.err.unavailable',
}

/** One line for a link's state: the end reason when it ended or is retrying, else the status. */
export function linkStatusText(link: ShareLinkView, t: TFn): string {
  if ((link.status === 'ended' || link.status === 'reconnecting') && link.reason) {
    const why = t(END_KEY[link.reason])
    return link.status === 'ended' ? why : `${t(STATUS_KEY.reconnecting)} ${why}`
  }
  return t(STATUS_KEY[link.status])
}

/**
 * Dot class of a link's state (state tokens: color is a state, never decoration).
 * The text of linkStatusText goes with it as aria-label.
 */
export function linkDotClass(link: ShareLinkView): string {
  switch (link.status) {
    case 'connected':
      return 'bg-state-done'
    case 'paused':
    case 'waiting_approval':
    case 'password_required':
      return 'bg-state-action ring-2 ring-state-action/30'
    case 'connecting':
    case 'reconnecting':
      return 'bg-state-working animate-pulse motion-reduce:animate-none'
    case 'ended':
      return link.reason === 'host_quit' || link.reason === 'sharing_off' ? 'bg-state-idle' : 'bg-state-error'
    default:
      return 'bg-transparent ring-1 ring-text-secondary'
  }
}
