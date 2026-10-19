// Review notes of the Changes panel (E7-FR-17..21): the exact batch format
// and sanitizeForPaste, the Enter delay, main's ReviewNoteStore on a temp
// folder (validation, edit -> pending, markSent, prune, the 500 cap, atomic
// debounced writes, corrupt files), the renderer helpers (anchors, outdated
// notes, batch limits, "send in parts") and sendReviewNotes against a fake
// window: refused targets (plain, unmounted, `not_agent`) write nothing.
// Bundled with esbuild and run in a vm, like test-git.cjs. No user data,
// pty or real console is touched.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
// Values built inside the vm have another realm's prototypes; compare as JSON.
function same(actual, expected, label) { assert.deepEqual(JSON.parse(JSON.stringify(actual ?? null)), expected, label); checks++ }
const alias = { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, alias }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, setTimeout, clearTimeout, crypto: globalThis.crypto, ...overrides })
  return mod.exports
}

// ---------------------------------------------------------------------------
// Format (Design D): identical to Orca's, sorted, escaped, sanitized.
// ---------------------------------------------------------------------------
const fmt = load('src/shared/review-notes-format.ts')
const batch = [
  { file: 'src/main/Foo.ts', lines: '40-52', comment: 'cambiar esto por un Map\nverificar null' },
  { file: 'src/main/Bar.ts', lines: '', comment: 'falta el header de licencia' },
  { file: 'src/main/Foo.ts', lines: '7', comment: 'dice "hola" y C:\\tmp' },
]
same(fmt.formatReviewNotes(batch), [
  'File: src/main/Bar.ts',
  'Scope: file',
  'User comment: "falta el header de licencia"',
  '',
  'File: src/main/Foo.ts',
  'Line: 7',
  'User comment: "dice \\"hola\\" y C:\\\\tmp"',
  '',
  'File: src/main/Foo.ts',
  'Lines: 40-52',
  'User comment: "cambiar esto por un Map\\nverificar null"',
].join('\n'), 'exact format: sorted by file then line, File/Line/Lines/Scope, escaped comment, blank line between notes')
same(fmt.escapeComment('a\\b"c\r\nd'), 'a\\\\b\\"c\\r\\nd', 'escape: backslash, quote, CR, LF')
same([fmt.linesLabel('40'), fmt.linesLabel('40-52'), fmt.linesLabel(''), fmt.linesLabel('9-3'), fmt.linesLabel('x'), fmt.linesLabel('0')], ['Line: 40', 'Lines: 40-52', 'Scope: file', 'Scope: file', 'Scope: file', 'Scope: file'], 'line labels; a malformed range is a file note')
same(fmt.formatReviewNotes([{ file: 'a', lines: '3', comment: 'x' }, { file: 'a', lines: '', comment: 'y' }, { file: 'a', lines: '3-9', comment: 'z' }]).split('\n\n').map((b) => b.split('\n')[1]), ['Scope: file', 'Line: 3', 'Lines: 3-9'], 'a file note goes first, then by start and end')
same(fmt.formatReviewNotes([]), '', 'no notes, no text')

// sanitizeForPaste (Design D): ESC -> U+241B; other C0 but tab/LF, DEL and C1 -> U+FFFD.
same(fmt.sanitizeForPaste('a\x1b[201~b'), 'a\u241b[201~b', 'ESC[201~ cannot close the paste frame')
same(fmt.sanitizeForPaste('t\tn\nr\rbel\x07nul\x00del\x7fcsi\x9bend'), 't\tn\nr\ufffdbel\ufffdnul\ufffddel\ufffdcsi\ufffdend', 'tab and LF kept; CR, BEL, NUL, DEL and C1 replaced')
same(fmt.sanitizeForPaste('$(calc) \u00f1and\u00fa \u65e5\u672c \ud83d\ude00'), '$(calc) \u00f1and\u00fa \u65e5\u672c \ud83d\ude00', 'shell syntax and unicode stay literal')
const evil = fmt.buildReviewNotesText([{ file: 'x.ts', lines: '1', comment: 'run $(calc) then \x1b[201~\rrm -rf ~' }])
check(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(evil) && evil.includes('$(calc)') && evil.includes('\u241b[201~') && evil.includes('\\rrm -rf ~'), 'a hostile comment arrives as literal text inside the frame')
check(fmt.buildReviewNotesText([{ file: 'a\x1b]0;pwn\x07.ts', lines: '1', comment: 'c' }]).startsWith('File: a\u241b]0;pwn\ufffd.ts'), 'a control byte in a path is neutralized too')
same([fmt.utf8Bytes('abc'), fmt.utf8Bytes('\u00f1'), fmt.utf8Bytes('\u65e5'), fmt.utf8Bytes('\ud83d\ude00')], [3, 2, 3, 4], 'UTF-8 byte count')

