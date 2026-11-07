/**
 * Hands-free voice (app 2.11.0, Labs `voice`): main's half. It owns the one
 * narration queue, the announcements of consoles that finish, ask or fail
 * (grouped in a short window, said once, never two at a time), the list of
 * finished consoles not read yet, reading a reply (as it is when short, else
 * summarized), the engine choice (local Supertonic, or ElevenLabs cache-first)
 * with the phrase cache, and the voice pack install. With the lab off it
 * answers `disabled`, keeps no timer and no worker.
 *
 * Everything the renderer names is checked here: pane and workspace ids
 * against main's config, phrase keys against VOICE_SAY_KEYS. The renderer
 * never sends text to say.
 */
import type { ConfigFile, PaneStatusEvt } from '@shared/types'
import { labOn } from '@shared/labs'
import {
  DEFAULT_VOICE_SETTINGS, SUPERTONIC_SPEAKERS, VOICE_LABEL_MAX, VOICE_MODES, VOICE_ROSTER_MAX_PANES, VOICE_SAY_KEYS, isVoiceId, voiceLangOf, wakeWordFor,
  type VoiceCmd, type VoiceCmdRes, type VoiceEvent, type VoiceInstallProgress, type VoiceMode, type VoicePlay, type VoiceRoster, type VoiceSayKey, type VoiceSettings, type VoiceStatus,
} from '@shared/voice'
import { cleanForSpeech, isShortReply, joinNames, localSummary, sentencesOf, type SpeechLang } from '@shared/speechText'
import { BRAND } from '@shared/brand'
import { DeadlineTimer, type DeadlineTimerDeps } from '../DeadlineTimer'
import { mainTLang, type MainKey } from '../i18n'
import { NarrationQueue, type NarrationItem, type NarrationPart } from './NarrationQueue'
import { PhraseCache } from './PhraseCache'
import type { TtsAudio, TtsEngine } from './LocalTts'
import { ElevenFail, type ElevenLabs } from './ElevenLabs'
import type { Summarizer } from './Summarizer'
import { VOICE_PACK_ID } from './catalog'
import { voiceSettingsSchema } from '../store/schema'

/** Announcements that come together are said together; the window never waits longer than this. */
export const GROUP_CAP_MS = 6000
/** A read reply is said in parts of at most this many characters. */
export const READ_PART_MAX = 400

export interface VoiceStatusSource {
  addListener(cb: (evt: PaneStatusEvt) => void): () => void
  stateOf(paneId: string): PaneStatusEvt | null
  replyOf(paneId: string): { text: string; turn: string } | null
  markRead(paneId: string): boolean
}

export interface VoiceInstaller {
  readonly busy: boolean
  installed(): Set<string>
  status(): { packs: Array<{ id: string; installed: boolean; downloadBytes: number; diskBytes: number }>; install: { phase: string; transferred: number; total: number; error?: string } | null }
  install(pack: never): Promise<{ ok: boolean; error?: string }>
  cancel(pack: never): void
  remove(pack: never, guard?: () => boolean): Promise<{ ok: boolean; error?: string }>
}

export interface VoiceServiceDeps {
  getConfig: () => ConfigFile | null
  status: VoiceStatusSource
  installer: VoiceInstaller
  local: TtsEngine & { unload(): void }
  eleven: ElevenLabs
  summarizer: Summarizer
  cache: PhraseCache
  send: (msg: { ch: 'play'; payload: VoicePlay } | { ch: 'event'; payload: VoiceEvent }) => void
  throttleHold: (on: boolean) => void
  dictationReady: () => boolean
  narratorMod: () => boolean
  supported: boolean
  timer?: DeadlineTimerDeps
  log?: (line: string) => void
}

type AnnounceKind = 'done' | 'action' | 'error'

interface Pending {
  kind: AnnounceKind
  /** The announcement phrase key. */
  key: MainKey
  since: number
}

