// App 2.11.0 (Labs voice): main's half of hands-free voice, with fakes for the
// clock, the engines, the worker, the network and the Claude CLI. Narration
// queue (one in flight, priorities, holds, watchdog, stop, repeat), the
// VoiceService (lab gate, grouped announcements, stale drops, unread list,
// reading with the short rule and the summarizer, say keys checked against
// the roster), the Summarizer (argv without user text, stdin, env, timeout,
// breaker, cache), the PhraseCache, ElevenLabs (host, key sealing, errors,
// credits per period), LocalTts (worker protocol, timeouts, idle unload) and
// the pinned catalog.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, URL, setTimeout, clearTimeout, AbortController, TextEncoder, TextDecoder, ...overrides })
  return mod.exports
}
const tick = () => new Promise((r) => setImmediate(r))
async function settle(n = 6) { for (let i = 0; i < n; i++) await tick() }

/** A manual clock for DeadlineTimer deps. */
function clock(start = 1_800_000_000_000) {
  let now = start
  const timers = new Map()
  let seq = 0
  return {
    deps: { now: () => now, setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id }, clearTimeout: (id) => timers.delete(id) },
    now: () => now,
    pending: () => timers.size,
    async advance(ms) {
      const until = now + ms
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next || next[1].at > until) break
        now = next[1].at
        timers.delete(next[0])
        next[1].fn()
        await settle(2)
      }
      now = until
      await settle(2)
    },
  }
}

const pcm = (samples = 2400) => new Int16Array(samples).fill(100).buffer
const audio = (rate = 24000, samples = 2400) => ({ rate, pcm: pcm(samples) })

async function testQueue(Q) {
  const c = clock()
  const played = [], stops = [], said = []
  const q = new Q.NarrationQueue({
    synth: async (part) => { said.push(part.text); return audio() },
    play: (id, a) => played.push({ id, a }),
    stopPlayback: () => stops.push(1),
    timer: c.deps,
  })
  q.enqueue({ priority: 2, parts: [{ text: 'x', fixed: true }] })
  check(played.length === 0, 'nothing is said while hands-free is off')
  q.setActive(true)
  q.enqueue({ priority: 2, tag: 'done', parts: [{ text: 'Terminó A', fixed: true }] })
  q.enqueue({ priority: 2, tag: 'done', parts: [{ text: 'Terminaron A y B', fixed: false }] })
  q.enqueue({ priority: 1, parts: [{ text: 'C necesita permiso', fixed: true }] })
  q.enqueue({ priority: 0, parts: [{ text: 'Consola D', fixed: true }] })
  await settle()
  check(played.length === 1 && said[0] === 'Terminó A', 'one item in flight: the first one starts, the rest wait (never two voices)')
  q.played(played[0].id)
  await settle()
  check(said[1] === 'Consola D' && played.length === 2, 'what the user asked for goes first')
  q.played(played[1].id)
  await settle()
  check(said[2] === 'C necesita permiso', 'then a request')
  q.played(played[2].id)
  await settle()
  check(said[3] === 'Terminaron A y B' && said.length === 4, 'then finished consoles; a later announcement with the same tag replaced the waiting one')
  // The watchdog frees the queue when the renderer never answers.
  q.enqueue({ priority: 2, parts: [{ text: 'E', fixed: true }] })
  q.enqueue({ priority: 2, parts: [{ text: 'F', fixed: true }] })
  await settle()
  const before = played.length
  await c.advance(2400 / 24000 * 1000 + 2100)
  check(played.length === before + 1 && said.at(-1) === 'E', 'the watchdog (length + 2 s) lets the next item start')
  q.played(played.at(-1).id)
  await settle()
  check(said.at(-1) === 'F', 'and the one after it')
  // Dictating holds everything but what the user asked for.
  q.played(played.at(-1).id)
  await settle()
  q.setDictating(true)
  q.enqueue({ priority: 2, parts: [{ text: 'G', fixed: true }] })
  await settle()
  check(said.at(-1) === 'F', 'an announcement waits while the user dictates')
  q.enqueue({ priority: 0, parts: [{ text: 'Dictando a H', fixed: true }] })
  await settle()
  check(said.at(-1) === 'Dictando a H', 'a confirmation the user asked for still passes')
  q.played(played.at(-1).id)
  q.setDictating(false)
  await settle()
  check(said.at(-1) === 'G', 'the held announcement comes once dictation ends')
  // Stop and repeat.
  q.stop()
  check(stops.length === 1 && !q.speaking, 'stop ends what plays (stopPlayback) and frees the queue')
  check(q.repeat() && played.at(-1).a.pcm.byteLength > 0 && !said.includes('again'), 'repeat replays the last audio without a synthesis')
  q.played(played.at(-1).id)
  // A stale item is dropped right before it would be said.
  q.enqueue({ priority: 2, parts: [{ text: 'stale', fixed: true }], stillValid: () => false })
  q.enqueue({ priority: 2, parts: [{ text: 'fresh', fixed: true }] })
  await settle()
  check(!said.includes('stale') && said.at(-1) === 'fresh', 'stillValid false drops an item when its turn comes')
  q.setActive(false)
  check(!q.speaking && q.size === 0 && c.pending() === 0, 'turning off drops everything and leaves no timer')
  // joinAudio and the gap.
  const j = Q.joinAudio([audio(24000, 100), audio(24000, 100)], 10)
  check(j.rate === 24000 && new Int16Array(j.pcm).length === 100 + 240 + 100, 'joinAudio puts a gap between parts')
  const mixed = Q.joinAudio([audio(24000, 240), audio(48000, 480)], 0)
  check(new Int16Array(mixed.pcm).length === 480, 'a part at another rate is resampled to the first rate')
  check(Q.joinAudio([]) === null && Q.joinAudio([{ rate: 1, pcm: new ArrayBuffer(0) }]) === null, 'nothing to join is null')
}

