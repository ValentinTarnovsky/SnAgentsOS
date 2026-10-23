// Terminal engine (E6): ModeTracker, replay hygiene, the exit frame, the
// in-place restart and the exited record, the phone exit strip state and the
// default shell resolution, the saved scrollback (store, checkpoint, seed),
// against the real main-process modules with a fake
// node-pty. xterm and its addons are pinned exact: a bump must pass this suite.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws', 'node-pty', '@xterm/headless', '@xterm/addon-serialize', '@xterm/addon-unicode11'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval, ...overrides })
  return mod.exports
}

// --- pinned versions -------------------------------------------------------
{
  const pkg = require(path.join(root, 'package.json'))
  check(pkg.dependencies['@xterm/xterm'] === '5.5.0', '@xterm/xterm pinned exact at 5.5.0 (never move to 6)')
  check(pkg.dependencies['@xterm/addon-canvas'] === '0.7.0', '@xterm/addon-canvas pinned exact at 0.7.0')
  check(pkg.dependencies['@xterm/addon-unicode11'] === '0.8.0', '@xterm/addon-unicode11 pinned exact at 0.8.0')
}

// --- ModeTracker (E6-FR-33) -------------------------------------------------
const { ModeTracker } = load('src/main/pty/ModeTracker.ts')
{
  const t = new ModeTracker()
  check(t.rehydrate() === '' && t.altScreen === false, 'fresh tracker has nothing to rehydrate')
  t.feed('hello \x1b[?2004h world \x1b[?25l')
  check(t.rehydrate() === '\x1b[?25l\x1b[?2004h', 'simple DECSET/DECRST modes tracked')
  t.feed('\x1b[?25h\x1b[?2004l')
  check(t.rehydrate() === '', 'resetting returns to defaults')
  t.feed('\x1b[?1000;1006h')
  check(t.rehydrate() === '\x1b[?1000h\x1b[?1006h', 'parameter lists set every listed mode')
  t.feed('\x1b[?1002h')
  check(t.rehydrate() === '\x1b[?1002h\x1b[?1006h', 'a new mouse protocol replaces the previous one')
  t.feed('\x1b[?1000l')
  check(t.rehydrate() === '\x1b[?1006h', 'resetting any mouse protocol clears the active one (xterm.js)')
  t.feed('\x1b[?1006l')
  check(t.rehydrate() === '', 'encoding reset')
}
{
  const t = new ModeTracker()
  t.feed('\x1b[?10'); t.feed('06h')
  check(t.rehydrate() === '\x1b[?1006h', 'a sequence split across chunks is registered')
  const seq = '\x1b[?1;9;1004;1015h'
  for (const ch of seq) t.feed(ch)
  check(t.rehydrate() === '\x1b[?1h\x1b[?9h\x1b[?1015h\x1b[?1006h\x1b[?1004h', 'byte-by-byte feeding gives the same state')
  t.feed('\x1b'); t.feed('c')
  check(t.rehydrate() === '', 'RIS split across chunks resets everything')
}
{
  const t = new ModeTracker()
  t.feed('\x1b[?1049h\x1b[?1049l')
  check(!t.altScreen && t.rehydrate() === '', '?1049h then ?1049l in one chunk ends inactive')
  t.feed('\x1b[?1000h\x1b[?2004h\x1b[?1049h')
  check(t.altScreen && t.rehydrate().startsWith('\x1b[?1049h'), 'alt screen is rehydrated first')
  t.feed('\x1b[?25l\x1b[!p')
  check(t.rehydrate() === '\x1b[?1049h\x1b[?1000h', 'DECSTR resets cursor/paste modes but keeps mouse and alt (xterm.js)')
  t.feed('\x1bc')
  check(!t.altScreen && t.rehydrate() === '', 'RIS clears alt screen and mouse')
}
{
  const t = new ModeTracker()
  t.feed('\x1b[?' + '1'.repeat(40) + 'h\x1b[?2004h')
  check(t.rehydrate() === '\x1b[?2004h', 'an oversized parameter list is dropped without breaking the next sequence')
  t.feed('\x1b[?1000\x1b[?1006h')
  check(t.rehydrate() === '\x1b[?1006h\x1b[?2004h', 'ESC inside a sequence restarts parsing')
  t.feed('\x1b[1000h\x1b[38;2;1;2;3m\x1b]0;?1000h\x07')
  check(t.rehydrate() === '\x1b[?1006h\x1b[?2004h', 'non-private CSI, SGR and OSC text are ignored')
  t.feed('\x1b[?1000$p')
  check(!t.rehydrate().includes('1000h'), 'DECRQM is not a mode change')
}
{
  const t = new ModeTracker()
  const line = 'x'.repeat(70) + '\x1b[38;2;10;20;30mcolor\x1b[0m\r\n'
  const chunk = line.repeat(Math.ceil(65536 / line.length)).slice(0, 65536)
  for (let i = 0; i < 20; i++) t.feed(chunk)
  const start = process.hrtime.bigint()
  const rounds = 50
  for (let i = 0; i < rounds; i++) t.feed(chunk)
  const perFlushMs = Number(process.hrtime.bigint() - start) / 1e6 / rounds
  console.log(`  ModeTracker: ${perFlushMs.toFixed(3)} ms per 64 KB flush (budget 0.2 ms)`)
  // CI machines vary; the hard gate is loose, the budget is printed above.
  check(perFlushMs < 2, 'ModeTracker stays far below 2 ms per 64 KB flush')
}

// --- replay hygiene ---------------------------------------------------------
const { sanitizeQueries } = load('src/main/pty/ansiSanitize.ts')
{
  const raw = 'a\x1b[c b\x1b[0c c\x1b[>c d\x1b[>0c e\x1b[=c f\x1b[6n g\x1b[5n h\x1b[?6n i\x1b[14t j\x1b[18;0;0t k\x1b[?2004$p l\x1b[>q m\x1b[?u n'
  check(sanitizeQueries(raw) === 'a b c d e f g h i j k l m n', 'DA1/DA2/DA3, DSR, window reports, DECRQM, XTVERSION and kitty queries are removed')
  const keep = '\x1b[?25l\x1b[38;2;255;0;0mred\x1b[0m\x1b[2J\x1b[H\x1b[?1049h\x1b[>1u\x1b]0;title\x07'
  check(sanitizeQueries(keep) === keep, 'SGR, modes, cursor moves, kitty push and OSC are kept')
  const osc = 'a\x1b]11;?\x1b\\b\x1b]10;?;?\x07c\x1b]4;1;?;2;?\x07d\x1bP$qm\x1b\\e'
  check(sanitizeQueries(osc) === 'abcde', 'OSC 4/10/11 color queries and DECRQSS (answered by xterm.js 5.5) are removed')
  const sets = '\x1b]11;#101010\x07\x1b]4;1;rgb:ff/00/00\x1b\\\x1bPqsixel\x1b\\\x1b]8;;https://x\x07'
  check(sanitizeQueries(sets) === sets, 'color sets, other DCS and hyperlinks are kept')
}
let current = null
// PtyManager's console: warnings are muted, a case can swap `warn` to count them.
const ptyConsole = { ...console, warn() {} }
const loaded = load('src/main/pty/PtyManager.ts', {
  require: id => id === 'node-pty' ? { spawn: (...a) => current.impl(...a) } : id === 'electron' ? { app: { getPath: () => os.tmpdir() } } : require(id),
  console: ptyConsole,
})
const { trimRingHead } = loaded
{
  check(trimRingHead('abc', false) === 'abc', 'an untruncated ring is the stream start and stays whole')
  check(trimRingHead(';2;255mjunk\r\nline two', true) === 'line two', 'a truncated head mid-escape starts after the first line break')
  const crOnly = '5mtail\r\x1b[2Kframe 1\r\x1b[2Kframe 2'
  check(trimRingHead(crOnly, true) === '\x1b[2Kframe 1\r\x1b[2Kframe 2', 'a ring without line breaks starts at the first ESC, not empty')
  const noBoundary = 'z'.repeat(9000) + '\n' + 'rest'
  check(trimRingHead(noBoundary, true) === noBoundary, 'no boundary near the head keeps the ring rather than dropping it')
}

// --- PtyManager with a fake node-pty ------------------------------------------
function fakeHarness() {
  const procs = []
  const sent = []
  const spawnCalls = []
  const impl = (shell, args, opts) => {
    spawnCalls.push({ shell, args, opts })
    const dataCbs = [], exitCbs = []
    const proc = {
      cols: opts.cols, rows: opts.rows, writes: [], killed: false,
      onData: cb => dataCbs.push(cb), onExit: cb => exitCbs.push(cb),
      write: d => proc.writes.push(d), resize: (c, r) => { proc.cols = c; proc.rows = r },
      pause() {}, resume() {},
      // Worst case for the natural flag: killing fires onExit synchronously.
      kill: () => { proc.killed = true; proc.exit(1) },
      emit: d => dataCbs.forEach(cb => cb(d)),
      exit: code => exitCbs.forEach(cb => cb({ exitCode: code })),
    }
    procs.push(proc)
    return proc
  }
  return { impl, procs, sent, spawnCalls }
}
// The ring-replay cases run with the mirror off (E6-FR-01 kill switch); the
// headless cases below pass their own engine settings.
function manager(engine = { snapshotMode: 'off' }) {
  current = fakeHarness()
  const pm = new loaded.PtyManager(() => ({ isDestroyed: () => false, send: (ch, p) => current.sent.push({ ch, p }) }))
  pm.setEngine(engine)
  return { pm, h: current }
}
const flushAll = () => new Promise(r => setTimeout(r, 30))

