/**
 * Claude's answer menu as the mirrored terminal shows it (E2-FR-53, 54). The
 * card buttons beyond Allow / Deny depend on the layout of Claude's menu,
 * which changes between Claude Code versions, so the phone only offers them
 * after reading the menu off the screen and checking it against the layouts
 * it knows. pending[] still decides which request the card is about; the
 * screen only decides whether "Always allow" and the Plan card show. Any
 * menu that does not match falls back to what the phone did before: the
 * "always allow" hint, and the generic strip for a plan (E2-FR-25).
 *
 *  - The rows read are the pty screen (baseY .. baseY + rows), not the
 *    phone's scroll position, with soft-wrapped rows joined and the box
 *    border Claude may draw around a dialog stripped.
 *  - The menu is the last run of numbered rows "1. ...", "2. ..." near the
 *    bottom: at most MENU_TAIL_MAX non-empty rows (the footer hints) below
 *    its last option and at most MENU_GAP_MAX rows between two options (a
 *    long option that Ink wrapped by hand). Numbers must run 1..N.
 *  - Permission layout ("Always allow" = "2"): exactly 3 options, "1. Yes",
 *    "2. Yes, <scope>" and "3. No..." (or "Type here to tell Claude...").
 *  - Plan layout (ExitPlanMode): 2..5 options, every one an approval
 *    ("Yes, ..."), a rejection ("No, ...") or the free text row; at least one
 *    approval and one way back, and no bare "Yes" (that is a permission).
 *
 * The pure rules live in @shared/promptMenu (main reads the same menu off the
 * headless mirror); this module re-exports them and binds them to the live
 * xterm.
 */
import type { Terminal } from '@xterm/xterm'
import type { RemotePaneStatus } from '@shared/remote-protocol'
import { parseMenu, screenRowsOf, type MenuOption } from '@shared/promptMenu'

export {
  MENU_TAIL_MAX,
  MENU_GAP_MAX,
  MENU_LABEL_MAX,
  cleanRow,
  parseMenu,
  classify,
  alwaysOption,
  planOptions,
  sameOption,
  screenRowsOf,
  type MenuOption,
  type MenuClass,
  type PlanOption,
  type ScreenTerminalLike,
} from '@shared/promptMenu'

/** How often the card re-reads the screen while it needs the menu. */
export const MENU_POLL_MS = 300

/** The pty screen rows of a terminal, soft wraps joined. */
export function screenRows(term: Terminal): string[] {
  return screenRowsOf(term)
}

/** The menu on a live terminal, null when there is none or it cannot be read. */
export function readMenu(term: Terminal | null): MenuOption[] | null {
  if (!term) return null
  try {
    return parseMenu(screenRows(term))
  } catch {
    return null
  }
}

/** Where a card's menu came from: the live xterm, or main's read (RemotePaneStatus.menu). */
export type MenuSource = 'local' | 'status'

export interface SourcedMenu {
  menu: MenuOption[]
  source: MenuSource
}

/**
 * app 2.4.0: the menu main read off the headless mirror for `pendingId`
 * (RemotePaneStatus.menu), or null when it is for another request, the
 * request is gone, or the desktop sent none.
 */
export function statusMenu(status: RemotePaneStatus | undefined, pendingId: string | null): MenuOption[] | null {
  const menu = status?.menu
  if (!menu || !pendingId || menu.for !== pendingId) return null
  if (!status.pending?.some((p) => p.id === pendingId)) return null
  const options = menu.options.filter((o) => Number.isInteger(o.n) && o.n >= 1 && o.n <= 9 && typeof o.label === 'string')
  return options.length >= 2 ? options.map((o) => ({ n: o.n, label: o.label })) : null
}

/**
 * app 2.4.0 precedence of a card's menu: in Terminal the live xterm read
 * comes first; in Chat (its stream is paused, the screen may be stale), or
 * when the local read finds nothing, main's read for this request.
 * `statusOk` is false for a desktop older than 2.4.0.
 */
export function chooseMenu(local: MenuOption[] | null, inChat: boolean, status: RemotePaneStatus | undefined, pendingId: string | null, statusOk = true): SourcedMenu | null {
  if (!inChat && local) return { menu: local, source: 'local' }
  const remote = statusOk ? statusMenu(status, pendingId) : null
  return remote ? { menu: remote, source: 'status' } : null
}