const ACTION_KEY: Record<string, MainKey> = {
  permission: 'voice.say.permission',
  question: 'voice.say.question',
  elicitation: 'voice.say.question',
  plan: 'voice.say.plan',
}

export class VoiceService {
  private active = false
  private lab = false
  private settings: VoiceSettings = DEFAULT_VOICE_SETTINGS
  private appLang: 'es' | 'en' = 'es'
  private roster: VoiceRoster = { workspaces: [] }
  private mode: VoiceMode = 'off'
  private readonly queue: NarrationQueue
  private readonly timer: DeadlineTimer<string>
  private readonly now: () => number
  private readonly last = new Map<string, string>()
  private readonly pending = new Map<string, Pending>()
  private groupStart = 0
  /** Finished consoles announced and not read yet, oldest first. */
  private unread: string[] = []
  private noticed = new Set<string>()
  private unsubscribe: (() => void) | null = null

  constructor(private readonly deps: VoiceServiceDeps) {
    this.now = deps.timer?.now ?? (() => Date.now())
    this.timer = new DeadlineTimer<string>((key) => this.due(key), deps.timer)
    this.queue = new NarrationQueue({
      synth: (part, signal) => this.synth(part, signal),
      play: (id, audio) => this.deps.send({ ch: 'play', payload: { id, rate: audio.rate, pcm: audio.pcm, gain: Math.max(0, Math.min(1, this.settings.tts.volume / 100)) } }),
      stopPlayback: () => this.deps.send({ ch: 'event', payload: { t: 'stopPlayback' } }),
      onSpeaking: (on, queued) => this.deps.send({ ch: 'event', payload: { t: 'speaking', on, queued } }),
      timer: deps.timer,
      log: (l) => this.log(l),
    })
    this.configure(deps.getConfig())
  }

  // --- config and lifecycle -----------------------------------------------------

  /** Boot and every config save. Turning the lab off drops everything (no timer, no worker). */
  configure(cfg: ConfigFile | null): void {
    const lab = labOn(cfg?.settings, 'voice') && this.deps.supported
    // A config:save blob comes from the renderer as is: every field is normalized here.
    try {
      this.settings = voiceSettingsSchema.parse(cfg?.settings?.voice ?? {}) as VoiceSettings
    } catch {
      this.settings = DEFAULT_VOICE_SETTINGS
    }
    this.appLang = cfg?.settings?.language === 'en' ? 'en' : 'es'
    if (lab === this.lab) return
    this.lab = lab
    if (lab) {
      this.unsubscribe = this.deps.status.addListener((evt) => this.onStatus(evt))
    } else {
      this.setActive(false)
      this.unsubscribe?.()
      this.unsubscribe = null
      this.deps.local.unload()
    }
  }

  get isActive(): boolean {
    return this.active
  }

  /** settings.voice as configure() last normalized it. */
  get currentSettings(): VoiceSettings {
    return this.settings
  }

  private get lang(): SpeechLang {
    return voiceLangOf(this.settings.language, this.appLang)
  }

  private t(key: MainKey, vars?: Record<string, string | number>): string {
    return mainTLang(this.lang, key, vars)
  }

  /** Hands-free on or off (the renderer's controller). Off clears what waits to be said. */
  setActive(on: boolean): VoiceCmdRes {
    if (on && !this.lab) return { ok: false, error: 'disabled' }
    if (on === this.active) {
      if (on) this.touch()
      return { ok: true }
    }
    this.active = on
    this.queue.setActive(on)
    this.deps.throttleHold(on)
    if (on) {
      this.touch()
    } else {
      this.pending.clear()
      this.unread = []
      this.noticed.clear()
      this.timer.clear('group')
      this.timer.clear('autoOff')
      this.mode = 'off'
    }
    this.log(`active=${on}`)
    return { ok: true }
  }

