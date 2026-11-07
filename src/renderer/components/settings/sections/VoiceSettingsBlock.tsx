import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Check, Download, Loader2, Play, Trash2, X } from 'lucide-react'
import { formatBytes, isWhisperInstallError } from '@shared/dictation'
import { VOICE_LIMITS, type VoiceGender, type VoiceInstallProgress, type VoiceSettings, type VoiceStatus } from '@shared/voice'
import { useAppStore } from '@/lib/store'
import { useLang, useT, type MessageKey } from '@/i18n'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { SettingRow, ToggleRow, inputCls } from '../ui'

const headingCls = 'text-xs font-semibold uppercase tracking-wide text-text-secondary'
const ghostBtn =
  'inline-flex items-center gap-1.5 rounded-btn border border-border px-2.5 py-1 text-xs text-text-primary transition-colors hover:bg-card hover:border-accent-violet/40 disabled:pointer-events-none disabled:opacity-50'

function api() {
  return typeof window !== 'undefined' ? window.snApi?.voice : undefined
}

function Choice<T extends string>({ value, options, onChange, label, disabled }: { value: T; options: Array<{ v: T; key: MessageKey }>; onChange: (v: T) => void; label: string; disabled?: boolean }) {
  const t = useT()
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          disabled={disabled}
          onClick={() => onChange(o.v)}
          className={cn(
            'rounded-btn border px-3 py-1 text-xs transition-colors disabled:pointer-events-none disabled:opacity-50',
            value === o.v ? 'border-accent-violet bg-accent-violet text-white' : 'border-border bg-bg-secondary text-text-primary hover:border-accent-violet/40',
          )}
        >
          {t(o.key)}
        </button>
      ))}
    </div>
  )
}