async function main() {
  // Spawn result + shell resolution wiring (E6-FR-32).
  {
    const { pm, h } = manager()
    const res = pm.spawn({ paneId: 'p1', cols: 80, rows: 24 })
    check(typeof res.ptyId === 'string' && ['powershell', 'posix', 'other', 'cmd'].includes(res.shellKind) && !res.warning, 'spawn without a shell uses the OS default, no warning')
    const missing = process.platform === 'win32' ? 'C:\\snaos-nope\\noexiste.exe' : '/snaos-nope/noexiste'
    const bad = pm.spawn({ paneId: 'p2', shell: missing, cols: 80, rows: 24 })
    check(bad.warning && bad.warning.kind === 'shellNotFound' && bad.warning.requested === missing, 'a missing configured shell reports shellNotFound')
    check(h.spawnCalls[1].shell === bad.warning.used && h.spawnCalls[1].shell !== missing, 'the default shell is what actually gets spawned')
    const real = pm.spawn({ paneId: 'p3', shell: process.execPath, cols: 80, rows: 24 })
    check(!real.warning && h.spawnCalls[2].shell === process.execPath && real.shellKind === 'other', 'an existing absolute shell is used as is')
    pm.killAll()
  }

  // Modes survive the ring (E6-FR-33 / FR-05): emitted before 300 KB of output.
  {
    const { pm, h } = manager()
    const { ptyId } = pm.spawn({ paneId: 'pane', cols: 100, rows: 30 })
    const proc = h.procs[0]
    proc.emit('\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[?25l\x1b[c')
    const line = '\x1b[38;2;200;100;50m' + 'y'.repeat(60) + '\x1b[0m\r\n'
    for (let i = 0; i < 4000; i++) proc.emit(line)
    proc.emit('tail\x1b[6n')
    await flushAll()
    const rep = pm.getReplay('pane')
    check(rep.ptyId === ptyId && rep.cols === 100 && rep.rows === 30, 'getReplay keeps id and live size')
    const prefix = '\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?2004h'
    check(rep.replay.startsWith(prefix), 'replay starts with the modes that scrolled out of the ring')
    const body = rep.replay.slice(prefix.length)
    check(!body.includes('?1000h'), 'the original DECSET really left the 256 KB ring (fixture is meaningful)')
    check(body.startsWith('\x1b[38;2;200;100;50m'), 'a truncated ring head starts on a clean line, no `;2;...m` text')
    check(!body.includes('\x1b[6n') && body.endsWith('tail'), 'queries in the ring are stripped from the replay')
    const re = pm.reattach('pane')
    check(re.replay === rep.replay, 'desktop reattach gets the same replay as phones')
    pm.killAll()
  }
  {
    const { pm, h } = manager()
    pm.spawn({ paneId: 'alt', cols: 80, rows: 24 })
    h.procs[0].emit('\x1b[?1049h\x1b[?1002h')
    for (let i = 0; i < 3000; i++) h.procs[0].emit('\x1b[H' + 'w'.repeat(100) + '\r\n')
    await flushAll()
    check(pm.getReplay('alt').replay.startsWith('\x1b[?1049h\x1b[?1002h'), 'alt screen comes first in the rehydration')
    pm.killAll()
  }
  {
    // vim in a young pane: the ring itself enters the alt screen after shell
    // output, so the prefix must not move that output into the alt buffer.
    const { pm, h } = manager()
    pm.spawn({ paneId: 'vim', cols: 80, rows: 24 })
    h.procs[0].emit('$ ls\r\nfile.txt\r\n$ vim\x1b[?1049h\x1b[?1000;1006h\x1b[Hbuffer')
    await flushAll()
    const rep = pm.getReplay('vim').replay
    check(rep.startsWith('\x1b[?1000h\x1b[?1006h$ ls') && rep.indexOf('\x1b[?1049h') > rep.indexOf('file.txt'), 'an alt-screen entry still in the ring is not prefixed, the other modes are')
    pm.killAll()
  }

  // The exit frame (E6-FR-34) through the real SessionManager sink.
  {
    const { pm, h } = manager()
    const { SessionManager } = load('src/main/remote/SessionManager.ts', { setInterval: () => 0, clearInterval() {} })
    const sm = new SessionManager({ ptyManager: pm })
    const frames = []
    const session = { ws: { readyState: 1, send: s => frames.push(JSON.parse(s)), bufferedAmount: 0 }, authed: true, subs: new Set(), outBuf: new Map(), outTimer: null, congested: new Set(), congestedSince: new Map(), lastSeen: Date.now() }
    const statusExits = []
    pm.addSink(sm)
    pm.addSink({ id: 'status', onSpawn() {}, onData() {}, onExit: (ptyId, paneId, code, info) => statusExits.push({ ptyId, code, ...info }) })
    pm.spawn({ paneId: 'pane', cols: 80, rows: 24 })
    h.procs[0].emit('\x1b[?1000h$ ')
    await flushAll()
    sm.handleSub(session, 'pane')
    const replay = frames.find(f => f.type === 'replay')
    check(replay && replay.running && replay.data.startsWith('\x1b[?1000h'), 'phone replay carries the mouse mode rehydration')
    h.procs[0].emit('bye\r\n')
    h.procs[0].exit(3)
    const exits = frames.filter(f => f.type === 'exit')
    check(exits.length === 1 && exits[0].exitCode === 3 && exits[0].paneId === 'pane', 'a natural exit of the live pty sends exactly one exit frame')
    const outIdx = frames.findIndex(f => f.type === 'out' && f.data.includes('bye'))
    check(outIdx >= 0 && outIdx < frames.indexOf(exits[0]), 'the final output is flushed before the exit frame')
    check(statusExits.at(-1).natural && statusExits.at(-1).current && statusExits.at(-1).code === 3, 'status sink sees the natural exit')

    pm.spawn({ paneId: 'pane', cols: 80, rows: 24 })
    pm.kill(pm.ptyIdForPane('pane'))
    check(frames.filter(f => f.type === 'exit').length === 1, 'kill (fake pty exits synchronously inside kill) sends no exit frame')
    check(statusExits.at(-1).natural === false && statusExits.at(-1).current === true, 'status sink still gets the killed exit to release integrations')

    // A stale pty: the pane rebound to a newer pty, then the old one dies on its own.
    pm.spawn({ paneId: 'pane', cols: 80, rows: 24 })
    const old = h.procs.at(-1)
    pm.spawn({ paneId: 'pane', cols: 80, rows: 24 })
    old.exit(0)
    check(frames.filter(f => f.type === 'exit').length === 1, 'a stale pty exit is not current and sends nothing')
    check(statusExits.at(-1).current === false && statusExits.at(-1).natural === true, 'status sink gets the stale exit flagged not current')
    pm.killAll()
    check(frames.filter(f => f.type === 'exit').length === 1, 'killAll (app quit / close) sends no exit frame')
  }

  // In-place restart (E6-FR-18/19) and the exited record (E6-FR-20/38).
  {
    const { SOFT_RESET, restartTail } = loaded
    const { SessionManager } = load('src/main/remote/SessionManager.ts', { setInterval: () => 0, clearInterval() {} })
    const phone = () => {
      const frames = []
      return { frames, session: { ws: { readyState: 1, send: s => frames.push(JSON.parse(s)), bufferedAmount: 0 }, authed: true, subs: new Set(), outBuf: new Map(), outTimer: null, congested: new Set(), congestedSince: new Map(), lastSeen: Date.now() } }
    }
    const endModes = text => { const t = new ModeTracker(); t.feed(text); return t.rehydrate() }
    check(restartTail('reiniciado 14:32') === SOFT_RESET + '\r\n\x1b[2m--- reiniciado 14:32 ---\x1b[0m\r\n', 'tail = soft reset + gray separator line')
    check(restartTail('a\x1b]0;x\x07b') === SOFT_RESET + '\r\n\x1b[2m--- a]0;xb ---\x1b[0m\r\n', 'control characters in the label are dropped')
    check(endModes('\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[?1h\x1b[?25l\x1b[?1004h\x1b[?9h' + SOFT_RESET) === '', 'SOFT_RESET turns off every mode the ModeTracker knows')

    // Restart of a live pty: same xterm on the desktop, seeded ring for phones.
    const { pm, h } = manager()
    const sm = new SessionManager({ ptyManager: pm })
    const statusExits = []
    pm.addSink(sm)
    pm.addSink({ id: 'status', onSpawn() {}, onData() {}, onExit: (ptyId, paneId, code, info) => statusExits.push({ ptyId, code, ...info }) })
    const first = pm.spawn({ paneId: 'pane', cols: 90, rows: 30 })
    h.procs[0].emit('\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?2004hold output\r\n\x1b[6n$ ')
    await flushAll()
    const p1 = phone()
    sm.handleSub(p1.session, 'pane')
    const res = pm.restart({ paneId: 'pane', cols: 90, rows: 30, initialCommand: 'claude --resume abc' }, 'reiniciado 14:32')
    check(res.ptyId !== first.ptyId && res.tail === restartTail('reiniciado 14:32', 30) && res.tail.endsWith('\n'.repeat(29) + '\x1b[H') && ['powershell', 'posix', 'other', 'cmd'].includes(res.shellKind), 'restart returns the new pty, its tail and shell kind')
    check(h.procs[0].killed && !p1.frames.some(f => f.type === 'exit'), 'the old pty is killed and phones get no exit frame')
    check(statusExits.at(-1).ptyId === first.ptyId && statusExits.at(-1).natural === false && statusExits.at(-1).current === true, 'the status sink still hears the old exit (not natural) to release integrations')
    const oldExit = h.sent.find(s => s.ch === 'pty:exit' && s.p.ptyId === first.ptyId)
    check(oldExit && oldExit.p.natural === false, 'the renderer exit event of the old pty is flagged not natural')
    const seeded = p1.frames.filter(f => f.type === 'replay').at(-1)
    check(seeded.running && seeded.data.includes('old output') && seeded.data.endsWith(res.tail) && seeded.cols === 90, 'phones get a replay seeded with the kept output + tail')
    check(endModes(seeded.data) === '' && !seeded.data.includes('\x1b[6n'), 'the seeded replay ends with no mode on and carries no query')
    const rep = pm.getReplay('pane').replay
    check(rep.includes('old output') && rep.endsWith(res.tail) && endModes(rep) === '', 'a later replay of the new pty starts from the same seed, modes off')
    check(pm.getExited('pane') === null && pm.exitedPaneCodes().size === 0, 'restarting a live pty leaves no exited record')
    h.procs[1].emit('fresh prompt> ')
    await flushAll()
    check(pm.getReplay('pane').replay.endsWith(res.tail + 'fresh prompt> '), 'new output follows the seed')

    // Natural exit: the record, the exit frame, a late subscriber, then a restart from it.
    h.procs[1].emit('\x1b[?2004hbye\r\n')
    h.procs[1].exit(3)
    check(p1.frames.filter(f => f.type === 'exit').length === 1 && p1.frames.at(-1).exitCode === 3, 'a natural exit sends exactly one exit frame')
    const natural = h.sent.find(s => s.ch === 'pty:exit' && s.p.ptyId === res.ptyId)
    check(natural && natural.p.natural === true && natural.p.exitCode === 3, 'the renderer exit event of a natural exit is flagged natural')
    const ex = pm.getExited('pane')
    check(ex && ex.exitCode === 3 && ex.ptyId === res.ptyId && ex.data.includes('bye') && ex.data.endsWith(SOFT_RESET) && endModes(ex.data) === '' && ex.cols === 90, 'a natural exit keeps the clean output with modes off')
    check(pm.exitedPaneCodes().get('pane') === 3 && pm.ptyIdForPane('pane') === null, 'exitedPaneCodes reports it while no pty runs')
    const p2 = phone()
    sm.handleSub(p2.session, 'pane')
    const late = p2.frames.find(f => f.type === 'replay')
    check(late && late.running === false && late.exitCode === 3 && late.data === ex.data, 'subscribing after the exit shows the content + exitCode, not a spinner')
    const res2 = pm.restart({ paneId: 'pane', cols: 90, rows: 30 }, 'restarted 2:32 PM')
    const after = p2.frames.filter(f => f.type === 'replay').at(-1)
    check(after.running && after.exitCode === undefined && after.data.startsWith(ex.data) && after.data.endsWith(res2.tail), 'restarting an exited pane seeds its kept output, the next replay is running')
    check(pm.getExited('pane') === null && !p2.frames.slice(1).some(f => f.type === 'exit'), 'the respawn clears the record and sends no exit')

    // Only natural exits are kept; kill(deadId) from the closing pane drops the record.
    pm.kill(res2.ptyId)
    check(pm.getExited('pane') === null, 'a killed pty leaves no record')
    const other = pm.spawn({ paneId: 'other', cols: 80, rows: 24 })
    h.procs.at(-1).exit(0)
    check(pm.getExited('other')?.exitCode === 0, 'exit code 0 is kept too')
    pm.kill('pty-unrelated')
    check(pm.getExited('other') !== null, 'killing an unrelated dead id keeps the record')
    pm.kill(other.ptyId)
    check(pm.getExited('other') === null && pm.exitedPaneCodes().size === 0, 'killing the dead pty id (pane closed) drops the record')

    // fallbackDefaultShell ignores a configured shell.
    const missing = process.platform === 'win32' ? 'C:\\snaos-nope\\noexiste.exe' : '/snaos-nope/noexiste'
    const res3 = pm.restart({ paneId: 'fb', shell: missing, cols: 80, rows: 24, fallbackDefaultShell: true }, 'r')
    check(!res3.warning && h.spawnCalls.at(-1).shell !== missing, 'fallbackDefaultShell spawns the OS default without a warning')
    const res4 = pm.restart({ paneId: 'fb', shell: missing, cols: 80, rows: 24 }, 'r')
    check(res4.warning && res4.warning.kind === 'shellNotFound', 'a restart with a missing shell still reports shellNotFound')

    // A failed respawn throws, and the kept output stays for phones.
    h.procs.at(-1).emit('kept\r\n')
    await flushAll()
    const realImpl = current.impl
    current.impl = () => { throw new Error('spawn failed') }
    assert.throws(() => pm.restart({ paneId: 'fb', cols: 80, rows: 24 }, 'r'), /spawn failed/)
    check(pm.ptyIdForPane('fb') === null && pm.getExited('fb')?.data.includes('kept') && pm.getExited('fb').exitCode === -1, 'a failed restart keeps the output as an exited record (code -1)')
    current.impl = realImpl
    const res5 = pm.restart({ paneId: 'fb', cols: 80, rows: 24 }, 'again')
    check(pm.getReplay('fb').replay.includes('kept') && pm.getReplay('fb').replay.endsWith(res5.tail), 'the retry seeds that output')

    // A full ring's seed sits at the cap: new output must push out only its
    // oldest lines, never the whole kept output at once.
    {
      const big = pm.spawn({ paneId: 'big', cols: 80, rows: 24 })
      const line = 'x'.repeat(78) + '\r\n'
      for (let i = 0; i < 4000; i++) h.procs.at(-1).emit(line)
      h.procs.at(-1).emit('LAST-OLD-LINE\r\n')
      await flushAll()
      const resBig = pm.restart({ paneId: 'big', cols: 80, rows: 24 }, 'r')
      check(resBig.ptyId !== big.ptyId, 'restart of a pane with a full ring')
      for (let i = 0; i < 8; i++) h.procs.at(-1).emit('new output line ' + i + '\r\n')
      await flushAll()
      const repBig = pm.getReplay('big').replay
      check(repBig.includes('LAST-OLD-LINE') && repBig.length > 200 * 1024 && repBig.endsWith('new output line 7\r\n'), 'new output after restarting a full ring keeps the kept output (oldest lines trimmed only)')
    }
    pm.killAll()
  }

  // --- Headless mirror (E6-FR-01..07, FR-35) -----------------------------------
  {
    const { HeadlessMirror, advancePartialEscapeTail } = load('src/main/pty/HeadlessMirror.ts')
    const { normalizeEngine, engineFromSettings, mirrorScrollback, REPLAY_LINES, DEFAULT_ENGINE } = load('src/shared/terminalEngine.ts')
    const { Terminal } = require('@xterm/headless')
    const { Unicode11Addon } = require('@xterm/addon-unicode11')
    const { SessionManager } = load('src/main/remote/SessionManager.ts', { setInterval: () => 0, clearInterval() {} })
    const pkg = require(path.join(root, 'package.json'))
    check(pkg.dependencies['@xterm/headless'] === '5.5.0' && pkg.dependencies['@xterm/addon-serialize'] === '0.13.0', '@xterm/headless 5.5.0 and @xterm/addon-serialize 0.13.0 pinned exact')
    // A receiving terminal (desktop xterm or phone), headless here.
    const client = (cols, rows, v11 = true) => {
      const t = new Terminal({ cols, rows, scrollback: 6000, allowProposedApi: true, logLevel: 'off' })
      t.loadAddon(new Unicode11Addon())
      t.unicode.activeVersion = v11 ? '11' : '6'
      const replies = []
      t.onData(d => replies.push(d))
      return { t, replies, write: d => t._core.writeSync(d) }
    }
    const phone = () => {
      const frames = []
      return { frames, session: { ws: { readyState: 1, send: s => frames.push(JSON.parse(s)), bufferedAmount: 0 }, authed: true, subs: new Set(), outBuf: new Map(), outTimer: null, congested: new Set(), congestedSince: new Map(), lastSeen: Date.now() } }
    }
    // Cell-level signature of a buffer: text, colors and bold per row.
    const sig = buf => {
      const rows = []
      for (let y = 0; y < buf.length; y++) {
        const line = buf.getLine(y); let row = ''
        for (let x = 0; x < line.length; x++) {
          const c = line.getCell(x)
          if (!c || c.getWidth() === 0) continue
          row += `${c.getChars() || ' '}/${c.getFgColorMode()}:${c.getFgColor()}/${c.getBgColorMode()}:${c.getBgColor()}/${c.isBold()};`
        }
        rows.push(row.replace(/( \/0:0\/0:0\/0;)+$/, ''))
      }
      while (rows.length && rows[rows.length - 1] === '') rows.pop()
      return rows
    }
    const texts = buf => { const out = []; for (let y = 0; y < buf.length; y++) out.push(buf.getLine(y).translateToString(true)); return out }
    const state = t => ({
      normal: sig(t.buffer.normal), alt: t.buffer.active.type === 'alternate' ? sig(t.buffer.alternate) : null,
      cx: t.buffer.active.cursorX, cy: t.buffer.active.cursorY, type: t.buffer.active.type,
      modes: JSON.stringify(t.modes), encoding: t._core.coreMouseService.activeEncoding, hidden: t._core.coreService.isCursorHidden,
    })
    const mirrorOf = (cols, rows, opts = {}) => new HeadlessMirror({ cols, rows, scrollback: 2000, unicode11: true, ...opts })
    const endModes = text => { const t = new ModeTracker(); t.feed(text); return t.rehydrate() }

    // Engine settings normalization.
    check(JSON.stringify(normalizeEngine(null)) === JSON.stringify(DEFAULT_ENGINE), 'junk engine payload -> defaults (auto, Unicode 11, persist, 2000)')
    const eng = normalizeEngine({ snapshotMode: 'lazy', unicode11: false, persist: false, persistLines: 99999, extra: 1 })
    check(eng.snapshotMode === 'lazy' && !eng.unicode11 && !eng.persist && eng.persistLines === 5000 && !('extra' in eng), 'valid fields kept, lines clamped to 5000, unknown keys dropped')
    check(normalizeEngine({ snapshotMode: 'x', persistLines: 10 }).snapshotMode === 'auto' && normalizeEngine({ persistLines: 10 }).persistLines === 200, 'unknown mode -> auto, lines below 200 clamp up')
    const fromCfg = engineFromSettings({ terminalSnapshotMode: 'off', terminalUnicode11: false, persistScrollback: true, persistScrollbackLines: 3000 })
    check(fromCfg.snapshotMode === 'off' && fromCfg.unicode11 === false && fromCfg.persistLines === 3000 && engineFromSettings(undefined).snapshotMode === 'auto', 'engineFromSettings maps the schema 12 keys')
    check(REPLAY_LINES === 2000 && mirrorScrollback(fromCfg) === 3000 && mirrorScrollback(DEFAULT_ENGINE) === 2000, 'mirror scrollback = max(REPLAY_LINES, persistLines)')

    // Partial escape tail scanner (E6-FR-35).
    check(advancePartialEscapeTail('', 'abc\x1b[38;2;25') === '\x1b[38;2;25' && advancePartialEscapeTail('\x1b[38;2;25', '5;0;0mX') === '', 'a CSI cut at the end is kept, then completed')
    check(advancePartialEscapeTail('', 'x\x1b]0;tit') === '\x1b]0;tit' && advancePartialEscapeTail('\x1b]0;tit', 'le more') === '\x1b]0;title more' && advancePartialEscapeTail('\x1b]0;title more', 'x\x07y') === '', 'an OSC title spanning chunks stays pending until BEL')
    check(advancePartialEscapeTail('', 'a\x1b') === '\x1b' && advancePartialEscapeTail('\x1b', '[') === '\x1b[' && advancePartialEscapeTail('', '\x1b]0;t\x1b\\') === '', 'lone ESC and ST endings')
    check(advancePartialEscapeTail('', '\x1b(') === '\x1b(' && advancePartialEscapeTail('', '\x1b(B') === '' && advancePartialEscapeTail('', '\x1b7') === '', 'charset designation needs its final byte, two-byte escapes are whole')
    check(advancePartialEscapeTail('', '\x1b[3\x18') === '' && advancePartialEscapeTail('', '\x1b]0;t\x1a') === '', 'CAN / SUB abort a pending sequence')
    check(advancePartialEscapeTail('', 'hi \ud83d') === '\ud83d' && advancePartialEscapeTail('', 'plain') === '' && advancePartialEscapeTail('\x1b[', '') === '\x1b[', 'a split surrogate pair is kept, plain text and empty chunks are clean')
    check(advancePartialEscapeTail('', '\x1bP' + 'q'.repeat(5000)) === '', 'an oversized pending sequence (sixel) is dropped')

    // Round trip of a Claude-like TUI (E6-FR-03).
    let fx = ''
    for (let i = 0; i < 60; i++) fx += `\x1b[38;2;${i * 4};120;200mline ${i}\x1b[0m ` + 'é漢😀'.repeat(i % 3) + '\r\n'
    fx += '\x1b[?2004h\x1b[?1h\x1b[?25l\x1b[?1000;1006h\x1b[?1004h'
    fx += '╭' + '─'.repeat(40) + '╮\r\n│ \x1b[1m> \x1b[0mtype here' + ' '.repeat(28) + '│\r\n╰' + '─'.repeat(40) + '╯'
    fx += '\x1b[2A\x1b[5G\x1b[K\x1b[48;2;30;30;30m✻ Thinking\x1b[0m\x1b[3;1H\x1b[2Kreplaced row\x1b[J\x1b[10;20H'
    {
      const m = mirrorOf(80, 24)
      const src = client(80, 24)
      for (let i = 0; i < fx.length; i += 97) { m.write(fx.slice(i, i + 97)); src.write(fx.slice(i, i + 97)) }
      const snap = m.snapshot({ scrollback: 2000, purpose: 'replay' })
      check(snap.cols === 80 && snap.rows === 24 && !snap.altScreen && snap.lines > 24, 'snapshot reports size, buffer and lines')
      const dst = client(80, 24)
      dst.write(snap.data)
      const a = state(src.t), b = state(dst.t)
      check(JSON.stringify(a.normal) === JSON.stringify(b.normal), 'round trip: every row (text, truecolor, bold, wide chars) identical')
      check(a.cx === b.cx && a.cy === b.cy, 'round trip: cursor position identical')
      check(a.modes === b.modes && a.encoding === b.encoding && b.encoding === 'SGR' && a.hidden === b.hidden && b.hidden === true, 'round trip: modes (mouse, SGR encoding, paste, app cursor, focus) and hidden cursor identical')
      check(dst.replies.length === 0, 'writing a snapshot makes the receiving terminal answer nothing')
      m.dispose()
    }
    {
      // Alt screen: normal history + vim-like alt content.
      const m = mirrorOf(60, 12), src = client(60, 12)
      const alt = '$ ls\r\nfile.txt\r\n$ vim\x1b[?1049h\x1b[?1002h\x1b[H\x1b[2J' + '~\r\n'.repeat(8) + '\x1b[1;1H\x1b[7m-- INSERT --\x1b[0m\x1b[5;3H'
      m.write(alt); src.write(alt)
      const snap = m.snapshot({ scrollback: 2000, purpose: 'replay' })
      const dst = client(60, 12); dst.write(snap.data)
      const a = state(src.t), b = state(dst.t)
      check(snap.altScreen && b.type === 'alternate' && JSON.stringify(a.alt) === JSON.stringify(b.alt) && JSON.stringify(a.normal) === JSON.stringify(b.normal), 'round trip with the alt screen active: both buffers identical')
      check(a.cx === b.cx && a.cy === b.cy && a.modes === b.modes, 'alt screen round trip keeps cursor and mouse mode')
      const persist = m.snapshot({ scrollback: 2000, purpose: 'persist' })
      check(!persist.data.includes('\x1b[?1049h') && !persist.data.includes('INSERT') && persist.data.includes('file.txt') && !persist.data.includes('\x1b[?1002h'), 'persist snapshot: normal buffer only, no alt buffer and no modes')
      m.dispose()
    }
    {
      // Partial tail through a snapshot: the next frame completes it (E6-FR-35).
      const m = mirrorOf(40, 5)
      m.write('abc\x1b[38;2;25')
      const snap = m.snapshot({ scrollback: 2000, purpose: 'replay' })
      check(snap.data.endsWith('\x1b[38;2;25'), 'the replay ends with the pending escape')
      const dst = client(40, 5); dst.write(snap.data); dst.write('5;0;0mX')
      const line = dst.t.buffer.active.getLine(0), x = line.getCell(3)
      check(line.translateToString(true) === 'abcX' && x.getChars() === 'X' && x.isFgRGB() && x.getFgColor() === 0xff0000, 'the client shows a red X and no literal escape text')
      m.write('5;0;0mX')
      check(!m.snapshot({ scrollback: 2000, purpose: 'replay' }).data.endsWith('25'), 'once completed, the tail is gone')
      m.dispose()
    }
    {
      // Resize and live Unicode (E6-FR-06).
      const m = mirrorOf(80, 24)
      m.resize(100, 30)
      check(m.cols === 100 && m.rows === 30 && m.synchronous, 'resize reaches the mirror (writeSync available in xterm 5.5)')
      m.write('😀x')
      check(m.term.buffer.active.cursorX === 3, 'Unicode 11: the emoji is 2 columns wide')
      m.setUnicode(false); m.write('\r\n😀x')
      check(m.term.buffer.active.cursorX === 2, 'switching to Unicode 6 live changes the width in the existing mirror')
      m.setScrollback(5000)
      check(m.term.options.scrollback === 5000, 'scrollback adjusts live')
      m.dispose()
    }
    {
      // Snapshot cost at the NFR size (2000 lines x 120 columns), printed; the gate is loose.
      const m = mirrorOf(120, 40)
      const row = i => `\x1b[38;2;${i % 255};90;160m${String(i).padStart(5)} ` + 'lorem ipsum dolor sit amet '.repeat(5).slice(0, 110) + '\x1b[0m\r\n'
      let big = ''; for (let i = 0; i < 2100; i++) big += row(i)
      m.write(big)
      const times = []
      for (let i = 0; i < 10; i++) { const t0 = process.hrtime.bigint(); m.snapshot({ scrollback: 2000, purpose: 'replay' }); times.push(Number(process.hrtime.bigint() - t0) / 1e6) }
      times.sort((a, b) => a - b)
      console.log(`  HeadlessMirror: snapshot 2000x120 p95 ${times[9].toFixed(1)} ms (budget 25 ms)`)
      check(times[9] < 500, 'a 2000-line snapshot stays far below 500 ms')
      m.dispose()
    }

    // PtyManager integration: when the mirror exists (E6-FR-01).
    {
      const { pm, h } = manager({ snapshotMode: 'auto', persist: true })
      pm.spawn({ paneId: 'a', cols: 80, rows: 24 }); pm.spawn({ paneId: 'b', cols: 80, rows: 24 })
      check(pm.headlessMetrics().panes === 2, 'auto + persistence: a mirror per pane from the spawn')
      h.procs[0].exit(0)
      check(pm.headlessMetrics().panes === 1, 'the mirror is disposed with its pty')
      pm.setEngine({ snapshotMode: 'off' })
      check(pm.headlessMetrics().panes === 0, "switching to 'off' drops every mirror")
      pm.setEngine({ snapshotMode: 'auto', persist: true })
      check(pm.headlessMetrics().panes === 1, 'back to auto + persistence: live ptys get a mirror again')
      pm.killAll()
    }
    for (const engine of [{ snapshotMode: 'auto', persist: false }, { snapshotMode: 'lazy', persist: true }]) {
      const { pm, h } = manager(engine)
      const sm = new SessionManager({ ptyManager: pm })
      pm.addSink(sm)
      pm.spawn({ paneId: 'p', cols: 80, rows: 24 })
      h.procs[0].emit('hello\r\n')
      await flushAll()
      const label = engine.snapshotMode + (engine.persist ? '' : ' without persistence')
      check(pm.headlessMetrics().panes === 0, `${label}: no mirror before anyone replays`)
      const p = phone()
      sm.handleSub(p.session, 'p')
      check(pm.headlessMetrics().panes === 1 && p.frames[0].type === 'replay' && p.frames[0].data.includes('hello'), `${label}: a phone sub creates it (count +1) and gets its snapshot`)
      h.procs[0].exit(0)
      check(pm.headlessMetrics().panes === 0, `${label}: and it goes when the pty exits`)
      pm.killAll()
    }
    for (const mode of ['lazy', 'off']) {
      // Modes set long before the mirror exists (lazy) and in 'off' (E6-FR-05/33).
      const { pm, h } = manager({ snapshotMode: mode })
      pm.spawn({ paneId: 'm', cols: 100, rows: 30 })
      h.procs[0].emit('\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[?25l')
      const line = '\x1b[38;2;200;100;50m' + 'y'.repeat(60) + '\x1b[0m\r\n'
      for (let i = 0; i < 4000; i++) h.procs[0].emit(line)
      h.procs[0].emit('tail$ ')
      await flushAll()
      const rep = pm.getReplay('m')
      const dst = client(100, 30); dst.write(rep.replay)
      const b = state(dst.t)
      check(dst.t.modes.mouseTrackingMode === 'vt200' && b.encoding === 'SGR' && dst.t.modes.bracketedPasteMode && b.hidden, `${mode}: modes emitted before 300 KB of output are active in the replay`)
      const buf = dst.t.buffer.active
      check(!/;\d+;\d+m/.test(texts(dst.t.buffer.normal).join('\n')) && buf.getLine(buf.baseY + buf.cursorY).translateToString(true).startsWith('tail$'), `${mode}: clean head and the live prompt on the cursor row`)
      check(pm.headlessMetrics().panes === (mode === 'off' ? 0 : 1), `${mode}: ${mode === 'off' ? 'no mirror in any path' : 'the replay created the mirror'}`)
      pm.killAll()
    }
    {
      // A ring truncated inside an escape seeds a lazy mirror without garbage (E6-FR-02).
      const { pm, h } = manager({ snapshotMode: 'lazy' })
      pm.spawn({ paneId: 't', cols: 80, rows: 24 })
      h.procs[0].emit('start\x1b[38;2;')
      h.procs[0].emit('255;0;0mRED-HEAD\r\n')
      // Small chunks so the ring drops one chunk at a time.
      const filler = 'f'.repeat(8) + '\r\n'
      let n = 0
      const entry = pm.entries.get(pm.ptyIdForPane('t'))
      // Stop right after the chunk ending in `\x1b[38;2;` leaves the ring.
      while (entry.history[0] !== '255;0;0mRED-HEAD\r\n' && n++ < 40000) h.procs[0].emit(filler)
      await flushAll()
      check(entry.historyTruncated && entry.history[0].startsWith('255;0;0m'), 'fixture: the ring head starts inside an escape sequence')
      const dst = client(80, 24); dst.write(pm.getReplay('t').replay)
      check(!texts(dst.t.buffer.normal).some(l => /\d+;\d+;\d+m/.test(l)), 'no `255;0;0m` text anywhere in the replayed screen')
      pm.killAll()
    }
    {
      // DA1 / DSR never reach the pty (E6-FR-06), the cache serializes once (NFR).
      const { pm, h } = manager({ snapshotMode: 'auto', persist: true })
      const { ptyId } = pm.spawn({ paneId: 'q', cols: 80, rows: 24 })
      h.procs[0].emit('prompt\x1b[c\x1b[6n\x1b[>c\x1b]11;?\x07$ ')
      await flushAll()
      const r1 = pm.getReplay('q')
      check(h.procs[0].writes.length === 0, 'queries parsed by the mirror produce no pty.write')
      check(!r1.replay.includes('\x1b[6n') && !r1.replay.includes('\x1b[c'), 'the snapshot carries no query')
      const hits = pm.headlessMetrics().snapshotCacheHits
      const r2 = pm.getReplay('q'), r3 = pm.reattach('q')
      check(r2.replay === r1.replay && r3.replay === r1.replay && pm.headlessMetrics().snapshotCacheHits === hits + 2, 'two more replays without output reuse the cached snapshot')
      check(r3.cols === 80 && r3.rows === 24 && typeof r3.shellKind === 'string' && r3.ptyId === ptyId, 'reattach returns cols/rows/shellKind (E6-FR-04)')
      h.procs[0].emit('more')
      await flushAll()
      const r4 = pm.getReplay('q')
      check(r4.replay !== r1.replay && pm.headlessMetrics().snapshotCacheHits === hits + 2, 'new output invalidates the cache')
      pm.resize(ptyId, 100, 30)
      const entry = pm.entries.get(ptyId)
      check(entry.mirror.cols === 100 && entry.mirror.rows === 30, 'PtyManager.resize resizes the mirror')
      const r5 = pm.getReplay('q')
      check(r5.cols === 100 && r5.rows === 30 && pm.headlessMetrics().snapshotCacheHits === hits + 2, 'a resize invalidates the cache and the replay follows the new size')
      pm.setEngine({ snapshotMode: 'auto', persist: true, unicode11: false, persistLines: 4000 })
      check(entry.mirror.term.unicode.activeVersion === '6' && entry.mirror.term.options.scrollback === 4000, 'setEngine reaches live mirrors (Unicode version and scrollback)')
      const m = pm.headlessMetrics()
      check(['panes', 'parseMsP95', 'snapshotMsP95', 'bytesParsed', 'snapshotCacheHits'].every(k => typeof m[k] === 'number' && Number.isFinite(m[k])) && m.bytesParsed > 0, 'headlessMetrics: numeric panes, p95s and counters (E6-FR-07)')
      pm.setEngine('garbage')
      check(pm.getEngine().snapshotMode === 'auto' && pm.getEngine().unicode11 === true, 'a junk setEngine payload normalizes instead of throwing')
      pm.killAll()
    }
    {
      // A mirror that throws falls back to ring + modes, once, for good.
      const { pm, h } = manager({ snapshotMode: 'auto', persist: true })
      const warns = []
      const realWarn = ptyConsole.warn
      const { ptyId } = pm.spawn({ paneId: 'x', cols: 80, rows: 24 })
      const entry = pm.entries.get(ptyId)
      entry.mirror.write = () => { throw new Error('parser exploded') }
      ptyConsole.warn = (...a) => warns.push(a.join(' '))
      try {
        h.procs[0].emit('\x1b[?2004hafter failure')
        await flushAll()
        const rep = pm.getReplay('x').replay
        check(entry.mirror === null && entry.mirrorFailed && rep === '\x1b[?2004h' + '\x1b[?2004hafter failure', 'a mirror exception drops it and the replay is ModeTracker prefix + ring again')
        h.procs[0].emit(' more'); await flushAll(); pm.getReplay('x')
        check(entry.mirror === null && warns.length === 1 && warns[0].includes('pane x'), 'no new mirror for that pty and a single warning')
      } finally { ptyConsole.warn = realWarn }
      pm.killAll()
    }
    {
      // Restart and natural exit read the mirror (E6-FR-19/20); the respawn seeds a new one.
      const { SOFT_RESET } = loaded
      const { pm, h } = manager({ snapshotMode: 'auto', persist: true })
      const sm = new SessionManager({ ptyManager: pm })
      pm.addSink(sm)
      pm.spawn({ paneId: 'r', cols: 80, rows: 24 })
      const line = 'z'.repeat(70) + '\r\n'
      for (let i = 0; i < 4000; i++) h.procs[0].emit(line)
      h.procs[0].emit('KEEP-ME\r\n\x1b[?1000h\x1b[?2004h$ ')
      await flushAll()
      const p = phone()
      sm.handleSub(p.session, 'r')
      const res = pm.restart({ paneId: 'r', cols: 80, rows: 24 }, 'reiniciado 14:32')
      const seeded = p.frames.filter(f => f.type === 'replay').at(-1)
      const dst = client(80, 24); dst.write(seeded.data)
      const text = texts(dst.t.buffer.normal)
      check(text.includes('KEEP-ME') && text.some(l => l.includes('--- reiniciado 14:32 ---')), 'after a restart the phone replay (from the new mirror) shows the kept output + separator')
      check(dst.t.modes.mouseTrackingMode === 'none' && !dst.t.modes.bracketedPasteMode && pm.headlessMetrics().panes === 1, 'with modes off, and the new pty has its own mirror')
      check(text.filter(l => l === 'z'.repeat(70)).length >= 1900, 'the new mirror got the whole seed (2000 lines), not only what fits in the ring')
      h.procs.at(-1).emit('bye\r\n'); h.procs.at(-1).exit(4)
      const ex = pm.getExited('r')
      check(ex && ex.exitCode === 4 && ex.data.includes('bye') && ex.data.endsWith(SOFT_RESET) && endModes(ex.data) === '', 'a natural exit keeps the mirror snapshot + SOFT_RESET')
      check(pm.headlessMetrics().panes === 0 && typeof res.ptyId === 'string', 'no mirror outlives its pty')
      pm.killAll()
    }
    for (const mode of ['lazy', 'off']) {
      // A restart seed over the 256 KB ring: outside 'off' the respawn builds its
      // mirror from the whole seed (E6-FR-11/19), not from what the ring kept.
      const { pm, h } = manager({ snapshotMode: mode })
      const sm = new SessionManager({ ptyManager: pm })
      pm.addSink(sm)
      pm.spawn({ paneId: 'w', cols: 200, rows: 24 })
      const p = phone()
      sm.handleSub(p.session, 'w')
      const wide = 'w'.repeat(150) + '\r\n'
      for (let i = 0; i < 3000; i++) h.procs[0].emit(wide)
      await flushAll()
      pm.restart({ paneId: 'w', cols: 200, rows: 24 }, 'reiniciado')
      const entry = pm.entries.get(pm.ptyIdForPane('w'))
      const seeded = p.frames.filter(f => f.type === 'replay').at(-1)
      const dst = client(200, 24); dst.write(seeded.data)
      const kept = texts(dst.t.buffer.normal).filter(l => l === 'w'.repeat(150)).length
      if (mode === 'lazy') check(entry.mirror && entry.historyTruncated && kept >= 1990, `lazy: a seed bigger than the ring creates the mirror at the respawn and the phone keeps all of it (${kept} lines)`)
      else check(!entry.mirror && pm.headlessMetrics().panes === 0 && kept > 0, "off: a seeded respawn still never builds a mirror")
      pm.killAll()
    }
    {
      // Phone replay + next out frame across a partial escape (E6-FR-35, through SessionManager).
      const { pm, h } = manager({ snapshotMode: 'auto', persist: true })
      const sm = new SessionManager({ ptyManager: pm })
      pm.addSink(sm)
      const p = phone()
      pm.spawn({ paneId: 's', cols: 40, rows: 5 })
      h.procs[0].emit('abc\x1b[38;2;25')
      await flushAll()
      sm.handleSub(p.session, 's')
      h.procs[0].emit('5;0;0mX')
      await flushAll()
      await new Promise(r => setTimeout(r, 120))
      const out = p.frames.filter(f => f.type === 'out').map(f => f.data).join('')
      const dst = client(40, 5); dst.write(p.frames[0].data + out)
      const cellX = dst.t.buffer.active.getLine(0).getCell(3)
      check(out === '5;0;0mX' && dst.t.buffer.active.getLine(0).translateToString(true) === 'abcX' && cellX.getFgColor() === 0xff0000, 'replay + next out frame: a red X on the phone, no literal text')
      pm.killAll()
    }
  }

  // Phone exit strip state (E6-FR-20).
  {
    const { nextExit } = load('src/mobile/src/lib/exitState.ts')
    const replay = (running, exitCode) => ({ type: 'replay', data: '', cols: 80, rows: 24, running, ...(exitCode === undefined ? {} : { exitCode }) })
    const ex = nextExit(null, 'p', { type: 'exit', exitCode: 3 })
    check(ex && ex.paneId === 'p' && ex.exitCode === 3, 'an exit frame shows the strip with its code')
    check(nextExit(ex, 'p', { type: 'out', data: 'x' }) === ex, 'output keeps it')
    check(nextExit(ex, 'p', replay(true)) === null, 'the next running replay (restart) clears it')
    const late = nextExit(null, 'p', replay(false, 0))
    check(late && late.exitCode === 0, 'a replay of an already exited pane shows the strip')
    check(nextExit(null, 'p', replay(false)) === null, 'a pending lazy spawn (no exitCode) shows no strip')
    check(nextExit(ex, 'q', { type: 'out', data: 'x' }) === null && nextExit(ex, null, { type: 'exit', exitCode: 1 }) === null, 'another pane, or none, never inherits the strip')
  }
  {
    const failing = load('src/main/pty/PtyManager.ts', {
      require: id => id === 'node-pty' ? { spawn: () => { throw new Error('boom') } } : id === 'electron' ? { app: { getPath: () => os.tmpdir() } } : require(id),
      console: { ...console, warn() {} },
    })
    const pm = new failing.PtyManager(() => null)
    const seen = []
    pm.addSink({ id: 's', onSpawn() {}, onData() {}, onExit: (_p, _pane, code, info) => seen.push({ code, ...info }) })
    assert.throws(() => pm.spawn({ paneId: 'x', cols: 80, rows: 24 }))
    check(seen.length === 1 && seen[0].code === -1 && !seen[0].current && !seen[0].natural, 'a failed spawn notifies sinks with { current: false, natural: false }')
  }

  // resolveShell (E6-FR-32).
  {
    const { resolveShell, shellKindOf, shellExists } = load('src/main/pty/shellResolve.ts')
    const files = new Set(['C:\\Tools\\pwsh.exe', 'C:\\Win\\System32\\cmd.exe', '/usr/bin/fish'])
    const isFile = p => files.has(p)
    const win = { platform: 'win32', env: { Path: 'C:\\Win\\System32;"C:\\Tools"', PATHEXT: '.COM;.EXE;.BAT' }, isFile }
    const r1 = resolveShell('C:\\nope\\pwsh.exe', 'powershell.exe', win)
    check(r1.shell === 'powershell.exe' && r1.warning && r1.warning.requested === 'C:\\nope\\pwsh.exe' && r1.warning.used === 'powershell.exe', 'nonexistent absolute path falls back with a warning')
    const r2 = resolveShell('noexiste.exe', 'powershell.exe', win)
    check(r2.shell === 'powershell.exe' && r2.warning && r2.warning.kind === 'shellNotFound', 'a name not in PATH falls back with a warning')
    const r3 = resolveShell('pwsh', 'powershell.exe', win)
    check(r3.shell === 'C:\\Tools\\pwsh.exe' && !r3.warning && r3.shellKind === 'powershell', 'a bare name found via PATH + PATHEXT (quoted PATH entry) is launched by its absolute path (node-pty knows neither)')
    const r5 = resolveShell('cmd.exe', 'powershell.exe', win)
    check(r5.shellKind === 'cmd' && r5.shell === 'C:\\Win\\System32\\cmd.exe', 'cmd.exe in PATH resolves absolute with kind cmd')
    const rel = resolveShell('tools\\pwsh.exe', 'powershell.exe', { ...win, isFile: p => p === 'tools\\pwsh.exe' })
    check(!rel.warning && path.win32.isAbsolute(rel.shell), 'a relative Windows path is handed to node-pty absolute')
    check(resolveShell('"C:\\Tools\\pwsh.exe"', 'powershell.exe', win).shell === 'C:\\Tools\\pwsh.exe', 'surrounding quotes are stripped')
    const r4 = resolveShell('   ', 'powershell.exe', win)
    check(r4.shell === 'powershell.exe' && !r4.warning, 'an empty setting means the OS default, silently')
    const posix = { platform: 'linux', env: { PATH: '/usr/bin:/bin' }, isFile }
    check(resolveShell('fish', '/bin/bash', posix).shell === 'fish', 'POSIX name lookup in PATH')
    check(resolveShell('/opt/zsh', '/bin/bash', posix).warning?.used === '/bin/bash', 'POSIX missing absolute path falls back')
    check(!shellExists('fish.exe', posix), 'no PATHEXT guessing on POSIX')
    check(shellKindOf('C:\\Program Files\\PowerShell\\7\\pwsh.exe') === 'powershell' && shellKindOf('/bin/zsh') === 'posix' && shellKindOf('wsl.exe') === 'posix' && shellKindOf('node') === 'other', 'shellKindOf by executable name')
    check(resolveShell(process.execPath, 'x').shell === process.execPath, 'real filesystem lookup finds an existing executable')
    check(resolveShell(path.join(os.tmpdir(), `snaos-nope-${Date.now()}.exe`), 'x').warning, 'real filesystem lookup rejects a missing file')
    // Store apps (pwsh, python, wt) are App Execution Aliases: stat() fails with
    // EACCES on them, yet they launch. Read-only probe of the real WindowsApps.
    const fs = require('node:fs')
    const apps = process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps') : null
    const alias = apps && fs.existsSync(apps) ? fs.readdirSync(apps).find(f => f.toLowerCase().endsWith('.exe')) : null
    if (alias) check(!resolveShell(path.join(apps, alias), 'x').warning, 'a Windows App Execution Alias counts as an existing shell')
    else console.log('  (no App Execution Alias on this machine, alias probe skipped)')
  }

  // --- Saved scrollback (E6-FR-08..13, 36, 37) -------------------------------
  {
    const fs = require('node:fs')
    const { Terminal } = require('@xterm/headless')
    const { SessionManager } = load('src/main/remote/SessionManager.ts', { setInterval: () => 0, clearInterval() {} })
    const { sanitizeSeed } = load('src/main/pty/ansiSanitize.ts')
    // fs as ScrollbackStore sees it: a case can make rename fail with EPERM.
    const faults = { rename: 0, renameSync: 0 }
    const eperm = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
    const fakeFs = {
      ...fs,
      renameSync: (a, b) => { if (faults.renameSync > 0) { faults.renameSync--; throw eperm() } return fs.renameSync(a, b) },
      promises: { ...fs.promises, rename: async (a, b) => { if (faults.rename > 0) { faults.rename--; throw eperm() } return fs.promises.rename(a, b) } },
    }
    const storeLogs = []
    const S = load('src/main/pty/ScrollbackStore.ts', { require: id => id === 'fs' ? fakeFs : require(id) })
    const { ScrollbackCheckpoint } = load('src/main/pty/ScrollbackCheckpoint.ts')
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'snaos-scrollback-'))
    let dirSeq = 0
    const newStore = () => new S.ScrollbackStore(path.join(tmpRoot, `s${++dirSeq}`), msg => storeLogs.push(msg))
    const client = (cols, rows) => {
      const t = new Terminal({ cols, rows, scrollback: 6000, allowProposedApi: true, logLevel: 'off' })
      const replies = [], titles = []
      t.onData(d => replies.push(d))
      t.onTitleChange(x => titles.push(x))
      return { t, replies, titles, write: d => t._core.writeSync(d) }
    }
    const texts = buf => { const out = []; for (let y = 0; y < buf.length; y++) out.push(buf.getLine(y).translateToString(true)); return out }
    const snap = (ansi, extra = {}) => ({ ansi, cols: 80, rows: 24, lines: S.countLines(ansi), ...extra })
    const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))
    const ESC = '\x1b'

    try {
      // Sanitized seed (E6-FR-37): no OSC/DCS/APC/PM/SOS, no CSI queries, no C1.
      const evil = `ok${ESC}]0;\u2733 Claude\x07a${ESC}]2;t${ESC}\\b${ESC}]52;c;aGk=\x07c${ESC}Pq#0${ESC}\\d${ESC}_apc${ESC}\\e${ESC}^pm${ESC}\\f${ESC}Xsos${ESC}\\g${ESC}[6nh${ESC}[ci${ESC}[>0cj${ESC}[18tk\x9b6nl\x9d0;x\x07m\x05n${ESC}]0;unterminated`
      const clean = sanitizeSeed(evil)
      check(clean === 'okabcdefghijk6nl0;x\x07mn', 'sanitizeSeed drops OSC (BEL/ST, clipboard, unterminated), DCS, APC, PM, SOS, CSI queries, C1 and ENQ')
      const keep = `${ESC}[38;2;1;2;3mred${ESC}[0m ${ESC}[1mbold${ESC}[22m${ESC}[3;5H${ESC}[K text \u00e9\u6f22`
      check(sanitizeSeed(keep) === keep && sanitizeSeed('') === '', 'SGR, cursor moves, erases and plain text are kept')
      const c1 = client(80, 24)
      c1.write(sanitizeSeed(`hist${ESC}[6n${ESC}[c${ESC}]0;\u2733 Claude\x07${ESC}]11;?\x07${ESC}P$qm${ESC}\\\r\n`))
      check(c1.replies.length === 0 && c1.titles.length === 0, 'writing a sanitized hostile seed makes the terminal answer nothing and keeps the title (no pty.write, no status change)')
      // Strings cut by another ESC (xterm.js still dispatches them) and removals that join a new sequence.
      const sneaky = `a${ESC}]0;✳ Claude${ESC}[0mb${ESC}P$qm${ESC}[1mc${ESC}${ESC}[c]0;joined\x07d${ESC}[${ESC}[cce${ESC}${ESC}]0;x\x07[6nf`
      const raw = client(80, 24)
      raw.write(sneaky)
      check(raw.replies.length > 0 && raw.titles.length > 0, 'fixture: unsanitized, these sequences make xterm answer and set the title')
      const c2 = client(80, 24)
      c2.write(sanitizeSeed(sneaky))
      check(c2.replies.length === 0 && c2.titles.length === 0, 'an OSC/DCS ended by another ESC and sequences joined by a removal are dropped too')
      check(!sanitizeSeed(sneaky).includes(`${ESC}]`) && !sanitizeSeed(sneaky).includes(`${ESC}P`) && sanitizeSeed(sneaky).includes(`${ESC}[0mb`), 'the ESC that ended the string still opens its own SGR')

      // Persisted text and seed helpers.
      check(S.trimPersistAnsi(`a${ESC}[31mb${ESC}[0m\r\n   \r\n\r\n${ESC}[3A${ESC}[5C`) === `a${ESC}[31mb`, 'trailing blank rows, SGR and cursor moves are trimmed')
      check(S.countLines('') === 0 && S.countLines('a') === 1 && S.countLines('a\r\nb\r\nc') === 3, 'countLines counts CRLF rows')
      const big = Array.from({ length: 3000 }, (_, i) => `line ${i} ` + '\u00e9'.repeat(200)).join('\r\n')
      const capped = S.capBytes(big, 100 * 1024)
      check(Buffer.byteLength(capped, 'utf8') <= 100 * 1024 && capped.endsWith('line 2999 ' + '\u00e9'.repeat(200)) && capped.startsWith('line '), 'capBytes keeps the newest whole lines within the byte cap')
      check(S.scrollOff(5) === '\n\n\n\n\x1b[H' && S.scrollOff(1) === '\x1b[H', 'scrollOff pushes rows-1 lines and homes the cursor')
      const seed = S.buildSeed('row A\r\nrow B', 'reiniciado - historial del 17/10 14:32\x1b]0;x', 5)
      check(seed === `row A\r\nrow B${ESC}[0m\r\n${ESC}[2m--- reiniciado - historial del 17/10 14:32]0;x ---${ESC}[0m\r\n\n\n\n\n${ESC}[H`, 'seed = history + reset + gray separator (label without controls) + scroll-off')
      {
        // ConPTY starts with ESC[2J ESC[H: the separator and the last screen of history survive.
        const hist = Array.from({ length: 30 }, (_, i) => `hist ${i}`).join('\r\n')
        const c = client(80, 10)
        c.write(S.buildSeed(hist, 'restarted - history from 10/17 2:32 PM', 10))
        c.write(`${ESC}[?9001h${ESC}[?1004h${ESC}[?25l${ESC}[2J${ESC}[m${ESC}[HPS C:\\> `)
        const rows = texts(c.t.buffer.normal)
        const sep = rows.indexOf('--- restarted - history from 10/17 2:32 PM ---')
        check(rows.includes('hist 0') && rows.includes('hist 29') && sep > 0 && rows[sep - 1] === 'hist 29' && rows[sep + 1].startsWith('PS C:\\>'), 'after the ConPTY clear: all history, the separator, and the new prompt right below it')
      }

      // ScrollbackStore (E6-FR-09/12).
      {
        const st = newStore()
        check(st.fileOf('../x') === null && st.fileOf('a'.repeat(65)) === null && st.fileOf('pane-1').endsWith(path.join(`s${dirSeq}`, 'pane-1.json')), 'only plain pane ids map to a file in the folder')
        check(await st.save('../evil', snap('x')) === false && !fs.existsSync(path.join(tmpRoot, 'evil.json')), 'an invalid pane id is never written')
        check(await st.save('pane-1', snap(`hello ${ESC}[32mworld${ESC}[0m`), 1700000000000) === true, 'save writes the file')
        const f = readJson(st.fileOf('pane-1'))
        check(f.v === 1 && f.paneId === 'pane-1' && f.savedAt === 1700000000000 && f.cols === 80 && f.rows === 24 && f.lines === 1 && f.ansi.includes('world'), 'ScrollbackFileV1 shape')
        check(fs.readdirSync(st.dir).every(n => !n.endsWith('.tmp')), 'no tmp file left after an atomic save')
        const loaded1 = st.load('pane-1')
        check(loaded1 && loaded1.savedAt === 1700000000000 && loaded1.ansi === `hello ${ESC}[32mworld${ESC}[0m`, 'load returns the saved text and time')
        // A hand-edited file: queries and a title inside ansi come back sanitized.
        fs.writeFileSync(st.fileOf('pane-1'), JSON.stringify({ ...f, ansi: `x${ESC}[6ny${ESC}]0;\u2733 Claude\x07z` }))
        check(st.load('pane-1').ansi === 'xyz', 'an edited file restores without its queries or title (E6-FR-37)')
        fs.writeFileSync(st.fileOf('pane-1'), JSON.stringify({ ...f, v: 2 }))
        check(st.load('pane-1') === null && !fs.existsSync(st.fileOf('pane-1')), 'a file with another shape is deleted and gives no seed')
        fs.writeFileSync(st.fileOf('pane-1'), '{"v":1,"paneId":')
        check(st.load('pane-1') === null && !fs.existsSync(st.fileOf('pane-1')), 'a truncated file is deleted too')
        fs.writeFileSync(st.fileOf('pane-1'), JSON.stringify({ ...f, paneId: 'pane-2' }))
        check(st.load('pane-1') === null && !fs.existsSync(st.fileOf('pane-1')), 'a file whose paneId does not match its name is deleted')
        check(st.load('pane-9') === null, 'no file, no seed')

        // EPERM on rename (antivirus): retried, then the previous file is kept.
        await st.save('pane-e', snap('first version'))
        faults.rename = 2
        check(await st.save('pane-e', snap('second version')) === true && st.load('pane-e').ansi === 'second version' && faults.rename === 0, 'a rename blocked twice succeeds on the third try (50 + 150 ms)')
        faults.rename = 99
        const before = storeLogs.length
        check(await st.save('pane-e', snap('third version')) === false, 'a rename blocked every time fails the save')
        faults.rename = 0
        check(st.load('pane-e').ansi === 'second version' && fs.readdirSync(st.dir).every(n => !n.endsWith('.tmp')) && storeLogs.length === before + 1, 'the previous file stays, the tmp is removed and it is logged once')
        faults.renameSync = 99
        check(st.saveSync('pane-e', snap('sync version')) === false && st.load('pane-e').ansi === 'second version' && fs.readdirSync(st.dir).every(n => !n.endsWith('.tmp')), 'the synchronous save keeps the previous file on EPERM too')
        faults.renameSync = 1
        check(st.saveSync('pane-e', snap('sync version')) === true && st.load('pane-e').ansi === 'sync version', 'and retries a single blocked rename')
        faults.renameSync = 0
        // An async checkpoint still in flight never lands over a newer exit save.
        const late = st.save('pane-e', snap('older checkpoint'))
        st.saveSync('pane-e', snap('exit save'))
        check(await late === false && st.load('pane-e').ansi === 'exit save', 'an older async save is dropped once a newer synchronous save landed')

        // Trash, remove, stats, clearAll.
        await st.save('pane-t', snap('trash me'))
        await st.trash('pane-t')
        check(!fs.existsSync(st.fileOf('pane-t')) && fs.existsSync(path.join(st.dir, '.trash', 'pane-t.json')), 'trash moves the file to .trash/')
        check(st.load('pane-t').ansi === 'trash me', 'a trashed history still restores (console reopened in this session)')
        const stats = await st.stats()
        check(stats.files === 1 && stats.bytes > 0, 'stats counts live files only (not the trash)')
        await st.remove('pane-t')
        check(!fs.existsSync(path.join(st.dir, '.trash', 'pane-t.json')) && st.load('pane-t') === null, 'remove deletes the trashed copy at once')
        await st.save('pane-r', snap('remove me'))
        await st.remove('pane-r')
        check(!fs.existsSync(st.fileOf('pane-r')), 'remove deletes the live file at once')
        await st.save('pane-a', snap('a')); await st.trash('pane-a')
        await st.clearAll()
        check((await st.stats()).files === 0 && !fs.existsSync(path.join(st.dir, '.trash')), 'clearAll empties the folder and the trash')
      }
      {
        // Startup GC: orphans and trash only with a primary config; 50 MB cap.
        const st = newStore()
        for (const id of ['pane-live', 'pane-orphan', 'pane-old']) await st.save(id, snap(id))
        await st.save('pane-gone', snap('gone')); await st.trash('pane-gone')
        fs.writeFileSync(path.join(st.dir, 'pane-live.json.123.9.tmp'), 'partial')
        fs.writeFileSync(path.join(st.dir, 'notes.txt'), 'not ours')
        const skipped = await st.gc(null)
        check(skipped.removed.length === 0 && fs.existsSync(st.fileOf('pane-orphan')) && fs.existsSync(path.join(st.dir, '.trash', 'pane-gone.json')), 'GC is skipped without a primary config (recovered from backup): nothing deleted')
        const res = await st.gc(new Set(['pane-live', 'pane-old']))
        check(res.removed.join() === 'pane-orphan' && !fs.existsSync(st.fileOf('pane-orphan')) && fs.existsSync(st.fileOf('pane-live')), 'GC deletes files of panes the config no longer has')
        check(!fs.existsSync(path.join(st.dir, '.trash')) && !fs.existsSync(path.join(st.dir, 'pane-live.json.123.9.tmp')) && fs.existsSync(path.join(st.dir, 'notes.txt')), 'GC empties the trash and orphan tmp files, other files untouched')
        const old = new Date(Date.now() - 86400000)
        fs.utimesSync(st.fileOf('pane-old'), old, old)
        const sizeLive = fs.statSync(st.fileOf('pane-live')).size
        const capped = await st.gc(null, sizeLive)
        check(capped.removed.join() === 'pane-old' && fs.existsSync(st.fileOf('pane-live')), 'over the size cap the oldest files go first')
      }

      // PtyManager: persist snapshot, seed, dirty tracking.
      {
        const { pm, h } = manager({ snapshotMode: 'auto', persist: true, persistLines: 200 })
        pm.spawn({ paneId: 'pp', cols: 80, rows: 24 })
        check(pm.dirtyPaneIds().length === 0, 'a fresh pty is not dirty')
        h.procs[0].emit(`${ESC}[?2004h${ESC}[?1000h`)
        for (let i = 0; i < 1000; i++) h.procs[0].emit(`${ESC}[38;2;10;20;30mline ${i}${ESC}[0m\r\n`)
        h.procs[0].emit('prompt$ \r\n\r\n\r\n')
        check(pm.dirtyPaneIds().join() === 'pp', 'unflushed output already counts as dirty')
        const p1 = pm.takePersist('pp')
        check(p1 && p1.lines <= 200 && p1.lines >= 150 && p1.ansi.includes('line 999') && !p1.ansi.includes('line 500') && p1.ansi.endsWith('prompt$'), `persist keeps the last ${p1.lines} rows (<= persistScrollbackLines 200), no trailing blank lines`)
        check(!p1.ansi.includes('?2004h') && !p1.ansi.includes('?1000h') && p1.cols === 80 && p1.rows === 24, 'no modes in the persisted text')
        check(pm.dirtyPaneIds().length === 0, 'taking the snapshot clears the dirty flag')
        h.procs[0].emit(`${ESC}[?1049h${ESC}[2J${ESC}[HVIM-BUFFER ~`)
        const p2 = pm.takePersist('pp')
        check(p2.ansi.includes('prompt$') && !p2.ansi.includes('VIM-BUFFER'), 'a pane in the alt screen saves only its normal buffer (E6-FR-13)')
        pm.markDirty('pp')
        check(pm.dirtyPaneIds().join() === 'pp', 'markDirty puts a pane back on the list')
        // 1 MB cap with truecolor-heavy output.
        pm.setEngine({ snapshotMode: 'auto', persist: true, persistLines: 5000 })
        h.procs[0].emit(`${ESC}[?1049l`)
        const cell = i => `${ESC}[38;2;${i % 256};${(i * 7) % 256};${(i * 13) % 256}m#`
        for (let r = 0; r < 1200; r++) { let row = ''; for (let c = 0; c < 70; c++) row += cell(r + c); h.procs[0].emit(row + `${ESC}[0m R${r}\r\n`) }
        const p3 = pm.takePersist('pp')
        check(Buffer.byteLength(p3.ansi, 'utf8') <= S.MAX_FILE_BYTES && p3.ansi.includes(' R1199') && !p3.ansi.includes(' R10\r'), `a heavy pane is cut to 1 MB keeping its newest rows (${p3.lines} rows, ${Buffer.byteLength(p3.ansi)} bytes)`)
        // Natural exit: the exited record is saved too.
        h.procs[0].emit('bye\r\n')
        h.procs[0].exit(0)
        check(pm.dirtyPaneIds().join() === 'pp' && pm.ptyIdForPane('pp') === null, 'an exited pane with unsaved output is dirty')
        const p4 = pm.takePersist('pp')
        check(p4 && p4.ansi.includes('bye') && pm.dirtyPaneIds().length === 0 && pm.headlessMetrics().panes === 0, 'an exited pane persists from its record through a temporary mirror')
        pm.killAll()
      }
      {
        // lazy without a mirror: a temporary one, dropped; off: nothing.
        const { pm, h } = manager({ snapshotMode: 'lazy', persist: true })
        pm.spawn({ paneId: 'lz', cols: 80, rows: 24 })
        h.procs[0].emit(`lazy out\r\n${ESC}[?1049h${ESC}[2Jalt`)
        const p = pm.takePersist('lz')
        check(p && p.ansi.includes('lazy out') && !p.ansi.includes('alt') && pm.headlessMetrics().panes === 0, 'lazy without a mirror: the ring goes through a temporary mirror that is dropped')
        pm.setEngine({ snapshotMode: 'off', persist: true })
        h.procs[0].emit('more')
        check(!pm.persistEnabled() && pm.takePersist('lz') === null, "'off' turns persistence off (kill switch)")
        pm.setEngine({ snapshotMode: 'auto', persist: false })
        check(!pm.persistEnabled() && pm.takePersist('lz') === null, 'persistScrollback false: nothing to save')
        pm.killAll()
      }
      {
        // The seed (E6-FR-11): consumed once, not with restoreScrollback false, creates the mirror.
        const { pm, h } = manager({ snapshotMode: 'lazy', persist: true })
        const asked = []
        pm.setSeedSource((paneId, rows) => { asked.push({ paneId, rows }); return `SEED-${paneId}\r\n` + S.scrollOff(rows) })
        const r1 = pm.spawn({ paneId: 'sa', cols: 80, rows: 20, restoreScrollback: true })
        check(r1.seed === 'SEED-sa\r\n' + S.scrollOff(20) && asked.length === 1 && asked[0].rows === 20, 'the first spawn with restoreScrollback gets the seed for its rows')
        check(pm.headlessMetrics().panes === 1, "a seeded spawn creates the mirror even in 'lazy'")
        const sm = new SessionManager({ ptyManager: pm })
        pm.addSink(sm)
        const frames = []
        sm.handleSub({ ws: { readyState: 1, send: s => frames.push(JSON.parse(s)), bufferedAmount: 0 }, authed: true, subs: new Set(), outBuf: new Map(), outTimer: null, congested: new Set(), congestedSince: new Map(), lastSeen: Date.now() }, 'sa')
        check(frames[0].type === 'replay' && frames[0].data.includes('SEED-sa'), 'phones see the seed in their replay')
        check(pm.dirtyPaneIds().length === 0, 'a seed alone does not make the pane dirty (its file stays as it is)')
        pm.kill(r1.ptyId)
        const r2 = pm.spawn({ paneId: 'sa', cols: 80, rows: 20, restoreScrollback: true })
        check(r2.seed === undefined && asked.length === 1, 'a second spawn in the same session (clean restart) gets no seed')
        const r3 = pm.spawn({ paneId: 'sb', cols: 80, rows: 20, restoreScrollback: false })
        pm.kill(r3.ptyId)
        const r4 = pm.spawn({ paneId: 'sb', cols: 80, rows: 20, restoreScrollback: true })
        check(r3.seed === undefined && r4.seed === undefined && asked.length === 1, 'a resuming first spawn (restoreScrollback false) consumes the seed without loading it')
        pm.kill(r4.ptyId)
        pm.forgetSeed('sb')
        check(pm.spawn({ paneId: 'sb', cols: 80, rows: 20, restoreScrollback: true }).seed.startsWith('SEED-sb'), 'forgetSeed (pane closed and reopened) lets it restore again')
        pm.killAll()
        pm.resetSeeds()
        check(pm.spawn({ paneId: 'sa', cols: 80, rows: 20, restoreScrollback: true }).seed.startsWith('SEED-sa'), 'resetSeeds (a new window after killAll) restores again')
        pm.killAll()
        pm.resetSeeds()
        const realImpl = current.impl
        current.impl = () => { throw new Error('spawn failed') }
        let threw = false
        try { pm.spawn({ paneId: 'sc', cols: 80, rows: 20, restoreScrollback: true }) } catch { threw = true }
        current.impl = realImpl
        check(threw && pm.spawn({ paneId: 'sc', cols: 80, rows: 20, restoreScrollback: true }).seed.startsWith('SEED-sc'), 'a spawn that throws does not consume the seed')
        pm.setEngine({ snapshotMode: 'off', persist: true })
        pm.killAll(); pm.resetSeeds()
        check(pm.spawn({ paneId: 'sd', cols: 80, rows: 20, restoreScrollback: true }).seed === undefined, "no seed while persistence is off ('off' mode)")
        pm.killAll()
        void h
      }
      {
        // A 600 KB seed + one chunk + a persist keeps the seed (it lives in the mirror, not the 256 KB ring).
        const { pm, h } = manager({ snapshotMode: 'auto', persist: true, persistLines: 5000 })
        const seedRows = Array.from({ length: 4000 }, (_, i) => `seed ${String(i).padStart(4, '0')} ` + 'x'.repeat(150))
        const seedText = seedRows.join('\r\n') + '\r\n'
        check(seedText.length > 600 * 1024, 'fixture: the seed is over 600 KB')
        pm.setSeedSource(() => seedText)
        const { ptyId } = pm.spawn({ paneId: 'big', cols: 200, rows: 30, restoreScrollback: true })
        h.procs[0].emit('NEW-CHUNK after restore\r\n')
        await flushAll()
        const entry = pm.entries.get(ptyId)
        check(entry.historyTruncated, 'fixture: the ring already dropped the seed head')
        const p = pm.takePersist('big')
        check(p.ansi.includes('seed 0100 ') && p.ansi.includes('seed 3999 ') && p.ansi.includes('NEW-CHUNK after restore'), 'the persisted file keeps the old seed rows and the new output')
        pm.killAll()
      }
      {
        // Clear saved history: the next save brings no old scrollback back.
        const { pm, h } = manager({ snapshotMode: 'auto', persist: true })
        pm.spawn({ paneId: 'cl', cols: 80, rows: 10 })
        for (let i = 0; i < 100; i++) h.procs[0].emit(`OLD-${i}\r\n`)
        await flushAll()
        pm.clearPersisted('cl')
        check(pm.dirtyPaneIds().length === 0, 'clearing leaves nothing dirty')
        h.procs[0].emit('NEW-1\r\n')
        const p = pm.takePersist('cl')
        check(p.ansi.includes('NEW-1') && !p.ansi.includes('OLD-10\r'), 'after a clear the next save holds only the screen and newer output')
        pm.killAll()
      }

      // ScrollbackCheckpoint: 60 s checkpoint and the synchronous exit save.
      {
        const { pm, h } = manager({ snapshotMode: 'auto', persist: true })
        const st = newStore()
        const logs = []
        const cp = new ScrollbackCheckpoint(st, pm, { staggerMs: 0, log: m => logs.push(m) })
        pm.spawn({ paneId: 'c1', cols: 80, rows: 24 })
        pm.spawn({ paneId: 'c2', cols: 80, rows: 24 })
        pm.spawn({ paneId: 'c3', cols: 80, rows: 24 })
        h.procs[0].emit('one\r\n'); h.procs[1].emit('two\r\n')
        await cp.runOnce()
        check(fs.existsSync(st.fileOf('c1')) && fs.existsSync(st.fileOf('c2')) && !fs.existsSync(st.fileOf('c3')), 'a checkpoint saves the dirty panes only')
        check(st.load('c1').ansi.includes('one') && pm.dirtyPaneIds().length === 0, 'checkpoint content and dirty flags cleared')
        const m1 = fs.statSync(st.fileOf('c1')).mtimeMs
        await cp.runOnce()
        check(fs.statSync(st.fileOf('c1')).mtimeMs === m1, 'no new output, no rewrite')
        faults.rename = 99
        h.procs[0].emit('again\r\n')
        await cp.runOnce()
        faults.rename = 0
        check(pm.dirtyPaneIds().join() === 'c1', 'a failed save puts the pane back for the next checkpoint')
        // Exit save: flushes first (last 8-250 ms of output), includes exited panes.
        h.procs[1].emit('last bytes before quit')
        h.procs[2].emit('c3 out\r\n'); h.procs[2].exit(2)
        const r = cp.persistAllSync()
        check(r.saved === 3 && r.skipped === 0, 'persistAllSync saves live and exited dirty panes')
        check(st.load('c2').ansi.includes('last bytes before quit') && st.load('c3').ansi.includes('c3 out') && st.load('c1').ansi.includes('again'), 'including unflushed output and the exited pane')
        check(cp.persistOnExit() === true && cp.persistOnExit() === false, 'persistOnExit saves once per exit')
        cp.resetExit()
        check(cp.persistOnExit() === true, 'after killAll the flag resets and the next exit saves again')
        pm.setEngine({ snapshotMode: 'auto', persist: false })
        h.procs[0].emit('ignored\r\n')
        check(cp.persistAllSync().saved === 0, 'persistence off: the exit save writes nothing')
        let ticks = 0
        const timers = { setInterval: (fn, ms) => { ticks = ms; return 7 }, clearInterval: hd => { ticks = hd === 7 ? -1 : ticks }, now: () => Date.now() }
        const cp2 = new ScrollbackCheckpoint(st, pm, { timers })
        cp2.start(); cp2.start()
        check(ticks === 60000, 'the checkpoint runs every 60 s')
        cp2.stop()
        check(ticks === -1, 'stop clears the timer')
        pm.killAll()
      }
      {
        // E6-FR-36: the OS session end (Windows window 'session-end') and
        // powerMonitor 'shutdown' (macOS/Linux) run the exit save through the
        // same once-per-exit flag, re-armed after 10 s for a cancelled shutdown.
        const { EventEmitter } = require('node:events')
        const sd = load('src/main/pty/shutdownPersist.ts')
        const { pm, h } = manager({ snapshotMode: 'auto', persist: true })
        const st = newStore()
        const cp = new ScrollbackCheckpoint(st, pm, { staggerMs: 0, log() {} })
        let saves = 0
        const realPersist = cp.persistAllSync.bind(cp)
        cp.persistAllSync = () => { saves++; return realPersist() }
        const order = [], rearms = [], logs = []
        const persist = sd.createShutdownPersist({
          checkpoint: () => cp,
          flush: () => order.push('flush'),
          log: (m, e) => logs.push(m + String(e)),
          setTimer: (fn, ms) => rearms.push({ fn, ms }),
        })
        const win = new EventEmitter(), power = new EventEmitter()
        sd.wireSessionEnd(win, () => order.push('agents'), () => { order.push('persist'); persist() })
        sd.wirePowerShutdown(power, persist)
        check(win.listenerCount('session-end') === 1 && power.listenerCount('shutdown') === 1, 'the window listens to session-end and powerMonitor to shutdown')
        pm.spawn({ paneId: 's1', cols: 80, rows: 24 })
        h.procs[0].emit('seconds before the shutdown')
        win.emit('session-end')
        check(saves === 1 && st.load('s1').ansi.includes('seconds before the shutdown'), 'session-end saves the unflushed output synchronously')
        check(order.join() === 'agents,persist,flush', 'session-end snapshots the agents first, then saves and flushes')
        check(rearms.length === 1 && rearms[0].ms === sd.SHUTDOWN_REARM_MS && sd.SHUTDOWN_REARM_MS === 10000, 'and schedules the 10 s re-arm')
        power.emit('shutdown')
        check(saves === 1 && cp.persistOnExit() === false, 'a second shutdown event or a quit path in the window does not save again (same flag)')
        rearms.forEach(r => r.fn())
        h.procs[0].emit(' and after a cancelled shutdown')
        check(cp.persistOnExit() === true && saves === 2 && st.load('s1').ansi.includes('after a cancelled shutdown'), 'after the re-arm (cancelled shutdown) the next quit saves again')
        cp.resetExit()
        power.emit('shutdown')
        check(saves === 3, 'powerMonitor shutdown saves through the same path')
        cp.resetExit()
        const broken = sd.createShutdownPersist({ checkpoint: () => ({ persistOnExit() { throw new Error('disk gone') }, resetExit() {} }), flush: () => order.push('flush2'), log: (m, e) => logs.push(m + String(e)), setTimer: (fn, ms) => rearms.push({ fn, ms }) })
        broken()
        check(order.at(-1) === 'flush2' && logs.some(l => l.includes('disk gone')) && rearms.length === 4, 'a failing exit save is logged and still flushes and re-arms')
        let unrefd = false
        const viaDefault = load('src/main/pty/shutdownPersist.ts', { setTimeout: (fn, ms) => ({ unref() { unrefd = ms === 10000 } }) })
        viaDefault.createShutdownPersist({ checkpoint: () => null })()
        check(unrefd, 'the default re-arm timer is unref\'d so it never holds the app open')
        // The composition root wires both events to this one save.
        const index = require('node:fs').readFileSync(path.join(root, 'src/main/index.ts'), 'utf8')
        check(/const persistScrollbackForShutdown = createShutdownPersist\(\{\s*checkpoint: \(\) => scrollbackCheckpoint,\s*flush: \(\) => reviewNotes\?\.flush\(\)/.test(index), 'main builds the shutdown save over the live checkpoint and review notes')
        check(index.includes("wireSessionEnd(win, () => snapshotAgentsOnce('shutdown'), persistScrollbackForShutdown)") && index.includes('wirePowerShutdown(powerMonitor, persistScrollbackForShutdown)'), 'main wires the window session-end and powerMonitor shutdown to it')
        check(!/\.on\('session-end'|\.on\('shutdown'/.test(index), 'no other session-end or shutdown handler bypasses it')
        pm.killAll()
      }
      {
        // Budget: 12 panes x 256 KB within 1500 ms, all of them saved (logs the real time).
        const { pm, h } = manager({ snapshotMode: 'auto', persist: true })
        const st = newStore()
        const cp = new ScrollbackCheckpoint(st, pm, { log() {} })
        const row = `${ESC}[38;2;200;100;50m` + 'q'.repeat(100) + `${ESC}[0m\r\n`
        for (let p = 0; p < 12; p++) {
          pm.spawn({ paneId: `b${p}`, cols: 120, rows: 40 })
          const proc = h.procs.at(-1)
          for (let i = 0; i * row.length < 256 * 1024; i++) proc.emit(row)
        }
        await flushAll()
        const r = cp.persistAllSync()
        console.log(`  persistAllSync: 12 panes x 256 KB in ${Math.round(r.ms)} ms (budget 1500 ms), saved ${r.saved}, skipped ${r.skipped}`)
        check(r.ms <= 1500 && r.saved === 12 && r.skipped === 0, 'persistAllSync saves 12 full panes within the 1500 ms budget (E6-FR-10)')
        // A clock that runs out after the first pane: the rest keep their checkpoint.
        for (let p = 0; p < 12; p++) h.procs[p].emit('more\r\n')
        let t = 0
        const slow = new ScrollbackCheckpoint(st, pm, { log() {}, timers: { setInterval: () => 0, clearInterval() {}, now: () => (t += 1000) } })
        const rs = slow.persistAllSync()
        check(rs.saved === 1 && rs.skipped === 11, 'past the 1500 ms budget the remaining panes are skipped')
        check(pm.dirtyPaneIds().length === 11, 'skipped panes stay dirty for the next save')
        pm.killAll()
      }

      // IPC: scrollback:* channels and the installer hook.
      {
        const handlers = {}
        const fakeElectron = { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn }, on() {} } }
        const ipc = load('src/main/ipc/registerPtyIpc.ts', { require: id => id === 'electron' ? fakeElectron : id === 'fs' ? fakeFs : require(id) })
        const { pm, h } = manager({ snapshotMode: 'auto', persist: true })
        const st = newStore()
        ipc.registerPtyIpc(pm, () => 'restarted', st)
        await st.save('ip1', snap('saved one'))
        check(await handlers['pty:scrollbackLoad'](null, 'ip1') === 'saved one' && await handlers['pty:scrollbackLoad'](null, 42) === null, 'pty:scrollbackLoad returns the sanitized text (contract), junk ids -> null')
        pm.spawn({ paneId: 'ip1', cols: 80, rows: 24 })
        await handlers['scrollback:clear'](null, 'ip1', { trash: true })
        check(!fs.existsSync(st.fileOf('ip1')) && fs.existsSync(path.join(st.dir, '.trash', 'ip1.json')), 'scrollback:clear with trash moves the file to the trash')
        await st.save('ip2', snap('saved two'))
        pm.spawn({ paneId: 'ip2', cols: 80, rows: 24 })
        h.procs.at(-1).emit('screen text\r\n')
        await handlers['scrollback:clear'](null, 'ip2')
        check(!fs.existsSync(st.fileOf('ip2')) && pm.dirtyPaneIds().length === 0, 'scrollback:clear deletes at once and nothing is left dirty')
        await st.save('ip3', snap('three'))
        const s1 = await handlers['scrollback:stats']()
        await handlers['scrollback:clearAll']()
        const s2 = await handlers['scrollback:stats']()
        check(s1.files === 1 && s2.files === 0 && s2.bytes === 0, 'scrollback:stats and scrollback:clearAll')
        await handlers['scrollback:clear'](null, { paneId: 'x' })
        check(true, 'a malformed clear is ignored')
        pm.killAll()

        const uh = {}
        const upd = load('src/main/ipc/registerUpdateIpc.ts', { require: id => id === 'electron' ? { ipcMain: { handle: (ch, fn) => { uh[ch] = fn }, on() {} }, app: { getVersion: () => '2.0.0', isPackaged: false }, net: {}, shell: {} } : require(id), setTimeout: () => 0 })
        const stateMod = load('src/main/updateState.ts')
        let persisted = 0
        let kind = 'win-portable'
        upd.registerUpdateIpc({
          getSender: () => null, quitForUpdate() {}, setInstalling() {},
          persistBeforeInstall: () => { persisted++ },
          install: async (_p, opts) => { opts.beforeApply(kind); return { relaunching: kind === 'win-portable' } },
          state: new stateMod.UpdateStateStore(),
        })
        await uh['update:install']()
        check(persisted === 0, 'the portable update does not use the installer hook (before-quit saves)')
        kind = 'win-installer'
        await uh['update:install']()
        check(persisted === 1, 'the NSIS installer saves the scrollback right before the setup runs')
      }

      // ConfigStore.lastLoadSource drives the GC skip.
      {
        const cfgDir = path.join(tmpRoot, 'cfg')
        fs.mkdirSync(cfgDir, { recursive: true })
        const { ConfigStore } = load('src/main/store/ConfigStore.ts', { require: id => id === 'electron' ? { app: { getPath: () => cfgDir, isPackaged: false } } : require(id), console: ptyConsole })
        const { parseConfig } = load('src/main/store/schema.ts')
        const cs = new ConfigStore()
        cs.load()
        check(cs.lastLoadSource === 'none', 'no config: lastLoadSource none')
        const good = parseConfig({
          version: 12,
          workspaces: [{ id: 'w1', name: 'Uno', cwd: 'C:/a', panes: [{ id: 'pane-1', type: 'shell', title: 'Shell', color: '#fff', icon: 'terminal' }] }],
          presets: [],
          settings: { defaultShell: {}, fontFamily: 'mono', fontSize: 13, scrollback: 1000, restoreLastWorkspace: true, confirmCloseRunning: true, sidebarCollapsed: false },
          activeWorkspaceId: 'w1',
        })
        check(good !== null, 'fixture: a minimal config parses')
        fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify(good))
        cs.load()
        check(cs.lastLoadSource === 'primary', 'readable config.json: primary')
        fs.writeFileSync(path.join(cfgDir, 'config.json.bak'), JSON.stringify(good))
        fs.writeFileSync(path.join(cfgDir, 'config.json'), '{"broken"')
        const rec = cs.load()
        check(rec !== null && cs.lastLoadSource === 'backup', 'recovered from config.json.bak: backup (the GC is skipped)')
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  }

  await shellIntegrationChecks()

  console.log(`PASS: ${checks} terminal engine checks`)
}

// --- PowerShell shell integration (E6-FR-25..31) -------------------------------
async function shellIntegrationChecks() {
  const PI = load('src/main/pty/powershellIntegration.ts')
  // FR-25: the encoded argument is the static bootstrap.
  {
    const args = PI.buildIntegrationArgs()
    check(args.length === 3 && args[0] === '-NoExit' && args[1] === '-EncodedCommand', 'integration args are -NoExit -EncodedCommand <payload>')
    const script = Buffer.from(args[2], 'base64').toString('utf16le')
    check(script === PI.integrationScript(), 'the payload is base64 UTF-16LE of the bootstrap')
    check(script.includes("]133;A") && script.includes("]133;B") && script.includes("]133;C") && script.includes("]133;D;"), 'the bootstrap writes the A, B, C and D marks')
    check(script.includes("LanguageMode -eq 'FullLanguage'") && script.startsWith("if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') {") && script.trimEnd().endsWith('}'), 'everything runs inside the FullLanguage guard')
    check(script.includes('New-Object System.Text.UTF8Encoding($false)') && script.includes('[Console]::OutputEncoding') && script.includes('[Console]::InputEncoding') && script.includes('$Global:OutputEncoding'), 'UTF-8 without BOM for console output, input and $OutputEncoding')
    check(script.includes('$Global:__SnaosOsc133') && script.includes("$env:SNAOS_SHELL_INTEGRATION = '1'") && script.includes('function Global:PSConsoleHostReadLine') && script.includes('function Global:prompt'), 'state, env flag, PSReadLine and prompt wrappers')
    check(script.indexOf("Remove-Variable -Name '__snaosEnc', '__snaosPrompt'") > script.indexOf('Prompt = $__snaosPrompt'), 'the global temporaries are removed once the state holds them')
    check(/\$ok = \$\?\n/.test(script) && script.indexOf('$ok = $?') < script.indexOf('$lec = $Global:LASTEXITCODE'), '$? is captured as the first statement of the prompt')
    check(!/[\u2013\u2014]/.test(script) && !script.includes('`') && Buffer.from(args[2], 'base64').length < 16000, 'the payload is plain ASCII PowerShell well under the command line limit')
    check(PI.buildIntegrationArgs() !== args && PI.buildIntegrationArgs().join() === args.join(), 'each call gets its own copy of the same args')
    // v2.4: claude / codex typed by hand (agent=) and the per-pty nonce (k=).
    check(PI.SHELL_MARK_ENV === 'SNAOS_SHELL_MARK' && script.includes("$env:SNAOS_SHELL_MARK -match '^[0-9a-f]{16,64}$'") && script.includes("$Global:__SnaosOsc133.Mark = ';k=' + $env:SNAOS_SHELL_MARK"), 'v2.4: the bootstrap keeps a well-formed nonce from SNAOS_SHELL_MARK')
    const removes = script.split("Remove-Item -LiteralPath 'Env:SNAOS_SHELL_MARK' -ErrorAction Ignore").length - 1
    check(removes === 2 && script.indexOf("Remove-Item -LiteralPath 'Env:SNAOS_SHELL_MARK'") > script.indexOf('.Mark = '), 'the nonce leaves the environment right after it is read, and under ConstrainedLanguage too (no child or ssh inherits it)')
    check(script.trimEnd().endsWith("} else { Remove-Item -LiteralPath 'Env:SNAOS_SHELL_MARK' -ErrorAction Ignore }"), 'the only statement outside the FullLanguage guard is that removal')
    check(script.includes("$a = Get-Item -LiteralPath ('Alias:' + $t) -ErrorAction Ignore") && !/Get-Alias|Get-Command/.test(script), 'an alias resolves by its literal name (never a wildcard, never Get-Command)')
    check(script.includes("$n -notmatch '^(claude|codex)$'") && script.includes("$r = ';agent=' + $n.ToLowerInvariant() + $s.Mark") && !/agent=' \+ \$(l|line|t)\b/.test(script), 'only the enum leaves the shell, never the command line')
    check(/\$Global:__SnaosOsc133\.Agent = \{\n    param\(\$l\)\n    \$r = ''\n    try \{/.test(script) && script.includes('    } catch {}\n    $r\n  }'), 'the Agent block runs inside try/catch and returns \'\' on any failure')
    check(script.includes("']133;C' + (& $s.Agent ([string]$line)) + [string][char]7") && script.includes("']133;D;' + $code + $s.Mark + $b") && script.includes("']133;A' + $s.Mark + $b"), 'C carries the agent block, D and A the nonce')
  }
  // FR-25: only a bare PowerShell on Windows with the setting on.
  {
    const ok = (shell, extra = {}) => PI.shouldIntegrate({ shell, args: undefined, platform: 'win32', enabled: true, ...extra })
    check(ok('powershell.exe') && ok('pwsh') && ok('C:\\Program Files\\PowerShell\\7\\pwsh.exe') && ok('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\POWERSHELL.EXE') && ok('"C:\\Tools\\pwsh.exe"'), 'powershell(.exe) and pwsh(.exe), any folder or case')
    check(!ok('cmd.exe') && !ok('bash') && !ok('powershell_ise.exe') && !ok('C:\\pwsh\\nu.exe') && !ok('pwsh-preview.exe'), 'other shells never get the integration')
    check(!ok('pwsh.exe', { args: ['-NoLogo'] }) && !ok('powershell.exe', { args: '-NoProfile' }) && ok('pwsh.exe', { args: [] }) && ok('pwsh.exe', { args: '' }), 'a shell launched with its own args keeps exactly them')
    check(!ok('pwsh.exe', { enabled: false }) && !ok('pwsh', { platform: 'linux' }) && !ok('pwsh', { platform: 'darwin' }), 'setting off or not Windows: no integration')
  }
  // FR-31: the marks are stripped before a waitFor match.
  {
    const s = PI.stripOsc133
    check(s('PS C:\\> \x1b]133;B\x07') === 'PS C:\\> ' && s('\x1b]133;D;0\x07\x1b]133;A\x07PS> \x1b]133;B\x1b\\') === 'PS> ', 'BEL and ST terminated marks are removed')
    check(s('x \x1b]0;title\x07 \x1b[32mgreen\x1b[0m') === 'x \x1b]0;title\x07 \x1b[32mgreen\x1b[0m' && s('plain') === 'plain', 'other escapes and plain text are untouched')
    check(s('PS> \x1b]133') === 'PS> ' && s('PS> \x1b]133;B') === 'PS> ' && s('PS> \x1b') === 'PS> ', 'a mark cut at the end is dropped until it completes')
    check(/> $/.test(s('user@host:~> \x1b]133;B\x07')) && !/> $/.test('user@host:~> \x1b]133;B\x07'), 'an anchored /> $/ matches only after stripping')
  }

  // PtyManager under a Windows process with a fake clock and node-pty.
  const clock = (() => {
    let now = 1_000_000, seq = 0
    const queue = new Map()
    const setT = (fn, ms = 0) => { const id = ++seq; queue.set(id, { at: now + Math.max(0, ms || 0), fn }); return id }
    const clearT = id => { queue.delete(id) }
    const micro = () => new Promise(r => setImmediate(r))
    async function advance(ms) {
      const end = now + ms
      for (;;) {
        await micro()
        let next = null
        for (const [id, t] of queue) if (t.at <= end && (!next || t.at < next.t.at || (t.at === next.t.at && id < next.id))) next = { id, t }
        if (!next) break
        queue.delete(next.id)
        now = next.t.at
        next.t.fn()
      }
      now = end
      await micro()
    }
    return { setT, clearT, advance }
  })()
  const winProcess = new Proxy(process, { get: (t, k) => (k === 'platform' ? 'win32' : t[k]) })
  const winMod = load('src/main/pty/PtyManager.ts', {
    require: id => id === 'node-pty' ? { spawn: (...a) => current.impl(...a) } : id === 'electron' ? { app: { getPath: () => os.tmpdir() } } : require(id),
    console: ptyConsole, process: winProcess, setTimeout: clock.setT, clearTimeout: clock.clearT, setInterval: () => 0, clearInterval() {},
  })
  const winManager = (engine) => {
    current = fakeHarness()
    const pm = new winMod.PtyManager(() => ({ isDestroyed: () => false, send() {} }))
    pm.setEngine(engine)
    return { pm, h: current }
  }
  const typed = proc => proc.writes.join('')
  {
    const { pm, h } = winManager({ snapshotMode: 'off', shellIntegration: true })
    const i1 = pm.spawn({ paneId: 'i1', cols: 80, rows: 24 })
    check(h.spawnCalls[0].shell === 'powershell.exe' && h.spawnCalls[0].args.join() === PI.buildIntegrationArgs().join(), 'a bare default PowerShell spawns with the integration args')
    check(h.spawnCalls[0].opts.env.SNAOS_SHELL_INTEGRATION === '1', 'and SNAOS_SHELL_INTEGRATION=1 in its env')
    const mark0 = h.spawnCalls[0].opts.env.SNAOS_SHELL_MARK
    check(/^[0-9a-f]{32}$/.test(mark0) && pm.shellMarkOf(i1.ptyId) === mark0, 'v2.4: an integrated spawn gets a 32-hex nonce in SNAOS_SHELL_MARK, which shellMarkOf returns')
    const i2 = pm.spawn({ paneId: 'i2', args: ['-NoLogo'], env: { SNAOS_SHELL_MARK: 'feedfeedfeedfeedfeedfeedfeedfeed' }, cols: 80, rows: 24 })
    check(h.spawnCalls[1].args.join() === '-NoLogo' && !('SNAOS_SHELL_INTEGRATION' in h.spawnCalls[1].opts.env), 'a spawn with args keeps them, without the flag')
    check(!('SNAOS_SHELL_MARK' in h.spawnCalls[1].opts.env) && pm.shellMarkOf(i2.ptyId) === undefined, 'no integration: no nonce, not even one a preset env supplies')
    pm.spawn({ paneId: 'i1b', cols: 80, rows: 24 })
    check(/^[0-9a-f]{32}$/.test(h.spawnCalls[2].opts.env.SNAOS_SHELL_MARK) && h.spawnCalls[2].opts.env.SNAOS_SHELL_MARK !== mark0, 'every pty gets its own nonce')
    h.spawnCalls.splice(2, 1)
    pm.setEngine({ snapshotMode: 'off', shellIntegration: false })
    pm.spawn({ paneId: 'i3', cols: 80, rows: 24 })
    check(h.spawnCalls[2].args.length === 0 && !('SNAOS_SHELL_INTEGRATION' in h.spawnCalls[2].opts.env), 'with the setting off PowerShell launches without extra args')
    pm.setEngine({ snapshotMode: 'off' })
    pm.spawn({ paneId: 'i4', cols: 80, rows: 24 })
    check(h.spawnCalls[3].args.length === 0, 'an engine payload without shellIntegration leaves it off')
    pm.killAll()
  }
  // FR-30: the initial command waits for the first prompt mark.
  {
    const { pm, h } = winManager({ snapshotMode: 'off', shellIntegration: true })
    pm.spawn({ paneId: 'r1', cols: 80, rows: 24, initialCommand: 'claude' })
    await clock.advance(2000)
    check(typed(h.procs[0]) === '', 'a slow profile: nothing typed before the prompt shows (2 s)')
    h.procs[0].emit('Loading profile...\r\n\x1b]13')
    h.procs[0].emit('3;A\x07PS C:\\> \x1b]133;B\x07')
    check(typed(h.procs[0]) === 'claude\r', 'the first 133;A (split across chunks) types the command')
    await clock.advance(5000)
    check(typed(h.procs[0]) === 'claude\r', 'typed once')
    pm.spawn({ paneId: 'r2', cols: 80, rows: 24, initialCommand: 'codex' })
    await clock.advance(400)
    check(typed(h.procs[1]) === '', 'with marks known to work, the next pane waits for its own mark too')
    h.procs[1].emit('\x1b]133;A\x07PS> ')
    check(typed(h.procs[1]) === 'codex\r', 'and types on it')
    pm.killAll()
  }
  {
    const { pm, h } = winManager({ snapshotMode: 'off', shellIntegration: true })
    pm.spawn({ paneId: 't1', cols: 80, rows: 24, initialCommand: 'claude' })
    await clock.advance(2499)
    check(typed(h.procs[0]) === '', 'no mark yet at 2499 ms')
    await clock.advance(1)
    check(typed(h.procs[0]) === 'claude\r', 'at 2500 ms without a mark the command is typed anyway')
    h.procs[0].emit('\x1b]133;A\x07PS> ')
    check(typed(h.procs[0]) === 'claude\r', 'a late mark does not type it again')
    pm.spawn({ paneId: 't2', cols: 80, rows: 24, initialCommand: 'claude' })
    await clock.advance(350)
    check(typed(h.procs[1]) === 'claude\r', 'after one pane timed out, the next uses the 350 ms timer')
    pm.setEngine({ snapshotMode: 'off', shellIntegration: false })
    pm.spawn({ paneId: 't3', cols: 80, rows: 24, initialCommand: 'claude' })
    await clock.advance(349)
    check(typed(h.procs[2]) === '', 'without the integration: nothing before 350 ms')
    await clock.advance(1)
    check(typed(h.procs[2]) === 'claude\r', 'and the command at 350 ms, as before')
    pm.spawn({ paneId: 't4', cols: 80, rows: 24, initialCommand: 'claude' })
    h.procs[3].exit(0)
    await clock.advance(3000)
    check(typed(h.procs[3]) === '', 'a pty that exits while waiting never gets the command')
    pm.killAll()
  }
  // FR-31: an anchored waitFor still matches a prompt that ends in a mark.
  {
    const { pm, h } = winManager({ snapshotMode: 'off', shellIntegration: true })
    pm.spawn({ paneId: 'w1', cols: 80, rows: 24, setup: [{ send: 'ssh host', waitFor: '/> $/', timeoutMs: 10000, delayMs: 10 }, { send: 'secret', waitFor: '/password: $/', timeoutMs: 10000, delayMs: 10 }] })
    await clock.advance(400)
    h.procs[0].emit('Loading...\r\n> not yet\r\n')
    await clock.advance(50)
    check(typed(h.procs[0]) === '', 'no prompt at the end yet: the step waits')
    h.procs[0].emit('\x1b]133;D;0\x07\x1b]133;A\x07PS C:\\> \x1b]133;B\x07')
    await clock.advance(50)
    check(typed(h.procs[0]) === 'ssh host\r', '/> $/ matches the local prompt with the marks on')
    h.procs[0].emit('user@host password: ')
    await clock.advance(50)
    check(typed(h.procs[0]) === 'ssh host\rsecret\r', 'the next step matches as usual')
    pm.killAll()
  }
  // A secret step blanked by an export stops the setup: no bare Enter in the
  // password prompt, no later step nor agent command typed there.
  {
    current = fakeHarness()
    const sent = []
    const pm = new winMod.PtyManager(() => ({ isDestroyed: () => false, send: (ch, p) => sent.push({ ch, p }) }))
    pm.setEngine({ snapshotMode: 'off', shellIntegration: false })
    const h = current
    const prompts = []
    pm.addPromptListener(evt => prompts.push(evt))
    pm.setSetupNoticeSource(step => `paso ${step} sin secreto\x07`)
    const warns = []
    const oldWarn = ptyConsole.warn
    ptyConsole.warn = (...a) => warns.push(a.join(' '))
    const steps = [
      { send: 'ssh me@host', delayMs: 10 },
      { send: '', waitFor: 'password:', timeoutMs: 10000, delayMs: 10, secret: true },
      { send: 'cd /srv', waitFor: '$ ', timeoutMs: 10000, delayMs: 10 },
    ]
    pm.spawn({ paneId: 's1', cols: 80, rows: 24, setup: steps, initialCommand: 'claude', initialPrompt: { text: 'hola', enter: true } })
    await clock.advance(400)
    check(typed(h.procs[0]).startsWith('ssh me@host\r'), 'the steps before the blank secret run')
    h.procs[0].emit('me@host password: ')
    await clock.advance(1000)
    h.procs[0].emit('\r\n$ ')
    await clock.advance(15000)
    check(!/\r\r|ssh me@host\r(\r|cd|claude)/.test(typed(h.procs[0])) && !typed(h.procs[0]).includes('cd /srv') && !typed(h.procs[0]).includes('claude'), 'no Enter for the blank secret, no later step and no agent command')
    const out = sent.filter(s => s.ch === 'pty:data').map(s => s.p.data).join('')
    check(out.includes('paso 2 sin secreto') && !out.includes('\x07---'), 'the pane shows the localized notice for step 2, control characters stripped')
    check(warns.some(w => w.includes('stopped at step 2')) && !warns.some(w => w.includes('hola')), 'main logs the stop (step only, no text)')
    check(prompts.length === 1 && prompts[0].paneId === 's1' && prompts[0].result === 'not_delivered', 'the initial prompt is reported as not delivered, never sent or gated')
    ptyConsole.warn = oldWarn
    pm.killAll()
  }
  {
    // A secret step WITH text and a plain empty step (a bare Enter) still run.
    const { pm, h } = winManager({ snapshotMode: 'off', shellIntegration: false })
    pm.spawn({ paneId: 's2', cols: 80, rows: 24, setup: [{ send: '', delayMs: 10 }, { send: 'pw', delayMs: 10, secret: true }], initialCommand: 'claude' })
    await clock.advance(2000)
    check(typed(h.procs[0]) === '\rpw\rclaude\r', 'a non secret empty step and a filled secret step are typed as before')
    pm.killAll()
  }

  // Schema 14 key (R31-00 owns the bump): tolerant of junk, default on.
  {
    const { parseConfig } = load('src/main/store/schema.ts')
    const base = {
      version: 13,
      workspaces: [], presets: [], activeWorkspaceId: null,
      settings: { defaultShell: {}, fontFamily: 'mono', fontSize: 13, scrollback: 1000, restoreLastWorkspace: true, confirmCloseRunning: true, sidebarCollapsed: false },
    }
    const withKey = v => parseConfig({ ...base, settings: { ...base.settings, terminalShellIntegration: v } })
    check(parseConfig(base).settings.terminalShellIntegration === true && withKey('x').settings.terminalShellIntegration === true && withKey(false).settings.terminalShellIntegration === false, 'terminalShellIntegration defaults to true, junk falls back, false is kept')
    const { engineFromSettings } = load('src/shared/terminalEngine.ts')
    check(engineFromSettings({}).shellIntegration === true && engineFromSettings({ terminalShellIntegration: false }).shellIntegration === false && engineFromSettings(null).shellIntegration === true, 'engineFromSettings carries the setting (on unless turned off)')
  }

  // Keymap (E6-FR-27): the prompt jumps on Ctrl+Shift+PageUp/PageDown, remappable.
  {
    const { KEY_ACTIONS, resolveKeymap } = load('src/renderer/lib/keymap.ts')
    const km = resolveKeymap(undefined)
    check(km.promptPrev === 'Ctrl+Shift+PageUp' && km.promptNext === 'Ctrl+Shift+PageDown', 'promptPrev/promptNext defaults per D8')
    const accels = KEY_ACTIONS.map(a => a.defaultAccel)
    check(new Set(accels).size === accels.length && km.workspacePrev === 'Ctrl+PageUp' && km.focusPrevPane === 'Ctrl+Alt+Left', 'no default accelerator is shared')
    check(resolveKeymap({ promptPrev: 'Alt+Up' }).promptPrev === 'Alt+Up', 'the prompt jumps can be remapped')
  }

  // Renderer marks (E6-FR-26..29) on a real headless xterm 5.5.
  {
    const SM = load('src/renderer/components/terminal/shellMarks.ts', { TextEncoder, TextDecoder })
    const { Terminal } = require('@xterm/headless')
    const make = (cols = 40, rows = 10) => {
      const term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true })
      const marks = new SM.ShellMarks(term, { exitTitle: c => 'Exited with code ' + c })
      const write = d => new Promise(r => term.write(d, r))
      return { term, marks, write }
    }
    const A = '\x1b]133;A\x07', B = '\x1b]133;B\x07', C = '\x1b]133;C\x07', D = c => `\x1b]133;D;${c}\x07`
    {
      const { term, marks, write } = make()
      check(!marks.hasLastOutput() && marks.lastOutput() === null && !marks.navigate(-1) && !marks.navigate(1), 'without marks every action is inert')
      await write(`${A}PS C:\\> ${B}dir\r\n${C}\r\n    Directory: C:\\\r\n\r\nfile1.txt   \r\nfile2.txt\r\n\r\n${D(0)}${A}PS C:\\> ${B}`)
      check(marks.commands.length === 2 && marks.commands[0].exitCode === 0 && marks.commands[0].start && marks.commands[0].end && !marks.commands[1].start, 'A/C/D make one finished command plus the live prompt')
      check(marks.hasLastOutput() && marks.lastOutput() === '    Directory: C:\\\n\nfile1.txt\nfile2.txt', 'the last output is the text between C and D, trimmed, without the prompt')
      await write(`cmd /c exit 7\r\n${C}${D(7)}${A}PS C:\\> ${B}`)
      check(marks.commands[1].exitCode === 7 && marks.lastOutput() === '', 'a failing command records its code; an empty output copies empty')
      await write(`echo ${'x'.repeat(70)}\r\n${C}${'y'.repeat(70)}\r\n${D(0)}${A}PS C:\\> ${B}`)
      check(marks.lastOutput() === 'y'.repeat(70), 'a soft-wrapped output line is joined')
      await write(`\x1b[?1049h${A}${C}${D(3)}\x1b[?1049l`)
      check(marks.commands.length === 4 && marks.commands[2].exitCode === 0, 'marks inside the alternate screen are ignored')
      term.dispose()
    }
    {
      // FR-27: jumps put the prompt on the first row of the viewport.
      const { term, marks, write } = make(40, 10)
      for (let i = 0; i < 5; i++) {
        let out = ''
        for (let j = 0; j < 30; j++) out += `cmd${i} line ${j}\r\n`
        await write(`${A}PS> ${B}cmd${i}\r\n${C}${out}${D(0)}`)
      }
      await write(`${A}PS> ${B}`)
      const lines = marks.promptLines()
      const buf = () => term.buffer.active
      check(lines.length === 6 && buf().viewportY === buf().baseY, 'six prompts, viewport at the bottom')
      check(marks.navigate(-1) && buf().viewportY === lines[4], 'previous: the last command prompt on the first row')
      check(marks.navigate(-1) && buf().viewportY === lines[3], 'previous again: the one before')
      check(marks.navigate(1) && buf().viewportY === lines[4], 'next: back down one prompt')
      check(marks.navigate(1) && buf().viewportY === buf().baseY, 'next past the last command: capped at the live bottom')
      term.scrollToLine(lines[0])
      check(!marks.navigate(-1) && buf().viewportY === lines[0], 'no prompt above the first: nothing moves')
      check(SM.navTarget([2, 10, 20], 15, 30, -1) === 10 && SM.navTarget([2, 10, 20], 15, 30, 1) === 20 && SM.navTarget([2, 10, 40], 15, 30, 1) === 30 && SM.navTarget([], 5, 9, 1) === null && SM.navTarget([-1, 3], 5, 9, -1) === 3, 'navTarget picks the closest prompt and skips trimmed markers')
      term.dispose()
    }
    {
      // FR-26: 1000 commands per pane, the oldest markers disposed.
      const { term, marks, write } = make(40, 10)
      let chunk = ''
      for (let i = 0; i < 1200; i++) chunk += `${A}> ${B}c\r\n${C}o${i}\r\n${D(i % 2)}`
      await write(chunk.slice(0, chunk.length / 2))
      const first = marks.commands[0].prompt
      await write(chunk.slice(chunk.length / 2))
      check(marks.commands.length === 1000 && first.isDisposed, 'after 1200 commands 1000 records stay and the old markers are disposed')
      check(marks.lastOutput() === 'o1199' && marks.commands.at(-1).exitCode === 1, 'the newest record is intact')
      marks.dispose()
      check(marks.commands.length === 0, 'dispose drops every record')
      await write(`${A}> `)
      check(marks.commands.length === 0, 'a disposed parser no longer handles marks')
      term.dispose()
    }
    // FR-29: the 1 MB cap never splits a character.
    check(SM.capBytes('abc', 10) === 'abc' && SM.capBytes('aé€', 4) === 'aé' && SM.capBytes('€€', 5) === '€' && SM.MAX_COPY_BYTES === 1048576, 'capBytes cuts at a UTF-8 character boundary')
  }
}
main().catch(e => { console.error(e); process.exit(1) })