  /** The roster the renderer computed (spokenLabels): ids checked against the config, labels one line. */
  setRoster(raw: unknown): void {
    const cfg = this.deps.getConfig()
    const known = new Map((cfg?.workspaces ?? []).map((w) => [w.id, new Set(w.panes.map((p) => p.id))]))
    const out: VoiceRoster = { workspaces: [] }
    let panes = 0
    const list = raw && typeof raw === 'object' && Array.isArray((raw as VoiceRoster).workspaces) ? (raw as VoiceRoster).workspaces : []
    for (const w of list.slice(0, 200)) {
      if (!w || !isVoiceId(w.id) || !known.has(w.id) || !Array.isArray(w.panes)) continue
      const ids = known.get(w.id) as Set<string>
      const ws = { id: w.id, label: cleanLabel(w.label) || w.id, panes: [] as VoiceRoster['workspaces'][number]['panes'] }
      for (const p of w.panes) {
        if (panes >= VOICE_ROSTER_MAX_PANES) break
        if (!p || !isVoiceId(p.id) || !ids.has(p.id)) continue
        ws.panes.push({ id: p.id, label: cleanLabel(p.label) || ws.label })
        panes++
      }
      out.workspaces.push(ws)
    }
    this.roster = out
  }

  setMode(m: unknown): void {
    if (typeof m !== 'string' || !(VOICE_MODES as readonly string[]).includes(m)) return
    this.mode = m as VoiceMode
    this.queue.setDictating(this.mode === 'dictating')
    if (this.active) this.touch()
  }

  /** The renderer played item `id` (any outcome lets the next one start). */
  played(id: unknown): void {
    if (typeof id === 'number') this.queue.played(id)
  }

  dispose(): void {
    this.setActive(false)
    this.unsubscribe?.()
    this.queue.dispose()
    this.timer.dispose()
  }

  // --- status ---------------------------------------------------------------------

  status(): VoiceStatus {
    let pack = { installed: false, downloadBytes: 0, diskBytes: 0 }
    let install: VoiceInstallProgress | null = null
    try {
      const st = this.deps.installer.status()
      const info = st.packs.find((p) => p.id === VOICE_PACK_ID)
      if (info) pack = { installed: info.installed, downloadBytes: info.downloadBytes, diskBytes: info.diskBytes }
      if (st.install) install = { phase: st.install.phase as VoiceInstallProgress['phase'], transferred: st.install.transferred, total: st.install.total, ...(st.install.error ? { error: st.install.error } : {}) }
    } catch {
      /* not supported */
    }
    const key = this.deps.eleven.keyState()
    const usage = this.deps.eleven.usage()
    let claudeFound = false
    try {
      claudeFound = this.deps.summarizer.available()
    } catch {
      claudeFound = false
    }
    return {
      supported: this.deps.supported,
      lab: this.lab,
      pack,
      install,
      dictationReady: this.deps.dictationReady(),
      eleven: { keySet: key.keySet, last4: key.last4, usedChars: usage.usedChars, periodStart: usage.periodStart },
      claudeFound,
      narratorMod: this.deps.narratorMod(),
    }
  }

  // --- commands ---------------------------------------------------------------------

