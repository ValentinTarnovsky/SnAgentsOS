/**
 * Deep links from an ntfy push (E2-FR-42): http://<host>:<port>/#ws=<id>&pane=<id>.
 * A hash with `pair=` belongs to pairing, which always wins: the link is
 * ignored and the hash left for readPairCode. Otherwise the pair is taken
 * once and the hash cleared with history.replaceState (the back stack's
 * history.state is kept), so a reload never replays it. The link only picks
 * which console to show; it never triggers an action.
 */

export interface DeepLink {
  ws: string
  pane: string
}

const DEEP_LINK_RE = /^#?(?:.*&)?ws=([^&]+)&pane=([^&]+)/
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

/** The link in a location hash, or null (no link, a pairing hash, or junk). */
export function parseDeepLink(hash: string): DeepLink | null {
  if (!hash || PAIR_RE.test(hash)) return null
  const m = DEEP_LINK_RE.exec(hash)
  if (!m) return null
  const ws = decode(m[1])
  const pane = decode(m[2])
  return ws && pane ? { ws, pane } : null
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
