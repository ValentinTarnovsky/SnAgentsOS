// Changes on the phone (E3-FR-52..56, R30-09b), the logic half: the status
// pages joined and grouped by section, the diff read page by page (continued
// hunks joined, a new diffRev restarts at page 0, the 80% prefetch), the rows
// and their line numbers, and the phone's review notes (one localStorage key
// per workspace keyed by path, "Outdated" against the diff read, batches that
// fit the desktop's limits and the ctl schema, the default console). It runs
// against the gitRes fixtures R30-09a exports (scripts/fixtures/git-remote)
// and against GitRemote's own paging, so both halves agree. Same esbuild + vm
// harness as test-mobile-home.cjs, with a fake localStorage: no browser, no
// network, no real user data.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const fixtures = require('./fixtures/git-remote/frames.json')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
function same(actual, expected, label) { assert.deepEqual(JSON.parse(JSON.stringify(actual ?? null)), expected, label); checks++ }
const alias = { '@shared': path.join(root, 'src/shared') }

class FakeStorage {
  constructor(map = new Map()) { this.map = map; this.blocked = false }
  get length() { return this.map.size }
  key(i) { return [...this.map.keys()][i] ?? null }
  getItem(k) { if (this.blocked) throw new Error('blocked'); return this.map.has(k) ? this.map.get(k) : null }
  setItem(k, v) { if (this.blocked) throw new Error('blocked'); this.map.set(k, String(v)) }
  removeItem(k) { if (this.blocked) throw new Error('blocked'); this.map.delete(k) }
}

