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
 *
 * App 2.7.0 (E10 B8): a team notice (routeTeam, a new "Te necesita" row or an
 * integrate result) passes the same away gate and the same coalescers, where
 * it is action-like and never held: Web Push through `pushTeam`, Discord and
 * ntfy as a custom notice of main's own words, ntfy's tap opening the team on
 * the phone (`#team=<id>[&task=<id>]`). One marked `push: false` (a desktop
 * toast only) goes nowhere.
 */
import type { ConfigFile } from '@shared/types'
import type { DeadlineTimerDeps } from '../DeadlineTimer'
import type { CustomNotice, StatusNotice, TeamNotice } from './events'
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
  /**
   * App 2.7.0 (E10 B8): Web Push of a team notice (RemoteManager.notifyTeamPush): behind the same away gate; it skips
   * devices with a visible session and checks the desktop's notifyAction on its own.
   */
  pushTeam?: (notice: TeamNotice, config: ConfigFile | null) => void
  /** App 2.7.0 (A5): clock and timers of the coalescers (tests); the real ones by default. */
  timers?: DeadlineTimerDeps
}

export interface NoticeRouter {
  route: (notice: StatusNotice) => void
  /** `snaos notify` (E8-FR-19): the same away gate; ntfy is not skipped for a watched pane (the caller asked for it). */
  routeCustom: (notice: CustomNotice) => void
  /**
   * App 2.7.0 (E10 B8): a team notice with `push`: the away gate of routeCustom, then each channel's coalescer, where
   * it is never held (action-like): Web Push (pushTeam), Discord and ntfy when they take custom notices.
   */
  routeTeam: (notice: TeamNotice) => void
}

/** 'http://h:p/#ws=<wsId>&pane=<paneId>' (both URI-encoded), or undefined without a base or workspace. */
export function deepLinkUrl(base: string | null, workspaceId: string | null, paneId: string): string | undefined {
  if (!base || !workspaceId) return undefined
  return `${base.replace(/\/+$/, '')}/#ws=${encodeURIComponent(workspaceId)}&pane=${encodeURIComponent(paneId)}`
}

/** App 2.7.0 (E10 B8): 'http://h:p/#team=<teamId>[&task=<taskId>]' (URI-encoded), or undefined without a base. */
export function teamDeepLinkUrl(base: string | null, teamId: string, taskId?: string): string | undefined {
  if (!base) return undefined
  return `${base.replace(/\/+$/, '')}/#team=${encodeURIComponent(teamId)}${taskId ? `&task=${encodeURIComponent(taskId)}` : ''}`
}

/** A team notice rather than an agent notice or a `snaos notify`. */
export function isTeamNotice(n: StatusNotice | CustomNotice | TeamNotice): n is TeamNotice {
  return (n as TeamNotice).kind === 'team'
}

/** A team notice as Discord and ntfy send a `snaos notify`: main's title and body, no console. */
function customOf(n: TeamNotice): CustomNotice {
  return { kind: 'custom', paneId: null, title: n.title, body: n.body }
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

/** What a coalescer holds: the notice and the config it was routed with (a team notice is never held). */
interface Routed {
  notice: StatusNotice | CustomNotice | TeamNotice
  config: ConfigFile | null
}

/** The held notices a summary stands for (a team notice never waits in a window, so it is never one of them). */
function heldNotices(held: readonly Routed[]): Array<StatusNotice | CustomNotice> {
  const out: Array<StatusNotice | CustomNotice> = []
  for (const r of held) if (!isTeamNotice(r.notice)) out.push(r.notice)
  return out
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
  /**
   * One coalescer per channel; its summary passes the away gate again (the user may be back at the PC). An `action`
   * and every team notice (B8: a team that needs the user is action-like) are never held.
   */
  const channel = (deliver: (r: Routed) => void, deliverSummary: (summary: StatusNotice, config: ConfigFile | null) => void) =>
    createNoticeCoalescer<Routed>({
      timers: deps.timers,
      immediate: ({ notice }) => isTeamNotice(notice) || (!isCustomNotice(notice) && notice.state === 'action'),
      deliver,
      summarize: (held) => {
        const config = deps.loadConfig()
        if (!gateOpen(config)) return
        const notices = heldNotices(held)
        if (notices.length) deliverSummary(summaryNotice(notices, config), config)
      },
    })
  const push = channel(
    ({ notice, config }) => {
      try {
        if (isTeamNotice(notice)) deps.pushTeam?.(notice, config)
        else if (!isCustomNotice(notice)) deps.push?.(notice, config)
      } catch { /* push never blocks the other channels */ }
    },
    (summary, config) => {
      try { deps.push?.(summary, config) } catch { /* idem */ }
    },
  )
  const discord = channel(
    ({ notice, config }) => {
      if (isTeamNotice(notice)) deps.discord.notifyCustom?.(customOf(notice), config)
      else if (isCustomNotice(notice)) deps.discord.notifyCustom?.(notice, config)
      else deps.discord.notify(notice, config)
    },
    (summary, config) => deps.discord.notify(summary, config),
  )
  const ntfy = channel(
    ({ notice, config }) => {
      if (isTeamNotice(notice)) {
        deps.ntfy.notifyCustom?.(customOf(notice), config, teamDeepLinkUrl(base(), notice.teamId, notice.taskId))
        return
      }
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
    routeTeam(notice) {
      if (!notice.push) return
      const config = deps.loadConfig()
      if (!gateOpen(config)) return
      if (deps.pushTeam) push.push({ notice, config })
      if (deps.discord.wantsCustom?.() ?? true) discord.push({ notice, config })
      if (!deps.ntfy.wantsCustom?.()) return
      ntfy.push({ notice, config })
    },
  }
}
