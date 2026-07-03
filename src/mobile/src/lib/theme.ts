/**
 * Apply the desktop's resolved theme tokens to the phone. Replicates the
 * renderer's CSS_VAR_BY_TOKEN map (src/renderer/themes/tokens.ts) so the same
 * Tailwind utility classes (bg-bg-primary, text-text-secondary, ...) resolve to
 * the live desktop colors, and reuses the shared xtermThemeFromTokens for the
 * terminal palette - one source of truth for both surfaces.
 */
import type { ITheme } from '@xterm/xterm'
import type { ThemeTokenKey, ThemeTokens } from '@shared/types'
import { xtermThemeFromTokens } from '@shared/xtermTheme'

/** Same mapping the desktop uses; UI-chrome tokens only (ansi tokens feed xterm). */
const CSS_VAR_BY_TOKEN: Partial<Record<ThemeTokenKey, string>> = {
  'bg-primary': '--color-bg-primary',
  'bg-secondary': '--color-bg-secondary',
  card: '--color-card',
  border: '--color-border',
  'text-primary': '--color-text-primary',
  'text-secondary': '--color-text-secondary',
  accent: '--color-accent-violet',
  'accent-2': '--color-accent-purple',
  'accent-3': '--color-accent-blue',
}

function setMeta(name: string, content: string): void {
  let el = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)
  if (!el) {
    el = document.createElement('meta')
    el.name = name
    document.head.appendChild(el)
  }
  el.content = content
}

/** Rough luminance test so light themes get color-scheme: light. */
function isLight(bg: string): boolean {
  const hex = bg.replace('#', '')
  if (hex.length < 6) return false
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return 0.299 * r + 0.587 * g + 0.114 * b > 140
}

/**
 * Push tokens into the document's CSS custom properties, sync color-scheme and
 * the theme-color meta (address-bar tint), and return the xterm ITheme for the
 * terminal to adopt. Called on every state snapshot so a desktop theme change
 * repaints the phone live.
 */
export function applyRemoteTheme(tokens: ThemeTokens): ITheme {
  const root = document.documentElement
  for (const key of Object.keys(CSS_VAR_BY_TOKEN) as ThemeTokenKey[]) {
    const cssVar = CSS_VAR_BY_TOKEN[key]
    const value = tokens[key]
    if (cssVar && value) root.style.setProperty(cssVar, value)
  }
  const bg = tokens['bg-primary'] || '#0b0f19'
  root.style.colorScheme = isLight(bg) ? 'light' : 'dark'
  setMeta('theme-color', bg)
  return xtermThemeFromTokens(tokens)
}
