import type { MessageKey } from '@/i18n'

/** Remappable in-app actions (terminal-intrinsic keys like copy/paste are fixed). */
export type ActionId =
  | 'palette'
  | 'workspaceFlip'
  | 'workspaceNext'
  | 'workspacePrev'
  | 'newWorkspace'
  | 'newConsole'
  | 'globalPrompt'
  | 'openSettings'
  | 'toggleSidebar'
  | 'maximizePane'
  | 'minimizePane'
  | 'redrawPane'
  // Agent navigation (E5-FR-17/18, CONTRATOS "Atajos" per D8).
  | 'nextWaiting'
  | 'reopenClosedPane'
  | 'focusNextPane'
  | 'focusPrevPane'
  // Quick Commands popover (E8-FR-04).
  | 'quickCommands'
  // Changes panel (E7-FR-11; CONTRATOS "Atajos": toggleChanges, Ctrl+Shift+G is globalPrompt).
  | 'toggleChanges'
  // Agents board (E5-FR-27; D8 amendment for v3.0).
  | 'agentsBoard'
  // Prompt navigation (E6-FR-27; Ctrl+Shift+PageUp/PageDown left free by D8).
  | 'promptPrev'
  | 'promptNext'
  // Files and Notes drawers (v2.2, E9).
  | 'toggleFiles'
  | 'toggleNotes'
  // Desktop dictation (app 2.4.0): toggles on the focused console (or the open global prompt).
  | 'dictate'

export interface KeyAction {
  id: ActionId
  labelKey: MessageKey
  /** Default accelerator; chosen to avoid clobbering common shell control keys. */
  defaultAccel: string
}

export const KEY_ACTIONS: KeyAction[] = [
  { id: 'palette', labelKey: 'keys.palette', defaultAccel: 'Ctrl+K' },
  { id: 'workspaceFlip', labelKey: 'keys.workspaceFlip', defaultAccel: 'Ctrl+Tab' },
  { id: 'workspaceNext', labelKey: 'keys.workspaceNext', defaultAccel: 'Ctrl+PageDown' },
  { id: 'workspacePrev', labelKey: 'keys.workspacePrev', defaultAccel: 'Ctrl+PageUp' },
  { id: 'newWorkspace', labelKey: 'keys.newWorkspace', defaultAccel: 'Ctrl+Shift+N' },
  { id: 'newConsole', labelKey: 'keys.newConsole', defaultAccel: 'Ctrl+Shift+T' },
  { id: 'globalPrompt', labelKey: 'keys.globalPrompt', defaultAccel: 'Ctrl+Shift+G' },
  { id: 'openSettings', labelKey: 'keys.openSettings', defaultAccel: 'Ctrl+,' },
  { id: 'toggleSidebar', labelKey: 'keys.toggleSidebar', defaultAccel: 'Ctrl+Shift+B' },
  { id: 'maximizePane', labelKey: 'keys.maximizePane', defaultAccel: 'Ctrl+Shift+Space' },
  { id: 'minimizePane', labelKey: 'keys.minimizePane', defaultAccel: 'Ctrl+Shift+Down' },
  { id: 'redrawPane', labelKey: 'keys.redrawPane', defaultAccel: 'Ctrl+Shift+R' },
  // Ctrl+J alone is a newline in Claude, hence Shift. Ctrl+Alt+arrows can clash
  // with AltGr layouts or GPU rotation hotkeys: remappable like the rest.
  { id: 'nextWaiting', labelKey: 'keys.nextWaiting', defaultAccel: 'Ctrl+Shift+J' },
  { id: 'reopenClosedPane', labelKey: 'keys.reopenClosedPane', defaultAccel: 'Ctrl+Shift+U' },
  { id: 'focusNextPane', labelKey: 'keys.focusNextPane', defaultAccel: 'Ctrl+Alt+Right' },
  { id: 'focusPrevPane', labelKey: 'keys.focusPrevPane', defaultAccel: 'Ctrl+Alt+Left' },
  { id: 'quickCommands', labelKey: 'keys.quickCommands', defaultAccel: 'Ctrl+Shift+Q' },
  { id: 'toggleChanges', labelKey: 'keys.toggleChanges', defaultAccel: 'Ctrl+Shift+D' },
  { id: 'agentsBoard', labelKey: 'keys.agentsBoard', defaultAccel: 'Ctrl+Shift+A' },
  // Shift+PageUp/PageDown alone keep scrolling the terminal.
  { id: 'promptPrev', labelKey: 'keys.promptPrev', defaultAccel: 'Ctrl+Shift+PageUp' },
  { id: 'promptNext', labelKey: 'keys.promptNext', defaultAccel: 'Ctrl+Shift+PageDown' },
  // VS Code's explorer key; M for Markdown notes.
  { id: 'toggleFiles', labelKey: 'keys.toggleFiles', defaultAccel: 'Ctrl+Shift+E' },
  { id: 'toggleNotes', labelKey: 'keys.toggleNotes', defaultAccel: 'Ctrl+Shift+M' },
  // H for "hablar"; Win+H is the system's own dictation.
  { id: 'dictate', labelKey: 'keys.dictate', defaultAccel: 'Ctrl+Shift+H' },
]

