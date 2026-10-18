/**
 * Keyboard model of the new-workspace wizard (E4-FR-31), pure so it is unit
 * tested without a DOM.
 */

export interface WizardKeyEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing?: boolean
}

export interface WizardKeyTarget {
  tagName?: string
  isContentEditable?: boolean
  getAttribute?: (name: string) => string | null
}

/** Roles whose Enter belongs to the widget (open a list, pick an item). */
const NATIVE_ENTER_ROLES = new Set(['combobox', 'listbox', 'menu', 'menuitem', 'option', 'button', 'link'])

/**
 * Whether Enter on this element keeps its native meaning: a textarea newline,
 * a select, a button or link activation, a combobox/listbox/menu or an
 * editable region. Plain text inputs do not (Enter advances the wizard).
 */
export function enterIsNative(target: WizardKeyTarget | null): boolean {
  if (!target || typeof target.tagName !== 'string') return false
  const tag = target.tagName.toUpperCase()
  if (tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A') return true
  if (target.isContentEditable) return true
  const role = target.getAttribute?.('role')
  return !!role && NATIVE_ENTER_ROLES.has(role)
}

/**
 * - 'advance': Enter runs the step's primary (Next, or Create on the last step).
 * - 'create': Ctrl+Enter creates now with the defaults for the rest.
 * - 'block': swallow the key (Enter with nothing valid to do), never let it
 *   reach the console behind.
 * - null: not ours, let the element handle it.
 */
export type WizardKeyAction = 'advance' | 'create' | 'block' | null

export function wizardKeyAction(
  e: WizardKeyEvent,
  target: WizardKeyTarget | null,
  state: { canAdvance: boolean; hasCwd: boolean },
): WizardKeyAction {
  if (e.key !== 'Enter' || e.isComposing || e.altKey) return null
  if (e.ctrlKey || e.metaKey) return state.hasCwd ? 'create' : 'block'
  if (e.shiftKey || enterIsNative(target)) return null
  return state.canAdvance ? 'advance' : 'block'
}

/** Where focus lands when the wizard opens: the folder input, or the primary when prefilled. */
export function initialWizardFocus(prefilledCwd: string): 'cwd' | 'primary' {
  return prefilledCwd.trim() ? 'primary' : 'cwd'
}

/** Next element index for a Tab keypress trapped inside the dialog. */
export function trapTabIndex(count: number, current: number, backwards: boolean): number {
  if (count <= 0) return -1
  if (current < 0) return backwards ? count - 1 : 0
  return backwards ? (current - 1 + count) % count : (current + 1) % count
}
