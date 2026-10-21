/**
 * Desktop dictation (app 2.5.0): the renderer side of `dictation:*`. Main
 * runs the local Whisper engine; this store captures the microphone
 * (dictationCapture, 16 kHz mono s16 chunks over `dictation:audio`) and
 * turns the finished phrases into text the user could have typed.
 *
 *  - Capture starts together with `dictation:start`. Chunks captured before
 *    the reply names the session wait (at most EARLY_CHUNKS_MAX, the oldest
 *    go first) and are sent in order once it does. The capture stops on
 *    `end`, Stop, a replacing start, a refused start and a capture error
 *    (which shows its code and stops the session).
 *  - `slow`: the engine takes long. Before `ready`, after STARTING_SLOW_MS;
 *    after a GPU `ready`, when speech was sent and no answer (final or hyp)
 *    has come back REPLY_SLOW_MS after the last voiced chunk (the first CUDA
 *    JIT runs on the first request, after `ready`). Main sends a `final` with
 *    empty text when a phrase leaves nothing (VAD, the hallucination filter),
 *    so a warm engine that hears only noise never reads as slow. The first
 *    answer clears it for the session; a CPU engine is never `slow` after
 *    `ready` (its model loads before it).
 *  - `timeout` is a notice, not an end: the next answer or `ready` clears it,
 *    and so does `end` (TRANSIENT_ERRORS).
 *
 *  - A console target types each phrase with xterm's paste path (origin
 *    'user'), on one line, sanitized: never a CR or LF, so never an Enter. It
 *    works in SSH consoles too, the text goes into the local pty.
 *  - Menu guard: while the console's agent waits on a plan, permission,
 *    question or elicitation, or its screen shows a numbered menu, nothing is
 *    typed (a dictated "2 archivos" would pick option 2). The text waits in
 *    the overlay until the user presses Insert.
 *  - A field target (the global prompt) inserts at its caret.
 *  - The session stops on another start, Stop, the shortcut again, the
 *    console's pty changing or its terminal unmounting, and `end` from main.
 */
import { create } from 'zustand'
import type { DictationEvt, DictationStartReq } from '@shared/ipc-contract'
import { isDictationError, type DictationError } from '@shared/dictation'
import { spaced, voiceLang } from '@shared/voiceText'
import { sanitizePasteText } from '@shared/sanitize-paste'
import { parseMenu } from '@shared/promptMenu'
import { waitsOnUser } from '@shared/status'
import { translate } from '@/i18n'
import { useAppStore } from './store'
import { oneLine } from './broadcastPrompt'
import { pasteToPane } from './pasteRegistry'
import { getPtyId, onPtyRegistryChange } from './ptyRegistry'
import { readTerm } from './termReaders'
import { focusPane, getFocusedPane } from './focus'
import { toast } from './toast'
import { captureErrorCode, startCapture, type Capture, type CaptureError } from './dictationCapture'

/** `slow` while the start has no `ready` this long. */
export const STARTING_SLOW_MS = 4000
/** `slow` when no phrase came back this long after the last voiced chunk (first reply of the session only). */
export const REPLY_SLOW_MS = 4000
/** Chunks kept before the session id arrives: 10 s of 100 ms chunks. */
export const EARLY_CHUNKS_MAX = 100
/** RMS (s16) of a chunk that counts as speech for `slow`: about -34 dBFS. */
export const VOICED_RMS = 650

export type DictationTarget =
  | { kind: 'pane'; paneId: string }
  | {
      kind: 'field'
      /** Stable id of the field (its scope). */
      owner: string
      /** Insert at the caret. */
      insert: (text: string) => void
      /** The field's text before the caret (spacing and case of the next phrase). */
      before: () => string
    }

export type DictationPhase = 'idle' | 'starting' | 'listening' | 'stopping'

export interface DictationState {
  phase: DictationPhase
  target: DictationTarget | null
  /** 'pane:<id>' or 'field:<owner>': where the overlay shows, kept after the end for `error` and `held`. */
  scope: string | null
  sessionId: string | null
  /** The phrase being heard. */
  interim: string
  /** The device the engine runs on, from `ready`. */
  engine: 'gpu' | 'cpu' | null
  /** Why it runs on CPU although the GPU was wanted ('gpu_failed'). */
  fallback: DictationError | null
  error: DictationError | null
  /** Text the menu guard held back (console target), typed only with Insert. */
  held: string
  /** The engine is slow to answer (cold start or first CUDA JIT): the overlay says so. */
  slow: boolean
}

export const useDictationStore = create<DictationState>(() => ({
  phase: 'idle',
  target: null,
  scope: null,
  sessionId: null,
  interim: '',
  engine: null,
  fallback: null,
  error: null,
  held: '',
  slow: false,
}))

