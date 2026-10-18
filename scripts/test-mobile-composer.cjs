// Phone composer logic (E1-FR-22..31): input chunking with surrogate pairs,
// agent pane and slash detection, the Send / Insert / slash typing flows under
// a fake ComposerIo, drafts (debounce, cap, pruning, blocked storage), the
// storage wipe on unpair, and the per-pane input mode rules.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }

/** In-memory localStorage; blocked = every access throws (private mode). */
function fakeStorage({ blocked = false } = {}) {
  const map = new Map()
  const guard = () => { if (blocked) throw new Error('SecurityError') }
  return {
    map,
    get length() { guard(); return map.size },
    key(i) { guard(); return [...map.keys()][i] ?? null },
    getItem(k) { guard(); return map.has(k) ? map.get(k) : null },
    setItem(k, v) { guard(); map.set(k, String(v)) },
    removeItem(k) { guard(); map.delete(k) },
  }
}

function load(file, storage = fakeStorage()) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, setTimeout, clearTimeout, AbortController, localStorage: storage })
  return mod.exports
}

;(async () => {
  // --- chunkInput / isAgentPane / slash detection ---
  const cs = load('src/mobile/src/lib/composerSend.ts')
  const { chunkInput, isAgentPane, isSlashCommand, shouldTypeSlash, needsMultilineConfirm, insertAt } = cs
  check(cs.INPUT_CHUNK === 8000 && cs.INPUT_CHUNK <= 8192, 'frames stay under the 8192 schema limit')
  check(cs.SLASH_KEY_MS === 16 && cs.SLASH_MAX === 200 && cs.ENTER_DELAY_MS === 50 && cs.COMPOSER_MAX === 16384, 'contract constants')
  check(cs.LONG_PRESS_MS === 450 && cs.COMPOSER_COUNTER_FROM === 14000, 'long-press 450ms, counter from 14000')
  check(chunkInput('').length === 0 && chunkInput('abc').length === 1, 'empty yields no frame, short yields one')
  {
    const big = 'x'.repeat(20000)
    const parts = chunkInput(big)
    check(parts.length === 3 && parts.join('') === big, '20000 chars go in 3 frames, in order, complete')
    check(parts.every(p => p.length <= 8000), 'no frame exceeds INPUT_CHUNK')
  }
  {
    // An emoji straddling the cut: the pair moves whole into the next frame.
    const s = 'a'.repeat(7999) + '\u{1F600}' + 'b'.repeat(10)
    const parts = chunkInput(s)
    check(parts[0].length === 7999 && parts[1].startsWith('\u{1F600}'), 'a surrogate pair at the boundary is never split')
    check(parts.join('') === s, 'rejoined frames equal the input')
    const emojis = '\u{1F600}'.repeat(9000)
    const ep = chunkInput(emojis, 8000)
    check(ep.every(p => !/[\uD800-\uDBFF]$/.test(p) && !/^[\uDC00-\uDFFF]/.test(p)), 'all-emoji text never ends a frame on a high surrogate')
    check(ep.join('') === emojis, 'all-emoji text survives chunking')
    check(chunkInput('abcdefg', 3).join('|') === 'abc|def|g', 'custom max splits evenly')
  }
  check(isAgentPane('claude') && isAgentPane('codex') && isAgentPane('custom'), 'claude, codex and custom are agent panes')
  check(!isAgentPane('shell') && isAgentPane('shell', { state: 'working', provider: 'claude', stateSince: 0 }), 'a shell is an agent pane only with a provider in its status')
  check(isSlashCommand('/model') && isSlashCommand('  /compact  '), 'slash commands, edges trimmed')
  check(!isSlashCommand('/a\nb') && !isSlashCommand('/' + 'x'.repeat(300)) && !isSlashCommand('hello /x'), 'multi-line, long or non-leading slash text is not a command')
  check(isSlashCommand('/' + 'x'.repeat(199)) && !isSlashCommand('/' + 'x'.repeat(200)), '200 chars is the slash cap')
  check(shouldTypeSlash('/model', 'claude') && !shouldTypeSlash('/usr/bin/ls', 'shell'), '/model types in Claude, /usr/bin/ls pastes in a shell')
  check(needsMultilineConfirm('a\nb', false) && !needsMultilineConfirm('a\nb', true) && !needsMultilineConfirm('ab', false), 'multi-line confirm only without bracketed paste')
  check(!needsMultilineConfirm('a\nb', undefined), 'unknown paste mode does not ask')
  {
    const r = insertAt('hello world', 'XX', 5)
    check(r.value === 'helloXX world' && r.caret === 7, 'insertAt puts text at the caret and moves it')
    const sel = insertAt('hello world', '-', 0, 5)
    check(sel.value === '- world' && sel.caret === 1, 'insertAt replaces the selection')
    const cap = insertAt('abc', 'defgh', 3, 3, 5)
    check(cap.value === 'abcde' && cap.caret === 5, 'insertAt respects the max length')
    const pair = insertAt('abc', '\u{1F600}', 3, 3, 4)
    check(pair.value === 'abc', 'insertAt never inserts half a surrogate pair')
  }

  // --- sendComposer / typeSlash with a fake io ---
  function fakeIo({ open = true, pane = 'p1', bracketed = true } = {}) {
    const log = []
    const io = {
      open, pane, latch: true,
      isOpen: () => io.open,
      currentPaneId: () => io.pane,
      paste: text => log.push(['paste', text, io.latch]),
      sendInput: data => { if (!io.open) return false; log.push(['input', data]); return true },
      releaseLatch: () => { io.latch = false },
      sleeps: [],
      onSleep: null,
      sleep: async (ms) => { io.sleeps.push(ms); if (io.onSleep) io.onSleep(io.sleeps.length) },
    }
    return { io, log, bracketed }
  }
  {
    const { io, log } = fakeIo({ open: false })
    const ok = await cs.sendComposer('hi', { enter: true, paneId: 'p1', signal: new AbortController().signal }, io)
    check(ok === false && log.length === 0, 'closed socket: nothing is pasted and the draft stays')
  }
  {
    const { io, log } = fakeIo()
    const ok = await cs.sendComposer('line 1\nline 2\nline 3', { enter: true, paneId: 'p1', signal: new AbortController().signal }, io)
    check(ok && log.length === 2, 'Send pastes then writes Enter')
    check(log[0][0] === 'paste' && log[0][2] === false, 'the latch is released before the paste')
    check(log[1][0] === 'input' && log[1][1] === '\r', 'Enter goes as its own \\r frame')
    check(io.sleeps[0] === 50, 'Enter waits ENTER_DELAY_MS')
  }
  {
    const { io, log } = fakeIo()
    const ok = await cs.sendComposer('keep it', { enter: false, paneId: 'p1', signal: new AbortController().signal }, io)
    check(ok && log.length === 1 && log[0][0] === 'paste', 'Insert pastes without Enter')
  }
  {
    const { io, log } = fakeIo()
    io.onSleep = () => { io.pane = 'p2' }
    const ok = await cs.sendComposer('x', { enter: true, paneId: 'p1', signal: new AbortController().signal }, io)
    check(ok && log.length === 1, 'a pane switch during the delay drops the Enter (it never hits the new pane)')
  }
  {
    const { io, log } = fakeIo({ pane: 'p2' })
    const ok = await cs.sendComposer('x', { enter: true, paneId: 'p1', signal: new AbortController().signal }, io)
    check(!ok && log.length === 0, 'text for another pane is not sent')
  }
  {
    const { io, log } = fakeIo()
    const progress = []
    const ok = await cs.sendComposer(' /model ', { enter: true, paneId: 'p1', signal: new AbortController().signal, slash: true, onProgress: (d, t) => progress.push(d + '/' + t) }, io)
    check(ok && log.every(e => e[0] === 'input'), 'slash commands are typed, not pasted')
    check(log.map(e => e[1]).join('') === '/model\r' && log.length === 7, 'one character per frame, then \\r')
    check(io.sleeps.every(ms => ms === 16) && io.sleeps.length === 6, 'a key every SLASH_KEY_MS')
    check(progress.join(',') === '1/6,2/6,3/6,4/6,5/6,6/6', 'progress counts every typed key')
  }
  {
    const { io, log } = fakeIo()
    const ac = new AbortController()
    io.onSleep = n => { if (n === 2) ac.abort() }
    const ok = await cs.typeSlash('/compact', 'p1', io, ac.signal)
    check(!ok && log.length === 2 && !log.some(e => e[1] === '\r'), 'aborting (pane change) stops the typing, no Enter')
  }
  {
    const { io, log } = fakeIo()
    io.onSleep = n => { if (n === 3) io.open = false }
    const ok = await cs.typeSlash('/compact', 'p1', io, new AbortController().signal)
    check(!ok && log.length === 3, 'a dropped socket stops the typing')
  }
  {
    const { io, log } = fakeIo()
    const ok = await cs.typeSlash('/\u{1F600}x', 'p1', io, new AbortController().signal)
    check(ok && log[1][1] === '\u{1F600}', 'slash typing sends a surrogate pair as one key')
  }
  {
    const ac = new AbortController()
    const t0 = Date.now()
    const p = cs.abortableSleep(5000, ac.signal)
    ac.abort()
    await p
    check(Date.now() - t0 < 1000, 'abortableSleep settles on abort')
  }

  // --- drafts ---
  {
    const storage = fakeStorage()
    const d = load('src/mobile/src/lib/drafts.ts', storage)
    check(d.DRAFT_DEBOUNCE_MS === 300 && d.DRAFT_MAX_KEYS === 50 && d.DRAFT_MAX_CHARS === 16384, 'draft constants')
    check(d.draftKey('p1') === 'snagentsos.draft.p1', 'draft key carries the brand prefix')
    d.saveDraft('p1', 'hello', 1000)
    const got = d.loadDraft('p1')
    check(got && got.text === 'hello' && got.updatedAt === 1000, 'a draft round-trips with updatedAt')
    check(JSON.parse(storage.map.get('snagentsos.draft.p1')).text === 'hello', 'stored as { text, updatedAt } JSON')
    d.saveDraft('p1', '', 2000)
    check(d.loadDraft('p1') === null && !storage.map.has('snagentsos.draft.p1'), 'an empty draft removes the key')
    d.saveDraft('p2', 'y'.repeat(20000), 1)
    check(d.loadDraft('p2').text.length === 16384, 'a draft is capped at 16384 chars')
    storage.map.set('snagentsos.draft.bad', '{nope')
    check(d.loadDraft('bad') === null, 'a corrupt draft reads as none')
    // Debounce under a fake clock.
    let now = 0
    const queue = []
    const timers = { setTimeout: (fn, ms) => { const t = { fn, due: now + ms }; queue.push(t); return t }, clearTimeout: t => { const i = queue.indexOf(t); if (i >= 0) queue.splice(i, 1) } }
    const saves = []
    const w = d.createDraftWriter({ now: () => now, timers, save: (id, text, at) => saves.push([id, text, at]) })
    w.schedule('a', 'h'); now = 100; w.schedule('a', 'he'); now = 250; w.schedule('a', 'hel')
    check(saves.length === 0 && queue.length === 1, 'typing restarts the 300ms debounce')
    now = 550; queue.shift().fn()
    check(saves.length === 1 && saves[0][1] === 'hel' && saves[0][2] === 550, 'one write after 300ms of quiet')
    w.schedule('a', 'x'); w.schedule('b', 'y')
    check(saves.length === 2 && saves[1][0] === 'a' && saves[1][1] === 'x', 'switching panes flushes the previous pane right away')
    w.flush()
    check(saves.length === 3 && saves[2][0] === 'b', 'flush writes the pending draft')
    w.schedule('b', 'z'); w.cancel(); w.flush()
    check(saves.length === 3 && queue.length === 0, 'cancel drops the pending write (text was sent)')
  }
  {
    const storage = fakeStorage()
    const d = load('src/mobile/src/lib/drafts.ts', storage)
    for (let i = 0; i < 50; i++) d.saveDraft('p' + i, 't' + i, 1000 + i)
    check([...storage.map.keys()].length === 50, '50 drafts fit')
    d.saveDraft('p0', 'updated', 5000)
    check([...storage.map.keys()].length === 50 && d.loadDraft('p0').text === 'updated', 'updating an existing draft evicts nothing')
    d.saveDraft('new', 'n', 6000)
    check([...storage.map.keys()].length === 50 && d.loadDraft('p1') === null && d.loadDraft('new'), 'the 51st draft evicts the oldest')
  }
  {
    const storage = fakeStorage()
    const d = load('src/mobile/src/lib/drafts.ts', storage)
    const DAY = 24 * 60 * 60 * 1000, now = 100 * DAY
    d.saveDraft('oldGone', 'a', now - 8 * DAY)
    d.saveDraft('oldLive', 'b', now - 8 * DAY)
    d.saveDraft('newGone', 'c', now - 1 * DAY)
    storage.map.set('snagentsos.draft.corrupt', 'x')
    storage.map.set('snagentsos.remote.deviceId', 'keep')
    const removed = d.pruneDrafts(new Set(['oldLive']), now)
    check(removed === 2 && d.loadDraft('oldGone') === null && !storage.map.has('snagentsos.draft.corrupt'), 'old drafts of gone panes and corrupt ones are pruned')
    check(d.loadDraft('oldLive') && d.loadDraft('newGone'), 'live panes and recent drafts are kept')
    check(storage.map.get('snagentsos.remote.deviceId') === 'keep', 'pruning touches only draft keys')
  }
  {
    const d = load('src/mobile/src/lib/drafts.ts', fakeStorage({ blocked: true }))
    let threw = false
    try {
      d.saveDraft('p1', 'x'); d.loadDraft('p1'); d.clearDraft('p1'); d.pruneDrafts(new Set())
    } catch { threw = true }
    check(!threw && d.loadDraft('p1') === null, 'blocked storage never throws')
  }

  // --- storage wipe ---
  {
    const storage = fakeStorage()
    const m = load('src/mobile/src/lib/mobileStorage.ts', storage)
    storage.setItem('snagentsos.draft.p1', '{}')
    storage.setItem('snagentsos.draft.p2', '{}')
    storage.setItem('snagentsos.inputMode.p1', 'composer')
    storage.setItem('snagentsos.remote.deviceId', 'dev')
    storage.setItem('snagentsos.composer.autocorrect', '1')
    const n = m.clearMobileStorage()
    check(n === 3 && ![...storage.map.keys()].some(k => k.startsWith('snagentsos.draft.') || k.startsWith('snagentsos.inputMode.')), 'clearMobileStorage removes every draft and input mode')
    check(storage.map.has('snagentsos.remote.deviceId') && storage.map.has('snagentsos.composer.autocorrect'), 'auth keys and preferences stay')
    const blocked = load('src/mobile/src/lib/mobileStorage.ts', fakeStorage({ blocked: true }))
    check(blocked.clearMobileStorage() === 0 && blocked.storageGet('x') === null && blocked.storageSet('x', 'y') === false, 'blocked storage degrades quietly')
  }

  // --- prefs and input mode ---
  {
    const storage = fakeStorage()
    const p = load('src/mobile/src/lib/prefs.ts', storage)
    check(p.PREF_KEYS.composerDefaultForAgents === 'snagentsos.composer.agentsDefault' && p.PREF_KEYS.composerAutocorrect === 'snagentsos.composer.autocorrect', 'preference keys')
    const def = p.loadPrefs()
    check(!def.composerDefaultForAgents && !def.composerAutocorrect && def.inPageAlerts, 'defaults: composer prefs off, alerts on')
    p.savePref('composerAutocorrect', true)
    check(storage.map.get('snagentsos.composer.autocorrect') === '1' && p.loadPref('composerAutocorrect'), 'a pref saves and reads back')
    p.savePref('composerAutocorrect', false)
    check(!storage.map.has('snagentsos.composer.autocorrect'), 'back to the default removes the key')
    check(p.inputModeKey('p1') === 'snagentsos.inputMode.p1', 'input mode key')
    p.saveInputMode('p1', 'composer'); p.saveInputMode('p2', 'direct'); storage.setItem('snagentsos.inputMode.p3', 'bogus')
    const modes = p.loadInputModes()
    check(modes.p1 === 'composer' && modes.p2 === 'direct' && !('p3' in modes), 'saved modes load, corrupt ones are skipped')
    check(p.resolveInputMode(undefined, 'claude', false) === 'direct', 'default mode is direct')
    check(p.resolveInputMode(undefined, 'claude', true) === 'composer' && p.resolveInputMode(undefined, 'custom', true) === 'composer' && p.resolveInputMode(undefined, 'codex', true) === 'composer', 'the agents default opens AI consoles in composer')
    check(p.resolveInputMode(undefined, 'shell', true) === 'direct', 'a shell stays direct with the agents default on')
    check(p.resolveInputMode('direct', 'claude', true) === 'direct' && p.resolveInputMode('composer', 'shell', false) === 'composer', 'a saved choice wins')
    const blocked = load('src/mobile/src/lib/prefs.ts', fakeStorage({ blocked: true }))
    check(blocked.loadPrefs().inPageAlerts === true && Object.keys(blocked.loadInputModes()).length === 0, 'blocked storage reads defaults')
  }

  console.log(`PASS: ${checks} mobile composer checks`)
})().catch(e => { console.error(e); process.exit(1) })
