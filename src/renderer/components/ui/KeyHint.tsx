import type { ReactNode } from 'react'
import { CornerDownLeft } from 'lucide-react'
import { useAppStore } from '@/lib/store'
import { accelParts, resolveKeymap, type ActionId } from '@/lib/keymap'
import { cn } from '@/lib/cn'

/** Where the chip sits: on an accent (primary) button or on a neutral surface. */
export type KeyHintTone = 'onAccent' | 'muted'

/**
 * The keys of a remappable action, from the live keymap (E4-FR-30): rebinding
 * it re-renders the chip without a restart. Pass null to skip the lookup.
 */
export function useActionKeys(action: ActionId | null): string[] {
  const accel = useAppStore((s) => (action ? resolveKeymap(s.settings.keymap)[action] : ''))
  return accelParts(accel)
}

/**
 * One small chip per key (E4-FR-29), Enter drawn as an icon. Decorative: the
 * button that carries it exposes the shortcut through aria-keyshortcuts.
 */
export function KeyHint({
  keys,
  tone = 'muted',
  className,
}: {
  keys: string[]
  tone?: KeyHintTone
  className?: string
}) {
  if (keys.length === 0) return null
  return (
    <span aria-hidden="true" data-key-hint={keys.join('+')} className={cn('inline-flex shrink-0 items-center gap-0.5', className)}>
      {keys.map((k, i) => (
        <kbd
          key={i}
          className={cn(
            'inline-flex h-4 min-w-4 items-center justify-center rounded border px-1 font-mono text-[10px] font-medium leading-none',
            tone === 'onAccent'
              ? 'border-white/35 bg-white/15 text-white'
              : 'border-border bg-bg-secondary text-text-secondary',
          )}
        >
          {k === 'Enter' ? <CornerDownLeft size={10} strokeWidth={2.25} /> : k}
        </kbd>
      ))}
    </span>
  )
}

/** A tooltip label followed by the action's current chip (E4-FR-30). */
export function ActionTooltipLabel({ label, action }: { label: ReactNode; action: ActionId }) {
  const keys = useActionKeys(action)
  return (
    <span className="inline-flex items-center gap-2" data-action-tip={action}>
      <span>{label}</span>
      <KeyHint keys={keys} />
    </span>
  )
}
