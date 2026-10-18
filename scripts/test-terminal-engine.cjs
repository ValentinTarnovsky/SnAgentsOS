// Terminal engine (E6): ModeTracker, replay hygiene, the exit frame, the
// in-place restart and the exited record, the phone exit strip state and the
// default shell resolution, against the real main-process modules with a fake
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
    check(res.ptyId !== first.ptyId && res.tail === restartTail('reiniciado 14:32') && ['powershell', 'posix', 'other', 'cmd'].includes(res.shellKind), 'restart returns the new pty, its tail and shell kind')
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

  console.log(`PASS: ${checks} terminal engine checks`)
}
main().catch(e => { console.error(e); process.exit(1) })
