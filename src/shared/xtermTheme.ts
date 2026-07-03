/**
 * Map resolved theme tokens to an xterm ITheme. Single source for the desktop
 * renderer and the mobile web client (the phone receives the same flat token
 * record over the wire).
 */
import type { ITheme } from '@xterm/xterm'
import type { ThemeTokens } from './types'

export function xtermThemeFromTokens(t: ThemeTokens): ITheme {
  return {
    background: t['term-bg'],
    foreground: t['term-fg'],
    cursor: t['term-cursor'],
    cursorAccent: t['term-bg'],
    selectionBackground: t['term-selection'],

    black: t['ansi-black'],
    red: t['ansi-red'],
    green: t['ansi-green'],
    yellow: t['ansi-yellow'],
    blue: t['ansi-blue'],
    magenta: t['ansi-magenta'],
    cyan: t['ansi-cyan'],
    white: t['ansi-white'],

    brightBlack: t['ansi-brightBlack'],
    brightRed: t['ansi-brightRed'],
    brightGreen: t['ansi-brightGreen'],
    brightYellow: t['ansi-brightYellow'],
    brightBlue: t['ansi-brightBlue'],
    brightMagenta: t['ansi-brightMagenta'],
    brightCyan: t['ansi-brightCyan'],
    brightWhite: t['ansi-brightWhite'],
  }
}
