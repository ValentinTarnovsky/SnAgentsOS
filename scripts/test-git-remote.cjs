// Git API for the phone (E7-FR-22..26, R30-09a): the gitReq / sendReviewNotes
// schemas, the 48 KB paging of the change list and of a diff (hunks split with
// `continued`, one `diffRev` per read), GitRemote over a fake GitService and
// fake timers (snapshot per read, refresh once before not_found, timeouts,
// `remote` git priority), SessionManager's per-session limits through the real
// RemoteManager with a fake socket, the renderer executor of the
// `sendReviewNotes` ctl, and real repositories in temp. It also keeps the
// fixtures E3's Changes screen tests against (scripts/fixtures/git-remote/).
// Bundled with esbuild and run in a vm like test-git.cjs; nothing listens, no
// real user data is touched. UPDATE_FIXTURES=1 rewrites the fixture file.
const { build, buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
function same(actual, expected, label) { assert.deepEqual(JSON.parse(JSON.stringify(actual ?? null)), expected, label); checks++ }
const alias = { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws', 'qrcode'], alias }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, setTimeout, clearTimeout, setImmediate, setInterval, clearInterval, ...overrides })
  return mod.exports
}
const tick = () => new Promise((r) => setImmediate(r))
const FRAME_MAX = 48 * 1024
/** A gitRes frame exactly as SessionManager sends it, with the widest id the schema accepts. */
const frame = (reply, id = 'z'.repeat(64)) => JSON.stringify({ v: 1, type: 'gitRes', id, ...reply })
const frameBytes = (reply) => Buffer.byteLength(frame(reply), 'utf8')

// ---------------------------------------------------------------------------
// Schemas (E7 Design E "Zod").
// ---------------------------------------------------------------------------
function testSchemas() {
  const { parseRemoteClientMsg } = load('src/shared/remote-protocol-schemas.ts')
  const parse = (o) => parseRemoteClientMsg(JSON.stringify({ v: 1, ...o }))
  const req = (o) => parse({ type: 'gitReq', id: 'a1', workspaceId: 'w1', op: 'status', ...o })
  check(!!req({}) && !!req({ page: 0 }) && !!req({ page: 999 }), 'gitReq status parses, page 0..999')
  check(!!req({ op: 'diff', path: 'src/a b.ts', staged: true, page: 3 }), 'gitReq diff with path, staged and page parses')
  check(!!req({ op: 'diff' }), 'a diff without path still parses (answered not_found, no strike)')
  check(!req({ page: 1000 }) && !req({ page: -1 }) && !req({ page: 1.5 }) && !req({ page: '1' }), 'page out of range, negative, fractional or a string is refused')
  check(!req({ op: 'log' }) && !req({ path: 'x'.repeat(1025) }) && !req({ staged: 'yes' }), 'unknown op, a path over 1024 or a non boolean staged is refused')
  check(!!req({ id: 'A-z_09'.padEnd(64, 'x') }) && !req({ id: 'x'.repeat(65) }) && !req({ id: 'a"b' }) && !req({ id: '' }) && !req({ id: 'a b' }), 'the id is 1..64 of [A-Za-z0-9_-] (its JSON size is fixed)')
  check(!req({ workspaceId: undefined }), 'workspaceId is required')

  const note = (o = {}) => ({ file: 'src/a.ts', lines: '40-52', comment: 'use a Map', ...o })
  const ctl = (action) => parse({ type: 'ctl', id: 'c1', action: { kind: 'sendReviewNotes', workspaceId: 'w1', paneId: 'p1', enter: false, notes: [note()], ...action } })
  check(!!ctl({}) && !!ctl({ enter: true }), 'sendReviewNotes parses with inline notes')
  check(!!ctl({ notes: [note({ lines: '' }), note({ lines: '7' }), note({ lines: '12345678-87654321' })] }), "lines '' (file note), 'N' and 'a-b' up to 8 digits parse")
  check(!ctl({ notes: [note({ lines: 'abc' })] }) && !ctl({ notes: [note({ lines: '123456789' })] }) && !ctl({ notes: [note({ lines: '1-' })] }), 'malformed lines are refused')
  check(!ctl({ notes: [] }) && !!ctl({ notes: Array.from({ length: 50 }, () => note()) }) && !ctl({ notes: Array.from({ length: 51 }, () => note()) }), 'notes 1..50')
  check(!ctl({ notes: [note({ comment: '' })] }) && !!ctl({ notes: [note({ comment: 'x'.repeat(4000) })] }) && !ctl({ notes: [note({ comment: 'x'.repeat(4001) })] }), 'comment 1..4000')
  check(!ctl({ notes: [note({ file: '../etc/passwd' })] }) && !ctl({ notes: [note({ file: 'a/../../b' })] }) && !ctl({ notes: [note({ file: 'a\\..\\b' })] }), 'a file with a .. segment is refused')
  check(!ctl({ notes: [note({ file: 'C:\\x.ts' })] }) && !ctl({ notes: [note({ file: '/etc/x' })] }) && !ctl({ notes: [note({ file: '\\\\srv\\x' })] }), 'absolute, drive and UNC files are refused')
  check(!ctl({ notes: [note({ file: 'a\x1b[2J.ts' })] }) && !ctl({ notes: [note({ file: 'a\u009b.ts' })] }) && !ctl({ notes: [note({ file: 'a\u2028b' })] }) && !ctl({ notes: [note({ file: 'x'.repeat(1025) })] }), 'control characters or a file over 1024 are refused')
  check(!!ctl({ notes: [note({ file: '\u00f1 dir/x..y.ts' })] }), 'unicode and dots inside a name are fine')
  check(!ctl({ enter: undefined }) && !ctl({ paneId: undefined }), 'enter and paneId are required')
}

// ---------------------------------------------------------------------------
// Paging (FR-22, FR-23): frames <= 48 KB, continued hunks, one diffRev.
// ---------------------------------------------------------------------------
const GR = load('src/main/remote/GitRemote.ts')
const summary = { branch: 'main', ahead: 0, behind: 0, added: 10, removed: 2, files: 3, approx: false, conflicts: 0, op: null }
const entry = (p, area = 'untracked', o = {}) => ({ path: p, area, status: area === 'untracked' ? '?' : 'M', added: 1, removed: 0, binary: false, ...o })
const lineOf = (i, kind, tag = 'v') => ({ kind, ...(kind !== 'add' ? { oldNo: i } : {}), ...(kind !== 'del' ? { newNo: i } : {}), text: `${tag} line ${String(i).padStart(5, '0')} ${'x'.repeat(40)}` })
const bigDiff = (n) => ({ path: 'src/big.ts', area: 'unstaged', binary: false, diffRev: 'rev-1', totalLines: n + 1, hunks: [{ header: `@@ -1,${n / 2} +1,${n / 2} @@ fn()`, oldStart: 1, newStart: 1, lines: Array.from({ length: n }, (_, i) => lineOf(Math.floor(i / 2) + 1, i % 2 ? 'add' : 'del')) }] })

function testPaging() {
  check(GR.GIT_FRAME_MAX === FRAME_MAX, 'frame budget is 48 KB (CONTRATOS)')
  // 3000 untracked files.
  const files = Array.from({ length: 3000 }, (_, i) => entry(`assets/generated/file-${String(i).padStart(4, '0')}-${'n'.repeat(30)}.txt`))
  const pages = GR.pageChanges(summary, files, false)
  check(pages.length > 3, `3000 untracked: several pages (${pages.length})`)
  check(pages.every((d, i) => frameBytes({ ok: true, data: d, page: i, done: i === pages.length - 1 }) <= FRAME_MAX), 'every status frame, with a 64 char id, is <= 48 KB')
  check(pages.every((d, i) => i === pages.length - 1 || frameBytes({ ok: true, data: d, page: i, done: false }) > FRAME_MAX - 400), 'pages are filled close to the budget')
  same(pages.flatMap((d) => d.files.map((f) => f.path)), files.map((f) => f.path), 'pages keep every file once, in order')
  check(pages.every((d) => d.total === 3000 && d.truncated === false && d.summary.branch === 'main'), 'each page repeats the summary, total and truncated')
  same(GR.pageChanges(summary, [], true), [{ summary, total: 0, truncated: true, files: [] }], 'a clean repo is one page without files')

  // A 4000 line diff.
  const diff = bigDiff(4000)
  const dp = GR.pageDiff(diff)
  check(dp.length > 2, `a 4000 line diff: several pages (${dp.length})`)
  check(dp.every((d, i) => frameBytes({ ok: true, data: d, page: i, done: false }) <= FRAME_MAX), 'every diff frame is <= 48 KB')
  check(dp.every((d) => d.diffRev === 'rev-1' && d.path === 'src/big.ts' && d.area === 'unstaged' && d.binary === false), 'every page carries the same diffRev, path and area')
  check(!dp[0].hunks[0].continued && dp.slice(1).every((d) => d.hunks[0].continued === true && d.hunks[0].header === diff.hunks[0].header), 'a hunk cut at a page edge repeats its header with continued:true')
  same(dp.flatMap((d) => d.hunks.flatMap((h) => h.lines)), diff.hunks[0].lines, 'the pieces put back together are the whole hunk, line numbers intact')

  // Many small hunks: a hunk that does not fit starts on the next page whole.
  const small = { ...diff, hunks: Array.from({ length: 400 }, (_, k) => ({ header: `@@ -${k * 10 + 1},3 +${k * 10 + 1},3 @@`, oldStart: k * 10 + 1, newStart: k * 10 + 1, lines: [lineOf(k * 10 + 1, 'ctx'), lineOf(k * 10 + 2, 'del'), lineOf(k * 10 + 2, 'add')] })) }
  const sp = GR.pageDiff(small)
  check(sp.length > 1 && sp.every((d) => !d.hunks[0].continued) && sp.every((d, i) => frameBytes({ ok: true, data: d, page: i, done: false }) <= FRAME_MAX), 'small hunks never split: each page starts with a whole hunk')
  check(sp.reduce((n, d) => n + d.hunks.length, 0) === 400, 'every hunk is on exactly one page')

  // One minified line of 300 KB fits a page, cut and marked.
  const mini = { ...diff, hunks: [{ header: '@@ -1 +1 @@', oldStart: 1, newStart: 1, lines: [{ kind: 'del', oldNo: 1, text: 'a'.repeat(300 * 1024) }, { kind: 'add', newNo: 1, text: '\u65e5'.repeat(100 * 1024) }, { kind: 'add', newNo: 2, text: '\x01'.repeat(50 * 1024) }] }] }
  const mp = GR.pageDiff(mini)
  check(mp.every((d, i) => frameBytes({ ok: true, data: d, page: i, done: false }) <= FRAME_MAX), 'a 300 KB line, a 100k CJK line and escaped control bytes still frame <= 48 KB')
  const cut = mp.flatMap((d) => d.hunks.flatMap((h) => h.lines))
  check(cut.length === 3 && cut.every((l) => l.text.endsWith(GR.LINE_CUT_MARK) && Buffer.byteLength(JSON.stringify(l)) <= GR.LINE_MAX_BYTES), 'a huge line is cut to LINE_MAX_BYTES and marked')
  check(GR.clampLine({ kind: 'add', newNo: 1, text: '\u{1F600}'.repeat(5000) }).text.replace(GR.LINE_CUT_MARK, '').length % 2 === 0, 'the cut never splits a surrogate pair')
  same(GR.clampLine({ kind: 'ctx', oldNo: 1, newNo: 1, text: 'short' }), { kind: 'ctx', oldNo: 1, newNo: 1, text: 'short' }, 'a short line is untouched')

  same(GR.pageDiff({ path: 'img.png', area: 'unstaged', binary: true, diffRev: 'b', hunks: [], totalLines: 0 }), [{ path: 'img.png', area: 'unstaged', diffRev: 'b', binary: true, hunks: [] }], 'a binary diff is one page without hunks')
  same(GR.pageDiff({ path: 'big.log', oldPath: 'old.log', area: 'staged', binary: false, diffRev: 't', tooLarge: { lines: 9000, bytes: 900000 }, hunks: [], totalLines: 9000 }), [{ path: 'big.log', oldPath: 'old.log', area: 'staged', diffRev: 't', binary: false, tooLarge: { lines: 9000 }, hunks: [] }], 'too large: one page, tooLarge {lines} only (no bytes)')
  same(GR.remoteSummary({ repoRoot: 'C:\\secret', branch: null, detached: true, unborn: false, headShort: 'abc1234', upstream: null, ahead: 3, behind: 1, files: 2, added: 5, removed: 1, approx: true, staged: 1, unstaged: 1, untracked: 0, conflicts: 1, op: 'merge', truncated: false, updatedAt: 9 }), { branch: 'abc1234', ahead: 0, behind: 0, added: 5, removed: 1, files: 2, approx: true, conflicts: 1, op: 'merge' }, 'the phone summary: chip fields + approx/conflicts/op, short sha when detached, no repo root')
}

// ---------------------------------------------------------------------------
// GitRemote over a fake GitService.
// ---------------------------------------------------------------------------
function fakeWorld() {
  let now = 1_000_000
  let seq = 0
  const timers = []
  const t = {
    setTimeout: (fn, ms) => { const h = { at: now + ms, fn, id: seq++ }; timers.push(h); return h },
    clearTimeout: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1) },
  }
  const advance = async (ms) => {
    const end = now + ms
    for (;;) {
      await tick()
      timers.sort((a, b) => a.at - b.at || a.id - b.id)
      const next = timers[0]
      if (!next || next.at > end) break
      timers.shift()
      now = Math.max(now, next.at)
      next.fn()
    }
    now = end
    await tick()
  }
  const sum = (o = {}) => ({ repoRoot: 'C:\\fixture-secret-root', branch: 'main', detached: false, unborn: false, headShort: 'abc1234', upstream: 'origin/main', ahead: 1, behind: 0, files: 2, added: 3, removed: 1, approx: false, staged: 1, unstaged: 1, untracked: 0, conflicts: 0, op: null, truncated: false, updatedAt: 1, ...o })
  const state = { view: { summary: sum(), files: [entry('src/a.ts', 'unstaged'), entry('src/a.ts', 'staged')] }, refreshTo: null, hang: false }
  const calls = { ensure: [], hot: [], run: [] }
  const source = {
    get: (key) => (key === 'ws:w1' ? state.view : null),
    ensureFresh: (key, maxAge) => {
      calls.ensure.push([key, maxAge])
      if (state.hang) return new Promise(() => {})
      if (key !== 'ws:w1') return Promise.resolve(null)
      if (maxAge === 0 && state.refreshTo) { state.view = state.refreshTo; state.refreshTo = null }
      return Promise.resolve(state.view)
    },
    markHot: (key) => calls.hot.push(key),
  }
  const content = { 'src/a.ts': 'one' }
  const runner = {
    run: async (args, o) => {
      calls.run.push({ args, priority: o.priority })
      if (args.includes('--numstat')) return args.includes('--cached') ? '2\t0\tsrc/a.ts\0' : '1\t1\tsrc/a.ts\0'
      const file = args.at(-1)
      if (!(file in content)) return ''
      return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+${content[file]}\n`
    },
  }
  const remote = new GR.GitRemote({ source, runner, untrackedPeek: () => 4, now: () => now, timers: t, platform: 'win32', fs: { lstat: async () => ({ size: 4, isFile: () => true, isSymbolicLink: () => false, isDirectory: () => false }), readFile: async () => Buffer.from('new\n'), readlink: async () => '' } })
  return { remote, state, calls, content, sum, advance, setNow: (v) => { now = v }, get now() { return now } }
}

async function testGitRemote() {
  const w = fakeWorld()
  const status = await w.remote.handle({ workspaceId: 'w1', op: 'status' })
  check(status.ok && status.page === 0 && status.done === true, 'status answers one page, done')
  same(status.data.summary, { branch: 'main', ahead: 1, behind: 0, added: 3, removed: 1, files: 2, approx: false, conflicts: 0, op: null }, 'status summary is the chip plus approx, conflicts, op')
  same(status.data.files.map((f) => [f.area, f.added, f.removed]), [['unstaged', 1, 1], ['staged', 2, 0]], 'files carry their per-area +a -d')
  same(w.calls.ensure[0], ['ws:w1', 2000], 'a status refreshes when the cache is older than 2 s (FR-22)')
  same(w.calls.hot, ['ws:w1'], 'each gitReq marks its target hot (FR-06f)')
  check(w.calls.run.length > 0 && w.calls.run.every((c) => c.priority === 'remote'), 'git runs at remote priority (the desktop keeps its slot)')
  check(!frame(status).includes('fixture-secret-root'), 'the repo root never leaves main')
  same(await w.remote.handle({ workspaceId: 'nope', op: 'status' }), { ok: false, data: { error: 'not_found' }, page: 0, done: true }, 'a workspace without target: not_found')
  w.state.view = { summary: null, error: 'not_repo', files: [] }
  same((await w.remote.handle({ workspaceId: 'w1', op: 'status' })).data, { error: 'not_repo' }, 'the target error goes through (not_repo)')
  w.state.view = { summary: null, files: [] }
  same((await w.remote.handle({ workspaceId: 'w1', op: 'status' })).data, { error: 'git_error' }, 'no summary and no error: git_error')

  // A snapshot per read: a refresh between page 0 and page 1 never shifts entries.
  const many = Array.from({ length: 1500 }, (_, i) => entry(`f/${String(i).padStart(4, '0')}-${'q'.repeat(40)}.txt`))
  w.state.view = { summary: w.sum({ untracked: 1500 }), files: many }
  const p0 = await w.remote.handle({ workspaceId: 'w1', op: 'status', page: 0 })
  check(p0.ok && !p0.done && p0.data.total === 1500, 'a long list pages (page 0 not done)')
  w.state.view = { summary: w.sum(), files: [entry('zzz.txt'), ...many] }
  const p1 = await w.remote.handle({ workspaceId: 'w1', op: 'status', page: 1 })
  check(p1.data.total === 1500 && p1.data.files[0].path === many[p0.data.files.length].path, 'page 1 comes from the same snapshot as page 0')
  const ensures = w.calls.ensure.length
  let last = p1
  for (let n = 2; !last.done; n++) last = await w.remote.handle({ workspaceId: 'w1', op: 'status', page: n })
  check(w.calls.ensure.length === ensures, 'later pages never refresh')
  const past = await w.remote.handle({ workspaceId: 'w1', op: 'status', page: 400 })
  check(past.ok && past.done && past.page === 400 && past.data.files.length === 0, 'a page past the end is empty and done')
  const again = await w.remote.handle({ workspaceId: 'w1', op: 'status', page: 0 })
  check(again.data.total === 1501, 'a new page 0 takes a new snapshot')
  await w.advance(61000)
  const stale = await w.remote.handle({ workspaceId: 'w1', op: 'status', page: 1 })
  check(stale.ok && w.calls.ensure.length === ensures + 2, 'a snapshot older than 60 s is rebuilt even for page 1')

  // Diff: area choice, cache per read, invalidation by a refresh, refresh once before not_found.
  const files = [entry('src/a.ts', 'unstaged'), entry('src/a.ts', 'staged'), entry('only-staged.ts', 'staged')]
  w.state.view = { summary: w.sum(), files }
  const d0 = await w.remote.handle({ workspaceId: 'w1', op: 'diff', path: 'src/a.ts', page: 0 })
  check(d0.ok && d0.done && d0.data.area === 'unstaged' && d0.data.hunks[0].lines.at(-1).text === 'one', 'without staged the diff is the working tree one')
  const lastRun = w.calls.run.at(-1)
  check(!lastRun.args.includes('--cached') && lastRun.args.includes('--no-ext-diff') && lastRun.args.includes('--no-textconv') && lastRun.priority === 'remote', 'working tree diff: no --cached, no external diff or textconv, remote priority')
  const ds = await w.remote.handle({ workspaceId: 'w1', op: 'diff', path: 'src/a.ts', staged: true })
  check(ds.ok && ds.data.area === 'staged' && w.calls.run.at(-1).args.includes('--cached'), 'staged:true reads the index (--cached)')
  same((await w.remote.handle({ workspaceId: 'w1', op: 'diff', path: 'only-staged.ts' })).data, { error: 'not_found' }, 'a staged-only file has no working tree diff: not_found')
  const runs = w.calls.run.length
  const d1 = await w.remote.handle({ workspaceId: 'w1', op: 'diff', path: 'src/a.ts', page: 0 })
  check(w.calls.run.length === runs && d1.data.diffRev === d0.data.diffRev, 'page 0 again within 2 s and no refresh: served from the cache')
  w.content['src/a.ts'] = 'two'
  const d2 = await w.remote.handle({ workspaceId: 'w1', op: 'diff', path: 'src/a.ts', page: 1 })
  check(w.calls.run.length === runs && d2.data.diffRev === d0.data.diffRev && d2.done, 'without a refresh the read stays on its version')
  w.state.view = { summary: w.sum(), files: [...files] }
  const d3 = await w.remote.handle({ workspaceId: 'w1', op: 'diff', path: 'src/a.ts', page: 1 })
  check(w.calls.run.length === runs + 1 && d3.data.diffRev !== d0.data.diffRev, 'a refresh that sees the file changed gives the next page another diffRev')
  w.state.view = { summary: w.sum(), files: [...files] }
  const d4 = await w.remote.handle({ workspaceId: 'w1', op: 'diff', path: 'src/a.ts', page: 1 })
  check(d4.data.diffRev === d3.data.diffRev, 'a refresh with the file unchanged keeps the diffRev')
  w.setNow(w.now + 3000)
  await w.remote.handle({ workspaceId: 'w1', op: 'diff', path: 'src/a.ts', page: 0 })
  check(w.calls.run.length === runs + 3, 'page 0 older than 2 s reads the diff again')

  const newFile = entry('brand-new.ts', 'untracked')
  w.state.refreshTo = { summary: w.sum(), files: [...files, newFile] }
  const nf = await w.remote.handle({ workspaceId: 'w1', op: 'diff', path: 'brand-new.ts' })
  check(nf.ok && nf.data.area === 'untracked' && nf.data.hunks[0].lines[0].text === 'new', 'a file newer than the cached list is found after one refresh (no not_found)')
  check(w.calls.ensure.at(-1)[1] === 0, 'that refresh asks for a run newer than the request')
  const ensures2 = w.calls.ensure.length
  same(await w.remote.handle({ workspaceId: 'w1', op: 'diff', path: 'invented.ts' }), { ok: false, data: { error: 'not_found' }, page: 0, done: true }, 'an invented path: not_found')
  check(w.calls.ensure.length === ensures2 + 1, 'after exactly one refresh')
  same((await w.remote.handle({ workspaceId: 'w1', op: 'diff', path: '../outside.ts' })).data, { error: 'not_found' }, 'a path outside the list (traversal) is not_found')
  same((await w.remote.handle({ workspaceId: 'w1', op: 'diff' })).data, { error: 'not_found' }, 'a diff without path is not_found')
  w.content['src/a.ts'] = undefined
  delete w.content['src/a.ts']
  w.state.view = { summary: w.sum(), files: [...files] }
  const ensures3 = w.calls.ensure.length
  same((await w.remote.handle({ workspaceId: 'w1', op: 'diff', path: 'src/a.ts' })).data, { error: 'not_found' }, 'a listed file whose diff is gone answers not_found')
  check(w.calls.ensure.length === ensures3 + 1 && w.calls.ensure.at(-1)[1] === 0, 'after exactly one refresh')
  // Stale list: the file is listed unstaged, but by now its change is an untracked copy.
  w.state.view = { summary: w.sum(), files: [entry('moved.ts', 'unstaged')] }
  w.state.refreshTo = { summary: w.sum(), files: [entry('moved.ts', 'untracked')] }
  const mv = await w.remote.handle({ workspaceId: 'w1', op: 'diff', path: 'moved.ts' })
  check(mv.ok && mv.data.area === 'untracked' && mv.data.hunks[0].lines[0].text === 'new', 'a stale entry whose diff is gone refreshes once and reads the area it is in now')

  // Timeouts (FR-26): git 10 s, diff 15 s.
  const t = fakeWorld()
  t.state.hang = true
  let out = null
  t.remote.handle({ workspaceId: 'w1', op: 'status' }).then((r) => { out = r })
  await t.advance(9999)
  check(out === null, 'a status still waiting at 9.999 s has no answer yet')
  await t.advance(1)
  same(out, { ok: false, data: { error: 'timeout' }, page: 0, done: true }, 'status answers timeout at 10 s')
  t.state.hang = false
  t.state.view = { summary: t.sum(), files: [entry('slow.ts', 'unstaged')] }
  const slowRunner = t.remote
  // A diff whose git never returns.
  const hangRemote = new GR.GitRemote({ source: { get: () => t.state.view, ensureFresh: async () => t.state.view, markHot() {} }, runner: { run: () => new Promise(() => {}) }, untrackedPeek: () => undefined, now: () => t.now, timers: { setTimeout: (fn, ms) => { hangTimers.push({ fn, ms }); return hangTimers.length }, clearTimeout() {} } })
  const hangTimers = []
  out = null
  hangRemote.handle({ workspaceId: 'w1', op: 'diff', path: 'slow.ts' }).then((r) => { out = r })
  await tick()
  check(hangTimers.length === 1 && hangTimers[0].ms === 15000, 'a diff is given 15 s')
  hangTimers[0].fn()
  await tick()
  same(out?.data, { error: 'timeout' }, 'and then answers timeout')
  check(t.remote.backlog() === 1, 'a timed out read whose git never returns still counts as running')
  const after = await slowRunner.handle({ workspaceId: 'w1', op: 'status' })
  check(after.ok && after.data.files.length === 1 && t.remote.backlog() === 1, 'the service keeps answering after a timeout')
  // Backlog across sessions (git has no cancel): past GIT_REMOTE_BACKLOG_MAX running reads, rate.
  check(GR.GIT_REMOTE_BACKLOG_MAX === 4, 'at most 4 phone reads running at once')
  for (let i = 0; i < 3; i++) void hangRemote.handle({ workspaceId: 'w1', op: 'diff', path: 'slow.ts' })
  await tick()
  check(hangRemote.backlog() === 4, '4 hung reads are running')
  same(await hangRemote.handle({ workspaceId: 'w1', op: 'diff', path: 'slow.ts' }), { ok: false, data: { error: 'rate' }, page: 0, done: true }, 'the 5th answers rate at once, without touching git')
  check(hangTimers.length === 4, 'the refused read started no timer')
}

// ---------------------------------------------------------------------------
// SessionManager limits through the real RemoteManager (FR-26).
// ---------------------------------------------------------------------------
async function testSessionLimits() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-gitremote-'))
  const stubs = {
    name: 'stubs',
    setup(b) {
      b.onResolve({ filter: /\/RemoteServer$/ }, () => ({ path: 'RemoteServer', namespace: 'stub' }))
      b.onResolve({ filter: /^\.\.\/paths$/ }, () => ({ path: 'paths', namespace: 'stub' }))
      b.onLoad({ filter: /^RemoteServer$/, namespace: 'stub' }, () => ({ loader: 'ts', contents: 'export class RemoteServer { constructor(port: number, handlers: any) { (globalThis as any).__server = { port, handlers } } start() { return Promise.resolve() } close() {} }' }))
      b.onLoad({ filter: /^paths$/, namespace: 'stub' }, () => ({ loader: 'ts', contents: `export function dataDir() { return ${JSON.stringify(dataDir)} }` }))
    },
  }
  const code = (await build({
    stdin: { resolveDir: root, loader: 'ts', contents: "export { RemoteManager } from './src/main/remote/RemoteManager'\nexport { GIT_REQ_MAX, GIT_REQ_WINDOW_MS, GIT_REQ_IN_FLIGHT } from './src/main/remote/SessionManager'" },
    bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws', 'qrcode'], plugins: [stubs], alias,
  })).outputFiles[0].text
  let clock = 0
  class FakeDate extends Date { static now() { return 1700000000000 + clock } }
  const noop = () => ({ unref() {}, ref() {} })
  const ctx = { module: { exports: {} }, require: (id) => (id === 'qrcode' ? { toDataURL: async () => 'data:' } : require(id)), console, process, Buffer, URL, queueMicrotask, setTimeout: noop, clearTimeout() {}, setInterval: noop, clearInterval() {}, Date: FakeDate }
  ctx.exports = ctx.module.exports
  ctx.globalThis = ctx
  vm.runInNewContext(code, ctx)
  const api = ctx.module.exports
  check(api.GIT_REQ_MAX === 10 && api.GIT_REQ_WINDOW_MS === 5000 && api.GIT_REQ_IN_FLIGHT === 2, 'limits: 10 gitReq per 5 s, 2 in flight (FR-26)')
  const commands = []
  const pty = { addSink() {}, removeSink() {}, setRunningChangeListener() {}, setForcedFast() {}, runningPaneIds: () => [], exitedPaneCodes: () => new Map(), getReplay: () => null, getExited: () => null, ptyIdForPane: () => null, write() {} }
  const webContents = { isDestroyed: () => false, setBackgroundThrottling() {}, send: (ch, cmd) => { if (ch === 'remote:controlCmd') commands.push(cmd) } }
  const manager = new api.RemoteManager(pty, () => webContents, '2.0.0', () => [], () => 'PC')
  manager.applyConfig({ enabled: true, port: 4600 })
  manager.pushState({ workspaces: [], activeWorkspaceId: null, themeTokens: {}, language: 'en', fontFamily: '', fontSize: 14 })
  class FakeSocket {
    constructor() { this.readyState = 1; this.bufferedAmount = 0; this.inbox = []; this.handlers = {}; this.closed = null }
    on(ev, fn) { this.handlers[ev] = fn }
    send(data) { this.inbox.push(JSON.parse(data)) }
    close(c) { this.closed = c; this.readyState = 3; this.handlers.close && this.handlers.close() }
    terminate() { this.close(1006) }
    msg(obj) { this.handlers.message(JSON.stringify({ v: 1, ...obj })) }
    of(type) { return this.inbox.filter((m) => m.type === type) }
  }
  await tick()
  const pair = async () => {
    const payload = await manager.pairingBegin()
    const ws = new FakeSocket()
    ctx.__server.handlers.onSocket(ws, '100.64.0.9', '100.64.0.9')
    ws.msg({ type: 'hello', clientNonce: 'aa'.repeat(32) })
    ws.msg({ type: 'pair', code: payload.code, deviceName: 'Phone' })
    manager.pairingResolve(manager.getUiState().pendingPairing.requestId, true)
    return ws
  }
  const ws = await pair()
  check(ws.of('authOk').length === 1, 'a paired phone is authenticated')
  const git = (id, o = {}) => ws.msg({ type: 'gitReq', id, workspaceId: 'w1', op: 'status', ...o })

  // No git service: every gitReq answers not_found.
  git('n0')
  await tick()
  same(ws.of('gitRes').at(-1), { v: 1, type: 'gitRes', id: 'n0', ok: false, data: { error: 'not_found' }, page: 0, done: true }, 'without a git handler: gitRes not_found with the same id')

  // A handler that answers at once: 10 per 5 s, the 11th is rate, the socket lives.
  const seen = []
  // The status lists src/a.ts, so the diff below is one the session was shown (E3-FR-56).
  manager.setGitHandler(async (req) => { seen.push(req); return { ok: true, data: { summary: { branch: 'main', ahead: 0, behind: 0, added: 0, removed: 0, files: 1, approx: false, conflicts: 0, op: null }, files: [entry('src/a.ts', 'staged')], total: 1, truncated: false }, page: req.page ?? 0, done: true } })
  clock += 6000
  const before = ws.of('gitRes').length
  for (let i = 1; i <= 9; i++) { git('g' + i, { page: 0 }); await tick() }
  git('g10', { op: 'diff', path: 'src/a.ts', staged: true, page: 2 })
  await tick()
  git('g11')
  await tick()
  const res = ws.of('gitRes').slice(before)
  check(res.length === 11 && res.slice(0, 10).every((r) => r.ok) && res[10].id === 'g11', '10 gitReq in 5 s are answered')
  same(res[10], { v: 1, type: 'gitRes', id: 'g11', ok: false, data: { error: 'rate' }, page: 0, done: true }, 'the 11th in less than 5 s answers gitRes rate')
  check(ws.closed === null && !ws.inbox.some((m) => m.type === 'err'), 'no err, no strike, the socket stays open')
  same(seen.at(-1), { workspaceId: 'w1', op: 'diff', path: 'src/a.ts', staged: true, page: 2 }, 'the handler gets the request without the envelope')
  check(seen.length === 10, 'a refused gitReq never reaches git')
  clock += 5001
  git('g12')
  await tick()
  check(ws.of('gitRes').at(-1).id === 'g12' && ws.of('gitRes').at(-1).ok, '5 s later the window has room again')

  // In flight: a third request while two wait on git is rate.
  clock += 6000
  const waiting = []
  manager.setGitHandler((req) => new Promise((resolve) => waiting.push(() => resolve({ ok: true, data: { error: 'x' }, page: 0, done: true }))))
  const mark = ws.of('gitRes').length
  git('f1'); git('f2'); git('f3')
  await tick()
  same(ws.of('gitRes').slice(mark).map((r) => [r.id, r.data.error]), [['f3', 'rate']], 'a third gitReq in flight answers rate at once')
  waiting.shift()()
  await tick()
  git('f4')
  await tick()
  same(ws.of('gitRes').slice(mark).map((r) => r.id), ['f3', 'f1'], 'an answered one frees its slot')
  check(waiting.length === 2, 'and the next one is in flight')
  waiting.forEach((f) => f())
  await tick()
  manager.setGitHandler(async () => { throw new Error('boom') })
  clock += 6000
  git('e1')
  await tick()
  same(ws.of('gitRes').at(-1).data, { error: 'git_error' }, 'a throwing handler answers git_error')

  // Another session has its own window.
  manager.setGitHandler(async () => ({ ok: true, data: { error: 'x' }, page: 0, done: true }))
  for (let i = 0; i < 12; i++) { git('s' + i); await tick() }
  const other = await pair()
  other.msg({ type: 'gitReq', id: 'o1', workspaceId: 'w1', op: 'status' })
  await tick()
  check(other.of('gitRes').at(-1).ok, 'a second phone is not limited by the first one')
  // A malformed gitReq is a bad_msg strike like any other frame.
  other.msg({ type: 'gitReq', id: 'bad"id', workspaceId: 'w1', op: 'status' })
  check(other.of('err').at(-1)?.code === 'bad_msg', 'a malformed gitReq is bad_msg')

  // sendReviewNotes is relayed to the renderer with its notes inline.
  const notes = [{ file: 'src/a.ts', lines: '3', comment: 'rename this' }]
  other.msg({ type: 'ctl', id: 'n1', action: { kind: 'sendReviewNotes', workspaceId: 'w1', paneId: 'p1', notes, enter: false } })
  same(commands.at(-1).action, { kind: 'sendReviewNotes', workspaceId: 'w1', paneId: 'p1', notes, enter: false }, 'the ctl reaches the renderer with its notes inline')
  manager.onControlResult({ id: commands.at(-1).id, ok: true, info: 1 })
  await tick()
  same(other.of('ctlAck').at(-1), { v: 1, type: 'ctlAck', id: 'n1', ok: true, info: 1 }, 'ctlAck info = notes sent')

  // E3-FR-56 (R30-09b): a diff only of a path the session's last status listed.
  const asked = []
  const statusPages = [[entry('src/a.ts'), entry('docs/b.md')], [entry('src/c.ts')]]
  manager.setGitHandler(async (req) => {
    asked.push(req)
    if (req.op === 'diff') return { ok: true, data: { path: req.path, area: 'untracked', diffRev: 'r1', binary: false, hunks: [] }, page: 0, done: true }
    const page = req.page ?? 0
    return { ok: true, data: { summary, files: statusPages[page] ?? [], total: 3, truncated: false }, page, done: page >= statusPages.length - 1 }
  })
  clock += 6000
  const phone = await pair()
  const preq = (id, o) => { phone.msg({ type: 'gitReq', id, workspaceId: 'w1', ...o }); return tick().then(() => phone.of('gitRes').find((r) => r.id === id)) }
  same((await preq('d0', { op: 'diff', path: 'src/a.ts' })).data, { error: 'not_found' }, 'FR-56: before any status, a diff answers not_found')
  check(asked.length === 0, 'FR-56: and never reaches git')
  await preq('s0', { op: 'status' })
  check((await preq('d1', { op: 'diff', path: 'src/a.ts' })).ok, 'FR-56: a path listed on status page 0 opens its diff')
  same(await preq('d2', { op: 'diff', path: '../../secreto.txt' }), { v: 1, type: 'gitRes', id: 'd2', ok: false, data: { error: 'not_found' }, page: 0, done: true }, 'FR-56: ../../secreto.txt answers gitRes not_found')
  same((await preq('d3', { op: 'diff', path: 'src/c.ts' })).data, { error: 'not_found' }, 'FR-56: a path of a status page not read yet is not_found')
  same(asked.map((r) => r.path ?? r.op), ['status', 'src/a.ts'], 'FR-56: the refused diffs never reached git')
  clock += 6000
  await preq('s1', { op: 'status', page: 1 })
  check((await preq('d4', { op: 'diff', path: 'src/c.ts' })).ok && (await preq('d5', { op: 'diff', path: 'docs/b.md', staged: true })).ok, 'FR-56: a later status page adds its paths to the same set')
  same((await preq('d6', { workspaceId: 'w2', op: 'diff', path: 'src/a.ts' })).data, { error: 'not_found' }, 'FR-56: the set is per workspace')
  clock += 6000
  statusPages.splice(0, 2, [entry('src/new.ts')])
  await preq('s2', { op: 'status' })
  same((await preq('d8', { op: 'diff', path: 'src/c.ts' })).data, { error: 'not_found' }, 'FR-56: a new status page 0 starts the set over')
  check((await preq('d9', { op: 'diff', path: 'src/new.ts' })).ok, 'FR-56: with the paths of the new list')
  manager.setGitHandler(async () => ({ ok: false, data: { error: 'timeout' }, page: 0, done: true }))
  await preq('s3', { op: 'status' })
  manager.setGitHandler(async (req) => ({ ok: true, data: { path: req.path, area: 'untracked', diffRev: 'r2', binary: false, hunks: [] }, page: 0, done: true }))
  check((await preq('d10', { op: 'diff', path: 'src/new.ts' })).ok, 'FR-56: a status that failed keeps the list the phone still shows')
  clock += 6000
  other.msg({ type: 'gitReq', id: 'od', workspaceId: 'w1', op: 'diff', path: 'src/new.ts' })
  await tick()
  same(other.of('gitRes').at(-1).data, { error: 'not_found' }, 'FR-56: another session has its own set')
  manager.applyConfig({ enabled: false, port: 4600 })
  fs.rmSync(dataDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Renderer executor of the sendReviewNotes ctl (FR-24, FR-25).
// ---------------------------------------------------------------------------
async function testExecutor() {
  const writes = [], pastes = [], marks = [], results = []
  let onCmd = null
  const snApi = {
    platform: 'win32',
    pty: { write: (w) => writes.push(w), kill: async () => {}, killPanes: async () => 0 },
    reviewNotes: { list: async () => ({ notes: [], rev: 0 }), markSent: async (r) => { marks.push(r) }, delete: async () => {}, prune() {}, onChanged: () => () => {} },
    remote: { onCommand: (cb) => { onCmd = cb; return () => {} }, commandResult: (r) => results.push(r) },
    window: { reveal() {} },
    config: { save() {} },
  }
  const entry = [
    "export { initRemoteCommands } from './src/renderer/lib/remoteCommands'",
    "export { useAppStore } from './src/renderer/lib/store'",
    "export { useReviewNotesStore } from './src/renderer/lib/reviewNotesStore'",
    "export { registerPty } from './src/renderer/lib/ptyRegistry'",
    "export { registerPaster } from './src/renderer/lib/pasteRegistry'",
  ].join('\n')
  const code = buildSync({ stdin: { contents: entry, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, alias, define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, window: { snApi }, document: { hasFocus: () => false }, setTimeout, clearTimeout, crypto: globalThis.crypto })
  const R = mod.exports
  const pane = (id, type) => ({ id, type, title: id, color: '#fff', icon: 'bot' })
  R.useAppStore.setState({ workspaces: [{ id: 'w1', name: 'A', cwd: 'C:\\repo', panes: [pane('claude', 'claude'), pane('plain', 'shell'), pane('safe', 'shell')] }], activeWorkspaceId: 'w1', paneStatus: { claude: { state: 'idle', precise: true, provider: 'claude' } } })
  const brackets = { claude: true, plain: false, safe: true }
  for (const id of Object.keys(brackets)) {
    R.registerPty(id, `pty-${id}`)
    R.registerPaster(id, { paste: (t) => pastes.push([id, t]), bracketed: () => brackets[id] })
  }
  R.initRemoteCommands()
  const send = (id, action) => { onCmd({ id, action: { kind: 'sendReviewNotes', workspaceId: 'w1', enter: false, ...action } }); return results.at(-1) }
  const notes = [{ file: 'src/b.ts', lines: '7-9', comment: 'say "why"' }]
  same(send('x1', { paneId: 'claude', notes }), { id: 'x1', ok: true, info: 1 }, '1 note with enter:false: ok, ctlAck info=1')
  same(pastes, [['claude', 'File: src/b.ts\nLines: 7-9\nUser comment: "say \\"why\\""']], 'pasted once, in the shared format')
  await new Promise((r) => setTimeout(r, 260))
  check(writes.length === 0, 'enter:false never writes a CR')
  check(marks.length === 0 && R.useReviewNotesStore.getState().notes.w1 === undefined, 'phone notes are not stored or marked on the desktop (FR-24)')
  pastes.length = 0
  same(send('x2', { paneId: 'plain', notes }), { id: 'x2', ok: false, error: 'not_agent' }, 'a plain console: not_agent')
  same(send('x3', { paneId: 'safe', notes, enter: true }), { id: 'x3', ok: false, error: 'not_agent' }, 'enter:true to a console that is not an agent: not_agent')
  same(send('x4', { paneId: 'ghost', notes }), { id: 'x4', ok: false, error: 'not_found' }, 'an unknown pane: not_found')
  same(send('x5', { paneId: 'claude', notes: Array.from({ length: 9 }, (_, i) => ({ file: 'a.ts', lines: String(i + 1), comment: 'x'.repeat(4000) })) }), { id: 'x5', ok: false, error: 'too_large' }, 'over 32 KB of text: too_large')
  check(pastes.length === 0 && writes.length === 0, 'refused sends write nothing')
  same(send('x6', { paneId: 'claude', notes: [{ file: 'a\x1b[201~.ts', lines: '', comment: 'evil \x1b[201~ \x03' }] }), { id: 'x6', ok: true, info: 1 }, 'a note with escape sequences is sent')
  check(!pastes[0][1].includes('\x1b') && !pastes[0][1].includes('\x03') && pastes[0][1].includes('\u241b'), 'sanitized: ESC becomes U+241B, C0 becomes U+FFFD')
  pastes.length = 0
  same(send('x7', { paneId: 'claude', notes, enter: true }), { id: 'x7', ok: true, info: 1 }, 'enter:true to an agent')
  await new Promise((r) => setTimeout(r, 260))
  same(writes, [{ ptyId: 'pty-claude', data: '\r' }], 'then exactly one CR after submitDelayFor')
}

// ---------------------------------------------------------------------------
// Real repositories (FR-22, FR-23 acceptance) and the fixtures for E3.
// ---------------------------------------------------------------------------
async function testRealRepos() {
  let gitOk = true
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }) } catch { gitOk = false }
  if (!gitOk) { console.log('SKIP: git not on PATH, real repository checks skipped'); return }
  const gx = load('src/main/git/gitExec.ts')
  const { GitService } = load('src/main/git/GitService.ts')
  const { UntrackedCounter } = load('src/main/git/untrackedLines.ts')
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'snaos-gitremote-'))
  const cleanEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(base, 'gitconfig') }
  fs.writeFileSync(cleanEnv.GIT_CONFIG_GLOBAL, '[core]\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n')
  for (const k of Object.keys(cleanEnv)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE)$/i.test(k)) delete cleanEnv[k]
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
  const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s) }
  const runner = gx.createGitRunner({ env: () => gx.gitEnv(cleanEnv) })
  const repo = path.join(base, 'secret-repo-root')
  const untracked = new UntrackedCounter()
  const svc = new GitService({ runner, emit() {}, untracked, watch: () => null })
  const remote = new GR.GitRemote({ source: svc, runner, untrackedPeek: (abs) => untracked.peek(abs) })
  try {
    fs.mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    const lines = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} ${String(i).padStart(5, '0')} ${'w'.repeat(24)}`).join('\n') + '\n'
    write(path.join(repo, 'src', 'big.ts'), lines(2000, 'old'))
    write(path.join(repo, 'staged.txt'), 'a\n')
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init')
    write(path.join(repo, 'src', 'big.ts'), lines(2000, 'new'))
    write(path.join(repo, 'staged.txt'), 'a\nb\n'); git(repo, 'add', 'staged.txt')
    for (let i = 0; i < 3000; i++) write(path.join(repo, 'gen', `untracked-${String(i).padStart(4, '0')}-${'u'.repeat(20)}.txt`), 'x\n')
    svc.setTargets([{ key: 'ws:w1', cwd: repo, workspaceId: 'w1', active: false }])
    await svc.idle()

    // FR-22: 3000 untracked in several pages <= 48 KB, the last one done.
    const frames = []
    let page = 0
    for (;;) {
      const r = await remote.handle({ workspaceId: 'w1', op: 'status', page })
      frames.push(r)
      if (!r.ok || r.done) break
      page++
    }
    check(frames.every((r) => r.ok) && frames.length > 3 && frames.at(-1).done, `3000 untracked: ${frames.length} pages, the last done`)
    check(frames.every((r) => frameBytes(r) <= FRAME_MAX), 'every real status frame is <= 48 KB')
    const listed = frames.flatMap((r) => r.data.files)
    check(listed.length === 3002 && frames[0].data.total === 3002 && listed.filter((f) => f.area === 'untracked').length === 3000, 'all 3002 entries, once each')
    check(listed.find((f) => f.path === 'staged.txt' && f.area === 'staged').added === 1 && listed.find((f) => f.path === 'src/big.ts').added === 2000, 'per-area counts come with the list')

    // FR-23: a 4000 line diff, same diffRev, continued, then an edit between pages.
    const d = []
    for (let p = 0; ; p++) {
      const r = await remote.handle({ workspaceId: 'w1', op: 'diff', path: 'src/big.ts', page: p })
      d.push(r)
      if (!r.ok || r.done) break
    }
    check(d.every((r) => r.ok) && d.length > 2 && d.every((r) => frameBytes(r) <= FRAME_MAX), `a 4000 line diff: ${d.length} pages of <= 48 KB`)
    check(d.every((r) => r.data.diffRev === d[0].data.diffRev), 'all with the same diffRev')
    check(d.slice(1).every((r) => r.data.hunks[0].continued === true), 'the hunk split across pages carries continued:true')
    check(d.flatMap((r) => r.data.hunks.flatMap((h) => h.lines)).filter((l) => l.kind === 'add').length === 2000, 'all 2000 added lines arrive')
    const p1 = await remote.handle({ workspaceId: 'w1', op: 'diff', path: 'src/big.ts', page: 1 })
    write(path.join(repo, 'src', 'big.ts'), lines(2000, 'newer'))
    await svc.ensureFresh('ws:w1', 0)
    const p2 = await remote.handle({ workspaceId: 'w1', op: 'diff', path: 'src/big.ts', page: 2 })
    check(p1.data.diffRev === d[0].data.diffRev && p2.ok && p2.data.diffRev !== p1.data.diffRev, 'an edit between page 1 and 2 plus a refresh: page 2 brings another diffRev')
    const st = await remote.handle({ workspaceId: 'w1', op: 'diff', path: 'staged.txt', staged: true })
    check(st.ok && st.data.area === 'staged' && st.data.hunks[0].lines.some((l) => l.kind === 'add' && l.text === 'b'), 'staged:true gives the index diff')
    write(path.join(repo, 'late.txt'), 'late\n')
    const late = await remote.handle({ workspaceId: 'w1', op: 'diff', path: 'late.txt' })
    check(late.ok && late.data.area === 'untracked', 'a file created after the last list is found without not_found')
    same((await remote.handle({ workspaceId: 'w1', op: 'diff', path: 'made-up.ts' })).data, { error: 'not_found' }, 'an invented path: not_found')
    same((await remote.handle({ workspaceId: 'w9', op: 'status' })).data, { error: 'not_found' }, 'a workspace without target: not_found')
    const all = [...frames, ...d, p1, p2, st, late].map((r) => frame(r)).join('\n')
    const rootForms = [repo, repo.replace(/\\/g, '/'), path.basename(repo), fs.realpathSync.native(repo)]
    check(rootForms.every((s) => !all.includes(s)), 'no gitRes contains the repo root (any spelling) or the cwd')
  } finally {
    svc.dispose()
    fs.rmSync(base, { recursive: true, force: true })
  }
}

