import type { DictationEngine, DictationSettings } from '@shared/types'
import { VOICE_LANGS } from '@shared/voiceText'
import { useAppStore } from '@/lib/store'
import { useT } from '@/i18n'
import { SettingRow, ToggleRow, inputCls } from '../ui'

const ENGINES: DictationEngine[] = ['auto', 'online', 'offline']

/**
 * Desktop dictation (app 2.4.0, settings.dictation): engine, language and the
 * header mic. Shown under Terminal; the recognizer is Windows' own.
 */
export function DictationSettingsBlock() {
  const t = useT()
  const dictation = useAppStore((s) => s.settings.dictation)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const patch = (p: Partial<DictationSettings>): void => updateSettings({ dictation: { ...dictation, ...p } })
  // A tag saved by hand (any BCP 47 the schema accepts) stays selectable.
  const langs: string[] = [...VOICE_LANGS]
  if (dictation.language && !langs.includes(dictation.language)) langs.push(dictation.language)
  return (
    <section className="space-y-3 border-t border-border pt-5" aria-labelledby="terminal-dictation" data-dictation-settings>
      <h4 id="terminal-dictation" className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
        {t('settings.dictation.group')}
      </h4>
      <SettingRow searchId="terminal.dictationEngine" title={t('settings.dictation.engine')} description={t('settings.dictation.engineHint')}>
        <select
          className={inputCls}
          value={dictation.engine}
          data-dictation-engine-select
          onChange={(e) => patch({ engine: e.target.value as DictationEngine })}
        >
          {ENGINES.map((en) => (
            <option key={en} value={en}>
              {t(en === 'auto' ? 'settings.dictation.engineAuto' : en === 'online' ? 'settings.dictation.engineOnline' : 'settings.dictation.engineOffline')}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow searchId="terminal.dictationLanguage" title={t('settings.dictation.language')} description={t('settings.dictation.languageHint')}>
        <select className={inputCls} value={dictation.language} data-dictation-lang-select onChange={(e) => patch({ language: e.target.value })}>
          {langs.map((l) => (
            <option key={l} value={l}>
              {l === 'auto' ? t('settings.dictation.languageAuto') : l}
            </option>
          ))}
        </select>
      </SettingRow>
      <ToggleRow
        checked={dictation.headerButton !== false}
        onChange={(v) => patch({ headerButton: v })}
        searchId="terminal.dictationHeaderButton"
        title={t('settings.dictation.headerButton')}
        description={t('settings.dictation.headerButtonHint')}
      />
    </section>
  )
}
