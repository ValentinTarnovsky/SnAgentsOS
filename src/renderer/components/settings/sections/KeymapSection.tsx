import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { useAppStore } from '@/lib/store'
import { useT } from '@/i18n'
import {
  KEY_ACTIONS,
  eventToAccel,
  formatAccel,
  resolveKeymap,
  type ActionId,
} from '@/lib/keymap'
import { cn } from '@/lib/cn'

export function KeymapSection() {
  const t = useT()
  const keymap = useAppStore((s) => s.settings.keymap)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [recording, setRecording] = useState<ActionId | null>(null)

  const resolved = resolveKeymap(keymap)
  const counts: Record<string, number> = {}
  for (const a of KEY_ACTIONS) counts[resolved[a.id]] = (counts[resolved[a.id]] ?? 0) + 1

  const setAccel = (id: ActionId, accel: string): void =>
    updateSettings({ keymap: { ...keymap, [id]: accel } })
  const reset = (id: ActionId): void => {
    const next = { ...keymap }
    delete next[id]
    updateSettings({ keymap: next })
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-text-secondary">{t('keys.hint')}</p>

      {KEY_ACTIONS.map((a) => {
        const acc = resolved[a.id]
        const conflict = counts[acc] > 1
        const rec = recording === a.id
        return (
          <div
            key={a.id}
            className="flex items-center gap-3 rounded-card border border-border bg-bg-secondary px-3 py-2"
          >
            <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
              {t(a.labelKey)}
            </span>
            {conflict && <span className="shrink-0 text-[11px] text-amber-400">{t('keys.conflict')}</span>}
            <button
              onClick={() => setRecording(a.id)}
              onBlur={() => setRecording(null)}
              onKeyDown={(e) => {
                if (!rec) return
                e.preventDefault()
                if (e.key === 'Escape') {
                  setRecording(null)
                  return
                }
                const accel = eventToAccel(e.nativeEvent)
                if (accel) {
                  setAccel(a.id, accel)
                  setRecording(null)
                }
              }}
              className={cn(
                'h-8 min-w-[150px] rounded-btn border px-3 text-center font-mono text-xs transition-colors',
                rec
                  ? 'border-accent-violet bg-accent-violet/5 text-text-primary'
                  : conflict
                    ? 'border-amber-400/50 text-text-primary'
                    : 'border-border text-text-primary hover:border-accent-violet/40',
              )}
            >
              {rec ? t('keys.recording') : formatAccel(acc)}
            </button>
            <button
              onClick={() => reset(a.id)}
              title={t('keys.reset')}
              className="shrink-0 rounded p-1.5 text-text-secondary transition-colors hover:text-text-primary"
            >
              <RotateCcw size={14} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
