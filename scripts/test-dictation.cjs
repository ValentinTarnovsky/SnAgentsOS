// Desktop dictation (app 2.5.0), main side, in node with esbuild + vm:
//  - the VC++ runtime check (registry parse, exit codes);
//  - whisper-server's argv and env, the multipart body, the HTTP client
//    against a local node:http server (token path, 503, timeout, size cap);
//  - WhisperServer with a fake spawn: GPU line rules, vcredist / gpu_failed /
//    exit / spawn classification, port retry, stderr never parsed after
//    health, onExit, stop; the orphan killer;
//  - DictationService with a fake server, a fake installer and fake timers:
//    event order, cleaning, audio guards, drain, idle unload, hyp only on GPU
//    with interim, GPU fallback, timeouts and crashes, warmup on its own
//    server, remove / install guards, the log never holding text or prompt.
// The real engine runs only with SNAOS_TEST_WHISPER_DIR set (a folder laid
// out like `<dataDir>/whisper` plus `audio/clip1-short.wav`, `clip2-code.wav`
// and `clip3-silence.wav`), on win32, and never on CI (CI=true).
// The permission table and the renderer store checks live in
// test-dictation-renderer.cjs.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const fs = require('node:fs')
const os = require('node:os')
const http = require('node:http')
const assert = require('node:assert/strict')
const path = require('node:path')
const { PassThrough } = require('node:stream')
const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, AbortController, TextDecoder, TextEncoder, ...overrides })
  return mod.exports
}
const flush = () => new Promise((r) => setImmediate(r))
const settle = async (n = 12) => { for (let i = 0; i < n; i++) await flush() }

// A virtual clock: setTimeout / setInterval run when advance() passes them.
function clock() {
  let now = 1_000_000
  let seq = 0
  const timers = new Map()
  const add = (fn, ms, every) => { const id = { id: ++seq }; timers.set(id, { fn, at: now + Math.max(0, Number(ms) || 0), every }); return id }
  const clr = (id) => { if (id) timers.delete(id) }
  async function advance(ms) {
    const end = now + ms
    for (;;) {
      let key = null, next = null
      for (const [k, t] of timers) if (t.at <= end && (!next || t.at < next.at)) { key = k; next = t }
      if (!next) break
      now = next.at
      if (next.every) next.at += next.every
      else timers.delete(key)
      next.fn()
      await settle(4)
    }
    now = end
    await settle()
  }
  return { setTimeout: (fn, ms) => add(fn, ms, 0), clearTimeout: clr, setInterval: (fn, ms) => add(fn, ms, Math.max(1, ms)), clearInterval: clr, now: () => now, advance, count: () => timers.size }
}

const SR = 16000
/** A voice-like 440 Hz tone whose level moves (3 Hz), so the steady-noise guard never takes it for a hum. */
function voice(ms) {
  const n = Math.round((SR * ms) / 1000)
  const a = new Int16Array(n)
  for (let i = 0; i < n; i++) a[i] = Math.round(32767 * (0.25 + 0.2 * Math.sin((2 * Math.PI * 3 * i) / SR)) * Math.sin((2 * Math.PI * 440 * i) / SR))
  return a
}
const quiet = (ms) => new Int16Array(Math.round((SR * ms) / 1000))
const CPU_ASSETS = ['runtime-cpu', 'model-small', 'vad']
const GPU_ASSETS = [...CPU_ASSETS, 'runtime-cuda', 'model-turbo']
const cfg = (dict = {}) => ({
  version: 18,
  settings: { language: 'es', dictation: { device: 'auto', language: 'auto', headerButton: true, interim: true, vocabulary: 'Zarlak, Quibble', ...dict } },
  workspaces: [{ id: 'w', name: 'MiProyecto', cwd: 'C:\\code\\otro', panes: [{ id: 'p1', cwd: 'C:\\code\\mi-repo' }, { id: 'p2' }] }],
})
const seg = (text, extra = {}) => ({ text, avgLogprob: -0.2, noSpeechProb: 0.01, meanP: 0.9, ...extra })
const types = (events) => events.map((e) => e.t + (e.code ? ':' + e.code : '') + (e.engine ? ':' + e.engine : '') + (e.fallback ? ':' + e.fallback : '')).join(',')

// A fake WhisperServer instance.
function fakeServer(o, idx) {
  return {
    idx, starts: [], infers: [], stops: 0, running: false, served: 0, exitCode: null, onExit: null, _spec: null,
    get spec() { return this.running ? this._spec : null },
    async start(spec) {
      this.starts.push(spec)
      const r = o.start ? await o.start(spec, this) : { ok: true }
      if (r.ok) { this.running = true; this._spec = spec }
      return r
    },
    infer(wav, p, t) {
      const call = { wav, p, t, srv: this }
      this.infers.push(call)
      return Promise.resolve((o.infer || (async () => [seg(' Hola mundo\r\n')]))(call)).then((segs) => { this.served++; return segs })
    },
    async stop() { this.stops++; this.running = false },
    crash(code) { this.running = false; this.exitCode = code; if (this.onExit) this.onExit(code) },
  }
}

function harness(o = {}) {
  const c = clock()
  const Svc = load('src/main/dictation/DictationService.ts', { setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, setInterval: c.setInterval, clearInterval: c.clearInterval })
  const logs = [], events = [], servers = [], calls = []
  const installed = new Set(o.installed || CPU_ASSETS)
  let n = 0
  const installer = {
    busy: false,
    installed: () => installed,
    status: () => ({ packs: [{ id: 'cpu', installed: true, downloadBytes: 1, diskBytes: 2 }], install: null, dataDir: 'x', warming: false }),
    install: async (p) => { calls.push('install:' + p); return o.installResult || { ok: true } },
    cancel: (p) => calls.push('cancel:' + p),
    remove: async (p, g) => {
      calls.push('remove:' + p)
      if (g.inUse()) return { ok: false, error: 'busy' }
      if (g.awaitExit) await g.awaitExit()
      return { ok: true }
    },
  }
  const spec = (plan) => ({
    device: plan.device,
    exe: `C:\\data\\whisper\\${plan.runtime}\\whisper-server.exe`,
    cwd: `C:\\data\\whisper\\${plan.runtime}`,
    model: `C:\\data\\whisper\\models\\${plan.model}.bin`,
    vadModel: 'C:\\data\\whisper\\models\\vad.bin',
    publicDir: 'C:\\data\\whisper\\public-empty',
    threads: 4,
    ...(plan.device === 'gpu' ? { cudaCache: 'C:\\data\\whisper\\cuda-cache' } : {}),
  })
  const svc = new Svc.DictationService({
    platform: o.platform || 'win32',
    arch: o.arch || 'x64',
    installer,
    createServer: () => { const s = fakeServer(o, servers.length); servers.push(s); return s },
    spec,
    nvidia: () => o.nvidia === true,
    vcRuntime: async () => o.vc !== false,
    whisperDir: 'C:\\data\\whisper',
    log: (l) => logs.push(l),
    newId: () => 'd' + ++n,
    now: c.now,
  })
  svc.setConfig(o.config || cfg(o.dict))
  const h = { c, svc, logs, events, servers, calls, installer, installed, Svc, send: (e) => events.push(e) }
  /** Streams samples as 100 ms chunks, the clock moving with them. */
  h.feed = async (id, samples, owner = 1) => {
    for (let at = 0; at < samples.length; at += 1600) {
      svc.audio(id, owner, samples.slice(at, at + 1600).buffer)
      await c.advance(100)
    }
  }
  h.phrase = async (id, ms = 1000, owner = 1) => { await h.feed(id, voice(ms), owner); await h.feed(id, quiet(1000), owner) }
  h.start = async (req = { lang: 'es-AR', paneId: 'p1' }, owner = 1, send = h.send) => { const r = await svc.start(owner, send, req); await settle(); return r }
  return h
}