  async cmd(raw: unknown): Promise<VoiceCmdRes> {
    if (!this.lab) return { ok: false, error: 'disabled' }
    const c = raw && typeof raw === 'object' ? (raw as VoiceCmd) : null
    if (!c || typeof c.kind !== 'string') return { ok: false, error: 'bad_request' }
    if (this.active) this.touch()
    switch (c.kind) {
      case 'stop':
        this.queue.stop()
        return { ok: true }
      case 'repeat':
        return this.queue.repeat() ? { ok: true } : { ok: false, error: 'nothing' }
      case 'status':
        this.sayStatus()
        return { ok: true }
      case 'next':
        if (this.unread.length) return this.read(this.unread[0], false)
        this.sayKey('nothingWaiting')
        return { ok: true }
      case 'read': {
        if (c.paneId !== undefined && !this.paneKnown(c.paneId)) return { ok: false, error: 'not_found' }
        const target = c.paneId ?? this.unread[this.unread.length - 1] ?? null
        if (!target) {
          this.sayKey('nothingToRead')
          return { ok: false, error: 'nothing' }
        }
        return this.read(target, c.full === true)
      }
      case 'say': {
        if (!(VOICE_SAY_KEYS as readonly string[]).includes(c.key)) return { ok: false, error: 'bad_request' }
        if (c.paneId !== undefined && !this.paneKnown(c.paneId)) return { ok: false, error: 'not_found' }
        if (c.workspaceId !== undefined && !this.workspaceLabel(c.workspaceId)) return { ok: false, error: 'not_found' }
        const name = c.paneId ? this.paneLabel(c.paneId) : c.workspaceId ? (this.workspaceLabel(c.workspaceId) as string) : ''
        const options = Array.isArray(c.options) ? c.options.slice(0, 2).map((id) => (typeof id === 'string' ? this.paneLabel(id) || this.workspaceLabel(id) || '' : '')) : []
        if (c.key === 'ambiguous' && (options.length < 2 || options.some((o) => !o))) return { ok: false, error: 'bad_request' }
        this.sayKey(c.key, { name, a: options[0] ?? '', b: options[1] ?? '' })
        return { ok: true }
      }
      default:
        return { ok: false, error: 'bad_request' }
    }
  }

  /** Settings > Voz > Probar: a short sample with the voice in force (the queue does not need hands-free on). */
  preview(): VoiceCmdRes {
    if (!this.lab) return { ok: false, error: 'disabled' }
    const wasActive = this.active
    if (!wasActive) this.queue.setActive(true)
    this.queue.enqueue({ priority: 0, parts: [{ text: this.t('voice.say.preview', { app: BRAND.productName }), fixed: true }], onSpoken: () => { if (!this.active) this.queue.setActive(false) } })
    return { ok: true }
  }

  /**
   * Generates every fixed phrase of the roster once (so ElevenLabs is paid
   * once), or with dryRun just counts the characters that would be sent.
   */
  async warmPhrases(dryRun: boolean): Promise<{ ok: boolean; phrases: number; chars: number; error?: string }> {
    if (!this.lab) return { ok: false, phrases: 0, chars: 0, error: 'disabled' }
    const texts = this.fixedPhrases()
    const missing: string[] = []
    for (const text of texts) if (!(await this.deps.cache.get(this.cacheKey(text, this.engineFor(true))))) missing.push(text)
    const chars = missing.reduce((n, s) => n + s.length, 0)
    if (dryRun) return { ok: true, phrases: missing.length, chars }
    const ctrl = new AbortController()
    for (const text of missing) {
      try {
        await this.synth({ text, fixed: true }, ctrl.signal)
      } catch {
        /* one failure does not stop the rest */
      }
    }
    return { ok: true, phrases: missing.length, chars }
  }

  async clearCache(): Promise<void> {
    await this.deps.cache.clear()
  }

  // --- install -----------------------------------------------------------------------

  async install(): Promise<{ ok: boolean; error?: string }> {
    if (!this.deps.supported) return { ok: false, error: 'unsupported' }
    return this.deps.installer.install(VOICE_PACK_ID as never)
  }

  cancelInstall(): void {
    this.deps.installer.cancel(VOICE_PACK_ID as never)
  }

  async remove(): Promise<{ ok: boolean; error?: string }> {
    this.deps.local.unload()
    return this.deps.installer.remove(VOICE_PACK_ID as never, () => this.queue.speaking)
  }

  // --- announcements --------------------------------------------------------------------