const { submitDelayFor, SUBMIT_DELAY_MS } = load('src/renderer/lib/submit.ts')
same([SUBMIT_DELAY_MS, submitDelayFor(0), submitDelayFor(1), submitDelayFor(4096), submitDelayFor(4097), submitDelayFor(32 * 1024), submitDelayFor(10 ** 7)], [150, 150, 200, 200, 250, 550, 1000], 'Enter delay: 150 ms + 50 ms per started 4 KB, capped at 1000 ms')
const shared = load('src/shared/review-notes.ts')
same([shared.noteLines({ line: 0 }), shared.noteLines({ line: 40 }), shared.noteLines({ line: 52, startLine: 40 }), shared.noteLines({ line: 40, startLine: 40 })], ['', '40', '40-52', '40'], 'lines of the shared shape')
const formatChecks = checks

// ---------------------------------------------------------------------------
// ReviewNoteStore (main) on a temp folder with fake timers.
// ---------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-notes-'))
const { ReviewNoteStore, isRelativeRepoPath, NOTES_SAVE_DEBOUNCE_MS } = load('src/main/git/ReviewNoteStore.ts')
function makeStore(file) {
  const events = [], timers = new Map()
  let seq = 0, clock = 1000, ids = 0
  const store = new ReviewNoteStore({
    file: () => file,
    emit: (e) => events.push(e),
    now: () => clock,
    newId: () => `n${++ids}`,
    setTimer: (fn, ms) => { timers.set(++seq, { fn, ms }); return seq },
    clearTimer: (h) => timers.delete(h),
  })
  const runTimers = () => { const all = [...timers.values()]; timers.clear(); all.forEach((t) => t.fn()) }
  return { store, events, timers, runTimers, tick: (ms) => { clock += ms } }
}
const file = path.join(tmp, 'data', 'review-notes.json')
const h = makeStore(file)
const base = { workspaceId: 'w1', targetKey: 'ws:w1', filePath: 'src/a.ts', area: 'unstaged', line: 12, lineText: 'const x = 1', body: 'use let' }
const n1 = h.store.upsert(base)
same(n1, { id: 'n1', workspaceId: 'w1', targetKey: 'ws:w1', filePath: 'src/a.ts', area: 'unstaged', line: 12, lineText: 'const x = 1', body: 'use let', createdAt: 1000, updatedAt: 1000 }, 'create: main mints id and times')
same(h.events, [{ workspaceId: 'w1', rev: 1 }], 'a change emits git:notesChanged with the workspace rev')
check(!fs.existsSync(file) && [...h.timers.values()].every((t) => t.ms === NOTES_SAVE_DEBOUNCE_MS) && NOTES_SAVE_DEBOUNCE_MS === 300, 'the write waits for the 300 ms debounce')
const n2 = h.store.upsert({ ...base, line: 40, startLine: 30, lineText: undefined, body: 'range', sentAt: 5, sentToPaneId: 'p1' })
check(n2.startLine === 30 && n2.line === 40 && n2.sentAt === undefined && n2.sentToPaneId === undefined, 'a range keeps startLine; sentAt from the renderer is ignored')
const n3 = h.store.upsert({ ...base, line: 0, startLine: 3, lineText: 'ignored', body: 'file note' })
check(n3.line === 0 && n3.startLine === undefined && n3.lineText === undefined, 'a file note has no range and no line text')
check(h.store.upsert({ ...base, line: 5, startLine: 5, body: 'single' }).startLine === undefined, 'startLine equal to line is a single line')
h.runTimers()
const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
check(onDisk.version === 1 && onDisk.notes.length === 4 && !fs.existsSync(file + '.tmp'), 'debounced atomic write: version 1, every note, no .tmp left')
h.store.markSent({ ids: ['n1', 'n2'], paneId: 'p1', sentAt: 2000 })
check(h.store.list('w1').notes.filter((n) => n.sentAt === 2000 && n.sentToPaneId === 'p1').length === 2, 'markSent stamps sentAt and sentToPaneId')
h.tick(500)
const edited = h.store.upsert({ ...base, id: 'n1', body: 'use const' })
check(edited.sentAt === undefined && edited.sentToPaneId === undefined && edited.updatedAt === 1500 && edited.createdAt === 1000, 'editing the text puts a sent note back to pending and bumps updatedAt')
const resolved = h.store.upsert({ ...base, id: 'n2', line: 40, startLine: 30, body: 'range', resolvedAt: 1600 })
check(resolved.resolvedAt === 1600 && resolved.sentAt === 2000 && resolved.updatedAt === 1000, 'resolving keeps sentAt and updatedAt (text unchanged)')
const evBefore = h.events.length
h.store.upsert({ ...base, id: 'n2', line: 40, startLine: 30, body: 'range', resolvedAt: 1600 })
check(h.events.length === evBefore, 'an unchanged upsert emits nothing')
const reopened = h.store.upsert({ ...base, id: 'n2', line: 40, startLine: 30, body: 'range' })
check(reopened.resolvedAt === undefined, 'reopening drops resolvedAt')
check(h.store.list('w1').rev === h.events.filter((e) => e.workspaceId === 'w1').at(-1).rev, 'list carries the current rev')
same(h.store.list('nope'), { notes: [], rev: 0 }, 'unknown workspace lists empty')
same(h.store.list(42), { notes: [], rev: 0 }, 'a non-string workspace lists empty')

