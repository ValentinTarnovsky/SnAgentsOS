import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLink, Sparkles, X } from 'lucide-react'
import type { ReleaseSummary, UpdateInfo } from '@shared/ipc-contract'
import { useT } from '@/i18n'
import { useUpdaterStore } from '@/lib/updater'
import { Markdown } from '@/components/ui/Markdown'
import { isFromToast } from '@/lib/toast'

/** The releases to list: main's `missed` (newest first), else the offered one alone. */
export function notesSections(info: UpdateInfo): ReleaseSummary[] {
  if (info.missed && info.missed.length > 0) return info.missed
  if (!info.latestVersion) return []
  return [{ version: info.latestVersion, notes: info.notes, url: info.releaseUrl, publishedAt: null }]
}

/**
 * Release notes of every version the user is behind on, newest first
 * (E4-FR-12, 14). Only opened from "View full notes" on the update card and
 * from Settings > Updates; installing happens from the card or Settings.
 */
export function ReleaseNotesModal() {
  const t = useT()
  const open = useUpdaterStore((s) => s.notesOpen)
  const info = useUpdaterStore((s) => s.info)
  const setNotesOpen = useUpdaterStore((s) => s.setNotesOpen)
  const close = (): void => setNotesOpen(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setNotesOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, setNotesOpen])

  if (!open || !info) return null
  const sections = notesSections(info)

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/60" onClick={(e) => { if (!isFromToast(e)) close() }} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('update.notes.title')}
        data-release-notes=""
        className="relative z-10 flex max-h-[min(640px,calc(100vh-48px))] w-full max-w-lg flex-col overflow-hidden rounded-modal border border-border bg-card shadow-[0_20px_48px_-12px_rgba(0,0,0,0.6)]"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-btn bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] text-white">
              <Sparkles size={16} />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-text-primary">{t('update.notes.title')}</h2>
              <p className="font-mono text-xs text-text-secondary">
                {info.currentVersion} → {info.latestVersion ?? ''}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label={t('common.close')}
            className="text-text-secondary transition-colors hover:text-text-primary"
          >
            <X size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {sections.map((r) => (
            <section key={r.version} data-release-version={r.version} className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-mono text-xs font-semibold text-text-primary">v{r.version}</h3>
                {r.url && (
                  <button
                    type="button"
                    onClick={() => void window.snApi.system.openExternal(r.url as string)}
                    className="flex items-center gap-1 text-xs text-text-secondary transition-colors hover:text-text-primary"
                  >
                    <ExternalLink size={12} />
                    {t('update.viewRelease')}
                  </button>
                )}
              </div>
              <div className="break-words rounded-card border border-border bg-bg-secondary/50 p-3 text-xs leading-relaxed">
                {r.notes.trim() ? (
                  <Markdown source={r.notes.trim()} />
                ) : (
                  <p className="text-text-secondary">{t('update.notes.empty')}</p>
                )}
              </div>
            </section>
          ))}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border bg-bg-secondary/40 px-5 py-3">
          <button
            type="button"
            onClick={close}
            className="rounded-btn border border-border px-4 py-2 text-sm text-text-primary transition-colors hover:bg-card"
          >
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
