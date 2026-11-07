/**
 * Hands-free voice (app 2.11.0, Labs voice): the renderer's controller. It
 * keeps a hands-free dictation session open (main's DictationService, kind
 * 'handsfree'), turns each Whisper phrase into a command when it starts with
 * the wake word, selects workspaces and consoles, and fills a per-console
 * dictation buffer that only reaches the console on an explicit "enviar" or
 * "insertar". Main says everything out loud (voice:cmd with phrase keys and
 * ids); this file never sends text to say.
 *
 * The Enter rule (CLAUDE.md): the opt-in is the lab, hands-free on and a
 * spoken send; the precise signal is `userGate` (main refuses `awaiting_user`
 * and holds a late Enter) plus menuPending here. A refusal is said out loud
 * and the buffer is kept.
 *
 * Half-duplex: while main's voice plays, and for TAIL_MS after it, a phrase
 * without the wake word is dropped (the microphone hears the speakers); a
 * phrase with it stops the voice first (barge-in).
 */
import { create } from 'zustand'
import type { DictationEvt } from '@shared/ipc-contract'
import { labOn } from '@shared/labs'
import { bareDictationCommand, matchWake, parseVoiceCommand, splitAtLastWake, type VoiceCommand } from '@shared/voiceCommands'
import { pickOption, resolveSpokenRef, spokenLabels, type SpokenTarget } from '@shared/spokenNames'
import { voiceLangOf, wakeWordFor, type VoiceCmd, type VoiceMode, type VoiceRoster, type VoiceSayKey } from '@shared/voice'
import { spaced } from '@shared/voiceText'
import { sanitizePasteText } from '@shared/sanitize-paste'
import { useAppStore } from './store'
import { useAgentStore } from './agentStore'
import { isDefaultTitle, orderedPanes } from './agentNav'
import { liveSidebarOrder } from './sidebarOrder'
import { revealPane } from './revealPane'
import { getFocusedPane } from './focus'
import { getPtyId } from './ptyRegistry'
import { menuPending, useDictationStore } from './dictation'
import { oneLine } from './broadcastPrompt'
import { startCapture, type Capture } from './dictationCapture'
import { isVoicePlaying, sinceVoiceEnded, stopVoice, wireVoicePlayer } from './voicePlayer'

/** After main's voice stops, phrases without the wake word are still dropped this long (echo of the speakers). */
export const TAIL_MS = 1200
/** Waiting for "API o API Gateway?". */
export const CONFIRM_MS = 8000
/** A start that fails is retried once after this long. */
export const RETRY_MS = 3000

export type HandsFreePhase = 'off' | 'starting' | 'listening' | 'armed' | 'dictating' | 'confirming' | 'paused'

export interface HandsFreeState {
  phase: HandsFreePhase
  /** The console commands and dictation go to. */
  target: string | null
  /** Dictated text not sent yet, for `target`. */
  buffer: string
  /** A dictation that went idle, kept for Enviar / Insertar / Descartar in the overlay. */
  held: { paneId: string; text: string } | null
  options: SpokenTarget[]
  speaking: boolean
  error: string | null
  /** The last phrase taken as a command (shown in the pill's tooltip). */
  lastCommand: string
}

export const useHandsFreeStore = create<HandsFreeState>(() => ({ phase: 'off', target: null, buffer: '', held: null, options: [], speaking: false, error: null, lastCommand: '' }))

let capture: Capture | null = null
let sessionId: string | null = null
let pending: ArrayBuffer[] = []
let subscribed = false
let roster: VoiceRoster = { workspaces: [] }
let unsubRoster: (() => void) | null = null
let unsubDictation: (() => void) | null = null
let followTimer: ReturnType<typeof setTimeout> | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let confirmTimer: ReturnType<typeof setTimeout> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let startSeq = 0

function voiceApi() {
  return typeof window !== 'undefined' ? window.snApi?.voice : undefined
}
function dictApi() {
  return typeof window !== 'undefined' ? window.snApi?.dictation : undefined
}

