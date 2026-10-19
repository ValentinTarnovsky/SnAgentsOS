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
 * Pure functions over rows so the rules run in node; readMenu binds them to
 * the live xterm.
 */
import type { Terminal } from '@xterm/xterm'

/** Non-empty rows allowed below the last option (Claude's footer hints). */
export const MENU_TAIL_MAX = 4
/** Rows allowed between two options (an option Ink wrapped onto more rows). */
export const MENU_GAP_MAX = 2
/** Longest option label kept. */
export const MENU_LABEL_MAX = 160
/** How often the card re-reads the screen while it needs the menu. */
export const MENU_POLL_MS = 300

export interface MenuOption {
  /** The digit that picks it. */
  n: number
  /** Its text, whitespace collapsed, trailing key hint dropped. */
  label: string
}

export type MenuClass = 'yes' | 'approve' | 'reject' | 'feedback'

export interface PlanOption extends MenuOption {
  cls: Exclude<MenuClass, 'yes'>
}

/** "1. Yes" with an optional selection pointer in front. */
const OPTION_RE = /^(?:[❯›>▸▶]\s*)?([1-9])\.\s+(\S.*)$/
/** Box drawing borders and padding around a dialog row. */
const EDGE_LEFT_RE = /^[\s│┃║|]+/
const EDGE_RIGHT_RE = /[\s│┃║|]+$/
/** A trailing key hint such as "(shift+tab)" or "(esc)". */
const KEY_HINT_RE = /\s*\((?:shift\+tab|esc|tab|enter|(?:ctrl|alt|meta|shift)\+[\w-]+)\)\s*$/i
/** C0 / C1 controls that must never reach a label. */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g

export function cleanRow(row: string): string {
  return row.replace(CONTROL_RE, ' ').replace(EDGE_LEFT_RE, '').replace(EDGE_RIGHT_RE, '')
}

function cleanLabel(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(KEY_HINT_RE, '').trim().slice(0, MENU_LABEL_MAX)
}

/** The numbered menu at the bottom of these screen rows, or null. */
export function parseMenu(rows: readonly string[]): MenuOption[] | null {
  const lines = rows.map(cleanRow)
  let last = -1
  let tail = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    if (OPTION_RE.test(lines[i])) {
      last = i
      break
    }
    if (lines[i] && ++tail > MENU_TAIL_MAX) return null
  }
  if (last < 0) return null
  const options: MenuOption[] = []
  let gap: string[] = []
  let expect = Number(OPTION_RE.exec(lines[last])![1])
  for (let i = last; i >= 0; i--) {
    const m = OPTION_RE.exec(lines[i])
    if (!m) {
      if (gap.length >= MENU_GAP_MAX) return null
      gap.unshift(lines[i])
      continue
    }
    if (Number(m[1]) !== expect) return null
    // Rows between this option and the next one are its wrapped tail.
    const text = options.length > 0 ? [m[2], ...gap].join(' ') : m[2]
    options.unshift({ n: expect, label: cleanLabel(text) })
    gap = []
    if (expect === 1) break
    expect--
  }
  if (options.length < 2 || options[0].n !== 1) return null
  return options
}

export function classify(label: string): MenuClass | null {
  if (/^yes\.?$/i.test(label)) return 'yes'
  if (/^yes\b/i.test(label)) return 'approve'
  if (/^no\b/i.test(label)) return 'reject'
  if (/^(?:type here|tell claude)\b/i.test(label)) return 'feedback'
  return null
}

/** Option 2 of a validated permission menu ("Always allow"), or null (E2-FR-53). */
export function alwaysOption(menu: readonly MenuOption[] | null): MenuOption | null {
  if (!menu || menu.length !== 3) return null
  const [a, b, c] = menu.map((o) => classify(o.label))
  if (a !== 'yes' || b !== 'approve' || (c !== 'reject' && c !== 'feedback')) return null
  return menu[1]
}

/** The options of a validated plan menu, or null (E2-FR-54). */
export function planOptions(menu: readonly MenuOption[] | null): PlanOption[] | null {
  if (!menu || menu.length < 2 || menu.length > 5) return null
  const out: PlanOption[] = []
  for (const option of menu) {
    const cls = classify(option.label)
    if (!cls || cls === 'yes') return null
    out.push({ ...option, cls })
  }
  if (!out.some((o) => o.cls === 'approve') || !out.some((o) => o.cls !== 'approve')) return null
  return out
}

/** The pty screen rows of a terminal, soft wraps joined. */
export function screenRows(term: Terminal): string[] {
  const buf = term.buffer.active
  const rows: string[] = []
  const end = Math.min(buf.length, buf.baseY + term.rows)
  for (let y = buf.baseY; y < end; y++) {
    const line = buf.getLine(y)
    if (!line) continue
    const text = line.translateToString(true)
    if (line.isWrapped && rows.length > 0) rows[rows.length - 1] += text
    else rows.push(text)
  }
  return rows
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

/** Two reads show the same option under the same digit (checked again at tap time). */
export function sameOption(menu: readonly MenuOption[] | null, option: MenuOption): boolean {
  return !!menu?.some((o) => o.n === option.n && o.label === option.label)
}