async function main() {
  // --- VC++ runtime ----------------------------------------------------------------
  {
    const V = load('src/main/dictation/whisper/vcRuntime.ts')
    const reg = (major, minor, installed = 1) => `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64\r\n    Version    REG_SZ    v14.51.36247.00\r\n    Installed    REG_DWORD    0x${installed.toString(16)}\r\n    Major    REG_DWORD    0x${major.toString(16)}\r\n    Minor    REG_DWORD    0x${minor.toString(16)}\r\n    Bld    REG_DWORD    0x8d97\r\n`
    check(JSON.stringify(V.parseVcRuntimeReg(reg(14, 51))) === '{"installed":true,"major":14,"minor":51}', 'reg.exe output parsed (Installed, Major, Minor in hex)')
    check(V.vcRuntimeOk(V.parseVcRuntimeReg(reg(14, 40))) && V.vcRuntimeOk(V.parseVcRuntimeReg(reg(15, 0))), '14.40 and later pass')
    check(!V.vcRuntimeOk(V.parseVcRuntimeReg(reg(14, 39))) && !V.vcRuntimeOk(V.parseVcRuntimeReg(reg(14, 44, 0))), '14.39, or not installed, fails (the msvcp140 mutex crash)')
    check(V.parseVcRuntimeReg('') === null && V.parseVcRuntimeReg('ERROR: The system was unable to find') === null && !V.vcRuntimeOk(null), 'a missing key is not a runtime')
    check(V.isVcRuntimeExit(3221225781, true) && V.isVcRuntimeExit(-1073741515, true), '0xC0000135 (DLL not found), unsigned or signed, is vcredist')
    check(V.isVcRuntimeExit(3221225477, false) && V.isVcRuntimeExit(-1073741819, false) && !V.isVcRuntimeExit(3221225477, true), '0xC0000005 only before the first answer')
    check(!V.isVcRuntimeExit(1, false) && !V.isVcRuntimeExit(null, false) && !V.isVcRuntimeExit(undefined, false), 'other exits are not')
    check(/\\System32\\reg\.exe$/i.test(V.regExePath({ SystemRoot: 'C:\\Windows' })) && V.VC_REDIST_URL === 'https://aka.ms/vs/17/release/vc_redist.x64.exe', 'reg.exe by absolute path; the fixed vc_redist URL')
    const asked = []
    let answer = { [V.VC_REG_KEYS[0]]: null, [V.VC_REG_KEYS[1]]: reg(14, 42) }
    const chk = V.createVcRuntimeCheck(async (k) => { asked.push(k); return answer[k] })
    check((await chk()) === true && asked.length === 2, 'the WOW6432Node copy counts when the native key is missing')
    check((await chk()) === true && asked.length === 2, 'a positive answer is cached')
    const asked2 = []
    const chk2 = V.createVcRuntimeCheck(async (k) => { asked2.push(k); return reg(14, 30) })
    check((await chk2()) === false && (await chk2()) === false && asked2.length === 4, 'a negative answer is asked again (installed from the overlay meanwhile)')
    if (process.platform === 'win32') {
      const out = await V.regQuery()(V.VC_REG_KEYS[0])
      check(out === null || typeof out === 'string', 'real reg.exe query answers text or null')
    }
  }

  // --- Server argv, env, multipart ---------------------------------------------------
  const W = load('src/main/dictation/whisper/WhisperServer.ts')
  const C = load('src/main/dictation/whisper/serverClient.ts')
  const tok = 'a1'.repeat(16)
  const cpuSpec = { device: 'cpu', exe: 'C:\\d\\whisper\\runtime\\cpu-b5454\\whisper-server.exe', cwd: 'C:\\d\\whisper\\runtime\\cpu-b5454', model: 'C:\\d\\whisper\\models\\ggml-small-q5_1.bin', vadModel: 'C:\\d\\whisper\\models\\ggml-silero-v5.1.2.bin', publicDir: 'C:\\d\\whisper\\public-empty', threads: 6 }
  const gpuSpec = { ...cpuSpec, device: 'gpu', exe: 'C:\\d\\whisper\\runtime\\cuda124-b5454\\whisper-server.exe', cwd: 'C:\\d\\whisper\\runtime\\cuda124-b5454', model: 'C:\\d\\whisper\\models\\ggml-large-v3-turbo-q8_0.bin', threads: 4, cudaCache: 'C:\\d\\whisper\\cuda-cache' }
  {
    const a = W.serverArgs(cpuSpec, 41234, tok)
    const at = (flag) => a[a.indexOf(flag) + 1]
    check(at('--host') === '127.0.0.1' && at('--port') === '41234', 'binds 127.0.0.1 on the given port')
    check(/^\/[0-9a-f]{32}$/.test(at('--request-path')) && at('--request-path') === '/' + tok, '--request-path /<32 hex>')
    check(at('--public') === cpuSpec.publicDir && at('-l') === 'auto' && a.includes('-nt') && at('-t') === '6' && at('--vad-model') === cpuSpec.vadModel && at('-m') === cpuSpec.model, '--public <empty dir>, -l auto, -nt, threads, the VAD and the model')
    check(a.includes('-ng') && !W.serverArgs(gpuSpec, 1, tok).includes('-ng'), '-ng only on cpu')
    check(!a.some((x) => /prompt|package\.json|Zarlak|vocab/i.test(x)) && !a.includes('--prompt'), 'no prompt, vocabulary or user text on the command line')
    check(/^[0-9a-f]{32}$/.test(W.newServerToken()) && W.newServerToken() !== W.newServerToken(), 'the token is 128-bit random hex')
    const env = W.serverEnv({ SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', TEMP: 'C:\\t', TMP: 'C:\\t', PATH: 'C:\\Users\\me\\evil;C:\\bin', ANTHROPIC_API_KEY: 'sk', CLAUDE_CONFIG_DIR: 'x', USERPROFILE: 'C:\\Users\\me', APPDATA: 'y', NUMBER_OF_PROCESSORS: '16' })
    check(env.PATH === 'C:\\Windows\\System32;C:\\Windows' && env.TEMP === 'C:\\t' && env.NUMBER_OF_PROCESSORS === '16', 'PATH is System32 + Windows only (no DLL planting through the user PATH)')
    check(!('ANTHROPIC_API_KEY' in env) && !('CLAUDE_CONFIG_DIR' in env) && !('USERPROFILE' in env) && !('APPDATA' in env) && !('CUDA_CACHE_PATH' in env), 'nothing else is inherited; no CUDA cache on cpu')
    const genv = W.serverEnv({ SystemRoot: 'C:\\Windows' }, gpuSpec.cudaCache)
    check(genv.CUDA_CACHE_PATH === gpuSpec.cudaCache && genv.CUDA_CACHE_MAXSIZE === '1073741824', 'GPU: CUDA_CACHE_PATH under whisper/ and a 1 GB cache')
    check(W.requestTimeoutMs('gpu', 0) === 120000 && W.requestTimeoutMs('gpu', 1) === 15000 && W.requestTimeoutMs('cpu', 0) === 30000, 'request timeouts: the first GPU one pays the JIT')
    check(W.sameSpec(cpuSpec, { ...cpuSpec }) && !W.sameSpec(cpuSpec, gpuSpec) && !W.sameSpec(cpuSpec, { ...cpuSpec, threads: 2 }) && !W.sameSpec(null, cpuSpec), 'sameSpec')

    const wav = Buffer.from([82, 73, 70, 70, 0, 1, 2, 3, 13, 10, 45, 45])
    const body = C.multipartBody(wav, { lang: 'es', prompt: 'Dictado\r\npara package.json', vad: true, beamSize: 5 }, 'BOUND')
    const txt = body.toString('latin1')
    const fieldOf = (name) => { const m = new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`).exec(body.toString('utf8')); return m ? m[1] : null }
    check(body.indexOf(wav) > 0 && /name="file"; filename="audio\.wav"\r\nContent-Type: audio\/wav\r\n\r\n/.test(txt), 'the WAV goes as file, bytes untouched')
    check(fieldOf('response_format') === 'verbose_json' && fieldOf('language') === 'es' && fieldOf('temperature') === '0' && fieldOf('vad') === 'true' && fieldOf('suppress_nst') === 'true', 'verbose_json, language, temperature 0, vad, suppress_nst on every request')
    check(fieldOf('prompt') === 'Dictado para package.json' && fieldOf('beam_size') === '5' && fieldOf('audio_ctx') === null, 'prompt on one line; beam size set; no audio_ctx unless set')
    check(txt.endsWith('--BOUND--\r\n'), 'closing boundary')
    const plain = C.multipartBody(wav, { lang: 'auto', prompt: '', vad: false, audioCtx: 512 }, 'B2').toString('utf8')
    check(!/name="prompt"/.test(plain) && !/name="beam_size"/.test(plain) && /name="audio_ctx"\r\n\r\n512\r\n/.test(plain) && /name="vad"\r\n\r\nfalse\r\n/.test(plain), 'an empty prompt is not sent; greedy has no beam_size; audio_ctx when set')
  }

  // --- HTTP client against a local server ---------------------------------------------
  {
    const seen = []
    const server = http.createServer((req, res) => {
      seen.push({ url: req.url, method: req.method, ct: req.headers['content-type'] })
      if (req.url === `/${tok}/health`) { res.writeHead(200); res.end('{"status":"ok"}'); return }
      if (req.url === '/loading/health') { res.writeHead(503); res.end('{"status":"loading model"}'); return }
      if (req.url === `/${tok}/inference`) {
        let n = 0
        req.on('data', (d) => { n += d.length })
        req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ text: 'ok', got: n })) })
        return
      }
      if (req.url === '/slow/inference') { req.resume(); return }
      if (req.url === '/big/inference') { req.resume(); res.writeHead(200); res.end(Buffer.alloc(1100 * 1024, 32)); return }
      if (req.url === '/err/inference') { req.resume(); res.writeHead(500); res.end('x'); return }
      res.writeHead(404); res.end()
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const port = server.address().port
    check((await C.getHealth(port, tok, 2000)) === true && (await C.getHealth(port, 'loading', 2000)) === false && (await C.getHealth(port, 'nope', 2000)) === false, 'health: 200 under the token only; 503 while loading')
    const b = C.multipartBody(Buffer.alloc(100), { lang: 'es', prompt: '', vad: true }, 'XYZ')
    const out = JSON.parse(await C.postInference(port, tok, b, 'XYZ', 5000))
    const last = seen[seen.length - 1]
    check(out.got === b.length && last.method === 'POST' && last.url === `/${tok}/inference` && last.ct === 'multipart/form-data; boundary=XYZ', 'POST /<token>/inference with the multipart body')
    const code = (p) => p.then(() => 'ok', (e) => e.code)
    check((await code(C.postInference(port, 'slow', b, 'XYZ', 200))) === 'timeout', 'no answer in time: timeout')
    check((await code(C.postInference(port, 'big', b, 'XYZ', 5000))) === 'size', 'an answer over 1 MB: size')
    check((await code(C.postInference(port, 'err', b, 'XYZ', 5000))) === 'http', 'not 200: http')
    const dead = await W.freeLocalPort()
    check(dead > 0 && (await code(C.postInference(dead, tok, b, 'XYZ', 2000))) === 'exit' && (await C.getHealth(dead, tok, 2000)) === false, 'connection refused: exit; health false')
    server.close()
  }

  // --- WhisperServer with a fake spawn ------------------------------------------------
  {
    function fakeProc(pid) {
      const ev = new EventEmitter()
      return {
        pid, stderr: new PassThrough(), killed: 0, exited: false,
        kill() { this.killed++; setImmediate(() => this.exit(1)); return true },
        on(n, cb) { ev.on(n, cb); return this },
        exit(code) { if (this.exited) return; this.exited = true; ev.emit('exit', code) },
        error() { ev.emit('error', new Error('ENOENT')) },
        say(line) { this.stderr.write(line + '\n') },
      }
    }
    const verbose = JSON.stringify({ text: ' Hola', segments: [{ id: 0, text: ' Hola', avg_logprob: -0.1, no_speech_prob: 0.01, words: [{ word: ' Hola', probability: 0.9 }] }] })
    const sh = (o = {}) => {
      let t = 0
      const ports = [41001, 41002, 41003]
      const h = { spawned: [], pids: [], logs: [], health: [], posts: [], exits: [], probes: [], owners: [] }
      h.srv = new W.WhisperServer({
        spawn: (exe, args, opts) => {
          const p = fakeProc(5000 + h.spawned.length)
          h.spawned.push({ exe, args, opts, p })
          if (o.spawnThrows) throw new Error('EACCES')
          if (o.onSpawn) o.onSpawn(p, h.spawned.length)
          return p
        },
        freePort: async () => ports.shift(),
        token: () => tok,
        log: (l) => h.logs.push(l),
        writePid: (pid) => h.pids.push(pid),
        env: () => ({ SystemRoot: 'C:\\Windows', PATH: 'C:\\evil', ANTHROPIC_API_KEY: 'sk' }),
        health: async (port, token) => { h.health.push([port, token]); return o.healthy ? o.healthy(h.spawned.length, h) : true },
        listening: async (port) => { h.probes.push(port); return o.listening ? o.listening(h.probes.length, h) : true },
        portOwners: async (port) => { h.owners.push(port); return o.owners ? o.owners(h.spawned.length, h) : [h.spawned.at(-1).p.pid] },
        post: async (port, token, body, boundary, ms) => { h.posts.push({ port, token, ms, boundary, body }); if (o.post) return o.post(h); return verbose },
        now: () => t,
        sleep: async (ms) => { t += ms; await flush() },
      })
      h.srv.onExit = (code) => h.exits.push(code)
      return h
    }
    {
      const h = sh()
      const r = await h.srv.start(cpuSpec)
      const sp = h.spawned[0]
      check(r.ok && h.srv.running && h.srv.spec === cpuSpec, 'cpu: healthy start')
      check(sp.exe === cpuSpec.exe && sp.opts.cwd === cpuSpec.cwd && sp.opts.windowsHide === true && JSON.stringify(sp.opts.stdio) === '["ignore","ignore","pipe"]', 'spawned by absolute path, cwd = runtime folder, hidden, only stderr piped')
      check(sp.opts.env.PATH === 'C:\\Windows\\System32;C:\\Windows' && !('ANTHROPIC_API_KEY' in sp.opts.env), 'whitelisted env')
      check(h.health[0][0] === 41001 && h.health[0][1] === tok && h.pids[0] === 5000, 'health on the port and token; the pid recorded (server.json)')
      check(h.logs.every((l) => !l.includes(tok) && !l.includes('C:\\')), 'the token and paths are never logged: ' + JSON.stringify(h.logs))
      const again = await h.srv.start({ ...cpuSpec })
      check(again.ok && h.spawned.length === 1, 'the same spec reuses the running server')
      const segs = await h.srv.infer(Buffer.alloc(10), { lang: 'es', prompt: 'p', vad: true })
      check(segs.length === 1 && segs[0].text === ' Hola' && h.posts[0].port === 41001 && h.posts[0].token === tok && h.posts[0].ms === 30000 && h.srv.served === 1, 'infer posts to the server and parses verbose_json (cpu timeout 30 s)')
      sp.p.say('whisper_backend_init_gpu: no GPU found')
      await settle()
      check(h.srv.running, 'stderr is not parsed once healthy')
      sp.p.exit(3221225477)
      await settle()
      check(!h.srv.running && JSON.stringify(h.exits) === '[3221225477]' && h.srv.exitCode === 3221225477 && h.pids.at(-1) === null, 'a crash after start: onExit with the code, pid cleared')
    }
    {
      const h = sh()
      await h.srv.start(cpuSpec)
      const sp = h.spawned[0]
      await h.srv.stop()
      check(sp.p.killed === 1 && sp.p.exited && !h.srv.running && h.exits.length === 0 && h.pids.at(-1) === null, 'stop kills, waits for the exit, clears the pid, and is not reported as a crash')
    }
    {
      const h = sh({ onSpawn: (p) => p.say('whisper_backend_init_gpu: using CUDA0 backend') })
      const r = await h.srv.start(gpuSpec)
      check(r.ok && h.spawned[0].opts.env.CUDA_CACHE_PATH === gpuSpec.cudaCache, 'gpu: ok with "using CUDA0 backend"')
      await h.srv.infer(Buffer.alloc(10), { lang: 'es', prompt: '', vad: true })
      await h.srv.infer(Buffer.alloc(10), { lang: 'es', prompt: '', vad: true })
      check(h.posts[0].ms === 120000 && h.posts[1].ms === 15000, 'gpu: the first request may take the JIT (120 s), then 15 s')
    }
    {
      const h = sh({ onSpawn: (p) => p.say('whisper_backend_init_gpu: no GPU found'), healthy: () => false })
      const r = await h.srv.start(gpuSpec)
      check(!r.ok && r.error === 'gpu_failed' && h.spawned[0].p.killed === 1 && !h.srv.running, 'gpu: "no GPU found" is gpu_failed, the process killed')
    }
    {
      const h = sh()
      const r = await h.srv.start(gpuSpec)
      check(!r.ok && r.error === 'gpu_failed' && h.spawned[0].p.killed === 1, 'gpu: health without the CUDA line is gpu_failed')
    }
    for (const [label, spec, exit, want] of [
      ['cpu exit 0xC0000135', cpuSpec, 3221225781, 'vcredist'],
      ['gpu exit 0xC0000135', gpuSpec, -1073741515, 'vcredist'],
      ['cpu exit 0xC0000005 before health', cpuSpec, 3221225477, 'vcredist'],
      ['cpu other exit', cpuSpec, 1, 'exit'],
      ['gpu other exit (VRAM, driver)', gpuSpec, 3, 'gpu_failed'],
    ]) {
      const h = sh({ onSpawn: (p) => setImmediate(() => p.exit(exit)), healthy: () => false })
      const r = await h.srv.start(spec)
      check(!r.ok && r.error === want && h.exits.length === 0, `${label}: ${want}`)
    }
    {
      const h = sh({ spawnThrows: true })
      check((await h.srv.start(cpuSpec)).error === 'spawn' && (await sh({ spawnThrows: true }).srv.start(gpuSpec)).error === 'gpu_failed', 'spawn throwing: spawn on cpu, gpu_failed on gpu')
      const h2 = sh({ onSpawn: (p) => setImmediate(() => p.error()), healthy: () => false })
      check((await h2.srv.start(cpuSpec)).error === 'spawn', 'a spawn error event (ENOENT): spawn')
    }
    {
      const h = sh({ onSpawn: (p, n) => { if (n === 1) p.say("couldn't bind to server socket: hostname=127.0.0.1 port=41001") }, healthy: (n) => n === 2 })
      const r = await h.srv.start(cpuSpec)
      check(r.ok && h.spawned.length === 2 && h.spawned[0].p.killed === 1 && h.spawned[1].args.includes('41002'), 'a port race (bind failure) retries once on a new port')
    }
    {
      // The token goes out only to the child's own listener.
      const h = sh({ listening: (n) => n >= 4 })
      const r = await h.srv.start(cpuSpec)
      check(r.ok && h.probes.length === 4 && h.owners.length === 1 && h.health.length === 1, 'bare connects until the port is accepted, one owner check, then the tokened health')
      const taken = sh({ owners: (n, hh) => (n === 1 ? [999] : [hh.spawned.at(-1).p.pid]) })
      const r2 = await taken.srv.start(cpuSpec)
      check(r2.ok && taken.spawned.length === 2 && taken.spawned[0].p.killed === 1 && taken.health.every(([port]) => port === 41002) && taken.spawned[1].args.includes('41002'), 'another pid on the port: the token is never sent there, the child is killed, retry on a new port')
      check(taken.logs.includes('server port taken'), 'logged as a taken port')
      const both = sh({ owners: (n, hh) => [hh.spawned.at(-1).p.pid, 4242] })
      const r3 = await both.srv.start(gpuSpec)
      check(!r3.ok && r3.error === 'gpu_failed' && both.health.length === 0 && both.spawned.length === 2, 'a second listener next to the child is refused too (gpu: gpu_failed after the retry)')
      const blind = sh({ owners: () => null })
      const r4 = await blind.srv.start(cpuSpec)
      check(!r4.ok && r4.error === 'exit' && blind.health.length === 0 && blind.spawned[0].p.killed === 1, 'an unreadable TCP table: no tokened request, exit')
      const late = sh({ owners: (n, hh) => (hh.owners.length < 3 ? [] : [hh.spawned.at(-1).p.pid]) })
      check((await late.srv.start(cpuSpec)).ok && late.owners.length === 3 && late.health.length === 1, 'an accepted connect with no listener in the table yet: asked again')
      const net = [
        'Conexiones activas',
        '',
        '  Proto  Direccion local          Direccion remota        Estado           PID',
        '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1796',
        '  TCP    127.0.0.1:41001        0.0.0.0:0              ESCUCHANDO      5000',
        '  TCP    127.0.0.1:41001        127.0.0.1:52000        ESTABLISHED     5000',
        '  TCP    127.0.0.1:52000        127.0.0.1:41001        ESTABLISHED     77',
        '  TCP    127.0.0.1:41002        0.0.0.0:0              LISTENING       6000',
        '  TCP    [::]:41003             [::]:0                 LISTENING       8000',
        '  TCP    0.0.0.0:41003          0.0.0.0:0              LISTENING       8001',
        '  UDP    127.0.0.1:41001        *:*                                    9000',
      ].join('\r\n')
      check(JSON.stringify(W.parseListenerPids(net, 41001)) === '[5000]' && JSON.stringify(W.parseListenerPids(net, 41003)) === '[8000,8001]' && W.parseListenerPids(net, 1).length === 0 && W.parseListenerPids('', 41001).length === 0, 'netstat: the listeners by remote 0.0.0.0:0 or [::]:0 (any state language), 127.0.0.1, 0.0.0.0 and [::]; connections and UDP ignored')
      if (process.platform === 'win32') {
        const probe = require('node:net').createServer().listen(0, '127.0.0.1')
        await new Promise((r) => probe.once('listening', r))
        const port = probe.address().port
        check((await W.tcpListening(port, 2000)) === true, 'real bare connect: accepted')
        const pids = await W.listenerPids(port)
        check(Array.isArray(pids) && pids.includes(process.pid), 'real netstat.exe: our own listener is owned by our pid ' + JSON.stringify(pids))
        await new Promise((r) => probe.close(r))
      }
    }
    {
      const h = sh({ healthy: () => false })
      const r = await h.srv.start(cpuSpec)
      check(!r.ok && r.error === 'exit' && h.spawned[0].p.killed === 1, 'no health within 30 s: killed, exit (cpu)')
      check((await sh({ healthy: () => false }).srv.start(gpuSpec)).error === 'gpu_failed', 'no health within 30 s on gpu: gpu_failed')
    }
    {
      const h = sh({ post: () => { const e = new Error('timeout'); e.code = 'timeout'; throw e } })
      await h.srv.start(cpuSpec)
      const r = await h.srv.infer(Buffer.alloc(4), { lang: 'es', prompt: '', vad: true }).then(() => 'ok', (e) => e.code)
      check(r === 'timeout' && h.srv.served === 0, 'a request timeout throws timeout')
      const h2 = sh({ post: () => 'not json' })
      await h2.srv.start(cpuSpec)
      check((await h2.srv.infer(Buffer.alloc(4), { lang: 'es', prompt: '', vad: true }).then(() => 'ok', (e) => e.code)) === 'internal', 'a body that is not verbose_json: internal')
      const h3 = sh()
      check((await h3.srv.infer(Buffer.alloc(4), { lang: 'es', prompt: '', vad: true }).then(() => 'ok', (e) => e.code)) === 'exit', 'infer with no server: exit')
    }

    // Orphans.
    const dir = 'C:\\Users\\me\\AppData\\Roaming\\snagentsos\\whisper'
    check(W.isOurServerExe(dir + '\\runtime\\cpu-b5454\\whisper-server.exe', dir) && W.isOurServerExe((dir + '\\runtime\\cuda124-b5454\\WHISPER-SERVER.EXE').toUpperCase(), dir), 'our server: whisper-server.exe under the whisper folder (case-insensitive)')
    check(!W.isOurServerExe(dir + '2\\runtime\\whisper-server.exe', dir) && !W.isOurServerExe('C:\\other\\whisper-server.exe', dir) && !W.isOurServerExe(dir + '\\runtime\\cpu-b5454\\other.exe', dir) && !W.isOurServerExe(null, dir), 'another profile, another folder or another image is not')
    check(JSON.stringify(W.orphanPids('{"servers":[{"pid":12},{"pid":"x"},{"pid":-1},{"pid":34}]}')) === '[12,34]' && JSON.stringify(W.orphanPids('{"pid":7}')) === '[7]' && W.orphanPids('junk').length === 0 && W.orphanPids(null).length === 0, 'server.json pids (list or single), junk ignored')
    const killed = [], removed = []
    const paths = { 12: dir + '\\runtime\\cpu-b5454\\whisper-server.exe', 34: 'C:\\Windows\\System32\\notepad.exe', 56: 'D:\\other-profile\\whisper\\runtime\\cpu-b5454\\whisper-server.exe' }
    const n = await W.killOrphan(dir, {
      readText: () => '{"servers":[{"pid":12},{"pid":34},{"pid":56},{"pid":78}]}',
      processPath: async (pid) => paths[pid] || null,
      kill: (pid) => killed.push(pid),
      remove: (f) => removed.push(f),
    })
    check(n === 1 && JSON.stringify(killed) === '[12]' && removed[0] === dir + '\\server.json', 'killOrphan kills only a whisper-server.exe under this folder (a reused pid or another profile is left alone), then drops server.json')
  }

  // --- Pure service helpers ------------------------------------------------------------
  const S = load('src/main/dictation/DictationService.ts')
  {
    check(JSON.stringify(S.normalizeStart({ lang: 'es-AR', paneId: 'p1' })) === '{"lang":"es-AR","paneId":"p1"}', 'a valid request is kept')
    check(JSON.stringify(S.normalizeStart({ lang: 'es-AR"; calc', paneId: 3, engine: 'cloud' })) === '{"lang":"","paneId":null}' && JSON.stringify(S.normalizeStart(null)) === '{"lang":"","paneId":null}', 'a bad tag is empty (Whisper detects), a bad pane id null, unknown keys ignored')
    check(S.normalizeStart({ lang: 'auto' }).lang === '' && S.normalizeStart({ paneId: 'x'.repeat(200) }).paneId === null, "'auto' and an over-long pane id")
    check(JSON.stringify(S.paneContextOf(cfg(), 'p1')) === '{"workspace":"MiProyecto","folder":"mi-repo"}' && JSON.stringify(S.paneContextOf(cfg(), 'p2')) === '{"workspace":"MiProyecto","folder":"otro"}', 'prompt context from main\'s config: workspace name and the console folder (pane cwd, else the workspace\'s)')
    check(JSON.stringify(S.paneContextOf(cfg(), 'zz')) === '{}' && JSON.stringify(S.paneContextOf(null, 'p1')) === '{}' && JSON.stringify(S.paneContextOf({ workspaces: 'x' }, 'p1')) === '{}', 'an unknown pane or a broken config gives nothing')
    check(JSON.stringify(S.normalizeDictationSettings({ device: 'tpu', interim: 'yes', vocabulary: 'v'.repeat(500), language: 'es' })) === JSON.stringify({ device: 'auto', language: 'es', headerButton: true, interim: true, vocabulary: 'v'.repeat(400) }), 'settings from the renderer are checked field by field')
    check(S.cleanText('hola\r\nmundo\u001b[31m\u0007  ya') === 'hola mundo [31m ya' && S.cleanText('a\u2028b\u0085c') === 'a b c' && S.cleanText('x'.repeat(5000)).length === 2000, 'cleanText: no CR, LF, ESC, BEL, separators or C1; capped')
    const ab = new ArrayBuffer(3200)
    check(S.pcmChunk(ab).length === 1600 && S.pcmChunk(new Uint8Array(4)).length === 2 && S.pcmChunk(Buffer.alloc(6)).length === 3, 'an ArrayBuffer, a typed array or a Buffer is a chunk')
    check(S.pcmChunk(new ArrayBuffer(3)) === null && S.pcmChunk(new ArrayBuffer(0)) === null && S.pcmChunk(new ArrayBuffer(32002)) === null && S.pcmChunk('abcd') === null && S.pcmChunk({ byteLength: 4 }) === null && S.pcmChunk(null) === null, 'odd, empty, over 32000 bytes or not bytes: dropped')
    const odd = Buffer.alloc(9).subarray(1)
    check(S.pcmChunk(odd).length === 4, 'a view at an odd offset is copied, never misaligned')
    check(S.hasNvidiaGpu({ gpuDevice: [{ vendorId: 0x8086 }, { vendorId: 0x10de }] }) && !S.hasNvidiaGpu({ gpuDevice: [{ vendorId: 0x1002 }] }) && !S.hasNvidiaGpu(null) && !S.hasNvidiaGpu({}), 'NVIDIA from getGPUInfo (vendor 0x10de)')
    check(S.engineThreads('cpu', 16) === 8 && S.engineThreads('cpu', 2) === 2 && S.engineThreads('cpu', 24) === 8 && S.engineThreads('gpu', 16) === 4, 'threads: physical cores 2 to 8 on cpu, 4 on gpu')
    check(S.dictationSettingsUri('microphone') === 'ms-settings:privacy-microphone' && S.dictationSettingsUri('vcredist') === 'https://aka.ms/vs/17/release/vc_redist.x64.exe', 'openSettings: the mic privacy page and the fixed vc_redist URL')
    check(['speech', 'ms-settings:privacy-speech', 'https://x', '', null, {}].every((v) => S.dictationSettingsUri(v) === null), 'and nothing else, a URL included')
    const w = S.warmupNoise()
    check(w.length === 16000 && Math.max(...w) <= 64 && Math.min(...w) >= -64 && S.warmupNoise()[100] === w[100], 'warmup noise: 1 s, quiet, deterministic')
  }

  // --- DictationService: start answers --------------------------------------------------
  {
    for (const [label, o, want] of [
      ['off Windows', { platform: 'linux' }, 'unsupported'],
      ['Windows on ARM64', { arch: 'arm64' }, 'unsupported'],
      ['no VC++ runtime', { vc: false }, 'vcredist'],
      ['nothing installed', { installed: [] }, 'model_missing'],
      ['device gpu without the GPU pack', { dict: { device: 'gpu' } }, 'model_missing'],
    ]) {
      const h = harness(o)
      const r = await h.start()
      check(!r.ok && r.error === want && h.servers.length === 0 && h.svc.activeId === null, `${label}: ${want}, no server`)
    }
    const h = harness({ platform: 'linux' })
    const st = await h.svc.status()
    check(st.supported === false && st.vcRuntime === false && (await h.svc.install('cpu')).error === 'unsupported' && (await h.svc.remove('cpu')).error === 'unsupported', 'off Windows: status unsupported, install and remove refused')
  }

  // --- DictationService: a CPU session end to end ----------------------------------------
  {
    const h = harness()
    const r = await h.start()
    check(r.ok && r.sessionId === 'd1' && h.svc.activeId === 'd1', 'start answers the session id')
    check(h.servers.length === 1 && h.servers[0].starts[0].device === 'cpu' && h.servers[0].starts[0].model.endsWith('model-small.bin'), 'auto without NVIDIA: the CPU pack')
    check(types(h.events) === 'ready:cpu' && h.events[0].lang === 'es-AR' && !h.events[0].fallback, 'ready names the device and echoes the language')
    await h.phrase('d1')
    const call = h.servers[0].infers[0]
    check(h.servers[0].infers.length === 1 && types(h.events) === 'ready:cpu,final', 'one phrase, one request, one final: ' + types(h.events))
    check(h.events[1].text === 'Hola mundo' && h.events[1].sessionId === 'd1', 'final text cleaned (no CR or LF)')
    check(call.p.vad === true && call.p.lang === 'es' && call.p.audioCtx === 512 && call.p.beamSize === undefined, 'cpu final: vad on, Whisper language, audio_ctx 512 for a short phrase, greedy')
    check(/package\.json/.test(call.p.prompt) && /MiProyecto/.test(call.p.prompt) && /mi-repo/.test(call.p.prompt) && /Zarlak/.test(call.p.prompt) && /^Dictado/.test(call.p.prompt), 'prompt: Spanish base, workspace, console folder and vocabulary')
    check(call.wav.toString('ascii', 0, 4) === 'RIFF' && call.wav.length > 44 + 32000, 'the phrase goes as a WAV (with its pre-roll)')
    // Audio guards.
    const before = h.servers[0].infers.length
    for (const [sid, owner, buf] of [['d1', 2, new ArrayBuffer(3200)], ['other', 1, new ArrayBuffer(3200)], ['d1', 1, new ArrayBuffer(3201)], ['d1', 1, new ArrayBuffer(32002)], ['d1', 1, 'pcm']]) h.svc.audio(sid, owner, buf)
    await h.c.advance(100)
    check(h.servers[0].infers.length === before, 'audio from another owner or session, odd, oversized or not bytes is dropped')
    // Faster than real time.
    const burst = voice(9000)
    for (let at = 0; at < burst.length; at += 16000) h.svc.audio('d1', 1, burst.slice(at, at + 16000).buffer)
    check(h.logs.includes('audio dropped rate'), 'audio faster than real time (past 5 s of slack) is dropped')
    await h.feed('d1', quiet(1500))
    h.svc.stop('d1', 2)
    check(h.svc.activeId === 'd1', 'another webContents cannot stop the session')
    h.svc.stop('d1', 1)
    await settle()
    check(h.events.at(-1).t === 'end' && h.events.filter((e) => e.t === 'end').length === 1 && h.svc.activeId === null, 'stop with nothing queued: end, once, last')
    h.svc.audio('d1', 1, new ArrayBuffer(3200))
    h.svc.stop('d1', 1)
    await settle()
    check(h.events.filter((e) => e.t === 'end').length === 1, 'nothing after end')
    const text = h.logs.join('\n')
    check(!/Hola|MiProyecto|mi-repo|Zarlak|package\.json|Dictado|C:\\/.test(text), 'the log never holds dictated text, the prompt or a path: ' + JSON.stringify(h.logs))
    check(h.logs.some((l) => /^final ms=\d+ req=\d+ drop=-$/.test(l)) && h.logs.includes('start device=cpu lang=es') && h.logs.includes('end'), 'the log keeps codes and sizes')
    // Idle unload, and reuse before it.
    const r2 = await h.start()
    check(r2.ok && h.servers.length === 1 && h.servers[0].starts.length === 1 && types(h.events.slice(-1)) === 'ready:cpu', 'the next session reuses the warm server')
    h.svc.stop(r2.sessionId, 1)
    await settle()
    check((await h.svc.status()).loaded.device === 'cpu', 'status: loaded while warm')
    await h.c.advance(5 * 60_000 - 1000)
    check(h.servers[0].stops === 0, 'still loaded before IDLE_UNLOAD_MS')
    await h.c.advance(2000)
    check(h.servers[0].stops === 1 && (await h.svc.status()).loaded === null && h.logs.includes('idle unload'), 'IDLE_UNLOAD_MS after the last end the server is unloaded')
    const st = await h.svc.status()
    check(st.supported && st.vcRuntime && st.nvidia === false && st.dataDir === 'C:\\data\\whisper' && st.packs.length === 1 && st.install === null && st.warming === false, 'status: supported, runtime, packs, data folder')
  }

  // --- Drain, STOP_DRAIN_MS, replacement --------------------------------------------------
  {
    const pending = []
    const h = harness({ infer: () => new Promise((res, rej) => pending.push({ res, rej })) })
    await h.start()
    await h.phrase('d1')
    await h.feed('d1', voice(600))
    h.svc.stop('d1', 1)
    await settle()
    check(pending.length === 1 && h.events.at(-1).t === 'ready', 'stop with a request in flight and one queued: no end yet')
    pending[0].res([seg(' uno')])
    await settle()
    check(pending.length === 2 && types(h.events) === 'ready:cpu,final', 'the first result arrives, the queued phrase goes next')
    pending[1].res([seg(' dos')])
    await settle()
    check(types(h.events) === 'ready:cpu,final,final,end' && h.events[2].text === 'dos', 'stop drains the queue, then end')

    const h2 = harness({ infer: () => new Promise(() => {}) })
    await h2.start()
    await h2.phrase('d1')
    h2.svc.stop('d1', 1)
    await h2.c.advance(19_000)
    check(h2.events.at(-1).t === 'ready', 'draining')
    await h2.c.advance(1500)
    check(types(h2.events) === 'ready:cpu,end' && h2.logs.includes('drain timeout'), 'STOP_DRAIN_MS forces end')

    const p3 = []
    const h3 = harness({ infer: () => new Promise((res) => p3.push(res)) })
    const first = []
    await h3.start({ lang: 'es' }, 1, (e) => first.push(e))
    await h3.phrase('d1')
    h3.svc.stop('d1', 1)
    const r = await h3.start({ lang: 'es' }, 1)
    check(r.ok && first.filter((e) => e.t === 'end').length === 1 && first.at(-1).t === 'end', 'a start that replaces a draining session sends its end exactly once')
    check(h3.servers.length === 1 && h3.servers[0].stops === 0 && types(h3.events) === 'ready:cpu', 'and keeps the shared server')
    p3[0]([seg(' tarde')])
    await settle()
    check(first.length === 2 && !h3.events.some((e) => e.t === 'final'), 'the old session\'s late result goes nowhere')
    await h3.phrase('d2')
    check(h3.servers[0].infers.length === 2, 'the new session uses the server once it is free')

    const h4 = harness()
    await h4.start()
    h4.svc.stopOwner(9)
    check(h4.svc.activeId === 'd1', 'another renderer going away leaves the session alone')
    h4.svc.stopOwner(1)
    check(types(h4.events) === 'ready:cpu,end' && h4.svc.activeId === null, 'its renderer reloading ends it (stopOwner)')
    await h4.start()
    await h4.c.advance(10 * 60_000 + 100)
    check(h4.events.at(-1).t === 'end' && h4.logs.includes('session max'), 'SESSION_MAX_MS acts like stop')
  }

  // --- Slow start: audio buffered, queue capped -------------------------------------------
  {
    let release
    const gate = new Promise((r) => { release = r })
    const h = harness({ start: () => gate.then(() => ({ ok: true })) })
    await h.start()
    for (let i = 0; i < 11; i++) { await h.feed('d1', voice(400)); await h.feed('d1', quiet(900)) }
    check(h.events.length === 0 && h.logs.filter((l) => l === 'queue drop').length >= 3, 'while the server starts, phrases queue up to 8 (the oldest dropped)')
    release()
    await settle(30)
    check(h.events[0].t === 'ready' && h.servers[0].infers.length === 8 && h.events.filter((e) => e.t === 'final').length === 8, 'once up, the 8 kept phrases are sent in order')
  }

  // --- GPU: hyp, beam, fallback -------------------------------------------------------------
  {
    const h = harness({ nvidia: true, installed: GPU_ASSETS })
    await h.start()
    const spec = h.servers[0].starts[0]
    check(spec.device === 'gpu' && spec.model.endsWith('model-turbo.bin') && types(h.events) === 'ready:gpu', 'auto with NVIDIA and the GPU pack: gpu')
    await h.feed('d1', voice(1500))
    const hyps = h.servers[0].infers.filter((c) => c.p.beamSize === undefined)
    check(hyps.length >= 1 && hyps.every((c) => c.p.vad === true && c.p.audioCtx === undefined) && h.events.some((e) => e.t === 'hyp' && e.text === 'Hola mundo'), 'gpu with interim: greedy hyps of the open phrase, VAD on')
    await h.feed('d1', quiet(1000))
    const fin = h.servers[0].infers.at(-1)
    check(fin.p.beamSize === 5 && fin.p.audioCtx === undefined && h.events.at(-1).t === 'final', 'gpu final: beam 5, full window')
    const n = h.servers[0].infers.length
    await h.c.advance(3000)
    check(h.servers[0].infers.length === n, 'no hyp without an open phrase')

    const h2 = harness({ nvidia: true, installed: GPU_ASSETS, dict: { interim: false } })
    await h2.start()
    await h2.feed('d1', voice(2000))
    check(h2.servers[0].infers.length === 0 && !h2.events.some((e) => e.t === 'hyp'), 'interim off: no hyp')
    const h3 = harness()
    await h3.start()
    await h3.feed('d1', voice(2000))
    check(h3.servers[0].infers.length === 0, 'cpu: no hyp')
    const h4 = harness({ installed: GPU_ASSETS, dict: { device: 'cpu' } })
    await h4.start()
    check(h4.servers[0].starts[0].device === 'cpu', "device 'cpu' runs the CPU pack even with the GPU pack")
  }
  {
    const h = harness({ nvidia: true, installed: GPU_ASSETS, start: (spec) => (spec.device === 'gpu' ? { ok: false, error: 'gpu_failed' } : { ok: true }) })
    await h.start()
    check(h.servers.length === 2 && h.servers[0].starts[0].device === 'gpu' && h.servers[1].starts[0].device === 'cpu', 'the GPU start fails: the CPU plan starts')
    check(types(h.events) === 'ready:cpu:gpu_failed' && h.svc.gpuFailed, 'ready { engine: cpu, fallback: gpu_failed }')
    h.svc.stop('d1', 1)
    await settle()
    await h.start()
    check(h.servers.length === 2 && types(h.events.slice(-1)) === 'ready:cpu:gpu_failed', 'the GPU is not retried this run; the fallback is still reported')
    h.svc.stop('d2', 1)
    await settle()
    h.svc.setConfig(cfg({ device: 'gpu' }))
    check(!h.svc.gpuFailed, 'a device change clears the GPU failure')
    const h2 = harness({ nvidia: true, installed: GPU_ASSETS, start: (spec) => (spec.device === 'gpu' ? { ok: false, error: 'vcredist' } : { ok: false, error: 'vcredist' }) })
    await h2.start()
    check(types(h2.events) === 'error:vcredist,end', 'gpu and cpu both missing the runtime: vcredist, then end')
    const h3 = harness({ start: () => ({ ok: false, error: 'exit' }) })
    const r3 = await h3.start()
    check(r3.ok && types(h3.events) === 'error:exit,end', 'a CPU start failure with no fallback: error, then end')
  }

  // --- Timeouts and crashes ----------------------------------------------------------------
  {
    let fail = 1
    const h = harness({ infer: async () => { if (fail-- > 0) { const e = new Error('t'); e.code = 'timeout'; throw e } return [seg(' bien')] } })
    await h.start()
    await h.phrase('d1')
    check(h.events.some((e) => e.t === 'error' && e.code === 'timeout') && h.svc.activeId === 'd1', 'a final timeout: error timeout, not fatal')
    check(h.servers.length === 2 && h.servers[0].stops === 1 && h.servers[1].running, 'and the server is restarted (the request still runs inside it)')
    await h.phrase('d1')
    check(h.events.at(-1).t === 'final' && h.events.at(-1).text === 'bien', 'the next phrase works on the new server')
  }
  {
    const h = harness({ nvidia: true, installed: GPU_ASSETS, dict: { interim: false }, infer: async (c) => { if (c.srv.starts[0].device === 'gpu') { const e = new Error('t'); e.code = 'timeout'; throw e } return [seg(' cpu')] } })
    await h.start()
    await h.phrase('d1')
    check(h.servers.length === 2 && h.servers[1].starts[0].device === 'gpu' && h.svc.activeId === 'd1', 'one GPU timeout: restarted on GPU')
    await h.phrase('d1')
    check(h.servers.length === 3 && h.servers[2].starts[0].device === 'cpu' && h.events.some((e) => e.t === 'ready' && e.engine === 'cpu' && e.fallback === 'gpu_failed') && h.svc.gpuFailed, 'the second GPU timeout moves the session to CPU (ready fallback gpu_failed)')
    await h.phrase('d1')
    check(h.events.at(-1).text === 'cpu', 'and it goes on on CPU')
  }
  {
    const h = harness({ nvidia: true, installed: GPU_ASSETS })
    await h.start()
    h.servers[0].crash(3221226505)
    await settle()
    check(h.servers.length === 2 && h.servers[1].starts[0].device === 'cpu' && types(h.events) === 'ready:gpu,ready:cpu:gpu_failed', 'a GPU crash mid-session: restarted on CPU')
  }
  {
    const h = harness()
    await h.start()
    h.servers[0].crash(3221225477)
    await settle()
    check(types(h.events) === 'ready:cpu,error:vcredist,end', 'an access violation before the first answer: vcredist (old msvcp140)')
    const h2 = harness()
    await h2.start()
    await h2.phrase('d1')
    h2.servers[0].crash(3221225477)
    await settle()
    check(h2.servers.length === 2 && h2.svc.activeId === 'd1', 'a CPU crash after answers: restarted once')
    h2.servers[1].crash(1)
    await settle()
    check(types(h2.events) === 'ready:cpu,final,error:exit,end', 'a second CPU crash: error exit, then end')
  }
  {
    // A GPU access violation before its first answer is a CUDA or driver fault first: CPU, not vcredist.
    const h = harness({ nvidia: true, installed: GPU_ASSETS, dict: { interim: false } })
    await h.start()
    h.servers[0].crash(3221225477)
    await settle()
    check(h.servers.length === 2 && h.servers[1].starts[0].device === 'cpu' && types(h.events) === 'ready:gpu,ready:cpu:gpu_failed' && h.svc.gpuFailed, 'a GPU 0xC0000005 before the first answer: CPU fallback (gpu broken), not vcredist')
    h.servers[1].crash(3221225477)
    await settle()
    check(types(h.events) === 'ready:gpu,ready:cpu:gpu_failed,error:vcredist,end', 'the same crash on the CPU plan too: vcredist')
  }
  {
    // The GPU restart after a first timeout fails: the CPU plan, as at boot.
    let gpuStarts = 0
    const h = harness({
      nvidia: true, installed: GPU_ASSETS, dict: { interim: false },
      start: (spec) => (spec.device === 'gpu' && ++gpuStarts > 1 ? { ok: false, error: 'gpu_failed' } : { ok: true }),
      infer: async (c) => { if (c.srv.starts[0].device === 'gpu') { const e = new Error('t'); e.code = 'timeout'; throw e } return [seg(' cpu')] },
    })
    await h.start()
    await h.phrase('d1')
    check(h.svc.activeId === 'd1' && h.svc.gpuFailed && types(h.events) === 'ready:gpu,error:timeout,ready:cpu:gpu_failed', 'a GPU restart that fails moves the session to CPU (not gpu_failed + end): ' + types(h.events))
    check(h.servers.length === 3 && h.servers[1].starts[0].device === 'gpu' && h.servers[2].starts[0].device === 'cpu', 'gpu, the failed gpu restart, then cpu')
    await h.phrase('d1')
    check(h.events.at(-1).t === 'final' && h.events.at(-1).text === 'cpu', 'and it goes on on CPU')
    const h2 = harness({ start: (spec, srv) => (srv.idx > 0 ? { ok: false, error: 'exit' } : { ok: true }), infer: async () => { const e = new Error('t'); e.code = 'timeout'; throw e } })
    await h2.start()
    await h2.phrase('d1')
    check(types(h2.events) === 'ready:cpu,error:timeout,error:exit,end', 'a CPU restart that fails ends the session: ' + types(h2.events))
  }
  {
    // An ended session's request times out on the server a newer session reuses: the newer one gets a server back.
    const p1 = []
    let n = 0
    const h = harness({ infer: (c) => (++n === 1 ? new Promise((res, rej) => p1.push(rej)) : Promise.resolve([seg(' dos')])) })
    await h.start()
    await h.phrase('d1')
    h.svc.stopOwner(1)
    const r = await h.start()
    check(r.ok && h.servers.length === 1 && types(h.events) === 'ready:cpu,end,ready:cpu', 'the new session reuses the server held by the old request')
    await h.phrase('d2')
    check(h.servers[0].infers.length === 1, 'its phrase waits behind the old request')
    const e = new Error('t'); e.code = 'timeout'
    p1[0](e)
    await settle(30)
    check(h.servers[0].stops === 1 && h.servers.length === 2 && h.servers[1].running, 'the old request times out: the shared server is restarted, not just stopped')
    check(types(h.events) === 'ready:cpu,end,ready:cpu,final' && h.events.at(-1).text === 'dos' && h.events.at(-1).sessionId === 'd2', 'the new session\'s queued phrase is transcribed: ' + types(h.events))
    await h.phrase('d2')
    check(h.events.at(-1).t === 'final' && h.svc.activeId === 'd2', 'and it keeps going')
  }
  {
    // An empty answer still reaches the renderer (it types nothing, but `slow` learns the engine answers).
    const h = harness({ infer: async () => [] })
    await h.start()
    await h.phrase('d1')
    check(types(h.events) === 'ready:cpu,final' && h.events[1].text === '' && h.logs.some((l) => / empty$/.test(l)), 'VAD or the filter leave nothing: one final with empty text')
  }

  // --- Warmup, install, remove, dispose ------------------------------------------------------
  {
    let release
    const gate = new Promise((r) => { release = r })
    const h = harness({ nvidia: true, installed: GPU_ASSETS, infer: async (c) => { if (c.p.prompt === '' && c.srv.idx === 0) await gate; return [seg(' x')] } })
    const w = h.svc.warmup('gpu')
    await settle()
    const ws = h.servers[0]
    check(ws.starts[0].device === 'gpu' && (await h.svc.status()).warming, 'warmup: the CUDA server on its own instance')
    const r = await h.start()
    check(r.ok && h.servers.length === 2 && h.servers[1].starts[0].device === 'cpu' && types(h.events) === 'ready:cpu', 'a dictation during the warmup runs on CPU and does not touch the warmup')
    check((await h.svc.remove('cpu')).error === 'busy' && (await h.svc.install('gpu')).error === 'busy', 'remove and install are busy during the warmup')
    release()
    check((await w) === true, 'warmup ok')
    check(ws.infers.length === 2 && ws.infers.every((c) => c.p.vad === false && c.t === 120000) && ws.infers[0].p.beamSize === undefined && ws.infers[1].p.beamSize === 5 && ws.stops === 1, 'warmup: noise twice without VAD (greedy, then beam 5), then its server stops')
    check(h.servers[1].stops === 0 && h.svc.activeId === 'd1', 'the live CPU session kept its server')
    check((await h.svc.warmup('cpu')) === true && h.servers.length === 2, 'the cpu pack has no warmup')
    const hf = harness({ installed: GPU_ASSETS, start: () => ({ ok: false, error: 'gpu_failed' }) })
    check((await hf.svc.warmup('gpu')) === false && hf.logs.includes('warmup error=gpu_failed'), 'a failed warmup answers false (the installer reports warmup)')
  }
  {
    const h = harness({ nvidia: true, installed: GPU_ASSETS, start: (spec) => (spec.device === 'gpu' ? { ok: false, error: 'gpu_failed' } : { ok: true }) })
    await h.start()
    check((await h.svc.remove('gpu')).error === 'busy', 'remove during a session: busy')
    h.svc.stop('d1', 1)
    await settle()
    check(h.svc.gpuFailed && (await h.svc.install('gpu')).ok && !h.svc.gpuFailed && h.calls.includes('install:gpu'), 'a successful install clears the GPU failure')
    const cpuSrv = h.servers[1]
    // A start while the removal waits for the idle server: refused, it would spawn from the files being deleted.
    let release
    const gate = new Promise((r) => { release = r })
    const realRemove = h.installer.remove
    h.installer.remove = async (p, g) => { await gate; return realRemove(p, g) }
    const pending = h.svc.remove('gpu')
    await settle()
    const during = await h.start()
    check(!during.ok && during.error === 'model_missing' && h.svc.activeId === null && (await h.svc.remove('cpu')).error === 'busy', 'during a removal: start answers model_missing, a second removal is busy')
    release()
    const rm = await pending
    h.installer.remove = realRemove
    check(rm.ok && cpuSrv.stops === 1 && h.calls.includes('remove:gpu'), 'remove stops the idle server first (its DLLs are locked while it lives)')
    await h.start()
    h.svc.cancelInstall('gpu')
    h.svc.dispose()
    check(h.events.at(-1).t === 'end' && h.servers.at(-1).stops === 1 && h.calls.includes('cancel:cpu') && h.calls.includes('cancel:gpu'), 'dispose (quit): end, the server killed, installs cancelled')
    check(!(await h.start()).ok, 'nothing starts after dispose')
  }

  // --- No em or en dash in the main-side dictation sources ------------------------------
  for (const f of ['src/main/dictation/DictationService.ts', 'src/main/dictation/whisper/WhisperServer.ts', 'src/main/dictation/whisper/serverClient.ts', 'src/main/dictation/whisper/vcRuntime.ts', 'src/main/ipc/registerDictationIpc.ts']) {
    check(!/[\u2013\u2014]/.test(fs.readFileSync(path.join(root, f), 'utf8')), `no em or en dash in ${f}`)
  }
  check(!fs.existsSync(path.join(root, 'src/main/dictation/helperScript.ts')), 'the PowerShell helper is gone')

  // --- Real engine (gated) -------------------------------------------------------------------
  const realDir = process.env.SNAOS_TEST_WHISPER_DIR
  if (process.platform === 'win32' && process.env.CI !== 'true' && realDir) {
    const RW = load('src/main/dictation/whisper/WhisperServer.ts')
    const RV = load('src/main/dictation/whisper/vcRuntime.ts')
    const RA = load('src/main/dictation/whisper/wav.ts')
    const RC = load('src/main/dictation/whisper/catalog.ts')
    const dir = path.resolve(realDir)
    const has = (rel) => fs.existsSync(path.join(dir, rel))
    const installed = new Set(Object.values(RC.ASSETS).filter((a) => has(a.kind === 'zip' ? path.join(a.target, 'whisper-server.exe') : a.target)).map((a) => a.id))
    const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snaos-whisper-public-'))
    const clip = (name) => RA.wavToPcm(fs.readFileSync(path.join(dir, 'audio', name)))
    const devices = ['cpu', ...(RC.packInstalled('gpu', installed) ? ['gpu'] : [])]
    check(RC.packInstalled('cpu', installed), 'real engine: the CPU pack is laid out in SNAOS_TEST_WHISPER_DIR')
    const until = async (cond, ms) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50)); return cond() }
    for (const device of devices) {
      let fakeNow = Date.now()
      const servers = [], pids = [], logs = []
      const svc = new S.DictationService({
        platform: 'win32',
        arch: process.arch,
        installer: { busy: false, installed: () => installed, status: () => ({ packs: [], install: null }), install: async () => ({ ok: false }), cancel: () => {}, remove: async () => ({ ok: false }) },
        createServer: () => {
          const s = new RW.WhisperServer({ spawn: (exe, args, o) => spawn(exe, args, o), freePort: RW.freeLocalPort, token: RW.newServerToken, log: (l) => logs.push(l), writePid: (p) => { if (p) pids.push(p) } })
          servers.push(s)
          return s
        },
        spec: (plan) => {
          const rt = path.join(dir, RC.ASSETS[plan.runtime].target)
          return { device: plan.device, exe: path.join(rt, 'whisper-server.exe'), cwd: rt, model: path.join(dir, RC.ASSETS[plan.model].target), vadModel: path.join(dir, RC.ASSETS.vad.target), publicDir, threads: S.engineThreads(plan.device, os.cpus().length), ...(plan.device === 'gpu' ? { cudaCache: path.join(dir, 'cuda-cache') } : {}) }
        },
        nvidia: () => true,
        vcRuntime: RV.createVcRuntimeCheck(RV.regQuery()),
        whisperDir: dir,
        log: (l) => logs.push(l),
        now: () => fakeNow,
      })
      svc.setConfig(cfg({ device, vocabulary: '' }))
      const run = async (name) => {
        const events = []
        const res = await svc.start(1, (e) => events.push(e), { lang: 'es-AR', paneId: 'p1' })
        check(res.ok, `real ${device} ${name}: start ok (${res.error || ''})`)
        const pcm = clip(name)
        const all = new Int16Array(pcm.length + SR * 1.2)
        all.set(pcm)
        for (let at = 0; at < all.length; at += 1600) { fakeNow += 100; svc.audio(res.sessionId, 1, all.slice(at, at + 1600).buffer) }
        await until(() => events.some((e) => e.t === 'ready' || e.t === 'end'), 180_000)
        svc.stop(res.sessionId, 1)
        await until(() => events.some((e) => e.t === 'end'), 200_000)
        const finals = events.filter((e) => e.t === 'final' && e.text).map((e) => e.text).join(' ')
        const ready = events.find((e) => e.t === 'ready')
        console.log(`  real ${device} ${name}: ${types(events)} -> ${JSON.stringify(finals)}`)
        check(events.at(-1).t === 'end' && !events.some((e) => e.t === 'error' && e.code !== 'timeout'), `real ${device} ${name}: ends clean: ${types(events)}`)
        return { finals, ready }
      }
      if (device === 'gpu') {
        // As after an install: the warmup pays the CUDA JIT (a cold cache takes about 40 s) on its own server.
        const t0 = Date.now()
        check((await svc.warmup('gpu')) === true, `real gpu: warmup ok (${Date.now() - t0} ms): ${JSON.stringify(logs)}`)
      }
      const silence = await run('clip3-silence.wav')
      check(silence.finals === '', `real ${device}: silence gives no final`)
      if (device === 'gpu') check(silence.ready.engine === 'gpu' || silence.ready.fallback === 'gpu_failed', 'real gpu: the GPU runs, or the fallback says why not')
      const one = await run('clip1-short.wav')
      check(/terminal nueva/i.test(one.finals), `real ${device}: clip1 has "terminal nueva": ${one.finals} ${JSON.stringify(logs)}`)
      const two = await run('clip2-code.wav')
      check(/package\.json/i.test(two.finals) && /typecheck/i.test(two.finals), `real ${device}: clip2 with the prompt has package.json and typecheck: ${two.finals} ${JSON.stringify(logs)}`)
      check(logs.every((l) => !/terminal|package|typecheck|Dictado|MiProyecto/i.test(l) && !l.includes(dir)), `real ${device}: the log keeps codes only: ${JSON.stringify(logs)}`)
      svc.dispose()
      const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
      check(pids.length >= 1 && (await until(() => pids.every((p) => !alive(p)), 10_000)), `real ${device}: the server process exits on dispose`)
    }
    fs.rmSync(publicDir, { recursive: true, force: true })
  }

  console.log(`test-dictation: ${checks} checks passed`)
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
