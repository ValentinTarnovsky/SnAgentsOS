import type { MessageKey } from '@/i18n'

/** Remappable in-app actions (terminal-intrinsic keys like copy/paste are fixed). */
export type ActionId =
  | 'palette'
  | 'workspaceFlip'
  | 'workspaceNext'
  | 'workspacePrev'
  | 'newWorkspace'
  | 'newConsole'
  | 'openSettings'
  | 'toggleSidebar'

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
  { id: 'openSettings', labelKey: 'keys.openSettings', defaultAccel: 'Ctrl+,' },
  { id: 'toggleSidebar', labelKey: 'keys.toggleSidebar', defaultAccel: 'Ctrl+Shift+B' },
]

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
