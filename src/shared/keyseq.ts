/**
 * Maps a modifier combo (Ctrl/Shift/Alt + a base key) to the raw terminal escape
 * sequence written to a pty. Used by the desktop key-bar button editor so users can
 * build a KeyButton `seq` without memorizing control codes.
 *
 * Arrows, navigation, and function keys use the standard xterm CSI-modifier
 * encoding that Claude Code and modern shells understand. Ctrl/Shift on plain keys
 * such as Tab or Enter is terminal-dependent; we emit the widely-recognized
 * sequence and rely on the editor's live preview + raw editability as the escape
 * hatch. The bytes are forwarded verbatim to the pty (see KeyButton in types.ts).
 */

export type BaseKeyId =
  | 'char'
  | 'tab'
  | 'enter'
  | 'esc'
  | 'space'
  | 'backspace'
  | 'delete'
  | 'insert'
  | 'home'
  | 'end'
  | 'pageUp'
  | 'pageDown'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'f1'
  | 'f2'
  | 'f3'
  | 'f4'
  | 'f5'
  | 'f6'
  | 'f7'
  | 'f8'
  | 'f9'
  | 'f10'
  | 'f11'
  | 'f12'

export interface BaseKey {
  id: BaseKeyId
  /** Short, universal label for the picker (mostly symbols/abbreviations). */
  label: string
}

/** Base keys offered by the combo picker, in display order. */
export const BASE_KEYS: BaseKey[] = [
  { id: 'char', label: 'Char' },
  { id: 'tab', label: 'Tab' },
  { id: 'enter', label: 'Enter' },
  { id: 'esc', label: 'Esc' },
  { id: 'space', label: 'Space' },
  { id: 'backspace', label: 'Bksp' },
  { id: 'delete', label: 'Del' },
  { id: 'insert', label: 'Ins' },
  { id: 'home', label: 'Home' },
  { id: 'end', label: 'End' },
  { id: 'pageUp', label: 'PgUp' },
  { id: 'pageDown', label: 'PgDn' },
  { id: 'up', label: '↑' },
  { id: 'down', label: '↓' },
  { id: 'left', label: '←' },
  { id: 'right', label: '→' },
  { id: 'f1', label: 'F1' },
  { id: 'f2', label: 'F2' },
  { id: 'f3', label: 'F3' },
  { id: 'f4', label: 'F4' },
  { id: 'f5', label: 'F5' },
  { id: 'f6', label: 'F6' },
  { id: 'f7', label: 'F7' },
  { id: 'f8', label: 'F8' },
  { id: 'f9', label: 'F9' },
  { id: 'f10', label: 'F10' },
  { id: 'f11', label: 'F11' },
  { id: 'f12', label: 'F12' },
]

export interface KeyCombo {
  ctrl: boolean
  shift: boolean
  alt: boolean
  base: BaseKeyId
  /** Only used when `base === 'char'`; the single printable character. */
  char?: string
}

/** CSI final bytes for cursor / edit keys. */
const CURSOR_FINAL: Partial<Record<BaseKeyId, string>> = {
  up: 'A',
  down: 'B',
  right: 'C',
  left: 'D',
  home: 'H',
  end: 'F',
}

/** SS3 final bytes for F1-F4 (used unmodified). */
const FKEY_SS3: Partial<Record<BaseKeyId, string>> = {
  f1: 'P',
  f2: 'Q',
  f3: 'R',
  f4: 'S',
}

/** Numeric ids for tilde-form keys (`ESC [ <n> ~`). */
const TILDE_ID: Partial<Record<BaseKeyId, number>> = {
  insert: 2,
  delete: 3,
  pageUp: 5,
  pageDown: 6,
  f5: 15,
  f6: 17,
  f7: 18,
  f8: 19,
  f9: 20,
  f10: 21,
  f11: 23,
  f12: 24,
}

/** xterm modifier parameter: 1 + Shift(1) + Alt(2) + Ctrl(4). */
function modParam(combo: KeyCombo): number {
  return 1 + (combo.shift ? 1 : 0) + (combo.alt ? 2 : 0) + (combo.ctrl ? 4 : 0)
}

/**
 * Builds the escape sequence for a combo. Returns '' when nothing can be produced
 * (e.g. base 'char' with an empty character).
 */
export function comboToSeq(combo: KeyCombo): string {
  const { ctrl, shift, alt, base } = combo
  const mod = modParam(combo)

  // Cursor / edit keys: CSI (ESC [ final), or ESC [ 1 ; mod final when modified.
  const cursor = CURSOR_FINAL[base]
  if (cursor) {
    return mod === 1 ? `\x1b[${cursor}` : `\x1b[1;${mod}${cursor}`
  }

  // F1-F4: SS3 when unmodified, CSI 1 ; mod final when modified.
  const ss3 = FKEY_SS3[base]
  if (ss3) {
    return mod === 1 ? `\x1bO${ss3}` : `\x1b[1;${mod}${ss3}`
  }

  // Tilde-form keys (Insert/Delete/PageUp/PageDown/F5-F12): ESC [ n ~ (; mod).
  const tilde = TILDE_ID[base]
  if (tilde !== undefined) {
    return mod === 1 ? `\x1b[${tilde}~` : `\x1b[${tilde};${mod}~`
  }

  switch (base) {
    case 'char': {
      const raw = combo.char ?? ''
      if (!raw) return ''
      let ch = raw[0]
      if (shift && /[a-z]/i.test(ch)) ch = ch.toUpperCase()
      // Ctrl maps a printable char to its control code (Ctrl+A..Z -> 1..26, etc.).
      if (ctrl) ch = String.fromCharCode(ch.toUpperCase().charCodeAt(0) & 0x1f)
      return alt ? `\x1b${ch}` : ch
    }
    case 'tab':
      if (shift) return '\x1b[Z' // back-tab (CBT)
      if (alt) return '\x1b\t'
      return '\t' // Ctrl+Tab is not universally distinguishable; keep plain Tab.
    case 'enter':
      // Ctrl+Enter and Alt+Enter both send Meta+Enter (ESC + CR).
      return ctrl || alt ? '\x1b\r' : '\r'
    case 'esc':
      return alt ? '\x1b\x1b' : '\x1b'
    case 'space':
      if (ctrl) return '\x00' // Ctrl+Space -> NUL
      return alt ? '\x1b ' : ' '
    case 'backspace': {
      const bs = ctrl ? '\x08' : '\x7f'
      return alt ? `\x1b${bs}` : bs
    }
    default:
      return ''
  }
}