  private onStatus(evt: PaneStatusEvt): void {
    if (!evt || typeof evt.paneId !== 'string') return
    const sig = `${evt.state}:${evt.stateSince ?? ''}`
    const prev = this.last.get(evt.paneId)
    this.last.set(evt.paneId, sig)
    if (!this.active || prev === sig || !this.paneKnown(evt.paneId)) return
    // A console the user saw meanwhile, or muted, is not announced.
    if (evt.muted === true || evt.attention !== true) return
    const n = this.settings.narration
    if (!n.enabled) return
    let pending: Pending | null = null
    if (evt.state === 'done' && n.done) pending = { kind: 'done', key: 'voice.say.done1', since: evt.stateSince ?? 0 }
    else if (evt.state === 'action' && n.action) pending = { kind: 'action', key: evt.needs ? 'voice.say.needs' : ACTION_KEY[evt.reason ?? ''] ?? 'voice.say.question', since: evt.stateSince ?? 0 }
    else if (evt.state === 'error' && n.error) pending = { kind: 'error', key: evt.failure?.kind === 'limit' ? 'voice.say.limit' : 'voice.say.error', since: evt.stateSince ?? 0 }
    if (!pending) return
    this.pending.set(evt.paneId, pending)
    const now = this.now()
    if (this.pending.size === 1) this.groupStart = now
    this.timer.set('group', Math.min(now + n.groupMs, this.groupStart + GROUP_CAP_MS))
  }

  private flushGroup(): void {
    const entries = [...this.pending.entries()]
    this.pending.clear()
    if (!this.active || !entries.length) return
    const still = (paneId: string, p: Pending): boolean => {
      const st = this.deps.status.stateOf(paneId)
      return !!st && st.attention === true && st.muted !== true && (st.stateSince ?? 0) === p.since && (p.kind === 'done' ? st.state === 'done' : p.kind === 'action' ? st.state === 'action' : st.state === 'error')
    }
    const live = entries.filter(([id, p]) => still(id, p))
    const done = live.filter(([, p]) => p.kind === 'done')
    const urgent = live.filter(([, p]) => p.kind !== 'done')
    if (urgent.length) {
      this.queue.enqueue({
        priority: 1,
        parts: urgent.map(([id, p]) => ({ text: this.t(p.key, { name: this.paneLabel(id) }), fixed: true })),
        stillValid: () => urgent.some(([id, p]) => still(id, p)),
      })
    }
    if (done.length) {
      const names = done.map(([id]) => this.paneLabel(id))
      const text = names.length === 1 ? this.t('voice.say.done1', { name: names[0] }) : this.t('voice.say.doneN', { names: joinNames(names, this.lang) })
      for (const [id] of done) {
        this.unread = this.unread.filter((u) => u !== id)
        this.unread.push(id)
        this.prefetch(id)
      }
      // A group of several names is variable; one name is a fixed phrase (cached per console).
      this.queue.enqueue({ priority: 2, tag: 'done', parts: [{ text, fixed: names.length === 1 }], stillValid: () => done.some(([id, p]) => still(id, p)) })
    }
  }

  private prefetch(paneId: string): void {
    const n = this.settings.narration
    if (n.summarizer !== 'claude' || !n.prefetch) return
    const reply = this.deps.status.replyOf(paneId)
    if (!reply) return
    const clean = cleanForSpeech(reply.text, this.lang)
    if (!isShortReply(clean, n.shortMaxChars)) void this.deps.summarizer.summarize(clean, this.lang)
  }

  private async read(paneId: string, full: boolean): Promise<VoiceCmdRes> {
    const reply = this.deps.status.replyOf(paneId)
    if (!reply) {
      this.sayKey('nothingToRead')
      return { ok: false, error: 'nothing' }
    }
    const lang = this.lang
    const clean = cleanForSpeech(reply.text, lang)
    const n = this.settings.narration
    let body: string[]
    if (full) body = chunk(sentencesOf(clean), READ_PART_MAX)
    else if (isShortReply(clean, n.shortMaxChars)) body = [clean]
    else body = [n.summarizer === 'claude' ? await this.deps.summarizer.summarize(clean, lang) : localSummary(clean, lang)]
    const parts: NarrationPart[] = [{ text: this.t('voice.say.reading', { name: this.paneLabel(paneId) }), fixed: true }, ...body.filter(Boolean).map((text) => ({ text, fixed: false }))]
    this.queue.stop()
    this.queue.enqueue({
      priority: 0,
      parts,
      onSpoken: () => {
        this.unread = this.unread.filter((u) => u !== paneId)
        this.deps.status.markRead(paneId)
      },
    })
    return { ok: true }
  }

