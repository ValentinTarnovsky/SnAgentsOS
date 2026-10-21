// Local Whisper packs (app 2.5.0): the catalog (URLs, hashes, pack totals,
// resolveEngine) and WhisperInstaller in node with esbuild + vm, a fake fetch
// and a temp dir: download, resume with Range, manual redirects, size and
// SHA-256 checks, free space, cancel, busy, warmup, remove and the codes-only
// log. netFetch.ts runs against a fake Electron `net`. On Windows the real
// tar.exe extracts a zip built with the writer of src/main/migration/backupZip.ts.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, URL, setTimeout, clearTimeout, setImmediate, AbortController, AbortSignal, ...overrides })
  return mod.exports
}
const flush = () => new Promise((r) => setImmediate(r))
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')

const C = load('src/main/dictation/whisper/catalog.ts')
const I = load('src/main/dictation/whisper/WhisperInstaller.ts')
const Z = load('src/main/migration/backupZip.ts')
const D = load('src/shared/dictation.ts')

// --- Fake assets: real catalog URLs and targets, small contents ----------------------
function zipOf(members) {
  const entries = members.map((m) => ({ name: m, data: Buffer.from(`${m} payload\n`.repeat(40)), source: m }))
  return Z.encodeZip(entries, Z.buildManifest(entries, '0.0.0', Date.now(), Date.now()))
}
const CONTENT = {
  'runtime-cpu': zipOf(C.ASSETS['runtime-cpu'].members),
  'runtime-cuda': zipOf(C.ASSETS['runtime-cuda'].members),
  'model-small': crypto.randomBytes(300_000),
  'model-turbo': crypto.randomBytes(500_000),
  vad: crypto.randomBytes(20_000),
}
function catalogFor(content) {
  const assets = {}
  for (const [id, a] of Object.entries(C.ASSETS)) assets[id] = { ...a, bytes: content[id].length, sha256: sha(content[id]) }
  return { assets, packs: C.PACKS }
}
const CATALOG = catalogFor(CONTENT)
const URL_ID = new Map(Object.values(C.ASSETS).map((a) => [a.url, a.id]))

async function* chunksOf(buf, signal, size = 64 * 1024) {
  for (let i = 0; i < buf.length; i += size) {
    await flush()
    if (signal && signal.aborted) throw new Error('aborted')
    yield buf.subarray(i, Math.min(buf.length, i + size))
  }
}
const waitAbort = (signal) => new Promise((_, rej) => {
  if (signal.aborted) return rej(new Error('aborted'))
  signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true })
})

/** A fake `deps.fetch`: serves CONTENT by catalog URL, honours `Range`, records every call. */
function makeFetch(route, content = CONTENT) {
  const calls = []
  const fetch = async (url, headers, signal) => {
    calls.push({ url, headers: { ...headers } })
    if (route) {
      const r = await route(url, headers, signal, calls)
      if (r) return r
    }
    const id = URL_ID.get(url)
    if (!id) return { status: 404, headers: {}, body: chunksOf(Buffer.alloc(0)) }
    return serve(content[id], headers, signal)
  }
  return { fetch, calls }
}
function serve(data, headers, signal) {
  const m = /^bytes=(\d+)-$/.exec(headers.Range || '')
  if (m) {
    const start = Number(m[1])
    if (start >= data.length) return { status: 416, headers: { 'content-range': `bytes */${data.length}` }, body: chunksOf(Buffer.alloc(0)) }
    return { status: 206, headers: { 'content-range': `bytes ${start}-${data.length - 1}/${data.length}`, 'content-length': String(data.length - start) }, body: chunksOf(data.subarray(start), signal) }
  }
  return { status: 200, headers: { 'content-length': String(data.length) }, body: chunksOf(data, signal) }
}

/** Emulates tar --strip-components 1 with the zip reader. */
async function fakeExtract(zip, dest, members) {
  const decoded = Z.decodeZip(fs.readFileSync(zip))
  for (const e of decoded.entries) if (members.includes(e.name)) fs.writeFileSync(path.join(dest, I.strippedMember(e.name)), e.data)
}

const tmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-whisper-')))
let dirN = 0
function freshDir(name = 'whisper') {
  const d = path.join(tmpRoot, `${++dirN}`, name)
  fs.mkdirSync(path.dirname(d), { recursive: true })
  return d
}

function makeInstaller(dir, fetch, opt = {}) {
  const events = []
  const logs = []
  const inst = new I.WhisperInstaller({
    dir,
    fetch,
    extract: opt.extract || fakeExtract,
    freeBytes: opt.freeBytes || (async () => 1e13),
    warmup: opt.warmup || (async () => true),
    emit: (p) => events.push(p),
    log: (l) => logs.push(l),
    platform: opt.platform || 'win32',
    arch: opt.arch || 'x64',
    now: opt.now,
    idleTimeoutMs: opt.idleTimeoutMs || 5000,
    fsRetryDelaysMs: [5, 10],
    catalog: opt.catalog || CATALOG,
  })
  return { inst, events, logs }
}
const exists = (p) => fs.existsSync(p)
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const listAll = (d) => (exists(d) ? fs.readdirSync(d, { recursive: true }).map(String) : [])
function cleanLog(logs, dir) {
  return logs.every((l) => /^(install|asset|remove) [A-Za-z0-9=_ .-]+$/.test(l) && !l.includes('://') && !l.includes(dir) && !l.includes('github') && !l.includes('huggingface'))
}

