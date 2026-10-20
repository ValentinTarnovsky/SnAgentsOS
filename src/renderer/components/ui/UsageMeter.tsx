import { cn } from '@/lib/cn'
import type { IconComponent } from '@/lib/icons'

/** Reference palette: green when there's headroom, amber getting close, red near the cap. */
export function barColor(percent: number): string {
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
  /** Secondary line under the bar, e.g. a reset time (stacked only). */
  subText?: string
  /** Render the bar greyed out (expired / error / no-data). */
  muted?: boolean
  /**
   * 'stacked' (default): label and value over the bar, reset line under it.
   * 'row': one line (icon, label, thin bar, value) for the folded sidebar list.
   */
  variant?: 'stacked' | 'row'
  /** Provider mark at the start of a 'row'; without it the column stays aligned. */
  icon?: IconComponent
  /** Native tooltip over the whole meter (e.g. "last known value"). */
  title?: string
}

export function UsageMeter({ label, percent, valueText, subText, muted, variant = 'stacked', icon: Icon, title }: UsageMeterProps) {
  const pct = percent === null ? 0 : Math.max(0, Math.min(100, percent))
  const fillColor = muted ? 'var(--color-border)' : barColor(pct)
  const track = (
    <div className={cn('overflow-hidden rounded-full bg-bg-primary', variant === 'row' ? 'h-1.5 min-w-0 flex-1' : 'h-1.5 w-full')}>
      <div
        className="h-full rounded-full transition-[width] duration-300 ease-out"
        style={{ width: `${pct}%`, backgroundColor: fillColor }}
        data-usage-fill
      />
    </div>
  )

  if (variant === 'row') {
    // The value takes the bar's color once it gets close (amber, then red); low values stay neutral.
    const hot = !muted && percent !== null && pct >= 60
    return (
      <div className="flex h-5 min-w-0 items-center gap-2" title={title}>
        {Icon ? <Icon size={12} className="shrink-0 text-text-secondary" /> : <span className="w-3 shrink-0" />}
        <span className="w-[4.5rem] shrink-0 truncate text-[11px] text-text-primary">{label}</span>
        {track}
        <span
          className={cn(
            'min-w-[2.25rem] shrink-0 text-right text-[11px] font-semibold tabular-nums',
            muted ? 'text-text-secondary/70' : 'text-text-secondary',
          )}
          style={hot ? { color: barColor(pct) } : undefined}
          data-usage-value
        >
          {valueText}
        </span>
      </div>
    )
  }

  return (
    <div className="space-y-1" title={title}>
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
      {track}
      {subText && (
        <div className="truncate text-[10px] text-text-secondary/80">{subText}</div>
      )}
    </div>
  )
}
