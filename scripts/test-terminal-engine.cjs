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
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws', 'node-pty'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
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
const loaded = load('src/main/pty/PtyManager.ts', {
  require: id => id === 'node-pty' ? { spawn: (...a) => current.impl(...a) } : id === 'electron' ? { app: { getPath: () => os.tmpdir() } } : require(id),
  console: { ...console, warn() {} },
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
function manager() {
  current = fakeHarness()
  const pm = new loaded.PtyManager(() => ({ isDestroyed: () => false, send: (ch, p) => current.sent.push({ ch, p }) }))
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