function testFixtures() {
  // Deterministic frames for E3 (R30-09b): the Changes screen tests feed them
  // to the phone client. Small budgets make the paged cases short to read; the
  // shapes are exactly what main sends.
  const files = [entry('src/app.ts', 'staged', { status: 'M', added: 12, removed: 3 }), entry('src/app.ts', 'unstaged', { status: 'M', added: 2, removed: 2 }), entry('src/new name.ts', 'staged', { status: 'R', oldPath: 'src/old name.ts', added: 0, removed: 0 }), entry('img/logo.png', 'unstaged', { status: 'M', added: null, removed: null, binary: true }), entry('conflict.txt', 'conflict', { status: 'U', added: 4, removed: 1 }), entry('notes/\u00f1and\u00fa.md', 'untracked', { status: '?', added: 7, removed: 0 })]
  const sum = { branch: 'feature/login', ahead: 2, behind: 1, added: 25, removed: 6, files: 5, approx: false, conflicts: 1, op: 'merge' }
  const sp = GR.pageChanges(sum, files, false, 600)
  const dhunks = { path: 'src/app.ts', area: 'unstaged', binary: false, diffRev: '3f786850e387550fdab836ed7e6dc881de23001b', totalLines: 30, hunks: [
    { header: '@@ -10,6 +10,7 @@ export function login()', oldStart: 10, newStart: 10, lines: [{ kind: 'ctx', oldNo: 10, newNo: 10, text: '  const user = find(id)' }, { kind: 'del', oldNo: 11, text: '  if (!user) return null' }, { kind: 'add', newNo: 11, text: '  if (!user) {' }, { kind: 'add', newNo: 12, text: '    throw new NotFound(id)' }, { kind: 'add', newNo: 13, text: '  }' }, { kind: 'ctx', oldNo: 12, newNo: 14, text: '  return user' }] },
    { header: '@@ -40,3 +41,3 @@', oldStart: 40, newStart: 41, lines: Array.from({ length: 40 }, (_, i) => ({ kind: i % 2 ? 'add' : 'del', ...(i % 2 ? { newNo: 41 + (i >> 1) } : { oldNo: 40 + (i >> 1) }), text: `  value${i} = compute(${i})` })) },
  ] }
  const dp = GR.pageDiff(dhunks, 1500)
  const reply = (data, page, total) => ({ ok: true, data, page, done: page === total - 1 })
  const fixture = {
    comment: 'Generated by scripts/test-git-remote.cjs (UPDATE_FIXTURES=1 to rewrite). gitRes frames of E7-FR-22/23 for the E3 Changes screen. budgetBytes: the page budget used here (main uses 49152).',
    status: { budgetBytes: 600, frames: sp.map((d, i) => ({ v: 1, type: 'gitRes', id: 'fx-status', ...reply(d, i, sp.length) })) },
    statusClean: { v: 1, type: 'gitRes', id: 'fx-clean', ...reply(GR.pageChanges({ ...sum, added: 0, removed: 0, files: 0, conflicts: 0, op: null }, [], false)[0], 0, 1) },
    diff: { budgetBytes: 1500, frames: dp.map((d, i) => ({ v: 1, type: 'gitRes', id: 'fx-diff', ...reply(d, i, dp.length) })) },
    diffBinary: { v: 1, type: 'gitRes', id: 'fx-bin', ...reply(GR.pageDiff({ path: 'img/logo.png', area: 'unstaged', binary: true, diffRev: 'b1', hunks: [], totalLines: 0 })[0], 0, 1) },
    diffTooLarge: { v: 1, type: 'gitRes', id: 'fx-big', ...reply(GR.pageDiff({ path: 'dist/bundle.js', area: 'unstaged', binary: false, diffRev: 't1', tooLarge: { lines: 18000, bytes: 2400000 }, hunks: [], totalLines: 18000 })[0], 0, 1) },
    errors: ['not_found', 'rate', 'timeout', 'not_repo'].map((error) => ({ v: 1, type: 'gitRes', id: `fx-${error}`, ok: false, data: { error }, page: 0, done: true })),
    sendReviewNotes: { v: 1, type: 'ctl', id: 'fx-notes', action: { kind: 'sendReviewNotes', workspaceId: 'w1', paneId: 'p1', enter: false, notes: [{ file: 'src/app.ts', lines: '11-13', comment: 'throw is better here' }, { file: 'src/app.ts', lines: '', comment: 'add a header' }] } },
  }
  check(fixture.status.frames.length > 1 && fixture.diff.frames.length > 1 && fixture.diff.frames[1].data.hunks[0].continued === true, 'the fixtures cover a paged list and a continued hunk')
  const { parseRemoteClientMsg } = load('src/shared/remote-protocol-schemas.ts')
  check(!!parseRemoteClientMsg(JSON.stringify(fixture.sendReviewNotes)), 'the sendReviewNotes fixture passes the real schema')
  const file = path.join(root, 'scripts', 'fixtures', 'git-remote', 'frames.json')
  const text = JSON.stringify(fixture, null, 2) + '\n'
  if (process.env.UPDATE_FIXTURES === '1' || !fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }
  check(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') === text, 'scripts/fixtures/git-remote/frames.json matches the current paging (UPDATE_FIXTURES=1 to rewrite)')
}

;(async () => {
  testSchemas()
  const schemaChecks = checks
  testPaging()
  await testGitRemote()
  await testSessionLimits()
  await testExecutor()
  await testRealRepos()
  testFixtures()
  console.log(`PASS: ${checks} git remote checks (${schemaChecks} schema, ${checks - schemaChecks} paging, GitRemote, session limits, sendReviewNotes executor, real repos, fixtures)`)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
