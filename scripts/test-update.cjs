// Update card suite (E4-FR-12..18): esbuild + vm, no Electron, runs on the ubuntu CI.
// Release selection over the GitHub list, the fallback and the dev repo
// override against a fake net, the card/chip visibility table, the renderer
// store (dismiss, collapse, in-place refresh) and the check scheduler with
// fake timers. Nothing touches the network or the user's config.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, URL, setTimeout, clearTimeout, setImmediate, ...overrides })
  return mod.exports
}
function loadRenderer(contents, overrides = {}) {
  const code = buildSync({ stdin: { contents, resolveDir: path.join(root, 'src/renderer/lib'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, crypto: globalThis.crypto, setTimeout, clearTimeout, setInterval, clearInterval, ...overrides })
  return mod.exports
}
const flush = () => new Promise(res => setImmediate(res))

const REPO = 'ValentinTarnovsky/SnAgentsOS'
const api = repo => `https://api.github.com/repos/${repo}`
const asset = (v, name) => ({ name, browser_download_url: `https://github.com/${REPO}/releases/download/v${v}/${name}`, size: 10 })
/** A release with the Windows setup and (optionally) its sidecar. */
function rel(v, { sidecar = true, setup = true, draft = false, prerelease = false, body = `Notes ${v}` } = {}) {
  const names = []
  if (setup) names.push(`SnAgentsOS-${v}-setup.exe`)
  if (setup && sidecar) names.push(`SnAgentsOS-${v}-setup.exe.sha256`)
  names.push(`SnAgentsOS-${v}.dmg`, `SnAgentsOS-${v}.dmg.sha256`)
  return { tag_name: `v${v}`, body, html_url: `https://github.com/${REPO}/releases/tag/v${v}`, published_at: '2026-10-01T00:00:00Z', draft, prerelease, assets: names.map(n => asset(v, n)) }
}

/** updater.ts over a fake electron.net: routes(url) -> { status, body } | undefined (404); `modules` replaces node modules. */
function loadUpdater({ routes, env = {}, isPackaged = false, version = '2.0.0', modules = {}, userData = null }) {
  const log = { requests: [], aborted: 0, errors: [] }
  const net = {
    request(opts) {
      const req = new EventEmitter()
      req.setHeader = () => {}
      req.abort = () => { log.aborted++ }
      req.end = () => {
        log.requests.push(opts.url)
        const r = routes(opts.url) ?? { status: 404, body: '' }
        setImmediate(() => {
          const res = new EventEmitter(); res.statusCode = r.status
          req.emit('response', res)
          const body = Buffer.isBuffer(r.body) ? r.body : Buffer.from(typeof r.body === 'string' ? r.body : JSON.stringify(r.body))
          res.emit('data', body); res.emit('end')
        })
      }
      return req
    },
  }
  const electron = { app: { getVersion: () => version, isPackaged, ...(userData ? { getPath: () => userData } : {}) }, net, shell: {} }
  const mod = load('src/main/updater.ts', {
    require: id => id === 'electron' ? electron : modules[id] ?? require(id),
    process: { ...process, platform: 'win32', arch: 'x64', env, argv: [process.execPath] },
    console: { ...console, error: (...a) => log.errors.push(a.join(' ')) },
  })
  return { mod, log }
}

async function main() {
  // --- selectReleases (pure, E4-FR-14) -------------------------------------
  {
    const { mod } = loadUpdater({ routes: () => undefined })
    const { selectReleases, NOTES_BUDGET, RELEASE_PAGE } = mod
    check(RELEASE_PAGE === 30 && NOTES_BUDGET === 64 * 1024, 'page of 30 releases and a 64 KB notes budget')
    const list = [rel('2.1.0'), rel('2.3.0'), rel('2.4.0', { draft: true }), rel('2.5.0-beta', { prerelease: true }), rel('2.2.0'), rel('2.0.0'), rel('1.9.0')]
    const sel = selectReleases(list, '2.0.0')
    check(sel.offered.tag_name === 'v2.3.0' && sel.match.kind === 'win-installer' && /2\.3\.0-setup\.exe$/.test(sel.match.asset.name), 'drafts and prereleases skipped, the highest ready release offered')
    check(sel.newerCount === 3 && sel.missed.map(r => r.version).join() === '2.3.0,2.2.0,2.1.0', 'three behind: +3 with notes newest first (API order not trusted)')
    check(sel.missed[0].notes === 'Notes 2.3.0' && sel.missed[0].url.endsWith('/v2.3.0') && sel.missed[0].publishedAt === '2026-10-01T00:00:00Z', 'each summary keeps notes, url and date')
    check(sel.newestNotReady === undefined, 'a complete newest release is not flagged')

    const half = selectReleases([rel('2.2.0', { sidecar: false }), rel('2.1.0')], '2.0.0')
    check(half.offered.tag_name === 'v2.1.0' && half.newerCount === 1 && half.newestNotReady === '2.2.0', 'newest without .sha256 is not ready: the previous one is offered and the half-built one flagged')
    check(half.missed.map(r => r.version).join() === '2.1.0', 'the not-ready release is not counted nor listed')
    const noAsset = selectReleases([rel('2.2.0', { setup: false }), rel('2.1.0')], '2.0.0')
    check(noAsset.offered.tag_name === 'v2.1.0' && noAsset.newestNotReady === '2.2.0', 'newest without this install kind asset is not ready either')
    const none = selectReleases([rel('2.1.0', { sidecar: false })], '2.0.0')
    check(none.offered.tag_name === 'v2.1.0' && none.match === null && none.newerCount === 0 && none.newestNotReady === '2.1.0' && none.missed.length === 1, 'nothing ready: the newest is offered for its page only, flagged for the re-check')
    const old = selectReleases([rel('2.0.0'), rel('1.0.0'), { tag_name: 'nightly' }, null], '2.0.0')
    check(old.offered === null && old.newerCount === 0 && old.missed.length === 0, 'nothing newer, odd tags and null entries: no offer')
    check(selectReleases({ message: 'Not Found' }, '2.0.0').offered === null, 'a non-array body is no offer')

    const forty = Array.from({ length: 40 }, (_, i) => rel(`3.${i}.0`))
    const many = selectReleases(forty, '2.0.0')
    check(many.newerCount === 30 && many.missed.length === 30, 'at most 30 releases read: 30 means "30 or more"')
    const big = 'x'.repeat(40 * 1024)
    const heavy = selectReleases([rel('2.3.0', { body: big }), rel('2.2.0', { body: big }), rel('2.1.0', { body: big })], '2.0.0')
    const total = heavy.missed.reduce((n, r) => n + Buffer.byteLength(r.notes), 0)
    check(total === NOTES_BUDGET && heavy.missed[0].notes.length === big.length && heavy.missed[1].notes.length === NOTES_BUDGET - big.length && heavy.missed[2].notes === '', 'notes share one 64 KB budget, newest first, cut where it runs out')
    const emoji = selectReleases([rel('2.1.0', { body: '\u{1F600}'.repeat(20000) })], '2.0.0')
    check(Buffer.byteLength(emoji.missed[0].notes) <= NOTES_BUDGET && !/[\uD800-\uDBFF]$/.test(emoji.missed[0].notes), 'the cut never splits a character')
    const junk = rel('2.1.0'); junk.assets = [null, 7, { name: 5 }, ...junk.assets]; junk.html_url = 42
    const messy = selectReleases([junk], '2.0.0')
    check(messy.match && messy.match.kind === 'win-installer' && messy.missed[0].url === null, 'malformed assets and a non-string url do not sink the list')
    const pick = () => ({ asset: asset('9', 'x.exe'), kind: 'win-portable', sha256Url: 'https://github.com/x.sha256' })
    check(selectReleases([rel('2.1.0')], '2.0.0', pick).match.kind === 'win-portable', 'the install kind comes from the injected picker')
  }

  // --- checkForUpdate over the list, its fallback and the dev override ------
  {
    const list = [rel('2.3.0'), rel('2.2.0'), rel('2.1.0')]
    const listUrl = `${api(REPO)}/releases?per_page=30`
    const latestUrl = `${api(REPO)}/releases/latest`
    const ok = loadUpdater({ routes: url => url === listUrl ? { status: 200, body: list } : undefined })
    const info = await ok.mod.checkForUpdate()
    check(ok.log.requests.join() === listUrl, 'one call: the release list only')
    check(info.available && info.installable && info.latestVersion === '2.3.0' && info.newerCount === 3 && info.missed.length === 3 && info.notes === 'Notes 2.3.0', 'the check reports +3 with the notes of each version')

    const fallback = loadUpdater({ routes: url => url === listUrl ? { status: 500, body: '' } : url === latestUrl ? { status: 200, body: rel('2.3.0') } : undefined })
    const fb = await fallback.mod.checkForUpdate()
    check(fallback.log.requests.join() === `${listUrl},${latestUrl}`, 'a failed list falls back to /releases/latest')
    check(fb.available && fb.installable && fb.latestVersion === '2.3.0' && fb.newerCount === 0 && fb.missed.length === 0 && fallback.log.errors.length === 0, 'the fallback offers the card without +N')

    const huge = loadUpdater({ routes: url => url === listUrl ? { status: 200, body: Buffer.alloc(5 * 1024 * 1024 + 1, 32) } : url === latestUrl ? { status: 200, body: rel('2.1.0') } : undefined })
    const hi = await huge.mod.checkForUpdate()
    check(huge.log.aborted === 1 && hi.latestVersion === '2.1.0', 'a release list over 5 MB is aborted and the fallback answers')

    const down = loadUpdater({ routes: () => ({ status: 503, body: '' }) })
    const d = await down.mod.checkForUpdate()
    check(!d.available && d.error && d.newerCount === 0 && Array.isArray(d.missed) && down.log.errors.length === 1, 'both down: one logged error and an error result')

    const testRepo = 'someone/snaos-test'
    const devList = `${api(testRepo)}/releases?per_page=30`
    const dev = loadUpdater({ env: { SNAOS_UPDATE_REPO: testRepo }, routes: url => url === devList ? { status: 200, body: [rel('2.9.0')] } : undefined })
    check((await dev.mod.checkForUpdate()).latestVersion === '2.9.0' && dev.log.requests[0] === devList, 'SNAOS_UPDATE_REPO points a dev build at another repo')
    const packaged = loadUpdater({ isPackaged: true, env: { SNAOS_UPDATE_REPO: testRepo }, routes: url => url === listUrl ? { status: 200, body: list } : undefined })
    await packaged.mod.checkForUpdate()
    check(packaged.log.requests[0] === listUrl, 'a packaged build ignores SNAOS_UPDATE_REPO')
    const bad = loadUpdater({ env: { SNAOS_UPDATE_REPO: 'evil.com/x/../y?z' }, routes: url => url === listUrl ? { status: 200, body: list } : undefined })
    await bad.mod.checkForUpdate()
    check(bad.log.requests[0] === listUrl, 'a malformed override is ignored')
    const dots = loadUpdater({ env: { SNAOS_UPDATE_REPO: '../..' }, routes: url => url === listUrl ? { status: 200, body: list } : undefined })
    await dots.mod.checkForUpdate()
    check(dots.log.requests[0] === listUrl, 'a dot-only override segment is ignored')
  }

  // --- the setup waits for beforeApply (app 2.7.0, E10 B6: a Teams land finishes first) ---
  {
    const fs = require('node:fs')
    const os = require('node:os')
    const { PassThrough } = require('node:stream')
    const bytes = Buffer.from('not a real setup, never run')
    const sha = require('node:crypto').createHash('sha256').update(bytes).digest('hex')
    const release = rel('2.3.0')
    for (const a of release.assets) if (a.name.endsWith('-setup.exe')) a.size = bytes.length
    const listUrl = `${api(REPO)}/releases?per_page=30`
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-test-update-'))
    const spawned = []
    // The download (node https) and the setup start (child_process.spawn) are fakes: nothing runs, nothing leaves.
    const https = { get: (url, opts, cb) => {
      const req = new EventEmitter()
      req.setTimeout = () => req
      req.destroy = () => {}
      setImmediate(() => { const res = new PassThrough(); res.statusCode = 200; res.headers = {}; cb(res); res.end(bytes) })
      return req
    } }
    const child_process = { ...require('node:child_process'), spawn: (cmd, args) => { spawned.push({ cmd, args }); const c = new EventEmitter(); c.pid = 4242; c.unref = () => {}; return c } }
    const up = loadUpdater({
      routes: url => url === listUrl ? { status: 200, body: [release] } : url.endsWith('-setup.exe.sha256') ? { status: 200, body: `${sha}  setup.exe` } : undefined,
      modules: { https, child_process }, userData,
    })
    let open
    const gate = new Promise(r => { open = r })
    const kinds = []
    let settled = false
    try {
      const run = up.mod.downloadAndInstall(() => {}, { beforeApply: (kind) => { kinds.push(kind); return gate } }).then((r) => { settled = true; return r })
      // Wait by time, not by event loop turns: the download writes and hashes a file, which a slow CI runner can take
      // longer than a fixed number of turns to finish (the check then ran before beforeApply was even called).
      const until = Date.now() + 15000
      while (kinds.length === 0 && Date.now() < until) await new Promise(r => setTimeout(r, 10))
      // A pending beforeApply must hold the setup for good: give a would-be spawn time to happen.
      await new Promise(r => setTimeout(r, 100))
      for (let i = 0; i < 20; i++) await flush()
      check(kinds.join() === 'win-installer' && spawned.length === 0 && !settled, 'the setup never starts while the promise beforeApply returned is pending')
      open()
      const res = await run
      check(res.relaunching === true && spawned.length === 1 && spawned[0].cmd.endsWith('SnAgentsOS-2.3.0-setup.exe'), 'it starts once that promise settled')
    } finally {
      // Only the download folder updater.ts made in the temp dir.
      for (const s of spawned) {
        const dir = path.dirname(s.cmd)
        if (path.isAbsolute(dir) && path.dirname(dir) === path.resolve(os.tmpdir()) && path.basename(dir).startsWith('snagentsos-update-')) fs.rmSync(dir, { recursive: true, force: true })
      }
      fs.rmSync(userData, { recursive: true, force: true })
    }
  }

  // --- visibility table (E4-FR-13, 16, 18) ----------------------------------
  {
    const v = loadRenderer(`export * from '../components/updates/update-card-visibility'`)
    const base = { phase: 'available', latest: '2.2.0', dismissed: '', sessionDismissed: null, collapsed: false, userInitiated: false, installable: true }
    const rows = [
      [{ phase: 'idle' }, false, 'idle never shows'],
      [{}, true, 'a fresh offer shows'],
      [{ latest: null }, false, 'an offer without a version does not show'],
      [{ dismissed: '2.2.0' }, false, 'a dismissed version stays hidden'],
      [{ dismissed: '2.2.0', userInitiated: true }, true, 'the user asking for it overrides the dismissal'],
      [{ dismissed: '2.1.0' }, true, 'a strictly higher version shows again'],
      [{ dismissed: '2.3.0' }, false, 'an older version than the dismissed one stays hidden'],
      [{ sessionDismissed: '2.2.0', installable: false }, false, 'a session dismissal hides it'],
      [{ collapsed: true }, false, 'a collapsed offer is hidden'],
      [{ phase: 'downloading', dismissed: '2.2.0' }, true, 'a download shows even when dismissed'],
      [{ phase: 'downloading', collapsed: true }, false, 'a collapsed download is hidden (chip)'],
      [{ phase: 'installing', collapsed: true }, false, 'a collapsed install is hidden (chip)'],
      [{ phase: 'failed' }, true, 'a failure shows until closed'],
      [{ phase: 'failed', collapsed: true }, false, 'a closed failure is hidden (chip)'],
      [{ phase: 'opened' }, true, 'an opened installer shows'],
      [{ phase: 'opened', collapsed: true }, false, 'a closed opened card stays hidden'],
    ]
    for (const [patch, want, label] of rows) check(v.isUpdateCardVisible({ ...base, ...patch }) === want, `card: ${label}`)
    check(v.shouldPersistDismiss({ installable: true }) && !v.shouldPersistDismiss({ installable: false }), 'only an installable version persists its dismissal')
    const chip = [['downloading', false, true], ['installing', false, true], ['failed', false, true], ['downloading', true, false], ['available', false, false], ['opened', false, false], ['idle', false, false]]
    for (const [phase, cardVisible, want] of chip) check(v.isUpdateChipVisible({ phase, cardVisible }) === want, `chip: ${phase} with the card ${cardVisible ? 'visible' : 'hidden'} -> ${want}`)
    const re = { idle: true, available: true, downloading: false, installing: false, failed: false, opened: false }
    for (const [phase, want] of Object.entries(re)) check(v.shouldRecheck({ phase }) === want, `recheck in ${phase}: ${want}`)
    check(v.needsDoubleConfirm({ kind: 'win-portable', busyAgents: 2 }) && v.needsDoubleConfirm({ kind: 'win-installer', busyAgents: 1 }) && v.needsDoubleConfirm({ kind: 'linux-appimage', busyAgents: 1 }), 'closing kinds with a busy agent need the second click')
    check(!v.needsDoubleConfirm({ kind: 'win-portable', busyAgents: 0 }) && !v.needsDoubleConfirm({ kind: 'mac-dmg', busyAgents: 3 }) && !v.needsDoubleConfirm({ kind: 'linux-deb', busyAgents: 3 }) && !v.needsDoubleConfirm({ kind: 'open', busyAgents: 3 }), 'no agents, mac, deb and open take one click')
    check(v.newerLabel(1) === null && v.newerLabel(3).count === 3 && !v.newerLabel(3).more && v.newerLabel(30).more && v.newerLabel(30).count === 30, '+N from 2, "30 or more" at the cap')
    check(v.isVersionNewer('2.10.0', '2.9.9') && !v.isVersionNewer('v2.1.0', '2.1.0'), 'numeric version order')
  }

  // --- impact text and busy agents (E4-FR-15) -------------------------------
  {
    const r = loadRenderer(`export { impactText, countBusyAgents } from '../components/updates/useUpdateImpact'; export { en } from '../i18n/en'; export { es } from '../i18n/es'`, { window: { snApi: { config: { save() {} } } } })
    const tr = dict => (key, vars) => dict[key].replace(/\{(\w+)\}/g, (_m, k) => String(vars[k]))
    const es = tr(r.es), en = tr(r.en)
    check(es('update.impact.busy', { count: 7, busy: 2 }) === r.impactText(es, 7, 2) && r.impactText(es, 7, 2) === 'Se van a cerrar 7 consolas (2 con un agente trabajando o esperando)', 'es: 7 consoles, 2 working')
    check(r.impactText(en, 7, 0) === '7 consoles will close' && r.impactText(en, 1, 0) === '1 console will close' && r.impactText(en, 0, 0) === 'No consoles are open', 'en: plural, singular and none')
    check(r.impactText(es, 1, 1) === 'Se va a cerrar 1 consola (con un agente trabajando o esperando)', 'es singular with an agent')
    check(r.countBusyAgents({ a: { state: 'working' }, b: { state: 'action' }, c: { state: 'done' }, d: { state: 'idle' } }) === 2, 'working and action count as busy')
  }

  // --- renderer store: dismiss, collapse, reopen, in-place refresh ----------
  {
    let checkResult = null
    let checkCalls = 0
    const r = loadRenderer(`export * from './updater'`, { window: { snApi: { updates: { check: async () => { checkCalls++; return checkResult } } } } })
    const U = r.useUpdaterStore
    const offer = { available: true, currentVersion: '2.0.0', latestVersion: '2.2.0', notes: '', releaseUrl: null, installable: true, installKind: 'win-installer', newerCount: 2, missed: [] }
    U.setState({ info: offer, phase: 'available' })
    const persisted = []
    U.getState().dismissCard(v => persisted.push(v))
    check(persisted.join() === '2.2.0' && U.getState().sessionDismissed === null, 'X / Later on an installable version persists it')
    U.setState({ info: { ...offer, installable: false, installKind: 'open' } })
    U.getState().dismissCard(v => persisted.push(v))
    check(persisted.length === 1 && U.getState().sessionDismissed === '2.2.0', 'a non-installable version only hides for the session')
    U.getState().collapseCard()
    check(U.getState().cardCollapsed && !U.getState().userInitiated, 'collapse')
    U.getState().showCard()
    check(!U.getState().cardCollapsed && U.getState().userInitiated, 'the chip reopens the card')
    U.setState({ cardCollapsed: true })
    check(r.mirrorUpdateState({ phase: 'available', progress: null, installError: null, info: null }, 'failed').cardCollapsed === false, 'a new offer after a failure reopens the card')
    check(r.mirrorUpdateState({ phase: 'installing', progress: null, installError: null, info: null }, 'downloading').cardCollapsed === undefined, 'downloading -> installing keeps the collapse')
    U.setState({ info: offer, phase: 'available', installing: false })
    checkResult = { ...offer, latestVersion: '2.3.0', newerCount: 3 }
    await U.getState().check()
    check(U.getState().info.latestVersion === '2.3.0' && U.getState().info.newerCount === 3, 'a re-check refreshes the offer in place')
    checkResult = { ...offer, available: false, latestVersion: null, error: 'offline', newerCount: 0 }
    await U.getState().check()
    check(U.getState().info.latestVersion === '2.3.0' && U.getState().error === 'offline', 'a failed re-check keeps the good offer and reports the error')
    check(checkCalls === 2, 'two checks')
    U.getState().setNotesOpen(true)
    check(U.getState().notesOpen, 'the notes modal opens from the store')

    // notesExcerpt: plain text, 3 lines.
    const md = '## Novedades\n\n- **Tarjeta** de update con [notas](https://x)\n```js\ncode()\n```\n* `chip` en el titlebar\n1. Re-chequeo cada 6 h\n- cuarta linea'
    const ex = r.notesExcerpt(md)
    check(ex.length === 3 && ex[0] === 'Novedades' && ex[1] === 'Tarjeta de update con notas' && ex[2] === 'chip en el titlebar', `markdown becomes 3 plain lines: ${JSON.stringify(ex)}`)
    check(r.notesExcerpt('').length === 0 && r.notesExcerpt('<b>Hola</b> snake_case_name').join() === 'Hola snake_case_name', 'empty notes, html stripped, snake_case kept')
  }

  // --- the collapsed card survives a window reload (sessionStorage) ---------
  {
    const bag = new Map()
    const sessionStorage = { getItem: k => bag.has(k) ? bag.get(k) : null, setItem: (k, v) => bag.set(k, String(v)), removeItem: k => bag.delete(k) }
    const first = loadRenderer(`export * from './updater'`, { sessionStorage, window: { snApi: {} } })
    check(first.useUpdaterStore.getState().cardCollapsed === false, 'a fresh window starts with the card expanded')
    first.useUpdaterStore.getState().collapseCard()
    const reloaded = loadRenderer(`export * from './updater'`, { sessionStorage, window: { snApi: {} } })
    check(reloaded.useUpdaterStore.getState().cardCollapsed === true, 'reloading after collapsing keeps the chip')
    reloaded.useUpdaterStore.getState().showCard()
    const again = loadRenderer(`export * from './updater'`, { sessionStorage, window: { snApi: {} } })
    check(again.useUpdaterStore.getState().cardCollapsed === false, 'reopening the card clears the flag')
    const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') }, removeItem: () => { throw new Error('denied') } }
    const safe = loadRenderer(`export * from './updater'`, { sessionStorage: broken, window: { snApi: {} } })
    safe.useUpdaterStore.getState().collapseCard()
    check(safe.useUpdaterStore.getState().cardCollapsed === true, 'a throwing storage never breaks the store')
  }

  // --- scheduler with fake timers (E4-FR-12, 14, 18) -------------------------
  {
    let result = { available: true, latestVersion: '2.2.0', newerCount: 1, missed: [] }
    let calls = 0
    const r = loadRenderer(`export * from './updater'`, { window: { snApi: { updates: { check: async () => { calls++; return result } } } } })
    const U = r.useUpdaterStore
    const timers = []
    let nextId = 1
    const fake = {
      setTimeout: (fn, ms) => { const t = { id: nextId++, fn, ms, kind: 'timeout' }; timers.push(t); return t.id },
      clearTimeout: id => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1) },
      setInterval: (fn, ms) => { const t = { id: nextId++, fn, ms, kind: 'interval' }; timers.push(t); return t.id },
      clearInterval: id => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1) },
    }
    const fire = async kindMs => {
      const t = timers.find(x => x.ms === kindMs)
      if (!t) return false
      if (t.kind === 'timeout') timers.splice(timers.indexOf(t), 1)
      t.fn(); await flush(); await flush()
      return true
    }
    let enabled = true
    const stop = r.startUpdateScheduler(() => enabled, fake)
    check(timers.some(t => t.ms === 2500 && t.kind === 'timeout') && timers.some(t => t.ms === 6 * 3600 * 1000 && t.kind === 'interval'), 'a 2.5 s startup check and a 6 h interval')
    await fire(2500)
    check(calls === 1, 'the startup check runs')
    U.setState({ phase: 'downloading' })
    await fire(6 * 3600 * 1000)
    check(calls === 1, 'no re-check while downloading')
    U.setState({ phase: 'failed' })
    await fire(6 * 3600 * 1000)
    check(calls === 1, 'no re-check after a failed install (the card keeps its error)')
    U.setState({ phase: 'available' })
    await fire(6 * 3600 * 1000)
    check(calls === 2, 'the 6 h re-check runs while offering')
    enabled = false
    await fire(6 * 3600 * 1000)
    check(calls === 2, 'turning automatic checks off stops the re-check')
    enabled = true
    U.setState({ phase: 'idle', checking: false })
    result = { ...result, newestNotReady: '2.3.0' }
    await fire(6 * 3600 * 1000)
    check(calls === 3 && timers.some(t => t.ms === 10 * 60 * 1000), 'a half-published newest release schedules a 10 min re-check')
    for (let i = 0; i < 10; i++) await fire(10 * 60 * 1000)
    check(calls === 3 + 6 && !timers.some(t => t.ms === 10 * 60 * 1000), 'at most 6 not-ready re-checks per version')
    result = { ...result, newestNotReady: '2.4.0' }
    await fire(6 * 3600 * 1000)
    check(timers.some(t => t.ms === 10 * 60 * 1000), 'a new half-published version gets its own re-checks')
    stop()
    check(timers.length === 0, 'stop clears every timer')
  }

  console.log(`PASS: ${checks} update card checks (release selection, list fallback, dev repo override, visibility table, impact, store, scheduler)`)
}

main().catch(err => { console.error(err); process.exit(1) })
