import { barColor } from '@/components/ui/UsageMeter'

export interface UsageRingProps {
  /** 0..100, or null for a muted/indeterminate ring (error/expired/nodata/no budget). */
  percent: number | null
  /** Render greyed out (track only), independent of percent. */
  muted?: boolean
  /** Outer pixel size. Defaults to 36 to sit inside the 60px collapsed rail. */
  size?: number
}

/**
 * Compact circular progress ring for the collapsed sidebar: a track circle plus
 * a progress arc (stroke-dasharray/offset, rotated -90deg so it starts at 12
 * o'clock) with the integer percent centered. Lets the usage stay glanceable
 * when the sidebar is too narrow for horizontal bars.
 */
export function UsageRing({ percent, muted, size = 36 }: UsageRingProps) {
  const stroke = 3.5
  const r = (size - stroke) / 2
  const circumference = 2 * Math.PI * r
  const hasValue = percent !== null && !muted
  const pct = hasValue ? Math.max(0, Math.min(100, percent as number)) : 0
  const color = hasValue ? barColor(pct) : 'var(--color-border)'
  const offset = circumference * (1 - pct / 100)

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--color-border)"
          strokeWidth={stroke}
          opacity={0.4}
        />
        {hasValue && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            className="transition-[stroke-dashoffset] duration-300 ease-out"
          />
        )}
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        {hasValue ? (
          <span className="text-[9px] font-semibold tabular-nums text-text-primary">
            {Math.round(pct)}
          </span>
        ) : (
          <span className="text-[10px] leading-none text-text-secondary/60">–</span>
        )}
      </div>
    </div>
  )
}