function voiceService(V, opts = {}) {
  const c = clock()
  const listeners = []
  const states = new Map()
  const replies = new Map()
  const marked = []
  const sent = []
  const synth = []
  const cfg = {
    settings: { language: 'es', labs: { voice: opts.lab !== false }, voice: opts.voice ?? {} },
    workspaces: [{ id: 'w1', name: 'SnLib', panes: [{ id: 'p1', title: 'API' }, { id: 'p2', title: 'Pagos' }] }, { id: 'w2', name: 'MineBosh', panes: [{ id: 'p3', title: 'Gens' }] }],
  }
  const engine = (id, ready = true, fail = false) => ({ id, ready: () => ready, synth: async (req) => { synth.push({ engine: id, ...req }); if (fail) throw new Error('down'); return audio() }, unload() {} })
  const local = opts.local ?? engine('local')
  const eleven = Object.assign(engine('elevenlabs', opts.elevenReady ?? false, opts.elevenFail), { keyState: () => ({ keySet: false, last4: '' }), usage: () => ({ usedChars: 0, periodStart: '2026-11-01' }), canSpend: (n) => opts.canSpend ?? false })
  const cache = { store: new Map(), async get(k) { return this.store.get(JSON.stringify(k)) ?? null }, async put(k, a) { this.store.set(JSON.stringify(k), a) }, async clear() { this.store.clear() } }
  const summarizer = { calls: [], available: () => true, summarize: async (text) => { summarizer.calls.push(text); return 'Resumen corto.' } }
  const svc = new V.VoiceService({
    getConfig: () => cfg,
    status: {
      addListener: (cb) => { listeners.push(cb); return () => listeners.splice(listeners.indexOf(cb), 1) },
      stateOf: (id) => states.get(id) ?? null,
      replyOf: (id) => replies.get(id) ?? null,
      markRead: (id) => { marked.push(id); return true },
    },
    installer: { busy: false, installed: () => new Set(), status: () => ({ packs: [{ id: 'supertonic', installed: true, downloadBytes: 1, diskBytes: 2 }], install: null }), install: async () => ({ ok: true }), cancel() {}, remove: async () => ({ ok: true }) },
    local, eleven, summarizer, cache,
    send: (m) => sent.push(m),
    throttleHold: (on) => sent.push({ ch: 'hold', on }),
    dictationReady: () => true,
    narratorMod: () => true,
    supported: true,
    timer: c.deps,
  })
  const emit = (evt) => { states.set(evt.paneId, evt); for (const l of listeners) l(evt) }
  const plays = () => sent.filter((m) => m.ch === 'play')
  const playedAll = async () => { for (let i = 0; i < 6; i++) { const p = plays().at(-1); if (p) svc.played(p.payload.id); await settle() } }
  return { svc, c, emit, states, replies, marked, sent, synth, cache, summarizer, plays, playedAll, cfg, listeners }
}

