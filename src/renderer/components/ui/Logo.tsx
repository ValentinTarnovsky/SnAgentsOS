import { cn } from '@/lib/cn'

type Size = 'sm' | 'md' | 'lg'

const markPx: Record<Size, number> = { sm: 24, md: 30, lg: 40 }
const textCls: Record<Size, string> = {
  sm: 'text-[13px]',
  md: 'text-[15px]',
  lg: 'text-[20px]',
}

export function LogoMark({
  size = 'md',
  className,
  gradientId = 'snLogoGrad',
}: {
  size?: Size
  className?: string
  gradientId?: string
}) {
  const px = markPx[size]
  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden
      className={cn('shrink-0', className)}
    >
      <defs>
        <linearGradient
          id={gradientId}
          x1="2"
          y1="2"
          x2="30"
          y2="30"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#6366F1" />
          <stop offset="0.55" stopColor="#8B5CF6" />
          <stop offset="1" stopColor="#60A5FA" />
        </linearGradient>
      </defs>
      <g
        stroke={`url(#${gradientId})`}
        strokeWidth="5.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      >
        <polyline points="11.5,6.5 4.5,16 11.5,25.5" />
        <polyline points="20.5,6.5 27.5,16 20.5,25.5" />
        <line x1="19.5" y1="5" x2="12.5" y2="27" strokeWidth="4.2" />
      </g>
    </svg>
  )
}

export function Logo({
  size = 'md',
  withWordmark = true,
  gradientId,
  className,
}: {
  size?: Size
  withWordmark?: boolean
  gradientId?: string
  className?: string
}) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark size={size} gradientId={gradientId} />
      {withWordmark && (
        <span className={cn('font-semibold tracking-tight leading-none', textCls[size])}>
          <span className="bg-clip-text text-transparent bg-gradient-to-br from-accent-violet via-accent-purple to-accent-blue">
            Sn
          </span>
          <span className="text-text-primary">AgentsOS</span>
        </span>
      )}
    </span>
  )
}
