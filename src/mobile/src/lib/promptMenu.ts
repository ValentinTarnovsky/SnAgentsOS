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