async function testService(V) {
  const off = voiceService(V, { lab: false })
  check(JSON.stringify(off.svc.setActive(true)) === '{"ok":false,"error":"disabled"}' && off.listeners.length === 0, 'lab off: setActive answers disabled and no status listener is added')
  check(JSON.stringify(await off.svc.cmd({ kind: 'status' })) === '{"ok":false,"error":"disabled"}', 'lab off: every command answers disabled')

  const h = voiceService(V)
  check(h.listeners.length === 1, 'lab on: one status listener')
  h.svc.setRoster({ workspaces: [{ id: 'w1', label: 'SnLib', panes: [{ id: 'p1', label: 'API' }, { id: 'p2', label: 'Pagos' }, { id: 'ghost', label: 'X' }] }, { id: 'wx', label: 'Nope', panes: [] }, { id: 'w2', label: 'MineBosh\u0007\n', panes: [{ id: 'p3', label: 'Gens' }] }] })
  check(h.svc.setActive(true).ok && h.sent.some((m) => m.ch === 'hold' && m.on), 'on: holds the renderer unthrottled (a game may be in front)')
  // Two consoles finish within the window: one announcement.
  const st = (paneId, state, extra = {}) => ({ paneId, state, precise: true, notify: true, attention: true, stateSince: 100, ...extra })
  h.emit(st('p1', 'done'))
  await h.c.advance(1000)
  h.emit(st('p3', 'done'))
  check(h.plays().length === 0, 'nothing is said before the group window closes')
  await h.c.advance(2600)
  check(h.synth.at(-1).text === 'Terminaron API y Gens.' && h.plays().length === 1, 'two finished consoles in one announcement, with their roster names (got ' + JSON.stringify(h.synth.at(-1)) + ')')
  await h.playedAll()
  // A request and a failure.
  h.emit(st('p2', 'action', { reason: 'permission', stateSince: 200 }))
  h.emit(st('p3', 'error', { failure: { kind: 'limit' }, stateSince: 300 }))
  await h.c.advance(2600)
  check(h.synth.slice(-2).map((s) => s.text).join(' | ') === 'Pagos necesita permiso. | Gens llegó al límite de uso.', 'a permission and a usage limit are said in one item (got ' + h.synth.slice(-2).map((s) => s.text).join(' | ') + ')')
  await h.playedAll()
  // Seen, muted or moved on meanwhile: dropped.
  const n = h.synth.length
  h.emit(st('p1', 'done', { stateSince: 400, attention: false }))
  h.emit(st('p2', 'done', { stateSince: 500, muted: true }))
  await h.c.advance(3000)
  check(h.synth.length === n, 'a console already seen (attention false) or muted is never announced')
  h.emit(st('p1', 'done', { stateSince: 600 }))
  h.states.set('p1', st('p1', 'working', { stateSince: 700 }))
  await h.c.advance(3000)
  check(h.synth.length === n, 'a console that moved on before the window closed is dropped')
  // The unread list and reading.
  h.replies.set('p1', { text: 'Listo, pasa.', turn: 't1' })
  h.replies.set('p3', { text: 'Hice el wipe. Conecté MySQL. Verifiqué hashes. ¿Borro el archivo?', turn: 't2' })
  check((await h.svc.cmd({ kind: 'read', paneId: 'p1' })).ok, 'read a console')
  await settle()
  check(h.synth.slice(-2).map((s) => s.text).join(' | ') === 'API. | Listo, pasa.', 'a short reply is read as it is, after its name')
  await h.playedAll()
  check(h.marked.includes('p1'), 'reading marks the console read in main')
  await h.svc.cmd({ kind: 'read', paneId: 'p3' })
  await settle()
  check(h.summarizer.calls.length >= 1 && h.synth.at(-1).text === 'Resumen corto.', 'a long reply goes through the summarizer')
  await h.playedAll()
  const full = await h.svc.cmd({ kind: 'read', paneId: 'p3', full: true })
  await settle()
  check(full.ok && h.synth.at(-1).text.includes('¿Borro el archivo?'), 'read full says the whole cleaned reply')
  await h.playedAll()
  check(JSON.stringify(await h.svc.cmd({ kind: 'read', paneId: 'nope' })) === '{"ok":false,"error":"not_found"}', 'a pane id main does not know is refused')
  // Say keys: only catalog keys, names from the roster.
  check(JSON.stringify(await h.svc.cmd({ kind: 'say', key: 'free text please' })) === '{"ok":false,"error":"bad_request"}', 'a phrase key outside VOICE_SAY_KEYS is refused (the renderer never sends text)')
  await h.svc.cmd({ kind: 'say', key: 'sent', paneId: 'p2' })
  await settle()
  check(h.synth.at(-1).text === 'Enviado a Pagos.', 'say with a pane id uses its roster label')
  await h.playedAll()
  await h.svc.cmd({ kind: 'say', key: 'workspace', workspaceId: 'w2' })
  await settle()
  check(h.synth.at(-1).text === 'Workspace MineBosh.', 'a roster label is cleaned to one line (control characters dropped)')
  await h.playedAll()
  check(JSON.stringify(await h.svc.cmd({ kind: 'say', key: 'ambiguous', options: ['p1'] })) === '{"ok":false,"error":"bad_request"}', 'ambiguous needs two known options')
  await h.svc.cmd({ kind: 'say', key: 'ambiguous', options: ['p1', 'p2'] })
  await settle()
  check(h.synth.at(-1).text === '¿API o Pagos?', 'ambiguous says both names')
  await h.playedAll()
  await h.svc.cmd({ kind: 'say', key: 'help' })
  await settle()
  check(h.synth.at(-1).text.startsWith('Decí Agente y después'), 'help names the wake word in force')
  await h.playedAll()
  // Fixed phrases come from the cache the second time.
  const m = h.synth.length
  await h.svc.cmd({ kind: 'say', key: 'sent', paneId: 'p2' })
  await settle()
  check(h.synth.length === m && h.plays().length > 0, 'a fixed phrase already said plays from the cache (no synthesis)')
  await h.playedAll()
  // Status and next.
  await h.svc.cmd({ kind: 'status' })
  await settle()
  check(/Sin leer|Nadie te está esperando|Esperan/.test(h.synth.at(-1)?.text ?? ''), 'status says the unread and the waiting consoles')
  await h.playedAll()
  // Auto off.
  await h.c.advance(240 * 60_000 + 10)
  await h.playedAll()
  check(h.sent.some((x) => x.ch === 'event' && x.payload.t === 'autoOff'), 'after autoOffMin without commands main asks the renderer to turn off')
  check(h.svc.status().narratorMod === true && h.svc.status().lab === true, 'status tells the narrator mod is on (Settings shows /narrator off)')
  // Turning the lab off drops the listener and the queue.
  h.cfg.settings.labs.voice = false
  h.svc.configure(h.cfg)
  check(h.listeners.length === 0 && !h.svc.isActive, 'the lab off drops the listener and turns hands-free off')
  check(h.c.pending() === 0, 'and leaves no timer')

  // Engines: ElevenLabs only for fixed phrases in fixedOnly; local for variable text; a failure falls back.
  const e = voiceService(V, { voice: { tts: { engine: 'elevenlabs' }, eleven: { voiceId: 'abc', mode: 'fixedOnly' } }, elevenReady: true })
  e.svc.setRoster({ workspaces: [{ id: 'w1', label: 'SnLib', panes: [{ id: 'p1', label: 'API' }] }] })
  e.svc.setActive(true)
  await e.svc.cmd({ kind: 'say', key: 'console', paneId: 'p1' })
  await settle()
  check(e.synth.at(-1).engine === 'elevenlabs' && e.synth.at(-1).voice === 'abc', 'a fixed phrase goes to ElevenLabs with the voice id')
  await e.playedAll()
  e.replies.set('p1', { text: 'Uno. Dos. Tres. Cuatro.', turn: 't' })
  await e.svc.cmd({ kind: 'read', paneId: 'p1' })
  await settle()
  check(e.synth.at(-1).engine === 'local' && e.synth.at(-1).voice === '9', 'variable text goes to the local voice (male, speaker 9) in fixedOnly')
  await e.playedAll()
  const fem = voiceService(V, { voice: { tts: { voice: 'female' } } })
  fem.svc.setActive(true)
  await fem.svc.cmd({ kind: 'say', key: 'listening' })
  await settle()
  check(fem.synth.at(-1).voice === '4', 'the female voice is speaker 4')
  const f = voiceService(V, { voice: { tts: { engine: 'elevenlabs' }, eleven: { voiceId: 'abc' } }, elevenReady: true, elevenFail: true })
  f.svc.setActive(true)
  await f.svc.cmd({ kind: 'say', key: 'listening' })
  await settle()
  check(f.synth.map((s) => s.engine).join() === 'elevenlabs,local' && f.sent.some((x) => x.ch === 'event' && x.payload.code === 'elevenFailed'), 'an ElevenLabs failure falls back to the local voice and tells the renderer once')
  check(V.chunk(['a'.repeat(250), 'b'.repeat(250), 'c'], 400).length === 2 && V.cleanLabel('x\u0000y\nz') === 'x y z', 'chunk and cleanLabel')
}