/** Actions that stay out of text fields so the field keeps the key (E5-FR-18). */
export const SKIP_IN_EDITABLE: ReadonlySet<ActionId> = new Set<ActionId>(['reopenClosedPane'])

/**
 * True when a key event targets a text field the user types into: an input,
 * a textarea or a contenteditable element. xterm's hidden helper textarea is
 * not one (it is the terminal itself).
 */
export function isEditableTarget(e: { target: EventTarget | null }): boolean {
  const el = e.target as { tagName?: string; isContentEditable?: boolean; classList?: { contains(c: string): boolean } } | null
  if (!el || typeof el.tagName !== 'string') return false
  if (el.classList?.contains('xterm-helper-textarea')) return false
  const tag = el.tagName.toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true
}

/**
 * Ctrl+1..9 (focus the Nth visible console, E5-FR-18): the digit, or null when
 * the event is something else. A fixed family, outside the remappable keymap.
 */
export function ctrlDigit(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): number | null {
  if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey || !/^[1-9]$/.test(e.key)) return null
  return Number(e.key)
}

/** Merge user overrides over the defaults into a full actionId → accel map. */
export function resolveKeymap(overrides: Record<string, string> | undefined): Record<ActionId, string> {
  const out = {} as Record<ActionId, string>
  for (const a of KEY_ACTIONS) out[a.id] = overrides?.[a.id] || a.defaultAccel
  return out
}

const KEYNAME: Record<string, string> = {
  ' ': 'Space',
  Escape: 'Esc',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Home: 'Home',
  End: 'End',
}

/** Normalize a keydown into a stable accelerator string (null if only modifiers). */
export function eventToAccel(e: KeyboardEvent): string | null {
  const k = e.key
  if (['Control', 'Alt', 'Shift', 'Meta', 'OS', 'Dead'].includes(k)) return null
  const mods: string[] = []
  if (e.ctrlKey) mods.push('Ctrl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Meta')

  let main: string
  if (k.length === 1) main = /[a-z]/i.test(k) ? k.toUpperCase() : k
  else if (/^F\d{1,2}$/.test(k)) main = k
  else main = KEYNAME[k] ?? k
  if (!main) return null
  return [...mods, main].join('+')
}

/** Pretty-print an accelerator for display. */
export function formatAccel(accel: string): string {
  return accel
    .split('+')
    .map((p) => (p === 'Meta' ? 'Win' : p))
    .join(' + ')
}

/**
 * Split an accelerator into its keys for a chip per key (E4-FR-29/30), with
 * Meta shown as Win like formatAccel. A trailing "++" is the "+" key itself.
 */
export function accelParts(accel: string): string[] {
  if (!accel) return []
  const plusKey = accel.endsWith('++') || accel === '+'
  const parts = (plusKey ? accel.slice(0, accel === '+' ? 0 : -2) : accel)
    .split('+')
    .filter(Boolean)
    .map((p) => (p === 'Meta' ? 'Win' : p))
  return plusKey ? [...parts, '+'] : parts
}

const ARIA_KEY: Record<string, string> = {
  Ctrl: 'Control',
  Win: 'Meta',
  Esc: 'Escape',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Space: 'Space',
  '+': 'Plus',
}

/** The aria-keyshortcuts value for a chip's keys ("Control+Enter"). */
export function ariaKeyshortcuts(keys: string[]): string {
  return keys.map((k) => ARIA_KEY[k] ?? k).join('+')
}