function settings() {
  return useAppStore.getState().settings
}

function lang(): 'es' | 'en' {
  const s = settings()
  return voiceLangOf(s.voice?.language, s.language)
}

function wake(): string {
  return wakeWordFor(settings().voice?.wakeWord, lang())
}

function set(p: Partial<HandsFreeState>): void {
  useHandsFreeStore.setState(p)
}

function mode(m: VoiceMode): void {
  voiceApi()?.mode(m)
}

function say(key: VoiceSayKey, extra: Omit<Extract<VoiceCmd, { kind: 'say' }>, 'kind' | 'key'> = {}): void {
  void voiceApi()
    ?.cmd({ kind: 'say', key, ...extra })
    .catch(() => undefined)
}

function clearTimer(t: ReturnType<typeof setTimeout> | null): null {
  if (t) clearTimeout(t)
  return null
}

// --- roster -------------------------------------------------------------------

/** The names to say, from the store: workspaces in sidebar order, consoles in grid order. */
export function currentRoster(): VoiceRoster {
  const app = useAppStore.getState()
  const ordered = liveSidebarOrder(app, useAgentStore.getState())
  return spokenLabels({
    workspaces: ordered.map((ws) => ({
      id: ws.id,
      name: ws.name,
      panes: orderedPanes(ws).map((p) => ({ id: p.id, title: p.title, defaultTitle: isDefaultTitle(p, app.presets) })),
    })),
  })
}

function pushRoster(): void {
  roster = currentRoster()
  voiceApi()?.roster(roster)
}

// --- lifecycle -------------------------------------------------------------------

export function handsFreeOn(): boolean {
  return useHandsFreeStore.getState().phase !== 'off'
}

/** The pill, the shortcut and the global hotkey. */
export function toggleHandsFree(): void {
  if (handsFreeOn()) void stopHandsFree(true)
  else void startHandsFree()
}

export async function startHandsFree(): Promise<void> {
  const v = voiceApi()
  const d = dictApi()
  if (!v || !d || !labOn(settings(), 'voice')) return
  if (handsFreeOn() && useHandsFreeStore.getState().phase !== 'paused') return
  ensureSubscribed()
  wireVoicePlayer()
  const token = ++startSeq
  set({ phase: 'starting', error: null })
  const res = await v.setActive(true).catch(() => ({ ok: false as const, error: 'disabled' as const }))
  if (token !== startSeq) return
  if (!res.ok) {
    set({ phase: 'off', error: res.error ?? 'disabled' })
    return
  }
  pushRoster()
  unsubRoster ??= useAppStore.subscribe((s, prev) => {
    if (s.workspaces !== prev.workspaces || s.presets !== prev.presets) pushRoster()
  })
  // A manual dictation owns the engine: wait for it to end.
  if (useDictationStore.getState().phase !== 'idle') {
    set({ phase: 'paused' })
    mode('paused')
    return
  }
  await openSession(token)
}

async function openSession(token: number): Promise<void> {
  const d = dictApi()
  if (!d) return
  pending = []
  sessionId = null
  try {
    capture = await startCapture(
      (pcm) => {
        if (sessionId) d.audio(sessionId, pcm)
        else if (pending.length < 100) pending.push(pcm)
      },
      () => void stopHandsFree(false, 'audio'),
    )
  } catch (e) {
    set({ phase: 'off', error: e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : 'audio' })
    void voiceApi()?.setActive(false)
    return
  }
  if (token !== startSeq) {
    capture?.stop()
    capture = null
    return
  }
  const res = await d.start({ lang: lang(), mode: 'handsfree' }).catch(() => ({ ok: false as const, error: 'spawn' as const }))
  if (token !== startSeq) {
    if (res.ok && res.sessionId) void d.stop(res.sessionId)
    return
  }
  if (!res.ok || !res.sessionId) {
    capture?.stop()
    capture = null
    if (res.error === 'busy') {
      set({ phase: 'paused' })
      mode('paused')
      return
    }
    set({ phase: 'off', error: res.error ?? 'spawn' })
    void voiceApi()?.setActive(false)
    return
  }
  sessionId = res.sessionId
  for (const c of pending) d.audio(sessionId, c)
  pending = []
  const target = useHandsFreeStore.getState().target ?? getFocusedPane()
  set({ phase: 'listening', target, error: null })
  mode('listening')
  say('listening')
}

