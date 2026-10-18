// Headless mirror bench (E6-FR-07, NFR "Performance (main)"), outside the CI
// gate: `npm run bench:terminal`. 8 mirrors fed a Claude-like stream at about
// 50 KB/s each for 30 simulated seconds, the snapshot of 2000 x 120, memory per
// mirror, and a burst of 12 reattaches in 'lazy' (each seeds its mirror from a
// full 256 KB ring, then serializes). Prints every number; exits 1 when the
// parse throughput is under 20 MB/s or the burst blocks main over 1000 ms.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const path = require('node:path')
const root = path.resolve(__dirname, '..')

function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws', 'node-pty', '@xterm/headless', '@xterm/addon-serialize', '@xterm/addon-unicode11'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval, ...overrides })
  return mod.exports
}

const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6
const p95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] || 0 }
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)

/** A Claude Code like burst: truecolor text, a spinner redraw (cursor up + erase), a box, wide chars. */
function claudeChunk(i) {
  const color = `\x1b[38;2;${(i * 37) % 255};${(i * 11) % 255};200m`
  let s = ''
  for (let l = 0; l < 6; l++) s += `${color}${'The quick brown fox jumps over the lazy dog '.repeat(2)}\x1b[0m ${l % 2 ? 'é😀漢' : ''}\r\n`
  s += `\x1b[2A\x1b[2K\x1b[38;2;215;119;87m✻\x1b[0m Thinking… (${i}s · esc to interrupt)\r\n\x1b[2K`
  s += '╭' + '─'.repeat(70) + '╮\r\n│ \x1b[1m>\x1b[0m ' + ' '.repeat(66) + '│\r\n╰' + '─'.repeat(70) + '╯\x1b[2A\x1b[5G'
  return s
}

async function main() {
  const { HeadlessMirror } = load('src/main/pty/HeadlessMirror.ts')
  let failed = false

  // 1. Parse: 8 mirrors x 30 s x 50 KB/s, one flush every 80 ms (~4 KB).
  const PANES = 8, SECONDS = 30, RATE = 50 * 1024, FLUSH_MS = 80
  const mirrors = Array.from({ length: PANES }, () => new HeadlessMirror({ cols: 120, rows: 40, scrollback: 2000, unicode11: true }))
  const perFlush = Math.round(RATE * FLUSH_MS / 1000)
  let stream = ''
  for (let i = 0; stream.length < RATE * SECONDS; i++) stream += claudeChunk(i)
  // warm up the JIT on a separate mirror
  const warm = new HeadlessMirror({ cols: 120, rows: 40, scrollback: 2000, unicode11: true })
  warm.write(stream.slice(0, 2 * 1024 * 1024)); warm.dispose()
  const parse = []
  let parsed = 0, totalParseMs = 0
  for (let off = 0; off < RATE * SECONDS; off += perFlush) {
    const chunk = stream.slice(off, off + perFlush)
    for (const m of mirrors) {
      const t0 = process.hrtime.bigint()
      m.write(chunk)
      const d = ms(t0)
      parse.push(d); totalParseMs += d; parsed += chunk.length
    }
  }
  const throughput = parsed / 1024 / 1024 / (totalParseMs / 1000)
  const cpu = totalParseMs / (SECONDS * 1000) * 100
  console.log(`parse: ${mb(parsed)} MB in ${totalParseMs.toFixed(0)} ms -> ${throughput.toFixed(1)} MB/s (budget >= 20), p95 ${p95(parse).toFixed(3)} ms per ${perFlush} B flush (budget 2 ms), ${cpu.toFixed(2)}% of a core for ${PANES} panes at 50 KB/s (budget 5%)`)
  if (throughput < 20) failed = true

  // 2. Snapshot of 2000 lines x 120 columns, and the cache-hit path (a string reuse).
  const snaps = []
  for (let i = 0; i < 30; i++) { const t0 = process.hrtime.bigint(); mirrors[0].snapshot({ scrollback: 2000, purpose: 'replay' }); snaps.push(ms(t0)) }
  const persist = []
  for (let i = 0; i < 10; i++) { const t0 = process.hrtime.bigint(); mirrors[0].snapshot({ scrollback: 2000, purpose: 'persist' }); persist.push(ms(t0)) }
  const size = mirrors[0].snapshot({ scrollback: 2000, purpose: 'replay' }).data.length
  console.log(`snapshot: replay p95 ${p95(snaps).toFixed(1)} ms (budget 25 ms, ${(size / 1024).toFixed(0)} KB), persist p95 ${p95(persist).toFixed(1)} ms`)

  // 3. Memory per mirror at 120x40 with 2000 and 5000 lines (full scrollback).
  for (const lines of [2000, 5000]) {
    global.gc?.()
    const before = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers
    const set = Array.from({ length: 4 }, () => new HeadlessMirror({ cols: 120, rows: 40, scrollback: lines, unicode11: true }))
    let fill = ''
    for (let i = 0; i < lines + 100; i++) fill += `\x1b[38;2;${i % 255};80;160m${'x'.repeat(110)}\x1b[0m\r\n`
    for (const m of set) m.write(fill)
    global.gc?.()
    const after = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers
    console.log(`memory: ~${mb((after - before) / set.length)} MB per mirror with ${lines} lines (budget ${lines === 2000 ? 4 : 10} MB)${global.gc ? '' : ' (run node --expose-gc for a stable number)'}`)
    for (const m of set) m.dispose()
  }
  for (const m of mirrors) m.dispose()

  // 4. win.reload() with 12 panes in 'lazy': each reattach seeds a 256 KB ring, then serializes.
  let current = null
  const { PtyManager } = load('src/main/pty/PtyManager.ts', {
    require: (id) => id === 'node-pty' ? { spawn: (...a) => current(...a) } : id === 'electron' ? { app: { getPath: () => require('node:os').tmpdir() } } : require(id),
    console: { ...console, warn() {} },
  })
  const procs = []
  current = (_shell, _args, opts) => {
    const cbs = []
    const proc = { cols: opts.cols, rows: opts.rows, onData: (cb) => cbs.push(cb), onExit() {}, write() {}, resize() {}, pause() {}, resume() {}, kill() {}, emit: (d) => cbs.forEach((cb) => cb(d)) }
    procs.push(proc)
    return proc
  }
  const pm = new PtyManager(() => null)
  pm.setEngine({ snapshotMode: 'lazy' })
  for (let p = 0; p < 12; p++) {
    pm.spawn({ paneId: `pane-${p}`, cols: 120, rows: 40 })
    for (let off = 0; off < 300 * 1024; off += 4096) procs[p].emit(stream.slice(off, off + 4096))
  }
  await new Promise((r) => setTimeout(r, 300))
  const t0 = process.hrtime.bigint()
  const each = []
  for (let p = 0; p < 12; p++) { const t1 = process.hrtime.bigint(); pm.reattach(`pane-${p}`); each.push(ms(t1)) }
  const burst = ms(t0)
  console.log(`reload burst (lazy, 12 panes x 256 KB ring): ${burst.toFixed(0)} ms total (budget 1000 ms), worst pane ${Math.max(...each).toFixed(0)} ms (budget 150 ms)`)
  if (burst > 1000) failed = true
  const metrics = pm.headlessMetrics()
  console.log(`metrics: ${JSON.stringify(metrics)}`)
  pm.killAll()

  console.log(failed ? 'FAIL: headless bench over budget' : 'PASS: headless bench within the gated budgets')
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