function load(contents, storage) {
  const code = buildSync({ stdin: { contents, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, alias, define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, setTimeout, clearTimeout, localStorage: storage, TextEncoder })
  return mod.exports
}

const entry = "export * from './src/mobile/src/lib/changes'; export * from './src/mobile/src/lib/notesStore'; export { clearMobileStorage } from './src/mobile/src/lib/mobileStorage'; export { parseRemoteClientMsg } from './src/shared/remote-protocol-schemas'; export { buildReviewNotesText } from './src/shared/review-notes-format'"
const pageDiff = load("export { pageDiff } from './src/main/remote/GitRemote'").pageDiff

// ---------------------------------------------------------------------------
// Status (FR-52).
// ---------------------------------------------------------------------------
function testStatus(m) {
  const frames = fixtures.status.frames
  let view = null
  for (const f of frames) view = m.mergeStatus(view, f.page, f.data, f.done)
  check(view.complete && view.pages === 3 && view.files.length === 6 && view.total === 6, 'three status pages join into the whole list of 6 entries')
  same(view.summary, { branch: 'feature/login', ahead: 2, behind: 1, added: 25, removed: 6, files: 5, approx: false, conflicts: 1, op: 'merge' }, 'the summary comes with every page')
  const again = m.mergeStatus(view, 0, frames[0].data, false)
  check(again.files.length === 2 && !again.complete, 'a new page 0 starts the list over')
  same(m.groupChanges(view.files).map((g) => [g.area, g.files.map((f) => f.path)]), [['conflict', ['conflict.txt']], ['staged', ['src/app.ts', 'src/new name.ts']], ['unstaged', ['src/app.ts', 'img/logo.png']], ['untracked', ['notes/ñandú.md']]], 'sections in order: Conflicts, Staged, Not staged, Untracked')
  same(m.groupChanges(frames[0].data.files).map((g) => g.area), ['staged', 'unstaged'], 'empty sections are left out')
  same(view.files.map(m.statusBadge), ['M', 'M', 'R', 'M', 'U', '?'], 'badges M / R / U / ?')
  same([m.statusBadge({ status: 'C' }), m.statusBadge({ status: 'T' }), m.statusBadge({ status: 'D' }), m.statusBadge({ status: 'A' })], ['R', 'M', 'D', 'A'], 'a copy reads R, a type change M')
  const ordered = m.orderedFiles(view.files)
  same(m.nextFile(view.files, { path: 'conflict.txt', area: 'conflict' })?.path, 'src/app.ts', '"Next file" walks the list order')
  same(m.nextFile(view.files, { path: 'src/app.ts', area: 'staged' }), { path: 'src/new name.ts', area: 'staged', status: 'R', added: 0, removed: 0, binary: false, oldPath: 'src/old name.ts' }, 'the same path in another area is a different entry')
  check(m.nextFile(view.files, ordered.at(-1)) === null && m.nextFile(view.files, { path: 'gone.ts', area: 'unstaged' }) === null, 'none after the last one or for a file that left the list')
  same(m.diffTargetOf(ordered[1]), { path: 'src/app.ts', area: 'staged', staged: true }, 'a staged entry reads the index')
  same(m.diffTargetOf(view.files.find((f) => f.status === 'R')), { path: 'src/new name.ts', area: 'staged', staged: true, oldPath: 'src/old name.ts' }, 'a rename keeps its old path')
  same([m.baseName('src/a/b.ts'), m.dirName('src/a/b.ts'), m.baseName('README'), m.dirName('README')], ['b.ts', 'src/a/', 'README', ''], 'base and folder names')
  same([m.statusErrorKey('not_repo'), m.statusErrorKey('git_missing'), m.statusErrorKey('unsafe_repo'), m.statusErrorKey('weird')], ['changes.notRepo', 'changes.err.gitMissing', 'changes.err.unsafeRepo', 'changes.err.generic'], 'error messages, not_repo the FR-52 empty state')

  const out = (f) => m.gitOutcome({ ok: true, value: { ok: f.ok, data: f.data, page: f.page, done: f.done } })
  same(fixtures.errors.map((f) => out(f)), [{ kind: 'error', error: 'not_found' }, { kind: 'noReply' }, { kind: 'noReply' }, { kind: 'error', error: 'not_repo' }], "main's rate and timeout read as \"The PC did not answer\", the rest as errors")
  same(m.gitOutcome({ ok: false, error: 'timeout' }), { kind: 'noReply' }, 'no answer in 10s: no reply')
  same(m.gitOutcome({ ok: false, error: 'offline' }), { kind: 'noReply' }, 'offline: no reply')
  same(out(fixtures.statusClean).kind, 'data', 'a clean repo is data with no files')
}

// ---------------------------------------------------------------------------
// Diff paging (FR-53).
// ---------------------------------------------------------------------------
function readAll(m, frames, mutate = (f) => f) {
  let load = m.emptyDiffLoad()
  let asked = 0
  const log = []
  while (!load.done && asked < 20) {
    const f = mutate(frames[Math.min(load.nextPage, frames.length - 1)], asked)
    asked++
    log.push(load.nextPage)
    const step = m.applyDiffPage(load, load.nextPage, f.data, f.done)
    load = step.load
    if (step.unstable) return { load, log, unstable: true }
  }
  return { load, log, unstable: false }
}

function testDiff(m) {
  const frames = fixtures.diff.frames
  const { load, log } = readAll(m, frames)
  same(log, [0, 1, 2], 'pages 0, 1, 2 are asked for in order')
  check(load.done && load.hunks.length === 2, 'continued pieces join their hunk: 2 hunks, not 4')
  check(load.hunks[1].lines.length === 12 + 19 + 9 && load.hunks.every((h) => !('continued' in h)), 'every piece of the cut hunk is joined in order')
  same(load.head, { path: 'src/app.ts', area: 'unstaged', diffRev: frames[0].data.diffRev, binary: false }, 'the page head keeps path, area and diffRev')

  // Another diffRev on page 1: start over at page 0.
  const changed = (f, i) => (i === 1 ? { ...f, data: { ...f.data, diffRev: 'other' } } : f)
  let l = m.emptyDiffLoad()
  l = m.applyDiffPage(l, 0, frames[0].data, false).load
  const step = m.applyDiffPage(l, 1, changed(frames[1], 1).data, false)
  check(step.restart && step.load.nextPage === 0 && step.load.hunks.length === 0 && step.load.restarts === 1, 'a page with another diffRev drops what was read and restarts at page 0')
  const ok = readAll(m, frames, changed)
  same(ok.log, [0, 1, 0, 1, 2], 'the read starts over and finishes')
  const always = readAll(m, frames, (f, i) => (i % 2 ? { ...f, data: { ...f.data, diffRev: 'r' + i } } : f))
  check(always.unstable && always.load.restarts === m.DIFF_MAX_RESTARTS, `a file that keeps changing stops after ${m.DIFF_MAX_RESTARTS} restarts`)

  // 80% of the scroll asks for the next page.
  check(m.shouldPrefetch(800, 200, 1000) && !m.shouldPrefetch(500, 200, 1000) && m.shouldPrefetch(0, 600, 600), 'the next page goes at 80% of the scroll (or when the page does not fill the screen)')

  // A 120KB diff from GitRemote's own paging: 3 pages or more, read back whole.
  const lines = Array.from({ length: 1400 }, (_, i) => ({ kind: i % 3 === 0 ? 'del' : 'add', ...(i % 3 === 0 ? { oldNo: i + 1 } : { newNo: i + 1 }), text: `const value${i} = compute(${i}) // ${'x'.repeat(48)}` }))
  const big = { path: 'src/big.ts', area: 'unstaged', binary: false, diffRev: 'big1', totalLines: 1400, hunks: [{ header: '@@ -1,500 +1,900 @@', oldStart: 1, newStart: 1, lines: lines.slice(0, 700) }, { header: '@@ -900,500 +1300,900 @@', oldStart: 900, newStart: 1300, lines: lines.slice(700) }] }
  const rawBytes = Buffer.byteLength(JSON.stringify(big.hunks))
  const pages = pageDiff(big).map((data, i, all) => ({ data, page: i, done: i === all.length - 1 }))
  check(rawBytes > 120 * 1024 && pages.length >= 3, `a ${Math.round(rawBytes / 1024)}KB diff comes in ${pages.length} pages (3 or more)`)
  const back = readAll(m, pages).load
  check(back.hunks.length === 2 && back.hunks[0].lines.length === 700 && back.hunks[1].lines.length === 700, 'the phone joins the pages back into the 2 original hunks')
  same(back.hunks[1].lines.at(-1), lines.at(-1), 'down to the last line')

  // Binary and too large are one page without hunks.
  const bin = m.applyDiffPage(m.emptyDiffLoad(), 0, fixtures.diffBinary.data, true).load
  const tl = m.applyDiffPage(m.emptyDiffLoad(), 0, fixtures.diffTooLarge.data, true).load
  check(bin.head.binary && bin.done && tl.head.tooLarge.lines === 18000 && tl.hunks.length === 0, 'binary and too large: one page, no hunks, the line count kept')

  // Rows (FR-53): the new number, the old one on a deleted line; notes only on new-side lines.
  const rows = m.diffRows(load.hunks)
  const hunkRows = rows.filter((r) => r.kind === 'hunk')
  check(hunkRows.length === 2 && rows[0].kind === 'hunk' && rows[0].header.startsWith('@@ -10,6 +10,7 @@'), 'one header row per hunk')
  const del = rows.find((r) => r.kind === 'line' && r.line.kind === 'del')
  const add = rows.find((r) => r.kind === 'line' && r.line.kind === 'add')
  const ctx = rows.find((r) => r.kind === 'line' && r.line.kind === 'ctx')
  check(del.no === 11 && del.noteLine === undefined, 'a deleted line shows its old number and takes no note')
  check(add.no === 11 && add.noteLine === 11 && ctx.no === 10 && ctx.noteLine === 10, 'added and context lines show the new number and take notes')
  check(add.hunkEnd === 14, 'the range stepper stops at the end of the hunk')
  same([m.linePrefix('add'), m.linePrefix('del'), m.linePrefix('ctx')], ['+', '-', ' '], '+/- prefixes')
  const side = m.newSideLines(load.hunks)
  check(side.get(12) === '    throw new NotFound(id)' && !side.has(0) && side.get(10) === '  const user = find(id)', 'new-side text by line number')
  return load
}

// ---------------------------------------------------------------------------
// Notes (FR-54, 55).
// ---------------------------------------------------------------------------
function testNotes(m, storage, diffLoad) {
  const S = m.useNotesStore.getState
  const KEY = 'snagentsos.remote.notes.w1'
  check(m.NOTES_PREFIX === 'snagentsos.remote.notes.', 'notes live under snagentsos.remote.notes.<workspaceId>')
  const side = m.newSideLines(diffLoad.hunks)
  const a = S().add('w1', { file: 'src/app.ts', line: 11, endLine: 13, lineText: side.get(11), comment: '  throw is better here  ' })
  const b = S().add('w1', { file: 'src/app.ts', line: 41, lineText: side.get(41), comment: 'name it' })
  const c = S().add('w1', { file: 'notes/ñandú.md', line: 2, lineText: 'x', comment: 'typo' })
  check(a && b && c && a.comment === 'throw is better here', 'notes are added (comment trimmed)')
  check(S().add('w1', { file: 'a.ts', line: 3, comment: '   ' }) === null && S().add('w1', { file: 'a.ts', line: 0, comment: 'x' }) === null, 'an empty comment or a line 0 is refused')
  const stored = JSON.parse(storage.getItem(KEY))
  check(stored.v === 1 && Object.keys(stored.files).sort().join() === 'notes/ñandú.md,src/app.ts' && stored.files['src/app.ts'].length === 2 && !('file' in stored.files['src/app.ts'][0]), 'one key per workspace, the notes keyed by path')
  check(S().add('w1', { file: 'a.ts', line: 1, comment: 'y'.repeat(5000) }).comment.length === 4000, 'a comment is cut to 4000 characters')
  S().remove('w1', [S().byWs.w1.at(-1).id])

  // A reload of the page: a fresh module over the same storage.
  const m2 = load(entry, storage)
  const reread = m2.useNotesStore.getState().ensure('w1')
  same(reread.map((n) => [n.file, m2.noteLines(n), n.comment]), [['src/app.ts', '11-13', 'throw is better here'], ['src/app.ts', '41', 'name it'], ['notes/ñandú.md', '2', 'typo']], 'notes survive a reload of the page')
  same(m2.useNotesStore.getState().ensure('w2'), [], 'another workspace has its own key')

  // Outdated against the diff read.
  S().refreshStale('w1', 'src/app.ts', side, true)
  check(S().byWs.w1.every((n) => !n.stale), 'notes whose line still reads the same are fresh')
  const edited = new Map(side)
  edited.set(11, '  if (user == null) {')
  S().refreshStale('w1', 'src/app.ts', edited, false)
  check(S().byWs.w1.find((n) => n.id === a.id).stale === true && !S().byWs.w1.find((n) => n.id === b.id).stale, 'the line changed: "Outdated"')
  const partial = new Map([[11, side.get(11)]])
  S().refreshStale('w1', 'src/app.ts', partial, false)
  check(!S().byWs.w1.find((n) => n.id === a.id).stale && !S().byWs.w1.find((n) => n.id === b.id).stale, 'a line not read yet is left as it was; the original text back makes it fresh')
  S().refreshStale('w1', 'src/app.ts', partial, true)
  check(S().byWs.w1.find((n) => n.id === b.id).stale === true, 'a line gone from a diff read to the end: "Outdated"')
  check(m.staleAgainst({ line: 5, lineText: 'x'.repeat(1000) }, new Map([[5, 'x'.repeat(1500)]]), true) === false, 'a long line compares on the 1000 characters kept')
  S().markGoneFiles('w1', new Set(['src/app.ts']))
  check(S().byWs.w1.find((n) => n.id === c.id).stale === true, 'a file that left the complete list: its notes are "Outdated"')
  check(JSON.parse(storage.getItem(KEY)).files['notes/ñandú.md'][0].stale === true, 'the flag is stored')

  // Edit, send, show sent.
  S().edit('w1', b.id, { comment: 'call it user', endLine: 43 })
  check(S().byWs.w1.find((n) => n.id === b.id).comment === 'call it user' && m.noteLines(S().byWs.w1.find((n) => n.id === b.id)) === '41-43', 'an edit changes comment and range')
  const pending = m.pendingNotes(S().byWs.w1)
  same(pending.map((n) => `${n.file}:${m.noteLines(n)}`), ['notes/ñandú.md:2', 'src/app.ts:11-13', 'src/app.ts:41-43'], 'pending notes in the order the batch prints them')
  S().markSent('w1', [a.id], 1000)
  check(S().byWs.w1.find((n) => n.id === a.id).sentAt === 1000 && m.pendingNotes(S().byWs.w1).length === 2, 'acked notes get sentAt and leave the pending list')
  S().edit('w1', a.id, { comment: 'again' })
  check(S().byWs.w1.find((n) => n.id === a.id).sentAt === undefined, 'editing a sent note makes it pending again')

  // The ctl: the fixture shape, the schema, sanitizing on the desktop side.
  const notes = [{ ...a, comment: 'throw is better here', endLine: 13 }]
  same(notes.map(m.toPayload), [fixtures.sendReviewNotes.action.notes[0]], 'a note becomes the fixture payload {file, lines, comment}')
  const batches = m.chunkNotes(S().byWs.w1)
  const frame = (batch, enter = false) => JSON.stringify({ v: 1, type: 'ctl', id: 'f'.repeat(16), action: { kind: 'sendReviewNotes', workspaceId: 'w1', paneId: 'p1', notes: batch.map(m.toPayload), enter } })
  check(batches.length === 1 && !!m.parseRemoteClientMsg(frame(batches[0])), 'the batch passes the ctl schema')
  const evil = m.buildReviewNotesText([{ file: 'a.ts', lines: '3', comment: 'x\u001b[201~rm -rf\u009b2J' }])
  check(!evil.includes('\u001b') && !evil.includes('\u009b') && evil.includes('User comment: "x'), 'a comment with ESC or U+009B is pasted without them (the shared format sanitizes)')

  // Batches: 50 notes, 32KB of text, the frame budget.
  const many = Array.from({ length: 120 }, (_, i) => ({ id: 'n' + i, file: `src/f${String(i).padStart(3, '0')}.ts`, line: i + 1, comment: 'c' + i, createdAt: i }))
  const cut = m.chunkNotes(many)
  check(cut.length === 3 && cut[0].length === 50 && cut[2].length === 20, '120 short notes: batches of 50, 50, 20')
  const heavy = Array.from({ length: 30 }, (_, i) => ({ id: 'h' + i, file: `src/h${String(i).padStart(2, '0')}.ts`, line: 1, comment: 'ñ'.repeat(4000), createdAt: i }))
  const hcut = m.chunkNotes(heavy)
  const textBytes = (b) => Buffer.byteLength(m.buildReviewNotesText(b.map(m.toPayload)))
  check(hcut.length > 1 && hcut.every((b) => textBytes(b) <= 32 * 1024 && Buffer.byteLength(frame(b)) <= 64 * 1024 && !!m.parseRemoteClientMsg(frame(b))), `30 notes of 4000 two-byte characters: ${hcut.length} batches, each <= 32KB of text and a valid frame under 64KB`)
  same(hcut.flat().map((n) => n.id), heavy.map((n) => n.id), 'no note is lost or reordered across batches')

  // Default console (FR-55).
  const snap = { workspaces: [{ id: 'w1', panes: [{ id: 's1', type: 'shell' }, { id: 'c1', type: 'claude' }, { id: 'x1', type: 'codex' }] }, { id: 'w2', panes: [{ id: 's2', type: 'shell' }] }, { id: 'w3', panes: [] }] }
  same(m.defaultNotesTarget(snap, 'w1', { c1: 10, x1: 20, s1: 99 }, {}, null), 'x1', 'the agent console viewed last in the workspace')
  same(m.defaultNotesTarget(snap, 'w1', { c1: 10, x1: 20 }, {}, 'c1'), 'c1', 'the console the phone shows now wins when it is an agent of that workspace')
  same(m.defaultNotesTarget(snap, 'w1', {}, {}, 's2'), 'c1', 'never seen: the first agent console')
  same(m.defaultNotesTarget(snap, 'w2', {}, {}, null), 's2', 'no agent: the first console')
  same(m.defaultNotesTarget(snap, 'w3', {}, {}, null), null, 'no consoles: none')

  // Unpair wipes them; blocked storage degrades.
  check(m.clearMobileStorage() >= 1 && storage.getItem(KEY) === null, 'unpair or revoke wipes the phone notes')
  S().forgetAll()
  check(S().ensure('w1').length === 0 && storage.getItem(KEY) === null, 'and forgetAll drops the copy in memory, so no later edit writes them back')

  // Repo files named like Object.prototype members are plain keys.
  for (const file of ['constructor', '__proto__', 'toString']) check(!!S().add('w7', { file, line: 1, comment: 'odd name ' + file }), `a note on a file named ${file} is stored`)
  const odd = load(entry, storage).readNotes('w7')
  same(odd.map((n) => [n.file, n.comment]), [['constructor', 'odd name constructor'], ['__proto__', 'odd name __proto__'], ['toString', 'odd name toString']], 'and read back after a reload')
  storage.removeItem('snagentsos.remote.notes.w7')
  storage.blocked = true
  const m3 = load(entry, storage)
  check(m3.readNotes('w1').length === 0 && !!m3.useNotesStore.getState().add('w1', { file: 'a.ts', line: 1, comment: 'kept in memory' }), 'blocked storage: notes still work for this page')
  storage.blocked = false
  storage.setItem('snagentsos.remote.notes.w9', '{"v":1,"files":{"a.ts":[{"id":"x","line":-1,"comment":"bad","createdAt":1},{"id":"y","line":2,"comment":"ok","createdAt":2,"endLine":1}]}}')
  same(m3.readNotes('w9').map((n) => [n.id, n.line, n.endLine ?? null]), [['y', 2, null]], 'bad stored entries are skipped and a backwards range dropped')
  storage.setItem('snagentsos.remote.notes.w8', 'not json')
  same(m3.readNotes('w8'), [], 'unreadable storage reads as no notes')
}

const storage = new FakeStorage()
const m = load(entry, storage)
testStatus(m)
const diffLoad = testDiff(m)
testNotes(m, storage, diffLoad)
console.log(`PASS: ${checks} mobile Changes checks (status, diff paging, notes)`)