async function main() {
  // --- Catalog integrity -------------------------------------------------------------
  {
    const assets = Object.values(C.ASSETS)
    check(assets.length === 5 && !C.ASSETS['model-large'], 'five assets, no model-large in this batch')
    for (const a of assets) {
      const u = new URL(a.url)
      check(u.protocol === 'https:' && C.isAllowedDownloadHost(u.hostname), `${a.id}: https on an allowed host`)
      check(/^[0-9a-f]{64}$/.test(a.sha256) && Number.isInteger(a.bytes) && a.bytes > 0, `${a.id}: 64-hex sha256 and a size`)
      if (u.hostname === 'huggingface.co') check(/\/resolve\/[0-9a-f]{40}\//.test(u.pathname) && !/\/main\//.test(u.pathname), `${a.id}: Hugging Face pinned to a 40-hex revision`)
      if (a.kind === 'zip') check(a.members.length >= 13 && a.members.every((m) => /^Release\/[A-Za-z0-9_.-]+$/.test(m)), `${a.id}: members are Release/<file>`)
      check(!a.target.includes('..') && !path.isAbsolute(a.target), `${a.id}: target stays under whisperDir`)
    }
    check(C.ASSETS['runtime-cpu'].members.length === 13 && C.ASSETS['runtime-cuda'].members.length === 17, '13 CPU members, 17 CUDA members')
    check(C.assetsDownloadBytes(C.PACKS.cpu) === 199899225, 'cpu pack downloads 199,899,225 B')
    check(C.assetsDownloadBytes(C.PACKS.gpu) === 1759000704, 'gpu pack downloads 1,759,000,704 B')
    check(C.PACKS.cpu.every((id) => C.PACKS.gpu.includes(id)), 'the gpu pack includes the cpu pack')
    check(JSON.stringify(C.PACK_IDS) === JSON.stringify(D.PACK_IDS) && D.PACK_IDS.join() === "cpu,gpu", 'PACK_IDS comes from shared')
    for (const [h, ok] of [['github.com', true], ['GITHUB.COM', true], ['huggingface.co', true], ['objects.githubusercontent.com', true], ['release-assets.githubusercontent.com', true], ['us.aws.cdn.hf.co', true], ['cdn-lfs.huggingface.co', true],
      ['evil.example', false], ['github.com.evil.example', false], ['notgithub.com', false], ['xhf.co', false], ['hf.co.evil.example', false], ['githubusercontent.com.evil', false], ['', false]]) {
      check(C.isAllowedDownloadHost(h) === ok, `isAllowedDownloadHost(${JSON.stringify(h)}) === ${ok}`)
    }
    check(C.whisperDir('/data') === path.join('/data', 'whisper'), 'whisperDir joins whisper')

    // resolveEngine truth table.
    const cpu = new Set(C.PACKS.cpu)
    const gpu = new Set(C.PACKS.gpu)
    const none = new Set()
    const cudaOnly = new Set(['runtime-cuda', 'model-turbo'])
    const r = (device, inst, nvidia, broken) => {
      const x = C.resolveEngine({ device }, inst, nvidia, broken)
      return x.ok ? `${x.primary.device}${x.fallback ? '>' + x.fallback.device : ''}` : x.error
    }
    const table = [
      ['auto', gpu, true, false, 'gpu>cpu'], ['auto', gpu, false, false, 'cpu'], ['auto', gpu, true, true, 'cpu'], ['auto', cpu, true, false, 'cpu'],
      ['auto', none, true, false, 'model_missing'], ['auto', cudaOnly, true, false, 'model_missing'],
      ['gpu', gpu, true, false, 'gpu>cpu'], ['gpu', gpu, false, false, 'gpu>cpu'], ['gpu', gpu, true, true, 'cpu'], ['gpu', cpu, true, false, 'model_missing'], ['gpu', cudaOnly, true, false, 'model_missing'],
      ['cpu', gpu, true, false, 'cpu'], ['cpu', cpu, false, false, 'cpu'], ['cpu', none, true, false, 'model_missing'],
    ]
    for (const [device, inst, nv, broken, want] of table) check(r(device, inst, nv, broken) === want, `resolveEngine(${device}, ${[...inst].length} assets, nvidia=${nv}, broken=${broken}) = ${want}`)
    const plan = C.resolveEngine({ device: 'auto' }, gpu, true, false)
    check(plan.primary.runtime === 'runtime-cuda' && plan.primary.model === 'model-turbo' && plan.fallback.runtime === 'runtime-cpu' && plan.fallback.model === 'model-small', 'GPU plan: cuda + turbo, CPU fallback: cpu + small')
  }

  // --- Pure helpers ------------------------------------------------------------------
  {
    check(I.contentRangeStart('bytes 5-9/10') === 5 && I.contentRangeStart('bytes 0-0/*') === 0, 'contentRangeStart reads the start')
    check(I.contentRangeStart('bytes */10') === null && I.contentRangeStart(undefined) === null && I.contentRangeStart('items 1-2/3') === null, 'contentRangeStart: unsatisfied or junk is null')
    check(I.strippedMember('Release/ggml.dll') === 'ggml.dll', 'strippedMember drops the first folder')
    let n = 0
    const eperm = () => Object.assign(new Error('x'), { code: 'EPERM' })
    check((await I.withFsRetry(async () => { if (++n < 3) throw eperm(); return 'ok' }, [1, 1, 1])) === 'ok' && n === 3, 'withFsRetry: EPERM twice, then ok')
    n = 0
    await I.withFsRetry(async () => { n++; throw Object.assign(new Error('x'), { code: 'ENOENT' }) }, [1, 1]).catch(() => undefined)
    check(n === 1, 'withFsRetry: ENOENT is not retried')
    n = 0
    let failed = false
    await I.withFsRetry(async () => { n++; throw Object.assign(new Error('x'), { code: 'EBUSY' }) }, [1, 1]).catch((e) => { failed = e.code === 'EBUSY' })
    check(failed && n === 3, 'withFsRetry: EBUSY gives up after the backoff list')
    check(I.MAX_REDIRECTS === 5 && I.PROGRESS_THROTTLE_MS === 250 && I.DISK_MARGIN_BYTES === 200000000 && I.DOWNLOAD_TIMEOUT_MS === 60000, 'installer constants')
    check(/\\System32\\tar\.exe$/i.test(I.defaultTarPath()), 'tar.exe from System32 by absolute path')
  }

  // --- Unsupported, junk pack --------------------------------------------------------
  {
    const dir = freshDir()
    const { fetch, calls } = makeFetch()
    check((await makeInstaller(dir, fetch, { platform: 'linux' }).inst.install('cpu')).error === 'unsupported', 'off win32: unsupported')
    check((await makeInstaller(dir, fetch, { arch: 'arm64' }).inst.install('cpu')).error === 'unsupported', 'arm64: unsupported')
    check((await makeInstaller(dir, fetch).inst.install('gpu-large')).error === 'unsupported', 'an unknown pack: unsupported')
    check(calls.length === 0 && !exists(dir), 'nothing fetched or created')
  }

  // --- A clean CPU install -----------------------------------------------------------
  const cpuDir = freshDir()
  {
    const dir = cpuDir
    fs.mkdirSync(path.join(dir, 'runtime', 'cpu-b5454.tmp-deadbeef'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'runtime', 'cpu-b5454.tmp-deadbeef', 'whisper.dll'), 'stale')
    fs.writeFileSync(path.join(dir, 'installed.json.123.456.tmp'), 'stale')
    fs.mkdirSync(path.join(dir, 'models'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'models', 'ggml-small-q5_1.bin'), 'leftover from a crash')
    const { fetch, calls } = makeFetch()
    const { inst, events, logs } = makeInstaller(dir, fetch)
    check(inst.installed().size === 0 && inst.status().packs.every((p) => !p.installed), 'nothing installed before')
    const res = await inst.install('cpu')
    check(res.ok === true && !res.error, `cpu install ok (${JSON.stringify(res)})`)
    check(calls.length === 3 && calls.every((c) => !c.headers.Range), 'three downloads, no Range on a fresh start')
    const have = inst.installed()
    check(have.size === 3 && C.PACKS.cpu.every((id) => have.has(id)), 'installed() has the three cpu assets')
    const rec = readJson(path.join(dir, 'installed.json'))
    check(rec.version === 1 && Object.keys(rec.assets).sort().join() === 'model-small,runtime-cpu,vad', 'installed.json lists the assets')
    check(rec.assets.vad.sha256 === CATALOG.assets.vad.sha256 && rec.assets.vad.bytes === CONTENT.vad.length && rec.assets['runtime-cpu'].diskBytes === C.EXTRACT_BYTES['runtime-cpu'], 'installed.json records sha256, bytes and diskBytes')
    check(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')).length === 0, 'no installed.json temp file left (atomic write, stale one cleaned)')
    check(!fs.readFileSync(path.join(dir, 'installed.json')).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'installed.json has no BOM')
    check(fs.readdirSync(path.join(dir, 'downloads')).length === 0, 'downloads/ is empty: parts moved, zip deleted')
    const runtime = path.join(dir, 'runtime', 'cpu-b5454')
    check(fs.readdirSync(runtime).length === 13 && exists(path.join(runtime, 'whisper-server.exe')), 'runtime/cpu-b5454 holds the 13 members, flat')
    check(fs.readdirSync(path.join(dir, 'runtime')).join() === 'cpu-b5454', 'the stale .tmp-* folder is gone')
    check(fs.readFileSync(path.join(dir, 'models', 'ggml-small-q5_1.bin')).equals(CONTENT['model-small']), 'the leftover model was replaced by the verified one')
    const phases = [...new Set(events.map((e) => e.phase))]
    check(phases.join() === 'download,extract,done', `phases download, extract, done (${phases})`)
    const last = events.at(-1)
    check(last.phase === 'done' && last.pack === 'cpu' && last.transferred === last.total && last.total === CONTENT['runtime-cpu'].length + CONTENT['model-small'].length + CONTENT.vad.length, 'done: transferred equals the pack total')
    check(events.every((e, i) => i === 0 || e.phase !== 'download' || e.transferred >= events[i - 1].transferred || events[i - 1].phase !== 'download'), 'download progress never goes back')
    const st = inst.status()
    check(st.dataDir === dir && st.warming === false && st.install.phase === 'done', 'status: dataDir, warming, last install')
    check(st.packs.find((p) => p.id === 'cpu').installed && !st.packs.find((p) => p.id === 'gpu').installed, 'status: cpu installed, gpu not')
    const realStatus = new I.WhisperInstaller({ dir, platform: 'win32' }).status()
    check(realStatus.packs[0].downloadBytes === 199899225 && realStatus.packs[1].downloadBytes === 1759000704, 'status with the real catalog: catalog download totals')
    check(realStatus.packs[1].diskBytes === 1759000704 - 8928640 - 684913404 + 12000000 + 1160000000, 'status: gpu diskBytes counts the extracted runtimes')
    check(cleanLog(logs, dir) && logs.includes(`asset vad ok bytes=${CONTENT.vad.length}`) && logs.includes('install pack=cpu phase=done'), `log: codes only (${logs.join(' | ')})`)
    const again = await inst.install('cpu')
    check(again.ok && calls.length === 3, 'installing an installed pack downloads nothing')
  }

  // --- installed() checks the files ---------------------------------------------------
  {
    const dir = freshDir()
    fs.cpSync(cpuDir, dir, { recursive: true })
    const { inst } = makeInstaller(dir, makeFetch().fetch)
    check(inst.installed().size === 3, 'a copied install is recognised')
    fs.rmSync(path.join(dir, 'runtime', 'cpu-b5454', 'ggml-cpu-haswell.dll'))
    check(!inst.installed().has('runtime-cpu'), 'a zip asset missing one member is not installed')
    fs.writeFileSync(path.join(dir, 'models', 'ggml-silero-v5.1.2.bin'), 'short')
    check(!inst.installed().has('vad'), 'a model with the wrong size is not installed')
    const rec = readJson(path.join(dir, 'installed.json'))
    rec.assets['model-small'].sha256 = '0'.repeat(64)
    fs.writeFileSync(path.join(dir, 'installed.json'), JSON.stringify(rec))
    check(!inst.installed().has('model-small'), 'a record with another hash (catalog bump) is not installed')
    fs.writeFileSync(path.join(dir, 'installed.json'), '{junk')
    check(inst.installed().size === 0 && inst.status().packs.every((p) => !p.installed), 'a corrupt installed.json means nothing is installed')
    const fix = await inst.install('cpu')
    check(fix.ok && inst.installed().size === 3, 'a new install repairs it')
  }

  // --- Verification failures ---------------------------------------------------------
  {
    const dir = freshDir()
    const bad = Buffer.from(CONTENT['model-small'])
    bad[1000] ^= 0xff
    const { fetch } = makeFetch((url, h, signal) => (URL_ID.get(url) === 'model-small' ? serve(bad, h, signal) : null))
    const { inst, events, logs } = makeInstaller(dir, fetch)
    const res = await inst.install('cpu')
    check(res.error === 'sha256' && events.at(-1).phase === 'error' && events.at(-1).error === 'sha256', 'a corrupt download fails with sha256')
    check(!exists(path.join(dir, 'downloads', 'model-small.part')) && !inst.installed().has('model-small') && inst.installed().has('runtime-cpu'), 'the bad .part is deleted, finished assets stay')
    check(logs.includes('asset model-small error=sha256') && cleanLog(logs, dir), 'log: asset error code')
  }
  for (const [label, body, headers] of [
    ['short body', CONTENT.vad.subarray(0, CONTENT.vad.length - 10), {}],
    ['long body', Buffer.concat([CONTENT.vad, Buffer.alloc(10)]), {}],
    ['wrong Content-Length', CONTENT.vad, { 'content-length': String(CONTENT.vad.length + 1) }],
  ]) {
    const dir = freshDir()
    const { fetch } = makeFetch((url, h, signal) => (URL_ID.get(url) === 'vad' ? { status: 200, headers, body: chunksOf(body, signal) } : null))
    const { inst } = makeInstaller(dir, fetch)
    const res = await inst.install('cpu')
    check(res.error === 'size' && !exists(path.join(dir, 'downloads', 'vad.part')), `${label}: size, .part deleted`)
  }

  // --- HTTP and redirect failures ----------------------------------------------------
  {
    const cases = [
      ['http 500', () => ({ status: 500, headers: {}, body: chunksOf(Buffer.from('oops')) }), 'http'],
      ['http 404', () => ({ status: 404, headers: {}, body: chunksOf(Buffer.alloc(0)) }), 'http'],
      ['redirect to evil.example', () => ({ status: 302, headers: { location: 'https://evil.example/ggml.bin' }, body: chunksOf(Buffer.alloc(0)) }), 'http'],
      ['redirect to a look-alike host', () => ({ status: 302, headers: { location: 'https://github.com.evil.example/x' }, body: chunksOf(Buffer.alloc(0)) }), 'http'],
      ['redirect to plain http', () => ({ status: 301, headers: { location: 'http://objects.githubusercontent.com/x' }, body: chunksOf(Buffer.alloc(0)) }), 'http'],
      ['redirect with credentials', () => ({ status: 307, headers: { location: 'https://user:pw@github.com/x' }, body: chunksOf(Buffer.alloc(0)) }), 'http'],
      ['redirect without location', () => ({ status: 302, headers: {}, body: chunksOf(Buffer.alloc(0)) }), 'http'],
      ['fetch rejects', () => Promise.reject(new Error('ECONNRESET')), 'network'],
    ]
    for (const [label, respond, code] of cases) {
      const dir = freshDir()
      const { fetch, calls } = makeFetch((url) => (URL_ID.get(url) === 'runtime-cpu' ? respond() : null))
      const { inst, logs } = makeInstaller(dir, fetch)
      const res = await inst.install('cpu')
      check(res.error === code, `${label}: ${code} (${res.error})`)
      check(calls.every((c) => !c.url.includes('evil') && c.url.startsWith('https://')), `${label}: never requested off the allowlist`)
      check(cleanLog(logs, dir), `${label}: log has no URL`)
    }
    {
      const dir = freshDir()
      let hop = 0
      const { fetch, calls } = makeFetch((url) => (url.includes('github') ? { status: 302, headers: { location: `/loop/${++hop}` }, body: chunksOf(Buffer.alloc(0)) } : null))
      const res = await makeInstaller(dir, fetch).inst.install('cpu')
      check(res.error === 'http' && calls.length === I.MAX_REDIRECTS + 1, `a redirect loop stops after ${I.MAX_REDIRECTS} hops`)
    }
    {
      const dir = freshDir()
      const { fetch } = makeFetch((url, h, signal) => (URL_ID.get(url) === 'runtime-cpu' ? { status: 200, headers: {}, body: (async function* () { yield CONTENT['runtime-cpu'].subarray(0, 100); await waitAbort(signal) })() } : null))
      const t0 = Date.now()
      const res = await makeInstaller(dir, fetch, { idleTimeoutMs: 60 }).inst.install('cpu')
      check(res.error === 'network' && Date.now() - t0 < 3000, 'a stalled body fails with network after the idle timeout')
      check(fs.statSync(path.join(dir, 'downloads', 'runtime-cpu.part')).size === 100, 'the stalled .part is kept for a resume')
    }
    {
      const dir = freshDir()
      const { fetch } = makeFetch(() => new Promise(() => undefined))
      const res = await makeInstaller(dir, fetch, { idleTimeoutMs: 60 }).inst.install('cpu')
      check(res.error === 'network', 'no response at all fails with network after the idle timeout')
    }
  }

  // --- Free space --------------------------------------------------------------------
  {
    const dir = freshDir()
    const { fetch, calls } = makeFetch()
    let asked = ''
    const res = await makeInstaller(dir, fetch, { freeBytes: async (d) => { asked = d; return 1000 } }).inst.install('cpu')
    check(res.error === 'disk' && calls.length === 0 && asked === dir, 'low free space: disk, before any download')
    const need = CONTENT['runtime-cpu'].length + CONTENT['model-small'].length + CONTENT.vad.length + C.EXTRACT_BYTES['runtime-cpu'] + I.DISK_MARGIN_BYTES
    check((await makeInstaller(freshDir(), makeFetch().fetch, { freeBytes: async () => need - 1 }).inst.install('cpu')).error === 'disk', 'one byte short of downloads + extracted runtime + margin: disk')
    check((await makeInstaller(freshDir(), makeFetch().fetch, { freeBytes: async () => need }).inst.install('cpu')).ok, 'exactly enough: ok')
    check((await makeInstaller(freshDir(), makeFetch().fetch, { freeBytes: async () => { throw new Error('ENOSYS') } }).inst.install('cpu')).ok, 'an unknown free space does not block')
  }

  // --- Cancel, busy and resume through relative redirects ----------------------------
  {
    const dir = freshDir()
    const half = 150_000
    let hung = false
    const { fetch } = makeFetch((url, h, signal) => {
      if (URL_ID.get(url) !== 'model-small') return null
      return { status: 200, headers: { 'content-length': String(CONTENT['model-small'].length) }, body: (async function* () { yield CONTENT['model-small'].subarray(0, half); hung = true; await waitAbort(signal) })() }
    })
    const { inst, events } = makeInstaller(dir, fetch)
    const p = inst.install('cpu')
    while (!hung) await flush()
    for (let i = 0; i < 5; i++) await flush()
    check(inst.busy, 'busy while installing')
    check((await inst.install('gpu')).error === 'busy' && (await inst.install('cpu')).error === 'busy', 'a second install answers busy')
    check((await inst.remove('cpu', () => false)).error === 'busy', 'remove during an install answers busy')
    inst.cancel('gpu')
    check(inst.busy, 'cancel of another pack does nothing')
    inst.cancel('cpu')
    const res = await p
    check(res.error === 'cancelled' && events.at(-1).phase === 'error' && events.at(-1).error === 'cancelled' && !inst.busy, 'cancel: cancelled, not busy any more')
    check(fs.statSync(path.join(dir, 'downloads', 'model-small.part')).size === half, 'cancel keeps the .part')
    check(inst.installed().has('runtime-cpu') && !inst.installed().has('model-small'), 'finished assets stay installed')
    check(inst.status().install.error === 'cancelled', 'status keeps the last install state')

    // Resume: the pinned HF URL redirects to a relative path, then to the CDN.
    const hf = C.ASSETS['model-small'].url
    const r2 = makeFetch((url, h, signal) => {
      if (url === hf) return { status: 302, headers: { location: '/api/resolve-cache/models/ggerganov/whisper.cpp/x/ggml-small-q5_1.bin' }, body: chunksOf(Buffer.alloc(0)) }
      if (url.startsWith('https://huggingface.co/api/resolve-cache/')) return { status: 307, headers: { location: 'https://us.aws.cdn.hf.co/xet/abc?sig=1' }, body: chunksOf(Buffer.alloc(0)) }
      if (url.startsWith('https://us.aws.cdn.hf.co/')) return serve(CONTENT['model-small'], h, signal)
      return null
    })
    const resumed = makeInstaller(dir, r2.fetch)
    const ok = await resumed.inst.install('cpu')
    check(ok.ok, `resume ok (${JSON.stringify(ok)})`)
    const hops = r2.calls.filter((c) => /huggingface|hf\.co/.test(c.url) && !c.url.includes('silero'))
    check(hops.length === 3 && hops[1].url === 'https://huggingface.co/api/resolve-cache/models/ggerganov/whisper.cpp/x/ggml-small-q5_1.bin', 'the relative Location resolves against the current URL')
    check(hops.every((c) => c.headers.Range === `bytes=${half}-`), 'Range is sent on every hop')
    check(!r2.calls.some((c) => c.url === C.ASSETS['runtime-cpu'].url), 'installed assets are not downloaded again')
    check(resumed.events.some((e) => e.phase === 'verify'), 'the kept .part is rehashed (verify phase)')
    check(fs.readFileSync(path.join(dir, 'models', 'ggml-small-q5_1.bin')).equals(CONTENT['model-small']), 'the resumed model is byte exact')
  }
  {
    // A server that ignores Range (200) restarts from zero.
    const dir = freshDir()
    fs.mkdirSync(path.join(dir, 'downloads'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'downloads', 'model-small.part'), crypto.randomBytes(1000))
    const { fetch, calls } = makeFetch((url, h, signal) => (URL_ID.get(url) === 'model-small' ? serve(CONTENT['model-small'], {}, signal) : null))
    const res = await makeInstaller(dir, fetch).inst.install('cpu')
    check(res.ok && calls.find((c) => URL_ID.get(c.url) === 'model-small').headers.Range === 'bytes=1000-', 'a 200 answer to a Range request truncates the .part and the hash')
  }
  {
    // A 206 for the wrong offset restarts once without Range.
    const dir = freshDir()
    fs.mkdirSync(path.join(dir, 'downloads'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'downloads', 'model-small.part'), CONTENT['model-small'].subarray(0, 1000))
    const { fetch, calls } = makeFetch((url, h, signal) => {
      if (URL_ID.get(url) !== 'model-small' || !h.Range) return null
      return { status: 206, headers: { 'content-range': `bytes 0-${CONTENT['model-small'].length - 1}/${CONTENT['model-small'].length}` }, body: chunksOf(CONTENT['model-small'], signal) }
    })
    const res = await makeInstaller(dir, fetch).inst.install('cpu')
    const smalls = calls.filter((c) => URL_ID.get(c.url) === 'model-small')
    check(res.ok && smalls.length === 2 && smalls[0].headers.Range === 'bytes=1000-' && !smalls[1].headers.Range, 'a 206 with the wrong Content-Range restarts from zero')
  }
  {
    // A complete .part: 416 goes straight to the check.
    const dir = freshDir()
    fs.mkdirSync(path.join(dir, 'downloads'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'downloads', 'vad.part'), CONTENT.vad)
    const { fetch, calls } = makeFetch()
    const res = await makeInstaller(dir, fetch).inst.install('cpu')
    const vad = calls.find((c) => URL_ID.get(c.url) === 'vad')
    check(res.ok && vad.headers.Range === `bytes=${CONTENT.vad.length}-`, 'a complete .part: Range past the end, 416, verified, installed')
    // Same size but wrong bytes: 416, then sha256 and the .part goes.
    const dir2 = freshDir()
    fs.mkdirSync(path.join(dir2, 'downloads'), { recursive: true })
    fs.writeFileSync(path.join(dir2, 'downloads', 'vad.part'), crypto.randomBytes(CONTENT.vad.length))
    const res2 = await makeInstaller(dir2, makeFetch().fetch).inst.install('cpu')
    check(res2.error === 'sha256' && !exists(path.join(dir2, 'downloads', 'vad.part')), 'a complete but corrupt .part: sha256, deleted')
    check((await makeInstaller(dir2, makeFetch().fetch).inst.install('cpu')).ok, 'the next install downloads it again')
    // A .part larger than the asset is dropped.
    const dir3 = freshDir()
    fs.mkdirSync(path.join(dir3, 'downloads'), { recursive: true })
    fs.writeFileSync(path.join(dir3, 'downloads', 'vad.part'), Buffer.alloc(CONTENT.vad.length + 5))
    const r3 = makeFetch()
    check((await makeInstaller(dir3, r3.fetch).inst.install('cpu')).ok && !r3.calls.find((c) => URL_ID.get(c.url) === 'vad').headers.Range, 'an oversize .part is deleted and downloaded from zero')
  }

  // --- Extraction failures -----------------------------------------------------------
  {
    const dir = freshDir()
    const res = await makeInstaller(dir, makeFetch().fetch, { extract: async () => { throw new Error('tar exit 1') } }).inst.install('cpu')
    check(res.error === 'extract', 'tar failing: extract')
    check(fs.readdirSync(path.join(dir, 'runtime')).length === 0, 'no target and no .tmp-* folder left')
    check(fs.statSync(path.join(dir, 'downloads', 'runtime-cpu.part')).size === CONTENT['runtime-cpu'].length, 'the verified zip is kept for the next try')
    const dir2 = freshDir()
    const res2 = await makeInstaller(dir2, makeFetch().fetch, { extract: async (zip, dest, members) => { for (const m of members.slice(1)) fs.writeFileSync(path.join(dest, I.strippedMember(m)), 'x') } }).inst.install('cpu')
    check(res2.error === 'extract' && fs.readdirSync(path.join(dir2, 'runtime')).length === 0, 'a member missing after tar: extract, tmp folder removed')
  }

  // --- Progress throttle -------------------------------------------------------------
  {
    const content = { ...CONTENT, 'model-small': crypto.randomBytes(2_000_000) }
    const catalog = catalogFor(content)
    const fixed = makeInstaller(freshDir(), makeFetch(null, content).fetch, { catalog, now: () => 1000 })
    await fixed.inst.install('cpu')
    const chunks = Math.ceil(content['model-small'].length / 65536)
    const dl = fixed.events.filter((e) => e.phase === 'download').length
    check(dl <= 6 && chunks > 20, `throttled: ${dl} download events for ${chunks} chunks at a fixed clock`)
    let t = 0
    const moving = makeInstaller(freshDir(), makeFetch(null, content).fetch, { catalog, now: () => (t += 300) })
    await moving.inst.install('cpu')
    check(moving.events.filter((e) => e.phase === 'download').length > chunks, 'one event per chunk once 250 ms passed')
    check(fixed.events.at(-1).phase === 'done', 'the final state is always emitted')
  }

  // --- GPU pack, warmup, remove ------------------------------------------------------
  {
    const dir = freshDir()
    fs.cpSync(cpuDir, dir, { recursive: true })
    const order = []
    let inside = null
    const { fetch, calls } = makeFetch()
    let inst
    const made = makeInstaller(dir, fetch, {
      warmup: async (pack) => {
        order.push(`warmup:${pack}`)
        inside = { warming: inst.warming, status: inst.status().warming, busy: inst.busy, remove: (await inst.remove('gpu', () => false)).error, installed: inst.installed().has('model-turbo') }
        return true
      },
    })
    inst = made.inst
    const res = await inst.install('gpu')
    check(res.ok, `gpu install ok (${JSON.stringify(res)})`)
    check(calls.map((c) => URL_ID.get(c.url)).join() === 'runtime-cuda,model-turbo', 'only the CUDA runtime and turbo are downloaded on top of cpu')
    check(order.join() === 'warmup:gpu' && inside.warming && inside.status && inside.busy && inside.remove === 'busy' && inside.installed, 'warmup runs once with the files installed; warming and busy meanwhile, remove refused')
    check(!inst.warming && !inst.busy, 'warming clears after the warmup')
    const phases = [...new Set(made.events.map((e) => e.phase))]
    check(phases.join() === 'download,extract,warmup,done', `gpu phases end with warmup, done (${phases})`)
    check(fs.readdirSync(path.join(dir, 'runtime', 'cuda124-b5454')).length === 17, 'runtime/cuda124-b5454 has the 17 members')
    check(inst.status().packs.every((p) => p.installed), 'both packs installed')

    // Warmup failure keeps the files.
    const failDir = freshDir()
    fs.cpSync(dir, failDir, { recursive: true })
    for (const warmup of [async () => false, async () => { throw new Error('crash') }]) {
      const f = makeInstaller(failDir, makeFetch().fetch, { warmup })
      const r = await f.inst.install('gpu')
      check(r.error === 'warmup' && f.events.at(-1).error === 'warmup' && f.inst.installed().has('runtime-cuda') && !f.inst.warming, 'a failed warmup: warmup, files stay')
    }

    // Remove.
    fs.mkdirSync(path.join(dir, 'cuda-cache', 'ComputeCache'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'cuda-cache', 'ComputeCache', 'index'), 'jit')
    fs.mkdirSync(path.join(dir, 'downloads'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'downloads', 'model-turbo.part'), 'partial')
    const r1 = await inst.remove('cpu', () => false)
    check(r1.ok && inst.installed().size === 5, 'removing cpu while gpu is installed deletes nothing')
    check((await inst.remove('gpu', { inUse: () => true })).error === 'busy' && inst.installed().size === 5, 'remove while a session runs: busy')
    let started = false
    const rRace = await inst.remove('gpu', { inUse: () => started, awaitExit: async () => { started = true } })
    check(rRace.error === 'busy' && inst.installed().size === 5 && exists(path.join(dir, 'runtime', 'cuda124-b5454')) && !inst.busy, 'a session that began while the server went down: busy, nothing deleted, the record kept')
    const seq = []
    const r2 = await inst.remove('gpu', { inUse: () => false, awaitExit: async () => { seq.push('exit'); seq.push(exists(path.join(dir, 'runtime', 'cuda124-b5454')) ? 'files-there' : 'files-gone') } })
    check(r2.ok && seq.join() === 'exit,files-there', 'awaitExit runs before any file is deleted')
    const have = inst.installed()
    check(have.size === 3 && C.PACKS.cpu.every((id) => have.has(id)), 'removing gpu keeps the shared cpu assets')
    check(!exists(path.join(dir, 'runtime', 'cuda124-b5454')) && !exists(path.join(dir, 'models', 'ggml-large-v3-turbo-q8_0.bin')) && !exists(path.join(dir, 'downloads', 'model-turbo.part')), 'the CUDA runtime, turbo and its .part are gone')
    check(!exists(path.join(dir, 'cuda-cache')), 'cuda-cache goes with the last GPU pack')
    check(Object.keys(readJson(path.join(dir, 'installed.json')).assets).sort().join() === 'model-small,runtime-cpu,vad', 'installed.json rewritten')
    const r3 = await inst.remove('cpu', { inUse: () => false })
    check(r3.ok && inst.installed().size === 0 && fs.readdirSync(path.join(dir, 'models')).length === 0 && fs.readdirSync(path.join(dir, 'runtime')).length === 0, 'removing cpu last empties models/ and runtime/')
    check(Object.keys(readJson(path.join(dir, 'installed.json')).assets).length === 0, 'installed.json is empty')
    const r4 = await inst.remove('gpu', { inUse: () => false, awaitExit: async () => { throw new Error('still running') } })
    check(r4.error === 'busy' && !inst.busy, 'a server that does not exit: busy, and the installer is free again')
    check(cleanLog(made.logs, dir), `gpu log: codes only (${made.logs.join(' | ')})`)
  }
  {
    // A locked file: rm keeps failing with EBUSY, remove answers busy and the record already dropped it.
    const dir = freshDir()
    fs.cpSync(cpuDir, dir, { recursive: true })
    const realRm = fs.promises.rm
    const { inst } = makeInstaller(dir, makeFetch().fetch)
    fs.promises.rm = async (p, o) => { if (String(p).includes('cpu-b5454')) throw Object.assign(new Error('locked'), { code: 'EBUSY' }); return realRm(p, o) }
    let r
    try { r = await inst.remove('cpu', () => false) } finally { fs.promises.rm = realRm }
    check(r.error === 'busy' && !inst.installed().has('runtime-cpu'), 'locked DLLs: busy after the retries, and the asset is no longer installed')
    check((await makeInstaller(dir, makeFetch().fetch).inst.install('cpu')).ok, 'the next install replaces the leftovers')
  }

  // --- netFetch over a fake Electron net -----------------------------------------------
  {
    const reqs = []
    const fakeNet = {
      request(opts) {
        const ev = new EventEmitter()
        const r = { opts, headers: {}, aborted: 0, ended: 0, setHeader(k, v) { this.headers[k] = v }, on(n, cb) { ev.on(n, cb); return this }, emit: (...a) => ev.emit(...a), abort() { this.aborted++ }, end() { this.ended++ } }
        reqs.push(r)
        return r
      },
    }
    const N = load('src/main/dictation/whisper/netFetch.ts', { require: (m) => (m === 'electron' ? { net: fakeNet } : require(m)) })
    const ac = new AbortController()
    const p1 = N.netFetch('https://github.com/a', { Range: 'bytes=5-' }, ac.signal)
    const q = reqs.at(-1)
    check(q.opts.redirect === 'manual' && q.opts.method === 'GET' && q.opts.cache === 'no-store' && q.headers.Range === 'bytes=5-' && q.ended === 1, 'net.request: GET, manual redirects, no cache, headers set, sent')
    q.emit('redirect', 302, 'GET', 'https://objects.githubusercontent.com/x', { location: ['/x'] })
    const red = await p1
    check(red.status === 302 && red.headers.location === 'https://objects.githubusercontent.com/x' && q.aborted === 1, 'a redirect resolves with its location and is never followed')
    const it0 = red.body[Symbol.asyncIterator]()
    check((await it0.next()).done, 'a redirect has an empty body')

    const p2 = N.netFetch('https://github.com/b', {}, ac.signal)
    const q2 = reqs.at(-1)
    const res = new EventEmitter()
    res.statusCode = 206
    res.headers = { 'Content-Range': ['bytes 0-5/6'], 'content-length': '6' }
    let paused = 0
    let resumed = 0
    res.pause = () => { paused++ }
    res.resume = () => { resumed++ }
    q2.emit('response', res)
    const r2 = await p2
    check(r2.status === 206 && r2.headers['content-range'] === 'bytes 0-5/6' && r2.headers['content-length'] === '6', 'response headers lower-cased, arrays flattened')
    for (let i = 0; i < 70; i++) res.emit('data', Buffer.from([i]))
    check(paused === 1, 'the response pauses when chunks pile up')
    res.emit('end')
    const got = []
    for await (const c of r2.body) got.push(...c)
    check(got.length === 70 && got[69] === 69 && resumed === 1, 'every chunk in order; the response resumes once drained')

    const p3 = N.netFetch('https://github.com/c', {}, ac.signal)
    const q3 = reqs.at(-1)
    const res3 = new EventEmitter()
    res3.statusCode = 200
    res3.headers = {}
    q3.emit('response', res3)
    const r3 = await p3
    const it = r3.body[Symbol.asyncIterator]()
    res3.emit('data', Buffer.from('ab'))
    check(Buffer.from((await it.next()).value).toString() === 'ab', 'body yields data as it arrives')
    const pending = it.next()
    ac.abort()
    let threw = false
    await pending.catch(() => { threw = true })
    check(threw && q3.aborted >= 1, 'aborting the signal aborts the request and fails the body')

    const ac2 = new AbortController()
    const p4 = N.netFetch('https://github.com/d', {}, ac2.signal)
    reqs.at(-1).emit('error', new Error('net::ERR_PROXY_CONNECTION_FAILED'))
    check(await p4.then(() => false, () => true), 'a request error before the response rejects')
    const before = reqs.length
    check(await N.netFetch('https://github.com/e', {}, ac.signal).then(() => false, () => true) && reqs.length === before, 'an aborted signal rejects without a request')
    const ac3 = new AbortController()
    const p5 = N.netFetch('https://github.com/f', {}, ac3.signal)
    ac3.abort()
    check(await p5.then(() => false, () => true) && reqs.at(-1).aborted === 1, 'aborting before the response aborts the request')
  }

  // --- Real tar.exe (Windows) ---------------------------------------------------------
  const tarExe = I.defaultTarPath()
  if (process.platform === 'win32' && fs.existsSync(tarExe)) {
    const extract = I.extractWithTar(tarExe)
    const dir = freshDir('whisper data ñ')
    const { inst } = makeInstaller(dir, makeFetch().fetch, { extract })
    const res = await inst.install('cpu')
    check(res.ok, `real tar: cpu install ok (${JSON.stringify(res)})`)
    const target = path.join(dir, 'runtime', 'cpu-b5454')
    const files = fs.readdirSync(target).sort()
    check(files.length === 13 && !files.includes('manifest.json') && !files.includes('Release'), 'real tar: exactly the 13 members, flat, under a path with a space and a non-ASCII letter')
    const decoded = Z.decodeZip(CONTENT['runtime-cpu'])
    check(decoded.entries.every((e) => fs.readFileSync(path.join(target, I.strippedMember(e.name))).equals(e.data)), 'real tar: byte exact')
    check(fs.readdirSync(path.join(dir, 'runtime')).join() === 'cpu-b5454' && fs.readdirSync(path.join(dir, 'downloads')).length === 0, 'real tar: no tmp folder, zip deleted')

    // A zip that lacks one member (but matches its catalog hash): tar fails, extract.
    const short = { ...CONTENT, 'runtime-cpu': zipOf(C.ASSETS['runtime-cpu'].members.slice(1)) }
    const dir2 = freshDir('whisper')
    const r2 = await makeInstaller(dir2, makeFetch(null, short).fetch, { extract, catalog: catalogFor(short) }).inst.install('cpu')
    check(r2.error === 'extract' && fs.readdirSync(path.join(dir2, 'runtime')).length === 0, 'real tar: a missing member fails with extract and leaves no folder')
    const ac = new AbortController()
    ac.abort()
    check(await extract(path.join(dir2, 'downloads', 'runtime-cpu.part'), dir2, ['Release/x'], ac.signal).then(() => false, () => true), 'extractWithTar: an aborted signal never spawns')
  } else {
    console.log('test-whisper-install: real tar.exe part skipped (not Windows)')
  }

  // --- Sources: no dashes, no Electron in the installer -------------------------------
  for (const f of ['WhisperInstaller.ts', 'netFetch.ts']) {
    const src = fs.readFileSync(path.join(root, 'src/main/dictation/whisper', f), 'utf8')
    const dashes = String.fromCharCode(0x2013, 0x2014)
    check(![...src].some((ch) => dashes.includes(ch)) && src.charCodeAt(0) !== 0xfeff, `${f}: no em or en dash, no BOM`)
  }
  check(!/from 'electron'/.test(fs.readFileSync(path.join(root, 'src/main/dictation/whisper/WhisperInstaller.ts'), 'utf8')), 'WhisperInstaller.ts imports nothing from electron')

  fs.rmSync(tmpRoot, { recursive: true, force: true })
  console.log(`test-whisper-install: ${checks} checks passed`)
}

main().catch((e) => {
  console.error(e)
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  process.exitCode = 1
})
