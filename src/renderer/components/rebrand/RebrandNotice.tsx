import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, FolderOpen, Loader2, Sparkles } from 'lucide-react'
import { BRAND, LEGACY_BRAND } from '@shared/brand'
import { useLang, useT } from '@/i18n'
import { cleanupStatus, formatBackupDate, shouldShowNotice, useLegacyStore } from '@/lib/legacyStore'

/**
 * "{legacy} is now {app}" (E0-FR-10). Opens once after a confirmed migration
 * that brought data over: what came along, how the automatic cleanup is going
 * (live through app:legacyStatus), where the safety zip is and when it goes,
 * and the few things only the user can do. [Got it] (initial focus, also Esc)
 * stores noticeSeen in the marker, so it never comes back.
 */
export function RebrandNotice() {
  const t = useT()
  const lang = useLang()
  const info = useLegacyStore((s) => s.info)
  const ack = useLegacyStore((s) => s.ack)
  const open = shouldShowNotice(info)
  const dialogRef = useRef<HTMLDivElement>(null)
  const okRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    okRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        ack()
        return
      }
      if (e.key !== 'Tab' || !dialogRef.current) return
      // Keep the keyboard inside the dialog while it is open.
      const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled])'))
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      const inside = dialogRef.current.contains(document.activeElement)
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, ack])

  if (!open || !info) return null

  const names = { legacy: LEGACY_BRAND.productName, app: BRAND.productName }
  const status = cleanupStatus(info)
  const counts = info.counts
  const rows: Array<[string, number]> = counts
    ? [
        [t('rebrand.count.workspaces'), counts.workspaces],
        [t('rebrand.count.devices'), counts.devices],
        [t('rebrand.count.backups'), counts.backups],
      ]
    : []
  const extras: string[] = []
  if (info.pinRetargeted === false) extras.push(t('rebrand.repin', names))
  for (const action of info.manualActions) extras.push(t(`rebrand.manual.${action}`, names))
  if (info.firewallHint) extras.push(t('rebrand.firewall', names))

  return createPortal(
    <div className="fixed inset-0 z-[85] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/60" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="rebrand-notice-title"
        className="relative z-10 flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-modal border border-border bg-card shadow-[0_20px_48px_-12px_rgba(0,0,0,0.6)]"
      >
        <div className="flex items-center gap-2.5 border-b border-border px-5 py-4">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-btn bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] text-white">
            <Sparkles size={16} />
          </span>
          <h2 id="rebrand-notice-title" className="text-sm font-semibold text-text-primary">
            {t('rebrand.title', names)}
          </h2>
        </div>

        <div className="min-h-0 space-y-4 overflow-y-auto px-5 py-4 text-sm">
          {rows.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-text-secondary">{t('rebrand.brought', names)}</p>
              <ul className="space-y-1">
                {rows.map(([label, n]) => (
                  <li key={label} className="flex items-center justify-between rounded-btn bg-bg-secondary/50 px-3 py-1.5">
                    <span className="text-text-primary">{label}</span>
                    <span className="font-mono text-text-secondary">{n}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="space-y-1">
            <p className="text-text-secondary">{t('rebrand.cleanup.intro', names)}</p>
            <p className="flex items-center gap-1.5 text-xs" aria-live="polite">
              {status === 'done' ? (
                <CheckCircle2 size={13} className="text-emerald-400" />
              ) : (
                <Loader2 size={13} className={status === 'running' ? 'animate-spin text-text-secondary' : 'text-amber-400'} />
              )}
              <span className={status === 'done' ? 'text-emerald-400' : 'text-text-secondary'}>
                {status === 'deferred'
                  ? t('rebrand.cleanup.deferred', { n: info.cleanup.deferred })
                  : t(status === 'done' ? 'rebrand.cleanup.done' : 'rebrand.cleanup.running')}
              </span>
            </p>
          </div>

          {info.backup && (
            <p className="break-all text-xs text-text-secondary">
              {t('rebrand.backup', { path: info.backup.path, date: formatBackupDate(info.backup.expiresAt, lang) })}
            </p>
          )}

          {extras.length > 0 && (
            <ul className="space-y-1.5 rounded-card border border-accent-violet/40 bg-accent-violet/5 p-3 text-xs text-text-primary">
              {extras.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border bg-bg-secondary/40 px-5 py-3">
          {info.backup && (
            <button
              onClick={() => window.snApi.app.legacyShowBackup()}
              className="flex items-center gap-1.5 rounded-btn border border-border px-4 py-2 text-sm text-text-primary transition-colors hover:bg-card"
            >
              <FolderOpen size={14} />
              {t('rebrand.showBackup')}
            </button>
          )}
          <button
            ref={okRef}
            onClick={ack}
            className="rounded-btn bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] px-4 py-2 text-sm font-medium text-white transition-[filter] hover:brightness-110"
          >
            {t('rebrand.ok')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
