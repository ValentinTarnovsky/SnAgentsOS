/**
 * Where a status notice goes besides the desktop (E2-FR-40..42, 52). One gate
 * for both remote channels: with "only when I am away from the PC" on, Discord
 * and ntfy publish only while the desktop is idle (180s, fixed) or locked; an
 * unknown or failing idle read delivers anyway. ntfy also stays quiet for a
 * pane a phone is watching right now (authenticated, subscribed, page visible
 * in the last 30s), and its tap opens that console through a deep link on the
 * host the phones last reached the desktop at. Web Push to the installed PWA
 * (E3-FR-44) passes the same gate. Native notifications never
 * pass through here. Kept free of Electron so the future `snaos notify` of the
 * CLI can reuse it and the tests run it with fakes.
 *
 * App 2.7.0 (A5): after the gate and each channel's own filter, every channel
 * has its noticeCoalescer (10 s window, the first 3 at once, the rest as one
 * summary; an `action` is never held). `snaos notify` (routeCustom) goes
 * through the Discord and ntfy ones too.
 */
import type { ConfigFile } from '@shared/types'
import type { DeadlineTimerDeps } from '../DeadlineTimer'
import type { CustomNotice, StatusNotice } from './events'
import { describePlace } from './events'
import type { DiscordNotifier } from './DiscordNotifier'
import type { NtfyNotifier } from './NtfyNotifier'
import { createNoticeCoalescer, isCustomNotice, summaryNotice } from './noticeCoalescer'

export interface NoticeRouterDeps {
  discord: Pick<DiscordNotifier, 'notify'> & Partial<Pick<DiscordNotifier, 'notifyCustom' | 'wants' | 'wantsCustom'>>
  ntfy: Pick<NtfyNotifier, 'notify' | 'wants'> & Partial<Pick<NtfyNotifier, 'notifyCustom' | 'wantsCustom'>>
  loadConfig: () => ConfigFile | null
  /** isDesktopAway(powerMonitor): true away, false active, undefined unknown. */
  isAway: () => boolean | undefined
  /** RemoteManager.isPaneViewed (E2-FR-52). */
  isPaneViewed: (paneId: string) => boolean
  /** RemoteManager.deepLinkBase(): 'http://<host>:<port>' or null when the server is off. */
  deepLinkBase: () => string | null
  /**
   * Web Push to the PWA (E3-FR-44, RemoteManager.notifyPush): behind the same
   * away gate; it skips devices with a visible session on its own.
   */
  push?: (notice: StatusNotice, config: ConfigFile | null) => void
  /** App 2.7.0 (A5): clock and timers of the coalescers (tests); the real ones by default. */
  timers?: DeadlineTimerDeps
}

export interface NoticeRouter {
  route: (notice: StatusNotice) => void
  /** `snaos notify` (E8-FR-19): the same away gate; ntfy is not skipped for a watched pane (the caller asked for it). */
  routeCustom: (notice: CustomNotice) => void
}

/** 'http://h:p/#ws=<wsId>&pane=<paneId>' (both URI-encoded), or undefined without a base or workspace. */
export function deepLinkUrl(base: string | null, workspaceId: string | null, paneId: string): string | undefined {
  if (!base || !workspaceId) return undefined
  return `${base.replace(/\/+$/, '')}/#ws=${encodeURIComponent(workspaceId)}&pane=${encodeURIComponent(paneId)}`
}

/**
 * The desktop's notifyDone / notifyAction for Web Push, the same check
 * RemoteManager.notifyPush makes: a push it would drop never takes a slot of
 * the push window.
 */
function wantsPush(notice: StatusNotice, config: ConfigFile | null): boolean {
  const prefs = config?.settings?.notifications
  return !prefs || !!(notice.state === 'done' ? prefs.notifyDone : prefs.notifyAction)
}

/** What a coalescer holds: the notice and the config it was routed with. */
interface Routed {
  notice: StatusNotice | CustomNotice
  config: ConfigFile | null
}

export function createNoticeRouter(deps: NoticeRouterDeps): NoticeRouter {
  /** False only for a definite "active" with "only when away" on; unknown delivers (E2-FR-41). */
  const gateOpen = (config: ConfigFile | null): boolean => {
    if (!config?.settings.notifications.onlyWhenAway) return true
    let away: boolean | undefined
    try { away = deps.isAway() } catch { away = undefined }
    return away !== false
  }
  const base = (): string | null => {
    try { return deps.deepLinkBase() } catch { return null }
  }
  /** One coalescer per channel; its summary passes the away gate again (the user may be back at the PC). */
  const channel = (deliver: (r: Routed) => void, deliverSummary: (summary: StatusNotice, config: ConfigFile | null) => void) =>
    createNoticeCoalescer<Routed>({
      timers: deps.timers,
      immediate: ({ notice }) => !isCustomNotice(notice) && notice.state === 'action',
      deliver,
      summarize: (held) => {
        const config = deps.loadConfig()
        if (!gateOpen(config)) return
        deliverSummary(summaryNotice(held.map((r) => r.notice), config), config)
      },
    })
  const push = channel(
    ({ notice, config }) => {
      if (isCustomNotice(notice)) return
      try { deps.push?.(notice, config) } catch { /* push never blocks the other channels */ }
    },
    (summary, config) => {
      try { deps.push?.(summary, config) } catch { /* idem */ }
    },
  )
  const discord = channel(
    ({ notice, config }) => {
      if (isCustomNotice(notice)) deps.discord.notifyCustom?.(notice, config)
      else deps.discord.notify(notice, config)
    },
    (summary, config) => deps.discord.notify(summary, config),
  )
  const ntfy = channel(
    ({ notice, config }) => {
      const { workspaceId } = describePlace(notice.paneId, config, '')
      if (isCustomNotice(notice)) deps.ntfy.notifyCustom?.(notice, config, notice.paneId ? deepLinkUrl(base(), workspaceId, notice.paneId) : undefined)
      else deps.ntfy.notify(notice, config, deepLinkUrl(base(), workspaceId, notice.paneId))
    },
    // The summary's tap opens the app (no single console to open).
    (summary, config) => {
      const root = base()
      deps.ntfy.notify(summary, config, root ? `${root.replace(/\/+$/, '')}/` : undefined)
    },
  )

  return {
    route(notice) {
      const config = deps.loadConfig()
      if (!gateOpen(config)) return
      if (deps.push && wantsPush(notice, config)) push.push({ notice, config })
      if (deps.discord.wants?.(notice) ?? true) discord.push({ notice, config })
      if (!deps.ntfy.wants(notice)) return
      let viewed = false
      try { viewed = deps.isPaneViewed(notice.paneId) } catch { viewed = false }
      if (viewed) return
      ntfy.push({ notice, config })
    },
    routeCustom(notice) {
      const config = deps.loadConfig()
      if (!gateOpen(config)) return
      if (deps.discord.wantsCustom?.() ?? true) discord.push({ notice, config })
      if (!deps.ntfy.wantsCustom?.()) return
      ntfy.push({ notice, config })
    },
  }
}
