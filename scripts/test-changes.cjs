// Logic of the Changes panel (E7-FR-04, 11..16, R22-11): the unified diff
// parser, untracked diffs, repo path validation, the "open with the default
// app" allowlist, ChangesReader (git:status / git:fileDiff / git:openFile)
// with fakes and over real repos in temp (isolated git config), and the
// renderer's pure helpers (sections, keys, rows, chunks, wrap, drag paths,
// keymap). Bundled with esbuild and run in a vm, like test-git.cjs.
const { buildSync } = require('esbuild')
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
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, crypto: globalThis.crypto, process, Buffer, setTimeout, clearTimeout, setImmediate, setInterval, clearInterval, ...overrides })
  return mod.exports
}

const D = load('src/main/git/diff.ts')
const { parseUnifiedDiff, untrackedDiff, resolveRepoPath, canOpenWithDefaultApp, openRepoFile, readFileDiff, ChangesReader, findListed, DIFF_MAX_LINES, DIFF_MAX_BYTES, UNTRACKED_READ_BYTES } = D

;(async () => {
  // ---- unified diff parser -------------------------------------------------
  const two = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,4 +1,5 @@ export function a() {',
    ' one',
    '-two',
    '+TWO',
    '+two and a half',
    ' three',
    ' four',
    '@@ -40,3 +41,2 @@',
    ' forty',
    '--- not a header, a deleted line',
    ' forty two',
    '\\ No newline at end of file',
    '',
  ].join('\n')
  const p = parseUnifiedDiff(two)
  check(p.hunks.length === 2 && !p.binary, 'two hunks, not binary')
  same(p.hunks[0].header, '@@ -1,4 +1,5 @@ export function a() {', 'hunk header kept with its section text')
  same(p.hunks[0].lines, [
    { kind: 'ctx', oldNo: 1, newNo: 1, text: 'one' },
    { kind: 'del', oldNo: 2, text: 'two' },
    { kind: 'add', newNo: 2, text: 'TWO' },
    { kind: 'add', newNo: 3, text: 'two and a half' },
    { kind: 'ctx', oldNo: 3, newNo: 4, text: 'three' },
    { kind: 'ctx', oldNo: 4, newNo: 5, text: 'four' },
  ], 'old and new numbers walk independently')
  same(p.hunks[1].lines.map((l) => [l.kind, l.oldNo ?? null, l.newNo ?? null]), [['ctx', 40, 41], ['del', 41, null], ['ctx', 42, 42], ['meta', null, null]], 'a "---" line inside a hunk is a deletion; "\\ No newline" is meta')
  check(p.hunks[0].oldStart === 1 && p.hunks[1].newStart === 41 && p.totalLines === 2 + 6 + 4, 'starts and total line count')
  same(parseUnifiedDiff('@@ -1 +1 @@\r\n-a\r\n+b\r\n').hunks[0].lines, [{ kind: 'del', oldNo: 1, text: 'a' }, { kind: 'add', newNo: 1, text: 'b' }], 'CRLF output and single-line hunk headers')
  check(parseUnifiedDiff('diff --git a/x.png b/x.png\nindex 1..2 100644\nBinary files a/x.png and b/x.png differ\n').binary, 'binary files are flagged')
  const cc = parseUnifiedDiff('diff --cc f.txt\nindex 1,2..3\n--- a/f.txt\n+++ b/f.txt\n@@@ -1,1 -1,1 +1,5 @@@\n++<<<<<<< HEAD\n + ours\n++=======\n+ theirs\n++>>>>>>> b\n')
  check(cc.hunks.length === 1 && cc.hunks[0].lines.every((l) => l.kind === 'meta') && cc.hunks[0].lines[0].text === '++<<<<<<< HEAD', 'a combined (conflict) diff is shown raw as meta')
  const mode = parseUnifiedDiff('diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n')
  check(mode.hunks.length === 1 && mode.hunks[0].header === '' && mode.hunks[0].lines.map((l) => l.text).join('|') === 'old mode 100644|new mode 100755', 'a mode-only change shows what git said')
  const ren = parseUnifiedDiff('diff --git a/a b/b\nsimilarity index 100%\nrename from a\nrename to b\n')
  check(ren.hunks[0].lines.length === 3, 'a pure rename lists similarity and both names')
  same(parseUnifiedDiff(''), { hunks: [], binary: false, totalLines: 0 }, 'empty diff')

  // ---- untracked as all-added ----------------------------------------------
  const ut = untrackedDiff(Buffer.from('a\nb\r\nc'))
  same(ut.hunks[0].lines, [{ kind: 'add', newNo: 1, text: 'a' }, { kind: 'add', newNo: 2, text: 'b' }, { kind: 'add', newNo: 3, text: 'c' }, { kind: 'meta', text: '\\ No newline at end of file' }], 'untracked file: every line added, missing final newline noted')
  check(ut.hunks[0].header === '@@ -0,0 +1,3 @@', 'untracked hunk header')
  check(untrackedDiff(Buffer.from([0x50, 0x4e, 0x47, 0, 1])).binary, 'a NUL in the first 8 KB is binary')
  same(untrackedDiff(Buffer.alloc(0)), { hunks: [], binary: false, totalLines: 0 }, 'empty untracked file')

  // ---- path validation (git:fileDiff / git:openFile) -------------------------
  const R = 'C:\\repo'
  same(resolveRepoPath(R, 'src/a.ts', 'win32'), path.resolve(R, 'src/a.ts'), 'nested relative path resolves inside the repo')
  for (const bad of ['', '..\\x', 'src/../../x', '../x', 'C:\\Windows\\win.ini', 'D:x', '/etc/passwd', '\\\\srv\\share\\x', 'a\0b', 'a\nb', 'a\rb', 'x\u2028y', 'x\u009by', 'a/..']) {
    check(resolveRepoPath(R, bad, 'win32') === null, `rejected: ${JSON.stringify(bad)}`)
  }
  check(resolveRepoPath(R, 'x'.repeat(5000), 'win32') === null, 'a path over 4096 chars is rejected')
  check(resolveRepoPath(R, 'a..b/c..d.txt', 'win32') !== null, 'dots inside a name are fine')
  check(resolveRepoPath('/home/u/repo', 'src/a.ts', 'linux') !== null && resolveRepoPath('/home/u/repo', '../repo2/a', 'linux') === null, 'POSIX root')
  same(findListed([{ path: 'a', area: 'staged' }, { path: 'a', area: 'unstaged' }], 'a', 'unstaged'), { path: 'a', area: 'unstaged' }, 'a listed entry is found by path and area')
  check(findListed([{ path: 'a', area: 'staged' }], 'a', 'untracked') === null && findListed([], 'a') === null, 'unlisted path or area')

  // ---- open allowlist (FR-15) ----------------------------------------------
  for (const ok of ['a.txt', 'README.MD', 'x.json', 'c.jsonc', 'a.tsx', 'b.Java', 'c.kt', 'p.py', 'q.sql', 'build.gradle', 'app.properties', 'i.png', 'v.svg', 'w.webp', 'run.sh', 'log.log']) check(canOpenWithDefaultApp(ok), `opens: ${ok}`)
  for (const no of ['build.bat', 'tool.hta', 'x.reg', 'a.exe', 'b.cmd', 'c.ps1', 'd.vbs', 'e.lnk', 'f.msi', 'g.scr', 'h.js.lnk', 'Makefile', 'noext', '.env', 'x.jar', 'y.url', 'z.com']) check(!canOpenWithDefaultApp(no), `revealed instead: ${no}`)

  const fakeOpen = (entries) => {
    const calls = []
    const stat = (kind, size = 1) => ({ size, isFile: () => kind === 'file', isSymbolicLink: () => kind === 'link', isDirectory: () => kind === 'dir' })
    const deps = {
      fs: { lstat: async (p) => { const k = entries[p]; if (!k) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return stat(k) } },
      openPath: async (p) => { calls.push(['open', p]); return '' },
      showItemInFolder: (p) => calls.push(['reveal', p]),
      platform: 'win32',
    }
    return { calls, deps }
  }
  {
    const A = (rel) => path.resolve(R, rel)
    const f = fakeOpen({ [A('src/a.ts')]: 'file', [A('build.bat')]: 'file', [A('link.txt')]: 'link', [A('src')]: 'dir', [A('tool.hta')]: 'file', [A('x.reg')]: 'file' })
    check(await openRepoFile(R, 'src/a.ts', false, f.deps), 'allowlisted file opens')
    check(await openRepoFile(R, 'build.bat', false, f.deps) && await openRepoFile(R, 'tool.hta', false, f.deps) && await openRepoFile(R, 'x.reg', false, f.deps), '.bat / .hta / .reg answer true')
    check(await openRepoFile(R, 'link.txt', false, f.deps), 'a link named .txt answers true')
    check(await openRepoFile(R, 'src/a.ts', true, f.deps), 'reveal of a code file')
    check(await openRepoFile(R, 'src/gone.ts', false, f.deps), 'a deleted file reveals its folder')
    check(!(await openRepoFile(R, 'nope/gone.ts', false, f.deps)), 'a deleted file whose folder is gone answers false')
    check(!(await openRepoFile(R, '..\\..\\Windows\\System32\\calc.exe', false, f.deps)), 'traversal answers false')
    same(f.calls, [
      ['open', A('src/a.ts')],
      ['reveal', A('build.bat')], ['reveal', A('tool.hta')], ['reveal', A('x.reg')],
      ['reveal', A('link.txt')],
      ['reveal', A('src/a.ts')],
      ['open', A('src')],
    ], 'only the allowlisted regular file reaches openPath; .bat/.hta/.reg and links are revealed, never opened')
  }

  // ---- readFileDiff / ChangesReader with fakes --------------------------------
  const H = (n) => Array.from({ length: n }, (_, i) => `+l${i}`).join('\n')
  const fakeRunner = (replies) => {
    const calls = []
    return { calls, run: async (args, opts) => { calls.push({ args, cwd: opts.cwd }); const r = replies(args); if (r instanceof Error) throw r; return r } }
  }
  {
    const runner = fakeRunner((args) => (args.includes('--cached') ? '@@ -1 +1 @@\n-a\n+b\n' : `@@ -0,0 +1,${DIFF_MAX_LINES + 1} @@\n${H(DIFF_MAX_LINES + 1)}\n`))
    const staged = await readFileDiff({ repoRoot: R, entry: { path: 'new.ts', oldPath: 'old.ts', area: 'staged', status: 'R' }, force: false, runner, platform: 'win32' })
    same(runner.calls[0].args, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U3', '--cached', '-M', '--', 'new.ts', 'old.ts'], 'staged rename: --cached -M with both paths after --, no ext diff, no textconv')
    check(runner.calls[0].cwd === R, 'diff runs in the repo root')
    check(staged.path === 'new.ts' && staged.oldPath === 'old.ts' && staged.hunks.length === 1 && /^[0-9a-f]{40}$/.test(staged.diffRev), 'staged diff parsed, rev is a sha1')
    const big = await readFileDiff({ repoRoot: R, entry: { path: 'big.ts', area: 'unstaged', status: 'M' }, force: false, runner, platform: 'win32' })
    check(big.tooLarge && big.tooLarge.lines === DIFF_MAX_LINES + 2 && big.hunks.length === 0, `more than ${DIFF_MAX_LINES} lines: too large, no hunks`)
    same(runner.calls[1].args.slice(-3), ['-M', '--', 'big.ts'], 'unstaged: no --cached')
    const bigForced = await readFileDiff({ repoRoot: R, entry: { path: 'big.ts', area: 'unstaged', status: 'M' }, force: true, runner, platform: 'win32' })
    check(!bigForced.tooLarge && bigForced.hunks[0].lines.length === DIFF_MAX_LINES + 1 && bigForced.diffRev === big.diffRev, 'force renders it; same rev')
    const wide = fakeRunner(() => `@@ -1 +1 @@\n+${'x'.repeat(DIFF_MAX_BYTES + 10)}\n`)
    check((await readFileDiff({ repoRoot: R, entry: { path: 'w.min.js', area: 'unstaged', status: 'M' }, force: false, runner: wide, platform: 'win32' })).tooLarge.bytes > DIFF_MAX_BYTES, 'more than 512 KB: too large')
    const conflict = fakeRunner(() => 'diff --cc f\n@@@ -1 -1 +1 @@@\n++x\n')
    await readFileDiff({ repoRoot: R, entry: { path: 'f', area: 'conflict', status: 'U' }, force: false, runner: conflict, platform: 'win32' })
    same(conflict.calls[0].args, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U3', '--', 'f'], 'conflict: plain combined diff, no -M')
    const empty = fakeRunner(() => '')
    same(await readFileDiff({ repoRoot: R, entry: { path: 'a', area: 'unstaged', status: 'M' }, force: false, runner: empty, platform: 'win32' }), { error: 'gone' }, 'an empty diff means the file has no changes any more')
    const failing = fakeRunner(() => Object.assign(new Error('boom'), { code: 'timeout' }))
    same(await readFileDiff({ repoRoot: R, entry: { path: 'a', area: 'unstaged', status: 'M' }, force: false, runner: failing, platform: 'win32' }), { error: 'timeout' }, 'git errors come back as their code')
    same(await readFileDiff({ repoRoot: R, entry: { path: '../x', area: 'unstaged', status: 'M' }, force: false, runner: failing, platform: 'win32' }), { error: 'denied' }, 'a bad path never runs git')
    same(await readFileDiff({ repoRoot: R, entry: { path: 'a', oldPath: 'C:\\x', area: 'staged', status: 'R' }, force: false, runner: failing, platform: 'win32' }), { error: 'denied' }, 'a bad oldPath never runs git')
    check(failing.calls.length === 1, 'denied requests ran nothing')

    // Untracked through a fake fs: size cap, link, gone.
    const files = { [path.resolve(R, 'u.txt')]: Buffer.from('x\ny\n'), [path.resolve(R, 'huge.log')]: Buffer.alloc(UNTRACKED_READ_BYTES + 1, 0x61) }
    const ufs = {
      lstat: async (p) => {
        if (p === path.resolve(R, 'ln')) return { size: 3, isFile: () => false, isSymbolicLink: () => true, isDirectory: () => false }
        if (!files[p]) throw new Error('ENOENT')
        return { size: files[p].length, isFile: () => true, isSymbolicLink: () => false, isDirectory: () => false }
      },
      readFile: async (p) => files[p],
      readlink: async () => '../outside/secret',
    }
    const u = await readFileDiff({ repoRoot: R, entry: { path: 'u.txt', area: 'untracked', status: '?' }, force: false, runner: failing, fs: ufs, platform: 'win32' })
    check(u.hunks[0].lines.length === 2 && u.hunks[0].lines.every((l) => l.kind === 'add'), 'untracked: all added')
    const huge = await readFileDiff({ repoRoot: R, entry: { path: 'huge.log', area: 'untracked', status: '?' }, force: false, runner: failing, fs: ufs, platform: 'win32' })
    check(huge.tooLarge && huge.tooLarge.bytes === UNTRACKED_READ_BYTES + 1 && huge.tooLarge.lines === 0, 'untracked over 512 KB is not read without force')
    const hugeForced = await readFileDiff({ repoRoot: R, entry: { path: 'huge.log', area: 'untracked', status: '?' }, force: true, runner: failing, fs: ufs, platform: 'win32' })
    check(!hugeForced.tooLarge && hugeForced.hunks.length === 1, 'force reads it')
    const ln = await readFileDiff({ repoRoot: R, entry: { path: 'ln', area: 'untracked', status: '?' }, force: false, runner: failing, fs: ufs, platform: 'win32' })
    check(ln.hunks[0].lines[0].text === '../outside/secret', 'an untracked link shows its target, never the file behind it')
    same(await readFileDiff({ repoRoot: R, entry: { path: 'gone.txt', area: 'untracked', status: '?' }, force: false, runner: failing, fs: ufs, platform: 'win32' }), { error: 'gone' }, 'an untracked file deleted meanwhile is gone')
    check(failing.calls.length === 1, 'untracked diffs never run git')
  }
  {
    const summary = { repoRoot: R, staged: 1, unstaged: 1, untracked: 2, conflicts: 0 }
    const list = [
      { path: 'both.ts', area: 'staged', status: 'M', added: null, removed: null, binary: false },
      { path: 'both.ts', area: 'unstaged', status: 'M', added: null, removed: null, binary: false },
      { path: 'new.txt', area: 'untracked', status: '?', added: null, removed: null, binary: false },
      { path: 'pic.png', area: 'untracked', status: '?', added: null, removed: null, binary: false },
      { path: 'build.bat', area: 'unstaged', status: 'M', added: null, removed: null, binary: false },
    ]
    let view = { summary, files: list }
    const fresh = []
    const source = { ensureFresh: async (key, age) => { fresh.push([key, age]); return key === 'ws:a' ? view : null }, get: (key) => (key === 'ws:a' ? view : null) }
    const runner = fakeRunner((args) => (!args.includes('--numstat') ? '@@ -1 +1 @@\n-a\n+b\n' : args.includes('--cached') ? '10\t2\tboth.ts\0' : '3\t1\tboth.ts\0-\t-\tbuild.bat\0'))
    const opened = []
    const peeks = { [path.resolve(R, 'new.txt')]: 7, [path.resolve(R, 'pic.png')]: null }
    const reader = new ChangesReader({ source, runner, untrackedPeek: (abs) => peeks[abs], open: { openPath: async (p) => { opened.push(['open', p]); return '' }, showItemInFolder: (p) => opened.push(['reveal', p]) }, platform: 'win32', fs: { lstat: async () => ({ size: 1, isFile: () => true, isSymbolicLink: () => false, isDirectory: () => false }), readFile: async () => Buffer.from('a\n'), readlink: async () => '' } })
    const res = await reader.status('ws:a')
    same(res.files.map((f) => [f.area, f.path, f.added, f.removed, f.binary]), [
      ['staged', 'both.ts', 10, 2, false],
      ['unstaged', 'both.ts', 3, 1, false],
      ['untracked', 'new.txt', 7, 0, false],
      ['untracked', 'pic.png', null, null, true],
      ['unstaged', 'build.bat', null, null, true],
    ], 'per-row counts come from the per-area numstats and the untracked cache')
    same(fresh[0], ['ws:a', 2500], 'status asks for a result at most 2.5 s old')
    const numstatRuns = runner.calls.length
    await reader.status('ws:a')
    check(runner.calls.length === numstatRuns && numstatRuns === 2, 'the same run reuses its per-area counts (2 numstats total)')
    view = { summary, files: list.slice() }
    await reader.status('ws:a')
    check(runner.calls.length === 4, 'a new run (new list) recounts')
    check((await reader.status('ws:nope')) === null && (await reader.status(42)) === null, 'unknown key or bad payload: null')

    same(await reader.fileDiff({ key: 'ws:a', path: 'other.ts', area: 'unstaged' }), { error: 'gone' }, 'fileDiff: an unlisted path is refused (gone)')
    same(await reader.fileDiff({ key: 'ws:a', path: 'new.txt', area: 'staged' }), { error: 'gone' }, 'fileDiff: a listed path in another area is refused')
    same(await reader.fileDiff({ key: 'ws:a', path: 'both.ts', area: 'evil' }), { error: 'denied' }, 'fileDiff: unknown area')
    same(await reader.fileDiff(null), { error: 'denied' }, 'fileDiff: bad payload')
    same(await reader.fileDiff({ key: 'ws:zz', path: 'both.ts', area: 'staged' }), { error: 'gone' }, 'fileDiff: unknown key')
    const runsBefore = runner.calls.length
    const ok = await reader.fileDiff({ key: 'ws:a', path: 'both.ts', area: 'staged' })
    check(ok.hunks.length === 1 && runner.calls.length === runsBefore + 1, 'fileDiff: a listed path runs one diff')

    check(!(await reader.openFile({ key: 'ws:a', path: 'C:\\Windows\\System32\\calc.exe' })) && !(await reader.openFile({ key: 'ws:a', path: 'unlisted.txt' })), 'openFile: only listed paths')
    check(await reader.openFile({ key: 'ws:a', path: 'build.bat' }), 'openFile on a listed .bat answers')
    check(await reader.openFile({ key: 'ws:a', path: 'new.txt' }), 'openFile on a listed .txt answers')
    check(await reader.openFile({ key: 'ws:a', path: 'new.txt', reveal: true }), 'reveal')
    same(opened, [['reveal', path.resolve(R, 'build.bat')], ['open', path.resolve(R, 'new.txt')], ['reveal', path.resolve(R, 'new.txt')]], 'openFile: .bat revealed, .txt opened, reveal honored')
  }

  // ---- real repositories in temp --------------------------------------------
  let gitOk = true
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }) } catch { gitOk = false }
  if (!gitOk) console.log('SKIP: git not on PATH, real repository checks skipped')
  else {
    const gx = load('src/main/git/gitExec.ts')
    const { GitService } = load('src/main/git/GitService.ts')
    const { UntrackedCounter } = load('src/main/git/untrackedLines.ts')
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'snaos-changes-'))
    const cleanEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(base, 'gitconfig') }
    for (const k of Object.keys(cleanEnv)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|EXTERNAL_DIFF)$/i.test(k)) delete cleanEnv[k]
    fs.writeFileSync(cleanEnv.GIT_CONFIG_GLOBAL, '[core]\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n')
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
    const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s) }
    const lines = (n, tag = 'l') => Array.from({ length: n }, (_, i) => `${tag}${i}`).join('\n') + '\n'
    const runner = gx.createGitRunner({ env: () => gx.gitEnv(cleanEnv) })
    async function open(cwd) {
      const untracked = new UntrackedCounter()
      const svc = new GitService({ runner, emit: () => {}, untracked, watch: () => null })
      svc.setTargets([{ key: 'ws:x', cwd, workspaceId: 'x', active: false }])
      await svc.idle()
      const opened = []
      const reader = new ChangesReader({ source: svc, runner, untrackedPeek: (abs) => untracked.peek(abs), open: { openPath: async (p) => { opened.push(['open', p]); return '' }, showItemInFolder: (p) => opened.push(['reveal', p]) } })
      return { svc, reader, opened }
    }
    try {
      const repo = path.join(base, 'repo')
      fs.mkdirSync(repo)
      git(repo, 'init', '-q', '-b', 'main')
      write(path.join(repo, 'src', 'both.ts'), lines(10))
      write(path.join(repo, 'old name.txt'), lines(6))
      write(path.join(repo, 'del.txt'), lines(3))
      write(path.join(repo, 'big.txt'), lines(10))
      write(path.join(repo, 'img.bin'), Buffer.from([1, 2, 3, 0, 4]))
      git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init')
      // staged +1 then modified again (both areas), a staged rename, a deletion, a big rewrite, a binary change, an untracked file.
      write(path.join(repo, 'src', 'both.ts'), lines(10) + 'staged\n'); git(repo, 'add', 'src/both.ts')
      write(path.join(repo, 'src', 'both.ts'), lines(10) + 'staged\nworking\n')
      git(repo, 'mv', 'old name.txt', 'new name.txt')
      fs.unlinkSync(path.join(repo, 'del.txt'))
      write(path.join(repo, 'big.txt'), lines(6000, 'b'))
      write(path.join(repo, 'img.bin'), Buffer.from([9, 9, 0, 9]))
      write(path.join(repo, '\u00f1 notes.md'), lines(4, 'n'))
      const { svc, reader, opened } = await open(repo)
      const res = await reader.status('ws:x')
      const row = (area, p) => res.files.find((f) => f.area === area && f.path === p)
      check(row('staged', 'src/both.ts') && row('unstaged', 'src/both.ts'), 'a file staged and modified is listed in Staged and in Unstaged')
      check(row('staged', 'src/both.ts').added === 1 && row('unstaged', 'src/both.ts').added === 1 && row('unstaged', 'src/both.ts').removed === 0, 'per-area counts: +1 staged, +1 unstaged')
      check(row('staged', 'new name.txt').oldPath === 'old name.txt' && row('staged', 'new name.txt').status === 'R', 'staged rename with its old name')
      check(row('unstaged', 'del.txt').status === 'D' && row('unstaged', 'del.txt').removed === 3, 'deletion counted')
      check(row('unstaged', 'img.bin').binary, 'binary change flagged bin')
      check(row('untracked', '\u00f1 notes.md').added === 4, 'untracked row counts its lines from the cache')

      const dStaged = await reader.fileDiff({ key: 'ws:x', path: 'src/both.ts', area: 'staged' })
      same(dStaged.hunks[0].lines.filter((l) => l.kind !== 'ctx'), [{ kind: 'add', newNo: 11, text: 'staged' }], 'staged diff: only the staged line, numbered')
      const dWork = await reader.fileDiff({ key: 'ws:x', path: 'src/both.ts', area: 'unstaged' })
      same(dWork.hunks[0].lines.filter((l) => l.kind !== 'ctx'), [{ kind: 'add', newNo: 12, text: 'working' }], 'unstaged diff: only the working line')
      check(dStaged.diffRev !== dWork.diffRev, 'each area has its own rev')
      const again = await reader.fileDiff({ key: 'ws:x', path: 'src/both.ts', area: 'unstaged' })
      check(again.diffRev === dWork.diffRev, 'an unchanged diff keeps its rev (the panel keeps its scroll)')
      const dRen = await reader.fileDiff({ key: 'ws:x', path: 'new name.txt', area: 'staged' })
      check(dRen.oldPath === 'old name.txt' && dRen.hunks.length === 1 && dRen.hunks[0].lines.some((l) => l.text === 'rename from old name.txt'), 'a pure staged rename shows its rename lines')
      const dDel = await reader.fileDiff({ key: 'ws:x', path: 'del.txt', area: 'unstaged' })
      check(dDel.hunks[0].lines.every((l) => l.kind === 'del') && dDel.hunks[0].lines.length === 3, 'a deleted file is all deletions')
      check((await reader.fileDiff({ key: 'ws:x', path: 'img.bin', area: 'unstaged' })).binary, 'binary file')
      const dBig = await reader.fileDiff({ key: 'ws:x', path: 'big.txt', area: 'unstaged' })
      check(dBig.tooLarge && dBig.tooLarge.lines > 6000 && dBig.hunks.length === 0, '6000 changed lines: too large')
      const dBigF = await reader.fileDiff({ key: 'ws:x', path: 'big.txt', area: 'unstaged', force: true })
      check(!dBigF.tooLarge && dBigF.hunks.reduce((n, h) => n + h.lines.length, 0) === 6010, 'force renders all 6000 + 10 lines')
      const dUt = await reader.fileDiff({ key: 'ws:x', path: '\u00f1 notes.md', area: 'untracked' })
      check(dUt.hunks[0].lines.length === 4 && dUt.hunks[0].lines.every((l) => l.kind === 'add'), 'untracked shows all green')
      same(await reader.fileDiff({ key: 'ws:x', path: '../outside.txt', area: 'untracked' }), { error: 'gone' }, 'a path main did not list is refused')
      check(await reader.openFile({ key: 'ws:x', path: '\u00f1 notes.md' }) && opened[0][0] === 'open', 'a listed .md opens with its app')

      // Selection disappears after a commit: the list no longer has it.
      git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'second')
      write(path.join(repo, 'src', 'both.ts'), lines(3))
      svc.refresh(['ws:x'], 'manual')
      await new Promise((r) => setTimeout(r, 1600))
      svc.refresh(['ws:x'], 'manual')
      await new Promise((r) => setTimeout(r, 50))
      await svc.idle()
      same(await reader.fileDiff({ key: 'ws:x', path: 'big.txt', area: 'unstaged' }), { error: 'gone' }, 'a committed file is gone from the list (the panel says "no changes any more")')
      svc.dispose()

      // A repo whose config asks for textconv / external diff never runs them.
      const evil = path.join(base, 'evil')
      fs.mkdirSync(evil)
      git(evil, 'init', '-q', '-b', 'main')
      write(path.join(evil, '.gitattributes'), '*.txt diff=evil\n')
      write(path.join(evil, 'a.txt'), 'one\n')
      git(evil, 'add', '-A'); git(evil, 'commit', '-qm', 'init')
      git(evil, 'config', 'diff.evil.textconv', 'touch MARK_TEXTCONV; cat')
      git(evil, 'config', 'diff.evil.command', 'touch MARK_COMMAND')
      git(evil, 'config', 'diff.external', 'touch MARK_EXTERNAL')
      write(path.join(evil, 'a.txt'), 'two\n')
      let controlRan = false
      try { git(evil, 'diff', '--no-ext-diff'); controlRan = fs.existsSync(path.join(evil, 'MARK_TEXTCONV')) } catch { controlRan = fs.existsSync(path.join(evil, 'MARK_TEXTCONV')) }
      for (const m of ['MARK_TEXTCONV', 'MARK_COMMAND', 'MARK_EXTERNAL']) fs.rmSync(path.join(evil, m), { force: true })
      const ev = await open(evil)
      await ev.reader.status('ws:x')
      const evd = await ev.reader.fileDiff({ key: 'ws:x', path: 'a.txt', area: 'unstaged' })
      check(evd.hunks[0].lines.some((l) => l.kind === 'add' && l.text === 'two'), 'the evil repo still diffs as text')
      check(['MARK_TEXTCONV', 'MARK_COMMAND', 'MARK_EXTERNAL'].every((m) => !fs.existsSync(path.join(evil, m))), `no textconv, diff driver or external diff ran${controlRan ? ' (control: plain git diff did run textconv)' : ''}`)
      ev.svc.dispose()
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  }

  // ---- renderer helpers --------------------------------------------------------
  const C = load('src/renderer/lib/changes.ts')
  const F = (area, p, extra = {}) => ({ path: p, area, status: area === 'untracked' ? '?' : area === 'conflict' ? 'U' : 'M', added: 1, removed: 0, binary: false, ...extra })
  const list = [F('untracked', 'z.txt'), F('staged', 'b.ts'), F('unstaged', 'b.ts'), F('conflict', 'c.ts'), F('staged', 'a/d.ts')]
  same(C.groupFiles(list).map((s) => [s.area, s.files.map((f) => f.path)]), [['conflict', ['c.ts']], ['staged', ['b.ts', 'a/d.ts']], ['unstaged', ['b.ts']], ['untracked', ['z.txt']]], 'sections in order Conflicts, Staged, Unstaged, Untracked')
  same(C.groupFiles([F('unstaged', 'x')]).map((s) => s.area), ['unstaged'], 'empty sections are hidden')
  const rows = C.visibleRows(list, new Set(['staged']))
  same(rows.map(C.rowKey), ['conflict:c.ts', 'unstaged:b.ts', 'untracked:z.txt'], 'collapsed sections leave the keyboard walk')
  same(C.rowKey(C.stepRow(rows, 'conflict:c.ts', 1)), 'unstaged:b.ts', 'down moves to the next row')
  same(C.rowKey(C.stepRow(rows, 'untracked:z.txt', 1)), 'untracked:z.txt', 'down clamps at the end')
  same(C.rowKey(C.stepRow(rows, null, -1)), 'untracked:z.txt', 'up with no cursor picks the last row')
  check(C.stepRow([], null, 1) === null, 'no rows, no step')
  same(C.splitName('src/app/main.ts'), { name: 'main.ts', dir: 'src/app' }, 'name and folder')
  same(C.splitName('README.md'), { name: 'README.md', dir: '' }, 'root file')
  same([C.rowCounts(F('unstaged', 'a', { added: 12, removed: 3 })), C.rowCounts(F('unstaged', 'b', { binary: true })), C.rowCounts(F('untracked', 'c', { added: null, removed: null }))], ['+12 -3', 'bin', ''], 'row counts: +a -d, bin, or nothing')
  same(C.absRepoPath('C:\\repo\\', 'src/a b.ts'), 'C:\\repo\\src\\a b.ts', 'Windows absolute path with backslashes')
  same(C.absRepoPath('C:/Users/x/repo', 'src/a.ts'), 'C:/Users/x/repo\\src\\a.ts','a drive root keeps its prefix and gets backslashes')
  same(C.absRepoPath('/home/u/repo', 'src/a.ts'), '/home/u/repo/src/a.ts', 'POSIX absolute path')
  const files = { 'ws:a': [F('unstaged', 'src/a.ts')], 'ws:b': [F('untracked', 'x.md')] }
  const sums = { 'ws:a': { repoRoot: 'C:\\repo' }, 'ws:b': { repoRoot: 'C:\\other' } }
  check(C.isListedPath('C:\\repo\\src\\a.ts', files, sums) && C.isListedPath('C:\\other\\x.md', files, sums), 'listed paths of any target pass')
  check(!C.isListedPath('C:\\repo\\src\\A.ts', files, sums) && !C.isListedPath('C:\\repo\\src\\b.ts', files, sums) && !C.isListedPath('C:\\repo\\src\\a.ts', files, {}), 'exact match only, and only with a known repo root')
  // FR-04 end to end over the nonce check.
  const N = load('src/renderer/lib/dragNonce.ts')
  const known = (pth) => C.isListedPath(pth, files, sums)
  same(N.parseInternalPath(N.encodeInternalPath('C:\\repo\\src\\a.ts'), N.DRAG_NONCE, known), 'C:\\repo\\src\\a.ts', 'a row drag (nonce + listed path) is accepted')
  same(N.parseInternalPath(JSON.stringify({ nonce: N.DRAG_NONCE, path: 'rm -rf ~\r' }), N.DRAG_NONCE, () => true), null, 'rm -rf ~ with CR never passes')
  same(N.parseInternalPath(N.encodeInternalPath('C:\\repo\\src\\other.ts'), N.DRAG_NONCE, known), null, 'a path outside the current lists is rejected')
  same(N.parseInternalPath(N.encodeInternalPath('C:\\repo\\src\\a.ts', 'stolen'), N.DRAG_NONCE, known), null, 'a foreign nonce is rejected')

  const ws = { id: 'w1', name: 'W', cwd: 'C:\\repo', panes: [{ id: 'p1', type: 'claude', title: 'Claude 2', worktree: { path: 'C:\\wt\\sn-claude-3f2a' } }, { id: 'p2', type: 'shell', title: 'Shell' }] }
  same(C.panelTargets(ws), [{ key: 'ws:w1' }, { key: 'pane:p1', paneTitle: 'Claude 2' }], 'targets: the workspace and each pane worktree')
  same(C.panelTargets({ ...ws, cwd: '' }), [{ key: 'pane:p1', paneTitle: 'Claude 2' }], 'a workspace without cwd has no workspace target')
  same([C.workspaceOfKey([ws], 'ws:w1'), C.workspaceOfKey([ws], 'pane:p2'), C.workspaceOfKey([ws], 'ws:gone'), C.workspaceOfKey([ws], 'bogus')], ['w1', 'w1', null, null], 'workspace of a target key')

  const K = (key, mods = {}) => ({ key, code: mods.code ?? '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods })
  same(['F7', 'F7', 'ArrowDown', 'ArrowUp', 'z', 'Escape'].map((k, i) => C.panelKeyOf(K(k, [{}, { shiftKey: true }, { altKey: true }, { altKey: true }, { altKey: true, code: 'KeyZ' }, {}][i]))), ['nextHunk', 'prevHunk', 'nextFile', 'prevFile', 'wrap', 'close'], 'panel keys: F7, Shift+F7, Alt+Down, Alt+Up, Alt+Z, Esc')
  check(C.panelKeyOf(K('\u03a9', { altKey: true, code: 'KeyZ' })) === 'wrap', 'Alt+Z by its physical key on other layouts')
  same([K('F7', { ctrlKey: true }), K('ArrowDown'), K('z'), K('Escape', { shiftKey: true }), K('F8')].map((e) => C.panelKeyOf(e)), [null, null, null, null, null], 'other keys stay with the list or the app')
  same([C.stepHunk(-1, 5, 1), C.stepHunk(-1, 5, -1), C.stepHunk(0, 5, 1), C.stepHunk(4, 5, 1), C.stepHunk(0, 5, -1), C.stepHunk(-1, 0, 1)], [0, 4, 1, 4, 0, -1], 'hunk walk clamps and starts from either end')
  const hunks = [{ header: '@@ -1 +1 @@', lines: [{ kind: 'del', text: 'a' }, { kind: 'add', text: 'b' }] }, { header: '', lines: [{ kind: 'meta', text: 'old mode' }] }, { header: '@@ -9 +9 @@', lines: [{ kind: 'ctx', text: 'c' }] }]
  const dr = C.diffRows(hunks)
  same(dr.map((r) => r.type + r.hunk), ['hunk0', 'line0', 'line0', 'line1', 'hunk2', 'line2'], 'flat rows; a headerless hunk has no header row')
  same(C.hunkStarts(dr), [0, 3, 4], 'row index of each hunk')
  same(C.chunkRanges(2000), [[0, 2000]], 'up to 2000 rows: one chunk')
  same(C.chunkRanges(2001), [[0, 500], [500, 1000], [1000, 1500], [1500, 2000], [2000, 2001]], 'over 2000 rows: chunks of 500')
  const mem = { v: null, getItem: (k) => (k === C.WRAP_STORAGE_KEY ? mem.v : null), setItem: (k, v) => { mem.v = v } }
  check(C.loadWrap(mem) === false, 'wrap defaults off')
  C.saveWrap(mem, true)
  check(C.loadWrap(mem) === true, 'wrap is remembered')
  const thrower = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
  check(C.loadWrap(thrower) === false && C.loadWrap(null) === false, 'blocked or missing storage reads as off')
  C.saveWrap(thrower, true)
  check(true, 'blocked storage never throws on save')

  // Keymap and i18n.
  const km = load('src/renderer/lib/keymap.ts')
  const map = km.resolveKeymap({})
  check(map.toggleChanges === 'Ctrl+Shift+D' && map.globalPrompt === 'Ctrl+Shift+G', 'toggleChanges is Ctrl+Shift+D; Ctrl+Shift+G stays globalPrompt')
  const accels = km.KEY_ACTIONS.map((a) => a.defaultAccel)
  check(new Set(accels).size === accels.length, 'no two default actions share a key')
  check(km.resolveKeymap({ toggleChanges: 'Ctrl+Alt+D' }).toggleChanges === 'Ctrl+Alt+D', 'toggleChanges is remappable')
  const { en } = load('src/renderer/i18n/en.ts')
  const { es } = load('src/renderer/i18n/es.ts')
  const keys = Object.keys(en).filter((k) => k.startsWith('changes.'))
  check(keys.length >= 50 && keys.every((k) => typeof es[k] === 'string' && es[k].length > 0), `every changes.* string exists in es and en (${keys.length})`)
  check(typeof en['keys.toggleChanges'] === 'string' && typeof es['keys.toggleChanges'] === 'string', 'the action has its label')
  check(['conflict', 'staged', 'unstaged', 'untracked'].every((a) => en[`changes.section.${a}`]) && ['M', 'A', 'D', 'R', 'C', 'T', 'U', '?'].every((s) => en[`changes.status.${s}`]) && ['not_repo', 'git_missing', 'git_old', 'unsafe_repo', 'timeout', 'git_error'].every((e) => en[`changes.err.${e}`]), 'section, status and error labels cover every value')
  check(es['changes.viewChanges'] === 'Ver cambios' && es['changes.gone'] === 'El archivo ya no tiene cambios' && es['changes.binary'] === 'Archivo binario', 'Spanish copy per E7')

  console.log(`PASS: ${checks} changes panel checks (diff parser, untracked, path validation, open allowlist, ChangesReader fakes + real repos, textconv/ext-diff guard, sections, keys, rows, chunks, wrap, drag paths, keymap, i18n)`)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
