import type { Language } from '@shared/types'
import { useAppStore } from '@/lib/store'
import { useT } from '@/i18n'
import { SettingRow } from '../ui'
import { cn } from '@/lib/cn'

const LANGS: { code: Language; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
]

export function LanguageSection() {
  const t = useT()
  const language = useAppStore((s) => s.settings.language)
  const updateSettings = useAppStore((s) => s.updateSettings)

  return (
    <div className="space-y-6">
      <SettingRow title={t('settings.language')} description={t('settings.languageHint')}>
        <div className="flex gap-2">
          {LANGS.map((l) => (
            <button
              key={l.code}
              onClick={() => updateSettings({ language: l.code })}
              className={cn(
                'rounded-btn border px-4 py-2 text-sm transition-colors',
                language === l.code
                  ? 'border-accent-violet bg-accent-violet/10 text-text-primary'
                  : 'border-border text-text-secondary hover:text-text-primary',
              )}
            >
              {l.label}
            </button>
          ))}
        </div>
      </SettingRow>
    </div>
  )
}
