import type { ThemeDefinition, ThemeName } from '@shared/types'
import { midnight } from './midnight'
import { light } from './light'
import { nord } from './nord'
import { dracula } from './dracula'
import { solarized } from './solarized'

/** The Custom theme starts as a clone of Midnight; user overrides overlay it. */
const custom: ThemeDefinition = {
  name: 'custom',
  label: 'Custom',
  tokens: { ...midnight.tokens },
}

export const THEMES: Record<ThemeName, ThemeDefinition> = {
  midnight,
  light,
  nord,
  dracula,
  solarized,
  custom,
}

/** Themes offered in the picker, in display order. */
export const THEME_LIST: ThemeDefinition[] = [midnight, light, nord, dracula, solarized, custom]
