import { FlaskConical } from 'lucide-react'
import { labOn } from '@shared/labs'
import { useAppStore } from '@/lib/store'
import { useT } from '@/i18n'
import { VoiceSettingsBlock } from './VoiceSettingsBlock'

/**
 * Settings > Voz (app 2.11.0): the hands-free voice settings. They can be set
 * before the lab is on; until it is, the section says where to turn it on and
 * nothing listens or speaks.
 */
export function VoiceSection() {
  const t = useT()
  const lab = useAppStore((s) => labOn(s.settings, 'voice'))
  const openSettings = useAppStore((s) => s.openSettings)
  return (
    <div className="space-y-6">
      {!lab && (
        <button type="button" onClick={() => openSettings('labs')} data-voice-lab-off className="flex w-full items-center gap-2 rounded-btn border border-border bg-bg-secondary px-3 py-2 text-left text-xs text-text-secondary hover:border-accent-violet/40">
          <FlaskConical size={14} className="shrink-0" />
          <span>{t('settings.voice.labOff')}</span>
        </button>
      )}
      <VoiceSettingsBlock />
    </div>
  )
}