/** A number field that commits on blur or Enter, clamped to [min, max]. */
function NumberField({ value, min, max, step = 1, onCommit, label }: { value: number; min: number; max: number; step?: number; onCommit: (v: number) => void; label: string }) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (): void => {
    if (draft === null) return
    const n = Number(draft)
    if (draft.trim() && Number.isFinite(n)) onCommit(Math.min(max, Math.max(min, step < 1 ? Math.round(n / step) * step : Math.round(n))))
    setDraft(null)
  }
  return (
    <input
      type="number"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={draft ?? String(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
      className={cn(inputCls, 'w-28')}
    />
  )
}

/**
 * Settings > Labs > Voz (app 2.11.0): hands-free, the local voice pack, the
 * narration and ElevenLabs. Shown only with the Voice lab on. The ElevenLabs
 * key is write-only: main keeps it sealed and only says whether one is set.
 */
export function VoiceSettingsBlock() {
  const t = useT()
  const lang = useLang()
  const voice = useAppStore((s) => s.settings.voice)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  const [progress, setProgress] = useState<VoiceInstallProgress | null>(null)
  const [key, setKey] = useState('')
  const [warmAsk, setWarmAsk] = useState<{ n: number; chars: number } | null>(null)

  const patch = useCallback(
    (p: Partial<VoiceSettings>): void => {
      const cur = useAppStore.getState().settings.voice
      updateSettings({ voice: { ...cur, ...p } })
    },
    [updateSettings],
  )
  const patchIn = <K extends 'narration' | 'tts' | 'eleven'>(k: K, p: Partial<VoiceSettings[K]>): void => {
    const cur = useAppStore.getState().settings.voice
    updateSettings({ voice: { ...cur, [k]: { ...cur[k], ...p } } })
  }

  const refresh = useCallback((): void => {
    void api()
      ?.status()
      .then(setStatus)
      .catch(() => undefined)
  }, [])
  useEffect(() => {
    refresh()
    const off = api()?.onInstallProgress((p) => {
      setProgress(p)
      if (p.phase === 'done' || p.phase === 'error') refresh()
    })
    return () => off?.()
  }, [refresh])

  const busy = !!progress && progress.phase !== 'done' && progress.phase !== 'error'
  const installErr = progress?.phase === 'error' && progress.error && isWhisperInstallError(progress.error) ? (`settings.dictation.pack.err.${progress.error}` as MessageKey) : null
  const pct = progress && progress.total > 0 ? Math.round((progress.transferred / progress.total) * 100) : 0

  const saveKey = async (value: string | null): Promise<void> => {
    const res = await api()?.setKey(value)
    if (res?.ok) {
      setKey('')
      toast.success(value ? t('settings.voice.keySaved') : t('settings.voice.keyRemoved'))
    } else toast.error(t(res?.error === 'unavailable' ? 'settings.voice.keyUnavailable' : 'settings.voice.keyBad'))
    refresh()
  }
  const testKey = async (): Promise<void> => {
    const res = await api()?.testEleven()
    if (res?.ok) toast.success(t('settings.voice.keyTestOk', { used: res.used ?? 0, limit: res.limit ?? 0 }))
    else toast.error(t('settings.voice.keyTestFail'))
  }
  const warm = async (): Promise<void> => {
    const dry = await api()?.warmPhrases(true)
    if (!dry?.ok) return
    if (dry.phrases === 0) {
      toast.info(t('settings.voice.warmNone'))
      return
    }
    setWarmAsk({ n: dry.phrases, chars: dry.chars })
  }
  const warmRun = async (): Promise<void> => {
    setWarmAsk(null)
    const res = await api()?.warmPhrases(false)
    if (res?.ok) toast.success(t('settings.voice.warmDone', { n: res.phrases }))
    refresh()
  }

  return (
    <div className="space-y-8" data-voice-settings>
      {/* Hands-free */}
      <section className="space-y-4" aria-labelledby="voice-handsfree">
        <h4 id="voice-handsfree" className={headingCls}>
          {t('settings.voice.handsFree')}
        </h4>
        {status && !status.dictationReady && (
          <p className="flex items-center gap-1.5 text-xs text-state-action" data-voice-need-dictation>
            <AlertTriangle size={13} /> {t('settings.voice.needDictation')}
          </p>
        )}
        <SettingRow searchId="voice.wakeWord" title={t('settings.voice.wakeWord')} description={t('settings.voice.wakeWordHint')}>
          <input
            type="text"
            maxLength={VOICE_LIMITS.wakeWordMax}
            defaultValue={voice.wakeWord}
            placeholder={lang === 'en' ? 'Agent' : 'Agente'}
            onBlur={(e) => {
              const v = e.target.value.replace(/[^\p{L} ]/gu, '').trim()
              if (v !== voice.wakeWord) patch({ wakeWord: v })
            }}
            className={cn(inputCls, 'w-56')}
          />
        </SettingRow>
        <SettingRow searchId="voice.language" title={t('settings.voice.language')} description={t('settings.voice.languageHint')}>
          <Choice label={t('settings.voice.language')} value={voice.language} onChange={(v) => patch({ language: v })} options={[{ v: 'auto', key: 'settings.voice.lang.auto' }, { v: 'es', key: 'settings.voice.lang.es' }, { v: 'en', key: 'settings.voice.lang.en' }]} />
        </SettingRow>
        <SettingRow searchId="voice.hotkey" title={t('settings.voice.hotkey')} description={t('settings.voice.hotkeyHint')}>
          <input
            type="text"
            maxLength={VOICE_LIMITS.hotkeyMax}
            defaultValue={voice.globalHotkey}
            placeholder="CommandOrControl+Alt+V"
            onBlur={(e) => {
              const v = e.target.value.replace(/[^A-Za-z0-9+]/g, '')
              if (v !== voice.globalHotkey) patch({ globalHotkey: v })
            }}
            className={cn(inputCls, 'w-64')}
          />
        </SettingRow>
        <SettingRow searchId="voice.autoOff" title={t('settings.voice.autoOff')} description={t('settings.voice.autoOffHint')}>
          <NumberField label={t('settings.voice.autoOff')} value={voice.autoOffMin} min={VOICE_LIMITS.autoOffMin[0]} max={VOICE_LIMITS.autoOffMin[1]} onCommit={(v) => patch({ autoOffMin: v })} />
        </SettingRow>
        <ToggleRow searchId="voice.bareCommands" checked={voice.bareCommands} onChange={(v) => patch({ bareCommands: v })} title={t('settings.voice.bareCommands')} description={t('settings.voice.bareCommandsHint')} />
      </section>

      {/* Local voice */}
      <section className="space-y-4" aria-labelledby="voice-local">
        <h4 id="voice-local" className={headingCls}>
          {t('settings.voice.local')}
        </h4>
        <SettingRow searchId="voice.pack" title={t('settings.voice.pack')} description={t('settings.voice.packHint', { size: formatBytes(status?.pack.downloadBytes ?? 0, lang) })}>
          <div className="flex flex-wrap items-center gap-2" data-voice-pack={status?.pack.installed ? 'installed' : busy ? 'installing' : 'missing'}>
            {status?.pack.installed ? (
              <>
                <span className="inline-flex items-center gap-1 text-xs text-state-done">
                  <Check size={13} /> {t('settings.voice.pack.installed', { size: formatBytes(status.pack.diskBytes, lang) })}
                </span>
                <button type="button" className={ghostBtn} disabled={busy} onClick={() => void api()?.remove().then(refresh)}>
                  <Trash2 size={13} /> {t('settings.voice.pack.remove')}
                </button>
              </>
            ) : busy ? (
              <>
                <span className="inline-flex items-center gap-1 text-xs text-text-secondary">
                  <Loader2 size={13} className="animate-spin" /> {t('settings.voice.pack.downloading', { pct })}
                </span>
                <button type="button" className={ghostBtn} onClick={() => void api()?.cancelInstall()}>
                  <X size={13} /> {t('settings.voice.pack.cancel')}
                </button>
              </>
            ) : (
              <button type="button" className={ghostBtn} disabled={!status?.supported} onClick={() => void api()?.install().then(refresh)}>
                <Download size={13} /> {t('settings.voice.pack.install')}
              </button>
            )}
            {installErr && <span className="text-xs text-state-error">{t(installErr)}</span>}
          </div>
        </SettingRow>
        <SettingRow searchId="voice.voice" title={t('settings.voice.voice')} description={t('settings.voice.voiceHint')}>
          <div className="flex flex-wrap items-center gap-2">
            <Choice<VoiceGender> label={t('settings.voice.voice')} value={voice.tts.voice} onChange={(v) => patchIn('tts', { voice: v })} options={[{ v: 'male', key: 'settings.voice.voice.male' }, { v: 'female', key: 'settings.voice.voice.female' }]} />
            <button type="button" className={ghostBtn} disabled={!status?.pack.installed && !status?.eleven.keySet} onClick={() => void api()?.preview()} data-voice-preview>
              <Play size={13} /> {t('settings.voice.preview')}
            </button>
          </div>
        </SettingRow>
        <SettingRow searchId="voice.speed" title={t('settings.voice.speed')} description={t('settings.voice.speedHint')}>
          <NumberField label={t('settings.voice.speed')} value={voice.tts.speed} min={VOICE_LIMITS.speed[0]} max={VOICE_LIMITS.speed[1]} step={0.05} onCommit={(v) => patchIn('tts', { speed: v })} />
        </SettingRow>
        <SettingRow searchId="voice.volume" title={t('settings.voice.volume')} description={t('settings.voice.volumeHint')}>
          <NumberField label={t('settings.voice.volume')} value={voice.tts.volume} min={VOICE_LIMITS.volume[0]} max={VOICE_LIMITS.volume[1]} onCommit={(v) => patchIn('tts', { volume: v })} />
        </SettingRow>
      </section>

      {/* Narration */}
      <section className="space-y-4" aria-labelledby="voice-narration">
        <h4 id="voice-narration" className={headingCls}>
          {t('settings.voice.narration')}
        </h4>
        {status?.narratorMod && (
          <p className="flex items-center gap-1.5 text-xs text-state-action" data-voice-narrator-mod>
            <AlertTriangle size={13} /> {t('settings.voice.narratorMod')}
          </p>
        )}
        <ToggleRow searchId="voice.narration" checked={voice.narration.enabled} onChange={(v) => patchIn('narration', { enabled: v })} title={t('settings.voice.narrationOn')} description={t('settings.voice.narrationOnHint')} />
        <ToggleRow searchId="voice.announceDone" checked={voice.narration.done} disabled={!voice.narration.enabled} onChange={(v) => patchIn('narration', { done: v })} title={t('settings.voice.announceDone')} />
        <ToggleRow searchId="voice.announceAction" checked={voice.narration.action} disabled={!voice.narration.enabled} onChange={(v) => patchIn('narration', { action: v })} title={t('settings.voice.announceAction')} />
        <ToggleRow searchId="voice.announceError" checked={voice.narration.error} disabled={!voice.narration.enabled} onChange={(v) => patchIn('narration', { error: v })} title={t('settings.voice.announceError')} />
        <SettingRow searchId="voice.summarizer" title={t('settings.voice.summarizer')} description={status && !status.claudeFound ? `${t('settings.voice.summarizerHint')} ${t('settings.voice.noClaude')}` : t('settings.voice.summarizerHint')}>
          <Choice label={t('settings.voice.summarizer')} value={voice.narration.summarizer} onChange={(v) => patchIn('narration', { summarizer: v })} options={[{ v: 'claude', key: 'settings.voice.summarizer.claude' }, { v: 'local', key: 'settings.voice.summarizer.local' }]} />
        </SettingRow>
        <ToggleRow searchId="voice.muteChimes" checked={voice.narration.muteChimes} onChange={(v) => patchIn('narration', { muteChimes: v })} title={t('settings.voice.muteChimes')} description={t('settings.voice.muteChimesHint')} />
      </section>

      {/* ElevenLabs */}
      <section className="space-y-4" aria-labelledby="voice-eleven">
        <h4 id="voice-eleven" className={headingCls}>
          {t('settings.voice.eleven')}
        </h4>
        <SettingRow searchId="voice.engine" title={t('settings.voice.engine')} description={t('settings.voice.engineHint')}>
          <Choice label={t('settings.voice.engine')} value={voice.tts.engine} onChange={(v) => patchIn('tts', { engine: v })} options={[{ v: 'local', key: 'settings.voice.engine.local' }, { v: 'elevenlabs', key: 'settings.voice.engine.elevenlabs' }]} />
        </SettingRow>
        <SettingRow searchId="voice.elevenKey" title={t('settings.voice.key')} description={status?.eleven.keySet ? t('settings.voice.keySet', { last4: status.eleven.last4 }) : t('settings.voice.keyHint')}>
          <div className="flex flex-wrap items-center gap-2">
            <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk_..." className={cn(inputCls, 'w-64')} aria-label={t('settings.voice.key')} />
            <button type="button" className={ghostBtn} disabled={!key.trim()} onClick={() => void saveKey(key.trim())}>
              {t('settings.voice.keySave')}
            </button>
            {status?.eleven.keySet && (
              <>
                <button type="button" className={ghostBtn} onClick={() => void testKey()}>
                  {t('settings.voice.keyTest')}
                </button>
                <button type="button" className={ghostBtn} onClick={() => void saveKey(null)}>
                  {t('settings.voice.keyRemove')}
                </button>
              </>
            )}
          </div>
        </SettingRow>
        <SettingRow searchId="voice.elevenVoice" title={t('settings.voice.voiceId')} description={t('settings.voice.voiceIdHint')}>
          <input
            type="text"
            maxLength={VOICE_LIMITS.voiceIdMax}
            defaultValue={voice.eleven.voiceId}
            onBlur={(e) => {
              const v = e.target.value.replace(/[^A-Za-z0-9_-]/g, '')
              if (v !== voice.eleven.voiceId) patchIn('eleven', { voiceId: v })
            }}
            className={cn(inputCls, 'w-64')}
          />
        </SettingRow>
        <SettingRow searchId="voice.elevenModel" title={t('settings.voice.model')} description={t('settings.voice.modelHint')}>
          <input
            type="text"
            maxLength={VOICE_LIMITS.modelMax}
            defaultValue={voice.eleven.model}
            onBlur={(e) => {
              const v = e.target.value.replace(/[^A-Za-z0-9_.-]/g, '')
              if (v && v !== voice.eleven.model) patchIn('eleven', { model: v })
            }}
            className={cn(inputCls, 'w-64')}
          />
        </SettingRow>
        <SettingRow searchId="voice.elevenMode" title={t('settings.voice.mode')} description={t('settings.voice.modeHint')}>
          <Choice label={t('settings.voice.mode')} value={voice.eleven.mode} onChange={(v) => patchIn('eleven', { mode: v })} options={[{ v: 'fixedOnly', key: 'settings.voice.mode.fixedOnly' }, { v: 'all', key: 'settings.voice.mode.all' }]} />
        </SettingRow>
        <SettingRow searchId="voice.elevenCap" title={t('settings.voice.cap')} description={t('settings.voice.capHint', { used: status?.eleven.usedChars ?? 0, since: status?.eleven.periodStart ?? '' })}>
          <NumberField label={t('settings.voice.cap')} value={voice.eleven.monthlyCap} min={VOICE_LIMITS.monthlyCap[0]} max={VOICE_LIMITS.monthlyCap[1]} onCommit={(v) => patchIn('eleven', { monthlyCap: v })} />
        </SettingRow>
        <SettingRow searchId="voice.phrases" title={t('settings.voice.warm')} description={t('settings.voice.warmHint')}>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={ghostBtn} onClick={() => void warm()}>
              {t('settings.voice.warmRun')}
            </button>
            <button type="button" className={ghostBtn} onClick={() => void api()?.clearCache().then(() => toast.success(t('settings.voice.cacheCleared')))}>
              {t('settings.voice.clearCache')}
            </button>
          </div>
        </SettingRow>
      </section>
      <ConfirmDialog
        open={!!warmAsk}
        title={t('settings.voice.warm')}
        message={t('settings.voice.warmConfirm', { n: warmAsk?.n ?? 0, chars: warmAsk?.chars ?? 0 })}
        confirmLabel={t('settings.voice.warmRun')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => void warmRun()}
        onCancel={() => setWarmAsk(null)}
      />
    </div>
  )
}
