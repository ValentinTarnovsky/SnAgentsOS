import { useEffect, useState, type ComponentType } from 'react'
import { Boxes, Cpu, MemoryStick, TerminalSquare } from 'lucide-react'
import type { AppMetrics } from '@shared/ipc-contract'
import { useT } from '@/i18n'

const N = 60 // samples kept (~1 minute at 1s cadence)
const H = 56 // chart height in viewBox units

export function UsageSection() {
  const t = useT()
  const [current, setCurrent] = useState<AppMetrics | null>(null)
  const [mem, setMem] = useState<number[]>([])
  const [cpu, setCpu] = useState<number[]>([])

  useEffect(() => {
    let alive = true
    const tick = async (): Promise<void> => {
      try {
        const m = await window.snApi.system.getMetrics()
        if (!alive) return
        setCurrent(m)
        setMem((prev) => [...prev, m.memMB].slice(-N))
        setCpu((prev) => [...prev, m.cpuPercent].slice(-N))
      } catch {
        /* ignore */
      }
    }
    void tick()
    const id = setInterval(tick, 1000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  return (
    <div className="space-y-5">
      <p className="text-sm text-text-secondary">{t('usage.hint')}</p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat icon={MemoryStick} label={t('usage.ram')} value={current ? `${current.memMB} MB` : '—'} />
        <Stat icon={Cpu} label={t('usage.cpu')} value={current ? `${current.cpuPercent}%` : '—'} />
        <Stat icon={Boxes} label={t('usage.processes')} value={current ? String(current.processes) : '—'} />
        <Stat icon={TerminalSquare} label={t('usage.consoles')} value={current ? String(current.consoles) : '—'} />
      </div>

      <Chart title={t('usage.ram')} unit=" MB" data={mem} color="var(--color-accent-violet)" />
      <Chart title={t('usage.cpu')} unit="%" data={cpu} color="var(--color-accent-blue)" max={100} />
    </div>
  )
}

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: ComponentType<{ size?: number; className?: string }>
  label: string
  value: string
}) {
  return (
    <div className="rounded-card border border-border bg-bg-secondary p-3">
      <div className="flex items-center gap-1.5 text-text-secondary">
        <Icon size={14} />
        <span className="text-[11px] uppercase tracking-wide">{label}</span>
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-text-primary">{value}</div>
    </div>
  )
}

function Chart({
  title,
  unit,
  data,
  color,
  max = 0,
}: {
  title: string
  unit: string
  data: number[]
  color: string
  max?: number
}) {
  const maxV = Math.max(max, ...data, 1)
  const last = data[data.length - 1] ?? 0
  const pts = data.map((v, i) => `${(i / (N - 1)) * 100},${H - (v / maxV) * H}`).join(' ')
  const lastX = (Math.max(0, data.length - 1) / (N - 1)) * 100

  return (
    <div className="rounded-card border border-border bg-bg-secondary p-3">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs font-medium text-text-secondary">{title}</span>
        <span className="text-xs tabular-nums text-text-primary">
          {last}
          {unit}
        </span>
      </div>
      <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" className="h-14 w-full overflow-hidden">
        {data.length > 1 && (
          <>
            <polygon fill={color} opacity={0.12} points={`0,${H} ${pts} ${lastX},${H}`} />
            <polyline
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
              points={pts}
            />
          </>
        )}
      </svg>
    </div>
  )
}
