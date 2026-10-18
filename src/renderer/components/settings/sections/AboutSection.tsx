import { useState } from 'react'
import { Copy, Loader2 } from 'lucide-react'
import { useT } from '@/i18n'
import { useAppInfo } from '@/lib/useAppInfo'
import { copyDiagnostics } from '@/lib/renderErrors'
import { Logo } from '@/components/ui/Logo'
import { Button } from '@/components/ui/Button'

export function AboutSection() {
  const t = useT()
  const info = useAppInfo()

  return (
    <div className="space-y-6">
      <Logo size="lg" />
      <dl className="space-y-3 text-sm">
        <Row label={t('settings.about.version')} value={info?.version ?? '-'} />
        <Row
          label={t('settings.about.platform')}
          value={info ? `${info.platform} · ${info.arch}${info.portable ? ' · portable' : ''}` : '-'}
        />
        <Row label={t('settings.about.config')} value={info?.configPath ?? '-'} mono />
      </dl>
      <DiagnosticsRow />
    </div>
  )
}

/** "Copy diagnostics" (E4-FR-24): allowlisted and redacted in main. */
function DiagnosticsRow() {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const run = (): void => {
    setBusy(true)
    void copyDiagnostics().finally(() => setBusy(false))
  }
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4">
      <div className="text-xs font-medium text-text-secondary">{t('settings.about.diagnostics')}</div>
      <p className="text-xs text-text-secondary">{t('settings.about.diagnosticsHint')}</p>
      <div>
        <Button size="sm" variant="ghost" data-copy-diagnostics disabled={busy} onClick={run}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Copy size={16} />}
          {t('crash.copyDiagnostics')}
        </Button>
      </div>
    </div>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium text-text-secondary">{label}</dt>
      <dd className={`truncate text-text-primary ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </div>
  )
}
