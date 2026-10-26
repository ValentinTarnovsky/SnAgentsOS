/**
 * Agent state glyph for one pane (E1-FR-04), drawn with the state tokens of
 * docs/STYLEGUIDE.md: working = violet ring spinning every 0.8s (still under
 * prefers-reduced-motion via the .spin rule), action = amber dot with halo,
 * done = green dot, error = red dot with halo, idle = grey dot at 40%,
 * unknown = hollow ring. Nothing renders without a status (nor for a bare
 * one, app 2.7.0), so plain shells stay untouched. Color is never the only signal: role="img" carries the
 * localized name ("Claude: working", plus "(approximate)" for title-only).
 */
import type { ReactNode } from 'react'
import { clsx } from 'clsx'
import type { ClaudePaneState } from '@shared/types'
import type { RemotePaneStatus } from '@shared/remote-protocol'
import { displayStatus } from '@shared/status'
import { statusAriaLabel } from '../lib/statusText'

const DOT_CLASS: Record<Exclude<ClaudePaneState, 'working'>, string> = {
  action: 'bg-state-action ring-2 ring-state-action/30',
  done: 'bg-state-done',
  error: 'bg-state-error ring-2 ring-state-error/30',
  idle: 'bg-state-idle/40',
  unknown: 'bg-transparent ring-1 ring-text-secondary',
}

export function StatusIndicator({ status: raw, size = 12 }: { status?: RemotePaneStatus; size?: number }): ReactNode {
  // An action already answered (attention false) reads as the desktop glyph does;
  // app 2.7.0: a bare status (only a `snaos needs`, no agent) has no agent glyph.
  const status = displayStatus(raw?.bare ? undefined : raw)
  if (!status) return null
  const dot = Math.max(6, Math.round(size * 0.67))
  return (
    <span
      role="img"
      aria-label={statusAriaLabel(status)}
      data-state={status.state}
      className="inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
    >
      {status.state === 'working' ? (
        <span
          className="spin block rounded-full border-2 border-state-working border-t-transparent"
          style={{ width: size, height: size }}
        />
      ) : (
        <span className={clsx('block rounded-full', DOT_CLASS[status.state])} style={{ width: dot, height: dot }} />
      )}
    </span>
  )
}
