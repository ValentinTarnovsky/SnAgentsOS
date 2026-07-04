/**
 * In-app pairing scanner overlay. Exists because an installed home-screen web
 * app cannot pair via the OS camera: iOS opens the scanned link in Safari,
 * which is a different storage origin, so the credentials land in the wrong
 * app. Three ladders down, best available wins:
 *  - live getUserMedia scan with a square viewfinder (needs a secure context,
 *    so plain-http LAN origins never get it; localhost / HTTPS do)
 *  - native-camera photo capture decoded with jsQR (works on http origins)
 *  - manual entry of the 8-char code shown under the desktop QR
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Camera, X } from 'lucide-react'
import { PrimaryButton } from './InfoScreen'
import { useRemoteStore } from '../lib/store'
import { client } from '../lib/client'
import { t } from '../lib/i18n'
import { decodeQrFromFile, decodeQrFromVideo, extractPairCode, PAIR_CODE_LENGTH } from '../lib/qrScan'

type ScanError = 'noQr' | 'camDenied' | null

/** Shared "link this phone" button: opens the scanner overlay. Used by every
 * screen that tells the user to scan the desktop QR. */
export function LinkDeviceButton(): ReactNode {
  const update = useRemoteStore((s) => s.update)
  return <PrimaryButton onClick={() => update({ scanOpen: true })}>{t('welcome.link')}</PrimaryButton>
}

/** getUserMedia only exists on secure contexts; undefined means photo fallback. */
function liveCameraSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
}

export function ScanScreen(): ReactNode {
  const update = useRemoteStore((s) => s.update)
  const [live, setLive] = useState(liveCameraSupported)
  const [error, setError] = useState<ScanError>(null)
  const [busy, setBusy] = useState(false)
  const [code, setCode] = useState('')
  const videoRef = useRef<HTMLVideoElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const foundRef = useRef(false)

  const close = (): void => update({ scanOpen: false })

  /** A QR (or manual code) came in: validate and hand off to the pair flow. */
  const accept = (text: string): boolean => {
    const pairCode = extractPairCode(text)
    if (!pairCode || foundRef.current) return false
    foundRef.current = true
    update({ scanOpen: false, pairReason: null })
    client.startPairing(pairCode)
    return true
  }

  // Live scan loop: sample the center square a few times per second.
  useEffect(() => {
    if (!live) return
    let stream: MediaStream | null = null
    let raf = 0
    let stopped = false
    let last = 0
    const canvas = document.createElement('canvas')

    const tick = (): void => {
      if (stopped) return
      raf = requestAnimationFrame(tick)
      const now = performance.now()
      if (now - last < 200) return
      last = now
      const video = videoRef.current
      if (!video) return
      const text = decodeQrFromVideo(video, canvas)
      if (text && accept(text)) stopped = true
    }

    const start = async (): Promise<void> => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        })
      } catch {
        if (!stopped) {
          setLive(false)
          setError('camDenied')
        }
        return
      }
      if (stopped) {
        stream.getTracks().forEach((tr) => tr.stop())
        return
      }
      const video = videoRef.current
      if (!video) return
      video.srcObject = stream
      try {
        await video.play()
      } catch {
        /* autoplay refusal: the loop simply never decodes; fallbacks remain */
      }
      tick()
    }

    void start()
    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach((tr) => tr.stop())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live])

  const onPhoto = async (file: File | undefined): Promise<void> => {
    if (!file) return
    setBusy(true)
    setError(null)
    const text = await decodeQrFromFile(file)
    setBusy(false)
    if (!text || !accept(text)) setError('noQr')
  }

  const manualValid = extractPairCode(code) != null
  const submitManual = (): void => {
    if (manualValid) accept(code)
  }

  return (
    <div
      className="fade-in fixed inset-0 z-50 flex flex-col bg-bg-primary"
      style={{ height: 'var(--vvh, 100dvh)' }}
    >
      <div className="flex items-center justify-between px-5 pb-2 pt-[max(1rem,env(safe-area-inset-top))]">
        <h1 className="text-base font-semibold text-text-primary">{t('scan.title')}</h1>
        <button onClick={close} className="p-2 text-text-secondary transition-colors active:text-text-primary">
          <X size={20} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 overflow-y-auto px-6 py-4">
        {live ? (
          <>
            <div className="relative aspect-square w-full max-w-[280px] overflow-hidden rounded-card border border-border bg-black">
              <video
                ref={videoRef}
                muted
                playsInline
                autoPlay
                className="absolute inset-0 h-full w-full object-cover"
              />
              <div className="pointer-events-none absolute inset-5 rounded-xl border-2 border-accent-violet/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
            </div>
            <p className="max-w-sm text-center text-sm leading-relaxed text-text-secondary">{t('scan.aim')}</p>
          </>
        ) : (
          <div className="w-full max-w-sm text-center">
            <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-accent-violet/10 text-accent-violet">
              <Camera size={30} />
            </div>
            <p className="mb-5 text-sm leading-relaxed text-text-secondary">{t('scan.photoHint')}</p>
            <PrimaryButton onClick={() => fileRef.current?.click()} disabled={busy}>
              {busy ? t('scan.reading') : t('scan.openCamera')}
            </PrimaryButton>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                void onPhoto(e.target.files?.[0])
                e.target.value = ''
              }}
            />
          </div>
        )}

        {error && (
          <p className="max-w-sm text-center text-sm text-red-400">
            {error === 'camDenied' ? t('scan.camDenied') : t('scan.noQr')}
          </p>
        )}

        <div className="w-full max-w-sm">
          <div className="mb-4 flex items-center gap-3">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs text-text-secondary">{t('scan.manualLabel')}</span>
            <div className="h-px flex-1 bg-border" />
          </div>
          <div className="flex gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="ABCD2345"
              maxLength={PAIR_CODE_LENGTH}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitManual()
              }}
              className="h-12 min-w-0 flex-1 rounded-btn border border-border bg-bg-secondary px-3 text-center font-mono text-base tracking-[0.25em] text-text-primary outline-none focus:border-accent-violet"
            />
            <button
              onClick={submitManual}
              disabled={!manualValid}
              className="h-12 shrink-0 rounded-btn bg-accent-violet px-4 text-sm font-semibold text-white transition active:brightness-110 disabled:opacity-40"
            >
              {t('scan.continue')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
