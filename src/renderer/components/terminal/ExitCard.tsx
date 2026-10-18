import { AlertTriangle, RotateCw, X } from 'lucide-react'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'

export interface ExitCardProps {
  /** Exit code of the shell (-1 when it never started). */
  code: number
  /** The (re)spawn failed with this message. */
  error?: string
  onRestart: () => void
  onClose: () => void
}

/**
 * Card at the bottom of a pane whose shell ended on its own (E6-FR-17), or
 * whose respawn failed (E6-FR-18). The output above stays intact; [Restart]
 * respawns in place. Keyboard: Enter / Esc are handled by useXterm while the
 * pane is focused, so they never reach the dead pty. UX pattern after Orca's
 * process-exit overlay (no code taken).
 */
export function ExitCard({ code, error, onRestart, onClose }: ExitCardProps) {
  const t = useT()
  return (
    // Full-width lane so the card shrinks to the pane, never past it.
    <div className="pointer-events-none absolute inset-x-2 bottom-2 z-10 flex justify-center">
      <div
        role="alert"
        data-exit-card={error ? 'error' : 'exited'}
        className={cn(
          'pointer-events-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-x-3 gap-y-2 rounded-lg border bg-card/95 px-3 py-2 text-xs shadow-lg backdrop-blur',
          error ? 'border-amber-400/50' : 'border-border',
        )}
      >
        <div className="flex min-w-0 flex-1 basis-48 items-start gap-2">
          {error && <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-400" />}
          <div className="min-w-0">
            <div className="font-semibold text-text-primary">{t('exit.title')}</div>
            <div className="break-words text-text-secondary">
              {error ? t('exit.error', { message: error }) : t('exit.detail', { code })}
            </div>
            <div className="text-[10px] text-text-secondary/70">{t('exit.hint')}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1 rounded-btn border border-border px-2.5 py-1 text-text-primary transition-colors hover:bg-bg-secondary"
          >
            <X size={12} />
            {t('exit.close')}
          </button>
          <button
            type="button"
            data-exit-restart
            onClick={onRestart}
            className="flex items-center gap-1 rounded-btn bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] px-2.5 py-1 font-medium text-white transition-[filter] hover:brightness-110"
          >
            <RotateCw size={12} />
            {t('exit.restart')}
          </button>
        </div>
      </div>
    </div>
  )
}
