import type { ITheme } from '@xterm/xterm'
import type { ThemeName, ThemeTokenKey, ThemeTokens } from '@shared/types'
import { THEMES } from './registry'
import { CSS_VAR_BY_TOKEN } from './tokens'

type CustomColors = Partial<Record<ThemeTokenKey, string>>

/** Resolve the effective token set: base theme, with custom overrides on top of 'custom'. */
export function resolveTokens(name: ThemeName, custom?: CustomColors): ThemeTokens {
  const base = (THEMES[name] ?? THEMES.midnight).tokens
  if (name === 'custom' && custom) {
    return { ...base, ...custom } as ThemeTokens
  }
  return base
}

/** Push the UI-chrome tokens into CSS custom properties + set the color scheme. */
export function applyTheme(name: ThemeName, custom?: CustomColors): void {
  const tokens = resolveTokens(name, custom)
  const root = document.documentElement
  for (const [token, cssVar] of Object.entries(CSS_VAR_BY_TOKEN)) {
    const value = tokens[token as ThemeTokenKey]
    if (value && cssVar) root.style.setProperty(cssVar, value)
  }
  root.style.colorScheme = THEMES[name]?.light ? 'light' : 'dark'
}

/** Build an xterm ITheme from the active theme tokens. */
export function buildXtermTheme(name: ThemeName, custom?: CustomColors): ITheme {
  const t = resolveTokens(name, custom)
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
