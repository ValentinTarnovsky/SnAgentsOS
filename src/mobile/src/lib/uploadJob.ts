/**
 * The phone's image upload job (E3-FR-06..09): one at a time, shown by the
 * UploadChip above the composer and the KeyBar.
 *
 *  preparing -> uploading (percent) -> delivered (the job ends)
 *            \-> failed (red chip, Retry re-sends the prepared image)
 *            \-> paneGone (the console closed meanwhile: [Copy path])
 *            \-> undelivered (offline when it finished: [Copy path])
 *
 * Delivery (E3-FR-09): the reference `"<path>" ` goes to the pane the upload
 * started on, even when another one is viewed now. From the composer it is
 * appended to that pane's draft (the live field when it is mounted on that
 * pane, else the saved draft); from the KeyBar in Direct mode it is typed into
 * that pane with the safe paste of E3-FR-05, never with Enter.
 *
 * Every outcome also goes to the connection log (E2 M9) as a short line with
 * the type, size and error code only: never the token nor the PC path.
 */
import { create } from 'zustand'
import { client } from './client'
import { store } from './store'
import { getActiveTerm, getComposerHandle } from './terminalBus'
import { paneById } from './workspace'
import { loadDraft, saveDraft } from './drafts'
import { COMPOSER_MAX, abortableSleep } from './composerSend'
import { pasteBracketed, safePaste } from './safePaste'
import { copyText } from './clipboard'
import { log } from './connLog'
import { t } from './i18n'
import {
  TOKEN_WAIT_MS,
  UploadError,
  appendRef,
  attachmentRef,
  prepareImage,
  uploadImage,
  type PreparedImage,
  type UploadErrorCode,
  type UploadXhr,
} from './upload'

export type UploadOrigin = 'composer' | 'direct'
export type UploadPhase = 'preparing' | 'uploading' | 'failed' | 'paneGone' | 'undelivered'

export interface UploadJob {
  id: number
  paneId: string
  origin: UploadOrigin
  phase: UploadPhase
  /** 0..100 while uploading. */
  progress: number
  error?: UploadErrorCode
  /** The PC-side path once uploaded (paneGone / undelivered). */
  path?: string
  /** Object URL of the prepared image for the chip's thumbnail. */
  preview?: string
}

interface UploadState {
  job: UploadJob | null
}

export const useUploadStore = create<UploadState>(() => ({ job: null }))

let seq = 0
let controller: AbortController | null = null
let prepared: PreparedImage | null = null
/** Test seam: a fake XMLHttpRequest factory. */
let xhrFactory: (() => UploadXhr) | undefined

export function setUploadXhrFactory(factory: (() => UploadXhr) | undefined): void {
  xhrFactory = factory
}

function patch(id: number, next: Partial<UploadJob>): void {
  const job = useUploadStore.getState().job
  if (job && job.id === id) useUploadStore.setState({ job: { ...job, ...next } })
}

function revokePreview(job: UploadJob | null): void {
  if (job?.preview) {
    try {
      URL.revokeObjectURL(job.preview)
    } catch {
      /* already gone */
    }
  }
}

/** Busy jobs block a new pick; a failed or finished one is replaced. */
export function uploadBusy(): boolean {
  const phase = useUploadStore.getState().job?.phase
  return phase === 'preparing' || phase === 'uploading'
}

/** Resolves with the next authOk's httpToken (different from used), or null after TOKEN_WAIT_MS. */
export function waitForNewToken(used: string, ms: number = TOKEN_WAIT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    const now = store.getState().httpToken
    if (now && now !== used) return resolve(now)
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsub = store.subscribe((s) => {
      if (s.httpToken && s.httpToken !== used) finish(s.httpToken)
    })
    function finish(token: string | null): void {
      if (timer) clearTimeout(timer)
      unsub()
      resolve(token)
    }
    timer = setTimeout(() => finish(null), ms)
  })
}

