/**
 * KeyBar key definitions (E1-FR-16..21). Data only: the KeyBar renders these
 * in order and keyPress.ts decides when they fire. Kept free of React and DOM
 * so the layout and the sequences are testable in isolation.
 *
 * Layout: the mode chip is pinned left and the keyboard toggle pinned right
 * (both live in KeyBar.tsx). The scroll zone is SCROLL_KEYS_BEFORE_USER, then
 * the desktop's custom keyButtons, then SCROLL_KEYS_AFTER_USER. ^D and ^Z sit
 * last on purpose: far from where a swipe of the bar usually starts.
 *
 * KeyBar part 2 (E2-FR-45, 46): that order is now only the canonical default.
 * The user's layout (`snagentsos.keybar`, persisted by keyLayout.ts) reorders
 * and hides keys and adds custom ones; normalizeLayout() reconciles a stored
 * layout with the keys that exist today. Ids: the built-ins below,
 * `desk:<id>` for the desktop's keyButtons and `cust:<id>` for the phone's
 * own keys. The modifier byte table follows the xterm control sequence
 * reference (PC-Style Function Keys) and xterm.js's keyboard handling; Orca's
 * terminal-accessory-layout.ts and terminal-key-definitions.ts were only a
 * reference for the cases to cover (no code taken).
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
    ...userButtons.map(deskKeyDef),
    ...SCROLL_KEYS_AFTER_USER,
  ]
}

/** The bytes a key writes for the current terminal, or null for non-pty keys. */
export function resolveSeq(def: KeyDef, term: KeyTerm | null): string | null {
  if (def.seq == null) return null
  return typeof def.seq === 'function' ? def.seq(term) : def.seq
}

// --- KeyBar part 2: custom keys (E2-FR-46) ---

export const DESK_PREFIX = 'desk:'
export const CUSTOM_PREFIX = 'cust:'
export const MAX_CUSTOM_KEYS = 24
export const MAX_CUSTOM_LABEL = 8
/** A Text key is a short literal, not a paste (the composer handles those). */
export const MAX_CUSTOM_TEXT = 256

export type NamedKey =
  | 'enter'
  | 'tab'
  | 'esc'
  | 'backspace'
  | 'delete'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'home'
  | 'end'
  | 'pageUp'
  | 'pageDown'
  | 'space'

export const NAMED_KEYS: readonly NamedKey[] = [
  'enter',
  'tab',
  'esc',
  'backspace',
  'delete',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageUp',
  'pageDown',
  'space',
]
export const LETTER_KEYS: readonly string[] = 'abcdefghijklmnopqrstuvwxyz'.split('')
export const DIGIT_KEYS: readonly string[] = '0123456789'.split('')
export const FUNCTION_KEYS: readonly string[] = Array.from({ length: 12 }, (_v, i) => `f${i + 1}`)

/** A key the "Key" mode can press: a letter, a digit, a named key or F1-F12. */
export function isKeyName(key: unknown): key is string {
  return (
    typeof key === 'string' &&
    (LETTER_KEYS.includes(key) ||
      DIGIT_KEYS.includes(key) ||
      FUNCTION_KEYS.includes(key) ||
      (NAMED_KEYS as readonly string[]).includes(key))
  )
}

export interface KeyMods {
  ctrl: boolean
  alt: boolean
  shift: boolean
}

/** What a custom key sends: a key with modifiers, or a literal text. */
export type CustomKeySpec = ({ mode: 'key'; key: string } & KeyMods) | { mode: 'text'; text: string; enter: boolean }

export type CustomKey = CustomKeySpec & { id: string; label: string }

/** The xterm modifier parameter: 1 + shift + 2*alt + 4*ctrl. */
export function modifierParam(mods: KeyMods): number {
  return 1 + (mods.shift ? 1 : 0) + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0)
}

/** Final byte of the CSI 1 ; m X keys (SS3 X when unmodified under DECCKM). */
const CSI_FINAL: Record<string, string> = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' }
/** The CSI n ~ keys. */
const TILDE_CODE: Record<string, number> = { delete: 3, pageUp: 5, pageDown: 6 }
const F1_F4_FINAL = ['P', 'Q', 'R', 'S']
const F5_F12_CODE = [15, 17, 18, 19, 20, 21, 23, 24]
/** xterm's legacy Ctrl+digit codes; the other digits pass through unchanged. */
const CTRL_DIGIT: Record<string, string> = {
  '2': '\x00',
  '3': '\x1b',
  '4': '\x1c',
  '5': '\x1d',
  '6': '\x1e',
  '7': '\x1f',
  '8': '\x7f',
}

