// Crash resilience suite (E4-FR-19..25): esbuild + vm, no Electron, runs on the ubuntu CI.
// Breaker, shouldAutoReload, recovery flow with fake windows/timers, crash store,
// render-error throttle, redact and the diagnostics allowlist.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const fs = require('node:fs')
const os = require('node:os')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws', 'node-pty'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, URL, AbortController, TextEncoder, setTimeout, clearTimeout, ...overrides })
  return mod.exports
}
function loadRenderer(contents, overrides = {}) {
  const code = buildSync({ stdin: { contents, resolveDir: path.join(root, 'src/renderer/lib'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, TextEncoder, crypto: globalThis.crypto, setTimeout, clearTimeout, ...overrides })
  return mod.exports
}
const flush = () => new Promise(r => setImmediate(r))

async function main() {
  // --- RecoveryBreaker / shouldAutoReload (pure) ------------------------------
  {
    const { RecoveryBreaker, shouldAutoReload, decideRecovery, MAX_AUTO_RELOADS, RELOAD_WINDOW_MS } = load('src/main/crash/RecoveryBreaker.ts')
    check(MAX_AUTO_RELOADS === 2 && RELOAD_WINDOW_MS === 60000, 'breaker allows 2 automatic reloads per 60 s')
    const b = new RecoveryBreaker()
    check(b.canRecover(0), 'fresh breaker can recover')
    b.record(0); b.record(10_000)
    check(!b.canRecover(20_000) && b.countInWindow(20_000) === 2, 'third crash inside 60 s trips the breaker')
    check(b.canRecover(60_001) && b.countInWindow(60_001) === 1, 'the window rolls: the oldest reload ages out')
    b.record(60_001)
    b.reset()
    check(b.canRecover(60_002) && b.countInWindow(60_002) === 0, 'a manual reload resets it')
    const base = { reason: 'crashed', isQuitting: false, bypassCloseGuards: false, destroyed: false, updateRelaunchPending: false }
    check(shouldAutoReload(base), 'a crash reloads')
    check(shouldAutoReload({ ...base, reason: 'oom' }) && shouldAutoReload({ ...base, reason: 'killed' }), 'oom and killed reload')
    check(!shouldAutoReload({ ...base, reason: 'clean-exit' }), 'clean-exit never reloads')
    check(!shouldAutoReload({ ...base, isQuitting: true }), 'quitting never reloads')
    check(!shouldAutoReload({ ...base, bypassCloseGuards: true }), 'an update quit never reloads')
    check(!shouldAutoReload({ ...base, destroyed: true }), 'a destroyed window never reloads')
    check(!shouldAutoReload({ ...base, updateRelaunchPending: true }), 'a pending update relaunch never reloads')
    check(shouldAutoReload({ ...base, reason: null }), 'the unresponsive path (no reason) passes the guards')
    const b2 = new RecoveryBreaker()
    check(decideRecovery({ ...base, isQuitting: true }, b2, 0) === 'ignore', 'decideRecovery ignores while quitting')
    b2.record(0); b2.record(1)
    check(decideRecovery(base, b2, 2) === 'dialog', 'decideRecovery opens the dialog once tripped')
  }

  // --- RendererRecovery with a fake window and timers -------------------------
  {
    const { RendererRecovery } = load('src/main/crash/rendererRecovery.ts')
    const mk = (over = {}) => {
      const st = { now: 1_000, timers: [], writes: [], boxes: [], answers: [], reloads: 0, kills: 0, hidden: 0, quits: 0, copies: 0, quitting: false, bypass: false, relaunch: false, consoles: 3, crashed: false, visible: true, destroyed: false }
      const win = {
        isDestroyed: () => st.destroyed,
        isVisible: () => st.visible,
        webContents: { reload: () => { st.reloads++ }, forcefullyCrashRenderer: () => { st.kills++ }, isCrashed: () => st.crashed },
      }
      const rec = new RendererRecovery({
        isQuitting: () => st.quitting, bypassCloseGuards: () => st.bypass, updateRelaunchPending: () => st.relaunch,
        consoles: () => st.consoles,
        crashes: { write: r => { st.writes.push(r); return r } },
        t: (k, v) => k + (v ? JSON.stringify(v) : ''),
        productName: 'SnAgentsOS',
        showMessageBox: (w, opts) => { st.boxes.push({ parented: !!w, opts }); return new Promise((res, rej) => { const a = st.answers.shift(); if (a === 'abort') { opts.signal.addEventListener('abort', () => rej(new Error('aborted'))) } else res({ response: a ?? 2 }) }) },
        copyDiagnostics: () => { st.copies++ },
        hideToBackground: () => { st.hidden++ },
        quitSkippingGuards: () => { st.quits++ },
        now: () => st.now,
        setTimer: (fn, ms) => { st.timers.push({ fn, ms }) },
        ...over,
      })
      const runTimers = () => { const t = st.timers.splice(0); for (const x of t) x.fn(); return t }
      return { st, win, rec, runTimers }
    }
    {
      const { st, win, rec, runTimers } = mk()
      rec.onGone(win, { reason: 'crashed', exitCode: 5 })
      check(st.writes.length === 1 && st.writes[0].kind === 'render-process-gone' && st.writes[0].exitCode === 5, 'a crash writes a render-process-gone record')
      check(st.reloads === 0 && st.timers.length === 1 && st.timers[0].ms === 300, 'the reload waits 300 ms')
      runTimers()
      check(st.reloads === 1, 'first crash reloads automatically')
      const info = rec.takeRecovery()
      check(info && info.reason === 'crashed' && info.exitCode === 5 && info.consoles === 3 && info.autoReloadsInWindow === 1, 'takeRecovery returns the recovery with N counted at take time')
      check(rec.takeRecovery() === null, 'the recovery is consumed once')
      st.now += 5_000; rec.onGone(win, { reason: 'killed', exitCode: 1 }); runTimers()
      check(st.reloads === 2, 'second crash in 60 s still reloads')
      st.now += 5_000; st.answers.push(1, 2)
      rec.onGone(win, { reason: 'killed', exitCode: 1 }); runTimers()
      await flush(); await flush()
      check(st.reloads === 2, 'third crash in 60 s does not reload')
      check(st.boxes.length === 2 && st.copies === 1, '[Copy diagnostics] copies and shows the dialog again')
      check(st.hidden === 1, '[Leave in background] hides the window')
      const b = st.boxes[0].opts
      check(b.buttons.length === 4 && b.buttons[3].includes('crash.closeMany') && b.buttons[3].includes('"n":3') && b.detail.includes('crash.breaker.detailMany'), 'the dialog names the N consoles that keep running and that [Close] closes')
      check(b.cancelId === 2 && b.defaultId === 0, 'Esc leaves the app in background; Enter retries')
      st.answers.push(0); rec.onGone(win, { reason: 'crashed', exitCode: 1 }); await flush(); await flush()
      check(st.reloads === 3 && rec.breaker.canRecover(st.now), '[Retry] reloads by hand and resets the breaker')
      check(rec.takeRecovery() === null, 'a manual reload never shows the recovery card')
      st.consoles = 1
      rec.breaker.record(st.now); rec.breaker.record(st.now)
      st.answers.push(3); rec.onGone(win, { reason: 'crashed', exitCode: 1 }); await flush(); await flush()
      check(st.quits === 1 && st.boxes.at(-1).opts.buttons[3].includes('crash.closeOne'), '[Close (closes 1 console)] quits skipping the guards')
    }
    {
      const { st, win, rec, runTimers } = mk()
      st.quitting = true
      rec.onGone(win, { reason: 'crashed', exitCode: 1 }); runTimers()
      check(st.reloads === 0 && st.writes.length === 0, 'quitting the app triggers no reload')
      st.quitting = false; st.bypass = true
      rec.onGone(win, { reason: 'crashed', exitCode: 1 }); runTimers()
      check(st.reloads === 0, 'an update quit triggers no reload')
      st.bypass = false
      rec.onGone(win, { reason: 'clean-exit', exitCode: 0 }); runTimers()
      check(st.reloads === 0 && st.writes.length === 0, 'clean-exit is neither recorded nor reloaded')
      st.relaunch = true
      rec.onGone(win, { reason: 'crashed', exitCode: 1 }); runTimers()
      check(st.reloads === 0 && st.writes.length === 1, 'a pending update relaunch records the crash but does not reload')
      st.relaunch = false
      rec.onGone(win, { reason: 'crashed', exitCode: 1 })
      st.quitting = true; runTimers()
      check(st.reloads === 0, 'a quit that starts during the 300 ms delay cancels the reload')
    }
    {
      const { st, win, rec } = mk()
      st.visible = false
      st.answers.push(1)
      rec.onUnresponsive(win)
      await flush(); await flush()
      check(st.writes[0].kind === 'unresponsive' && st.boxes[0].opts.buttons.join() === 'crash.wait,crash.reload', 'a hang records the crash and asks [Wait] / [Reload window]')
      check(!st.boxes[0].parented, 'a hidden window gets an unparented dialog')
      check(st.kills === 1 && st.reloads === 1, '[Reload window] kills the hung renderer and reloads')
      check(rec.breaker.countInWindow(st.now) === 1, 'the hang reload counts for the breaker')
      rec.onGone(win, { reason: 'killed', exitCode: 1 })
      check(st.writes.length === 1, 'our own kill is not a second crash')
      check(rec.takeRecovery()?.reason === 'unresponsive', 'the hang recovery shows the card')
      st.answers.push('abort'); rec.onUnresponsive(win); rec.onResponsive(); await flush(); await flush()
      check(st.kills === 1 && st.reloads === 1, 'the renderer answering again closes the dialog without reloading')
      st.answers.push('abort'); rec.onUnresponsive(win); rec.onGone(win, { reason: 'crashed', exitCode: 2 }); await flush(); await flush()
      check(st.boxes.at(-1).opts.signal.aborted && st.kills === 1 && st.reloads === 1 && st.timers.some(t => t.ms === 300), 'a hung renderer that crashes closes its dialog and takes the normal reload path')
      st.quitting = true; const before = st.boxes.length; rec.onUnresponsive(win)
      check(st.boxes.length === before, 'no hang dialog during the quit')
    }
    {
      const { st, win, rec } = mk()
      st.crashed = true; rec.ensureAlive(win)
      check(st.reloads === 1, 'showing a window whose renderer is dead reloads it')
      st.crashed = false; rec.ensureAlive(win)
      check(st.reloads === 1, 'a live renderer is left alone')
    }
    {
      const { st, rec } = mk()
      for (let i = 0; i < 100; i++) { st.now += 100; rec.reportRenderError({ scope: 'pane', paneId: 'p1', message: 'boom', stack: 'x'.repeat(20000), at: st.now }) }
      check(st.writes.length === 1, '100 equal render errors in 10 s write one record')
      check(st.writes[0].stack.length === 8192, 'main trims the stack to 8KB')
      check(!rec.reportRenderError({ scope: 'nope', message: 'x', at: 1 }) && !rec.reportRenderError('junk') && !rec.reportRenderError({ scope: 'pane', at: 1 }), 'invalid payloads are rejected by zod')
      for (let i = 0; i < 20; i++) rec.reportRenderError({ scope: 'app', message: 'distinct ' + i, at: st.now })
      check(st.writes.length === 10, 'at most 10 render-error records per minute')
      check(rec.recentRenderErrors().length === 10, 'main keeps the last 10 accepted reports')
      st.now += 61_000
      check(rec.reportRenderError({ scope: 'pane', paneId: 'p1', message: 'boom', at: st.now }), 'the same key goes through again after 60 s')
    }
  }

  // --- CrashStore -------------------------------------------------------------
  {
    const { CrashStore, CRASH_MAX_BYTES } = load('src/main/crash/crashStore.ts', { console: { ...console, warn: () => {} } })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snaos-crash-'))
    const store = new CrashStore(path.join(dir, 'crashes'), '2.0.0')
    for (let i = 0; i < 25; i++) store.write({ kind: 'render-process-gone', at: 1_700_000_000_000 + i, reason: 'crashed', exitCode: i })
    const files = fs.readdirSync(path.join(dir, 'crashes'))
    check(files.length === 20 && files.every(f => f.endsWith('.json')), 'with 25 crashes 20 JSON files stay')
    const list = store.list(5)
    check(list.length === 5 && list[0].exitCode === 24 && list[4].exitCode === 20, 'list returns the newest first')
    check(list[0].version === '2.0.0' && typeof list[0].id === 'string', 'records carry the version and an id')
    const big = store.write({ kind: 'render-error', at: 1_800_000_000_000, scope: 'pane', message: 'm'.repeat(5000), stack: 'é'.repeat(9000), componentStack: 'ü'.repeat(9000) })
    const raw = fs.readFileSync(path.join(dir, 'crashes', big.id + '.json'))
    check(raw.length <= CRASH_MAX_BYTES && big.message.length === 1024, 'each record stays under 16KB, message trimmed')
    check(raw[0] !== 0xef, 'records are written without a BOM')
    check(!fs.readdirSync(path.join(dir, 'crashes')).some(f => f.endsWith('.tmp')), 'no temp file is left behind (atomic rename)')
    const home = 'C:\\Users\\Tester'
    const scrubbed = new CrashStore(path.join(dir, 'scrubbed'), '2.0.0', 20, () => ({ home, extraSecrets: ['hunter2'] }))
    const red = scrubbed.write({ kind: 'render-error', at: 1_800_000_000_001, scope: 'window', message: 'login hunter2 failed', stack: 'at f (c:\\users\\tester\\app\\x.js:1:2)\nat g (C:\\Users\\Tester\\y.js:3:4)' })
    const redRaw = fs.readFileSync(path.join(dir, 'scrubbed', red.id + '.json'), 'utf8')
    check(!redRaw.includes('hunter2') && !/tester/i.test(redRaw) && redRaw.includes('~'), 'crash records are redacted on disk (secrets and home folder)')
    const throwing = new CrashStore(path.join(dir, 'throwing'), '2.0.0', 20, () => { throw new Error('config unreadable') })
    check(throwing.write({ kind: 'unresponsive', at: 2 }) !== null, 'a failing redact source never blocks the record')
    const blocked = new CrashStore(path.join(dir, 'crashes', big.id + '.json', 'sub'), '2.0.0')
    check(blocked.write({ kind: 'unresponsive', at: 1 }) === null, 'a failed write returns null instead of throwing')
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // --- render-error throttle (shared) ------------------------------------------
  {
    const { RenderErrorThrottle, renderErrorKey } = load('src/shared/renderErrorThrottle.ts')
    const t = new RenderErrorThrottle()
    let ok = 0
    for (let i = 0; i < 100; i++) if (t.allow(renderErrorKey('pane', 'same'), i * 100)) ok++
    check(ok === 1, '100 equal errors in 10 s pass once')
    let n = 0
    for (let i = 0; i < 15; i++) if (t.allow(renderErrorKey('app', 'e' + i), 20_000)) n++
    check(n === 9, 'the per-minute cap counts every key (1 + 9 = 10)')
    check(t.allow(renderErrorKey('app', 'late'), 80_001), 'the cap rolls after a minute')
    check(renderErrorKey('a', 'x') !== renderErrorKey('b', 'x'), 'the key includes the scope')
  }

  // --- redact (shared) ----------------------------------------------------------
  {
    const { redact, maskIpv4 } = load('src/shared/redact.ts')
    const home = 'C:\\Users\\Tarno'
    const text = [
      'pass hunter2 again hunter2', 'tok abc', 'https://discord.com/api/webhooks/123456/AbC-def_9', 'https://discordapp.com/api/webhooks/9/x',
      'hash 0123456789abcdef0123456789ABCDEF00', 'http://192.168.1.20:4517/#pair=abc.def ok',
      'path c:\\users\\tarno\\proj and C:/Users/Tarno/x and C:\\\\Users\\\\Tarno\\\\y', 'ips 10.1.2.3 172.20.0.1 100.100.5.5 8.8.8.8 172.32.0.1 999.1.1.1',
    ].join('\n')
    const out = redact(text, { home, extraSecrets: ['hunter2', 'abc', ''] })
    check(!out.includes('hunter2') && out.includes('pass <redacted> again <redacted>'), 'extra secrets are replaced everywhere')
    check(out.includes('tok abc'), 'secrets shorter than 4 chars are ignored')
    check(out.includes('https://<discord-webhook>') && !out.includes('AbC-def_9') && out.includes('https://<discord-webhook>\n'), 'discord webhooks are masked')
    check(out.includes('hash <redacted>'), 'long hex runs are redacted')
    check(out.includes('#pair=<redacted> ok') && out.includes('192.168.x.x:4517'), 'pair fragments and private IPs are masked')
    check(out.includes('path ~\\proj and ~/x and ~\\\\y') && !/tarno/i.test(out), 'the Windows home is replaced case-insensitively in every slash form')
    check(out.includes('10.1.x.x') && out.includes('172.20.x.x') && out.includes('100.100.x.x') && out.includes('8.8.8.8') && out.includes('172.32.0.1') && out.includes('999.1.1.1'), 'only RFC1918 and 100.64/10 are masked')
    check(redact('/home/ana/x and /HOME/ANA/y', { home: '/home/ana' }) === '~/x and /HOME/ANA/y', 'a POSIX home is case-sensitive')
    check(redact('plain') === 'plain' && maskIpv4('192.168.0.1') === '192.168.x.x' && maskIpv4('1.2.3.4') === '1.2.3.4', 'no options leaves plain text alone')
    // app 2.3.0: Claude OAuth tokens (fake ones) and account emails never survive a copied log line.
    const fakeAccess = 'sk-' + 'ant-oat01-' + 'Fake_Token-For-Tests-Only'.repeat(3)
    const fakeRefresh = 'sk-' + 'ant-ort01-' + 'AnotherFake_value-0123456789'
    const log = redact(`[accounts] switch to ana.perez+work@example.co.uk failed: ${fakeAccess} / ${fakeRefresh} ssh dev@192.168.1.9`)
    check(!log.includes('sk-ant-') && !log.includes('Fake_Token') && log.split('<redacted>').length === 3, 'Claude OAuth tokens are redacted')
    check(!log.includes('@example') && log.includes('<email>') && log.includes('ssh dev@192.168.x.x'), 'emails become <email>; user@ip stays (masked ip)')
  }

  // --- logRing ------------------------------------------------------------------
  {
    const { installLogRing, recentLogLines, LOG_RING_MAX } = load('src/main/diagnostics/logRing.ts')
    const seen = []
    const fake = { warn: (...a) => seen.push(['w', ...a]), error: (...a) => seen.push(['e', ...a]) }
    installLogRing(fake)
    fake.warn('careful', { a: 1 }); fake.error(new Error('bad thing'))
    check(seen.length === 2, 'the original console still prints')
    const lines = recentLogLines(10)
    check(lines.length === 2 && /WARN careful \{"a":1\}$/.test(lines[0]) && lines[1].includes('ERROR Error: bad thing'), 'warn/error lines are remembered with level and stack')
    for (let i = 0; i < 300; i++) fake.warn('line ' + i)
    check(recentLogLines(1000).length === LOG_RING_MAX && recentLogLines(1)[0].endsWith('line 299'), 'the ring keeps the last 200 lines')
  }

  // --- buildDiagnostics allowlist ---------------------------------------------------
  {
    const { buildDiagnostics, diagnosticsSecrets, DIAGNOSTICS_MAX_BYTES } = load('src/main/diagnostics/buildDiagnostics.ts')
    const hookToken = 'f'.repeat(16) + 'tokentoken'
    const webhook = 'https://discord.com/api/webhooks/42/SeCrEt-Hook'
    const config = {
      version: 12,
      workspaces: [{ id: 'w1', name: 'Client secret project', cwd: 'C:\\Users\\Tarno\\work', panes: [{ id: 'p1', type: 'shell', title: 'prod db', schedules: [{ id: 's1', time: '10:00', prompt: 'deploy please', dueAt: 1 }, { id: 's2', time: '11:00', prompt: 'deploy again', dueAt: 2, recurrence: { kind: 'cron', expr: '0 11 * * 1-5' } }] }, { id: 'p2', type: 'claude', title: 'b', schedules: [{ id: 's1', time: '12:00', prompt: 'x', dueAt: 3 }] }] }],
      presets: [{ id: 'x' }],
      settings: {
        language: 'es', theme: 'midnight', terminalRenderer: 'canvas', globalHotkey: 'Super+Alt+O', keymap: { palette: 'Ctrl+K' },
        closeToTray: true, gitChip: false, remote: { enabled: true, port: 4517 },
        notifications: { enabled: true, hooksEnabled: true, hookToken, discord: { enabled: true, webhookUrl: webhook }, ntfy: { enabled: false, topic: 'mytopic123', token: 'tk_secretvalue' } },
        usage: { customModels: [{ name: 'my-private-model' }] },
      },
      connections: [{ id: 'c1', name: 'ssh prod', steps: [{ send: 'ssh admin@host' }, { send: 'hunter2', secret: true }] }],
      quickCommands: [{ id: 'q', name: 'n', text: 'rm -rf secret-dir' }],
      keyButtons: [{ id: 'k', label: 'K', seq: 'x' }],
    }
    check(diagnosticsSecrets(config).includes('hunter2') && diagnosticsSecrets(config).includes(hookToken) && diagnosticsSecrets(null).length === 0, 'secrets list covers connection sends and tokens')
    const input = {
      app: { version: '2.0.0', installKind: 'win-installer', platform: 'win32', arch: 'x64', osRelease: '10.0.26200', systemVersion: '10.0.26200', electron: '33.2.0', chrome: '130', node: '20.18', uptimeSec: 3725 },
      configVersion: 12, config,
      renderer: { renderErrors: [{ scope: 'pane', paneId: 'p1', message: 'Cannot read hunter2 of C:\\Users\\Tarno', stack: 'at C:\\Users\\Tarno\\app.js:1', at: 1 }], workspaces: 1, panes: 2, connections: 1, snippets: 1, lang: 'es' },
      mainRenderErrors: [],
      metrics: { memMB: 512, cpuPercent: 3.5, processes: 6, consoles: 2 },
      health: { desktop: { error: null }, claude: { installed: true, settingsPath: 'C:\\Users\\Tarno\\.claude\\settings.json', port: 4519, complete: true, running: true, lastEventAt: 1 }, codex: { enabled: false, available: true, connected: 0 }, discord: { lastSuccessAt: null, error: 'POST ' + webhook + ' failed', queued: 0 } },
      remote: { state: 'running', port: 4517, endpoints: [{ kind: 'lan', ip: '192.168.1.20', url: 'http://192.168.1.20:4517' }, { kind: 'tailscale', ip: '100.101.1.2', url: 'x' }], connectedCount: 1 },
      crashes: [{ id: 'c', kind: 'render-process-gone', at: 2, version: '2.0.0', reason: 'crashed', exitCode: 5 }],
      logLines: ['2026 WARN hook /hook/' + hookToken + ' at C:\\Users\\Tarno\\x', '2026 ERROR ntfy tk_secretvalue failed', '2026 WARN sent hunter2'],
      home: 'C:\\Users\\Tarno',
    }
    const text = buildDiagnostics(input)
    check(!text.includes('hunter2'), 'a connection send ("hunter2") never appears')
    check(!text.includes(hookToken) && !text.includes('tokentoken'), 'the hookToken never appears')
    check(!text.includes('SeCrEt-Hook') && !text.includes('webhooks/42'), 'the webhook URL never appears')
    check(!/tarno/i.test(text), 'the home path never appears')
    check(!text.includes('tk_secretvalue') && !text.includes('mytopic123'), 'ntfy topic and token never appear')
    for (const leak of ['Client secret project', 'prod db', 'deploy please', 'deploy again', '0 11 * * 1-5', 'ssh admin', 'rm -rf', 'Super+Alt+O', 'Ctrl+K', 'my-private-model', 'ssh prod'])
      check(!text.includes(leak), `allowlist keeps out "${leak}"`)
    check(text.includes('Version: 2.0.0 (win-installer)') && text.includes('Config version: 12') && text.includes('Uptime: 1h 02m'), 'version, install kind, config version and uptime are listed')
    check(text.includes('closeToTray=on') && text.includes('gitChip=off') && text.includes('remote.enabled=on') && text.includes('terminalRenderer=canvas'), 'feature booleans and enums are listed')
    check(text.includes('workspaces 1, panes 2, connections 1, quick commands 1') && text.includes('schedules 3'), 'counts are listed (schema 19: every schedule of every console)')
    check(text.includes('lan 192.168.x.x') && text.includes('tailscale 100.101.x.x') && text.includes('port 4517'), 'remote state with masked IPs')
    check(text.includes('render-process-gone (reason crashed, exit 5') && text.includes('[pane] pane p1'), 'crashes and render errors are listed')
    check(Buffer.byteLength(text) < DIAGNOSTICS_MAX_BYTES, 'the block is under 64KB')
    const flood = { ...input, logLines: Array.from({ length: 200 }, (_, i) => 'WARN ' + 'x'.repeat(990) + i), renderer: { ...input.renderer, renderErrors: Array.from({ length: 10 }, (_, i) => ({ scope: 'app', message: 'm' + i, stack: 's'.repeat(8192), componentStack: 'c'.repeat(8192), at: i })) }, crashes: Array.from({ length: 20 }, (_, i) => ({ id: 'c' + i, kind: 'render-error', at: i, version: '2.0.0', message: 'z'.repeat(1024), stack: 'q'.repeat(8192) })) }
    const big = buildDiagnostics(flood)
    check(Buffer.byteLength(big) <= DIAGNOSTICS_MAX_BYTES, 'a flood of logs, errors and crashes still fits in 64KB')
    check((big.match(/^- \d{4}-.* render-error/gm) || []).length === 5, 'only the last 5 crashes are listed')
    const noRenderer = buildDiagnostics({ ...input, renderer: null, mainRenderErrors: [{ scope: 'titlebar', message: 'from main', at: 3 }] })
    check(noRenderer.includes('[titlebar] from main') && noRenderer.includes('workspaces 1, panes 2'), 'without a renderer, main errors and config counts are used')
    const nulls = buildDiagnostics({ ...input, config: null, renderer: null, metrics: null, health: null, remote: null, crashes: [], logLines: [] })
    check(nulls.includes('### Metrics\n-') && nulls.includes('### Remote\n-'), 'missing sources become "-"')
  }

  // --- renderer: renderErrors -------------------------------------------------------
  {
    const sent = []
    const clip = []
    const r = loadRenderer(`
      export * from './renderErrors'
      export { useToastStore } from './toast'
      export { useAppStore } from './store'
    `, { window: { snApi: { config: { save() {} }, app: { reportRenderError: rep => sent.push(rep), diagnostics: async d => 'x'.repeat(3000) + JSON.stringify(d), takeRecovery: async () => ({ at: 1, reason: 'crashed', exitCode: 1, consoles: 4, autoReloadsInWindow: 1 }) }, clipboard: { writeText: t => clip.push(t) } } } })
    const rep = r.toReport('pane', new Error('kaboom'), { paneId: 'p1', componentStack: 'c'.repeat(9000), at: 5 })
    check(rep.message === 'kaboom' && rep.paneId === 'p1' && rep.componentStack.length === 8192 && rep.at === 5 && rep.stack.includes('kaboom'), 'toReport normalizes errors and trims stacks')
    check(r.toReport('window', 'plain').message === 'plain' && r.toReport('window', { a: 1 }).message === '{"a":1}', 'non-Error values are reported too')
    for (let i = 0; i < 100; i++) r.reportRenderError(r.toReport('pane', new Error('same'), { at: i }), i * 100)
    check(sent.length === 1 && r.recentRenderErrors().length === 1, 'the renderer throttles 100 equal errors to one send')
    for (let i = 0; i < 30; i++) r.reportRenderError(r.toReport('app', new Error('e' + i)), 70_000 + i)
    check(r.recentRenderErrors().length === r.RENDER_RING_MAX, 'the ring keeps the last 10 reports')
    check(r.countRecent([0, 10_000, 59_999, 61_000], 61_000) === 3, 'countRecent uses a 60 s window')
    check(r.notePaneFailure('px', 0) === 1 && r.notePaneFailure('px', 1000) === 2 && r.notePaneFailure('px', 2000) === 3, 'three failures in 60 s reach the restart threshold')
    check(r.notePaneFailure('px', 70_000) === 1 && r.notePaneFailure('py', 70_000) === 1, 'failures age out and are per pane')
    check(r.PANE_FAILURE_LIMIT === 3, 'the primary swaps after 3 failures')
    const detail = r.formatErrorDetail(new Error('m'), 'z'.repeat(10_000))
    check(detail.length === 4096 && detail.startsWith('m'), '[Copy detail] is capped at 4KB')
    check(await r.copyDiagnostics(), 'copyDiagnostics resolves true')
    check(clip.length === 1 && clip[0].length > 3000, 'the diagnostics text goes to the clipboard')
    const toasts = () => r.useToastStore.getState().items
    const kb = Math.ceil(Buffer.byteLength(clip[0]) / 1024)
    check(toasts().some(t => t.title.endsWith(`(${kb} KB)`)), 'the toast names the size in KB')
    check(await r.showRecoveryCard(), 'a pending recovery shows the card')
    const card = toasts().find(t => t.dedupeKey === r.RECOVERY_TOAST_KEY)
    check(card && card.durationMs === null && card.priority === 3 && card.body.includes('4') && card.actions.length === 1, 'the recovery card is persistent, top priority, names N and offers Copy diagnostics')
  }

  console.log(`PASS: ${checks} crash resilience checks (breaker, auto-reload guards, recovery flow, crash store, throttle, redact, log ring, diagnostics allowlist, render errors)`)
}

main().catch(error => { console.error(error); process.exitCode = 1 })
