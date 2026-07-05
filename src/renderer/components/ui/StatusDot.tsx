import type { ClaudePaneState } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { useT, type MessageKey } from '@/i18n'
import { cn } from '@/lib/cn'

const DOT_CLASS: Record<ClaudePaneState, string> = {
  working: 'bg-[#8B5CF6] animate-pulse',
  done: 'bg-[#22C55E]',
  action: 'bg-[#F59E0B] ring-2 ring-[#F59E0B]/30',
  idle: 'bg-[#6B7280]',
}

const LABEL_KEY: Record<ClaudePaneState, MessageKey> = {
  working: 'status.working',
  done: 'status.done',
  action: 'status.action',
  idle: 'status.idle',
}

/**
 * Live Claude state dot for one console. Renders nothing while no Claude
 * session is detected in the pane, so plain shells stay untouched.
 */
export function PaneStatusDot({ paneId, size = 7 }: { paneId: string; size?: number }) {
  const status = useAppStore((s) => s.paneStatus[paneId])
  const t = useT()
  if (!status) return null
  return (
    <span
      title={t(LABEL_KEY[status.state])}
      className={cn('shrink-0 rounded-full', DOT_CLASS[status.state])}
      style={{ width: size, height: size }}
    />
  )
}
