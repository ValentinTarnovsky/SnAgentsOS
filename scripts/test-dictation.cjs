// Desktop dictation (app 2.4.0): the PowerShell helper script, main's
// DictationService with a fake spawn, the web permission table, the IPC
// settings URIs and the renderer store (menu guard, never an Enter), all in
// node with esbuild + vm. On Windows it also runs the real helper once per
// engine (no speech needed: it must start, stop and end cleanly); set
// SNAOS_TEST_NO_PS=1 to skip that part. CI runners have no recognizer or
// microphone, so it is skipped there too (CI=true).
const { buildSync } = require('esbuild')
const vm = require('node:vm')
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
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, URL, setTimeout, clearTimeout, ...overrides })
  return mod.exports
}
function loadRenderer(contents, overrides = {}) {
  const code = buildSync({ stdin: { contents, resolveDir: path.join(root, 'src/renderer/lib'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, crypto: globalThis.crypto, setTimeout, clearTimeout, URL, TextEncoder, ...overrides })
  return mod.exports
}
const flush = () => new Promise((r) => setImmediate(r))

// A fake helper process: stdout/stdin streams, exit and error events, kill().
function fakeChild() {
  const ev = new EventEmitter()
  const child = {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), killed: 0, written: '',
    kill() { this.killed++; setImmediate(() => ev.emit('exit', null)); return true },
    on(name, cb) { ev.on(name, cb); return this },
    line(obj) { this.stdout.write((typeof obj === 'string' ? obj : JSON.stringify(obj)) + '\r\n') },
    exit(code) { ev.emit('exit', code) },
    error() { ev.emit('error', new Error('ENOENT')) },
  }
  child.stdin.on('data', (d) => { child.written += d.toString() })
  return child
}

async function main() {
  // --- Helper script -------------------------------------------------------------
  {
    const H = load('src/main/dictation/helperScript.ts')
    const script = H.dictationScript()
    const args = H.buildDictationArgs()
    check(args.slice(0, 6).join(' ') === '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand', 'no profile, no prompts, -EncodedCommand')
    check(Buffer.from(args[6], 'base64').toString('utf16le') === script, 'the argument decodes to the script (UTF-16LE base64)')
    check(args[6].length < 30000, `the command line fits Windows' 32767 limit (${args[6].length})`)
    check(H.buildDictationArgs()[6] === args[6], 'the script is static: the same bytes on every start')
    check(!/ReadLineAsync/.test(script) && /\[Console\]::OpenStandardInput\(\)/.test(script) && /\.ReadAsync\(\$buf, 0, \$buf\.Length\)/.test(script), 'stdin through the raw stream ReadAsync, never Console.In.ReadLineAsync (blocks on .NET Framework)')
    check(!/-Timeout\s+\d*\.\d/.test(script) && /System\.Timers\.Timer/.test(script) && /-SourceIdentifier 'snaos\.tick'/.test(script) && /\$ev = Wait-Event\n/.test(script), 'no fractional -Timeout: a Timers.Timer event wakes Wait-Event')
    check(/\$env:SNAOS_DICT_LANG/.test(script) && /\$env:SNAOS_DICT_ENGINE/.test(script) && /-cnotmatch '\^\[a-z\]\{2,3\}/.test(script), 'language and engine come from env vars and are checked again in the script')
    check(!/\$\{/.test(script) && !/`/.test(script), 'no template or backtick escapes in the embedded script')
    check(/0x80045509\) return "privacy"/.test(script) && /0x80070005\) return "mic_denied"/.test(script), 'StartAsync HRESULTs map to privacy (spike) and mic_denied')
    check(/CSharpCodeProvider/.test(script) && /Windows\.Media\.winmd/.test(script) && !/Add-Type -TypeDefinition/.test(script), 'online engine: C# bridge compiled with CodeDom (Register-ObjectEvent cannot take WinRT events)')
    check(/DictationGrammar/.test(script) && /SetInputToDefaultAudioDevice/.test(script) && /\$r\.Confidence -ge 0\.3/.test(script), 'offline engine: SAPI dictation on the default mic, low confidence dropped')
    check(!/[\u2013\u2014]/.test(script), 'no em or en dash')
    check(script.split('\n').every((l) => l === l.trim() && l && !l.startsWith('#')), 'sent minified: no indentation, blank lines or comments')
  }

  // --- Line parsing, request and env --------------------------------------------
  const S = load('src/main/dictation/DictationService.ts')
  {
    const p = S.parseHelperLine
    check(JSON.stringify(p('{"t":"ready","engine":"offline","lang":"es-ES","fallback":"privacy"}')) === '{"t":"ready","engine":"offline","lang":"es-ES","fallback":"privacy"}', 'ready with engine, lang and fallback')
    check(JSON.stringify(p('{"t":"ready","engine":"online","lang":"x; rm","fallback":"nope"}')) === '{"t":"ready","engine":"online"}', 'a bad lang or fallback is dropped, the line kept')
    check(p('{"t":"ready","engine":"cloud"}') === null, 'an unknown engine drops the line')
    check(p('{"t":"final","text":"hola\\r\\nmundo\\u001b[31m\\u0007  ya"}').text === 'hola mundo [31m ya', 'final text: CR, LF, ESC and BEL never survive')
    check(p('{"t":"hyp","text":"a\\u2028b\\u0085c"}').text === 'a b c', 'line and paragraph separators and C1 go too')
    check(p(JSON.stringify({ t: 'final', text: 'x'.repeat(5000) })).text.length === 2000, 'text capped at 2000')
    check(p('{"t":"error","code":"privacy"}').code === 'privacy' && p('{"t":"error","code":"whatever"}').code === 'internal', 'error codes: known kept, unknown is internal')
    check(p('{"t":"end"}').t === 'end', 'end')
    for (const junk of ['', 'hola', '{', '[1]', 'null', '{"t":"say","text":"x"}', '{"t":"final"}', '{"t":"final","text":3}', JSON.stringify({ t: 'hyp', text: 'y'.repeat(20000) })]) {
      check(p(junk) === null, 'junk dropped: ' + junk.slice(0, 30))
    }
    check(JSON.stringify(S.normalizeStart({ engine: 'offline', lang: 'es-AR' })) === '{"engine":"offline","lang":"es-AR"}', 'a valid request is kept')
    check(JSON.stringify(S.normalizeStart({ engine: 'cloud', lang: 'es-AR"; calc; "' })) === '{"engine":"auto","lang":""}', 'bad engine -> auto, bad tag -> empty (system language)')
    check(JSON.stringify(S.normalizeStart(null)) === '{"engine":"auto","lang":""}' && S.normalizeStart({ lang: 'auto' }).lang === '' && S.normalizeStart({ lang: 'e' + '-abcdefgh'.repeat(4) }).lang === '', "null, 'auto' and an over-long tag")
    const env = S.helperEnv({ SystemRoot: 'C:\\Windows', TEMP: 'C:\\t', PATH: 'C:\\bin', ANTHROPIC_API_KEY: 'sk', CLAUDE_CONFIG_DIR: 'x', SNAOS_DICT_LANG: 'evil' }, 'online', 'en-US')
    check(env.SystemRoot === 'C:\\Windows' && env.TEMP === 'C:\\t' && env.PATH === 'C:\\bin' && !('ANTHROPIC_API_KEY' in env) && !('CLAUDE_CONFIG_DIR' in env), 'the helper env keeps only what powershell and CodeDom need')
    check(env.SNAOS_DICT_LANG === 'en-US' && env.SNAOS_DICT_ENGINE === 'online', 'engine and language set by main, never inherited')
    check(S.dictationSettingsUri('speech') === 'ms-settings:privacy-speech' && S.dictationSettingsUri('microphone') === 'ms-settings:privacy-microphone', 'openSettings maps to the two fixed URIs')
    check(['ms-settings:privacy-speech', 'https://x', '', null, 'network', {}].every((v) => S.dictationSettingsUri(v) === null), 'and nothing else, a URL included')
  }

  // --- DictationService with a fake spawn ----------------------------------------
  {
    const timers = []
    const fakeSetTimeout = (fn, ms) => { const t = { fn, ms, done: false }; timers.push(t); return t }
    const fakeClearTimeout = (t) => { if (t) t.done = true }
    const runTimers = () => { for (const t of timers.splice(0)) if (!t.done) { t.done = true; t.fn() } }
    const Svc = load('src/main/dictation/DictationService.ts', { setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout })
    const make = (platform = 'win32') => {
      const spawned = [], logs = [], events = []
      let n = 0
      const svc = new Svc.DictationService({
        platform,
        exe: () => 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        spawn: (exe, args, opts) => { const c = fakeChild(); spawned.push({ exe, args, opts, c }); return c },
        env: () => ({ SystemRoot: 'C:\\Windows', SECRET_TOKEN: 'nope' }),
        log: (l) => logs.push(l),
        newId: () => 'd' + ++n,
      })
      return { svc, spawned, logs, events, send: (e) => events.push(e) }
    }

    {
      const h = make('linux')
      check(JSON.stringify(h.svc.start(1, h.send, {})) === '{"ok":false,"error":"unsupported"}' && h.spawned.length === 0, 'off Windows: unsupported, nothing spawned')
    }
    {
      const h = make()
      const res = h.svc.start(7, h.send, { engine: 'auto', lang: 'es-AR' })
      check(res.ok && res.sessionId === 'd1' && h.svc.activeId === 'd1', 'start answers the session id')
      const sp = h.spawned[0]
      check(/WindowsPowerShell\\v1\.0\\powershell\.exe$/.test(sp.exe) && sp.args.includes('-EncodedCommand') && sp.opts.windowsHide === true && sp.opts.stdio === 'pipe', 'powershell.exe by absolute path, hidden, piped')
      check(sp.opts.env.SNAOS_DICT_LANG === 'es-AR' && sp.opts.env.SNAOS_DICT_ENGINE === 'auto' && !('SECRET_TOKEN' in sp.opts.env), 'validated values in the env, nothing else inherited')
      check(!sp.args.some((a) => a.includes('es-AR')), 'the language never appears on the command line')
      sp.c.line({ t: 'ready', engine: 'offline', lang: 'es-ES', fallback: 'privacy' })
      sp.c.line('not json')
      sp.c.line({ t: 'hyp', text: 'dos' })
      sp.c.line({ t: 'final', text: 'dos archivos\r' })
      sp.c.stderr.write('secret stderr')
      await flush()
      check(JSON.stringify(h.events) === JSON.stringify([
        { sessionId: 'd1', t: 'ready', engine: 'offline', lang: 'es-ES', fallback: 'privacy' },
        { sessionId: 'd1', t: 'hyp', text: 'dos' },
        { sessionId: 'd1', t: 'final', text: 'dos archivos' },
      ]), 'valid lines forwarded with the session id, junk dropped: ' + JSON.stringify(h.events))
      h.svc.stop('d1', 8)
      check(sp.c.written === '', 'another webContents cannot stop the session')
      h.svc.stop('d1', 7)
      check(sp.c.written === 'stop\n', 'stop writes "stop" to the helper')
      h.svc.stop('d1', 7)
      check(sp.c.written === 'stop\n', 'a second stop writes nothing more')
      check(timers.length === 1 && timers[0].ms === 3000, 'a 3 s kill fallback is armed')
      sp.c.line({ t: 'final', text: 'ultimo' })
      sp.c.line({ t: 'end' })
      await flush()
      check(h.events.slice(-2).map((e) => e.t).join() === 'final,end' && h.svc.activeId === null, 'the last phrase arrives, then end')
      check(timers[0].done && sp.c.killed === 0, 'a clean end disarms the kill')
      sp.c.exit(0)
      await flush()
      check(h.events.filter((e) => e.t === 'end').length === 1, 'end is sent once')
      check(h.logs.every((l) => !/dos|archivos|ultimo|secret/.test(l)) && h.logs.includes('ready engine=offline fallback=privacy') && h.logs.includes('stop'), 'the log keeps codes, never text: ' + JSON.stringify(h.logs))
      timers.length = 0
    }
    {
      const h = make()
      h.svc.start(1, h.send, {})
      const c = h.spawned[0].c
      h.svc.stop('d1', 1)
      runTimers()
      await flush()
      check(c.killed === 1 && h.events.map((e) => e.t).join() === 'end', 'a helper that ignores stop is killed after 3 s and the renderer gets end')
      check(h.svc.activeId === null, 'and the slot is free')
    }
    {
      const h = make()
      const first = []
      h.svc.start(1, (e) => first.push(e), {})
      h.svc.start(1, h.send, {})
      await flush()
      check(h.spawned[0].c.killed === 1 && first.map((e) => e.t).join() === 'end', 'one session at a time: a new start kills the old one and ends it')
      check(h.svc.activeId === 'd2' && h.events.length === 0, 'the new one runs')
      h.spawned[0].c.line({ t: 'final', text: 'late' })
      await flush()
      check(first.length === 1, 'nothing from the old helper after its end')
      h.svc.stopOwner(99)
      check(h.spawned[1].c.killed === 0, 'another renderer going away leaves it alone')
      h.svc.stopOwner(1)
      await flush()
      check(h.spawned[1].c.killed === 1 && h.events.map((e) => e.t).join() === 'end' && h.svc.activeId === null, 'its renderer reloading kills the helper (stopOwner)')
    }
    {
      const h = make()
      h.svc.start(1, h.send, {})
      h.spawned[0].c.line({ t: 'ready', engine: 'online' })
      await flush()
      h.spawned[0].c.exit(1)
      await flush()
      check(h.events.map((e) => e.t + (e.code ? ':' + e.code : '')).join() === 'ready,error:exit,end', 'a helper gone without end: error exit, then end')
    }
    {
      const h = make()
      h.svc.start(1, h.send, {})
      h.spawned[0].c.error()
      await flush()
      check(h.events.map((e) => e.t + (e.code ? ':' + e.code : '')).join() === 'error:spawn,end', 'a spawn failure (ENOENT): error spawn, then end')
    }
    {
      const svc = new Svc.DictationService({ platform: 'win32', exe: () => 'x', spawn: () => { throw new Error('EACCES') }, env: () => ({}) })
      check(JSON.stringify(svc.start(1, () => {}, {})) === '{"ok":false,"error":"spawn"}', 'spawn throwing answers spawn')
    }
    {
      const h = make()
      h.svc.start(1, h.send, {})
      h.svc.dispose()
      await flush()
      check(h.spawned[0].c.killed === 1 && h.events.map((e) => e.t).join() === 'end', 'dispose (quit) kills the helper')
    }
  }

  // --- Web permissions ------------------------------------------------------------
  {
    const P = load('src/main/permissions.ts')
    const file = 'file:///C:/Program%20Files/SnAgentsOS/resources/app.asar/out/renderer/index.html'
    check(P.isAppOrigin(file, file, true) && P.isAppOrigin('file:///c:/program files/snagentsos/resources/app.asar/out/renderer/index.html#/x', file, true), 'the renderer file is the app (hash ignored, case-insensitive on Windows)')
    check(!P.isAppOrigin('file:///C:/Users/me/Downloads/evil.html', file, true) && !P.isAppOrigin('file:///', file, true) && !P.isAppOrigin('https://example.com/', file, true), 'another file, an opaque file origin or a web page are not')
    check(!P.isAppOrigin(file.toLowerCase(), file, false), 'case matters off Windows')
    const dev = 'http://localhost:5173/'
    check(P.isAppOrigin('http://localhost:5173/index.html', dev) && !P.isAppOrigin('http://localhost:5174/', dev) && !P.isAppOrigin('http://127.0.0.1:5173/', dev) && !P.isAppOrigin(file, dev), 'dev: only the ELECTRON_RENDERER_URL origin')
    check(!P.isAppOrigin('', file) && !P.isAppOrigin(undefined, file) && !P.isAppOrigin('not a url', file) && !P.isAppOrigin(file, 'not a url'), 'empty or broken URLs fail closed')
    const table = [
      ['notifications', file, true], ['clipboard-sanitized-write', file, true], ['fullscreen', file, true],
      ['media', file, false], ['geolocation', file, false], ['clipboard-read', file, false], ['openExternal', file, false], ['hid', file, false],
      ['notifications', 'https://evil.example/', false], ['fullscreen', 'file:///C:/x/evil.html', false],
    ]
    for (const [perm, url, want] of table) check(P.allowPermission(perm, url, file, true) === want, `${perm} from ${url.slice(0, 24)}: ${want ? 'allowed' : 'denied'}`)
    let req = null, chk = null
    P.installPermissionHandlers({ setPermissionRequestHandler: (fn) => { req = fn }, setPermissionCheckHandler: (fn) => { chk = fn } }, file)
    let answer = null
    req(null, 'media', (v) => { answer = v }, { requestingUrl: file })
    check(answer === false, 'request handler: media denied for the app itself')
    req(null, 'notifications', (v) => { answer = v }, { requestingUrl: file })
    check(answer === true, 'request handler: notifications allowed for the app')
    check(chk({ getURL: () => file }, 'notifications', 'file:///', {}) === true, 'check handler: the opaque file origin falls back to the page URL')
    check(chk(null, 'notifications', 'file:///', {}) === false && chk({ getURL: () => file }, 'media', 'file:///', { requestingUrl: file }) === false, 'check handler: no page, or media, is denied')
  }

  // --- Renderer store: never an Enter, the menu guard --------------------------------
  {
    const listeners = new Set()
    const calls = { start: [], stop: [] }
    let nextId = 0
    const snApi = {
      platform: 'win32',
      dictation: {
        start: async (req) => { calls.start.push(req); return { ok: true, sessionId: 's' + ++nextId } },
        stop: async (id) => { calls.stop.push(id) },
        onEvent: (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
        openSettings: async () => true,
      },
    }
    const R = loadRenderer(`
      export * as D from './dictation'
      export { useAppStore } from './store'
      export { registerPaster } from './pasteRegistry'
      export { registerPty, unregisterPty } from './ptyRegistry'
      export { registerTermReader } from './termReaders'
      export { setFocusedPane } from './focus'
    `, { window: { snApi }, navigator: { language: 'es-AR' }, requestAnimationFrame: (fn) => fn(), document: { hasFocus: () => true } })
    const emit = (e) => listeners.forEach((cb) => cb(e))
    const pasted = []
    R.registerPaster('p1', { paste: (text, o) => pasted.push({ text, auto: o?.auto === true }), bracketed: () => true })
    R.registerPty('p1', 'pty-1')
    let screen = ['PS C:\\> ']
    R.registerTermReader('p1', () => screen)
    R.useAppStore.setState({ hydrated: true, activeWorkspaceId: 'w', workspaces: [{ id: 'w', name: 'W', cwd: '', panes: [{ id: 'p1', type: 'claude', title: 'C', icon: 'bot' }] }] })
    const D = R.D
    const state = () => D.useDictationStore.getState()

    R.useAppStore.setState((s) => ({ settings: { ...s.settings, language: 'es', dictation: { engine: 'offline', language: 'auto', headerButton: true } } }))
    D.toggleDictationPane('p1')
    check(state().phase === 'starting', 'the mic starts a session')
    await flush()
    check(JSON.stringify(calls.start[0]) === '{"engine":"offline","lang":"es-AR"}', "engine from settings; 'auto' language resolves to the system one when it matches the app")
    check(state().sessionId === 's1' && D.isDictating('pane:p1'), 'listening on p1')
    emit({ sessionId: 'other', t: 'final', text: 'intruso' })
    emit({ sessionId: 's1', t: 'ready', engine: 'offline', fallback: 'privacy' })
    emit({ sessionId: 's1', t: 'hyp', text: 'hola' })
    check(state().phase === 'listening' && state().engine === 'offline' && state().fallback === 'privacy' && state().interim === 'hola', 'ready, fallback and the phrase so far')
    emit({ sessionId: 's1', t: 'final', text: 'Hola mundo' })
    emit({ sessionId: 's1', t: 'final', text: 'Esto es una prueba' })
    emit({ sessionId: 's1', t: 'final', text: '.' })
    check(JSON.stringify(pasted.map((p) => p.text)) === JSON.stringify(['Hola mundo', ' esto es una prueba', '.']), 'finals typed with one space between, mid-sentence lowercase, none before punctuation: ' + JSON.stringify(pasted))
    check(pasted.every((p) => !/[\r\n]/.test(p.text) && !p.auto), 'never a CR or LF, and typed as the user (not auto)')
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
    D.toggleDictationPane('p1')
    check(state().phase === 'stopping' && calls.stop.join() === 's1', 'the mic again stops (stop to main)')
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
    check(calls.stop.join() === 's1,s2' && state().phase === 'stopping', 'a new pty for the console stops the session, even before ready (its text was for the old one)')
    pasted.length = 0
    emit({ sessionId: 's2', t: 'final', text: 'frase final' })
    check(pasted.length === 0 && state().held === 'frase final', 'the last phrase drained after a pty change is held, never typed into the new pty: ' + JSON.stringify(state().held))
    emit({ sessionId: 's2', t: 'end' })
    D.insertHeld()
    check(JSON.stringify(pasted.map((p) => p.text)) === JSON.stringify(['frase final']) && state().held === '', 'Insert (the user asking) still types it')
    D.dismissDictation()

    // Error from start, error then end from the helper.
    snApi.dictation.start = async () => ({ ok: false, error: 'unsupported' })
    D.toggleDictationPane('p1')
    await flush()
    check(state().phase === 'idle' && state().error === 'unsupported' && state().scope === 'pane:p1', 'a refused start shows its error on that console')
    D.dismissDictation()
    check(state().error === null && state().scope === null, 'dismiss clears it')
    snApi.dictation.start = async () => ({ ok: true, sessionId: 's9' })
    D.toggleDictationPane('p1')
    await flush()
    emit({ sessionId: 's9', t: 'error', code: 'mic_denied' })
    emit({ sessionId: 's9', t: 'end' })
    check(state().phase === 'idle' && state().error === 'mic_denied', 'a helper error stays after the end')
    D.releaseDictationScope('pane:p1')
    check(state().scope === null && state().error === null, 'the terminal unmounting drops it')

    // Field target (global prompt): at the caret, no Enter, the shortcut toggles it.
    let field = 'Revisa '
    D.setDictationFieldToggler(() => void D.startDictation({ kind: 'field', owner: 'gp', insert: (t) => { field += t }, before: () => field }))
    snApi.dictation.start = async () => ({ ok: true, sessionId: 'f1' })
    D.runDictateShortcut()
    await flush()
    check(D.isDictating('field:gp'), 'with a field open, the shortcut toggles its mic')
    emit({ sessionId: 'f1', t: 'final', text: 'El archivo' })
    emit({ sessionId: 'f1', t: 'final', text: 'de config' })
    check(field === 'Revisa el archivo de config', 'field text joins with what is before the caret: ' + JSON.stringify(field))
    D.setDictationFieldToggler(null)
    D.releaseDictationScope('field:gp')
    check(state().phase !== 'listening' && calls.stop.includes('f1'), 'closing the dialog stops its session')
  }

  // --- Real helper on this machine (Windows only) ---------------------------------
  if (process.platform === 'win32' && process.env.SNAOS_TEST_NO_PS !== '1' && !process.env.CI) {
    const H = load('src/main/dictation/helperScript.ts')
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const run = (engine, lang) => new Promise((resolve) => {
      const lines = []
      let err = ''
      const c = spawn(exe, H.buildDictationArgs(), { env: S.helperEnv(process.env, engine, lang), windowsHide: true, stdio: 'pipe' })
      let buf = ''
      c.stdout.setEncoding('utf8')
      c.stderr.setEncoding('utf8')
      c.stderr.on('data', (d) => { err += d })
      c.stdout.on('data', (d) => {
        buf += d
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          lines.push(buf.slice(0, i).trim())
          buf = buf.slice(i + 1)
        }
      })
      const t0 = Date.now()
      const stopper = setTimeout(() => c.stdin.write('stop\n'), 2500)
      const killer = setTimeout(() => c.kill(), 30000)
      c.on('exit', (code) => { clearTimeout(stopper); clearTimeout(killer); resolve({ code, lines: lines.filter(Boolean), err: err.slice(0, 2000), ms: Date.now() - t0 }) })
    })
    for (const [engine, lang] of [['offline', 'zz-QQ'], ['auto', 'es-AR']]) {
      const r = await run(engine, lang)
      const parsed = r.lines.map(S.parseHelperLine)
      check(r.code === 0 && parsed.length >= 1 && parsed.every(Boolean), `real helper (${engine}): exit 0, every line valid: ${JSON.stringify(r.lines)} stderr: ${r.err}`)
      check(parsed.at(-1).t === 'end' && parsed.filter((p) => p.t === 'end').length === 1, `real helper (${engine}): end once, last`)
      const first = parsed[0]
      check(first.t === 'ready' || first.t === 'error', `real helper (${engine}): starts with ready or an error code (${first.t}${first.code ? ' ' + first.code : ''}${first.fallback ? ' fallback ' + first.fallback : ''})`)
      if (first.t === 'ready' && engine === 'offline') check(first.engine === 'offline' && !first.fallback, 'offline engine reports offline, no fallback')
    }
  }

  console.log(`test-dictation: ${checks} checks passed`)
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
