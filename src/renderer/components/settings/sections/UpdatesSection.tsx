import { useEffect } from 'react'
import { Check, Download, ExternalLink, RefreshCw } from 'lucide-react'
import { useAppStore } from '@/lib/store'
import { useUpdaterStore } from '@/lib/updater'
import { useAppInfo } from '@/lib/useAppInfo'
import { useT } from '@/i18n'
import { cn } from '@/lib/cn'
import { ToggleRow } from '../ui'

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
            </p>

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
              <p className="text-xs text-red-400">{t('update.installFailed', { error: installError })}</p>
            )}

            {result.installable ? (
              <button
                onClick={() => void install()}
                disabled={installing || opened}
                className="flex items-center gap-2 rounded-btn bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] px-3 py-2 text-sm font-medium text-white transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Download size={15} />
                {installing ? t('update.installing') : t('update.updateNow')}
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
          title={t('update.autoCheck')}
          description={t('update.autoCheckHint')}
        />
      </div>
    </div>
  )
}
