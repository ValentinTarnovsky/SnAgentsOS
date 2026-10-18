import type { ThemeTokenKey } from '@shared/types'

/**
 * Maps the UI-chrome tokens to the Tailwind `@theme` CSS custom properties
 * defined in globals.css. Terminal/ansi tokens feed the xterm palette directly
 * (see applyTheme/buildXtermTheme); only ansi green and red are also CSS vars,
 * for the git chip and diff counts (E7). They stay out of UI_TOKENS.
 */
export const CSS_VAR_BY_TOKEN: Partial<Record<ThemeTokenKey, string>> = {
  'bg-primary': '--color-bg-primary',
  'bg-secondary': '--color-bg-secondary',
  card: '--color-card',
  border: '--color-border',
  'text-primary': '--color-text-primary',
  'text-secondary': '--color-text-secondary',
  accent: '--color-accent-violet',
  'accent-2': '--color-accent-purple',
  'accent-3': '--color-accent-blue',
  'ansi-green': '--color-ansi-green',
  'ansi-red': '--color-ansi-red',
}

/** UI-chrome tokens exposed in the custom-color editor (Settings → Appearance). */
export const UI_TOKENS: { key: ThemeTokenKey; label: string }[] = [
  { key: 'bg-primary', label: 'Background' },
  { key: 'bg-secondary', label: 'Surface' },
  { key: 'card', label: 'Card' },
  { key: 'border', label: 'Border' },
  { key: 'text-primary', label: 'Text' },
  { key: 'text-secondary', label: 'Muted text' },
  { key: 'accent', label: 'Accent' },
  { key: 'accent-2', label: 'Accent 2' },
  { key: 'accent-3', label: 'Accent 3' },
]
