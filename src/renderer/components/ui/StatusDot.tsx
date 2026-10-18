import { useEffect, useState, type ReactNode } from 'react'
import { Check, Moon } from 'lucide-react'
import type { ClaudePaneState, PaneStatus } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { useLang, useT, type MessageKey } from '@/i18n'
import { statusTipLines, STATUS_LABEL_KEY } from '@/lib/formatSince'
import { Tooltip } from '@/components/ui/Tooltip'
import { cn } from '@/lib/cn'

/** Hover delay of every status tooltip (E4-FR-10, E5-FR-20). */
export const STATUS_TIP_DELAY = 200
/** A status tooltip left open refreshes its "since" text this often. */
const TIP_REFRESH_MS = 30_000

const DOT_CLASS: Record<ClaudePaneState, string> = {
  working: 'bg-[#8B5CF6] animate-pulse motion-reduce:animate-none',
  done: 'bg-[#22C55E]',
  action: 'bg-[#F59E0B] ring-2 ring-[#F59E0B]/30',
  idle: 'bg-[#6B7280]',
  error: 'bg-[#EF4444] ring-2 ring-[#EF4444]/30',
  unknown: 'bg-transparent ring-1 ring-text-secondary',
}

/** Tooltip lines as separate nodes, computed when it opens and every 30 s while open. */
function StatusTip({ status }: { status: PaneStatus }) {
  const t = useT()
  const lang = useLang()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TIP_REFRESH_MS)
    return () => clearInterval(id)
  }, [])
  return (
    <span className="flex flex-col" data-status-tip>
      {statusTipLines(status, t, lang, now).map((line, i) => (
        <span key={i} className={i === 0 ? undefined : 'font-normal text-text-secondary'}>
          {line}
        </span>
      ))}
    </span>
  )
}

/**
 * Live agent state dot for one console. Renders nothing while no agent
 * session is detected in the pane, so plain shells stay untouched.
 */
export function PaneStatusDot({ paneId, size = 7, noTooltip }: { paneId: string; size?: number; noTooltip?: boolean }) {
  const status = useAppStore((s) => s.paneStatus[paneId])
  return <StatusDot status={status} size={size} noTooltip={noTooltip} />
}

/**
 * Status dot with its themed tooltip (E4-FR-10): "Claude - <state>", how long
 * ago, "(approximate)" and the pending count, each on its own line. `tip`
 * replaces that content (the sidebar's per-workspace summary); `noTooltip`
 * leaves the hover to a parent tooltip. The aria-label carries the full text.
 */
export function StatusDot({
  status,
  size = 8,
  label,
  tip,
  noTooltip,
}: {
  status?: PaneStatus
  size?: number
  label?: string
  tip?: ReactNode
  noTooltip?: boolean
}) {
  const t = useT()
  const lang = useLang()
  if (!status) return null
  const aria = label ?? statusTipLines(status, t, lang, Date.now()).join(', ')
  const dot = (
    <span
      role="img"
      aria-label={aria}
      data-status-dot={status.state}
      className={cn('inline-block shrink-0 rounded-full', DOT_CLASS[status.state])}
      style={{ width: size, height: size }}
    />
  )
  if (noTooltip) return dot
  return (
    <Tooltip label={tip ?? <StatusTip status={status} />} delay={STATUS_TIP_DELAY} className="shrink-0">
      {dot}
    </Tooltip>
  )
}

/** Glyph kinds (E5-FR-20): the agent states plus sleeping and not started. */
export type GlyphKind = ClaudePaneState | 'sleeping' | 'notStarted'

const GLYPH_LABEL: Record<GlyphKind, MessageKey> = {
  ...STATUS_LABEL_KEY,
  sleeping: 'agents.glyph.sleeping',
  notStarted: 'agents.glyph.notStarted',
}

/**
 * Shared glyph vocabulary of the palette, the sidebar agent rows and the
 * board (E5-FR-20): a ring spinner while working (static with reduced
 * motion), an amber "?" waiting on you, an emerald check for an unread done
 * (a dot once seen), a gray dot idle, a red "!" on error, a dotted ring when
 * unknown or not started, and a moon while sleeping. Every glyph has an
 * aria-label and a 200 ms tooltip (unless `noTooltip`).
 */
export function StatusGlyph({
  kind,
  unread,
  size = 14,
  label,
  tip,
  noTooltip,
}: {
  kind: GlyphKind
  /** done only: not looked at yet. */
  unread?: boolean
  size?: number
  label?: string
  tip?: ReactNode
  noTooltip?: boolean
}) {
  const t = useT()
  const text = label ?? t(GLYPH_LABEL[kind])
  const inner = Math.max(8, Math.round(size * 0.72))
  const font = Math.max(8, Math.round(size * 0.7))
  let body: ReactNode
  switch (kind) {
    case 'working':
      body = (
        <span
          className="block rounded-full border-2 border-[#8B5CF6]/30 border-t-[#8B5CF6] animate-spin motion-reduce:animate-none"
          style={{ width: inner, height: inner }}
        />
      )
      break
    case 'action':
    case 'error':
      body = (
        <span
          className={cn('flex items-center justify-center rounded-full font-bold leading-none text-white', kind === 'action' ? 'bg-[#F59E0B]' : 'bg-[#EF4444]')}
          style={{ width: size, height: size, fontSize: font }}
        >
          {kind === 'action' ? '?' : '!'}
        </span>
      )
      break
    case 'done':
      body = unread ? (
        <span className="flex items-center justify-center rounded-full bg-[#10B981] text-white" style={{ width: size, height: size }}>
          <Check size={Math.max(8, size - 4)} strokeWidth={3} />
        </span>
      ) : (
        <span className="block rounded-full bg-[#10B981]" style={{ width: size / 2, height: size / 2 }} />
      )
      break
    case 'idle':
      body = <span className="block rounded-full bg-[#6B7280]" style={{ width: size / 2, height: size / 2 }} />
      break
    case 'sleeping':
      body = <Moon size={size - 2} className="text-text-secondary" />
      break
    default:
      body = <span className="block rounded-full border border-dashed border-text-secondary" style={{ width: inner, height: inner }} />
  }
  const glyph = (
    <span
      role="img"
      aria-label={text}
      data-glyph={kind === 'done' && unread ? 'done-unread' : kind}
      className="inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
    >
      {body}
    </span>
  )
  if (noTooltip) return glyph
  return (
    <Tooltip label={tip ?? text} delay={STATUS_TIP_DELAY} className="shrink-0">
      {glyph}
    </Tooltip>
  )
}