// Validation: every bad input throws 'invalid' and writes nothing.
const invalid = [
  { ...base, filePath: 'C:\\repo\\a.ts' }, { ...base, filePath: '/etc/passwd' }, { ...base, filePath: '../outside.ts' }, { ...base, filePath: 'a/../../b' },
  { ...base, filePath: 'a\x1b[2J.ts' }, { ...base, filePath: '' }, { ...base, body: '' }, { ...base, body: '   \n ' }, { ...base, body: 'x'.repeat(4001) },
  { ...base, targetKey: 'other:w1' }, { ...base, targetKey: 'ws:' }, { ...base, area: 'conflict' }, { ...base, line: -1 }, { ...base, line: 1.5 },
  { ...base, workspaceId: '' }, null, 'note', { ...base, startLine: 'x' },
]
const evInvalid = h.events.length
for (const bad of invalid) {
  let code = null
  try { h.store.upsert(bad) } catch (e) { code = e.code }
  check(code === 'invalid', `invalid input rejected: ${JSON.stringify(bad)?.slice(0, 60)}`)
}
check(h.events.length === evInvalid, 'rejected inputs change nothing')
check(h.store.upsert({ ...base, body: 'x'.repeat(4000) }).body.length === 4000, 'a 4000 character body is accepted')
check(isRelativeRepoPath('docs/una carpeta/\u00f1.md') && !isRelativeRepoPath('a//b') && !isRelativeRepoPath('./a'), 'relative path rules')
check(h.store.upsert({ ...base, lineText: 'y'.repeat(5000), body: 'long line' }).lineText.length === 1000, 'the line snapshot is capped at 1000 characters')

// Delete, prune and the per-workspace cap.
h.store.upsert({ ...base, workspaceId: 'w2', targetKey: 'pane:p9', body: 'other ws' })
h.store.upsert({ ...base, workspaceId: 'w3', body: 'third ws' })
h.store.delete({ ids: ['n3'] })
check(!h.store.list('w1').notes.some((n) => n.id === 'n3'), 'delete by id')
h.store.delete({ ids: [h.store.list('w2').notes[0].id], workspaceId: 'w1' })
check(h.store.list('w2').notes.length === 1, 'ids scoped to another workspace are left alone')
h.store.delete({ workspaceId: 'w2' })
check(h.store.list('w2').notes.length === 0, 'delete a whole workspace')
h.store.prune(['w1'])
check(h.store.list('w3').notes.length === 0 && h.store.list('w1').notes.length > 0, 'prune keeps only the listed workspaces')
const evPrune = h.events.length
h.store.prune('w1'); h.store.delete(null); h.store.markSent({ ids: 'x' })
check(h.events.length === evPrune, 'malformed prune / delete / markSent do nothing')
const cap = makeStore(path.join(tmp, 'cap.json'))
for (let i = 0; i < 500; i++) cap.store.upsert({ ...base, body: `n${i}` })
let capCode = null
try { cap.store.upsert({ ...base, body: 'one too many' }) } catch (e) { capCode = e.code }
check(capCode === 'limit' && cap.store.list('w1').notes.length === 500, 'a workspace keeps at most 500 notes')
check(cap.store.upsert({ ...base, id: 'n1', body: 'edit still works' }).body === 'edit still works', 'editing at the cap still works')