/** Start uploading a picked file for paneId. Ignored while another upload is busy. */
export function startUpload(file: File, paneId: string, origin: UploadOrigin): void {
  if (uploadBusy() || !paneId) return
  cancelUpload()
  const id = ++seq
  useUploadStore.setState({ job: { id, paneId, origin, phase: 'preparing', progress: 0 } })
  const ac = new AbortController()
  controller = ac
  void (async () => {
    try {
      const img = await prepareImage(file)
      if (ac.signal.aborted) return
      prepared = img
      let preview: string | undefined
      try {
        preview = URL.createObjectURL(img.blob)
      } catch {
        preview = undefined
      }
      patch(id, { preview })
      await send(id, ac)
    } catch (err) {
      if (ac.signal.aborted) return
      const code = err instanceof UploadError ? err.code : 'decode'
      log('warn', `upload prepare failed: ${code}`)
      if (code === 'tooBig') {
        // E3-FR-07: a toast, not a chip; there is nothing to retry.
        clearJob()
        store.getState().setToast(t('upload.tooBig'))
        return
      }
      patch(id, { phase: 'failed', error: code })
    }
  })()
}

async function send(id: number, ac: AbortController): Promise<void> {
  const img = prepared
  if (!img) return
  patch(id, { phase: 'uploading', progress: 0, error: undefined })
  try {
    const path = await uploadImage(img.blob, img.type, {
      token: () => store.getState().httpToken,
      waitForNewToken,
      onProgress: (progress) => patch(id, { progress }),
      signal: ac.signal,
      createXhr: xhrFactory,
    })
    if (ac.signal.aborted) return
    log('info', `upload ok ${img.type} ${img.width}x${img.height} ${Math.ceil(img.blob.size / 1024)}KB`)
    await deliver(id, path)
  } catch (err) {
    if (ac.signal.aborted) return
    const code = err instanceof UploadError ? err.code : 'network'
    log('warn', `upload failed: ${code}`)
    if (code === 'tooBig') {
      clearJob()
      store.getState().setToast(t('upload.tooBig'))
      return
    }
    patch(id, { phase: 'failed', error: code })
  }
}

/** Retry a failed upload with the image already prepared. */
export function retryUpload(): void {
  const job = useUploadStore.getState().job
  if (!job || job.phase !== 'failed') return
  if (!prepared) {
    clearJob()
    return
  }
  controller?.abort()
  const ac = new AbortController()
  controller = ac
  void send(job.id, ac)
}

/** The X: abort a running upload (the server drops the partial) or dismiss the chip. */
export function cancelUpload(): void {
  controller?.abort()
  controller = null
  clearJob()
}

function clearJob(): void {
  revokePreview(useUploadStore.getState().job)
  prepared = null
  useUploadStore.setState({ job: null })
}

/**
 * [Copy path] of a paneGone / undelivered chip. Synchronous: it must run
 * straight from the tap (copyText's execCommand fallback needs the gesture).
 */
export function copyUploadPath(): boolean {
  const path = useUploadStore.getState().job?.path
  if (!path) return false
  const ok = copyText(path)
  store.getState().setToast(t(ok ? 'upload.copied' : 'upload.copyFailed'))
  if (ok) clearJob()
  return ok
}

/** Put the reference where E3-FR-09 says, or park the job with its path. */
async function deliver(id: number, path: string): Promise<void> {
  const job = useUploadStore.getState().job
  if (!job || job.id !== id) return
  const s = store.getState()
  if (!s.snapshot || !paneById(s.snapshot, job.paneId)) {
    log('warn', 'upload not inserted: console closed')
    patch(id, { phase: 'paneGone', path })
    return
  }
  const ref = attachmentRef(path)
  const ok = job.origin === 'composer' ? appendToDraft(job.paneId, ref) : await typeIntoPane(job.paneId, ref)
  if (!ok) {
    log('warn', `upload not inserted: ${job.origin}`)
    patch(id, { phase: 'undelivered', path })
    return
  }
  controller = null
  clearJob()
}

/** Composer origin: the live field when it shows that pane, else the saved draft. */
export function appendToDraft(paneId: string, ref: string): boolean {
  const handle = getComposerHandle()
  if (handle && handle.paneId() === paneId) return handle.append(ref)
  const next = appendRef(loadDraft(paneId)?.text ?? '', ref, COMPOSER_MAX)
  if (next == null) return false
  saveDraft(paneId, next)
  return true
}

/** Direct origin: a safe paste into that pane, bracketed like the composer would, no Enter. */
async function typeIntoPane(paneId: string, ref: string): Promise<boolean> {
  const s = store.getState()
  const termMode = s.subscribedPaneId === paneId ? getActiveTerm()?.modes.bracketedPasteMode : undefined
  return safePaste(
    ref,
    { bracketed: pasteBracketed(termMode, s.paneStatus[paneId]), enter: false, signal: new AbortController().signal },
    { sendInput: (data, opts) => client.sendInputTo(paneId, data, opts), sleep: abortableSleep },
  )
}