export function scopeOf(target: DictationTarget): string {
  return target.kind === 'pane' ? `pane:${target.paneId}` : `field:${target.owner}`
}

// Per session, never rendered: the text produced so far (spacing and case of
// the next phrase) and the console's pty.
let sessionText = ''
let targetPty: string | undefined
let startSeq = 0
/** Events that arrived before the start reply named the session. */
let early: DictationEvt[] = []
let subscribed = false

// The microphone of the current session. Every capture callback carries the
// captureSeq it was started with; stopCapture bumps it, so a late chunk,
// error or resolved start of an older capture is dropped (and stopped).
let capture: Capture | null = null
let captureSeq = 0
/** Chunks captured before the start reply named the session. */
let pendingChunks: ArrayBuffer[] = []
let slowTimer: ReturnType<typeof setTimeout> | null = null
/** `ready` arrived for this session. */
let readySeen = false
/** A final or hyp arrived for this session: the engine answers, `slow` is over. */
let replied = false
/** Speech was sent and nothing came back yet. */
let voicedUnanswered = false

function stopCapture(): void {
  captureSeq++
  const c = capture
  capture = null
  pendingChunks = []
  c?.stop()
}

function clearSlowTimer(): void {
  if (slowTimer !== null) clearTimeout(slowTimer)
  slowTimer = null
}

function armSlow(ms: number, token: number, cond: () => boolean): void {
  clearSlowTimer()
  slowTimer = setTimeout(() => {
    slowTimer = null
    if (token !== startSeq || useDictationStore.getState().phase === 'idle' || !cond()) return
    useDictationStore.setState({ slow: true })
  }, ms)
}

function armReplySlow(): void {
  armSlow(REPLY_SLOW_MS, startSeq, () => !replied)
}

function chunkRms(pcm: ArrayBuffer): number {
  const v = new Int16Array(pcm, 0, pcm.byteLength >> 1)
  if (v.length === 0) return 0
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  return Math.sqrt(sum / v.length)
}

function onChunk(seq: number, pcm: ArrayBuffer): void {
  if (seq !== captureSeq) return
  const s = useDictationStore.getState()
  if (s.phase === 'idle' || s.phase === 'stopping') return
  if (!replied && chunkRms(pcm) >= VOICED_RMS) {
    voicedUnanswered = true
    // Only the GPU pays a load on its first request (the CUDA JIT); a CPU engine is loaded at `ready`.
    if (readySeen && s.engine === 'gpu') armReplySlow()
  }
  if (s.sessionId) {
    api()?.audio(s.sessionId, pcm)
    return
  }
  pendingChunks.push(pcm)
  if (pendingChunks.length > EARLY_CHUNKS_MAX) pendingChunks.shift()
}

function onCaptureError(seq: number, code: CaptureError): void {
  if (seq !== captureSeq) return
  stopCapture()
  if (useDictationStore.getState().phase === 'idle') return
  useDictationStore.setState({ error: code })
  stopDictation()
}

function beginCapture(): void {
  stopCapture()
  const seq = captureSeq
  startCapture(
    (pcm) => onChunk(seq, pcm),
    (code) => onCaptureError(seq, code),
  ).then(
    (c) => {
      if (seq !== captureSeq) c.stop()
      else capture = c
    },
    (e: unknown) => onCaptureError(seq, captureErrorCode(e)),
  )
}

function api() {
  return typeof window !== 'undefined' ? window.snApi?.dictation : undefined
}

function ensureSubscribed(): void {
  if (subscribed) return
  const a = api()
  if (!a) return
  subscribed = true
  a.onEvent(onEvent)
  // The console restarted or died: its new pty never gets text meant for the old one.
  onPtyRegistryChange(() => {
    const t = useDictationStore.getState().target
    if (t?.kind === 'pane' && getPtyId(t.paneId) !== targetPty) stopDictation()
  })
}

/**
 * The console's agent waits on an answer, or its screen ends in a numbered
 * menu (shared parseMenu, the phone's rules): typing there could pick an option.
 */
export function menuPending(paneId: string): boolean {
  const st = useAppStore.getState().paneStatus[paneId]
  if (waitsOnUser(st) || (st?.state === 'action' && (st.pending?.length ?? 0) > 0)) return true
  const rows = readTerm(paneId, 60)
  return !!rows && parseMenu(rows) !== null
}

function resolveLang(): string {
  const s = useAppStore.getState().settings
  const pref = s.dictation?.language ?? 'auto'
  if (pref !== 'auto') return pref
  return voiceLang('auto', s.language, typeof navigator !== 'undefined' ? navigator.language : '')
}

