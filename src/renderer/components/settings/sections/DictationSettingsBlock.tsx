import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Download, Loader2, Lock, RotateCcw, Trash2, X } from 'lucide-react'
import type { DictationDevice, DictationSettings } from '@shared/types'
import {
  DICTATION_DEVICES,
  formatBytes,
  type WhisperInstallError,
  type WhisperInstallProgress,
  type WhisperPackId,
  type WhisperPackInfo,
  type WhisperStatus,
} from '@shared/dictation'
import { VOICE_LANGS } from '@shared/voiceText'
import { useAppStore } from '@/lib/store'
import { useLang, useT, type MessageKey } from '@/i18n'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { cn } from '@/lib/cn'
import { SettingRow, ToggleRow, inputCls } from '../ui'

const DEVICE_LABEL: Record<DictationDevice, MessageKey> = {
  auto: 'settings.dictation.deviceAuto',
  gpu: 'settings.dictation.deviceGpu',
  cpu: 'settings.dictation.deviceCpu',
}

const PACK_LABEL: Record<WhisperPackId, MessageKey> = {
  cpu: 'settings.dictation.pack.cpu',
  gpu: 'settings.dictation.pack.gpu',
}

const PACK_HINT: Record<WhisperPackId, MessageKey> = {
  cpu: 'settings.dictation.pack.cpuHint',
  gpu: 'settings.dictation.pack.gpuHint',
}

const INSTALL_ERR: Record<WhisperInstallError, MessageKey> = {
  network: 'settings.dictation.pack.err.network',
  http: 'settings.dictation.pack.err.http',
  size: 'settings.dictation.pack.err.size',
  sha256: 'settings.dictation.pack.err.sha256',
  disk: 'settings.dictation.pack.err.disk',
  extract: 'settings.dictation.pack.err.extract',
  warmup: 'settings.dictation.pack.err.warmup',
  cancelled: 'settings.dictation.pack.err.cancelled',
  busy: 'settings.dictation.pack.err.busy',
  unsupported: 'settings.dictation.pack.err.unsupported',
}

const PHASE_LABEL: Record<'verify' | 'extract' | 'warmup', MessageKey> = {
  verify: 'settings.dictation.pack.phase.verify',
  extract: 'settings.dictation.pack.phase.extract',
  warmup: 'settings.dictation.pack.phase.warmup',
}

const VOCABULARY_MAX = 400

const ghostBtn =
  'inline-flex items-center gap-1.5 rounded-btn border border-border px-2.5 py-1 text-xs text-text-primary transition-colors hover:bg-card hover:border-accent-violet/40 disabled:pointer-events-none disabled:opacity-50'

function api() {
  return typeof window !== 'undefined' ? window.snApi?.dictation : undefined
}

function isStatus(v: unknown): v is WhisperStatus {
  return !!v && typeof v === 'object' && Array.isArray((v as WhisperStatus).packs)
}

/** The install that is still working (a final 'done' / 'error' state is not). */
function runningInstall(st: WhisperStatus | null): WhisperInstallProgress | null {
  const p = st?.install
  return p && p.phase !== 'done' && p.phase !== 'error' ? p : null
}

/**
 * Desktop dictation (app 2.5.0, settings.dictation): the device, the model
 * packs of the local Whisper engine (download, progress, cancel, delete), the
 * language, the live preview, the vocabulary and the header mic. Shown under
 * Terminal. Packs are downloaded only from here; main validates every pack id.
 */
