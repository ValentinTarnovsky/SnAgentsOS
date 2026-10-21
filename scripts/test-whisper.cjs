// Local Whisper dictation (app 2.5.0), the pure engine logic: the energy
// Segmenter (synthetic 16 kHz signals, plus real speech clips when
// SNAOS_TEST_WHISPER_AUDIO names their folder), the WAV helpers, verbose_json
// parsing, the hallucination filter (SnClips port plus tag, unsure and
// prompt echo) and the prompt builder. Node only, esbuild + vm.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
function load(file) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, URL })
  return mod.exports
}

const SR = 16000
const near = (a, b, tol) => Math.abs(a - b) <= tol

// --- Signals ----------------------------------------------------------------
function silence(ms) { return new Int16Array(Math.round((ms * SR) / 1000)) }
// Speech-like: a 440 Hz tone (with a harmonic) under a 4 Hz syllable envelope.
function speech(ms, amp = 0.3) {
  const n = Math.round((ms * SR) / 1000)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const env = 0.3 + 0.7 * Math.abs(Math.sin(2 * Math.PI * 2 * t))
    const v = amp * env * (0.8 * Math.sin(2 * Math.PI * 440 * t) + 0.2 * Math.sin(2 * Math.PI * 880 * t))
    out[i] = Math.round(v * 32767)
  }
  return out
}
// A steady hum (pure sine at rms `rms`).
function hum(ms, rms) {
  const n = Math.round((ms * SR) / 1000)
  const out = new Int16Array(n)
  const amp = rms * Math.SQRT2
  for (let i = 0; i < n; i++) out[i] = Math.round(amp * Math.sin((2 * Math.PI * 120 * i) / SR) * 32767)
  return out
}
// White noise whose rms goes linearly from `from` to `to` (deterministic LCG).
function noiseRamp(ms, from, to) {
  const n = Math.round((ms * SR) / 1000)
  const out = new Int16Array(n)
  let seed = 12345
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0
    const u = seed / 4294967296 * 2 - 1 // uniform [-1, 1): rms 1/sqrt(3)
    const rms = from + ((to - from) * i) / n
    out[i] = Math.round(u * Math.sqrt(3) * rms * 32767)
  }
  return out
}
function join(...parts) {
  const out = new Int16Array(parts.reduce((s, p) => s + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}
function rmsOf(pcm, from = 0, to = pcm.length) {
  let s = 0
  for (let i = from; i < to; i++) s += (pcm[i] / 32768) ** 2
  return Math.sqrt(s / Math.max(1, to - from))
}

function main() {
  const Seg = load('src/main/dictation/whisper/segmenter.ts')
  const W = load('src/main/dictation/whisper/wav.ts')
  const V = load('src/main/dictation/whisper/verbose.ts')
  const H = load('src/main/dictation/whisper/hallucination.ts')
  const P = load('src/main/dictation/whisper/prompt.ts')

  // Runs a signal through a fresh Segmenter in `chunk`-sample pushes.
  function segment(pcm, { chunk = 1600, flush = true } = {}) {
    const out = []
    const s = new Seg.Segmenter((p, ms) => out.push({ pcm: p, ms }))
    for (let at = 0; at < pcm.length; at += chunk) s.push(pcm.subarray(at, at + chunk))
    const beforeFlush = out.length
    if (flush) s.flush()
    return { out, beforeFlush, seg: s }
  }

  // --- Segmenter: constants -------------------------------------------------------
  check(Seg.FRAME_SAMPLES === 480 && Seg.START_FRAMES === 3 && Seg.END_SILENCE_MS === 700 && Seg.PRE_ROLL_MS === 300, 'frame 30 ms, 3 frames open, 700 ms close, 300 ms pre-roll')
  check(Seg.MIN_SPEECH_MS === 250 && Seg.MAX_SEGMENT_MS === 25000 && Seg.ABS_MIN_RMS === 0.006 && Seg.NOISE_FACTOR === 3, 'min speech 250 ms, cut at 25 s, abs rms 0.006, noise factor 3')

  // --- Segmenter: one phrase with its pre-roll -------------------------------------
  {
    const { out, beforeFlush } = segment(join(silence(1000), speech(1500), silence(1500)))
    check(out.length === 1 && beforeFlush === 1, `one phrase gives one segment, closed by the silence before stop (${out.length}, ${beforeFlush})`)
    const { pcm, ms } = out[0]
    check(ms === (pcm.length * 1000) / SR, 'ms matches the samples')
    check(near(ms, 300 + 1500 + 300, 61), `pre-roll + phrase + post-roll (${ms} ms)`)
    let first = 0
    while (first < pcm.length && pcm[first] === 0) first++
    check(near(first, 0.3 * SR, 480), `the segment opens with ~300 ms of pre-roll before the voice (${first} samples)`)
    check(rmsOf(pcm, 0, first) === 0 && rmsOf(pcm, first, first + 0.5 * SR) > 0.05, 'pre-roll is the audio from before the run, then the voice')
  }

  // --- Segmenter: a click is dropped -------------------------------------------------
  {
    const { out } = segment(join(silence(1000), speech(200), silence(1500)))
    check(out.length === 0, `a 200 ms click gives no segment (${out.length})`)
    const short = segment(join(silence(500), speech(100)))
    check(short.out.length === 0, 'flush with only 100 ms of voice gives nothing')
  }

  // --- Segmenter: two phrases, and a short pause inside one --------------------------
  {
    const two = segment(join(silence(500), speech(1200), silence(1000), speech(1200), silence(1200)))
    check(two.out.length === 2, `two phrases 1 s apart give two segments (${two.out.length})`)
    check(two.out.every((o) => near(o.ms, 1800, 121)), `each about 1.8 s (${two.out.map((o) => o.ms).join(', ')})`)
    const one = segment(join(silence(500), speech(1200), silence(400), speech(1200), silence(1200)))
    check(one.out.length === 1 && near(one.out[0].ms, 300 + 2800 + 300, 121), `a 400 ms pause stays inside one phrase (${one.out.map((o) => o.ms).join(', ')})`)
  }

  // --- Segmenter: forced cut at 25 s ------------------------------------------------
  {
    const { out } = segment(join(silence(500), speech(30000), silence(1500)))
    check(out.length === 2, `a 30 s phrase is cut in two (${out.length})`)
    check(out[0].ms <= 25000 && out[0].ms > 24900, `the first piece stops under 25 s (${out[0].ms})`)
    check(near(out[0].ms + out[1].ms, 300 + 30000 + 300, 121), `no audio lost across the cut (${out[0].ms + out[1].ms})`)
  }

  // --- Segmenter: flush, openMs, openPcm ---------------------------------------------
  {
    const { out, beforeFlush, seg } = segment(join(silence(500), speech(1000)), { flush: false })
    check(beforeFlush === 0 && out.length === 0, 'a phrase still being spoken is not emitted')
    check(near(seg.openMs, 300 + 1000, 61), `openMs while open (${seg.openMs})`)
    const a = seg.openPcm()
    check(a && (a.length * 1000) / SR === seg.openMs, 'openPcm covers the open segment')
    a.fill(7)
    check(seg.openPcm()[0] === 0, 'openPcm is a copy')
    seg.flush()
    check(out.length === 1 && near(out[0].ms, 1300, 61), `flush closes the open segment (${out.map((o) => o.ms)})`)
    check(seg.openMs === 0 && seg.openPcm() === null, 'nothing open after flush')
    seg.flush()
    check(out.length === 1, 'a second flush emits nothing')
  }

  // --- Segmenter: chunk size does not matter -----------------------------------------
  {
    const sig = join(silence(700), speech(900), silence(900), speech(1300), silence(1000))
    const a = segment(sig, { chunk: 1600 }).out
    const b = segment(sig, { chunk: 777 }).out
    const c = segment(sig, { chunk: sig.length }).out
    const same = (x, y) => x.length === y.length && x.every((o, i) => Buffer.from(o.pcm.buffer).equals(Buffer.from(y[i].pcm.buffer)))
    check(a.length === 2 && same(a, b) && same(a, c), 'the same segments whatever the push size (1600, 777, all at once)')
  }

  // --- Segmenter: noise -------------------------------------------------------------
  {
    const ramp = segment(join(noiseRamp(5000, 0.002, 0.03), noiseRamp(5000, 0.03, 0.03)))
    check(ramp.out.length === 0, `a noise floor that rises to 0.03 rms opens no segment (${ramp.out.length})`)
    const over = segment(join(noiseRamp(5000, 0.002, 0.03), noiseRamp(2000, 0.03, 0.03), speech(1500), noiseRamp(1500, 0.03, 0.03)))
    check(over.out.length === 1, `speech over that noise still opens one (${over.out.length})`)
    const steady = segment(hum(10000, 0.02))
    check(steady.out.length <= 1 && steady.out.every((o) => o.ms < 4000), `a steady hum loud from the first frame does not hold a segment open (${steady.out.map((o) => o.ms).join(', ')})`)
    const voice = speech(1500)
    const mixed = hum(1500, 0.02).map((v, i) => v + voice[i])
    const after = segment(join(hum(10000, 0.02), mixed, hum(1500, 0.02)))
    check(after.out.length === steady.out.length + 1, `once the hum is learned, speech over it opens one segment (${after.out.length})`)
  }

  // --- Segmenter: soft speech never ratchets the noise floor (review finding) ---------
  // Four 8 s utterances 1.5 s apart: 4 syllables a second whose peak level varies
  // (soft and loud words) with deep dips between them, plus Gaussian noise.
  function talk(ms, amp, seed0) {
    const n = Math.round((ms * SR) / 1000)
    const out = new Float64Array(n)
    let s = seed0
    const rnd = () => { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296 }
    const syl = SR / 4
    let level = 1
    for (let i = 0; i < n; i++) {
      if (i % syl === 0) level = 0.15 + 0.85 * rnd()
      const env = Math.sin((Math.PI * (i % syl)) / syl) ** 2
      const t = i / SR
      out[i] = amp * level * env * (0.7 * Math.sin(2 * Math.PI * 180 * t) + 0.3 * Math.sin(2 * Math.PI * 540 * t))
    }
    return out
  }
  function noisyTalk(utter, noise, gain, gapMs = 1500) {
    const parts = [new Float64Array(SR / 2)]
    for (const u of utter) { parts.push(u.map((v) => v * gain)); parts.push(new Float64Array((gapMs * SR) / 1000)) }
    const out = new Int16Array(parts.reduce((a, p) => a + p.length, 0))
    let at = 0
    let s = 3
    const rnd = () => { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296 }
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd())
    for (const p of parts) { for (let i = 0; i < p.length; i++) out[at + i] = Math.max(-32768, Math.min(32767, Math.round((p[i] + gauss() * noise) * 32767))); at += p.length }
    return out
  }
  {
    const utter = [0, 1, 2, 3].map((r) => talk(8000, 0.3, 7 + r))
    const clean = segment(noisyTalk(utter, 0, 1)).out
    check(clean.length === 4 && clean.every((o) => o.ms >= 8000), `clean synthetic talk: four whole utterances (${clean.map((o) => o.ms).join(', ')})`)
    const quiet = segment(noisyTalk(utter, 0.005, 0.3)).out
    check(quiet.length === 4 && quiet.every((o, i) => o.ms >= 0.9 * clean[i].ms), `a quiet speaker (-46 dBFS noise, gain 0.3): every utterance at least 90% whole (${quiet.map((o) => o.ms).join(', ')})`)
  }

  // --- Segmenter: the spike's real clips ---------------------------------------------
  {
    // A folder with the spike's clip1-short.wav, clip2-code.wav and clip3-silence.wav (16 kHz mono s16).
    const dir = process.env.SNAOS_TEST_WHISPER_AUDIO || ''
    const clip = (name) => {
      const f = dir && path.join(dir, name)
      return f && fs.existsSync(f) ? W.wavToPcm(fs.readFileSync(f)) : null
    }
    const c1 = clip('clip1-short.wav')
    const c2 = clip('clip2-code.wav')
    const c3 = clip('clip3-silence.wav')
    if (c1 && c2 && c3) {
      for (const [name, pcm] of [['clip1', c1], ['clip2', c2]]) {
        const { out } = segment(join(silence(500), pcm, silence(1200)))
        check(out.length === 1, `real ${name}: one phrase, one segment (${out.map((o) => o.ms).join(', ')})`)
        const lenMs = (pcm.length * 1000) / SR
        check(out[0].ms > 1500 && out[0].ms <= lenMs + 300 + 300, `real ${name}: the segment covers the speech (${out[0].ms} of ${lenMs} ms)`)
      }
      check(segment(c3).out.length === 0, 'real clip3 (silence): no segment')
      const both = segment(join(silence(300), c1, silence(1000), c2, c3))
      check(both.out.length === 2, `real clip1 + 1 s + clip2 + silence: two segments (${both.out.map((o) => o.ms).join(', ')})`)
      // The review's measurement: clip2 four times, 1.5 s apart, under Gaussian noise.
      const c2f = Float64Array.from(c2, (v) => v / 32767)
      const reps = [c2f, c2f, c2f, c2f]
      const base = segment(noisyTalk(reps, 0, 1)).out
      for (const [noise, gain] of [[0.005, 0.3], [0.02, 1]]) {
        const got = segment(noisyTalk(reps, noise, gain)).out
        check(got.length === 4 && got.every((o, i) => o.ms >= 0.9 * base[i].ms), `real clip2 x4, noise ${noise}, gain ${gain}: every utterance at least 90% of the clean one (${got.map((o) => o.ms).join(', ')} vs ${base.map((o) => o.ms).join(', ')})`)
      }
      const wav = W.pcmToWav(c2)
      const back = W.wavToPcm(wav)
      check(back.length === c2.length && back.every((v, i) => v === c2[i]), 'real clip2 survives pcmToWav / wavToPcm')
    } else {
      console.log('test-whisper: SNAOS_TEST_WHISPER_AUDIO not set or clips missing, real PCM checks skipped (synthetic only)')
    }
  }

  // --- wav ----------------------------------------------------------------------
  {
    const wav = W.pcmToWav(new Int16Array([1, -1, 32767, -32768]))
    const header = '52494646' + '2c000000' + '57415645' + '666d7420' + '10000000' + '0100' + '0100' + '803e0000' + '007d0000' + '0200' + '1000' + '64617461' + '08000000'
    check(W.WAV_HEADER_BYTES === 44 && wav.length === 52, '44-byte header + 2 bytes per sample')
    check(wav.subarray(0, 44).toString('hex') === header, 'RIFF / WAVE / fmt PCM mono 16 kHz 32000 B/s align 2 16 bit / data size')
    check(wav.subarray(44).toString('hex') === '0100ffffff7f0080', 'samples little-endian s16')
    check(W.wavToPcm(wav).join(',') === '1,-1,32767,-32768', 'wavToPcm reads it back')
    check(W.pcmToWav(new Int16Array(0)).length === 44 && W.wavToPcm(W.pcmToWav(new Int16Array(0))).length === 0, 'an empty segment is a bare header')
    const stereo = Buffer.from(wav); stereo.writeUInt16LE(2, 22)
    const rate = Buffer.from(wav); rate.writeUInt32LE(44100, 24)
    const float = Buffer.from(wav); float.writeUInt16LE(3, 20)
    for (const [bad, label] of [[stereo, 'stereo'], [rate, '44.1 kHz'], [float, 'float'], [Buffer.from('hola'), 'junk'], [wav.subarray(0, 30), 'truncated header'], [Buffer.alloc(0), 'empty']]) {
      check(W.wavToPcm(bad) === null, `wavToPcm rejects ${label}`)
    }
    const list = Buffer.concat([wav.subarray(0, 36), Buffer.from('LIST'), Buffer.from([3, 0, 0, 0]), Buffer.from('abc\0'), wav.subarray(36)])
    check(W.wavToPcm(list).join(',') === '1,-1,32767,-32768', 'a LIST chunk (odd size, padded) before data is skipped')
  }

  // --- verbose_json -------------------------------------------------------------------
  {
    const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/whisper-verbose.json'), 'utf8')
    const doc = JSON.parse(fixture)
    const segs = V.parseVerbose(fixture)
    const probs = doc.segments[0].words.map((w) => w.probability)
    check(Array.isArray(segs) && segs.length === 1, 'the spike answer has one segment')
    check(segs[0].text === ' Revisa el archivo package.json y corra copyright npm run typecheck antes del commit.', 'text as sent')
    check(segs[0].avgLogprob === doc.segments[0].avg_logprob && segs[0].noSpeechProb === doc.segments[0].no_speech_prob, 'avg_logprob and no_speech_prob')
    check(near(segs[0].meanP, probs.reduce((a, b) => a + b, 0) / probs.length, 1e-12), `meanP is the mean word probability (${segs[0].meanP})`)
    check(JSON.stringify(V.parseVerbose('{"text":"","segments":[]}')) === '[]', 'silence with vad=true: no segments')
    check(JSON.stringify(V.parseVerbose('{"text":" hola "}')) === '[{"text":" hola "}]' && JSON.stringify(V.parseVerbose('{"text":"  "}')) === '[]', 'no segment list: the top-level text')
    for (const junk of ['', 'hola', '{', '[1]', 'null', '3', '"x"', '{"segments":3}', '{"foo":1}']) {
      check(V.parseVerbose(junk) === null, `junk body ${JSON.stringify(junk)} gives null`)
    }
    check(V.parseVerbose(undefined) === null, 'a non-string body gives null')
    check(V.parseVerbose(' '.repeat(V.VERBOSE_MAX_BODY - 2) + '{}') === null && V.parseVerbose(JSON.stringify({ text: 'x'.repeat(V.VERBOSE_MAX_BODY) })) === null, 'a body over 1 MB gives null')
    const mixed = V.parseVerbose(JSON.stringify({ segments: [
      { text: 'a', avg_logprob: 'x', no_speech_prob: null, words: [{ word: 'a', probability: 2 }, { word: 'b' }, 'w', { probability: 0.4 }] },
      { text: 3 },
      null,
      { text: 'b', words: 'nope' },
      { text: 'c', avg_logprob: -0.5, no_speech_prob: 0.1, words: [] },
    ] }))
    check(JSON.stringify(mixed) === '[{"text":"a","meanP":0.4},{"text":"b"},{"text":"c","avgLogprob":-0.5,"noSpeechProb":0.1}]', `lenient fields: bad numbers and words left out, bad segments skipped (${JSON.stringify(mixed)})`)
    const many = V.parseVerbose(JSON.stringify({ segments: Array.from({ length: 250 }, (_, i) => ({ text: String(i) })) }))
    check(many.length === V.VERBOSE_MAX_SEGMENTS && V.VERBOSE_MAX_SEGMENTS === 200 && many[199].text === '199', 'capped at 200 segments')
  }

  // --- Hallucination filter -----------------------------------------------------------
  {
    check(H.normalize('  ¿Habrá   una ÑANDÚ? ') === 'habra una nandu?', 'normalize: lowercase, no accents, no leading inverted mark, single spaces')
    check(H.normalize('¡¡...') === '' && H.normalize('') === '', 'normalize: punctuation only is empty')
    const seg = (text, extra = {}) => ({ text, ...extra })
    const table = [
      ['Gracias por ver el video.', {}, true, 'weak'],
      [' [Música]', {}, true, 'tag'],
      ['[MÚSICA] [MÚSICA]', {}, true, 'tag'],
      ['(aplausos)', {}, true, 'tag'],
      ['[BLANK_AUDIO]', {}, true, 'tag'],
      ['[Música].', {}, true, 'tag'],
      [' \u266a \u266a', {}, true, 'tag'],
      ['Subtítulos realizados por la comunidad de Amara.org', {}, true, 'credit'],
      ['Subtitles by the Amara.org community', {}, true, 'credit'],
      ['Gracias.', { meanP: 0.3 }, true, 'unsure'],
      ['Gracias.', { meanP: 0.95, avgLogprob: -1.4 }, true, 'unsure'],
      ['¡Gracias!', { meanP: 0.2 }, true, 'unsure'],
      ['Gracias.', { meanP: 0.95 }, true, null],
      ['Thank you.', { meanP: 0.9, avgLogprob: -0.2 }, true, null],
      ['Tamara organizó la reunión', {}, true, null],
      ['Hola, ¿habrá una terminal nueva por favor?', {}, true, null],
      ['Revisa el archivo package.json y corra copyright npm run typecheck antes del commit.', {}, true, null],
      ['Gracias por ver el video, ahora seguimos con el deploy de la rama principal.', { meanP: 0.9 }, true, null],
      ['Gracias por ver el video.', { meanP: 0.9 }, false, null],
      ['Gracias por ver el video.', { meanP: 0.3 }, false, 'weak'],
      ['¡Suscríbete al canal!', {}, true, 'weak'],
      ['Thanks for watching!', { meanP: 0.92 }, true, 'weak'],
      ['algo', { noSpeechProb: 0.7, avgLogprob: -1.2 }, true, 'silence'],
      ['algo', { noSpeechProb: 0.7, avgLogprob: -0.5 }, true, null],
      ['[Música] hola mundo', {}, true, null],
      ['', {}, true, null],
    ]
    for (const [text, extra, alone, want] of table) {
      const got = H.dropReason(seg(text, extra), alone)
      check(got === want, `${JSON.stringify(text)} ${JSON.stringify(extra)}${alone ? ' alone' : ''}: ${want ?? 'keep'} (got ${got ?? 'keep'})`)
    }
    check(H.CREDIT_MAX_WORDS === 10 && H.WEAK_PHRASE_MAX_P === 0.5 && H.ALONE_MAX_WORDS === 6 && H.NO_SPEECH_PROB === 0.6 && H.LOW_AVG_LOGPROB === -1, 'SnClips constants')
    check(H.dropReason(seg('uno dos tres cuatro cinco seis siete ocho nueve diez once amara.org')) === null, 'a credit pattern inside 11+ words is speech')

    // Prompt echo (critique 13).
    const prompt = P.buildPrompt('es', { workspace: 'SnAgentsOS', vocabulary: 'Zustand, xterm, node-pty' })
    const echo = H.promptEcho(prompt)
    check(H.promptEcho('') === null && H.promptEcho('  ¿? ') === null, 'an empty prompt has no echo check')
    // [text, when Whisper was sure, when it was unsure]
    const echoes = [
      ['Dictado para una terminal de programación.', 'prompt', 'prompt'],
      ['Términos: package.json, npm run typecheck, npm test.', 'prompt', 'prompt'],
      ['package.json, npm run typecheck, npm test, npm install, git commit, git push, pull request', 'prompt', 'prompt'],
      ['React, Electron, Node, Python, Claude, Codex.', null, 'prompt'],
      ['Codex, README, JSON, API, CLI, PowerShell. SnAgentsOS, Zustand, xterm', null, 'prompt'],
      ['Python, Claude, Codex, PowerShell, README, merge, TypeScript, JSON, API.', null, 'prompt'],
      // Things a user dictates on purpose: prompt words in the prompt's order (review finding).
      ['Git commit, git push.', null, 'prompt'],
      ['npm run typecheck, npm test.', null, 'prompt'],
      ['npm test, npm install', null, 'prompt'],
      ['React, Electron, Node, Python.', null, 'prompt'],
      ['Pull request, merge, branch.', null, 'prompt'],
      ['npm install, npm test, git commit y git push.', null, 'prompt'],
      ['npm run typecheck', null, null],
      ['git push', null, null],
      ['PowerShell.', null, null],
      ['Corre npm run typecheck y después npm test.', null, null],
      ['Haz un pull request para la branch de test con el fix de Electron.', null, null],
      ['Revisa el archivo package.json y corra copyright npm run typecheck antes del commit.', null, null],
    ]
    for (const [text, sure, unsure] of echoes) {
      const got = H.dropReason(seg(text, { meanP: 0.9, avgLogprob: -0.2, noSpeechProb: 0.01 }), true, echo)
      check(got === sure, `prompt echo, sure ${JSON.stringify(text)}: ${sure ?? 'keep'} (got ${got ?? 'keep'})`)
      const got2 = H.dropReason(seg(text, { meanP: 0.3, avgLogprob: -0.2, noSpeechProb: 0.01 }), true, echo)
      check(got2 === unsure, `prompt echo, unsure ${JSON.stringify(text)}: ${unsure ?? 'keep'} (got ${got2 ?? 'keep'})`)
    }
    check(H.dropReason(seg('Git commit, git push.', { meanP: 0.9, avgLogprob: -1.3 }), true, echo) === 'prompt' && H.dropReason(seg('Git commit, git push.', { meanP: 0.9, avgLogprob: -0.2, noSpeechProb: 0.8 }), true, echo) === 'prompt', 'a low log probability or a high no-speech probability counts as unsure')
    for (const [lang, ctx] of [['es', { appLang: 'es', workspace: 'SnAgentsOS' }], ['en', {}], ['auto', { appLang: 'es', workspace: 'Mi Proyecto Grande', vocabulary: 'deploy staging, rollback prod' }]]) {
      const p = P.buildPrompt(lang, ctx)
      for (const text of ['Git commit, git push.', 'npm run typecheck, npm test.', 'npm test, npm install', 'React, Electron, Node, Python.', 'Pull request, merge, branch.', 'npm install, npm test, git commit y git push.', 'Mi Proyecto Grande deploy staging', 'Deploy staging, rollback prod.']) {
        const k = H.keptText([seg(text)], p)
        check(k.text !== '' && k.dropped.length === 0, `confident dictation is typed with the ${lang} prompt: ${JSON.stringify(text)} (${k.dropped.join(',')})`)
      }
    }
    check(H.dropReason(seg('Dictado para una terminal de programación.')) === null, 'no echo check without a prompt')
    const fr = H.promptEcho(P.buildPrompt('fr'))
    check(fr.heads.length === 0 && fr.labels.size === 0 && H.dropReason(seg(P.BASE_TERMS), true, fr) === 'prompt', 'the bare term list (other languages): no head, a whole read-back is still an echo')

    // Real Spanish speech that starts like an outro (review finding): -nt makes every answer one segment.
    for (const text of ['Suscribir el listener al evento.', 'Suscribite al canal de logs', '¿Suscribiste el handler?', 'Suscribete al canal de websockets y loguea', 'Gracias por ver el PR.', 'Thanks for watching the logs']) {
      check(H.dropReason(seg(text), true) === null, `confident ${JSON.stringify(text)} is kept`)
    }
    for (const text of ['Suscríbete al canal.', '¡Suscríbete!', 'No olvides suscribirte.', 'Suscríbete y dale like.', 'Gracias por ver.', 'Thanks for watching this video!']) {
      check(H.dropReason(seg(text), true) === 'weak', `a confident whole outro ${JSON.stringify(text)} is still dropped`)
    }
    check(H.dropReason(seg('Suscribir el listener al evento.', { meanP: 0.3 }), true) === 'weak', 'an unsure one that starts like an outro goes (SnClips prefix)')

    // keptText.
    const fixtureSegs = V.parseVerbose(fs.readFileSync(path.join(__dirname, 'fixtures/whisper-verbose.json'), 'utf8'))
    const k0 = H.keptText(fixtureSegs, prompt)
    check(k0.text === 'Revisa el archivo package.json y corra copyright npm run typecheck antes del commit.' && k0.dropped.length === 0, 'keptText: the spike answer is kept whole, trimmed')
    const k1 = H.keptText([seg(' Hola,'), seg(' [Música]'), seg('  ¿qué tal?  '), seg(''), seg('Gracias por ver el video.', { meanP: 0.2 })])
    check(k1.text === 'Hola, ¿qué tal?' && k1.dropped.join(',') === 'tag,weak', `keptText joins the kept ones and lists why the rest went (${JSON.stringify(k1)})`)
    const k2 = H.keptText([seg(''), seg(' Gracias por ver el video. ', { meanP: 0.9 }), seg('   ')])
    check(k2.text === '' && k2.dropped.join(',') === 'weak', 'empty segments do not count: a lone weak phrase is still alone')
    const k3 = H.keptText([seg('Gracias por ver el video.', { meanP: 0.9 }), seg('Ahora el deploy.')])
    check(k3.text === 'Gracias por ver el video. Ahora el deploy.' && k3.dropped.length === 0, 'a confident weak phrase with company is kept')
    check(JSON.stringify(H.keptText([])) === '{"text":"","dropped":[]}', 'no segments: empty text')
  }

  // --- Prompt -----------------------------------------------------------------------
  {
    check(P.PROMPT_MAX_CHARS === 600 && P.VOCAB_MAX_CHARS === 400, 'caps: prompt 600, vocabulary 400')
    for (const [tag, want] of [['es-AR', 'es'], ['es', 'es'], ['EN_us', 'en'], ['pt-BR', 'pt'], ['zh-Hans-CN', 'zh'], ['auto', 'auto'], ['zz', 'auto'], ['', 'auto'], [' x ', 'auto'], [undefined, 'auto']]) {
      check(P.whisperLang(tag) === want, `whisperLang(${JSON.stringify(tag)}) === ${want}`)
    }
    check(P.buildPrompt('es-AR') === P.BASE_PROMPT.es && P.BASE_PROMPT.es.startsWith('Dictado para una terminal de programación. Términos: package.json'), 'Spanish: the Spanish sentence')
    check(P.buildPrompt('en-US') === P.BASE_PROMPT.en && P.BASE_PROMPT.en.startsWith('Dictation for a programming terminal. Terms: package.json'), 'English: the English sentence')
    check(P.buildPrompt('fr') === P.BASE_TERMS && !/Dictation|Dictado/.test(P.buildPrompt('de')), 'another language: the bare term list, no English sentence (critique 14)')
    check(P.buildPrompt('auto', { appLang: 'es' }) === P.BASE_PROMPT.es && P.buildPrompt('auto') === P.BASE_PROMPT.en && P.buildPrompt('zz-QQ', { appLang: 'es' }) === P.BASE_PROMPT.es, 'auto: the app language picks the base')
    check(P.buildPrompt('es', { workspace: 'SnAgentsOS', folder: 'snagentsos', vocabulary: 'Zustand' }) === `${P.BASE_PROMPT.es} SnAgentsOS, Zustand`, 'workspace, folder (deduped) and vocabulary after the base')
    check(P.buildPrompt('en', { folder: 'api' }) === `${P.BASE_PROMPT.en} api`, 'folder alone')
    const dirty = P.buildPrompt('en', { workspace: 'a\u0007b\r\nc\u001b[31m', folder: '\u2028x\u0085y\t', vocabulary: 'one\u0000two\u00a0three' })
    check(dirty === `${P.BASE_PROMPT.en} a b c [31m, x y, one two three`, `controls and odd spaces become single spaces (${JSON.stringify(dirty)})`)
    check(!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(dirty), 'no control characters survive')
    const long = P.buildPrompt('es', { workspace: 'W'.repeat(200), vocabulary: 'palabra '.repeat(100) })
    check(long.length <= P.PROMPT_MAX_CHARS && long.startsWith(P.BASE_PROMPT.es) && long.endsWith('palabra'), `capped at 600 at a word boundary, the base intact (${long.length})`)
    check(long.includes(' ' + 'W'.repeat(80) + ',') && !long.includes('W'.repeat(81)), 'a long workspace name is cut at 80')
    check(P.cleanVocabulary('a\tb\u2028c\u00a0d  e') === 'a b c d e', 'cleanVocabulary: one printable line')
    const vocab = P.cleanVocabulary('término '.repeat(80))
    check(vocab.length <= 400 && vocab.endsWith('término') && !vocab.endsWith(' '), `cleanVocabulary cuts at a word boundary (${vocab.length})`)
    check(P.cleanVocabulary('x'.repeat(500)).length === 400, 'one long word is cut at 400')
    check(P.cleanVocabulary(undefined) === '' && P.cleanVocabulary('   ') === '', 'cleanVocabulary: nothing gives empty')
  }

  // --- No dashes, no BOM ---------------------------------------------------------------
  {
    const files = fs.readdirSync(path.join(root, 'src/main/dictation/whisper')).filter((f) => f.endsWith('.ts')).map((f) => path.join(root, 'src/main/dictation/whisper', f))
    files.push(__filename, path.join(__dirname, 'fixtures/whisper-verbose.json'))
    for (const f of files) {
      const buf = fs.readFileSync(f)
      const text = buf.toString('utf8')
      check(!/[\u2013\u2014]/.test(text) && !(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf), `${path.relative(root, f)}: no em or en dash, no BOM`)
    }
  }

  console.log(`test-whisper: ${checks} checks passed`)
}

try {
  main()
} catch (e) {
  console.error(e)
  process.exitCode = 1
}