export async function startDictation(target: DictationTarget): Promise<void> {
  const a = api()
  const scope = scopeOf(target)
  if (!a) {
    useDictationStore.setState({ phase: 'idle', target: null, scope, sessionId: null, interim: '', error: 'unsupported', held: '' })
    return
  }
  ensureSubscribed()
  if (target.kind === 'pane') {
    targetPty = getPtyId(target.paneId)
    if (!targetPty) return
  }
  // A running session is replaced: main ends it before starting this one.
  sessionText = ''
  early = []
  readySeen = false
  replied = false
  voicedUnanswered = false
  const token = ++startSeq
  useDictationStore.setState({ phase: 'starting', target, scope, sessionId: null, interim: '', engine: null, fallback: null, error: null, held: '', slow: false })
  armSlow(STARTING_SLOW_MS, token, () => !readySeen)
  // The microphone opens while main starts the session; its chunks wait for the id.
  beginCapture()
  const req: DictationStartReq = { lang: resolveLang() }
  if (target.kind === 'pane') req.paneId = target.paneId
  let res: { ok: boolean; sessionId?: string; error?: DictationError }
  try {
    res = await a.start(req)
  } catch {
    res = { ok: false, error: 'spawn' }
  }
  if (token !== startSeq) {
    // Stopped or replaced while starting (whoever did it stopped the capture).
    if (res.ok && res.sessionId) void a.stop(res.sessionId).catch(() => undefined)
    return
  }
  if (!res.ok || !res.sessionId) {
    stopCapture()
    clearSlowTimer()
    useDictationStore.setState({ phase: 'idle', target: null, sessionId: null, slow: false, error: isDictationError(res.error) ? res.error : 'spawn' })
    return
  }
  const sessionId = res.sessionId
  useDictationStore.setState({ sessionId })
  const chunks = pendingChunks
  pendingChunks = []
  for (const c of chunks) a.audio(sessionId, c)
  const queued = early.filter((e) => e.sessionId === sessionId)
  early = []
  for (const e of queued) onEvent(e)
}

/** Ends the session; the last phrase still arrives before `end`. The microphone closes now. */
export function stopDictation(): void {
  const s = useDictationStore.getState()
  if (s.phase === 'idle') return
  stopCapture()
  if (!s.sessionId) {
    // The start reply has not come yet: it stops the session it gets.
    startSeq++
    clearSlowTimer()
    useDictationStore.setState({ phase: 'idle', target: null, sessionId: null, interim: '', slow: false })
    return
  }
  if (s.phase === 'stopping') return
  useDictationStore.setState({ phase: 'stopping' })
  void api()?.stop(s.sessionId).catch(() => undefined)
}

export function isDictating(scope: string): boolean {
  const s = useDictationStore.getState()
  return s.phase !== 'idle' && s.scope === scope
}

/** The header mic, the context menu and the shortcut: start on this console, or stop it. */
export function toggleDictationPane(paneId: string): void {
  if (isDictating(`pane:${paneId}`)) {
    stopDictation()
    return
  }
  if (!getPtyId(paneId)) {
    toast.info(translate(useAppStore.getState().settings.language, 'dictation.noConsole'), { dedupeKey: 'dictation' })
    return
  }
  void startDictation({ kind: 'pane', paneId })
}

/** Types the held text (the user answered the agent first). Still never an Enter. */
export function insertHeld(): void {
  const s = useDictationStore.getState()
  const paneId = s.scope?.startsWith('pane:') ? s.scope.slice(5) : null
  if (!paneId || !s.held) return
  if (pasteToPane(paneId, s.held)) {
    useDictationStore.setState({ held: '' })
    requestAnimationFrame(() => focusPane(paneId))
  }
}

/** Closes the overlay's notice (error, held text) once the session is over. */
export function dismissDictation(): void {
  const s = useDictationStore.getState()
  if (s.phase !== 'idle') return
  useDictationStore.setState({ scope: null, error: null, held: '', fallback: null, engine: null, slow: false })
}

/** A console's terminal unmounted: its session stops and its notices go. */
export function releaseDictationScope(scope: string): void {
  const s = useDictationStore.getState()
  if (s.scope !== scope) return
  if (s.phase !== 'idle') stopDictation()
  clearSlowTimer()
  useDictationStore.setState({ scope: null, target: null, error: null, held: '', fallback: null, engine: null, interim: '', slow: false })
}

let fieldToggler: (() => void) | null = null

/** A dialog with a mic (the global prompt) takes the shortcut while it is open. */
export function setDictationFieldToggler(fn: (() => void) | null): void {
  fieldToggler = fn
}