  private sayStatus(): void {
    const unread = this.unread.map((id) => this.paneLabel(id))
    const waiting = this.roster.workspaces.flatMap((w) => w.panes).filter((p) => {
      const st = this.deps.status.stateOf(p.id)
      return st?.state === 'action' && st.attention === true && st.muted !== true
    })
    const parts: NarrationPart[] = []
    if (unread.length) parts.push({ text: this.t('voice.say.statusUnread', { names: joinNames(unread, this.lang) }), fixed: false })
    if (waiting.length) parts.push({ text: this.t('voice.say.statusWaiting', { names: joinNames(waiting.map((p) => p.label), this.lang) }), fixed: false })
    if (!parts.length) parts.push({ text: this.t('voice.say.nothingWaiting'), fixed: true })
    this.queue.enqueue({ priority: 0, parts })
  }

  private sayKey(key: VoiceSayKey, vars: Record<string, string> = {}): void {
    const text = this.t(`voice.say.${key}` as MainKey, { ...vars, wake: wakeWordFor(this.settings.wakeWord, this.lang) })
    this.queue.enqueue({ priority: 0, parts: [{ text, fixed: true }] })
  }

  /** Every fixed phrase the roster can produce (what warmPhrases generates). */
  private fixedPhrases(): string[] {
    const out = new Set<string>()
    const plain: VoiceSayKey[] = ['listening', 'off', 'yes', 'notUnderstood', 'notFound', 'cancelled', 'emptyBuffer', 'noConsole', 'nothingToRead', 'nothingWaiting', 'help', 'autoOff']
    const wake = wakeWordFor(this.settings.wakeWord, this.lang)
    for (const k of plain) out.add(this.t(`voice.say.${k}` as MainKey, { wake }))
    for (const ws of this.roster.workspaces) {
      out.add(this.t('voice.say.workspace', { name: ws.label }))
      for (const p of ws.panes) {
        for (const k of ['console', 'dictating', 'sent', 'inserted', 'awaitingUser', 'held', 'reading', 'done1', 'permission', 'question', 'plan', 'needs', 'error', 'limit'] as const) {
          out.add(this.t(`voice.say.${k}` as MainKey, { name: p.label }))
        }
      }
    }
    return [...out]
  }

  // --- engines ----------------------------------------------------------------------

  private engineFor(fixed: boolean, chars = 0): TtsEngine {
    const s = this.settings.tts
    const eleven = this.deps.eleven
    if (s.engine === 'elevenlabs' && eleven.ready()) {
      if (fixed || eleven.canSpend(chars)) return eleven
      if (this.settings.eleven.mode === 'all') this.notice('elevenCap')
    }
    return this.deps.local
  }

  private voiceOf(engine: TtsEngine): string {
    return engine.id === 'elevenlabs' ? this.settings.eleven.voiceId : String(SUPERTONIC_SPEAKERS[this.settings.tts.voice] ?? SUPERTONIC_SPEAKERS.male)
  }

  private cacheKey(text: string, engine: TtsEngine) {
    return { engine: engine.id, voice: this.voiceOf(engine), model: engine.id === 'elevenlabs' ? this.settings.eleven.model : 'supertonic-3', speed: this.settings.tts.speed, lang: this.lang, text }
  }

