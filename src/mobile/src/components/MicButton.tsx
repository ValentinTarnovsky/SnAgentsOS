/**
 * The dictation button of a text field (v2.2): tap to dictate, tap again to
 * stop. Final words go to `onFinal` (the field places them at its caret,
 * never with Enter); the words still being heard show where the field draws
 * `useVoiceStore.interim`. On plain http it explains why the microphone is
 * off and offers the desktop's https address (secure mode); a browser without
 * speech recognition points to the keyboard's own microphone.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { Lock, Mic, MicOff } from 'lucide-react'
import { store, useRemoteStore } from '../lib/store'
import { getLang, t } from '../lib/i18n'
import { loadVoiceLang, startDictation, stopDictation, useVoiceStore, voiceLang, voiceSupport, type VoiceError } from '../lib/voice'
import { Sheet } from './Sheet'

const ERROR_KEY: Record<VoiceError, 'voice.denied' | 'voice.noSpeech' | 'voice.error'> = {
  denied: 'voice.denied',
  noSpeech: 'voice.noSpeech',
  failed: 'voice.error',
}

export function MicButton({
  owner,
  onFinal,
  resetKey,
  className,
}: {
  /** Field id: only one field dictates at a time. */
  owner: string
  onFinal: (text: string) => void
  /** A change (another pane) ends the dictation. */
  resetKey?: unknown
  className?: string
}): ReactNode {
  const listening = useVoiceStore((s) => s.owner === owner)
  const [help, setHelp] = useState(false)

  // Another pane, or the field going away, ends the dictation; so does a hidden page.
  useEffect(() => () => stopDictation(owner), [owner, resetKey])
  useEffect(() => {
    const onHide = (): void => {
      if (document.visibilityState === 'hidden') stopDictation(owner)
    }
    document.addEventListener('visibilitychange', onHide)
    return () => document.removeEventListener('visibilitychange', onHide)
  }, [owner])

  const toggle = (): void => {
    if (listening) {
      stopDictation(owner)
      return
    }
    const support = voiceSupport()
    if (support === 'insecure') {
      setHelp(true)
      return
    }
    if (support === 'unsupported') {
      store.getState().setToast(t('voice.unsupported'))
      return
    }
    const lang = voiceLang(loadVoiceLang(), getLang(), navigator.language)
    const started = startDictation(owner, lang, {
      onFinal,
      onError: (error) => store.getState().setToast(t(ERROR_KEY[error])),
    })
    if (!started) store.getState().setToast(t('voice.error'))
  }

  return (
    <>
      <button
        type="button"
        data-mic-button={owner}
        data-listening={listening ? 'true' : 'false'}
        aria-label={listening ? t('voice.stop') : t('voice.start')}
        aria-pressed={listening}
        // Keep the focus (and the soft keyboard, when up) in the field.
        onPointerDown={(e) => e.preventDefault()}
        onClick={toggle}
        onContextMenu={(e) => e.preventDefault()}
        className={clsx(
          'relative flex h-11 w-11 shrink-0 select-none items-center justify-center rounded-btn border transition [-webkit-touch-callout:none]',
          listening ? 'border-red-500 bg-red-500 text-white' : 'border-border bg-bg-secondary text-text-primary active:bg-card',
          className,
        )}
      >
        {listening && <span aria-hidden className="absolute inset-0 animate-ping rounded-btn bg-red-500/40 motion-reduce:animate-none" />}
        {listening ? <MicOff size={18} className="relative" /> : <Mic size={18} />}
      </button>
      <VoiceHelpSheet open={help} onClose={() => setHelp(false)} />
    </>
  )
}

/** Why the microphone is off on http, and the way out. */
function VoiceHelpSheet({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const secureUrl = useRemoteStore((s) => s.secureUrl)
  return (
    <Sheet open={open} onClose={onClose} title={t('voice.insecureTitle')}>
      <div data-voice-help className="space-y-3 px-4 pb-4">
        <p className="text-sm leading-relaxed text-text-secondary">{t('voice.insecureBody')}</p>
        {secureUrl ? (
          <a
            data-voice-secure
            href={secureUrl}
            className="flex h-11 items-center justify-center gap-2 rounded-btn bg-accent-violet px-4 text-sm font-medium text-white"
          >
            <Lock size={16} />
            {t('voice.openSecure')}
          </a>
        ) : (
          <p data-voice-no-secure className="text-xs leading-relaxed text-text-secondary">{t('voice.noSecure')}</p>
        )}
      </div>
    </Sheet>
  )
}

/** The words still being heard for `owner`, under its field. */
export function VoiceInterim({ owner }: { owner: string }): ReactNode {
  const interim = useVoiceStore((s) => (s.owner === owner ? s.interim : null))
  if (interim === null) return null
  return (
    <div data-voice-interim className="mb-1.5 flex items-center gap-2 px-1 text-xs text-text-secondary" role="status" aria-live="polite">
      <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-red-500 motion-reduce:animate-none" />
      <span className="min-w-0 truncate">{interim || t('voice.listening')}</span>
    </div>
  )
}
