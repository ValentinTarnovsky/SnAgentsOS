import type { ITheme } from '@xterm/xterm'
import type { ThemeName, ThemeTokenKey, ThemeTokens } from '@shared/types'
import { xtermThemeFromTokens } from '@shared/xtermTheme'
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
  return xtermThemeFromTokens(resolveTokens(name, custom))
}
