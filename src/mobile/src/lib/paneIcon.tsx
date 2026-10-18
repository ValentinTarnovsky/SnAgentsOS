/**
 * Pane type -> lucide glyph, shared by the tab strip and the action list
 * header (E1-FR-32): claude Sparkles, codex Code2, shell Terminal, custom Bot.
 */
import type { ReactNode } from 'react'
import { Bot, Code2, Sparkles, Terminal, type LucideIcon } from 'lucide-react'
import type { PaneType } from '@shared/types'

export const PANE_ICON: Record<PaneType, LucideIcon> = {
  claude: Sparkles,
  codex: Code2,
  shell: Terminal,
  custom: Bot,
}

export function PaneIcon({ type, size = 14, className }: { type: PaneType; size?: number; className?: string }): ReactNode {
  const Icon = PANE_ICON[type] ?? Terminal
  return (
    <span data-pane-icon={type} className="inline-flex shrink-0">
      <Icon size={size} className={className} aria-hidden />
    </span>
  )
}
