import {
  Bot,
  Boxes,
  Cpu,
  Database,
  GitBranch,
  Hammer,
  type LucideIcon,
  Rocket,
  Server,
  Sparkles,
  SquareTerminal,
  TerminalSquare,
  Wand2,
} from 'lucide-react'

/** Named icons selectable for presets/panes. */
export const ICONS: Record<string, LucideIcon> = {
  terminal: TerminalSquare,
  console: SquareTerminal,
  sparkles: Sparkles,
  wand: Wand2,
  bot: Bot,
  cpu: Cpu,
  server: Server,
  database: Database,
  git: GitBranch,
  build: Hammer,
  rocket: Rocket,
  boxes: Boxes,
}

export const ICON_NAMES = Object.keys(ICONS)

export function iconFor(name: string | undefined): LucideIcon {
  return (name && ICONS[name]) || TerminalSquare
}