// Reload: the file round-trips; a corrupt or foreign file loads as empty; bad notes are dropped one by one.
h.store.flush()
const reloaded = makeStore(file)
same(reloaded.store.list('w1').notes.map((n) => n.id), JSON.parse(JSON.stringify(h.store.list('w1').notes.map((n) => n.id))), 'a new store reads the same notes back')
check(reloaded.store.list('w1').rev === 0, 'revs restart per run')
fs.writeFileSync(path.join(tmp, 'corrupt.json'), '{not json')
check(makeStore(path.join(tmp, 'corrupt.json')).store.list('w1').notes.length === 0, 'corrupt file loads as empty')
fs.writeFileSync(path.join(tmp, 'foreign.json'), JSON.stringify({ version: 7, notes: [] }))
check(makeStore(path.join(tmp, 'foreign.json')).store.list('w1').notes.length === 0, 'unknown version loads as empty')
const good = { ...n1 }
fs.writeFileSync(path.join(tmp, 'mixed.json'), JSON.stringify({ version: 1, notes: [good, { ...good, id: 'bad', filePath: '../x' }, { ...good }, 'junk'] }))
same(makeStore(path.join(tmp, 'mixed.json')).store.list('w1').notes.map((n) => n.id), ['n1'], 'invalid and duplicate notes in the file are dropped')
const ro = makeStore(path.join(tmp, 'missing', 'x.json'))
check(ro.store.list('w1').notes.length === 0, 'a missing file loads as empty')
const storeChecks = checks - formatChecks

