/**
 * Where a status notice goes besides the desktop (E2-FR-40..42, 52). One gate
 * for both remote channels: with "only when I am away from the PC" on, Discord
 * and ntfy publish only while the desktop is idle (180s, fixed) or locked; an
 * unknown or failing idle read delivers anyway. ntfy also stays quiet for a
 * pane a phone is watching right now (authenticated, subscribed, page visible
 * in the last 30s), and its tap opens that console through a deep link on the
 * host the phones last reached the desktop at. Native notifications never
 * pass through here. Kept free of Electron so the future `snaos notify` of the
 * CLI can reuse it and the tests run it with fakes.
 */
import type { ConfigFile } from '@shared/types'
import type { CustomNotice, StatusNotice } from './events'
import { describeNotice, describePlace } from './events'
import type { DiscordNotifier } from './DiscordNotifier'
import type { NtfyNotifier } from './NtfyNotifier'

export interface NoticeRouterDeps {
  discord: Pick<DiscordNotifier, 'notify'> & Partial<Pick<DiscordNotifier, 'notifyCustom'>>
  ntfy: Pick<NtfyNotifier, 'notify' | 'wants'> & Partial<Pick<NtfyNotifier, 'notifyCustom' | 'wantsCustom'>>
  loadConfig: () => ConfigFile | null
  /** isDesktopAway(powerMonitor): true away, false active, undefined unknown. */
  isAway: () => boolean | undefined
  /** RemoteManager.isPaneViewed (E2-FR-52). */
  isPaneViewed: (paneId: string) => boolean
  /** RemoteManager.deepLinkBase(): 'http://<host>:<port>' or null when the server is off. */
  deepLinkBase: () => string | null
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

export function createNoticeRouter(deps: NoticeRouterDeps): NoticeRouter {
  return {
    route(notice) {
      const config = deps.loadConfig()
      if (config?.settings.notifications.onlyWhenAway) {
        let away: boolean | undefined
        try { away = deps.isAway() } catch { away = undefined }
        // Only a definite "active" silences; unknown delivers (E2-FR-41).
        if (away === false) return
      }
      deps.discord.notify(notice, config)
      if (!deps.ntfy.wants(notice)) return
      let viewed = false
      try { viewed = deps.isPaneViewed(notice.paneId) } catch { viewed = false }
      if (viewed) return
      let base: string | null = null
      try { base = deps.deepLinkBase() } catch { base = null }
      const { workspaceId } = describeNotice(notice, config, '')
      deps.ntfy.notify(notice, config, deepLinkUrl(base, workspaceId, notice.paneId))
    },
    routeCustom(notice) {
      const config = deps.loadConfig()
      if (config?.settings.notifications.onlyWhenAway) {
        let away: boolean | undefined
        try { away = deps.isAway() } catch { away = undefined }
        if (away === false) return
      }
      deps.discord.notifyCustom?.(notice, config)
      if (!deps.ntfy.wantsCustom?.()) return
      let base: string | null = null
      try { base = deps.deepLinkBase() } catch { base = null }
      const { workspaceId } = describePlace(notice.paneId, config, '')
      deps.ntfy.notifyCustom?.(notice, config, notice.paneId ? deepLinkUrl(base, workspaceId, notice.paneId) : undefined)
    },
  }
}