/** Turns hands-free off. `spoken`: say "manos libres apagado" first (the user asked). */
export async function stopHandsFree(spoken = false, error: string | null = null): Promise<void> {
  ++startSeq
  if (spoken) say('off')
  followTimer = clearTimer(followTimer)
  idleTimer = clearTimer(idleTimer)
  confirmTimer = clearTimer(confirmTimer)
  retryTimer = clearTimer(retryTimer)
  capture?.stop()
  capture = null
  const id = sessionId
  sessionId = null
  if (id) void dictApi()?.stop(id).catch(() => undefined)
  unsubRoster?.()
  unsubRoster = null
  mode('off')
  // Let the goodbye play before main drops the queue.
  if (spoken) await new Promise((r) => setTimeout(r, 1500))
  void voiceApi()?.setActive(false).catch(() => undefined)
  const s = useHandsFreeStore.getState()
  const held = s.buffer && s.target ? { paneId: s.target, text: s.buffer } : s.held
  set({ phase: 'off', buffer: '', options: [], held, error })
}

function ensureSubscribed(): void {
  if (subscribed) return
  const d = dictApi()
  const v = voiceApi()
  if (!d || !v) return
  subscribed = true
  unsubDictation = d.onEvent(onDictationEvent)
  v.onEvent((e) => {
    if (e.t === 'toggle') toggleHandsFree()
    else if (e.t === 'autoOff') void stopHandsFree(false)
    else if (e.t === 'speaking') set({ speaking: e.on })
  })
  // A manual dictation ended: a paused hands-free session takes the engine back.
  useDictationStore.subscribe((s, prev) => {
    if (prev.phase !== 'idle' && s.phase === 'idle' && useHandsFreeStore.getState().phase === 'paused') void openSession(++startSeq)
  })
}

function onDictationEvent(e: DictationEvt): void {
  if (!e || !sessionId || e.sessionId !== sessionId) return
  if (e.t === 'final' && typeof e.text === 'string' && e.text.trim()) onPhrase(e.text)
  else if (e.t === 'end') {
    sessionId = null
    capture?.stop()
    capture = null
    if (!handsFreeOn()) return
    if (e.reason === 'replaced') {
      set({ phase: 'paused' })
      mode('paused')
      return
    }
    // An engine crash or a stop we did not ask for: one retry, then off.
    retryTimer = clearTimer(retryTimer)
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (handsFreeOn()) void openSession(++startSeq)
    }, RETRY_MS)
  } else if (e.t === 'error' && e.code && e.code !== 'timeout') set({ error: e.code })
}

// --- phrases --------------------------------------------------------------------------

function voiceBusy(): boolean {
  return isVoicePlaying() || useHandsFreeStore.getState().speaking || sinceVoiceEnded() < TAIL_MS
}

