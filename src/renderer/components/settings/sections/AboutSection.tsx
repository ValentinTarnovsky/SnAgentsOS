import { useT } from '@/i18n'
import { useAppInfo } from '@/lib/useAppInfo'
import { Logo } from '@/components/ui/Logo'

export function AboutSection() {
  const t = useT()
  const info = useAppInfo()

  return (
    <div className="space-y-6">
      <Logo size="lg" />
      <dl className="space-y-3 text-sm">
        <Row label={t('settings.about.version')} value={info?.version ?? '—'} />
        <Row
          label={t('settings.about.platform')}
          value={info ? `${info.platform} · ${info.arch}${info.portable ? ' · portable' : ''}` : '—'}
        />
        <Row label={t('settings.about.config')} value={info?.configPath ?? '—'} mono />
      </dl>
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
