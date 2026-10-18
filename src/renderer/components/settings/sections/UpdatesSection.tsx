import { useEffect } from 'react'
import { Check, Download, ExternalLink, FileText, RefreshCw } from 'lucide-react'
import { useAppStore } from '@/lib/store'
import { installErrorText, useUpdaterStore } from '@/lib/updater'
import { useAppInfo } from '@/lib/useAppInfo'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'
import { ToggleRow } from '../ui'
import { closesConsoles, needsDoubleConfirm, newerLabel } from '@/components/updates/update-card-visibility'
import { impactText, useDoubleConfirm, useUpdateImpact } from '@/components/updates/useUpdateImpact'

export function UpdatesSection() {
  const t = useT()
  const info = useAppInfo()
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)

  const result = useUpdaterStore((s) => s.info)
  const checking = useUpdaterStore((s) => s.checking)
  const installing = useUpdaterStore((s) => s.installing)
  const progress = useUpdaterStore((s) => s.progress)
  const error = useUpdaterStore((s) => s.error)
  const installError = useUpdaterStore((s) => s.installError)
  const opened = useUpdaterStore((s) => s.opened)
  const check = useUpdaterStore((s) => s.check)
  const install = useUpdaterStore((s) => s.install)
  const setNotesOpen = useUpdaterStore((s) => s.setNotesOpen)

  // Settings ignores a dismissed version (E4-FR-13) but keeps the impact
  // notice and the double confirm of the card (E4-FR-15).
  const kind = result?.installKind ?? 'none'
  const offer = !!result?.available && !!result.installable && !installing && !opened
  const { consoles, busy } = useUpdateImpact(offer && closesConsoles(kind))
  const confirm = useDoubleConfirm(offer && needsDoubleConfirm({ kind, busyAgents: busy }))
  const newer = newerLabel(result?.newerCount ?? 0)

  // Refresh on open so the status reflects reality without forcing a manual click.
  useEffect(() => {
    void check()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const current = result?.currentVersion ?? info?.version ?? '-'
  const percent = progress?.percent ?? 0

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex flex-col gap-0.5">
          <div className="text-xs font-medium text-text-secondary">{t('update.current')}</div>
          <div className="font-mono text-sm text-text-primary">{current}</div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => void check()}
            disabled={checking || installing}
            className="flex items-center gap-2 rounded-btn border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary transition-colors hover:border-accent-violet/40 disabled:opacity-50"
          >
            <RefreshCw size={15} className={cn(checking && 'animate-spin')} />
            {checking ? t('update.checking') : t('update.check')}
          </button>

          {result?.releaseUrl && (
            <button
              onClick={() => window.snApi.system.openExternal(result.releaseUrl as string)}
              className="flex items-center gap-1.5 text-xs text-text-secondary transition-colors hover:text-text-primary"
            >
              <ExternalLink size={13} />
              {t('update.viewRelease')}
            </button>
          )}
        </div>

        {/* Update available */}
        {!checking && result && result.available && (
          <div className="space-y-3 rounded-card border border-accent-violet/40 bg-accent-violet/5 p-3">
            <p className="text-sm text-text-primary">
              {t('update.newVersion', { version: result.latestVersion ?? '' })}
              {newer && (
                <span className="ml-2 text-xs text-accent-violet">
                  {newer.more ? t('update.card.newerMore', { count: newer.count }) : t('update.card.newer', { count: newer.count })}
                </span>
              )}
            </p>
            <button
              onClick={() => setNotesOpen(true)}
              className="flex items-center gap-1.5 text-xs text-text-secondary transition-colors hover:text-text-primary"
            >
              <FileText size={13} />
              {t('update.notes.open')}
            </button>

            {installing && (
              <div className="space-y-1.5">
                <div className="h-2 w-full overflow-hidden rounded-full bg-bg-secondary">
                  <div
                    className="h-full rounded-full bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] transition-[width] duration-150"
                    style={{ width: `${percent}%` }}
                  />
                </div>
                <p className="text-xs text-text-secondary">{t('update.downloading', { percent })}</p>
              </div>
            )}

            {opened && <p className="text-xs text-emerald-400">{t('update.openedInstaller')}</p>}
            {installError && (
              <p className="text-xs text-red-400">{installErrorText(t, installError)}</p>
            )}

            {offer && closesConsoles(kind) && consoles !== null && (
              <p className={cn('text-xs', busy > 0 ? 'text-amber-400' : 'text-text-secondary')}>
                {impactText(t, consoles, busy)}
              </p>
            )}

            {result.installable ? (
              <button
                onClick={() => {
                  if (confirm.click()) void install()
                }}
                disabled={installing || opened}
                className={cn(
                  'flex items-center gap-2 rounded-btn px-3 py-2 text-sm font-medium text-white transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60',
                  confirm.armed ? 'bg-red-500' : 'bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))]',
                )}
              >
                <Download size={15} />
                {installing
                  ? t('update.installing')
                  : confirm.armed
                    ? Math.max(consoles ?? 0, busy) === 1
                      ? t('update.impact.confirmOne')
                      : t('update.impact.confirm', { count: Math.max(consoles ?? 0, busy) })
                    : t('update.updateNow')}
              </button>
            ) : (
              <p className="text-xs text-text-secondary">{t('update.manualHint')}</p>
            )}
          </div>
        )}

        {/* Up to date */}
        {!checking && result && !result.available && !error && (
          <p className="flex items-center gap-1.5 text-sm text-emerald-400">
            <Check size={15} />
            {t('update.upToDate', { version: current })}
          </p>
        )}

        {/* Check failed */}
        {!checking && error && <p className="text-sm text-red-400">{t('update.failed')}</p>}
      </section>

      <div className="border-t border-border pt-5">
        <ToggleRow
          checked={settings.autoCheckUpdates}
          onChange={(v) => updateSettings({ autoCheckUpdates: v })}
          searchId="updates.autoCheck"
          title={t('update.autoCheck')}
          description={t('update.autoCheckHint')}
        />
      </div>
    </div>
  )
}
