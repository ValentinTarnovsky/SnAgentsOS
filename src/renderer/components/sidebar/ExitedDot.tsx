import type { Pane } from '@shared/types'
import type { TFn } from '@/i18n'

/** "<pane>: exited" tooltip lines for a workspace's consoles whose shell ended (E6-FR-38). */
export function exitedLines(panes: Pane[], paneExit: Record<string, number>, t: TFn): string[] {
  return panes.filter((p) => paneExit[p.id] !== undefined).map((p) => t('pane.exitedTip', { pane: p.title }))
}

/** True when the workspace has consoles and every one of them has exited. */
export function allExited(panes: Pane[], paneExit: Record<string, number>): boolean {
  return panes.length > 0 && panes.every((p) => paneExit[p.id] !== undefined)
}

/** Gray workspace dot: every console of the workspace has exited (E6-FR-38). */
export function ExitedDot({ label, size = 8 }: { label: string; size?: number }) {
  return (
    <span
      title={label}
      role="img"
      aria-label={label}
      data-exited-dot
      className="inline-block shrink-0 rounded-full bg-text-secondary/50"
      style={{ width: size, height: size }}
    />
  )
}
