/**
 * Image from the phone, the UI half (E3-FR-06, 08).
 *
 *  - ImageButton: the 44x44 ImagePlus button of the composer and of the
 *    KeyBar in Direct mode. It renders only while authOk brought an
 *    httpToken (E3-FR-01: an old desktop has no upload route) and opens a
 *    plain `<input type="file" accept="image/*">`, so the phone offers both
 *    the camera and the gallery. The pick starts the upload for this pane.
 *  - UploadChip: the strip above the composer / KeyBar while a job exists:
 *    "Uploading image... 42%" with an X that aborts, a red "Retry" on failure,
 *    or [Copy path] when the console closed (or the socket dropped) before
 *    the reference could be inserted.
 */
import { useRef, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { ImagePlus, RotateCw, X } from 'lucide-react'
import { useRemoteStore } from '../lib/store'
import {
  cancelUpload,
  copyUploadPath,
  retryUpload,
  startUpload,
  uploadBusy,
  useUploadStore,
  type UploadJob,
  type UploadOrigin,
} from '../lib/uploadJob'
import type { UploadErrorCode } from '../lib/upload'
import { t, type MobileMessageKey } from '../lib/i18n'

const ERROR_KEY: Record<UploadErrorCode, MobileMessageKey> = {
  tooBig: 'upload.tooBig',
  decode: 'upload.errDecode',
  auth: 'upload.errAuth',
  rate: 'upload.errRate',
  type: 'upload.errType',
  network: 'upload.errNetwork',
  server: 'upload.errServer',
  aborted: 'upload.errNetwork',
}

export function ImageButton({ paneId, origin, className }: { paneId: string; origin: UploadOrigin; className?: string }): ReactNode {
  const httpToken = useRemoteStore((s) => s.httpToken)
  const busy = useUploadStore((s) => s.job?.phase === 'preparing' || s.job?.phase === 'uploading')
  const input = useRef<HTMLInputElement | null>(null)
  if (!httpToken) return null
  return (
    <>
      <button
        type="button"
        data-upload-button={origin}
        aria-label={t('upload.button')}
        aria-disabled={busy}
        // Keep the focus (and the soft keyboard) where it is until the picker opens.
        onPointerDown={(e) => e.preventDefault()}
        // The picker opens from click: a real user gesture on every browser.
        onClick={() => {
          if (uploadBusy()) return
          input.current?.click()
        }}
        onContextMenu={(e) => e.preventDefault()}
        className={clsx(
          'flex h-11 w-11 shrink-0 select-none items-center justify-center rounded-btn border border-border bg-bg-secondary text-text-primary transition active:bg-card [-webkit-touch-callout:none]',
          busy && 'opacity-40',
          className,
        )}
      >
        <ImagePlus size={18} />
      </button>
      <input
        ref={input}
        data-upload-input={origin}
        type="file"
        accept="image/*"
        tabIndex={-1}
        aria-hidden="true"
        className="hidden"
        onChange={(e) => {
          const file = e.currentTarget.files?.[0]
          // Reset, so picking the same photo again still fires change.
          e.currentTarget.value = ''
          if (file) startUpload(file, paneId, origin)
        }}
      />
    </>
  )
}

function chipText(job: UploadJob): string {
  if (job.phase === 'preparing') return t('upload.preparing')
  if (job.phase === 'uploading') return t('upload.progress', { percent: job.progress })
  if (job.phase === 'paneGone') return t('upload.paneGone')
  if (job.phase === 'undelivered') return t('upload.undelivered')
  return t(ERROR_KEY[job.error ?? 'network'])
}

export function UploadChip(): ReactNode {
  const job = useUploadStore((s) => s.job)
  if (!job) return null
  const failed = job.phase === 'failed'
  const parked = job.phase === 'paneGone' || job.phase === 'undelivered'
  const running = job.phase === 'preparing' || job.phase === 'uploading'
  return (
    <div
      data-upload-chip={job.phase}
      role="status"
      aria-live="polite"
      className="shrink-0 border-t border-border bg-bg-secondary px-2 pt-2"
    >
      <div
        className={clsx(
          'relative flex items-center gap-2 overflow-hidden rounded-btn border px-2 py-1.5',
          failed ? 'border-red-500/70 bg-red-500/15' : 'border-border bg-card',
        )}
      >
        {job.phase === 'uploading' && (
          <span
            aria-hidden="true"
            data-upload-bar
            className="pointer-events-none absolute inset-y-0 left-0 bg-accent-violet/20 transition-[width]"
            style={{ width: `${job.progress}%` }}
          />
        )}
        {job.preview && <img src={job.preview} alt="" className="relative h-8 w-8 shrink-0 rounded object-cover" />}
        <span data-upload-text className={clsx('relative min-w-0 flex-1 truncate text-xs', failed ? 'text-red-300' : 'text-text-primary')}>
          {chipText(job)}
        </span>
        {failed && job.error !== 'decode' && (
          <button
            type="button"
            data-upload-retry
            onPointerDown={(e) => e.preventDefault()}
            onClick={retryUpload}
            className="relative flex h-9 shrink-0 items-center gap-1 rounded-btn bg-red-500 px-3 text-xs font-semibold text-white active:opacity-80"
          >
            <RotateCw size={14} />
            {t('upload.retry')}
          </button>
        )}
        {parked && (
          <button
            type="button"
            data-upload-copy
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => copyUploadPath()}
            className="relative h-9 shrink-0 rounded-btn bg-accent-violet px-3 text-xs font-semibold text-white active:opacity-80"
          >
            {t('upload.copyPath')}
          </button>
        )}
        <button
          type="button"
          data-upload-cancel
          aria-label={running ? t('upload.cancel') : t('upload.dismiss')}
          onPointerDown={(e) => e.preventDefault()}
          onClick={cancelUpload}
          className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-btn text-text-secondary active:bg-bg-secondary"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  )
}
