import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Download, ExternalLink, Sparkles, X } from 'lucide-react'
import { useT } from '@/i18n'
import { useUpdaterStore } from '@/lib/updater'
import { cn } from '@/lib/cn'

type NoteKey =
  | 'update.portableNote'
  | 'update.installerNote'
  | 'update.openHint'
  | 'update.manualHint'

/** Maps the resolved install kind to the explanatory note shown under the button. */
function installNoteKey(kind: string): NoteKey {
  if (kind === 'win-portable' || kind === 'linux-appimage') return 'update.portableNote'
  if (kind === 'win-installer') return 'update.installerNote'
  if (kind === 'mac-dmg' || kind === 'linux-deb') return 'update.openHint'
  return 'update.manualHint'
}

/**
 * Startup "update available" prompt. Driven entirely by the updater store: the
 * app opens it (via openPrompt) when a newer release is detected on launch, and
 * it doubles as the live download-progress UI once the user accepts.
 */
export function UpdateModal() {
  const t = useT()
  const open = useUpdaterStore((s) => s.promptOpen)
  const info = useUpdaterStore((s) => s.info)
  const installing = useUpdaterStore((s) => s.installing)
  const progress = useUpdaterStore((s) => s.progress)
  const error = useUpdaterStore((s) => s.installError)
  const opened = useUpdaterStore((s) => s.opened)
  const install = useUpdaterStore((s) => s.install)
  const closePrompt = useUpdaterStore((s) => s.closePrompt)

  const close = (): void => {
    if (installing) return
    closePrompt()
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !installing) {
        e.preventDefault()
        closePrompt()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, installing, closePrompt])

  if (!open || !info || !info.available) return null

  const percent = progress?.percent ?? 0
  const noteKey = installNoteKey(info.installKind)

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/60" onClick={close} />
      <div className="relative z-10 flex w-full max-w-md flex-col overflow-hidden rounded-modal border border-border bg-card shadow-[0_20px_48px_-12px_rgba(0,0,0,0.6)]">
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-btn bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] text-white">
              <Sparkles size={16} />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-text-primary">{t('update.title')}</h2>
              <p className="text-xs text-text-secondary">
                {t('update.newVersion', { version: info.latestVersion ?? '' })}
              </p>
            </div>
          </div>
          <button
            onClick={close}
            disabled={installing}
            className="text-text-secondary transition-colors hover:text-text-primary disabled:opacity-40"
          >
            <X size={18} />
          </button>
        </div>

        <div className="min-h-0 space-y-4 overflow-y-auto px-5 py-4">
          <div className="flex items-center gap-2 text-xs text-text-secondary">
            <span className="rounded-btn border border-border px-2 py-0.5 font-mono">
              {info.currentVersion}
            </span>
            <span>→</span>
            <span className="rounded-btn border border-accent-violet/40 bg-accent-violet/10 px-2 py-0.5 font-mono text-text-primary">
              {info.latestVersion}
            </span>
          </div>

          {info.notes.trim().length > 0 && (
            <div>
              <div className="mb-1 text-xs font-medium text-text-secondary">
                {t('update.releaseNotes')}
              </div>
              <pre className="max-h-44 overflow-y-auto whitespace-pre-wrap break-words rounded-card border border-border bg-bg-secondary/50 p-3 text-xs leading-relaxed text-text-primary">
                {info.notes.trim()}
              </pre>
            </div>
          )}

          {installing && (
            <div className="space-y-1.5">
              <div className="h-2 w-full overflow-hidden rounded-full bg-bg-secondary">
                <div
                  className="h-full rounded-full bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] transition-[width] duration-150"
                  style={{ width: `${percent}%` }}
                />
              </div>
              <p className="text-xs text-text-secondary">
                {t('update.downloading', { percent })}
              </p>
            </div>
          )}

          {opened && <p className="text-xs text-emerald-400">{t('update.openedInstaller')}</p>}
          {error && (
            <p className="text-xs text-red-400">{t('update.installFailed', { error })}</p>
          )}
          {!installing && !opened && (
            <p className="text-xs text-text-secondary">{t(noteKey)}</p>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border bg-bg-secondary/40 px-5 py-3">
          <button
            onClick={() => info.releaseUrl && window.snApi.system.openExternal(info.releaseUrl)}
            disabled={!info.releaseUrl}
            className="flex items-center gap-1.5 text-xs text-text-secondary transition-colors hover:text-text-primary disabled:opacity-40"
          >
            <ExternalLink size={13} />
            {t('update.viewRelease')}
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={close}
              disabled={installing}
              className="rounded-btn border border-border px-4 py-2 text-sm text-text-primary transition-colors hover:bg-card disabled:opacity-40"
            >
              {t('update.later')}
            </button>
            {info.installable ? (
              <button
                onClick={() => void install()}
                disabled={installing || opened}
                className={cn(
                  'flex items-center gap-2 rounded-btn px-4 py-2 text-sm font-medium text-white transition-[filter]',
                  'bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] hover:brightness-110',
                  (installing || opened) && 'cursor-not-allowed opacity-60',
                )}
              >
                <Download size={15} />
                {installing ? t('update.installing') : t('update.updateNow')}
              </button>
            ) : (
              <button
                onClick={() => info.releaseUrl && window.snApi.system.openExternal(info.releaseUrl)}
                className="flex items-center gap-2 rounded-btn bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] px-4 py-2 text-sm font-medium text-white transition-[filter] hover:brightness-110"
              >
                <ExternalLink size={15} />
                {t('update.viewRelease')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
