import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Clock } from 'lucide-react'
import type { PaneSchedule } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { nextOccurrence } from '@/lib/usePaneScheduler'
import { useT } from '@/i18n'

interface ScheduleDialogProps {
  workspaceId: string
  paneId: string
  paneTitle: string
  schedule?: PaneSchedule
  onClose: () => void
}

/** Default the time picker to ~5 minutes out so "now" never auto-fires. */
function defaultTime(): string {
  const d = new Date(Date.now() + 5 * 60_000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * Per-console scheduler: pick a wall-clock time and a prompt; on save we store a
 * one-shot schedule on the pane that the renderer ticker fires once it's due.
 * Mounted only while open, so its state always reflects the current schedule.
 */
export function ScheduleDialog({
  workspaceId,
  paneId,
  paneTitle,
  schedule,
  onClose,
}: ScheduleDialogProps) {
  const t = useT()
  const setPaneSchedule = useAppStore((s) => s.setPaneSchedule)
  const [time, setTime] = useState(schedule?.time ?? defaultTime())
  const [prompt, setPrompt] = useState(schedule?.prompt ?? '')

  const canSave = time.length > 0 && prompt.trim().length > 0

  const save = (): void => {
    if (!canSave) return
    setPaneSchedule(workspaceId, paneId, { time, prompt: prompt.trim(), dueAt: nextOccurrence(time) })
    onClose()
  }
  const remove = (): void => {
    setPaneSchedule(workspaceId, paneId, null)
    onClose()
  }

  return createPortal(
    <div className="fixed inset-0 z-[75] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md overflow-hidden rounded-modal border border-border bg-card shadow-[0_20px_48px_-12px_rgba(0,0,0,0.6)]">
        <div className="space-y-4 p-5">
          <div className="flex items-center gap-2">
            <Clock size={16} className="text-accent-violet" />
            <h2 className="text-sm font-semibold text-text-primary">{t('schedule.title')}</h2>
          </div>
          <p className="-mt-1 truncate text-xs text-text-secondary">{paneTitle}</p>

          {schedule && (
            <div className="flex items-center gap-2 rounded-btn border border-accent-violet/30 bg-accent-violet/10 px-3 py-2 text-xs text-text-primary">
              <Clock size={13} className="shrink-0 text-accent-violet" />
              <span>{t('schedule.active', { time: schedule.time })}</span>
            </div>
          )}

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-text-secondary">{t('schedule.time')}</span>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="w-full rounded-btn border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-violet/60"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-text-secondary">{t('schedule.prompt')}</span>
            <textarea
              autoFocus
              rows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  save()
                }
              }}
              placeholder={t('schedule.promptPlaceholder')}
              className="w-full resize-none rounded-btn border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-violet/60"
            />
          </label>

          <p className="text-xs text-text-secondary/80">{t('schedule.hint')}</p>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border bg-bg-secondary/40 px-5 py-3">
          {schedule ? (
            <button
              onClick={remove}
              className="rounded-btn border border-red-400/40 px-3 py-2 text-sm font-medium text-red-400 transition-colors hover:bg-red-400/10"
            >
              {t('schedule.remove')}
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-btn border border-border px-4 py-2 text-sm text-text-primary transition-colors hover:bg-card"
            >
              {t('schedule.cancel')}
            </button>
            <button
              onClick={save}
              disabled={!canSave}
              className="rounded-btn bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] px-4 py-2 text-sm font-medium text-white transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {schedule ? t('schedule.update') : t('schedule.save')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
