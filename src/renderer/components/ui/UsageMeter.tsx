import { cn } from '@/lib/cn'

/** Reference palette: green when there's headroom, amber getting close, red near the cap. */
function barColor(percent: number): string {
  if (percent >= 85) return '#ef4444'
  if (percent >= 60) return '#f59e0b'
  return '#22c55e'
}

export interface UsageMeterProps {
  label: string
  /** Fill width + color. null renders an empty track (e.g. a custom row with no budget). */
  percent: number | null
  /** Right-aligned value, e.g. "67%" or "1.2M / 5M". */
  valueText: string
  /** Secondary line under the bar, e.g. a reset time. */
  subText?: string
  /** Render the bar greyed out (expired / error / no-data). */
  muted?: boolean
  /** Thin, label-less variant for the collapsed sidebar. */
  compact?: boolean
}

export function UsageMeter({ label, percent, valueText, subText, muted, compact }: UsageMeterProps) {
  const pct = percent === null ? 0 : Math.max(0, Math.min(100, percent))
  const fillColor = muted ? 'var(--color-border)' : barColor(pct)

  return (
    <div className={compact ? '' : 'space-y-1'}>
      {!compact && (
        <div className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 truncate text-[11px] font-medium text-text-primary">{label}</span>
          <span
            className={cn(
              'shrink-0 text-[10px] tabular-nums',
              muted ? 'text-text-secondary/70' : 'text-text-secondary',
            )}
          >
            {valueText}
          </span>
        </div>
      )}
      <div
        className={cn(
          'w-full overflow-hidden rounded-full bg-bg-primary',
          compact ? 'h-1' : 'h-1.5',
        )}
      >
        <div
          className="h-full rounded-full transition-[width] duration-300 ease-out"
          style={{ width: `${pct}%`, backgroundColor: fillColor }}
        />
      </div>
      {!compact && subText && (
        <div className="truncate text-[10px] text-text-secondary/80">{subText}</div>
      )}
    </div>
  )
}