/** The `dictate` shortcut (Ctrl+Shift+H): the open field's mic, else the focused console. */
export function runDictateShortcut(): void {
  if (fieldToggler) {
    fieldToggler()
    return
  }
  const app = useAppStore.getState()
  if (app.paletteOpen || app.settingsOpen || app.wizardOpen || app.quickPopoverOpen) return
  const s = useDictationStore.getState()
  if (s.phase !== 'idle' && s.target?.kind === 'pane') {
    stopDictation()
    return
  }
  let paneId = getFocusedPane()
  if (!paneId || !getPtyId(paneId)) {
    const ws = app.workspaces.find((w) => w.id === app.activeWorkspaceId)
    paneId = ws?.panes.find((p) => getPtyId(p.id))?.id ?? null
  }
  if (!paneId) {
    toast.info(translate(app.settings.language, 'dictation.noConsole'), { dedupeKey: 'dictation' })
    return
  }
  toggleDictationPane(paneId)
}

/**
 * One Whisper `final` is one new phrase, never the session so far (app 2.5.0):
 * it is typed whole, also when it repeats or extends the phrase before it
 * ("sí" twice, "git status" then "git status otra vez"). The phone's
 * `nextFinal` dedupe is for Android's cumulative results and does not apply.
 */
function deliver(text: string): void {
  const s = useDictationStore.getState()
  const target = s.target
  if (!target) return
  const fresh = text.replace(/\s+/g, ' ').trim()
  if (!fresh) return
  if (target.kind === 'field') {
    const chunk = sanitizePasteText(spaced(target.before(), fresh))
    if (chunk) target.insert(chunk)
    return
  }
  // oneLine trims, so it runs on the phrase and spaced adds the joining space after it.
  const chunk = spaced(sessionText, oneLine(sanitizePasteText(fresh)))
  if (!chunk) return
  sessionText += chunk
  // Once something is held, the rest waits too, so the order never changes.
  // A pty that changed since the start (restart, respawn) never gets this
  // session's text unasked: it is held for Insert.
  if (s.held || getPtyId(target.paneId) !== targetPty || menuPending(target.paneId) || !pasteToPane(target.paneId, chunk)) {
    useDictationStore.setState({ held: s.held + chunk })
  }
}

function onEvent(e: DictationEvt): void {
  const s = useDictationStore.getState()
  if (!e || typeof e.sessionId !== 'string') return
  if (s.sessionId !== e.sessionId) {
    if (s.phase === 'starting' && !s.sessionId && early.length < 64) early.push(e)
    return
  }
  switch (e.t) {
    case 'ready': {
      readySeen = true
      clearSlowTimer()
      const engine = e.engine === 'gpu' || e.engine === 'cpu' ? e.engine : null
      useDictationStore.setState({ phase: s.phase === 'stopping' ? 'stopping' : 'listening', engine, fallback: isDictationError(e.fallback) ? e.fallback : null, slow: false, ...noticeGone(s) })
      // Speech already sent while the engine started: its first reply may hit the cold JIT (GPU only).
      if (voicedUnanswered && !replied && engine === 'gpu') armReplySlow()
      break
    }
    case 'hyp':
      answered()
      // An empty hyp (VAD heard nothing yet) keeps the phrase shown so far.
      if (typeof e.text === 'string' && e.text) useDictationStore.setState({ interim: e.text, ...noticeGone(s) })
      break
    case 'final':
      // Main also sends an empty final (the phrase left no text): nothing to type, but the engine answered.
      answered()
      useDictationStore.setState({ interim: '', ...noticeGone(s) })
      if (typeof e.text === 'string' && e.text) deliver(e.text)
      break
    case 'error':
      useDictationStore.setState({ error: isDictationError(e.code) ? e.code : 'internal' })
      break
    case 'end':
      stopCapture()
      clearSlowTimer()
      // A transient notice does not outlive the session (a fatal error, sent right before `end`, stays).
      useDictationStore.setState({ phase: 'idle', target: null, sessionId: null, interim: '', slow: false, ...noticeGone(useDictationStore.getState()) })
      break
  }
}

/**
 * Errors that do not end the session (`timeout`: one phrase was dropped and
 * the engine was restarted) are a notice: the next phrase, hyp or `ready`
 * clears it, and so does `end`.
 */
export const TRANSIENT_ERRORS: ReadonlySet<DictationError> = new Set<DictationError>(['timeout'])

function noticeGone(s: DictationState): { error?: null } {
  return s.error && TRANSIENT_ERRORS.has(s.error) ? { error: null } : {}
}

/** The engine answered with a phrase: no more `slow` this session. */
function answered(): void {
  if (replied) return
  replied = true
  voicedUnanswered = false
  clearSlowTimer()
  if (useDictationStore.getState().slow) useDictationStore.setState({ slow: false })
}

/** Tests: drop the module state between cases. */
export function __resetDictationForTests(): void {
  sessionText = ''
  targetPty = undefined
  early = []
  startSeq++
  stopCapture()
  clearSlowTimer()
  readySeen = false
  replied = false
  voicedUnanswered = false
  fieldToggler = null
  useDictationStore.setState({ phase: 'idle', target: null, scope: null, sessionId: null, interim: '', engine: null, fallback: null, error: null, held: '', slow: false })
}
