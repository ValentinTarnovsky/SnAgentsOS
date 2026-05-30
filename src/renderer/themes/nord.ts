import type { ThemeDefinition } from '@shared/types'

export const nord: ThemeDefinition = {
  name: 'nord',
  label: 'Nord',
  tokens: {
    'bg-primary': '#2e3440',
    'bg-secondary': '#272c36',
    card: '#3b4252',
    border: '#434c5e',
    'text-primary': '#eceff4',
    'text-secondary': '#8b95a7',
    accent: '#88c0d0',
    'accent-2': '#81a1c1',
    'accent-3': '#5e81ac',

    'term-bg': '#2e3440',
    'term-fg': '#d8dee9',
    'term-cursor': '#88c0d0',
    'term-selection': 'rgba(136, 192, 208, 0.25)',

    'ansi-black': '#3b4252',
    'ansi-red': '#bf616a',
    'ansi-green': '#a3be8c',
    'ansi-yellow': '#ebcb8b',
    'ansi-blue': '#81a1c1',
    'ansi-magenta': '#b48ead',
    'ansi-cyan': '#88c0d0',
    'ansi-white': '#e5e9f0',
    'ansi-brightBlack': '#4c566a',
    'ansi-brightRed': '#bf616a',
    'ansi-brightGreen': '#a3be8c',
    'ansi-brightYellow': '#ebcb8b',
    'ansi-brightBlue': '#81a1c1',
    'ansi-brightMagenta': '#b48ead',
    'ansi-brightCyan': '#8fbcbb',
    'ansi-brightWhite': '#eceff4',
  },
}
