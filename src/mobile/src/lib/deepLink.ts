/**
 * Deep links from a push (E2-FR-42): http://<host>:<port>/#ws=<id>&pane=<id>
 * picks a console; app 2.7.0 (E10 B8) adds #team=<id>[&task=<id>], which
 * opens that team's board (and the task over it). A hash with `pair=` belongs
 * to pairing, which always wins: the link is ignored and the hash left for
 * readPairCode. The pane form is tried first. Otherwise the link is taken
 * once and the hash cleared with history.replaceState (the back stack's
 * history.state is kept), so a reload never replays it. A link only picks
 * which screen to show; it never triggers an action.
 */

export interface PaneDeepLink {
  ws: string
  pane: string
}

/** app 2.7.0: a team push (`#team=tm-<12 hex>[&task=t-<n>]`, the ids of src/shared/teams.ts). */
export interface TeamDeepLink {
  team: string
  task?: string
}

export type DeepLink = PaneDeepLink | TeamDeepLink

export function isTeamLink(link: DeepLink | null | undefined): link is TeamDeepLink {
  return !!link && 'team' in link
}

const DEEP_LINK_RE = /^#?(?:.*&)?ws=([^&]+)&pane=([^&]+)/
const TEAM_LINK_RE = /^#?(?:.*&)?team=(tm-[a-f0-9]{12})(?:&task=(t-[0-9]{1,5}))?(?:&|$)/
const PAIR_RE = /(?:^#?|&)pair=/
/** Ids the desktop mints are short; anything longer is not ours. */
const MAX_ID = 128

function decode(part: string): string | null {
  try {
    const v = decodeURIComponent(part)
    return v.length > 0 && v.length <= MAX_ID ? v : null
  } catch {
    return null
  }
}

function paneLink(hash: string): PaneDeepLink | null {
  const m = DEEP_LINK_RE.exec(hash)
  if (!m) return null
  const ws = decode(m[1])
  const pane = decode(m[2])
  return ws && pane ? { ws, pane } : null
}

/** The link in a location hash, or null (no link, a pairing hash, or junk). */
export function parseDeepLink(hash: string): DeepLink | null {
  if (!hash || PAIR_RE.test(hash)) return null
  const pane = paneLink(hash)
  if (pane) return pane
  const t = TEAM_LINK_RE.exec(hash)
  if (!t) return null
  return t[2] ? { team: t[1], task: t[2] } : { team: t[1] }
}

/** Read the link from the current URL and clear the hash; null when there is none. */
export function takePendingDeepLink(): DeepLink | null {
  let hash = ''
  try {
    hash = location.hash
  } catch {
    return null
  }
  const link = parseDeepLink(hash)
  if (!link) return null
  try {
    history.replaceState(history.state, '', `${location.pathname}${location.search}`)
  } catch {
    /* replaceState blocked: the link was taken anyway */
  }
  return link
}