export function DictationSettingsBlock() {
  const t = useT()
  const dictation = useAppStore((s) => s.settings.dictation)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const patch = (p: Partial<DictationSettings>): void => updateSettings({ dictation: { ...dictation, ...p } })
  // A tag saved by hand (any BCP 47 the schema accepts) stays selectable.
  const langs: string[] = [...VOICE_LANGS]
  if (dictation.language && !langs.includes(dictation.language)) langs.push(dictation.language)
  const [vocabulary, setVocabulary] = useState(dictation.vocabulary ?? '')
  useEffect(() => setVocabulary(dictation.vocabulary ?? ''), [dictation.vocabulary])
  const saveVocabulary = (): void => {
    const v = vocabulary.slice(0, VOCABULARY_MAX).trim()
    setVocabulary(v)
    if (v !== (dictation.vocabulary ?? '')) patch({ vocabulary: v })
  }
  return (
    <section className="space-y-3 border-t border-border pt-5" aria-labelledby="terminal-dictation" data-dictation-settings>
      <h4 id="terminal-dictation" className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
        {t('settings.dictation.group')}
      </h4>
      <SettingRow searchId="terminal.dictationDevice" title={t('settings.dictation.device')} description={t('settings.dictation.deviceHint')}>
        <select
          className={inputCls}
          value={dictation.device ?? 'auto'}
          data-dictation-device-select
          onChange={(e) => patch({ device: e.target.value as DictationDevice })}
        >
          {DICTATION_DEVICES.map((d) => (
            <option key={d} value={d}>
              {t(DEVICE_LABEL[d])}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow searchId="terminal.dictationModels" title={t('settings.dictation.packs')} description={t('settings.dictation.packsHint')}>
        <DictationPacks />
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
        checked={dictation.interim !== false}
        onChange={(v) => patch({ interim: v })}
        searchId="terminal.dictationInterim"
        title={t('settings.dictation.interim')}
        description={t('settings.dictation.interimHint')}
      />
      <SettingRow searchId="terminal.dictationVocabulary" title={t('settings.dictation.vocabulary')} description={t('settings.dictation.vocabularyHint')}>
        <input
          type="text"
          className={inputCls}
          value={vocabulary}
          maxLength={VOCABULARY_MAX}
          spellCheck={false}
          placeholder={t('settings.dictation.vocabularyPlaceholder')}
          data-dictation-vocabulary
          onChange={(e) => setVocabulary(e.target.value)}
          onBlur={saveVocabulary}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
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

/**
 * The packs card: per pack its sizes and state (Download, progress with
 * Cancel, the phase, Installed with Delete, an error with Retry), the VC++
 * runtime warning, the data folder and the privacy note.
 */
function DictationPacks() {
  const t = useT()
  const lang = useLang()
  const [status, setStatus] = useState<WhisperStatus | null>(null)
  const [loadError, setLoadError] = useState(false)
  /** A pack whose install was asked and has no progress event yet. */
  const [pending, setPending] = useState<WhisperPackId | null>(null)
  const [removing, setRemoving] = useState<WhisperPackId | null>(null)
  /** The last install or delete answer that failed, per pack. */
  const [errors, setErrors] = useState<Partial<Record<WhisperPackId, WhisperInstallError>>>({})
  const [confirm, setConfirm] = useState<WhisperPackId | null>(null)
  const alive = useRef(true)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const st: unknown = await api()?.models()
      if (!alive.current) return
      if (isStatus(st)) {
        setStatus(st)
        setLoadError(false)
      } else setLoadError(true)
    } catch {
      if (alive.current) setLoadError(true)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void refresh()
    const off = api()?.onInstallProgress((p) => {
      if (!alive.current || !p || typeof p !== 'object') return
      setStatus((s) => (s ? { ...s, install: p } : s))
      setPending((x) => (x === p.pack ? null : x))
      if (p.phase === 'done' || p.phase === 'error') void refresh()
    })
    return () => {
      alive.current = false
      if (typeof off === 'function') off()
    }
  }, [refresh])

  const install = async (pack: WhisperPackId): Promise<void> => {
    const a = api()
    if (!a) return
    setPending(pack)
    setErrors((e) => ({ ...e, [pack]: undefined }))
    setStatus((s) => (s ? { ...s, install: null } : s))
    try {
      const res = await a.install(pack)
      if (alive.current && !res?.ok && res?.error) setErrors((e) => ({ ...e, [pack]: res.error }))
    } catch {
      if (alive.current) setErrors((e) => ({ ...e, [pack]: 'network' }))
    }
    if (!alive.current) return
    setPending(null)
    await refresh()
  }

  const remove = async (pack: WhisperPackId): Promise<void> => {
    const a = api()
    if (!a) return
    setRemoving(pack)
    setErrors((e) => ({ ...e, [pack]: undefined }))
    try {
      const res = await a.remove(pack)
      if (alive.current && !res?.ok && res?.error) setErrors((e) => ({ ...e, [pack]: res.error }))
    } catch {
      if (alive.current) setErrors((e) => ({ ...e, [pack]: 'busy' }))
    }
    if (!alive.current) return
    setRemoving(null)
    await refresh()
  }

  if (loadError && !status) {
    return (
      <p data-dictation-packs-error className="text-xs text-red-400">
        {t('settings.dictation.packsError')}
      </p>
    )
  }
  if (!status) return null

  const running = runningInstall(status)
  const busy = !!running || pending !== null || removing !== null
  const installed = (id: WhisperPackId): boolean => status.packs.some((p) => p.id === id && p.installed)
  const recommended: WhisperPackId = status.nvidia ? 'gpu' : 'cpu'
  const confirmInfo = confirm ? status.packs.find((p) => p.id === confirm) : undefined

  return (
    <div data-dictation-packs className="min-w-0 space-y-2">
      {!status.supported && (
        <p data-dictation-unsupported className="text-xs text-text-secondary">
          {t('settings.dictation.unsupported')}
        </p>
      )}
      {status.supported && !status.vcRuntime && (
        <div data-dictation-vcredist className="flex flex-wrap items-center gap-2 rounded-btn border border-amber-400/30 bg-amber-400/5 p-2.5 text-xs text-text-primary">
          <AlertTriangle size={13} className="shrink-0 text-amber-400" />
          <span className="min-w-0 flex-1">{t('settings.dictation.vcredist')}</span>
          <button
            type="button"
            data-dictation-open-vcredist
            className={ghostBtn}
            onClick={() => void api()?.openSettings('vcredist').catch(() => false)}
          >
            <Download size={13} className="shrink-0" />
            {t('dictation.openVcredist')}
          </button>
        </div>
      )}
      {status.packs.map((info) => (
        <PackCard
          key={info.id}
          info={info}
          status={status}
          running={running?.pack === info.id ? running : null}
          warming={info.id === 'gpu' && status.warming && !running}
          pending={pending === info.id}
          removing={removing === info.id}
          busy={busy}
          recommended={recommended === info.id && !info.installed}
          error={errors[info.id] ?? (status.install?.pack === info.id && status.install.phase === 'error' ? status.install.error : undefined)}
          cpuNeeded={info.id === 'cpu' && installed('gpu')}
          onInstall={() => void install(info.id)}
          onCancel={() => void api()?.cancelInstall(info.id).catch(() => undefined)}
          onDelete={() => setConfirm(info.id)}
          lang={lang}
        />
      ))}
      {status.dataDir && (
        <p data-dictation-folder className="break-all text-[11px] text-text-secondary">
          {t('settings.dictation.folder', { path: status.dataDir })}
        </p>
      )}
      <p data-dictation-privacy className="flex items-start gap-1.5 text-[11px] text-text-secondary">
        <Lock size={13} className="mt-px shrink-0" />
        <span className="min-w-0">{t('settings.dictation.privacy')}</span>
      </p>
      <ConfirmDialog
        open={!!confirm}
        title={confirm ? t('settings.dictation.pack.deleteTitle', { name: t(PACK_LABEL[confirm]) }) : ''}
        message={
          confirm === 'gpu'
            ? t('settings.dictation.pack.deleteGpu')
            : t('settings.dictation.pack.deleteCpu', { size: formatBytes(confirmInfo?.diskBytes ?? 0, lang) })
        }
        confirmLabel={t('settings.dictation.pack.delete')}
        cancelLabel={t('common.cancel')}
        danger
        onConfirm={() => {
          const pack = confirm
          setConfirm(null)
          if (pack) void remove(pack)
        }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  )
}

function PackCard({
  info,
  status,
  running,
  warming,
  pending,
  removing,
  busy,
  recommended,
  error,
  cpuNeeded,
  onInstall,
  onCancel,
  onDelete,
  lang,
}: {
  info: WhisperPackInfo
  status: WhisperStatus
  running: WhisperInstallProgress | null
  warming: boolean
  pending: boolean
  removing: boolean
  busy: boolean
  recommended: boolean
  error: WhisperInstallError | undefined
  cpuNeeded: boolean
  onInstall: () => void
  onCancel: () => void
  onDelete: () => void
  lang: ReturnType<typeof useLang>
}) {
  const t = useT()
  const noGpu = info.id === 'gpu' && !status.nvidia
  const state = running ? running.phase : warming ? 'warmup' : pending ? 'pending' : removing ? 'removing' : info.installed ? 'installed' : error ? 'error' : 'available'
  const percent = running && running.total > 0 ? Math.min(100, Math.floor((running.transferred / running.total) * 100)) : 0
  const phase = running?.phase ?? (warming ? 'warmup' : null)
  return (
    <div data-dictation-pack={info.id} data-pack-state={state} className="min-w-0 space-y-2 rounded-card border border-border bg-bg-secondary/40 p-3">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-text-primary">{t(PACK_LABEL[info.id])}</span>
            {recommended && (
              <span data-pack-recommended className="rounded border border-border px-1.5 text-[10px] leading-4 text-text-secondary">
                {t('settings.dictation.pack.recommended')}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-text-secondary">{t(PACK_HINT[info.id])}</p>
          <p data-pack-sizes className="mt-0.5 text-xs text-text-secondary">
            {info.installed ? (
              <span data-pack-installed className="inline-flex items-center gap-1 text-text-primary">
                <Check size={13} className="shrink-0 text-state-done" />
                {t('settings.dictation.pack.installed', { size: formatBytes(info.diskBytes, lang) })}
              </span>
            ) : (
              t('settings.dictation.pack.sizes', { download: formatBytes(info.downloadBytes, lang), disk: formatBytes(info.diskBytes, lang) })
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {running?.phase === 'download' && (
            <button type="button" data-pack-cancel className={ghostBtn} onClick={onCancel}>
              <X size={13} className="shrink-0" />
              {t('settings.dictation.pack.cancel')}
            </button>
          )}
          {!phase && info.installed && (
            <button
              type="button"
              data-pack-delete
              className={cn(ghostBtn, 'hover:border-red-400/50 hover:text-red-400')}
              disabled={busy || cpuNeeded || !status.supported}
              onClick={onDelete}
            >
              {removing ? <Loader2 size={13} className="shrink-0 animate-spin" /> : <Trash2 size={13} className="shrink-0" />}
              {t('settings.dictation.pack.delete')}
            </button>
          )}
          {!phase && !info.installed && (
            <button
              type="button"
              data-pack-install
              className={ghostBtn}
              disabled={busy || noGpu || !status.supported}
              onClick={onInstall}
            >
              {pending ? (
                <Loader2 size={13} className="shrink-0 animate-spin" />
              ) : error && error !== 'cancelled' ? (
                <RotateCcw size={13} className="shrink-0" />
              ) : (
                <Download size={13} className="shrink-0" />
              )}
              {t(error ? 'settings.dictation.pack.retry' : 'settings.dictation.pack.download')}
            </button>
          )}
        </div>
      </div>
      {running?.phase === 'download' && (
        <div data-pack-progress className="space-y-1">
          <div className="h-2 w-full overflow-hidden rounded-full bg-bg-secondary">
            <div
              className="h-full rounded-full bg-[linear-gradient(135deg,var(--color-accent-violet),var(--color-accent-blue))] transition-[width] duration-150"
              style={{ width: `${percent}%` }}
            />
          </div>
          <div className="flex flex-wrap justify-between gap-x-3 text-xs text-text-secondary">
            <span>{t('settings.dictation.pack.phase.download', { percent })}</span>
            <span data-pack-bytes>
              {t('settings.dictation.pack.progress', { done: formatBytes(running.transferred, lang), total: formatBytes(running.total, lang) })}
            </span>
          </div>
        </div>
      )}
      {phase && phase !== 'download' && phase !== 'done' && phase !== 'error' && (
        <p data-pack-phase={phase} className="flex items-center gap-1.5 text-xs text-text-secondary">
          <Loader2 size={13} className="shrink-0 animate-spin motion-reduce:animate-none" />
          {t(PHASE_LABEL[phase])}
        </p>
      )}
      {noGpu && !info.installed && (
        <p data-pack-no-gpu className="text-xs text-text-secondary">
          {t('settings.dictation.pack.noGpu')}
        </p>
      )}
      {cpuNeeded && !phase && (
        <p data-pack-cpu-needed className="text-xs text-text-secondary">
          {t('settings.dictation.pack.cpuNeeded')}
        </p>
      )}
      {error && !phase && !pending && (
        <p data-pack-error={error} className={cn('text-xs', error === 'cancelled' ? 'text-text-secondary' : 'text-red-400')}>
          {t(INSTALL_ERR[error])}
        </p>
      )}
    </div>
  )
}
