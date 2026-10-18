/**
 * "Text size: 100%" in Settings (E2-FR-34): the same presets the pinch snaps
 * to, instead of the old per-pixel +/-. The choice is a multiplier on the
 * auto-fit size, saved in 'snagentsos.fontScale'.
 */
import type { ReactNode } from 'react'
import { clsx } from 'clsx'
import { useRemoteStore } from '../lib/store'
import { FONT_SCALE_PRESETS } from '../lib/fit'
import { t } from '../lib/i18n'

export function FontScaleRow(): ReactNode {
  const fontScale = useRemoteStore((s) => s.fontScale)
  const setFontScale = useRemoteStore((s) => s.setFontScale)
  return (
    <div data-font-scale={fontScale}>
      <span className="mb-2 block text-sm text-text-primary">{t('set.textSize', { pct: Math.round(fontScale * 100) })}</span>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('set.textSizeLabel')}>
        {FONT_SCALE_PRESETS.map((p) => (
          <button
            key={p}
            role="radio"
            aria-checked={fontScale === p}
            data-scale={p}
            onClick={() => setFontScale(p)}
            className={clsx(
              'min-h-10 min-w-12 rounded-btn border px-2.5 py-1.5 text-xs font-medium transition',
              fontScale === p
                ? 'border-accent-violet bg-accent-violet text-white'
                : 'border-border bg-card text-text-primary active:bg-bg-primary',
            )}
          >
            {Math.round(p * 100)}%
          </button>
        ))}
      </div>
    </div>
  )
}
