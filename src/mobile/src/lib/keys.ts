/**
 * KeyBar key definitions (E1-FR-16..21). Data only: the KeyBar renders these
 * in order and keyPress.ts decides when they fire. Kept free of React and DOM
 * so the layout and the sequences are testable in isolation.
 *
 * Layout: the mode chip is pinned left and the keyboard toggle pinned right
 * (both live in KeyBar.tsx). The scroll zone is SCROLL_KEYS_BEFORE_USER, then
 * the desktop's custom keyButtons, then SCROLL_KEYS_AFTER_USER. ^D and ^Z sit
 * last on purpose: far from where a swipe of the bar usually starts.
 */
import type { KeyButton } from '@shared/types'
import type { MobileMessageKey } from './i18n'

/** Icon slots resolved to lucide icons by the KeyBar. */
export type KeyIcon = 'left' | 'up' | 'down' | 'right' | 'backspace' | 'paste' | 'quick'

/** The terminal state a sequence may depend on (an xterm Terminal fits). */
export interface KeyTerm {
  modes: { applicationCursorKeysMode: boolean }
}

export interface KeyDef {
  id: string
  /** Visible text from i18n. */
  labelKey?: MobileMessageKey
  /** Visible literal text (^C, user keyButtons). */
  label?: string
  /** Localized aria-label; defaults to the visible label. */
  ariaKey?: MobileMessageKey
  icon?: KeyIcon
  /** Bytes for the pty; a function reads terminal modes (DECCKM arrows). */
  seq?: string | ((term: KeyTerm | null) => string)
  /** Auto-repeat while held (arrows, Bksp, Del). */
  repeat?: boolean
  /** The Ctrl latch toggle. */
  latch?: boolean
  /** One-tap Ctrl chip: sending it also releases the Ctrl latch. */
  chip?: boolean
  /** Opens a sheet instead of writing to the pty. */
  action?: 'paste' | 'quickCommands'
}

/** One-tap control chips (E1-FR-18). */
export const CTRL_CHIPS = [
  ['^C', '\x03'],
  ['^D', '\x04'],
  ['^L', '\x0c'],
  ['^R', '\x12'],
  ['^Z', '\x1a'],
] as const

/**
 * E1-FR-19: `key.ctrlEnter` keeps its id and this sequence, matching the
 * desktop's Ctrl+Enter (newline in Claude/Codex); only its label changed.
 */
export const NEWLINE_SEQ = '\x1b\r'

/** DECCKM: application cursor keys send SS3 (ESC O x), otherwise CSI (ESC [ x). */
function arrow(dir: 'A' | 'B' | 'C' | 'D'): (term: KeyTerm | null) => string {
  return (term) => (term?.modes.applicationCursorKeysMode ? `\x1bO${dir}` : `\x1b[${dir}`)
}

function chip(label: (typeof CTRL_CHIPS)[number][0], ariaKey: MobileMessageKey): KeyDef {
  const entry = CTRL_CHIPS.find(([l]) => l === label)
  return { id: `chip:${label}`, label, ariaKey, seq: entry ? entry[1] : '', chip: true }
}

export const SCROLL_KEYS_BEFORE_USER: readonly KeyDef[] = [
  { id: 'esc', labelKey: 'key.esc', seq: '\x1b' },
  chip('^C', 'key.ctrlC'),
  { id: 'tab', labelKey: 'key.tab', seq: '\t' },
  { id: 'ctrl', labelKey: 'key.ctrl', latch: true },
  { id: 'left', icon: 'left', ariaKey: 'key.left', seq: arrow('D'), repeat: true },
  { id: 'up', icon: 'up', ariaKey: 'key.up', seq: arrow('A'), repeat: true },
  { id: 'down', icon: 'down', ariaKey: 'key.down', seq: arrow('B'), repeat: true },
  { id: 'right', icon: 'right', ariaKey: 'key.right', seq: arrow('C'), repeat: true },
  { id: 'backspace', icon: 'backspace', ariaKey: 'key.backspace', seq: '\x7f', repeat: true },
  { id: 'delete', labelKey: 'key.del', ariaKey: 'key.delete', seq: '\x1b[3~', repeat: true },
  { id: 'enter', labelKey: 'key.enter', seq: '\r' },
  { id: 'shiftTab', labelKey: 'key.shiftTab', seq: '\x1b[Z' },
  { id: 'ctrlEnter', labelKey: 'key.ctrlEnter', ariaKey: 'key.ctrlEnterAria', seq: NEWLINE_SEQ },
  chip('^L', 'key.ctrlL'),
  chip('^R', 'key.ctrlR'),
]

export const SCROLL_KEYS_AFTER_USER: readonly KeyDef[] = [
  { id: 'paste', icon: 'paste', ariaKey: 'key.paste', action: 'paste' },
  // E8-FR-07: the old Snippets slot, now the Quick Commands sheet.
  { id: 'quick', icon: 'quick', ariaKey: 'key.quickCommands', action: 'quickCommands' },
  chip('^D', 'key.ctrlD'),
  chip('^Z', 'key.ctrlZ'),
]

/** The full scroll zone, with the desktop's custom keyButtons spliced in. */
export function buildScrollKeys(userButtons: readonly KeyButton[] = []): KeyDef[] {
  return [
    ...SCROLL_KEYS_BEFORE_USER,
    ...userButtons.map((b): KeyDef => ({ id: `user:${b.id}`, label: b.label, seq: b.seq })),
    ...SCROLL_KEYS_AFTER_USER,
  ]
}

/** The bytes a key writes for the current terminal, or null for non-pty keys. */
export function resolveSeq(def: KeyDef, term: KeyTerm | null): string | null {
  if (def.seq == null) return null
  return typeof def.seq === 'function' ? def.seq(term) : def.seq
}