function fakeChild() {
  const child = new EventEmitter()
  child.pid = 4242
  child.stdout = new EventEmitter()
  child.stdout.setEncoding = () => {}
  child.stdin = { got: '', end(t) { this.got = t } }
  return child
}

async function testSummarizer(S) {
  check(!S.summarizerArgv('es').some((a) => /wipe|MySQL/.test(a)) && S.summarizerArgv('es').includes('--safe-mode') && S.summarizerArgv('en').join(' ').includes('--model haiku --effort low'), 'argv: safe mode, Haiku at low effort, never the reply')
  const env = S.summarizerEnv({ PATH: 'x', SNAOS_CONSOLE_ID: 'p', SNAOS_CTL_TOKEN: 't', CLAUDE_CODE_CHILD_SESSION: '1', HOME: 'h' })
  check(env.PATH === 'x' && env.HOME === 'h' && !('SNAOS_CONSOLE_ID' in env) && !('SNAOS_CTL_TOKEN' in env) && !('CLAUDE_CODE_CHILD_SESSION' in env), 'env: no console variables, no child-session mark')
  check(S.summaryOfOutput('{"result":"  Hice el wipe.\\n¿Borro?  ","is_error":false}') === 'Hice el wipe. ¿Borro?' && S.summaryOfOutput('{"is_error":true,"result":"x"}') === '' && S.summaryOfOutput('nope') === '', 'summaryOfOutput: one line; an error or junk is empty')
  const c = clock()
  const spawned = []
  const killed = []
  let next = null
  const sum = new S.Summarizer({
    resolve: () => ({ file: 'claude.exe', args: [], verbatim: false }),
    spawn: (file, args, opts) => { const ch = fakeChild(); spawned.push({ file, args, opts, ch }); next = ch; return ch },
    kill: (pid) => killed.push(pid),
    cwd: path.join(os.tmpdir(), 'snaos-voice-sum-' + process.pid),
    env: { PATH: 'x', SNAOS_CONSOLE_ID: 'p' },
    timer: c.deps,
  })
  const p1 = sum.summarize('Texto largo uno.', 'es')
  await settle()
  check(spawned.length === 1 && spawned[0].ch.stdin.got === 'Texto largo uno.' && !('SNAOS_CONSOLE_ID' in spawned[0].opts.env) && spawned[0].opts.shell === false, 'the reply goes on stdin, the env is clean, no shell')
  const p2 = sum.summarize('Texto largo dos.', 'es')
  await settle()
  check(spawned.length === 1, 'one run at a time')
  next.stdout.emit('data', '{"result":"Uno.","is_error":false}')
  next.emit('close', 0)
  check(await p1 === 'Uno.', 'the first summary')
  await settle()
  check(spawned.length === 2, 'the next one starts after')
  await c.advance(25_000)
  check(await p2 === 'Texto largo dos.' && killed.includes(4242), 'a timeout kills the run and answers with the local summary')
  check(await sum.summarize('Texto largo uno.', 'es') === 'Uno.' && spawned.length === 2, 'a summary already made comes from the cache')
  // The breaker.
  for (const t of ['a1.', 'a2.']) {
    const p = sum.summarize(t, 'es')
    await settle()
    next.emit('close', 1)
    await p
  }
  const before = spawned.length
  check(await sum.summarize('a3.', 'es') === 'a3.' && spawned.length === before, 'three failures in a row: the local summary for a while, no run')
  await c.advance(10 * 60_000 + 10)
  void sum.summarize('a4.', 'es')
  await settle()
  check(spawned.length === before + 1, 'the breaker closes after 10 minutes')
  const none = new S.Summarizer({ resolve: () => null, spawn: () => { throw new Error('no') }, kill() {}, cwd: os.tmpdir(), timer: c.deps })
  check(await none.summarize('Solo esto. Y aquello.', 'es') === 'Solo esto. Y 1 punto más.' && !none.available(), 'without the CLI: the local summary, available() false')
  sum.dispose()
}