// ---------------------------------------------------------------------------
// Renderer: helpers, sendReviewNotes and the sync, against a fake window.
// ---------------------------------------------------------------------------
;(async () => {
  const writes = [], pastes = [], marks = [], deletes = [], prunes = []
  let changedCb = null
  const listed = { w1: { notes: [], rev: 0 } }
  const fakeWin = {
    snApi: {
      platform: 'win32',
      pty: { write: (w) => writes.push(w) },
      reviewNotes: {
        list: async (ws) => listed[ws] ?? { notes: [], rev: 0 },
        markSent: async (r) => { marks.push(r) },
        delete: async (r) => { deletes.push(r) },
        prune: (ids) => prunes.push(ids),
        onChanged: (cb) => { changedCb = cb; return () => { changedCb = null } },
      },
    },
  }
  const entry = [
    "export * from './src/renderer/lib/reviewNotesStore'",
    "export * from './src/renderer/lib/sendReviewNotes'",
    "export { useAppStore } from './src/renderer/lib/store'",
    "export { registerPty } from './src/renderer/lib/ptyRegistry'",
    "export { registerPaster } from './src/renderer/lib/pasteRegistry'",
    "export { setFocusedPane, getFocusHistoryForWorkspace } from './src/renderer/lib/focus'",
  ].join('\n')
  const code = buildSync({ stdin: { contents: entry, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, alias, define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text
  const rmod = { exports: {} }
  vm.runInNewContext(code, { module: rmod, exports: rmod.exports, require, console, process, window: fakeWin, setTimeout, clearTimeout, crypto: globalThis.crypto })
  const R = rmod.exports
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // Anchors and outdated notes (E7-FR-18).
  const note = (o) => ({ id: o.id, workspaceId: 'w1', targetKey: 'ws:w1', filePath: 'src/a.ts', area: 'unstaged', line: 0, body: 'b', createdAt: o.createdAt ?? 1, updatedAt: 1, ...o })
  const hunks = [{ header: '@@ -1,3 +1,4 @@', oldStart: 1, newStart: 1, lines: [{ kind: 'ctx', oldNo: 1, newNo: 1, text: 'one' }, { kind: 'del', oldNo: 2, text: 'two' }, { kind: 'add', newNo: 2, text: 'TWO' }, { kind: 'add', newNo: 3, text: 'three' }] }]
  const anchors = R.anchorNotes([note({ id: 'a', line: 2, lineText: 'TWO' }), note({ id: 'b', line: 3, lineText: 'old three' }), note({ id: 'c', line: 99, lineText: 'x' }), note({ id: 'f', line: 0, createdAt: 5 }), note({ id: 'd', line: 2, createdAt: 0 })], hunks)
  same([...anchors.byLine.entries()].map(([l, ns]) => [l, ns.map((n) => n.id)]), [[2, ['d', 'a']], [3, ['b']]], 'cards sit under their new-side line, oldest first')
  same(anchors.top.map((n) => n.id), ['f', 'c'], 'file notes, then notes whose line left the diff, go above it')
  same([...anchors.stale].sort(), ['b', 'c'], 'a changed line text or a line gone from the diff is outdated; same text is not')
  same([...R.newSideLines(hunks).keys()], [1, 2, 3], 'only add and context lines take notes')
  // A minified line past main's 1000-character snapshot: same text is not outdated, a change past the cut is not seen either.
  const longLine = 'a'.repeat(70 * 1024)
  const longHunks = [{ header: '@@ -0,0 +1 @@', oldStart: 0, newStart: 1, lines: [{ kind: 'add', newNo: 1, text: longLine }] }]
  const snap = R.lineSnapshot(longLine)
  check(snap.length === 1000 && R.anchorNotes([note({ id: 'L', line: 1, lineText: snap })], longHunks).stale.size === 0, 'a long line compares its 1000-character snapshot, so an unchanged line is not outdated')
  check(R.anchorNotes([note({ id: 'L', line: 1, lineText: 'b' + snap.slice(1) })], longHunks).stale.has('L'), 'a change inside the snapshot of a long line is outdated')
  check(h.store.upsert({ ...base, workspaceId: 'wLong', targetKey: 'ws:wLong', line: 1, lineText: snap, body: 'minified' }).lineText === snap, 'the snapshot the panel sends is accepted as is')
  same(R.noteCountsByRow([note({ id: 'a' }), note({ id: 'b', resolvedAt: 1 }), note({ id: 'c', area: 'staged' }), note({ id: 'e', targetKey: 'pane:p1' })], 'ws:w1'), { 'unstaged:src/a.ts': 1, 'staged:src/a.ts': 1 }, 'row badges count unresolved notes of the target')
  same(R.pendingNotes([note({ id: 'a' }), note({ id: 'b', sentAt: 1 }), note({ id: 'c', resolvedAt: 1 })]).map((n) => n.id), ['a'], 'pending = not sent, not resolved')
  same(R.toPayload(note({ id: 'a', line: 52, startLine: 40, body: 'x' })), { file: 'src/a.ts', lines: '40-52', comment: 'x' }, 'the desktop note maps to the shared shape')

  // Batch limits (E7-FR-19): 50 notes or 32 KB; "send in parts" takes the longest prefix that fits.
  const many = (n, body = 'b') => Array.from({ length: n }, (_, i) => note({ id: `m${i}`, line: i + 1, body }))
  check(R.checkBatch(many(50).map(R.toPayload)).ok && !R.checkBatch(many(51).map(R.toPayload)).ok, '50 notes fit, 51 do not')
  check(!R.checkBatch(many(9, 'x'.repeat(4000)).map(R.toPayload)).ok && R.checkBatch(many(8, 'x'.repeat(4000)).map(R.toPayload)).ok, 'the 32 KB limit counts the formatted text')
  check(!R.checkBatch(many(3, '\u65e5'.repeat(3700)).map(R.toPayload)).ok, 'the limit counts UTF-8 bytes, not characters')
  check(!R.checkBatch([]).ok, 'an empty batch does not fit')
  same(R.firstBatch(many(60)).length, 50, 'parts: at most 50')
  same(R.firstBatch(many(12, 'x'.repeat(4000))).map((n) => n.id), ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'], 'parts: the first notes in batch order that fit 32 KB')
  same(R.firstBatch([note({ id: 'z', filePath: 'z.ts', line: 1 }), note({ id: 'a2', filePath: 'a.ts', line: 9 }), note({ id: 'a1', filePath: 'a.ts', line: 2 })]).map((n) => n.id), ['a1', 'a2', 'z'], 'parts follow the printed order')

  // sendReviewNotes (E7-FR-19, executor of FR-25). Panes: agent, safe shell, plain shell, unmounted.
  const pane = (id, type) => ({ id, type, title: id, color: '#fff', icon: 'bot' })
  R.useAppStore.setState({ workspaces: [{ id: 'w1', name: 'A', cwd: 'C:\\repo', panes: [pane('claude', 'claude'), pane('safe', 'shell'), pane('plain', 'shell'), pane('cold', 'codex')] }], activeWorkspaceId: 'w1', paneStatus: { claude: { state: 'idle', precise: true, provider: 'claude' } } })
  const brackets = { claude: true, safe: true, plain: false }
  for (const id of Object.keys(brackets)) {
    R.registerPty(id, `pty-${id}`)
    R.registerPaster(id, { paste: (t) => pastes.push([id, t]), bracketed: () => brackets[id] })
  }
  same(['claude', 'safe', 'plain', 'cold'].map((id) => R.notesTargetOf(pane(id, id === 'claude' ? 'claude' : id === 'cold' ? 'codex' : 'shell'))), ['agent', 'safe', 'plain', 'unmounted'], 'targets: agent, safe paste, plain, unmounted')
  const stored = [note({ id: 's1', filePath: 'src/b.ts', line: 3, body: 'fix "this"' }), note({ id: 's2', line: 0, body: 'license' }), note({ id: 's3', line: 9, body: 'sent', sentAt: 5 }), note({ id: 's4', line: 1, body: 'done', resolvedAt: 5 })]
  R.useReviewNotesStore.getState().apply('w1', { notes: stored, rev: 3 })
  const nothing = () => pastes.length === 0 && writes.length === 0 && marks.length === 0
  const send = (paneId, opts) => R.sendReviewNotes('w1', paneId, opts)
  same(send('plain', { submit: false }), { ok: false, sent: 0, error: 'not_agent' }, 'plain console: not_agent')
  same(send('safe', { submit: true }), { ok: false, sent: 0, error: 'not_agent' }, 'Enter to a console that is not an agent: not_agent')
  same(send('cold', { submit: false }), { ok: false, sent: 0, error: 'no_pty' }, 'unmounted console: no_pty')
  same(send('ghost', { submit: false }), { ok: false, sent: 0, error: 'not_found' }, 'unknown pane: not_found')
  same(R.sendReviewNotes('w9', 'claude', { submit: false }), { ok: false, sent: 0, error: 'not_found' }, 'pane of another workspace: not_found')
  same(send('claude', { notes: [], submit: false }), { ok: false, sent: 0, error: 'no_notes' }, 'empty inline list: no_notes')
  same(send('claude', { noteIds: ['s4', 'nope'], submit: false }).error, 'no_notes', 'a resolved note is never sent; unknown ids: no_notes')
  same(send('claude', { notes: many(51).map(R.toPayload), submit: false }), { ok: false, sent: 0, error: 'too_large' }, '51 inline notes: too_large')
  same(send('claude', { notes: many(9, 'x'.repeat(4000)).map(R.toPayload), submit: false }).error, 'too_large', 'over 32 KB: too_large')
  check(nothing(), 'every refused send wrote nothing: no paste, no pty write, no markSent')
  brackets.claude = false
  same(send('claude', { submit: false }).error, 'not_agent', 'an agent console whose app dropped bracketed paste is refused')
  check(nothing(), 'and nothing was written')
  brackets.claude = true

  // A real send: one paste with the exact text, no Enter by default, store notes stamped.
  const res = send('claude', { submit: false })
  same(res, { ok: true, sent: 2 }, 'pending store notes go (sent and resolved ones stay out)')
  const expected = R.checkBatch([stored[0], stored[1]].map(R.toPayload)).text
  same(pastes, [['claude', expected]], 'one term.paste with the formatted, sanitized batch')
  same(expected, 'File: src/a.ts\nScope: file\nUser comment: "license"\n\nFile: src/b.ts\nLine: 3\nUser comment: "fix \\"this\\""', 'exactly the Orca format')
  await sleep(260)
  check(writes.length === 0, 'without "Send with Enter" no CR is ever written')
  same(marks.map((m) => [m.ids, m.paneId]), [[['s1', 's2'], 'claude']], 'store notes are marked sent to that pane')
  pastes.length = 0; marks.length = 0

  // Enter on an agent console, after the delay; inline notes are never stored.
  same(send('claude', { notes: [{ file: 'm.ts', lines: '1', comment: 'from the phone' }], submit: true }), { ok: true, sent: 1 }, 'inline notes with Enter')
  check(writes.length === 0, 'the CR waits for submitDelayFor')
  await sleep(260)
  same(writes, [{ ptyId: 'pty-claude', data: '\r' }], 'then exactly one CR to the same pty')
  check(marks.length === 0, 'inline (phone) notes are not marked in the desktop store')
  writes.length = 0; pastes.length = 0
  same(send('safe', { noteIds: ['s1'], submit: false }), { ok: true, sent: 1 }, 'a safe-paste shell takes a paste without Enter')
  check(pastes.length === 1 && pastes[0][0] === 'safe', 'pasted into the shell, never written raw')
  pastes.length = 0; marks.length = 0
  R.registerPty('claude', 'pty-claude')
  send('claude', { notes: [{ file: 'a', lines: '', comment: 'x' }], submit: true })
  R.registerPty('claude', 'pty-restarted')
  await sleep(260)
  check(writes.length === 0, 'a console restarted before the Enter gets no stray CR')
  R.registerPty('claude', 'pty-claude')
  pastes.length = 0

  // Last focused agent console (the preselected target).
  R.setFocusedPane('safe', 'w1'); R.setFocusedPane('claude', 'w1'); R.setFocusedPane('plain', 'w1')
  same([...R.getFocusHistoryForWorkspace('w1')], ['plain', 'claude', 'safe'], 'focus history per workspace, most recent first')

  // FR-21: a new Claude console.
  R.useAppStore.setState((s) => ({ presets: [{ id: 'pc', name: 'Claude', type: 'claude', command: 'claude', args: [], color: '#f80', icon: 'claude' }, ...s.presets.filter((p) => p.type !== 'claude')], settings: { ...s.settings, automation: { ...s.settings.automation, defaultAgentPresetId: '' } } }))
  R.useReviewNotesStore.getState().apply('w1', { notes: [note({ id: 'q1', line: 2, body: 'new console' })], rev: 4 })
  const fresh = R.sendReviewNotesToNewClaude('w1', { noteIds: ['q1'], submit: true, cwd: 'C:\\wt\\sn-claude' }, { readyMs: 2000, pollMs: 20, settleMs: 10 })
  await sleep(10)
  const ws1 = R.useAppStore.getState().workspaces[0]
  const created = ws1.panes.at(-1)
  check(ws1.panes.length === 5 && created.type === 'claude' && created.presetId === 'pc' && created.cwd === 'C:\\wt\\sn-claude', 'a Claude pane is added in the target folder')
  check(pastes.length === 0, 'nothing is pasted before the console is ready')
  R.registerPty(created.id, 'pty-new')
  R.registerPaster(created.id, { paste: (t) => pastes.push([created.id, t]), bracketed: () => true })
  await sleep(60)
  check(pastes.length === 0, 'bracketed paste alone is not ready: it also waits for a first status')
  R.useAppStore.setState((s) => ({ paneStatus: { ...s.paneStatus, [created.id]: { state: 'idle', precise: true, provider: 'claude' } } }))
  const freshRes = await fresh
  check(freshRes.ok && freshRes.paneId === created.id && !freshRes.late && pastes.length === 1 && pastes[0][1].includes('new console'), 'once ready the notes are pasted in the new console')
  await sleep(260)
  same(writes.at(-1), { ptyId: 'pty-new', data: '\r' }, 'with Enter checked the turn starts')
  writes.length = 0; pastes.length = 0

  const slow = await R.sendReviewNotesToNewClaude('w1', { noteIds: ['q1'], submit: true }, { readyMs: 80, pollMs: 20, settleMs: 0 })
  check(!slow.ok && slow.error === 'timeout' && pastes.length === 0 && writes.length === 0, 'not ready in time and no safe paste: timeout, nothing written')
  const late = R.sendReviewNotesToNewClaude('w1', { noteIds: ['q1'], submit: true }, { readyMs: 80, pollMs: 20, settleMs: 0 })
  await sleep(5)
  const lateId = R.useAppStore.getState().workspaces[0].panes.at(-1).id
  R.registerPty(lateId, 'pty-late')
  R.registerPaster(lateId, { paste: (t) => pastes.push([lateId, t]), bracketed: () => true })
  const lateRes = await late
  check(lateRes.ok && lateRes.late && pastes.length === 1, 'past the timeout with a safe paste: sent anyway, flagged late')
  await sleep(260)
  check(writes.length === 0, 'a late console with no status gets no Enter')
  pastes.length = 0
  const closing = R.sendReviewNotesToNewClaude('w1', { noteIds: ['q1'], submit: false }, { readyMs: 500, pollMs: 20 })
  await sleep(5)
  const closingId = R.useAppStore.getState().workspaces[0].panes.at(-1).id
  R.useAppStore.getState().removePane('w1', closingId)
  same((await closing).error, 'closed', 'closing the new console while it starts aborts the send')
  R.useAppStore.setState((s) => ({ workspaces: s.workspaces.map((w) => ({ ...w, panes: [...w.panes, ...Array.from({ length: 12 - w.panes.length }, (_, i) => pane(`fill${i}`, 'shell'))] })) }))
  const before = R.useAppStore.getState().workspaces[0].panes.length
  same((await R.sendReviewNotesToNewClaude('w1', { noteIds: ['q1'], submit: false })).error, 'full', 'with 12 consoles the workspace is full')
  check(R.useAppStore.getState().workspaces[0].panes.length === before && before === 12, 'and no pane is added')
  R.useAppStore.setState((s) => ({ presets: s.presets.filter((p) => p.type !== 'claude'), workspaces: s.workspaces.map((w) => ({ ...w, panes: w.panes.slice(0, 4) })) }))
  same((await R.sendReviewNotesToNewClaude('w1', { noteIds: ['q1'], submit: false })).error, 'no_preset', 'no Claude preset: no_preset')

  // Sync: prune after a real load, delete the notes of a removed workspace, reload on change.
  R.useAppStore.setState({ workspaces: [{ id: 'w1', name: 'A', panes: [] }, { id: 'w2', name: 'B', panes: [] }] })
  const stopSync = R.startReviewNotesSync({ prune: true })
  same(prunes, [['w1', 'w2']], 'prune with the workspaces that exist')
  listed.w1 = { notes: [note({ id: 'r1', body: 'reloaded' })], rev: 9 }
  changedCb({ workspaceId: 'w1', rev: 9 })
  await sleep(10)
  same(R.useReviewNotesStore.getState().notes.w1.map((n) => n.id), ['r1'], 'a change event reloads a loaded workspace')
  changedCb({ workspaceId: 'w2', rev: 1 })
  await sleep(10)
  check(!('w2' in R.useReviewNotesStore.getState().notes), 'a workspace never opened is not loaded on change')
  R.useReviewNotesStore.getState().apply('w1', { notes: [], rev: 8 })
  check(R.useReviewNotesStore.getState().notes.w1.length === 1, 'an older rev never overwrites a newer list')
  R.useAppStore.setState({ workspaces: [{ id: 'w1', name: 'A', panes: [] }] })
  same(deletes, [{ workspaceId: 'w2' }], 'deleting a workspace deletes its notes in main')
  R.useAppStore.setState({ workspaces: [] })
  check(!('w1' in R.useReviewNotesStore.getState().notes), 'and drops them from the mirror')
  stopSync()
  const stopNoPrune = R.startReviewNotesSync({ prune: false })
  check(prunes.length === 1, 'no prune after a failed config load')
  stopNoPrune()

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`PASS: ${checks} review notes checks (${formatChecks} format/sanitize/delay, ${storeChecks} ReviewNoteStore, ${checks - formatChecks - storeChecks} renderer: anchors, limits, parts, sendReviewNotes, new console, sync)`)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
