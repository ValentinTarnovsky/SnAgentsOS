import type { ThemeDefinition } from '@shared/types'

/** Default theme — identical to the original Sn brand look (do not drift). */
export const midnight: ThemeDefinition = {
  name: 'midnight',
  label: 'Midnight',
  tokens: {
    'bg-primary': '#0b0f19',
    'bg-secondary': '#0f172a',
    card: '#111827',
    border: '#1f2937',
    'text-primary': '#e5e7eb',
    'text-secondary': '#9ca3af',
    accent: '#6366f1',
    'accent-2': '#8b5cf6',
    'accent-3': '#60a5fa',

    'term-bg': '#0b0f19',
    'term-fg': '#e5e7eb',
    'term-cursor': '#6366f1',
    'term-selection': 'rgba(99, 102, 241, 0.30)',

    'ansi-black': '#0b0f19',
    'ansi-red': '#ef4444',
    'ansi-green': '#22c55e',
    'ansi-yellow': '#f59e0b',
    'ansi-blue': '#60a5fa',
    'ansi-magenta': '#8b5cf6',
    'ansi-cyan': '#22d3ee',
    'ansi-white': '#e5e7eb',
    'ansi-brightBlack': '#9ca3af',
    'ansi-brightRed': '#f87171',
    'ansi-brightGreen': '#4ade80',
    'ansi-brightYellow': '#fbbf24',
    'ansi-brightBlue': '#93c5fd',
    'ansi-brightMagenta': '#a78bfa',
    'ansi-brightCyan': '#67e8f9',
    'ansi-brightWhite': '#f9fafb',
  },
}
