/**
 * Desktop dictation (app 2.4.0): the renderer side of `dictation:*`. Main
 * runs the Windows recognizer; this store only turns its finished phrases
 * into text the user could have typed.
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
import type { DictationEvt } from '@shared/ipc-contract'
import { isDictationError, type DictationError } from '@shared/dictation'
import { nextFinal, spaced, voiceLang } from '@shared/voiceText'
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

interface DictationState {
  phase: DictationPhase
  target: DictationTarget | null
  /** 'pane:<id>' or 'field:<owner>': where the overlay shows, kept after the end for `error` and `held`. */
  scope: string | null
  sessionId: string | null
  /** The phrase being heard. */
  interim: string
  engine: 'online' | 'offline' | null
  /** Why auto runs offline (privacy: "Online speech recognition" is off). */
  fallback: DictationError | null
  error: DictationError | null
  /** Text the menu guard held back (console target), typed only with Insert. */
  held: string
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
}))

export function scopeOf(target: DictationTarget): string {
  return target.kind === 'pane' ? `pane:${target.paneId}` : `field:${target.owner}`
}

// Per session, never rendered: what nextFinal already committed, the text
// produced so far (spacing and case of the next phrase) and the console's pty.
let committed = ''
let sessionText = ''
let targetPty: string | undefined
let startSeq = 0
/** Events that arrived before the start reply named the session. */
let early: DictationEvt[] = []
let subscribed = false

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
  committed = ''
  sessionText = ''
  early = []
  const token = ++startSeq
  useDictationStore.setState({ phase: 'starting', target, scope, sessionId: null, interim: '', engine: null, fallback: null, error: null, held: '' })
  const engine = useAppStore.getState().settings.dictation?.engine ?? 'auto'
  let res: { ok: boolean; sessionId?: string; error?: DictationError }
  try {
    res = await a.start({ engine, lang: resolveLang() })
  } catch {
    res = { ok: false, error: 'spawn' }
  }
  if (token !== startSeq) {
    // Stopped or replaced while starting.
    if (res.ok && res.sessionId) void a.stop(res.sessionId).catch(() => undefined)
    return
  }
  if (!res.ok || !res.sessionId) {
    useDictationStore.setState({ phase: 'idle', target: null, sessionId: null, error: isDictationError(res.error) ? res.error : 'spawn' })
    return
  }
  useDictationStore.setState({ sessionId: res.sessionId })
  const queued = early.filter((e) => e.sessionId === res.sessionId)
  early = []
  for (const e of queued) onEvent(e)
}

/** Ends the session; the last phrase still arrives before `end`. */
export function stopDictation(): void {
  const s = useDictationStore.getState()
  if (s.phase === 'idle') return
  if (!s.sessionId) {
    // The start reply has not come yet: it stops the session it gets.
    startSeq++
    useDictationStore.setState({ phase: 'idle', target: null, sessionId: null, interim: '' })
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
  useDictationStore.setState({ scope: null, error: null, held: '', fallback: null, engine: null })
}

/** A console's terminal unmounted: its session stops and its notices go. */
export function releaseDictationScope(scope: string): void {
  const s = useDictationStore.getState()
  if (s.scope !== scope) return
  if (s.phase !== 'idle') stopDictation()
  useDictationStore.setState({ scope: null, target: null, error: null, held: '', fallback: null, engine: null, interim: '' })
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

function deliver(text: string): void {
  const s = useDictationStore.getState()
  const target = s.target
  if (!target) return
  const next = nextFinal(committed, text)
  committed = next.committed
  if (!next.fresh) return
  if (target.kind === 'field') {
    const chunk = sanitizePasteText(spaced(target.before(), next.fresh))
    if (chunk) target.insert(chunk)
    return
  }
  // oneLine trims, so it runs on the phrase and spaced adds the joining space after it.
  const chunk = spaced(sessionText, oneLine(sanitizePasteText(next.fresh)))
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
    case 'ready':
      useDictationStore.setState({ phase: s.phase === 'stopping' ? 'stopping' : 'listening', engine: e.engine ?? null, fallback: isDictationError(e.fallback) ? e.fallback : null })
      break
    case 'hyp':
      useDictationStore.setState({ interim: typeof e.text === 'string' ? e.text : '' })
      break
    case 'final':
      useDictationStore.setState({ interim: '' })
      if (typeof e.text === 'string') deliver(e.text)
      break
    case 'error':
      useDictationStore.setState({ error: isDictationError(e.code) ? e.code : 'internal' })
      break
    case 'end':
      useDictationStore.setState({ phase: 'idle', target: null, sessionId: null, interim: '' })
      break
  }
}

/** Tests: drop the module state between cases. */
export function __resetDictationForTests(): void {
  committed = ''
  sessionText = ''
  targetPty = undefined
  early = []
  startSeq++
  fieldToggler = null
  useDictationStore.setState({ phase: 'idle', target: null, scope: null, sessionId: null, interim: '', engine: null, fallback: null, error: null, held: '' })
}