/** One Whisper final. Exported for the tests. */
export function onPhrase(text: string): void {
  const s = useHandsFreeStore.getState()
  if (s.phase === 'off' || s.phase === 'starting' || s.phase === 'paused') return
  const w = wake()
  const hit = matchWake(text, w)
  if (!hit.hit && voiceBusy()) return
  if (hit.hit && isVoicePlaying()) stopVoice()

  if (s.phase === 'armed') {
    followTimer = clearTimer(followTimer)
    set({ phase: s.target && s.buffer ? 'dictating' : 'listening' })
    runCommandText(hit.hit ? hit.rest : text)
    return
  }
  if (s.phase === 'confirming') {
    const picked = pickOption(hit.hit ? hit.rest : text, s.options)
    confirmTimer = clearTimer(confirmTimer)
    set({ phase: 'listening', options: [] })
    if (picked) select(picked)
    else if (hit.hit) runCommandText(hit.rest)
    return
  }
  if (s.phase === 'dictating') {
    armIdle()
    if (settings().voice?.bareCommands !== false) {
      const bare = bareDictationCommand(text)
      if (bare) {
        run({ kind: bare }, text)
        return
      }
    }
    if (hit.hit) {
      runCommandText(hit.rest)
      return
    }
    const split = splitAtLastWake(text, w)
    const tail = split ? parseVoiceCommand(split.after) : null
    if (split && tail && (tail.kind === 'send' || tail.kind === 'insert' || tail.kind === 'cancel')) {
      append(split.before)
      run(tail, split.after)
      return
    }
    append(text)
    return
  }
  // listening
  if (!hit.hit) return
  if (!hit.rest.trim()) {
    set({ phase: 'armed' })
    say('yes')
    followTimer = clearTimer(followTimer)
    followTimer = setTimeout(() => {
      followTimer = null
      if (useHandsFreeStore.getState().phase === 'armed') set({ phase: 'listening' })
    }, (settings().voice?.followUpSec ?? 6) * 1000)
    return
  }
  runCommandText(hit.rest)
}

function runCommandText(rest: string): void {
  const cmd = parseVoiceCommand(rest)
  if (!cmd) {
    say('notUnderstood')
    return
  }
  run(cmd, rest)
}

function append(text: string): void {
  const s = useHandsFreeStore.getState()
  const fresh = oneLine(sanitizePasteText(text.replace(/\s+/g, ' ').trim()))
  if (!fresh) return
  set({ buffer: s.buffer + spaced(s.buffer, fresh) })
}

function armIdle(): void {
  idleTimer = clearTimer(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    const s = useHandsFreeStore.getState()
    if (s.phase !== 'dictating' || !s.target) return
    if (s.buffer) say('held', { paneId: s.target })
    set({ phase: 'listening', held: s.buffer ? { paneId: s.target, text: s.buffer } : s.held, buffer: '' })
    mode('listening')
  }, (settings().voice?.dictateIdleSec ?? 90) * 1000)
}

function activeWorkspaceId(): string | null {
  return useAppStore.getState().activeWorkspaceId ?? null
}

function resolve(ref: string, want: 'console' | 'workspace' | 'any') {
  return resolveSpokenRef(ref, roster, activeWorkspaceId(), want)
}

function select(t: SpokenTarget): void {
  if (t.kind === 'workspace') {
    useAppStore.getState().setActive(t.id)
    say('workspace', { workspaceId: t.id })
    return
  }
  revealPane(t.id)
  set({ target: t.id })
  say('console', { paneId: t.id })
}

function selectOrAsk(ref: string, want: 'console' | 'workspace' | 'any'): SpokenTarget | null {
  const r = resolve(ref, want)
  if (r.ok) return r.target
  if (r.reason === 'ambiguous' && r.options.length === 2) {
    set({ phase: 'confirming', options: r.options })
    mode('confirming')
    say('ambiguous', { options: r.options.map((o) => o.id) })
    confirmTimer = clearTimer(confirmTimer)
    confirmTimer = setTimeout(() => {
      confirmTimer = null
      if (useHandsFreeStore.getState().phase === 'confirming') set({ phase: 'listening', options: [] })
    }, CONFIRM_MS)
    return null
  }
  say('notFound')
  return null
}