/**
 * Bytes for one key with modifiers, or null when the combination has no
 * sequence of its own (Ctrl+Enter: the Text mode covers it). `appCursor` is
 * DECCKM: unmodified arrows, Home and End then use SS3, like the built-ins.
 */
export function keySeq(key: string, mods: KeyMods, appCursor = false): string | null {
  if (!isKeyName(key)) return null
  const m = modifierParam(mods)
  const final = CSI_FINAL[key]
  if (final) {
    if (m > 1) return `\x1b[1;${m}${final}`
    return appCursor ? `\x1bO${final}` : `\x1b[${final}`
  }
  const tilde = TILDE_CODE[key]
  if (tilde != null) return m > 1 ? `\x1b[${tilde};${m}~` : `\x1b[${tilde}~`
  if (FUNCTION_KEYS.includes(key)) {
    const n = Number(key.slice(1))
    if (n <= 4) {
      const f = F1_F4_FINAL[n - 1]
      return m > 1 ? `\x1b[1;${m}${f}` : `\x1bO${f}`
    }
    const code = F5_F12_CODE[n - 5]
    return m > 1 ? `\x1b[${code};${m}~` : `\x1b[${code}~`
  }
  const meta = (s: string): string => (mods.alt ? `\x1b${s}` : s)
  if (key === 'enter') return mods.ctrl ? null : meta('\r')
  if (key === 'tab') return meta(mods.shift ? '\x1b[Z' : '\t')
  if (key === 'esc') return meta('\x1b')
  if (key === 'backspace') return meta(mods.ctrl ? '\x08' : '\x7f')
  if (key === 'space') return meta(mods.ctrl ? '\x00' : ' ')
  if (DIGIT_KEYS.includes(key)) return meta(mods.ctrl ? (CTRL_DIGIT[key] ?? key) : key)
  // A letter. Ctrl wins over Shift: a terminal cannot tell Ctrl+Shift+A apart.
  const upper = key.toUpperCase()
  if (mods.ctrl) return meta(String.fromCharCode(upper.charCodeAt(0) & 0x1f))
  return meta(mods.shift ? upper : key)
}

/** Bytes a custom key writes, or null when it has nothing to send. */
export function customKeySeq(key: CustomKeySpec, appCursor = false): string | null {
  if (key.mode === 'text') {
    const seq = key.text + (key.enter ? '\r' : '')
    return seq.length > 0 ? seq : null
  }
  return keySeq(key.key, key, appCursor)
}

const ESCAPES: Record<string, string> = { '\r': '\\r', '\n': '\\n', '\t': '\\t', '\\': '\\\\' }