  private async synth(part: NarrationPart, signal: AbortSignal): Promise<TtsAudio | null> {
    const engine = this.engineFor(part.fixed, part.text.length)
    if (part.fixed) {
      const hit = await this.deps.cache.get(this.cacheKey(part.text, engine))
      if (hit) return hit
    }
    const req = { text: part.text, lang: this.lang, voice: this.voiceOf(engine), speed: this.settings.tts.speed }
    try {
      if (!engine.ready()) throw new Error('missing')
      const audio = await engine.synth(req, signal)
      if (part.fixed) void this.deps.cache.put(this.cacheKey(part.text, engine), audio)
      return audio
    } catch (e) {
      if (signal.aborted) return null
      if (engine.id === 'elevenlabs') {
        if (e instanceof ElevenFail) this.log(`eleven failed ${e.reason}`)
        this.notice('elevenFailed')
        const local = this.deps.local
        if (!local.ready()) {
          this.notice('engineMissing')
          return null
        }
        try {
          return await local.synth({ ...req, voice: this.voiceOf(local) }, signal)
        } catch {
          this.notice('engineFailed')
          return null
        }
      }
      this.notice(engine.ready() ? 'engineFailed' : 'engineMissing')
      return null
    }
  }

  private notice(code: 'elevenCap' | 'elevenFailed' | 'engineMissing' | 'engineFailed'): void {
    if (this.noticed.has(code)) return
    this.noticed.add(code)
    this.deps.send({ ch: 'event', payload: { t: 'notice', code } })
  }

  // --- timers ---------------------------------------------------------------------

  private touch(): void {
    const min = this.settings.autoOffMin
    if (min > 0) this.timer.set('autoOff', this.now() + min * 60_000)
    else this.timer.clear('autoOff')
  }

  private due(key: string): void {
    if (key === 'group') this.flushGroup()
    else if (key === 'autoOff' && this.active) {
      this.log('auto off')
      this.queue.stop(true)
      this.queue.enqueue({ priority: 0, parts: [{ text: this.t('voice.say.autoOff'), fixed: true }], onSpoken: () => this.deps.send({ ch: 'event', payload: { t: 'autoOff' } }) })
      // Said or not, hands-free ends: the renderer turns itself off on autoOff.
      if (!this.queue.speaking) this.deps.send({ ch: 'event', payload: { t: 'autoOff' } })
    }
  }

  // --- roster lookups ------------------------------------------------------------------

  private paneKnown(id: unknown): boolean {
    if (!isVoiceId(id)) return false
    return (this.deps.getConfig()?.workspaces ?? []).some((w) => w.panes.some((p) => p.id === id))
  }

  /** The roster label of a console, else its title in the config. */
  private paneLabel(id: string): string {
    for (const w of this.roster.workspaces) for (const p of w.panes) if (p.id === id) return p.label
    for (const w of this.deps.getConfig()?.workspaces ?? []) for (const p of w.panes) if (p.id === id) return cleanLabel(p.title) || cleanLabel(w.name)
    return ''
  }

  private workspaceLabel(id: unknown): string | null {
    if (!isVoiceId(id)) return null
    const r = this.roster.workspaces.find((w) => w.id === id)
    if (r) return r.label
    const w = (this.deps.getConfig()?.workspaces ?? []).find((x) => x.id === id)
    return w ? cleanLabel(w.name) || null : null
  }

  private log(line: string): void {
    try {
      this.deps.log?.(line)
    } catch {
      /* never blocks */
    }
  }
}

/** A roster label as main says it: one line, no control characters, cut. */
export function cleanLabel(v: unknown): string {
  return typeof v === 'string'
    ? v
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, VOICE_LABEL_MAX)
    : ''
}

/** Sentences grouped into parts of at most `max` characters. */
export function chunk(sentences: string[], max: number): string[] {
  const out: string[] = []
  let cur = ''
  for (const s of sentences) {
    if (cur && cur.length + 1 + s.length > max) {
      out.push(cur)
      cur = ''
    }
    cur = cur ? `${cur} ${s}` : s.slice(0, max * 2)
  }
  if (cur) out.push(cur)
  return out
}

export type { NarrationItem }
