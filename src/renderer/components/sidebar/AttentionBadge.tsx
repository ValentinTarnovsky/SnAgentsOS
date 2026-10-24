import { cn } from '@/lib/cn'

/** Keyboard focus ring of the sidebar's buttons, in place of Chromium's white default. */
export const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-violet/60'

/**
 * Discord-style unread pill: how many things await the user (consoles of a
 * workspace, or "Te necesita" rows of a team, app 2.7.0). `marker` is the
 * data attribute UI suites read: workspace badges keep `data-attention-badge`,
 * team badges carry their own so a workspace query never counts them.
 */
export function AttentionBadge({
  count,
  className,
  marker = 'data-attention-badge',
}: {
  count: number
  className?: string
  marker?: 'data-attention-badge' | 'data-team-badge' | 'data-team-tab-count'
}) {
  if (count <= 0) return null
  return (
    <span
      {...{ [marker]: count }}
      className={cn(
        'flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-[#EF4444] px-1 text-[11px] font-semibold leading-none text-white',
        className,
      )}
    >
      {count > 9 ? '9+' : count}
    </span>
  )
}
