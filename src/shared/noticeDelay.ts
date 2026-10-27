/**
 * Delay of the remote notices (schema 20, app 2.8.0): Web Push, Discord and
 * ntfy wait `settings.notifications.remoteDelaySec` seconds and go out only if
 * the notice still stands (src/main/status/noticeDelay.ts). 0 sends at once.
 */

/** Longest delay the setting takes (one hour). */
export const NOTICE_DELAY_MAX_SEC = 3600

/** Any value as a whole number of seconds in 0..NOTICE_DELAY_MAX_SEC; junk is 0. */
export function normalizeNoticeDelay(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  return Math.min(NOTICE_DELAY_MAX_SEC, Math.max(0, Math.round(v)))
}
