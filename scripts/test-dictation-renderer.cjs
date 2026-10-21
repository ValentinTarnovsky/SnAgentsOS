// Desktop dictation (app 2.5.0), the renderer side and the web permissions,
// in node with esbuild + vm:
//  - main's permission table (moved here from test-dictation.cjs): `media`
//    only for the app page and only audio, request and check handlers;
//  - the AudioWorklet (src/renderer/public/dictation-worklet.js): 100 ms
//    chunks of 16 kHz s16, clamping, mixdown and resampling from 48 and 44.1 kHz;
//  - dictationCapture with a fake getUserMedia / AudioContext / worklet node:
//    audio-only constraints, the 16 kHz context and its device-rate fallback,
//    resume, error codes, stop releasing everything;
//  - the store (moved checks: never an Enter, the menu guard, held text, the
//    field caret) plus capture: chunks before the session id flushed in order
//    and capped, capture stopped on end / stop / refusal / replacement, capture
//    errors, and `slow` before ready and on the first reply after it.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const fs = require('node:fs')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, URL, setTimeout, clearTimeout, ...overrides })
  return mod.exports
}
function loadRenderer(contents, overrides = {}) {
  const code = buildSync({ stdin: { contents, resolveDir: path.join(root, 'src/renderer/lib'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, crypto: globalThis.crypto, setTimeout, clearTimeout, URL, TextEncoder, ...overrides })
  return mod.exports
}
const flush = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

// Controllable timers for the store's `slow` and the capture's resume timeout.
function fakeTimers() {
  let now = 0, seq = 0
  const map = new Map()
  return {
    setTimeout: (fn, ms) => { const id = ++seq; map.set(id, { fn, at: now + (ms || 0) }); return id },
    clearTimeout: (id) => { map.delete(id) },
    advance(ms) {
      const end = now + ms
      for (;;) {
        let next = null
        for (const [id, t] of map) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t]
        if (!next) break
        map.delete(next[0])
        now = next[1].at
        next[1].fn()
      }
      now = end
    },
    pending: () => map.size,
  }
}

// A fake microphone + Web Audio: getUserMedia, AudioContext, AudioWorkletNode.
function fakeMedia() {
  const env = { gum: [], tracks: [], ctxs: [], nodes: [], modules: [], gumError: null, rateRefused: false, sourceRefuses: false, resumeHangs: false, addModuleError: null, gumGate: null }
  const named = (name) => { const e = new Error(name); e.name = name; return e }
  class Track { constructor() { this.stopped = false; this.onended = null } stop() { this.stopped = true } }
  const mediaDevices = {
    getUserMedia: async (c) => {
      env.gum.push(c)
      if (env.gumGate) await env.gumGate
      if (env.gumError) throw named(env.gumError)
      const t = new Track()
      env.tracks.push(t)
      return { getAudioTracks: () => [t], getTracks: () => [t] }
    },
  }
  class AudioContext {
    constructor(o = {}) {
      if (o.sampleRate && env.rateRefused) throw named('NotSupportedError')
      this.opts = o
      this.sampleRate = o.sampleRate || 48000
      this.state = 'suspended'
      this.resumes = 0
      this.audioWorklet = { addModule: async (u) => { env.modules.push(u); if (env.addModuleError) throw named(env.addModuleError) } }
      env.ctxs.push(this)
    }
    createMediaStreamSource() {
      if (env.sourceRefuses && this.sampleRate === 16000) throw named('NotSupportedError')
      const src = { connected: [], disconnected: 0, connect(n) { this.connected.push(n) }, disconnect() { this.disconnected++ } }
      this.source = src
      return src
    }
    resume() { this.resumes++; if (env.resumeHangs) return new Promise(() => {}); this.state = 'running'; return Promise.resolve() }
    close() { this.state = 'closed'; return Promise.resolve() }
  }
  class AudioWorkletNode {
    constructor(ctx, name, opts) {
      this.ctx = ctx; this.name = name; this.opts = opts; this.disconnected = 0
      this.port = { onmessage: null, closed: false, close() { this.closed = true } }
      env.nodes.push(this)
    }
    disconnect() { this.disconnected++ }
  }
  env.globals = { navigator: { language: 'es-AR', mediaDevices }, AudioContext, AudioWorkletNode }
  /** Posts one chunk from the newest worklet node, as the worklet would. */
  env.chunk = (buf, node = env.nodes.at(-1)) => node.port.onmessage?.({ data: buf })
  return env
}
/** 100 ms of 16 kHz s16 at a constant level (0 = silence). */
const pcm = (level = 0, frames = 1600) => { const a = new Int16Array(frames); a.fill(level); return a.buffer }
const tagged = (n, level = 0) => { const a = new Int16Array(1600); a.fill(level); a[0] = n; return a.buffer }

async function main() {
  // --- Web permissions ---------------------------------------------------------------
  {
    const P = load('src/main/permissions.ts')
    const file = 'file:///C:/Program%20Files/SnAgentsOS/resources/app.asar/out/renderer/index.html'
    check(P.isAppOrigin(file, file, true) && P.isAppOrigin('file:///c:/program files/snagentsos/resources/app.asar/out/renderer/index.html#/x', file, true), 'the renderer file is the app (hash ignored, case-insensitive on Windows)')
    check(!P.isAppOrigin('file:///C:/Users/me/Downloads/evil.html', file, true) && !P.isAppOrigin('file:///', file, true) && !P.isAppOrigin('https://example.com/', file, true), 'another file, an opaque file origin or a web page are not')
    check(!P.isAppOrigin(file.toLowerCase(), file, false), 'case matters off Windows')
    const dev = 'http://localhost:5173/'
    check(P.isAppOrigin('http://localhost:5173/index.html', dev) && !P.isAppOrigin('http://localhost:5174/', dev) && !P.isAppOrigin('http://127.0.0.1:5173/', dev) && !P.isAppOrigin(file, dev), 'dev: only the ELECTRON_RENDERER_URL origin')
    check(!P.isAppOrigin('', file) && !P.isAppOrigin(undefined, file) && !P.isAppOrigin('not a url', file) && !P.isAppOrigin(file, 'not a url'), 'empty or broken URLs fail closed')
    const evil = 'file:///C:/x/evil.html'
    const table = [
      ['notifications', file, null, true], ['clipboard-sanitized-write', file, null, true], ['fullscreen', file, null, true],
      ['geolocation', file, null, false], ['clipboard-read', file, null, false], ['openExternal', file, null, false], ['hid', file, null, false],
      ['display-capture', file, null, false], ['speaker-selection', file, null, false],
      ['notifications', 'https://evil.example/', null, false], ['fullscreen', evil, null, false],
      // media: the app page, audio only.
      ['media', file, null, false], ['media', file, {}, false],
      ['media', file, { types: ['audio'] }, true],
      ['media', file, { types: ['audio', 'audio'] }, true],
      ['media', file, { types: ['audio', 'video'] }, false],
      ['media', file, { types: ['video'] }, false],
      ['media', file, { types: [] }, false],
      ['media', file, { types: 'audio' }, false],
      ['media', evil, { types: ['audio'] }, false],
      ['media', 'https://evil.example/', { types: ['audio'] }, false],
      ['media', file, { type: 'audio' }, true],
      ['media', file, { type: 'video' }, false],
      ['media', file, { type: 'unknown' }, false],
      ['media', evil, { type: 'audio' }, false],
      // An audio answer never leaks into another permission.
      ['geolocation', file, { types: ['audio'] }, false],
    ]
    for (const [perm, url, media, want] of table) check(P.allowPermission(perm, url, file, true, media) === want, `${perm} ${JSON.stringify(media)} from ${url.slice(0, 24)}: ${want ? 'allowed' : 'denied'}`)
    check(P.audioOnly({ types: ['audio'], type: 'audio' }) && !P.audioOnly({ types: ['audio'], type: 'video' }) && !P.audioOnly(null) && !P.audioOnly(undefined), 'audioOnly: both fields must agree; nothing fails closed')
    let req = null, chk = null
    P.installPermissionHandlers({ setPermissionRequestHandler: (fn) => { req = fn }, setPermissionCheckHandler: (fn) => { chk = fn } }, file)
    const ask = (perm, details) => { let answer = 'none'; req(null, perm, (v) => { answer = v }, details); return answer }
    check(ask('media', { requestingUrl: file, mediaTypes: ['audio'] }) === true, 'request handler: the microphone for the app page')
    check(ask('media', { requestingUrl: file, mediaTypes: ['video'] }) === false && ask('media', { requestingUrl: file, mediaTypes: ['audio', 'video'] }) === false, 'request handler: the camera is denied, alone or with the mic')
    check(ask('media', { requestingUrl: file }) === false && ask('media', { requestingUrl: file, mediaTypes: [] }) === false, 'request handler: media without types is denied')
    check(ask('media', { requestingUrl: evil, mediaTypes: ['audio'] }) === false, 'request handler: the mic for another file page is denied')
    check(ask('notifications', { requestingUrl: file }) === true && ask('geolocation', { requestingUrl: file }) === false, 'request handler: notifications allowed, geolocation denied')
    check(chk({ getURL: () => file }, 'notifications', 'file:///', {}) === true, 'check handler: the opaque file origin falls back to the page URL')
    check(chk(null, 'notifications', 'file:///', {}) === false, 'check handler: no page is denied')
    check(chk({ getURL: () => file }, 'media', 'file:///', { requestingUrl: file, mediaType: 'audio' }) === true, "check handler: mediaType 'audio' for the app")
    check(chk({ getURL: () => file }, 'media', 'file:///', { requestingUrl: file, mediaType: 'video' }) === false, "check handler: mediaType 'video' denied")
    check(chk({ getURL: () => file }, 'media', 'file:///', { requestingUrl: file }) === false && chk({ getURL: () => file }, 'media', 'file:///', { requestingUrl: file, mediaType: 'unknown' }) === false, 'check handler: media with no or an unknown type denied')
    check(chk({ getURL: () => evil }, 'media', 'file:///', { mediaType: 'audio' }) === false, 'check handler: audio for another page denied')
    const src = fs.readFileSync(path.join(root, 'src/main/permissions.ts'), 'utf8')
    check(!/never through getUserMedia/.test(src), 'the doc comment no longer says media is never used')
  }

  // --- The AudioWorklet ----------------------------------------------------------------
  {
    const code = fs.readFileSync(path.join(root, 'src/renderer/public/dictation-worklet.js'), 'utf8')
    check(!/[\u2013\u2014]/.test(code) && !/^\uFEFF/.test(code), 'worklet: no em or en dash, no BOM')
    check(!/\bimport\b|\brequire\(|\bfetch\(|eval\(/.test(code), 'worklet: a plain script with no imports, fetch or eval')
    const worklet = (rate) => {
      const posted = []
      let Proc = null, name = null
      class AudioWorkletProcessor { constructor() { this.port = { postMessage: (m, transfer) => posted.push({ m, transfer }) } } }
      vm.runInNewContext(code, { AudioWorkletProcessor, registerProcessor: (n, c) => { name = n; Proc = c }, sampleRate: rate, Math, Int16Array })
      return { name, p: new Proc(), posted }
    }
    let alive = true
    const feed = (w, frames, fn, block = 128, chans = 1) => {
      for (let i = 0; i < frames; i += block) {
        const n = Math.min(block, frames - i)
        const input = []
        for (let c = 0; c < chans; c++) { const a = new Float32Array(n); for (let k = 0; k < n; k++) a[k] = fn(i + k, c); input.push(a) }
        if (w.p.process([input], [], {}) !== true) alive = false
      }
    }
    const samples = (w) => w.posted.map((x) => new Int16Array(x.m))
    {
      const w = worklet(16000)
      check(w.name === 'snaos-pcm', 'worklet registers snaos-pcm')
      feed(w, 1600 * 2 + 64, (i) => [0.5, -1, 2, -2, 0][i % 5])
      const s = samples(w)
      check(w.posted.length === 2 && w.posted.every((x) => x.m.byteLength === 3200), '16 kHz: 100 ms chunks of 3200 bytes, a partial chunk waits')
      check(w.posted.every((x) => x.transfer?.length === 1 && x.transfer[0] === x.m), 'each chunk is transferred, not copied')
      check(s[0][0] === 16384 && s[0][1] === -32768 && s[0][2] === 32767 && s[0][3] === -32768 && s[0][4] === 0, 'Float32 to s16 with clamping: ' + Array.from(s[0].slice(0, 5)))
      check(alive, 'process() always returns true (the node stays alive)')
      check(w.p.process([[]], [], {}) === true && w.p.process([], [], {}) === true && w.posted.length === 2, 'no input (mic not flowing yet) is a no-op')
    }
    {
      const w = worklet(48000)
      feed(w, 4800, () => 0.25)
      const s = samples(w)
      check(w.posted.length === 1 && s[0].length === 1600 && s[0].every((v) => v === 8192), '48 kHz: 4800 frames give exactly one 1600-sample chunk, level kept')
      feed(w, 4800 * 3, (i) => (i % 3 === 0 ? 0.9 : 0))
      const s2 = samples(w)
      check(w.posted.length === 4 && s2[1].every((v) => v === Math.round(0.3 * 0x7fff)), '48 kHz: area average of each 3 input samples (box filter)')
    }
    {
      const w = worklet(44100)
      feed(w, 44100, () => 0.1)
      const total = samples(w).reduce((n, a) => n + a.length, 0)
      check(w.posted.length === 9 || w.posted.length === 10, '44.1 kHz: one second gives about 10 chunks (' + w.posted.length + ')')
      const outSoFar = total + 0
      check(outSoFar >= 14400 && outSoFar <= 16000, '44.1 kHz resampled sample count is consistent: ' + outSoFar)
      feed(w, 441, () => 0.1)
      check(w.posted.length === 10 && samples(w).every((a) => a.every((v) => Math.abs(v - Math.round(0.1 * 0x7fff)) <= 1)), '44.1 kHz: 1.01 s gives 10 chunks, level kept')
    }
    {
      const w = worklet(16000)
      feed(w, 1600, (_i, c) => (c === 0 ? 0.5 : -0.5), 128, 2)
      check(w.posted.length === 1 && samples(w)[0].every((v) => v === 0), 'stereo input is mixed down to mono')
    }
  }

  // --- dictationCapture --------------------------------------------------------------
  {
    const env = fakeMedia()
    const T = fakeTimers()
    const C = loadRenderer(`export * from './dictationCapture'`, { ...env.globals, document: { baseURI: 'file:///C:/app/resources/app.asar/out/renderer/index.html' }, setTimeout: T.setTimeout, clearTimeout: T.clearTimeout })
    check(C.CHUNK_BYTES === 3200, 'a chunk is 3200 bytes')
    check(C.workletUrl() === 'file:///C:/app/resources/app.asar/out/renderer/dictation-worklet.js', 'the worklet sits next to index.html: ' + C.workletUrl())
    const got = [], errs = []
    const cap = await C.startCapture((b) => got.push(b), (e) => errs.push(e))
    const c = env.gum[0]
    check(c.video === false && c.audio && c.audio.channelCount === 1 && c.audio.echoCancellation && c.audio.noiseSuppression && c.audio.autoGainControl, 'getUserMedia: audio only, mono, with the voice processing on')
    const ctx = env.ctxs[0], node = env.nodes[0]
    check(env.ctxs.length === 1 && ctx.opts.sampleRate === 16000 && ctx.opts.latencyHint === 'interactive' && cap.rate === 16000, 'one 16 kHz interactive AudioContext')
    check(ctx.resumes === 1 && ctx.state === 'running', 'the context is resumed')
    check(env.modules.join() === C.workletUrl(), 'the worklet module loads from the same-origin file')
    check(node.name === 'snaos-pcm' && node.opts.numberOfOutputs === 0 && node.opts.numberOfInputs === 1 && ctx.source.connected[0] === node, 'mic -> snaos-pcm node, no output (nothing plays)')
    env.chunk(pcm(5))
    env.chunk(new ArrayBuffer(3))
    env.chunk('junk')
    env.chunk(new Int16Array(8))
    check(got.length === 1 && got[0].byteLength === 3200, 'whole ArrayBuffer chunks only (odd length, strings and views dropped)')
    cap.stop()
    cap.stop()
    env.chunk(pcm(5), node)
    check(got.length === 1 && env.tracks[0].stopped && ctx.state === 'closed' && node.port.closed && node.port.onmessage === null && ctx.source.disconnected >= 1, 'stop releases the mic, the graph and the context; idempotent; nothing after it')

    // The track ends (mic unplugged): onError('audio'), already stopped.
    const cap2 = await C.startCapture((b) => got.push(b), (e) => errs.push(e))
    env.tracks.at(-1).onended()
    check(errs.join() === 'audio' && env.tracks.at(-1).stopped && env.ctxs.at(-1).state === 'closed', 'a track that ends reports audio and releases everything')
    cap2.stop()

    // 16 kHz refused: by the context, or by the stream source.
    env.rateRefused = true
    const cap3 = await C.startCapture(() => undefined)
    check(cap3.rate === 48000 && env.ctxs.at(-1).opts.sampleRate === undefined, 'a refused 16 kHz context falls back to the device rate (the worklet resamples)')
    cap3.stop()
    env.rateRefused = false
    env.sourceRefuses = true
    const before = env.ctxs.length
    const cap4 = await C.startCapture(() => undefined)
    check(env.ctxs.length === before + 2 && env.ctxs[before].state === 'closed' && cap4.rate === 48000, 'a stream source refusing 16 kHz closes that context and uses the device rate')
    cap4.stop()
    env.sourceRefuses = false

    // Error codes.
    const codeOf = async () => { try { await C.startCapture(() => undefined); return 'ok' } catch (e) { return e.code } }
    for (const [name, want] of [['NotAllowedError', 'mic_denied'], ['SecurityError', 'mic_denied'], ['NotFoundError', 'no_mic'], ['OverconstrainedError', 'no_mic'], ['NotReadableError', 'audio'], ['AbortError', 'audio'], ['TypeError', 'audio']]) {
      env.gumError = name
      check((await codeOf()) === want, `getUserMedia ${name} -> ${want}`)
    }
    env.gumError = null
    check(C.captureErrorCode(null) === 'audio' && C.captureErrorCode({ name: 'NotAllowedError' }) === 'mic_denied', 'captureErrorCode on plain values')
    env.addModuleError = 'AbortError'
    const tracksBefore = env.tracks.length
    check((await codeOf()) === 'audio' && env.tracks.length === tracksBefore + 1 && env.tracks.at(-1).stopped && env.ctxs.at(-1).state === 'closed', 'a worklet that fails to load is audio, and the mic and context are released')
    env.addModuleError = null
    env.resumeHangs = true
    const p = codeOf()
    await flush()
    T.advance(C.RESUME_TIMEOUT_MS - 1)
    await flush()
    let settled = null
    p.then((v) => { settled = v })
    await flush()
    check(settled === null, 'a suspended context is waited on')
    T.advance(1)
    await flush()
    check(settled === 'audio' && env.tracks.at(-1).stopped && env.ctxs.at(-1).state === 'closed', 'a context that never runs is audio after RESUME_TIMEOUT_MS, released')
    env.resumeHangs = false
    const noMd = loadRenderer(`export * from './dictationCapture'`, { navigator: {}, document: { baseURI: 'file:///x/index.html' } })
    let code = null
    try { await noMd.startCapture(() => undefined) } catch (e) { code = e.code }
    check(code === 'no_mic', 'no mediaDevices at all is no_mic')
  }

  // --- Renderer store: never an Enter, the menu guard, capture ---------------------------
  {
    const env = fakeMedia()
    const T = fakeTimers()
    const listeners = new Set()
    const calls = { start: [], stop: [], audio: [] }
    let nextId = 0
    let startGate = null
    const snApi = {
      platform: 'win32',
      dictation: {
        start: async (req) => { calls.start.push(req); if (startGate) await startGate.p; return { ok: true, sessionId: 's' + ++nextId } },
        stop: async (id) => { calls.stop.push(id) },
        audio: (id, buf) => { calls.audio.push([id, new Int16Array(buf)[0], buf.byteLength]) },
        onEvent: (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
        openSettings: async () => true,
      },
    }
    const gate = () => { let open; const p = new Promise((r) => { open = r }); return { p, open } }
    const R = loadRenderer(`
      export * as D from './dictation'
      export { useAppStore } from './store'
      export { registerPaster } from './pasteRegistry'
      export { registerPty, unregisterPty } from './ptyRegistry'
      export { registerTermReader } from './termReaders'
      export { setFocusedPane } from './focus'
    `, { ...env.globals, window: { snApi }, requestAnimationFrame: (fn) => fn(), document: { hasFocus: () => true, baseURI: 'file:///C:/app/out/renderer/index.html' }, setTimeout: T.setTimeout, clearTimeout: T.clearTimeout })
    const emit = (e) => listeners.forEach((cb) => cb(e))
    const pasted = []
    R.registerPaster('p1', { paste: (text, o) => pasted.push({ text, auto: o?.auto === true }), bracketed: () => true })
    R.registerPty('p1', 'pty-1')
    let screen = ['PS C:\\> ']
    R.registerTermReader('p1', () => screen)
    R.useAppStore.setState({ hydrated: true, activeWorkspaceId: 'w', workspaces: [{ id: 'w', name: 'W', cwd: '', panes: [{ id: 'p1', type: 'claude', title: 'C', icon: 'bot' }] }] })
    const D = R.D
    const state = () => D.useDictationStore.getState()
    check(D.STARTING_SLOW_MS === 4000 && D.REPLY_SLOW_MS === 4000 && D.EARLY_CHUNKS_MAX === 100, 'slow after 4 s, 100 early chunks (10 s)')
    const src = fs.readFileSync(path.join(root, 'src/renderer/lib/dictation.ts'), 'utf8')
    check(!/settings\.dictation\?*\.engine|engine:\s*'(online|offline|auto)'/.test(src), 'the store no longer reads an engine setting')

    R.useAppStore.setState((s) => ({ settings: { ...s.settings, language: 'es', dictation: { device: 'auto', language: 'auto', headerButton: true, interim: true, vocabulary: '' } } }))
    D.toggleDictationPane('p1')
    check(state().phase === 'starting' && state().slow === false, 'the mic starts a session')
    await flush()
    check(JSON.stringify(calls.start[0]) === '{"lang":"es-AR","paneId":"p1"}', "start sends the language ('auto' resolves to the system one when it matches the app) and the console: " + JSON.stringify(calls.start[0]))
    check(env.gum.length === 1 && env.nodes.length === 1, 'the microphone opens with the start')
    check(state().sessionId === 's1' && D.isDictating('pane:p1'), 'listening on p1')
    env.chunk(tagged(7))
    check(calls.audio.length === 1 && calls.audio[0].join() === 's1,7,3200', 'a chunk goes to main with the session id')
    emit({ sessionId: 'other', t: 'final', text: 'intruso' })
    emit({ sessionId: 's1', t: 'ready', engine: 'cpu', fallback: 'gpu_failed' })
    emit({ sessionId: 's1', t: 'hyp', text: 'hola' })
    check(state().phase === 'listening' && state().engine === 'cpu' && state().fallback === 'gpu_failed' && state().interim === 'hola', 'ready, fallback and the phrase so far')
    emit({ sessionId: 's1', t: 'final', text: 'Hola mundo' })
    emit({ sessionId: 's1', t: 'final', text: 'Esto es una prueba' })
    emit({ sessionId: 's1', t: 'final', text: '.' })
    check(JSON.stringify(pasted.map((p) => p.text)) === JSON.stringify(['Hola mundo', ' esto es una prueba', '.']), 'finals typed with one space between, mid-sentence lowercase, none before punctuation: ' + JSON.stringify(pasted))
    check(pasted.every((p) => !/[\r\n]/.test(p.text) && !p.auto), 'never a CR or LF, and typed as the user (not auto)')
    emit({ sessionId: 's1', t: 'final', text: 'linea uno\r\nlinea dos\n' })
    check(!/[\r\n]/.test(pasted.at(-1).text), 'a final with CR LF from main is still typed on one line: ' + JSON.stringify(pasted.at(-1).text))
    check(state().interim === '' && state().held === '', 'nothing held without a menu')

    // Menu guard: a pending permission holds the text back.
    pasted.length = 0
    R.useAppStore.setState({ paneStatus: { p1: { state: 'action', precise: true, provider: 'claude', reason: 'permission', pendingCount: 1, pending: [{ id: 't', kind: 'permission', summary: 'Bash' }] } } })
    emit({ sessionId: 's1', t: 'final', text: '2 archivos' })
    check(pasted.length === 0 && state().held === ' 2 archivos', 'with a pending permission, "2 archivos" is not typed (it would pick option 2)')
    R.useAppStore.setState({ paneStatus: { p1: { state: 'working', precise: true, provider: 'claude' } } })
    emit({ sessionId: 's1', t: 'final', text: 'y algo mas' })
    check(pasted.length === 0 && state().held === ' 2 archivos y algo mas', 'once something is held, the rest waits too (order kept)')
    D.insertHeld()
    check(JSON.stringify(pasted.map((p) => p.text)) === JSON.stringify([' 2 archivos y algo mas']) && state().held === '', 'Insert types the held text, still without Enter')
    pasted.length = 0
    R.useAppStore.setState({ paneStatus: { p1: { state: 'action', precise: true, provider: 'claude', reason: 'plan', attention: false } } })
    emit({ sessionId: 's1', t: 'final', text: 'listo' })
    check(pasted.length === 1, 'an action already answered (attention false, nothing pending) does not hold')
    pasted.length = 0
    screen = ['Do you want to proceed?', '\u276F 1. Yes', '  2. Yes, and don\'t ask again for git commands', '  3. No, and tell Claude what to do differently (esc)', '']
    emit({ sessionId: 's1', t: 'final', text: 'uno' })
    check(pasted.length === 0 && state().held === ' uno', 'a numbered menu on screen holds the text even without a pending request')
    D.useDictationStore.setState({ held: '' })
    screen = ['PS C:\\> ']
    for (const kind of ['question', 'elicitation', 'plan']) {
      R.useAppStore.setState({ paneStatus: { p1: { state: 'action', precise: true, provider: 'claude', reason: kind, pending: [{ id: kind, kind, summary: kind }] } } })
      emit({ sessionId: 's1', t: 'final', text: kind })
      check(pasted.length === 0 && state().held.endsWith(kind), `a pending ${kind} holds the text`)
    }
    D.useDictationStore.setState({ held: '' })
    R.useAppStore.setState({ paneStatus: {} })

    // Stop, end, errors.
    const node1 = env.nodes[0]
    D.toggleDictationPane('p1')
    check(state().phase === 'stopping' && calls.stop.join() === 's1', 'the mic again stops (stop to main)')
    check(env.tracks[0].stopped && env.ctxs[0].state === 'closed', 'Stop closes the microphone right away')
    const sent = calls.audio.length
    env.chunk(tagged(8), node1)
    check(calls.audio.length === sent, 'no chunk after Stop')
    emit({ sessionId: 's1', t: 'end' })
    check(state().phase === 'idle' && !D.isDictating('pane:p1'), 'end -> idle')
    pasted.length = 0
    emit({ sessionId: 's1', t: 'final', text: 'tarde' })
    check(pasted.length === 0, 'nothing after the end')

    // The shortcut and a pty change.
    R.setFocusedPane('p1', 'w')
    D.runDictateShortcut()
    await flush()
    check(state().sessionId === 's2' && D.isDictating('pane:p1'), 'the dictate shortcut starts on the focused console')
    R.registerPty('p1', 'pty-2')
    check(calls.stop.join() === 's1,s2' && state().phase === 'stopping' && env.tracks.at(-1).stopped, 'a new pty for the console stops the session and the mic, even before ready (its text was for the old one)')
    pasted.length = 0
    emit({ sessionId: 's2', t: 'final', text: 'frase final' })
    check(pasted.length === 0 && state().held === 'frase final', 'the last phrase drained after a pty change is held, never typed into the new pty: ' + JSON.stringify(state().held))
    emit({ sessionId: 's2', t: 'end' })
    D.insertHeld()
    check(JSON.stringify(pasted.map((p) => p.text)) === JSON.stringify(['frase final']) && state().held === '', 'Insert (the user asking) still types it')
    D.dismissDictation()

    // Each Whisper final is a new phrase, from the first one of a session on:
    // a repeat or an extension of the phrase before it is typed whole.
    {
      D.toggleDictationPane('p1')
      await flush()
      const sid = state().sessionId
      emit({ sessionId: sid, t: 'ready', engine: 'gpu' })
      pasted.length = 0
      emit({ sessionId: sid, t: 'final', text: 'Sí.' })
      emit({ sessionId: sid, t: 'final', text: 'Sí.' })
      emit({ sessionId: sid, t: 'final', text: 'Sí. Y otra cosa.' })
      const phrases = pasted.map((p) => p.text)
      check(JSON.stringify(phrases) === JSON.stringify(['Sí.', ' Sí.', ' Sí. Y otra cosa.']), 'a repeated phrase and one that extends the last are typed whole (no cumulative dedupe): ' + JSON.stringify(phrases))
      D.toggleDictationPane('p1')
      emit({ sessionId: sid, t: 'end' })
      check(state().phase === 'idle', 'that session ends')
      pasted.length = 0
    }

    // Error from start, error then end from main.
    snApi.dictation.start = async () => ({ ok: false, error: 'model_missing' })
    D.toggleDictationPane('p1')
    await flush()
    check(state().phase === 'idle' && state().error === 'model_missing' && state().scope === 'pane:p1', 'a refused start shows its error on that console')
    check(env.tracks.at(-1).stopped && env.ctxs.at(-1).state === 'closed', 'a refused start closes the microphone')
    D.dismissDictation()
    check(state().error === null && state().scope === null, 'dismiss clears it')
    snApi.dictation.start = async (req) => { calls.start.push(req); if (startGate) await startGate.p; return { ok: true, sessionId: 's' + ++nextId } }
    D.toggleDictationPane('p1')
    await flush()
    const sid = state().sessionId
    emit({ sessionId: sid, t: 'error', code: 'vcredist' })
    emit({ sessionId: sid, t: 'end' })
    check(state().phase === 'idle' && state().error === 'vcredist' && env.tracks.at(-1).stopped, 'an error from main stays after the end; the end closes the mic')
    D.releaseDictationScope('pane:p1')
    check(state().scope === null && state().error === null, 'the terminal unmounting drops it')

    // Chunks before the session id: buffered, flushed in order, capped.
    calls.audio.length = 0
    startGate = gate()
    D.toggleDictationPane('p1')
    await flush()
    check(state().phase === 'starting' && state().sessionId === null && env.nodes.length > 0, 'starting: the mic is open before main answers')
    for (let i = 1; i <= 3; i++) env.chunk(tagged(i))
    check(calls.audio.length === 0, 'chunks wait for the session id')
    startGate.open()
    startGate = null
    await flush()
    const s3 = state().sessionId
    check(calls.audio.map((a) => a.join()).join('|') === [1, 2, 3].map((n) => `${s3},${n},3200`).join('|'), 'the early chunks go to main in order with the new id: ' + JSON.stringify(calls.audio))
    env.chunk(tagged(4))
    check(calls.audio.at(-1).join() === `${s3},4,3200`, 'later chunks go straight to main')
    emit({ sessionId: s3, t: 'end' })
    check(env.tracks.at(-1).stopped && env.ctxs.at(-1).state === 'closed', 'end from main stops the capture')
    const afterEnd = calls.audio.length
    env.chunk(tagged(5), env.nodes.at(-1))
    check(calls.audio.length === afterEnd, 'no chunk after end')

    calls.audio.length = 0
    startGate = gate()
    D.toggleDictationPane('p1')
    await flush()
    for (let i = 1; i <= 105; i++) env.chunk(tagged(i))
    startGate.open()
    startGate = null
    await flush()
    check(calls.audio.length === 100 && calls.audio[0][1] === 6 && calls.audio[99][1] === 105, 'at most 100 early chunks (10 s), the oldest dropped first')
    D.stopDictation()
    emit({ sessionId: state().sessionId, t: 'end' })

    // Stop while starting: the capture and the session it gets are both stopped.
    startGate = gate()
    const gumGate = gate()
    env.gumGate = gumGate.p
    const tracksBefore = env.tracks.length
    D.toggleDictationPane('p1')
    await flush()
    D.toggleDictationPane('p1')
    check(state().phase === 'idle', 'the mic again while starting stops at once')
    gumGate.open()
    env.gumGate = null
    await flush()
    check(env.tracks.length === tracksBefore + 1 && env.tracks.at(-1).stopped && env.ctxs.at(-1).state === 'closed', 'a capture that opens after the stop is closed at once')
    const stopsBefore = calls.stop.length
    startGate.open()
    startGate = null
    await flush()
    check(calls.stop.length === stopsBefore + 1 && calls.stop.at(-1) === 's' + nextId && state().phase === 'idle' && state().sessionId === null, 'the session that arrives after the stop is stopped in main')

    // Capture errors: shown, and the session stops.
    env.gumError = 'NotAllowedError'
    startGate = gate()
    D.toggleDictationPane('p1')
    await flush()
    check(state().error === 'mic_denied' && state().phase === 'idle' && state().scope === 'pane:p1', 'a denied microphone shows mic_denied and stops')
    startGate.open()
    startGate = null
    await flush()
    check(calls.stop.at(-1) === 's' + nextId && state().phase === 'idle' && state().error === 'mic_denied', 'the session main opened meanwhile is stopped; the error stays')
    D.dismissDictation()
    env.gumError = 'NotReadableError'
    D.toggleDictationPane('p1')
    await flush()
    check(state().error === 'audio' && state().phase !== 'listening' && calls.stop.at(-1) === 's' + nextId, 'NotReadableError (Windows privacy) is audio, which offers the microphone page; the session stops')
    emit({ sessionId: 's' + nextId, t: 'end' })
    D.dismissDictation()
    env.gumError = 'NotFoundError'
    D.toggleDictationPane('p1')
    await flush()
    check(state().error === 'no_mic', 'no microphone is no_mic')
    emit({ sessionId: 's' + nextId, t: 'end' })
    D.dismissDictation()
    env.gumError = null
    D.toggleDictationPane('p1')
    await flush()
    const live = state().sessionId
    env.tracks.at(-1).onended()
    check(state().error === 'audio' && state().phase === 'stopping' && calls.stop.at(-1) === live, 'the mic disappearing mid-session shows audio and stops the session')
    emit({ sessionId: live, t: 'end' })
    D.dismissDictation()

    // A replacing start closes the previous capture.
    D.toggleDictationPane('p1')
    await flush()
    const firstTrack = env.tracks.at(-1)
    void D.startDictation({ kind: 'pane', paneId: 'p1' })
    await flush()
    check(firstTrack.stopped && !env.tracks.at(-1).stopped && env.tracks.at(-1) !== firstTrack, 'a new start replaces the capture of the old one')
    D.stopDictation()
    emit({ sessionId: state().sessionId, t: 'end' })

    // slow: before ready, and the first reply after ready.
    D.toggleDictationPane('p1')
    await flush()
    let slowSid = state().sessionId
    T.advance(3999)
    check(state().slow === false, 'not slow before 4 s')
    T.advance(1)
    check(state().slow === true, 'slow after 4 s without ready')
    emit({ sessionId: slowSid, t: 'ready', engine: 'gpu' })
    check(state().slow === false && state().engine === 'gpu', 'ready clears slow')
    env.chunk(pcm(0))
    T.advance(10000)
    check(state().slow === false, 'silence never makes it slow')
    env.chunk(pcm(3000))
    T.advance(2000)
    env.chunk(pcm(3000))
    T.advance(3999)
    check(state().slow === false, 'the wait counts from the last voiced chunk')
    T.advance(1)
    check(state().slow === true, 'speech sent and no phrase back 4 s later: slow (first CUDA JIT)')
    emit({ sessionId: slowSid, t: 'final', text: 'hola' })
    check(state().slow === false, 'the first phrase clears slow')
    env.chunk(pcm(3000))
    T.advance(20000)
    check(state().slow === false, 'after the first reply the session is never slow again')
    D.stopDictation()
    emit({ sessionId: slowSid, t: 'end' })
    check(state().slow === false && T.pending() === 0, 'end clears slow and its timers')

    D.toggleDictationPane('p1')
    await flush()
    slowSid = state().sessionId
    env.chunk(pcm(3000))
    emit({ sessionId: slowSid, t: 'ready', engine: 'gpu' })
    T.advance(4000)
    check(state().slow === true, 'speech sent while starting arms the reply wait at ready')
    emit({ sessionId: slowSid, t: 'hyp', text: 'ho' })
    check(state().slow === false, 'a hyp is a reply too')
    D.stopDictation()
    emit({ sessionId: slowSid, t: 'end' })

    D.toggleDictationPane('p1')
    await flush()
    D.stopDictation()
    T.advance(10000)
    check(state().slow === true && state().phase === 'stopping', 'stopping before ready still says slow while main drains')
    emit({ sessionId: state().sessionId, t: 'end' })
    check(state().slow === false && state().phase === 'idle', 'no slow left after the end')

    // A warm engine that hears only noise: main's empty final is an answer (review finding).
    D.toggleDictationPane('p1')
    await flush()
    slowSid = state().sessionId
    emit({ sessionId: slowSid, t: 'ready', engine: 'gpu' })
    env.chunk(pcm(3000))
    T.advance(1500)
    emit({ sessionId: slowSid, t: 'final', text: '' })
    env.chunk(pcm(3000))
    T.advance(20000)
    check(state().slow === false && state().interim === '', 'an empty final (VAD dropped the noise) clears the reply wait: never "loading the model" on a warm engine')
    emit({ sessionId: slowSid, t: 'hyp', text: 'git sta' })
    emit({ sessionId: slowSid, t: 'hyp', text: '' })
    check(state().interim === 'git sta', 'an empty hyp keeps the phrase shown so far')
    D.stopDictation()
    emit({ sessionId: slowSid, t: 'end' })
    // CPU: its model loads before `ready`, so a long first phrase is never "loading".
    D.toggleDictationPane('p1')
    await flush()
    slowSid = state().sessionId
    env.chunk(pcm(3000))
    emit({ sessionId: slowSid, t: 'ready', engine: 'cpu' })
    env.chunk(pcm(3000))
    T.advance(20000)
    check(state().slow === false, 'cpu: no reply wait after ready')
    D.stopDictation()
    emit({ sessionId: slowSid, t: 'end' })

    // timeout is a notice: the next answer clears it, and so does end (review finding).
    D.toggleDictationPane('p1')
    await flush()
    const tSid = state().sessionId
    emit({ sessionId: tSid, t: 'ready', engine: 'cpu' })
    emit({ sessionId: tSid, t: 'error', code: 'timeout' })
    check(state().error === 'timeout' && state().phase === 'listening', 'a timeout shows while it keeps listening')
    emit({ sessionId: tSid, t: 'final', text: 'sigue' })
    check(state().error === null, 'the next phrase clears it')
    emit({ sessionId: tSid, t: 'error', code: 'timeout' })
    emit({ sessionId: tSid, t: 'hyp', text: 'otra' })
    check(state().error === null && state().interim === 'otra', 'a hyp clears it too, and the interim shows again')
    emit({ sessionId: tSid, t: 'error', code: 'timeout' })
    emit({ sessionId: tSid, t: 'ready', engine: 'cpu', fallback: 'gpu_failed' })
    check(state().error === null, 'and a ready')
    emit({ sessionId: tSid, t: 'error', code: 'timeout' })
    D.stopDictation()
    emit({ sessionId: tSid, t: 'end' })
    check(state().phase === 'idle' && state().error === null, 'end clears a leftover timeout: the overlay closes by itself')
    D.dismissDictation()
    D.toggleDictationPane('p1')
    await flush()
    const fSid = state().sessionId
    emit({ sessionId: fSid, t: 'ready', engine: 'cpu' })
    emit({ sessionId: fSid, t: 'error', code: 'timeout' })
    emit({ sessionId: fSid, t: 'error', code: 'exit' })
    emit({ sessionId: fSid, t: 'end' })
    check(state().phase === 'idle' && state().error === 'exit', 'a fatal error before end stays')
    D.dismissDictation()

    // Field target (global prompt): at the caret, no Enter, the shortcut toggles it, no paneId.
    let field = 'Revisa '
    D.setDictationFieldToggler(() => void D.startDictation({ kind: 'field', owner: 'gp', insert: (t) => { field += t }, before: () => field }))
    snApi.dictation.start = async (req) => { calls.start.push(req); return { ok: true, sessionId: 'f1' } }
    D.runDictateShortcut()
    await flush()
    check(D.isDictating('field:gp') && !('paneId' in calls.start.at(-1)), 'with a field open, the shortcut toggles its mic (no console sent)')
    emit({ sessionId: 'f1', t: 'final', text: 'El archivo' })
    emit({ sessionId: 'f1', t: 'final', text: 'de config' })
    check(field === 'Revisa el archivo de config', 'field text joins with what is before the caret: ' + JSON.stringify(field))
    D.setDictationFieldToggler(null)
    D.releaseDictationScope('field:gp')
    check(state().phase !== 'listening' && calls.stop.includes('f1') && env.tracks.at(-1).stopped, 'closing the dialog stops its session and the mic')

    // No api (no preload): unsupported, no mic.
    D.__resetDictationForTests()
    check(state().phase === 'idle' && state().slow === false, 'reset')
  }

  console.log(`PASS: ${checks} dictation renderer checks (permissions, worklet, capture, store)`)
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
