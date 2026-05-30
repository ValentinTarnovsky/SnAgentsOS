import type { ThemeDefinition } from '@shared/types'

export const dracula: ThemeDefinition = {
  name: 'dracula',
  label: 'Dracula',
  tokens: {
    'bg-primary': '#282a36',
    'bg-secondary': '#21222c',
    card: '#343746',
    border: '#44475a',
    'text-primary': '#f8f8f2',
    'text-secondary': '#8b90b8',
    accent: '#bd93f9',
    'accent-2': '#ff79c6',
    'accent-3': '#8be9fd',

    'term-bg': '#282a36',
    'term-fg': '#f8f8f2',
    'term-cursor': '#f8f8f0',
    'term-selection': 'rgba(189, 147, 249, 0.30)',

    'ansi-black': '#21222c',
    'ansi-red': '#ff5555',
    'ansi-green': '#50fa7b',
    'ansi-yellow': '#f1fa8c',
    'ansi-blue': '#bd93f9',
    'ansi-magenta': '#ff79c6',
    'ansi-cyan': '#8be9fd',
    'ansi-white': '#f8f8f2',
    'ansi-brightBlack': '#6272a4',
    'ansi-brightRed': '#ff6e6e',
    'ansi-brightGreen': '#69ff94',
    'ansi-brightYellow': '#ffffa5',
    'ansi-brightBlue': '#d6acff',
    'ansi-brightMagenta': '#ff92df',
    'ansi-brightCyan': '#a4ffff',
    'ansi-brightWhite': '#ffffff',
  },
}
