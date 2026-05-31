import { useState } from 'react'
import { Download, Upload } from 'lucide-react'
import type { ConfigFile } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { snapshotConfig } from '@/lib/persist'
import { useT } from '@/i18n'

export function DataSection() {
  const t = useT()
  const importConfig = useAppStore((s) => s.importConfig)
  const mergeConfig = useAppStore((s) => s.mergeConfig)

  const [pending, setPending] = useState<ConfigFile | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const onExport = async (): Promise<void> => {
    const ok = await window.snApi.config.export(snapshotConfig())
    if (ok) setMsg(t('data.exported'))
  }
  const onImport = async (): Promise<void> => {
    setMsg(null)
    const cfg = await window.snApi.config.import()
    if (cfg) setPending(cfg)
  }

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div>
          <div className="text-sm font-medium text-text-primary">{t('data.backup')}</div>
          <p className="mt-0.5 text-xs text-text-secondary">{t('data.exportHint')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={onExport}
            className="flex items-center gap-2 rounded-btn border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary transition-colors hover:border-accent-violet/40"
          >
            <Download size={15} />
            {t('data.export')}
          </button>
          <button
            onClick={onImport}
            className="flex items-center gap-2 rounded-btn border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary transition-colors hover:border-accent-violet/40"
          >
            <Upload size={15} />
            {t('data.import')}
          </button>
          {msg && <span className="text-xs text-emerald-400">{msg}</span>}
        </div>

        {pending && (
          <div className="space-y-2 rounded-card border border-accent-violet/40 bg-accent-violet/5 p-3">
            <p className="text-sm text-text-primary">{t('data.importChoose')}</p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => {
                  importConfig(pending)
                  setPending(null)
                  setMsg(t('data.imported'))
                }}
                className="rounded-btn bg-red-500 px-3 py-1.5 text-sm font-medium text-white hover:brightness-110"
              >
                {t('data.replace')}
              </button>
              <button
                onClick={() => {
                  mergeConfig(pending)
                  setPending(null)
                  setMsg(t('data.merged'))
                }}
                className="rounded-btn bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] px-3 py-1.5 text-sm font-medium text-white hover:brightness-110"
              >
                {t('data.merge')}
              </button>
              <button
                onClick={() => setPending(null)}
                className="rounded-btn border border-border px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary"
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