/** Printable preview of a byte sequence: ESC [ 1 ; 5 C reads `\x1b[1;5C`. */
export function escapeSeq(seq: string): string {
  let out = ''
  for (const ch of seq) {
    const code = ch.charCodeAt(0)
    if (ESCAPES[ch]) out += ESCAPES[ch]
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`
    else out += ch
  }
  return out
}

/** A stored custom key, or null when it is malformed or sends nothing. */
export function parseCustomKey(raw: unknown): CustomKey | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id.startsWith(CUSTOM_PREFIX) || r.id.length <= CUSTOM_PREFIX.length) return null
  if (typeof r.label !== 'string') return null
  const label = r.label.trim()
  if (label.length === 0 || [...label].length > MAX_CUSTOM_LABEL) return null
  let key: CustomKey
  if (r.mode === 'key') {
    if (!isKeyName(r.key)) return null
    key = { id: r.id, label, mode: 'key', key: r.key, ctrl: r.ctrl === true, alt: r.alt === true, shift: r.shift === true }
  } else if (r.mode === 'text') {
    if (typeof r.text !== 'string' || r.text.length > MAX_CUSTOM_TEXT) return null
    key = { id: r.id, label, mode: 'text', text: r.text, enter: r.enter === true }
  } else {
    return null
  }
  return customKeySeq(key) == null ? null : key
}

/** A fresh `cust:` id. Not crypto.randomUUID: that needs a secure context. */
export function newCustomKeyId(taken: Iterable<string> = []): string {
  const used = new Set(taken)
  for (;;) {
    const id = `${CUSTOM_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    if (!used.has(id)) return id
  }
}

// --- KeyBar part 2: layout (E2-FR-45) ---

export const KEY_LAYOUT_VERSION = 1

/** `snagentsos.keybar`: the scroll zone's order, what shows and the custom keys. */
export interface KeyLayout {
  version: typeof KEY_LAYOUT_VERSION
  orderedIds: string[]
  visibleIds: string[]
  custom: CustomKey[]
}

const BUILT_IN_KEYS: readonly KeyDef[] = [...SCROLL_KEYS_BEFORE_USER, ...SCROLL_KEYS_AFTER_USER]
export const BUILT_IN_IDS: readonly string[] = BUILT_IN_KEYS.map((k) => k.id)

export function deskKeyDef(b: KeyButton): KeyDef {
  return { id: `${DESK_PREFIX}${b.id}`, label: b.label, seq: b.seq }
}

export function customKeyDef(key: CustomKey): KeyDef {
  return {
    id: key.id,
    label: key.label,
    seq: (term) => customKeySeq(key, term?.modes.applicationCursorKeysMode === true) ?? '',
  }
}

function deskIds(deskButtons: readonly KeyButton[]): string[] {
  return [...new Set(deskButtons.map((b) => `${DESK_PREFIX}${b.id}`))]
}

/** The default order: built-ins with the desktop keys spliced in, then custom keys. */
export function canonicalOrder(deskButtons: readonly KeyButton[], custom: readonly CustomKey[] = []): string[] {
  return [
    ...SCROLL_KEYS_BEFORE_USER.map((k) => k.id),
    ...deskIds(deskButtons),
    ...SCROLL_KEYS_AFTER_USER.map((k) => k.id),
    ...custom.map((k) => k.id),
  ]
}

export function defaultLayout(deskButtons: readonly KeyButton[], custom: readonly CustomKey[] = []): KeyLayout {
  const order = canonicalOrder(deskButtons, custom)
  return { version: KEY_LAYOUT_VERSION, orderedIds: order, visibleIds: [...order], custom: [...custom] }
}

/**
 * Insert every canonical id missing from orderedIds next to its canonical
 * neighbour: right after the nearest earlier canonical id already placed,
 * else right before the nearest later one, else at the end. Inserted ids come
 * in visible, so a key added by a future release (or a new desktop key) shows
 * up beside its neighbour. Hidden ids stay in orderedIds, so they are never
 * mistaken for new ones.
 */
export function insertMissingBuiltInIds(
  layout: { orderedIds: readonly string[]; visibleIds: readonly string[] },
  canonical: readonly string[],
): { orderedIds: string[]; visibleIds: string[] } {
  const ordered = [...layout.orderedIds]
  const visible = new Set(layout.visibleIds)
  canonical.forEach((id, i) => {
    if (ordered.includes(id)) return
    let at = -1
    for (let j = i - 1; j >= 0 && at < 0; j--) {
      const k = ordered.indexOf(canonical[j])
      if (k >= 0) at = k + 1
    }
    for (let j = i + 1; j < canonical.length && at < 0; j++) {
      const k = ordered.indexOf(canonical[j])
      if (k >= 0) at = k
    }
    if (at < 0) at = ordered.length
    ordered.splice(at, 0, id)
    visible.add(id)
  })
  return { orderedIds: ordered, visibleIds: ordered.filter((id) => visible.has(id)) }
}

/**
 * Reconcile a stored layout with today's keys. Anything that is not a valid
 * version-1 layout falls back to the default. Unknown ids are dropped
 * (including a `desk:` key the desktop no longer sends), a duplicate keeps its
 * first place, custom keys are validated and capped at MAX_CUSTOM_KEYS, and
 * missing ids are inserted by insertMissingBuiltInIds.
 */
export function normalizeLayout(raw: unknown, deskButtons: readonly KeyButton[] = []): KeyLayout {
  if (!raw || typeof raw !== 'object') return defaultLayout(deskButtons)
  const r = raw as Record<string, unknown>
  if (r.version !== KEY_LAYOUT_VERSION) return defaultLayout(deskButtons)
  const custom: CustomKey[] = []
  for (const item of Array.isArray(r.custom) ? r.custom : []) {
    const key = parseCustomKey(item)
    if (key && custom.length < MAX_CUSTOM_KEYS && !custom.some((c) => c.id === key.id)) custom.push(key)
  }
  const canonical = canonicalOrder(deskButtons, custom)
  const known = new Set(canonical)
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const ordered = [...new Set(strings(r.orderedIds).filter((id) => known.has(id)))]
  const placed = new Set(ordered)
  const visible = strings(r.visibleIds).filter((id) => placed.has(id))
  const merged = insertMissingBuiltInIds({ orderedIds: ordered, visibleIds: visible }, canonical)
  return { version: KEY_LAYOUT_VERSION, orderedIds: merged.orderedIds, visibleIds: merged.visibleIds, custom }
}

/** Every key of the layout in its order, hidden ones included (the settings list). */
export function layoutKeyDefs(layout: KeyLayout, deskButtons: readonly KeyButton[] = []): KeyDef[] {
  const defs = new Map<string, KeyDef>()
  for (const k of BUILT_IN_KEYS) defs.set(k.id, k)
  for (const b of deskButtons) {
    const def = deskKeyDef(b)
    if (!defs.has(def.id)) defs.set(def.id, def)
  }
  for (const c of layout.custom) defs.set(c.id, customKeyDef(c))
  return layout.orderedIds.map((id) => defs.get(id)).filter((d): d is KeyDef => d != null)
}

/** What the KeyBar's scroll zone renders: the visible keys, in order. */
export function visibleKeyDefs(layout: KeyLayout, deskButtons: readonly KeyButton[] = []): KeyDef[] {
  const visible = new Set(layout.visibleIds)
  return layoutKeyDefs(layout, deskButtons).filter((d) => visible.has(d.id))
}

/** Move a key one slot up (-1) or down (+1); a no-op at either end. */
export function moveKey(layout: KeyLayout, id: string, delta: -1 | 1): KeyLayout {
  const i = layout.orderedIds.indexOf(id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= layout.orderedIds.length) return layout
  const ordered = [...layout.orderedIds]
  ordered[i] = ordered[j]
  ordered[j] = id
  const visible = new Set(layout.visibleIds)
  return { ...layout, orderedIds: ordered, visibleIds: ordered.filter((k) => visible.has(k)) }
}

export function setKeyVisible(layout: KeyLayout, id: string, show: boolean): KeyLayout {
  if (!layout.orderedIds.includes(id)) return layout
  const visible = new Set(layout.visibleIds)
  if (show) visible.add(id)
  else visible.delete(id)
  return { ...layout, visibleIds: layout.orderedIds.filter((k) => visible.has(k)) }
}

/**
 * Save a custom key: an edit keeps its place and visibility, a new key goes
 * to the end, visible. Null when the key is invalid or a new key would pass
 * MAX_CUSTOM_KEYS.
 */
export function upsertCustomKey(layout: KeyLayout, key: CustomKey): KeyLayout | null {
  const valid = parseCustomKey(key)
  if (!valid) return null
  const i = layout.custom.findIndex((c) => c.id === valid.id)
  if (i >= 0) {
    const custom = [...layout.custom]
    custom[i] = valid
    return { ...layout, custom }
  }
  if (layout.custom.length >= MAX_CUSTOM_KEYS) return null
  return {
    ...layout,
    custom: [...layout.custom, valid],
    orderedIds: [...layout.orderedIds, valid.id],
    visibleIds: [...layout.visibleIds, valid.id],
  }
}

export function removeCustomKey(layout: KeyLayout, id: string): KeyLayout {
  return {
    ...layout,
    custom: layout.custom.filter((c) => c.id !== id),
    orderedIds: layout.orderedIds.filter((k) => k !== id),
    visibleIds: layout.visibleIds.filter((k) => k !== id),
  }
}

/** [Restablecer]: the default order with every key visible; custom keys are kept, at the end. */
export function resetLayout(layout: KeyLayout, deskButtons: readonly KeyButton[] = []): KeyLayout {
  return defaultLayout(deskButtons, layout.custom)
}

/** Short glyph per named key, for a suggested label. */
const KEY_GLYPH: Record<string, string> = {
  enter: 'Ent',
  tab: 'Tab',
  esc: 'Esc',
  backspace: 'Bksp',
  delete: 'Del',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  home: 'Home',
  end: 'End',
  pageUp: 'PgUp',
  pageDown: 'PgDn',
  space: 'Spc',
}

/**
 * The label a key gets when the user leaves it blank: `^C` for Ctrl+letter, a
 * letter in the case it sends (x, X, A-x), otherwise C-/A-/S- prefixes and
 * the key's short name (C-→, S-Tab, F5); a Text key takes its first
 * characters. Capped at MAX_CUSTOM_LABEL.
 */
export function suggestLabel(key: CustomKeySpec): string {
  let label: string
  if (key.mode === 'text') {
    label = key.text.replace(/\s+/g, ' ').trim()
  } else if (LETTER_KEYS.includes(key.key)) {
    const upper = key.key.toUpperCase()
    if (key.ctrl) label = `${key.alt ? 'A-' : ''}^${upper}`
    else label = `${key.alt ? 'A-' : ''}${key.shift ? upper : key.key}`
  } else {
    const name = KEY_GLYPH[key.key] ?? key.key.toUpperCase()
    label = `${key.ctrl ? 'C-' : ''}${key.alt ? 'A-' : ''}${key.shift ? 'S-' : ''}${name}`
  }
  return [...label].slice(0, MAX_CUSTOM_LABEL).join('')
}