async function testCache(P) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snaos-voice-cache-'))
  try {
    let now = 1
    const cache = new P.PhraseCache(dir, () => 30_000, () => now++)
    const k = (text) => ({ engine: 'local', voice: '9', model: 'supertonic-3', speed: 1.15, lang: 'es', text })
    check(await cache.get(k('Terminó API.')) === null, 'a miss is null')
    await cache.put(k('Terminó API.'), audio(44100, 5000))
    const hit = await cache.get(k('Terminó API.'))
    check(hit && hit.rate === 44100 && hit.pcm.byteLength === 10000, 'a put phrase comes back with its rate and bytes')
    check(await cache.get({ ...k('Terminó API.'), voice: '4' }) === null && await cache.get({ ...k('Terminó API.'), speed: 1.2 }) === null, 'another voice or speed is another entry')
    const idx = fs.readFileSync(path.join(dir, 'index.json'), 'utf8')
    check(!idx.includes('Terminó') && /"[0-9a-f]{64}"/.test(idx), 'the index keeps hashes, never the text')
    await cache.put(k('Dos'), audio(44100, 5000))
    await cache.put(k('Tres'), audio(44100, 5000))
    check(cache.size() <= 30_000 && await cache.get(k('Tres')) !== null, 'past the size cap the least recently used go')
    const again = new P.PhraseCache(dir, () => 30_000)
    check(await again.get(k('Tres')) !== null, 'the index survives a restart')
    fs.writeFileSync(path.join(dir, 'index.json'), '{broken')
    const broken = new P.PhraseCache(dir, () => 30_000)
    check(await broken.get(k('Tres')) === null && broken.size() === 0, 'a corrupt index starts empty')
    await broken.clear()
    check(!fs.existsSync(dir), 'clear removes the cache folder')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

async function testEleven(E) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snaos-voice-eleven-'))
  try {
    const calls = []
    let reply = { status: 200, body: new Int16Array(240).buffer, json: {} }
    const crypto = { available: () => true, encrypt: (s) => Buffer.from('enc:' + s), decrypt: (b) => b.toString().replace(/^enc:/, '') }
    let settings = { voiceId: 'voz123', model: 'eleven_flash_v2_5', mode: 'all', monthlyCap: 100, resetDay: 5, cacheMaxMb: 256 }
    let now = new Date(2026, 10, 7).getTime()
    const logs = []
    const el = new E.ElevenLabs({ dir, crypto, fetch: async (url, init) => { calls.push({ url, init }); return { status: reply.status, arrayBuffer: async () => reply.body, json: async () => reply.json } }, settings: () => settings, now: () => now, log: (l) => logs.push(l) })
    check(!el.ready() && JSON.stringify(el.keyState()) === '{"keySet":false,"last4":""}', 'no key: not ready')
    check((await el.setKey('not a key!')).error === 'bad_key', 'a key that is not a plain token is refused')
    const key = 'sk_abcdefghijklmnop1234'
    check((await el.setKey(key)).ok && el.ready() && el.keyState().last4 === '1234', 'a key is stored and only its last 4 characters are told')
    const onDisk = fs.readFileSync(path.join(dir, 'eleven-key.json'), 'utf8')
    check(!onDisk.includes(key) && onDisk.includes('"enc":"os"'), 'the key is sealed on disk, never in plain text')
    const fresh = new E.ElevenLabs({ dir, crypto, fetch: async () => reply, settings: () => settings })
    check(fresh.keyState().keySet, 'a restart reads the sealed key back')
    const a = await el.synth({ text: 'Terminó API.', lang: 'es', voice: '', speed: 1.15 })
    check(calls[0].url === 'https://api.elevenlabs.io/v1/text-to-speech/voz123?output_format=pcm_24000' && calls[0].init.method === 'POST' && calls[0].init.headers['xi-api-key'] === key, 'POST to api.elevenlabs.io with the voice id and pcm_24000')
    check(JSON.parse(calls[0].init.body).text === 'Terminó API.' && JSON.parse(calls[0].init.body).model_id === 'eleven_flash_v2_5' && a.rate === 24000, 'the body has the text and the model; 24 kHz audio back')
    check(el.usage().usedChars === 12 && el.usage().periodStart === '2026-11-05', 'characters are counted in the period that started on the reset day')
    check(el.canSpend(80) && !el.canSpend(89), 'canSpend keeps variable text within the monthly cap')
    settings = { ...settings, mode: 'fixedOnly' }
    check(!el.canSpend(1), 'fixedOnly never spends on variable text')
    now = new Date(2026, 11, 6).getTime()
    check(el.usage().usedChars === 0 && el.usage().periodStart === '2026-12-05', 'a new period starts from zero')
    for (const [status, json, want] of [[401, {}, 'unauthorized'], [401, { detail: { status: 'quota_exceeded' } }, 'quota'], [429, {}, 'rate_limited'], [404, {}, 'bad_voice'], [500, {}, 'network']]) {
      reply = { status, body: new ArrayBuffer(0), json }
      let reason = ''
      try { await el.synth({ text: 'x', lang: 'es', voice: '', speed: 1 }) } catch (e) { reason = e.reason }
      check(reason === want, `HTTP ${status} is ${want}`)
    }
    check(!logs.join('\n').includes(key) && !logs.join('\n').includes('Terminó'), 'the log has neither the key nor any text')
    check(E.periodStart(new Date(2026, 0, 3).getTime(), 5) === '2025-12-05' && E.periodStart(new Date(2026, 0, 5).getTime(), 5) === '2026-01-05', 'periodStart wraps the year')
    reply = { status: 200, body: new ArrayBuffer(0), json: { character_count: 50, character_limit: 100000 } }
    const t = await el.test()
    check(t.ok && t.used === 50 && t.limit === 100000 && calls.at(-1).url === 'https://api.elevenlabs.io/v1/user/subscription', 'test reads the subscription once')
    check((await el.setKey(null)).ok && !el.ready() && !fs.existsSync(path.join(dir, 'eleven-key.json')), 'removing the key deletes the file')
    const noCrypto = new E.ElevenLabs({ dir, crypto: { available: () => false }, fetch: async () => reply, settings: () => settings })
    check((await noCrypto.setKey(key)).error === 'unavailable' && !fs.existsSync(path.join(dir, 'eleven-key.json')), 'without OS encryption nothing is stored')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

async function testLocal(L) {
  const c = clock()
  const workers = []
  const mk = () => {
    const w = new EventEmitter()
    w.sent = []
    w.killed = false
    w.postMessage = (m) => w.sent.push(m)
    w.kill = () => { w.killed = true; return true }
    workers.push(w)
    return w
  }
  let installed = true
  const tts = new L.LocalTts({ fork: mk, paths: () => (installed ? { addon: 'C:/d/voice/runtime/sherpa.node', model: 'C:/d/voice/models/m' } : null), timer: c.deps })
  check(tts.ready() && !tts.running, 'ready with the pack installed; no worker until the first synthesis')
  const p = tts.synth({ text: 'Hola', lang: 'es', voice: '9', speed: 1.15 })
  await settle()
  check(workers.length === 1 && workers[0].sent[0].t === 'load' && workers[0].sent[0].threads === 2, 'the first synthesis forks the worker and loads the pack with 2 threads')
  workers[0].emit('message', { t: 'loaded', rate: 44100, speakers: 10 })
  await settle()
  const req = workers[0].sent.find((m) => m.t === 'synth')
  check(req && req.text === 'Hola' && req.sid === 9 && req.lang === 'es', 'then the text with the speaker id and the language')
  workers[0].emit('message', { t: 'audio', id: req.id, rate: 44100, pcm: new Int16Array(10).buffer })
  const a = await p
  check(a.rate === 44100 && a.pcm.byteLength === 20, 'the audio comes back')
  await c.advance(5 * 60_000 + 10)
  check(workers[0].killed && !tts.running, 'the worker is killed 5 minutes after the last synthesis')
  const p2 = tts.synth({ text: 'Otra', lang: 'es', voice: '4', speed: 1 }).catch((e) => e)
  await settle()
  workers[1].emit('message', { t: 'loaded', rate: 44100 })
  await settle()
  await c.advance(20_000 + 10)
  let code = (await p2)?.code ?? ''
  check(code === 'timeout' && workers[1].killed, 'a synthesis past its timeout kills the worker')
  const p3 = tts.synth({ text: 'x', lang: 'es', voice: '9', speed: 1 }).catch((e) => e)
  await settle()
  workers[2].emit('exit', 1)
  code = (await p3)?.code ?? ''
  check(code === 'exit', 'a worker that dies fails what was pending')
  installed = false
  code = ''
  try { await tts.synth({ text: 'x', lang: 'es', voice: '9', speed: 1 }) } catch (e) { code = e.code }
  check(code === 'missing' && !tts.ready(), 'without the pack: missing, nothing forked')
  tts.dispose()
  check(c.pending() === 0, 'dispose leaves no timer')
  const W = load('src/main/voice/ttsWorker.ts')
  const s16 = new Int16Array(W.toS16(new Float32Array([0, 1, -1, 2, -2])))
  check(s16[0] === 0 && s16[1] === 32767 && s16[2] === -32768 && s16[3] === 32767 && s16[4] === -32768, 'toS16 clamps and scales')
}

function testCatalog(C) {
  const r = C.VOICE_ASSETS['voice-runtime']
  const m = C.VOICE_ASSETS['voice-model']
  check(r.url === 'https://registry.npmjs.org/sherpa-onnx-win-x64/-/sherpa-onnx-win-x64-2.0.1.tgz' && r.bytes === 8779375 && r.sha256 === '217cec234c6026dbfd2b9c06523507180796fe4227c7cc9d11cfe218260a2519', 'the runtime is pinned (npm sherpa-onnx-win-x64 2.0.1)')
  check(m.url.endsWith('/tts-models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2') && m.bytes === 128774318 && m.sha256 === '82fa96f91c4ef8abaae3a14a3f4153facf88bed821d1f7331cec2700f432c427', 'the model is pinned (Supertonic 3 int8)')
  check(r.members.every((x) => x.startsWith('package/')) && r.members.some((x) => x.endsWith('sherpa-onnx.node')) && m.members.some((x) => x.endsWith('vocoder.int8.onnx')), 'members to extract, stripped of their first folder')
  check(C.isAllowedVoiceHost('github.com') && C.isAllowedVoiceHost('objects.githubusercontent.com') && C.isAllowedVoiceHost('registry.npmjs.org') && !C.isAllowedVoiceHost('evil.com') && !C.isAllowedVoiceHost('npmjs.org.evil.com'), 'only GitHub and the npm registry')
  const cat = C.voiceInstallerCatalog()
  check(cat.packIds.join() === 'supertonic' && cat.packs.supertonic.join() === 'voice-runtime,voice-model', 'the installer catalog has the one pack')
  check(C.packPaths('C:/d/voice').addon.replace(/\\/g, '/') === 'C:/d/voice/runtime/sherpa-2.0.1/sherpa-onnx.node', 'the addon path under voiceDir')
}

async function main() {
  await testQueue(load('src/main/voice/NarrationQueue.ts'))
  await testService(load('src/main/voice/VoiceService.ts'))
  await testSummarizer(load('src/main/voice/Summarizer.ts'))
  await testCache(load('src/main/voice/PhraseCache.ts'))
  await testEleven(load('src/main/voice/ElevenLabs.ts'))
  await testLocal(load('src/main/voice/LocalTts.ts'))
  testCatalog(load('src/main/voice/catalog.ts'))
  console.log(`PASS: ${checks} voice main checks (narration queue, VoiceService, summarizer, phrase cache, ElevenLabs, local engine, catalog)`)
}

main().catch((e) => { console.error(e); process.exit(1) })