/** Runs one command. Exported for the tests. */
export function run(cmd: VoiceCommand, heard = ''): void {
  set({ lastCommand: heard })
  const v = voiceApi()
  const s = useHandsFreeStore.getState()
  switch (cmd.kind) {
    case 'exit':
      void stopHandsFree(true)
      return
    case 'stop':
      stopVoice()
      void v?.cmd({ kind: 'stop' })
      return
    case 'repeat':
      // Says the last item again (dictated text never goes to main, so it is not read back).
      void v?.cmd({ kind: 'repeat' })
      return
    case 'next':
      void v?.cmd({ kind: 'next' })
      return
    case 'status':
      void v?.cmd({ kind: 'status' })
      return
    case 'help':
      say('help')
      return
    case 'read': {
      if (!cmd.ref) {
        void v?.cmd({ kind: 'read', ...(cmd.full ? { full: true } : {}) })
        return
      }
      const t = selectOrAsk(cmd.ref, 'console')
      if (t && t.kind === 'console') void v?.cmd({ kind: 'read', paneId: t.id, ...(cmd.full ? { full: true } : {}) })
      return
    }
    case 'selectWorkspace':
    case 'selectConsole':
    case 'select': {
      const t = selectOrAsk(cmd.ref, cmd.kind === 'selectWorkspace' ? 'workspace' : cmd.kind === 'selectConsole' ? 'console' : 'any')
      if (t) select(t)
      return
    }
    case 'dictate': {
      let target = s.target ?? getFocusedPane()
      if (cmd.ref) {
        const t = selectOrAsk(cmd.ref, 'console')
        if (!t || t.kind !== 'console') return
        revealPane(t.id)
        target = t.id
      }
      if (!target) {
        say('noConsole')
        return
      }
      const keep = s.target === target ? s.buffer : ''
      set({ phase: 'dictating', target, buffer: keep })
      mode('dictating')
      if (cmd.text) append(cmd.text)
      armIdle()
      say('dictating', { paneId: target })
      return
    }
    case 'send':
    case 'insert':
      void deliver(cmd.kind === 'send')
      return
    case 'cancel':
      if (s.phase === 'dictating' || s.buffer) {
        idleTimer = clearTimer(idleTimer)
        set({ phase: 'listening', buffer: '' })
        mode('listening')
      }
      say('cancelled')
      return
  }
}

/** Sends (enter) or types the buffer into the target console. Exported for the tests. */
export async function deliver(enter: boolean, from: { paneId: string; text: string } | null = null): Promise<boolean> {
  const s = useHandsFreeStore.getState()
  const paneId = from?.paneId ?? s.target
  const text = (from?.text ?? s.buffer).trim()
  if (!paneId || !text) {
    say(paneId ? 'emptyBuffer' : 'noConsole')
    return false
  }
  const ptyId = getPtyId(paneId)
  // The console waits on an answer, or shows a menu: typing could pick an option.
  if (!ptyId || menuPending(paneId)) {
    say('awaitingUser', { paneId })
    return false
  }
  const pty = typeof window !== 'undefined' ? window.snApi?.pty : undefined
  const res = await pty?.submit({ ptyId, paneId, text, enter, userGate: true }).catch(() => ({ ok: false as const, error: 'internal' as never }))
  if (!res || !res.ok) {
    say('awaitingUser', { paneId })
    return false
  }
  idleTimer = clearTimer(idleTimer)
  if (from) set({ held: null })
  else {
    set({ buffer: '', phase: handsFreeOn() ? 'listening' : 'off' })
    if (handsFreeOn()) mode('listening')
  }
  say(enter ? 'sent' : 'inserted', { paneId })
  return true
}

/** The overlay's buttons for a held dictation. */
export function sendHeld(enter: boolean): void {
  const h = useHandsFreeStore.getState().held
  if (h) void deliver(enter, h)
}

export function discardHeld(): void {
  set({ held: null })
}

export function __resetHandsFreeForTests(): void {
  startSeq = 0
  capture = null
  sessionId = null
  pending = []
  subscribed = false
  roster = { workspaces: [] }
  unsubRoster = null
  unsubDictation?.()
  unsubDictation = null
  for (const t of [followTimer, idleTimer, confirmTimer, retryTimer]) if (t) clearTimeout(t)
  followTimer = idleTimer = confirmTimer = retryTimer = null
  useHandsFreeStore.setState({ phase: 'off', target: null, buffer: '', held: null, options: [], speaking: false, error: null, lastCommand: '' })
}

/** Tests: the roster the controller resolves names against. */
export function __setRosterForTests(r: VoiceRoster): void {
  roster = r
}
