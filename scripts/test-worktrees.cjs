// Worktree per console (E7-FR-27..32, FR-36): WorktreeService + WorktreeManifest
// on real repositories in os.tmpdir() (create with .env copy and node_modules
// junction, branch_exists leaves the branch alone, rollback of a failed step,
// remove that never follows the junction, not_managed guards, unlink failure
// aborting before anything else, orphans by scan), "main -N" (inspect's
// behindMain and GitService's mainBehind, counted only when the tip or the
// main HEAD moved), a remove refused while another pane of the saved config
// runs in the folder ('shared'), schema 13 round trip,
// PtyManager's cwd_missing, and the renderer side (offer rules, close routing,
// the phone's closePane keeping folder and branch), and the team task owner of
// app 2.7.0 B4 (manifest owner, teamOwned in list, the IPC remove refused, the
// owner's remove, disown, never an orphan, a create landing while list() adopts
// its folder keeps its owner). Bundled with esbuild and
// run in a vm like test-git.cjs; git runs with an isolated config. Nothing
// outside the temp tree is touched.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
function same(actual, expected, label) { assert.deepEqual(JSON.parse(JSON.stringify(actual ?? null)), JSON.parse(JSON.stringify(expected)), label); checks++ }
const EXTERNAL = ['electron', 'ws', 'node-pty', '@xterm/headless', '@xterm/addon-serialize', '@xterm/addon-unicode11']
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: EXTERNAL, alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, crypto: globalThis.crypto, setTimeout, clearTimeout, ...overrides })
  return mod.exports
}
function loadRenderer(contents, overrides = {}) {
  const code = buildSync({ stdin: { contents, resolveDir: path.join(root, 'src/renderer/lib'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, crypto: globalThis.crypto, setTimeout, clearTimeout, setImmediate, ...overrides })
  return mod.exports
}

const shared = load('src/shared/worktree-types.ts')
// deleteNeedsAck is pure; bundled alone so the real repo block can use it before the renderer checks.
const r_deleteBlockProbe = (info, branch) => loadRenderer(`export { deleteBlock } from './worktrees'`, { window: { snApi: {} }, document: { hasFocus: () => true, querySelector: () => null } }).deleteBlock(info, branch)
const r_deleteNeedsAckProbe = (info) => loadRenderer(`export { deleteNeedsAck } from './worktrees'`, { window: { snApi: {} }, document: { hasFocus: () => true, querySelector: () => null } }).deleteNeedsAck(info)
// What the close dialog and the race send back to main from an inspect (the real renderer rule).
const r_removeExpectations = loadRenderer(`export { removeExpectations } from './worktrees'`, { window: { snApi: {} }, document: { hasFocus: () => true, querySelector: () => null } }).removeExpectations
// The checkbox "may lose work" the dialog adds once ticked (ackIncomplete).
const r_ackFields = loadRenderer(`export { ackFields } from './worktrees'`, { window: { snApi: {} }, document: { hasFocus: () => true, querySelector: () => null } }).ackFields
const W = load('src/main/git/WorktreeService.ts')
const M = load('src/main/git/WorktreeManifest.ts')
const gx = load('src/main/git/gitExec.ts')
const { parseConfig } = load('src/main/store/schema.ts')

// --- Pure helpers ------------------------------------------------------------
check(['claude-3f2a', 'a', 'x-1-2', 'a'.repeat(40)].every(shared.isValidSlug), 'valid slugs')
check(!['', 'A', 'a b', '../x', 'a/b', 'a'.repeat(41), 'ñ', null, 3].some(shared.isValidSlug), 'invalid slugs (case, space, slash, length, non ASCII, non string)')
// The repo root comes from git on the host, so the helper uses the host's path
// flavor; a Windows or POSIX path is named here with an explicit platform, so
// every case runs on every OS.
const winFolder = (p) => W.repoFolderName(p, { platform: 'win32' })
const f1 = winFolder('C:\\Users\\tarno\\Desktop\\Mi Repo')
check(/^Mi-Repo-[0-9a-f]{6}$/.test(f1), `repo folder is <name>-<hash6> (${f1})`)
check(f1 === `Mi-Repo-${require('node:crypto').createHash('sha1').update('c:\\users\\tarno\\desktop\\mi repo').digest('hex').slice(0, 6)}`, 'the hash is of the lower-cased resolved path, as before (existing folders keep their name)')
check(f1.toLowerCase() === winFolder('c:\\users\\TARNO\\desktop\\mi repo\\').toLowerCase() && f1 === winFolder('C:/Users/tarno/Desktop/Mi Repo'), 'same repo, same folder, whatever the spelling (Windows: case, trailing slash, slashes)')
check(winFolder('C:\\a\\repo') !== winFolder('C:\\b\\repo'), 'two repos of one name get different folders')
const f2 = W.repoFolderName('/home/u/Mi Repo', { platform: 'linux' })
check(/^Mi-Repo-[0-9a-f]{6}$/.test(f2) && f2 !== W.repoFolderName('/home/u/mi repo', { platform: 'linux' }), `POSIX: <name>-<hash6>, and case is part of the path on Linux (${f2})`)
check(W.repoFolderName('/Users/u/Mi Repo', { platform: 'darwin' }).toLowerCase() === W.repoFolderName('/users/U/mi repo/', { platform: 'darwin' }).toLowerCase(), 'macOS folds case like its default filesystem')
check(W.repoFolderName('/x/C:\\odd', { platform: 'linux' }).startsWith('C--odd-'), 'a backslash is a name character on POSIX, not a separator')
same(W.parseWorktreeList('worktree C:/r\nHEAD abc\nbranch refs/heads/main\n\nworktree C:/w/x\nHEAD def\nbranch refs/heads/sn/x\nprunable gitdir file points to non-existent location\n\nworktree C:/w/d\nHEAD 123\ndetached\n'), [
  { path: 'C:/r', branch: 'refs/heads/main', prunable: false },
  { path: 'C:/w/x', branch: 'refs/heads/sn/x', prunable: true },
  { path: 'C:/w/d', branch: null, prunable: false },
], 'worktree list --porcelain: path, branch, prunable, detached')
const winGitFile = (c, p) => W.repoRootFromGitFile(c, p, 'win32')
check(winGitFile('gitdir: C:/Users/x/repo/.git/worktrees/claude-1\n', 'C:\\wt\\repo-abc123\\claude-1') === 'C:\\Users\\x\\repo', 'the .git file of a linked worktree names its repo')
check(winGitFile('gitdir: //server/share/repo/.git/worktrees/a\n', '\\\\server\\share\\wt\\r-1\\a') === '\\\\server\\share\\repo', 'a repo on a UNC share keeps its \\\\server prefix')
check(winGitFile('gitdir: C:/x/repo/.git\n', 'C:\\wt') === null && winGitFile('nope', 'C:\\wt') === null && winGitFile('gitdir: C:/bare.git/worktrees/a', 'C:\\wt') === null, 'a submodule, junk or a bare repo is not a linked worktree of a checkout')
check(W.repoRootFromGitFile('gitdir: /home/u/repo/.git/worktrees/claude-1\n', '/data/wt/repo-abc123/claude-1', 'linux') === '/home/u/repo', 'POSIX: the same, with POSIX paths')
check(W.repoRootFromGitFile('gitdir: ../../../repo/.git/worktrees/claude-1\n', '/data/wt/repo-abc123/claude-1', 'linux') === '/data/repo', 'a relative gitdir (worktree.useRelativePaths) resolves from the worktree')
check(W.repoRootFromGitFile('gitdir: /home/u/a\\b/.git/worktrees/x\n', '/wt/r/x', 'darwin') === '/home/u/a\\b' && W.repoRootFromGitFile('gitdir: /.git/worktrees/x\n', '/wt/r/x', 'linux') === '/', 'POSIX: a backslash stays in the name; a repo at / still resolves')
const sha = 'a'.repeat(40)
same(shared.paneWorktreeOf({ path: 'C:\\w', branch: 'sn/x', repoName: 'r', dirty: false, managed: true, exists: true, repoRoot: 'C:\\r', base: sha }), { repoRoot: 'C:\\r', path: 'C:\\w', branch: 'sn/x', base: sha }, 'a managed row rebuilds pane.worktree')
check(shared.paneWorktreeOf({ path: 'C:\\w', branch: 'feat', repoName: 'r', dirty: false, managed: false, exists: true, repoRoot: 'C:\\r', base: sha }) === null, 'an unmanaged row never becomes a pane worktree')

// --- Schema 13 ---------------------------------------------------------------
{
  const baseSettings = { defaultShell: {}, fontFamily: 'mono', fontSize: 13, scrollback: 1000, restoreLastWorkspace: true, confirmCloseRunning: true, sidebarCollapsed: false }
  const wt = { repoRoot: 'C:\\repo', path: 'C:\\data\\worktrees\\repo-abc123\\claude-1', branch: 'sn/claude-1', base: sha }
  const raw = {
    version: 12,
    workspaces: [{ id: 'w1', name: 'W', cwd: 'C:\\repo', panes: [
      { id: 'p1', type: 'claude', title: 'Claude · claude-1', color: '#fff', icon: 'claude', cwd: wt.path, worktree: wt },
      { id: 'p2', type: 'shell', title: 'Bad', color: '#fff', icon: 'terminal', worktree: { ...wt, branch: 'main' } },
      { id: 'p3', type: 'shell', title: 'Junk', color: '#fff', icon: 'terminal', worktree: 'nope' },
    ] }],
    presets: [],
    settings: { ...baseSettings, worktreesRoot: 'D:\\wt' },
  }
  const cfg = parseConfig(raw)
  same(cfg.workspaces[0].panes[0].worktree, wt, 'pane.worktree survives a parse (zod would drop an unknown key)')
  check(cfg.workspaces[0].panes[1].worktree === undefined && cfg.workspaces[0].panes[2].worktree === undefined && cfg.workspaces[0].panes.length === 3, 'a non sn/ branch or junk drops only the field, not the pane or the config')
  check(cfg.settings.worktreesRoot === 'D:\\wt', 'settings.worktreesRoot kept')
  const again = parseConfig(JSON.parse(JSON.stringify(cfg)))
  same(again.workspaces[0].panes[0].worktree, wt, 'save -> reload keeps the worktree')
  check(parseConfig({ ...raw, settings: baseSettings }).settings.worktreesRoot === '' && parseConfig({ ...raw, settings: { ...baseSettings, worktreesRoot: 5 } }).settings.worktreesRoot === '', 'missing or junk worktreesRoot defaults to empty (= dataDir()/worktrees)')
}

// --- Manifest ----------------------------------------------------------------
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'snaos-wt-'))
// git prints realpaths (8.3 names expanded, links resolved: CI's TEMP is
// C:\Users\RUNNER~1\..., macOS's tmpdir is /var -> /private/var), while base
// keeps os.tmpdir()'s spelling. Locations are compared through canon(), the
// test's own realpath; equal strings are never assumed.
function canon(p) {
  const rest = []
  let cur = path.resolve(p)
  for (;;) {
    try {
      const r = path.join(fs.realpathSync.native(cur), ...rest.reverse())
      return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return path.resolve(p)
      rest.push(path.basename(cur))
      cur = parent
    }
  }
}
// A second spelling of base on every machine (a junction on Windows, a
// symlink elsewhere), so the spelling checks run even where TEMP has no alias.
let alias = path.join(os.tmpdir(), `snaos-wt-alias-${process.pid}-${Date.now()}`)
try { fs.symlinkSync(base, alias, 'junction') } catch (e) { console.log(`NOTE: no link alias for base (${e.code}), link spelling checks skipped`); alias = null }
// Removed as a link (never followed into base) however the run ends, a failed top-level check included.
process.on('exit', () => { try { if (alias) fs.unlinkSync(alias) } catch { /* already gone */ } })
{
  const file = path.join(base, 'mf', 'worktrees.json')
  const m = new M.WorktreeManifest(file)
  check(m.list().length === 0, 'missing manifest reads empty')
  const entry = { path: 'C:\\Data\\WT\\repo-1\\a', branch: 'sn/a', repoRoot: 'C:\\repo', baseRef: 'HEAD', baseSha: sha, linkedPaths: [], root: 'C:\\Data\\WT', createdAt: 1 }
  m.put(entry)
  check(fs.existsSync(file) && !fs.existsSync(file + '.tmp'), 'written atomically (no tmp left behind)')
  check(new M.WorktreeManifest(file).find(process.platform === 'win32' ? 'c:\\data\\wt\\REPO-1\\a\\' : entry.path) !== null, 'find compares paths like the filesystem')
  m.put({ ...entry, baseSha: 'b'.repeat(40) })
  check(new M.WorktreeManifest(file).list().length === 1, 'put replaces the entry of the same path')
  if (alias) {
    const viaBase = path.join(base, 'mf', 'r-1', 'a')
    const viaAlias = path.join(alias, 'mf', 'r-1', 'a')
    m.put({ ...entry, path: viaBase })
    check(new M.WorktreeManifest(file).find(viaAlias) !== null && new M.WorktreeManifest(file).find(viaAlias).path === viaBase, 'find matches another spelling of the folder (8.3 name, link, /private/var)')
    m.put({ ...entry, path: viaAlias })
    check(new M.WorktreeManifest(file).list().length === 2, 'put through another spelling replaces, never duplicates')
    check(m.remove(viaBase) && new M.WorktreeManifest(file).list().length === 1, 'remove through another spelling')
  }
  fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [entry, { ...entry, path: 'C:\\x', branch: 'main' }, 'junk'] }))
  check(new M.WorktreeManifest(file).list().length === 1, 'an entry on a non sn/ branch or junk is dropped one by one')
  fs.writeFileSync(file, '{broken')
  check(new M.WorktreeManifest(file).list().length === 0, 'a corrupt manifest reads empty')
  check(m.remove(entry.path) && !new M.WorktreeManifest(file).find(entry.path), 'remove drops the entry')
}

// --- Real repositories ---------------------------------------------------------
let gitOk = true
try { execFileSync('git', ['--version'], { stdio: 'ignore' }) } catch { gitOk = false }

async function realRepoChecks() {
  const cleanEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(base, 'gitconfig') }
  fs.writeFileSync(cleanEnv.GIT_CONFIG_GLOBAL, '[core]\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n')
  for (const k of Object.keys(cleanEnv)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE)$/i.test(k)) delete cleanEnv[k]
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
  const gitOkSync = (cwd, ...args) => { try { git(cwd, ...args); return true } catch { return false } }
  const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s) }
  const runner = gx.createGitRunner({ env: () => gx.gitEnv(cleanEnv) })
  const listed = (repo) => git(repo, 'worktree', 'list', '--porcelain').split(/\r?\n/).filter((l) => l.startsWith('worktree ')).map((l) => canon(l.slice(9)))

  const repo = path.join(base, 'repo')
  write(path.join(repo, 'src', 'app.js'), 'console.log(1)\n')
  write(path.join(repo, '.gitignore'), '.env\n.env.local\n')
  write(path.join(repo, 'tracked.env.txt'), 'x\n')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init')
  const head = git(repo, 'rev-parse', 'HEAD').trim()
  write(path.join(repo, '.env'), 'SECRET=1\n')
  write(path.join(repo, '.env.local'), 'LOCAL=1\n')
  const sentinel = path.join(repo, 'node_modules', 'pkg', 'sentinel.txt')
  write(sentinel, 'keep me\n')
  write(path.join(repo, 'dirty-in-main.txt'), 'not copied\n')

  const wtRoot = path.join(base, 'data', 'worktrees')
  const defRoot = path.join(base, 'data', 'worktrees')
  const mfFile = path.join(base, 'data', 'worktrees.json')
  const make = (over = {}) => {
    const kills = []
    const manifest = over.manifest ?? new M.WorktreeManifest(mfFile)
    const s = new W.WorktreeService({ runner, manifest, root: () => over.root ?? wtRoot, defaultRoot: () => defRoot, killPane: async (id) => { kills.push(id) }, removeOptions: { delayMs: 0, retries: 1 }, ...(over.deps ?? {}) })
    return { s, kills, manifest }
  }
  const { s, kills, manifest } = make()

  // Probe (FR-27 dialog).
  const pr = await s.probe(repo)
  check(pr.ok && pr.head === head && pr.headShort === head.slice(0, 7) && pr.repoName === 'repo', 'probe: HEAD and repo name')
  const plain = path.join(base, 'plain'); fs.mkdirSync(plain)
  const empty = path.join(base, 'empty'); fs.mkdirSync(empty); git(empty, 'init', '-q', '-b', 'main')
  same(await s.probe(plain), { ok: false, error: 'not_repo' }, 'probe: a folder without repo')
  same(await s.probe(empty), { ok: false, error: 'unborn' }, 'probe: a repo without commits')
  same(await s.probe('relative\\x'), { ok: false, error: 'not_repo' }, 'probe: a relative path is refused')

  // Create with .env + junction (FR-28).
  const res = await s.create({ repoCwd: path.join(repo, 'src'), slug: 'claude-ab12', copyEnv: true, linkNodeModules: true })
  check(res.ok, `create ok (${JSON.stringify(res)})`)
  const wt = res.worktree
  const folder = W.repoFolderName(repo)
  check(canon(wt.path) === canon(path.join(wtRoot, folder, 'claude-ab12')), `created at <root>/<repo>-<hash6>/<slug> (${wt.path})`)
  check(wt.path === fs.realpathSync.native(wt.path) && wt.repoRoot === fs.realpathSync.native(repo), `pane.worktree is spelled as git spells it, the realpath (${wt.path}, ${wt.repoRoot})`)
  check(wt.branch === 'sn/claude-ab12' && wt.base === head && canon(wt.repoRoot) === canon(repo), 'pane.worktree: branch sn/<slug>, base sha, repoRoot (from a subfolder)')
  check(!gitOkSync(repo, 'rev-parse', '--abbrev-ref', 'sn/claude-ab12@{upstream}'), 'the branch has no upstream (--no-track)')
  check(fs.readFileSync(path.join(wt.path, '.env'), 'utf8') === 'SECRET=1\n' && fs.existsSync(path.join(wt.path, '.env.local')), '.env and .env.local copied')
  check(!fs.existsSync(path.join(wt.path, 'dirty-in-main.txt')), 'uncommitted files of the main checkout are not copied')
  check(fs.lstatSync(path.join(wt.path, 'node_modules')).isSymbolicLink() && fs.existsSync(path.join(wt.path, 'node_modules', 'pkg', 'sentinel.txt')), 'node_modules is a junction to the repo')
  const ent = manifest.find(wt.path)
  check(ent && ent.branch === 'sn/claude-ab12' && ent.baseSha === head && ent.baseRef === 'HEAD' && ent.linkedPaths.length === 1 && canon(path.dirname(ent.linkedPaths[0])) === canon(wt.path),'manifest entry with baseRef, baseSha and the junction')
  check(fs.existsSync(mfFile), 'the manifest is dataDir()/worktrees.json')

  // Inspect (FR-30 / 36).
  same(await s.inspect({ path: wt.path }), { exists: true, dirtyFiles: 0, commitsAhead: 0, mergedIntoHead: true, tip: head, headBranch: 'sn/claude-ab12', behindMain: 0 }, 'inspect clean: our own junction and the ignored .env are not dirty; the tip and the checked out branch; main is not ahead')
  write(path.join(wt.path, 'new.txt'), 'n\n')
  write(path.join(wt.path, 'src', 'app.js'), 'console.log(2)\n')
  same(await s.inspect({ path: wt.path }), { exists: true, dirtyFiles: 2, commitsAhead: 0, mergedIntoHead: true, tip: head, headBranch: 'sn/claude-ab12', behindMain: 0 }, 'inspect dirty: 2 files')
  git(wt.path, 'add', 'src/app.js'); git(wt.path, 'commit', '-qm', 'work')
  const wtTip = git(wt.path, 'rev-parse', 'HEAD').trim()
  same(await s.inspect({ path: wt.path }), { exists: true, dirtyFiles: 1, commitsAhead: 1, mergedIntoHead: false, tip: wtTip, headBranch: 'sn/claude-ab12', behindMain: 0 }, 'inspect: 1 commit over the base, not merged, the tip moved with it (main still has nothing it lacks)')
  const blind = make({ deps: { runner: { run: (args, o) => (args.includes('status') ? Promise.reject(Object.assign(new Error('fatal: unsafe repository'), { code: 'unsafe_repo' })) : runner.run(args, o)) } } })
  same(await blind.s.inspect({ path: wt.path }), { exists: true, dirtyFiles: 0, commitsAhead: 1, mergedIntoHead: false, incomplete: true, tip: wtTip, headBranch: 'sn/claude-ab12', behindMain: 0 }, 'inspect: a git status that fails is incomplete, never a silent clean')
  check(r_deleteNeedsAckProbe({ exists: true, dirtyFiles: 0, commitsAhead: 0, mergedIntoHead: true, incomplete: true }), 'an incomplete inspect still requires the checkbox')
  // The dirty count goes back to main whenever git status was read, not only on a complete inspect.
  const tipX = 'a'.repeat(40)
  same(r_removeExpectations({ exists: true, dirtyFiles: 2, commitsAhead: 0, mergedIntoHead: true, tip: tipX }), { expectTip: tipX, expectDirty: 2 }, 'a complete inspect sends tip and dirty count')
  same(r_removeExpectations({ exists: true, dirtyFiles: 3, commitsAhead: 0, mergedIntoHead: false, incomplete: true, dirtyRead: true, tip: tipX }), { expectTip: tipX, expectDirty: 3 }, 'incomplete for another reason (base, rev-list) but status read: the count is still sent')
  same(r_removeExpectations({ exists: true, dirtyFiles: 0, commitsAhead: 1, mergedIntoHead: false, incomplete: true, tip: tipX }), { expectTip: tipX }, 'an unread status (incomplete without dirtyRead) sends no count, so a failing status never loops on changed')
  same(r_removeExpectations({ exists: true, dirtyFiles: 0, commitsAhead: 0, mergedIntoHead: false, incomplete: true }), {}, "the dialog's own fallback (inspect threw) sends nothing")
  same(r_removeExpectations({ exists: false, dirtyFiles: 0, commitsAhead: 2, mergedIntoHead: false, tip: tipX }), { expectTip: tipX }, 'a gone folder sends only the tip')
  same(await s.inspect({ path: path.join(base, 'nope') }), { exists: false, dirtyFiles: 0, commitsAhead: 0, mergedIntoHead: false }, 'inspect of a missing folder')
  same(await s.inspect({ path: 'rel' }), { exists: false, dirtyFiles: 0, commitsAhead: 0, mergedIntoHead: false }, 'inspect of a relative path')

  // Duplicate from a worktree pane lands in the main repo.
  const dup = await s.create({ repoCwd: wt.path, slug: 'dup-1', copyEnv: false, linkNodeModules: false })
  check(dup.ok && canon(dup.worktree.repoRoot) === canon(repo) && canon(path.dirname(dup.worktree.path)) === canon(path.join(wtRoot, folder)),'a worktree as repoCwd resolves to the main checkout')
  check(!fs.existsSync(path.join(dup.worktree.path, '.env')) && !fs.existsSync(path.join(dup.worktree.path, 'node_modules')), 'copyEnv/linkNodeModules off: nothing copied or linked')

  // Refusals that touch nothing.
  git(repo, 'branch', 'sn/taken', head)
  const before = git(repo, 'rev-parse', 'refs/heads/sn/taken').trim()
  same(await s.create({ repoCwd: repo, slug: 'taken', copyEnv: true, linkNodeModules: true }), { ok: false, error: 'branch_exists' }, 'an existing sn/<slug> is branch_exists')
  check(git(repo, 'rev-parse', 'refs/heads/sn/taken').trim() === before && !fs.existsSync(path.join(wtRoot, folder, 'taken')), 'the pre-existing branch keeps its sha and no folder appears')
  fs.mkdirSync(path.join(wtRoot, folder, 'occupied'), { recursive: true })
  same(await s.create({ repoCwd: repo, slug: 'occupied', copyEnv: false, linkNodeModules: false }), { ok: false, error: 'path_exists' }, 'an existing folder is path_exists')
  check(!gitOkSync(repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/sn/occupied'), 'path_exists creates no branch')
  for (const bad of ['Bad', '../x', 'a b', 'a'.repeat(41), '']) same(await s.create({ repoCwd: repo, slug: bad, copyEnv: false, linkNodeModules: false }), { ok: false, error: 'bad_slug' }, `bad slug ${JSON.stringify(bad)}`)
  same(await make({ root: path.join(repo, 'inner') }).s.create({ repoCwd: repo, slug: 'x1', copyEnv: false, linkNodeModules: false }), { ok: false, error: 'root_inside_repo' }, 'a root inside the repo is refused')
  check(!fs.existsSync(path.join(repo, 'inner')), 'root_inside_repo writes nothing in the repo')
  same(await s.create({ repoCwd: plain, slug: 'x2', copyEnv: false, linkNodeModules: false }), { ok: false, error: 'not_repo' }, 'not_repo')
  same(await s.create({ repoCwd: empty, slug: 'x3', copyEnv: false, linkNodeModules: false }), { ok: false, error: 'unborn' }, 'unborn')
  same(await s.create({ repoCwd: repo, slug: 'x4', base: 'HEAD; rm', copyEnv: false, linkNodeModules: false }), { ok: false, error: 'git_error', detail: 'bad_base' }, 'a base that is not a sha is refused')
  const fromBase = await s.create({ repoCwd: repo, slug: 'from-base', base: head.slice(0, 10), copyEnv: false, linkNodeModules: false })
  check(fromBase.ok && fromBase.worktree.base === head, 'an explicit base sha (race) resolves to the full sha')

  // Rollback: a failed .env copy undoes the new worktree and branch only.
  const failing = make({ deps: { fs: { ...fs.promises, copyFile: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) } } } })
  const rb = await failing.s.create({ repoCwd: repo, slug: 'rollback-1', copyEnv: true, linkNodeModules: true })
  check(!rb.ok && rb.error === 'git_error', `a failed step reports git_error (${JSON.stringify(rb)})`)
  const rbPath = path.join(wtRoot, folder, 'rollback-1')
  check(!fs.existsSync(rbPath) && !gitOkSync(repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/sn/rollback-1') && !listed(repo).includes(canon(rbPath)) && !manifest.find(rbPath), 'rollback removed folder, branch, git record and manifest entry')
  check(fs.existsSync(sentinel) && git(repo, 'rev-parse', 'refs/heads/sn/taken').trim() === before, 'rollback left the repo node_modules and other branches alone')

  // Remove guards (FR-30): not_managed touches nothing.
  same(await s.remove({ path: repo, deleteBranch: true }), { ok: false, error: 'not_managed', detail: 'manifest' }, 'the repo itself is not_managed')
  same(await s.remove({ path: 'relative', deleteBranch: true }), { ok: false, error: 'not_managed', detail: 'path' }, 'a relative path is not_managed')
  const foreign = path.join(wtRoot, folder, 'foreign')
  git(repo, 'worktree', 'add', '-q', '-b', 'feat', foreign, head)
  same(await s.remove({ path: foreign, deleteBranch: true }), { ok: false, error: 'not_managed', detail: 'manifest' }, 'a worktree under the root the app did not create is not_managed')
  manifest.put({ path: foreign, branch: 'sn/foreign', repoRoot: repo, baseRef: 'HEAD', baseSha: head, linkedPaths: [], root: wtRoot, createdAt: 1 })
  same(await s.remove({ path: foreign, deleteBranch: true }), { ok: false, error: 'not_managed', detail: 'branch_mismatch' }, 'a branch other than the recorded sn/ one is not_managed')
  check(fs.existsSync(foreign) && gitOkSync(repo, 'rev-parse', '--verify', 'refs/heads/feat'), 'not_managed left the folder and the branch')
  manifest.remove(foreign)
  const tooDeep = path.join(wtRoot, folder, 'a', 'b')
  manifest.put({ path: tooDeep, branch: 'sn/deep', repoRoot: repo, baseRef: 'HEAD', baseSha: head, linkedPaths: [], root: wtRoot, createdAt: 1 })
  same(await s.remove({ path: tooDeep, deleteBranch: true }), { ok: false, error: 'not_managed', detail: 'root' }, 'a path not exactly <root>/<repo>/<slug> is not_managed')
  manifest.remove(tooDeep)
  const outside = path.join(base, 'elsewhere', 'r', 's')
  manifest.put({ path: outside, branch: 'sn/s', repoRoot: repo, baseRef: 'HEAD', baseSha: head, linkedPaths: [], root: '', createdAt: 1 })
  same(await s.remove({ path: outside, deleteBranch: true }), { ok: false, error: 'not_managed', detail: 'root' }, 'a manifest path outside every root is not_managed')
  manifest.remove(outside)

  // What the close dialog sends back: the inspect the user saw.
  const seen = async (svc, p) => r_removeExpectations(await svc.inspect({ path: p }))

  // Unlink failure aborts before anything else (FR-30 acceptance).
  let treeCalls = 0
  const noUnlink = make({ deps: { fs: { ...fs.promises, unlink: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) }, rmdir: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) } }, removeTree: async () => { treeCalls++; return 'done' } } })
  same(await noUnlink.s.remove({ path: wt.path, paneId: 'p1', deleteBranch: true, ...(await seen(s, wt.path)) }), { ok: false, error: 'unlink_failed', detail: 'EACCES' }, 'a junction that cannot be unlinked is unlink_failed')
  check(treeCalls === 0 && fs.existsSync(wt.path) && listed(repo).includes(canon(wt.path)) && gitOkSync(repo, 'rev-parse', '--verify', 'refs/heads/sn/claude-ab12') && manifest.find(wt.path), 'unlink_failed: no folder delete, no git, no branch, entry kept')

  // Busy: files still locked after the retries.
  const busy = make({ deps: { removeTree: async () => ({ deferred: 'EBUSY' }) } })
  const dupBusy = await busy.s.remove({ path: dup.worktree.path, deleteBranch: true })
  same(dupBusy, { ok: false, error: 'busy', detail: 'EBUSY' }, 'locked files after the retries are busy')
  check(manifest.find(dup.worktree.path) && gitOkSync(repo, 'rev-parse', '--verify', 'refs/heads/sn/dup-1'), 'busy keeps the branch and the entry (Retry works)')

  // The delete race (FR-30): the dialog's inspect can be stale by the click.
  const branchAt = (b) => (gitOkSync(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${b}`) ? git(repo, 'rev-parse', `refs/heads/${b}`).trim() : '')
  const commitIn = (dir, file, text, msg) => { write(path.join(dir, file), text); git(dir, 'add', file); git(dir, 'commit', '-qm', msg); return git(dir, 'rev-parse', 'HEAD').trim() }
  {
    // An agent commits after the dialog opened: here while its pty is being killed, the latest moment.
    const race1 = (await s.create({ repoCwd: repo, slug: 'race-1', copyEnv: false, linkNodeModules: false })).worktree
    const saw = await seen(s, race1.path)
    check(saw.expectTip === head && saw.expectDirty === 0, 'the dialog saw a clean worktree at the base')
    let late = ''
    const racing = make({ deps: { killPane: async () => { late = commitIn(race1.path, 'late.txt', 'late\n', 'late work') } } })
    same(await racing.s.remove({ path: race1.path, paneId: 'pr', deleteBranch: true, ...saw }), { ok: false, error: 'changed', detail: 'tip' }, 'a commit after the inspect is changed, read once the pty is gone')
    check(branchAt('sn/race-1') === late && fs.existsSync(race1.path) && manifest.find(race1.path), 'changed: branch at the new commit, folder and entry kept')
    // New files after the inspect.
    write(path.join(race1.path, 'scratch.txt'), 's\n')
    same(await s.remove({ path: race1.path, deleteBranch: true, ...saw, expectTip: late }), { ok: false, error: 'changed', detail: 'dirty' }, 'more uncommitted files than the inspect showed is changed')
    check(fs.existsSync(path.join(race1.path, 'scratch.txt')) && branchAt('sn/race-1') === late, 'and nothing was deleted')
    same(await s.remove({ path: race1.path, deleteBranch: true, expectTip: 'HEAD' }), { ok: false, error: 'git_error', detail: 'bad_expect' }, 'an expectTip that is not a full sha is refused')
    same(await s.remove({ path: race1.path, deleteBranch: true, expectDirty: -1 }), { ok: false, error: 'git_error', detail: 'bad_expect' }, 'a negative expectDirty is refused')
    // No expectation (a caller that never inspected): only what loses nothing goes.
    same(await s.remove({ path: race1.path, deleteBranch: true }), { ok: false, error: 'changed', detail: 'unconfirmed' }, 'without expectations a dirty worktree is not deleted')
    fs.rmSync(path.join(race1.path, 'scratch.txt'))
    same(await s.remove({ path: race1.path, deleteBranch: true }), { ok: false, error: 'changed', detail: 'unconfirmed' }, 'without expectations a branch with unmerged commits is not deleted')
    check(branchAt('sn/race-1') === late && fs.existsSync(race1.path), 'unconfirmed deletes nothing')
    // The dialog reads it again and the user confirms the new state.
    const again = await seen(s, race1.path)
    check(again.expectTip === late && again.expectDirty === 0, 're-inspect sees the late commit')
    check((await s.remove({ path: race1.path, deleteBranch: true, ...again })).ok && !branchAt('sn/race-1') && !fs.existsSync(race1.path) && !manifest.find(race1.path), 'with the fresh expectations the delete goes through')

    // Compare-and-delete: a commit that lands after the recheck keeps the branch.
    const race2 = (await s.create({ repoCwd: repo, slug: 'race-2', copyEnv: false, linkNodeModules: false })).worktree
    const saw2 = await seen(s, race2.path)
    const sneaky = git(repo, 'commit-tree', `${head}^{tree}`, '-p', head, '-m', 'sneaky').trim()
    const sneakRunner = { run: async (args, o) => { if (args.includes('update-ref')) git(repo, 'update-ref', 'refs/heads/sn/race-2', sneaky); return runner.run(args, o) } }
    same(await make({ deps: { runner: sneakRunner } }).s.remove({ path: race2.path, deleteBranch: true, ...saw2 }), { ok: false, error: 'changed', detail: 'tip_after_delete' }, 'update-ref -d compares: a branch that moved after the recheck is not deleted')
    check(branchAt('sn/race-2') === sneaky && !fs.existsSync(race2.path) && manifest.find(race2.path), 'the folder went, the branch keeps the commit, the entry stays for a retry')
    const gone2 = await s.inspect({ path: race2.path })
    check(!gone2.exists && gone2.tip === sneaky, 'a re-inspect of the deleted folder reports the branch tip')
    check(gone2.commitsAhead === 1 && gone2.mergedIntoHead === false && !gone2.incomplete && r_deleteNeedsAckProbe(gone2), `and the commit its branch delete drops, so the dialog asks for the checkbox (${JSON.stringify(gone2)})`)
    same(await s.remove({ path: race2.path, deleteBranch: true, expectTip: head }), { ok: false, error: 'changed', detail: 'tip' }, 'the gone path also compares the tip')
    check(branchAt('sn/race-2') === sneaky && manifest.find(race2.path), 'and keeps branch and entry')
    check((await s.remove({ path: race2.path, deleteBranch: true, expectTip: sneaky })).ok && !branchAt('sn/race-2') && !manifest.find(race2.path), 'confirmed at the new tip, the branch goes')

    // update-ref, unlike branch -D, would delete a checked out branch: main lists the worktrees again first.
    const race3 = (await s.create({ repoCwd: repo, slug: 'race-3', copyEnv: false, linkNodeModules: false })).worktree
    const saw3 = await seen(s, race3.path)
    const other3 = path.join(base, 'other3')
    // Another checkout takes the branch once the folder is gone, before the branch delete.
    const takeover = { run: async (args, o) => { if (args[0] === 'worktree' && args[1] === 'list' && !fs.existsSync(race3.path) && !fs.existsSync(other3)) git(repo, 'worktree', 'add', '-q', other3, 'sn/race-3'); return runner.run(args, o) } }
    same(await make({ deps: { runner: takeover } }).s.remove({ path: race3.path, deleteBranch: true, ...saw3 }), { ok: false, error: 'git_error', detail: 'checked_out' }, 'a branch another worktree has checked out is kept')
    check(branchAt('sn/race-3') === head && fs.existsSync(other3), 'its branch and the other checkout survive')
    git(repo, 'worktree', 'remove', '--force', other3)
    check((await s.remove({ path: race3.path, deleteBranch: true, expectTip: head })).ok && !branchAt('sn/race-3'), 'once free, the retry deletes it')
  }

  // Retry after 'busy' (audit 5): safeRemoveTree goes on past a locked entry,
  // so the folder is left half-deleted. Our own deletions are not new work.
  {
    // `half` deletes part of the tree and reports the lock; null is the real delete.
    let half = null
    const halfTree = async (target) => { if (half) { half(target); return { deferred: 'EBUSY' } } fs.rmSync(target, { recursive: true, force: true }); return 'done' }
    const halfway = make({ manifest, deps: { removeTree: halfTree } })
    const busyRes = { ok: false, error: 'busy', detail: 'EBUSY' }

    // .git survives: the tracked files it took read as deletions.
    const p1 = (await s.create({ repoCwd: repo, slug: 'partial-1', copyEnv: false, linkNodeModules: false })).worktree
    write(path.join(p1.path, 'notes.txt'), 'mine\n')
    const saw1 = await seen(s, p1.path)
    check(saw1.expectTip === head && saw1.expectDirty === 1, 'the dialog saw one uncommitted file')
    half = (t) => { for (const f of ['notes.txt', 'tracked.env.txt', path.join('src', 'app.js')]) fs.rmSync(path.join(t, f), { force: true }) }
    same(await halfway.s.remove({ path: p1.path, deleteBranch: true, ...saw1 }), busyRes, 'a locked entry stops the delete half-way')
    check(fs.existsSync(path.join(p1.path, '.git')) && !fs.existsSync(path.join(p1.path, 'src', 'app.js')) && !fs.existsSync(path.join(p1.path, 'notes.txt')), 'what could go is gone, .git is still there')
    same(await s.remove({ path: p1.path, deleteBranch: true, ...saw1 }), { ok: false, error: 'changed', detail: 'dirty' }, 'a service that did not run that delete (a restart) counts the deletions: it asks again and deletes nothing')
    check(fs.existsSync(p1.path) && branchAt('sn/partial-1') === head, 'and the folder and branch stay')
    write(path.join(p1.path, 'late-1.txt'), 'a\n')
    write(path.join(p1.path, 'late-2.txt'), 'b\n')
    same(await halfway.s.remove({ path: p1.path, deleteBranch: true, ...saw1 }), { ok: false, error: 'changed', detail: 'dirty' }, 'files written after the half delete are still new work on Retry')
    check(fs.existsSync(path.join(p1.path, 'late-1.txt')) && fs.existsSync(path.join(p1.path, 'late-2.txt')), 'and they are kept')
    fs.rmSync(path.join(p1.path, 'late-1.txt'))
    fs.rmSync(path.join(p1.path, 'late-2.txt'))
    half = null
    const retry1 = await halfway.s.remove({ path: p1.path, deleteBranch: true, ...saw1 })
    check(retry1.ok && !fs.existsSync(p1.path) && !branchAt('sn/partial-1') && !manifest.find(p1.path), `Retry with the same inspect: our own deletions are not new dirt, the delete finishes (${JSON.stringify(retry1)})`)

    // .git went first (it sorts early): git cannot read the folder as this worktree any more.
    const p2 = (await s.create({ repoCwd: repo, slug: 'partial-2', copyEnv: false, linkNodeModules: false })).worktree
    const saw2 = await seen(s, p2.path)
    check(saw2.expectTip === head && saw2.expectDirty === 0, 'the dialog saw a clean worktree')
    half = (t) => { fs.rmSync(path.join(t, '.git'), { force: true }); fs.rmSync(path.join(t, '.gitignore'), { force: true }) }
    same(await halfway.s.remove({ path: p2.path, deleteBranch: true, ...saw2 }), busyRes, 'busy after the .git file went')
    check(fs.existsSync(p2.path) && !fs.existsSync(path.join(p2.path, '.git')), 'the folder is there without its .git')
    const blindRetry = await s.remove({ path: p2.path, deleteBranch: true, ...saw2 })
    check(!blindRetry.ok && blindRetry.error === 'changed' && fs.existsSync(p2.path), `without the record the unreadable folder is changed (${JSON.stringify(blindRetry)})`)
    // The tip is still compared on that Retry (read in the repo, not in the folder).
    const moved = git(repo, 'commit-tree', `${head}^{tree}`, '-p', head, '-m', 'late').trim()
    git(repo, 'update-ref', 'refs/heads/sn/partial-2', moved)
    same(await halfway.s.remove({ path: p2.path, deleteBranch: true, ...saw2 }), { ok: false, error: 'changed', detail: 'tip' }, 'a commit on the branch after the inspect is still changed on Retry')
    check(branchAt('sn/partial-2') === moved && fs.existsSync(p2.path), 'and nothing more is deleted')
    git(repo, 'update-ref', 'refs/heads/sn/partial-2', head)
    half = null
    const retry2 = await halfway.s.remove({ path: p2.path, deleteBranch: true, ...saw2 })
    check(retry2.ok && !fs.existsSync(p2.path) && !branchAt('sn/partial-2') && !manifest.find(p2.path), `Retry without .git: the tip matches, the delete finishes (${JSON.stringify(retry2)})`)

    // The same folder after a restart (audit 5): the in-memory record is gone,
    // so nothing says the deletions are ours. It is never "gone" (that sent no
    // count and deleted whatever was left, files written since included).
    const p3 = (await s.create({ repoCwd: repo, slug: 'partial-3', copyEnv: false, linkNodeModules: false })).worktree
    half = (t) => { fs.rmSync(path.join(t, '.git'), { force: true }) }
    same(await halfway.s.remove({ path: p3.path, deleteBranch: true, ...(await seen(s, p3.path)) }), busyRes, 'busy after the .git file went (before the restart)')
    half = null
    const restarted = make({ manifest, deps: { removeTree: halfTree } })
    const i4 = await restarted.s.inspect({ path: p3.path })
    same(i4, { exists: true, dirtyFiles: 0, commitsAhead: 0, mergedIntoHead: true, incomplete: true, noCheckout: true, tip: head }, 'a folder left without its .git inspects as present and unknown, never gone')
    check(r_deleteNeedsAckProbe(i4) && !r_deleteBlockProbe(i4, 'sn/partial-3'), 'the dialog asks for the "may lose work" checkbox and does not block Delete')
    const saw4 = r_removeExpectations(i4)
    same(saw4, { expectTip: head }, 'no dirty count is sent (git cannot read one)')
    write(path.join(p3.path, 'after.txt'), 'written after the inspect\n')
    same(await restarted.s.remove({ path: p3.path, deleteBranch: true, ...saw4 }), { ok: false, error: 'changed', detail: 'unreadable' }, 'without the checkbox the unreadable folder is changed, not deleted')
    same(await restarted.s.remove({ path: p3.path, deleteBranch: true }), { ok: false, error: 'changed', detail: 'unreadable' }, 'a caller that never inspected is refused too')
    same(await restarted.s.remove({ path: p3.path, deleteBranch: true, ...saw4, ackIncomplete: 'yes' }), { ok: false, error: 'git_error', detail: 'bad_expect' }, 'an ackIncomplete that is not a boolean is refused')
    check(fs.existsSync(path.join(p3.path, 'after.txt')) && branchAt('sn/partial-3') === head && manifest.find(p3.path), 'the file written after the inspect, the branch and the entry are kept')
    same(r_ackFields(i4, false), {}, 'the dialog sends no ack before the checkbox')
    same(r_ackFields({ exists: true, dirtyFiles: 1, commitsAhead: 0, mergedIntoHead: true, tip: head }, true), {}, 'nor for a complete inspect')
    same(r_ackFields(i4, true), { ackIncomplete: true }, 'and sends ackIncomplete once ticked')
    // The confirmed delete hits a lock again: its Retry (same session) finishes without asking again.
    half = (t) => { fs.rmSync(path.join(t, 'tracked.env.txt'), { force: true }) }
    const confirmed = { path: p3.path, deleteBranch: true, ...saw4, ...r_ackFields(i4, true) }
    same(await restarted.s.remove(confirmed), busyRes, 'a confirmed delete that hits a lock is busy')
    half = null
    const retry3 = await restarted.s.remove(confirmed)
    check(retry3.ok && !fs.existsSync(p3.path) && !branchAt('sn/partial-3') && !manifest.find(p3.path), `confirmed with the checkbox, the leftover folder and its branch go (${JSON.stringify(retry3)})`)

    // Confirmed in one go, and a commit after the inspect still stops it (the tip is read in the repo).
    const p4 = (await s.create({ repoCwd: repo, slug: 'partial-4', copyEnv: false, linkNodeModules: false })).worktree
    fs.rmSync(path.join(p4.path, '.git'), { force: true })
    const i5 = await make({ manifest }).s.inspect({ path: p4.path })
    check(i5.exists && i5.noCheckout && i5.incomplete && i5.tip === head, `a .git removed by hand reads the same (${JSON.stringify(i5)})`)
    const moved4 = git(repo, 'commit-tree', `${head}^{tree}`, '-p', head, '-m', 'late4').trim()
    git(repo, 'update-ref', 'refs/heads/sn/partial-4', moved4)
    same(await s.remove({ path: p4.path, deleteBranch: true, ...r_removeExpectations(i5), ...r_ackFields(i5, true) }), { ok: false, error: 'changed', detail: 'tip' }, 'the checkbox does not cover a commit made after the inspect')
    check(fs.existsSync(p4.path) && branchAt('sn/partial-4') === moved4, 'and nothing is deleted')
    const i6 = await s.inspect({ path: p4.path })
    const del4 = await s.remove({ path: p4.path, deleteBranch: true, ...r_removeExpectations(i6), ...r_ackFields(i6, true) })
    check(del4.ok && !fs.existsSync(p4.path) && !branchAt('sn/partial-4') && !manifest.find(p4.path), `confirmed again on the fresh inspect, it goes (${JSON.stringify(del4)})`)
  }

  // An inspect incomplete for a reason other than git status still sends its dirty count (audit 5).
  {
    const nb = (await s.create({ repoCwd: repo, slug: 'nobase-1', copyEnv: false, linkNodeModules: false })).worktree
    const nbTip = commitIn(nb.path, 'nb.txt', 'nb\n', 'nb work')
    manifest.put({ ...manifest.find(nb.path), baseSha: '' })
    const i3 = await s.inspect({ path: nb.path })
    same(i3, { exists: true, dirtyFiles: 0, commitsAhead: 0, mergedIntoHead: false, incomplete: true, dirtyRead: true, tip: nbTip, headBranch: 'sn/nobase-1', behindMain: 0 }, 'without a base the inspect is incomplete, but its status was read')
    check(r_deleteNeedsAckProbe(i3), 'the dialog still asks for the checkbox')
    const saw3 = r_removeExpectations(i3)
    same(saw3, { expectTip: nbTip, expectDirty: 0 }, 'and sends the dirty count it read')
    write(path.join(nb.path, 'after.txt'), 'written after the inspect\n')
    same(await s.remove({ path: nb.path, deleteBranch: true, ...saw3 }), { ok: false, error: 'changed', detail: 'dirty' }, 'a file written after an incomplete inspect is changed, never deleted in silence')
    check(fs.existsSync(path.join(nb.path, 'after.txt')) && branchAt('sn/nobase-1') === nbTip, 'nothing deleted')
    const again3 = await seen(s, nb.path)
    check(again3.expectDirty === 1, 're-inspect counts it')
    check((await s.remove({ path: nb.path, deleteBranch: true, ...again3 })).ok && !fs.existsSync(nb.path) && !branchAt('sn/nobase-1'), 'confirmed again, it goes')
  }

  // Half-done operations and another branch checked out (shown from the start).
  {
    const op = (await s.create({ repoCwd: repo, slug: 'op-1', copyEnv: false, linkNodeModules: false })).worktree
    git(repo, 'branch', 'conflict-src', head)
    const side = path.join(base, 'side')
    git(repo, 'worktree', 'add', '-q', side, 'conflict-src')
    commitIn(side, 'src/app.js', 'console.log("side")\n', 'side')
    git(repo, 'worktree', 'remove', '--force', side)
    commitIn(op.path, 'src/app.js', 'console.log("mine")\n', 'mine')
    check(!gitOkSync(op.path, 'merge', 'conflict-src'), 'a conflicting merge stops half-done')
    const im = await s.inspect({ path: op.path })
    check(im.inProgress === 'merge' && im.headBranch === 'sn/op-1' && !im.incomplete, `MERGE_HEAD reads as a merge in progress (${JSON.stringify(im)})`)
    check(r_deleteBlockProbe(im, 'sn/op-1') === 'inProgress', 'the dialog blocks Delete for it')
    same(await s.remove({ path: op.path, deleteBranch: true, ...(await seen(s, op.path)) }), { ok: false, error: 'changed', detail: 'in_progress' }, 'main refuses a delete over a half-done merge')
    check(fs.existsSync(op.path) && branchAt('sn/op-1'), 'nothing deleted')
    git(op.path, 'merge', '--abort')
    check(!(await s.inspect({ path: op.path })).inProgress, 'merge --abort clears it')
    check(!gitOkSync(op.path, 'rebase', 'conflict-src'), 'a conflicting rebase stops half-done')
    const ir = await s.inspect({ path: op.path })
    check(ir.inProgress === 'rebase' && ir.headBranch === '', `rebase-merge reads as a rebase on a detached HEAD (${JSON.stringify(ir)})`)
    same(await s.remove({ path: op.path, deleteBranch: true, ...(await seen(s, op.path)) }), { ok: false, error: 'not_managed', detail: 'branch_mismatch' }, 'a rebase in progress (detached) is refused before anything')
    git(op.path, 'rebase', '--abort')
    check(!gitOkSync(op.path, 'cherry-pick', 'conflict-src'), 'a conflicting cherry-pick stops half-done')
    check((await s.inspect({ path: op.path })).inProgress === 'cherry-pick', 'CHERRY_PICK_HEAD reads as a cherry-pick')
    git(op.path, 'cherry-pick', '--abort')
    // The main checkout, without a manifest entry: --git-path answers relative to the folder, the tip is HEAD.
    git(repo, 'bisect', 'start')
    const ib = await s.inspect({ path: repo })
    check(ib.inProgress === 'bisect' && ib.headBranch === 'main' && ib.tip === head, `a bisect in the main checkout (${JSON.stringify(ib)})`)
    git(repo, 'bisect', 'reset')
    check(!(await s.inspect({ path: repo })).inProgress, 'bisect reset clears it')
    // Another branch, or a detached HEAD, checked out in the folder.
    git(op.path, 'checkout', '-q', '-b', 'sn/elsewhere')
    const ie = await s.inspect({ path: op.path })
    check(ie.headBranch === 'sn/elsewhere' && r_deleteBlockProbe(ie, 'sn/op-1') === 'branchMismatch', 'another branch checked out blocks Delete')
    git(op.path, 'checkout', '-q', '--detach')
    const idt = await s.inspect({ path: op.path })
    check(idt.headBranch === '' && r_deleteBlockProbe(idt, 'sn/op-1') === 'branchMismatch', 'a detached HEAD blocks Delete')
    git(op.path, 'checkout', '-q', 'sn/op-1')
    const back = await s.inspect({ path: op.path })
    check(back.headBranch === 'sn/op-1' && r_deleteBlockProbe(back, 'sn/op-1') === null && r_deleteBlockProbe({ exists: false }, 'sn/op-1') === null, 'back on its branch (or gone), Delete is offered again')
    check((await s.remove({ path: op.path, deleteBranch: true, ...(await seen(s, op.path)) })).ok && !branchAt('sn/op-1'), 'and goes through')
  }

  // The real delete: never follows the junction.
  same(await s.remove({ path: wt.path, deleteBranch: true }), { ok: false, error: 'changed', detail: 'unconfirmed' }, 'with no expectation the dirty worktree with an unmerged commit stays')
  const okRm = await s.remove({ path: wt.path, paneId: 'pane-7', deleteBranch: true, ...(await seen(s, wt.path)) })
  check(okRm.ok, `remove ok (${JSON.stringify(okRm)})`)
  check(kills.includes('pane-7'), 'main killed the pane pty before deleting')
  check(!fs.existsSync(wt.path) && !gitOkSync(repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/sn/claude-ab12') && !listed(repo).includes(canon(wt.path)) && !manifest.find(wt.path), 'folder, branch, git record and manifest entry gone')
  check(fs.readFileSync(sentinel, 'utf8') === 'keep me\n', 'the repo node_modules sentinel survives (the junction was unlinked, not followed)')
  check(fs.readFileSync(path.join(repo, '.env'), 'utf8') === 'SECRET=1\n' && git(repo, 'rev-parse', 'HEAD').trim() === head, 'the repo .env and HEAD are untouched')
  check((await s.remove({ path: dup.worktree.path, deleteBranch: false })).ok && gitOkSync(repo, 'rev-parse', '--verify', 'refs/heads/sn/dup-1'), 'deleteBranch:false removes the folder and keeps the branch')

  // Folder deleted by hand (FR-36): inspect says so, remove just cleans up.
  const gone = await s.create({ repoCwd: repo, slug: 'gone-1', copyEnv: false, linkNodeModules: false })
  fs.rmSync(gone.worktree.path, { recursive: true, force: true })
  same(await s.inspect({ path: gone.worktree.path }), { exists: false, dirtyFiles: 0, commitsAhead: 0, mergedIntoHead: true, tip: head }, 'a worktree deleted by hand inspects as missing, with the tip its branch delete expects')
  {
    // Gone with commits of its own: the inspect still counts them in the repo.
    const goneC = (await s.create({ repoCwd: repo, slug: 'gone-c', copyEnv: false, linkNodeModules: false })).worktree
    const own = commitIn(goneC.path, 'own.txt', 'own\n', 'own work')
    fs.rmSync(goneC.path, { recursive: true, force: true })
    const ig = await s.inspect({ path: goneC.path })
    same(ig, { exists: false, dirtyFiles: 0, commitsAhead: 1, mergedIntoHead: false, tip: own }, 'a gone folder whose branch has a commit reports it')
    check(r_deleteNeedsAckProbe(ig), 'deleting that branch needs the checkbox')
    // No base recorded and not merged: unknown, so incomplete.
    const ent = manifest.find(goneC.path)
    manifest.put({ ...ent, baseSha: '' })
    const ib = await s.inspect({ path: goneC.path })
    check(ib.incomplete === true && ib.commitsAhead === 0 && ib.tip === own && r_deleteNeedsAckProbe(ib), `without a base the gone branch reads as incomplete (${JSON.stringify(ib)})`)
    manifest.put(ent)
    same(await s.remove({ path: goneC.path, deleteBranch: true }), { ok: false, error: 'changed', detail: 'unconfirmed' }, 'without expectations its commit is not dropped')
    check((await s.remove({ path: goneC.path, deleteBranch: true, expectTip: ig.tip })).ok && !gitOkSync(repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/sn/gone-c'), 'confirmed against the tip it showed, the branch goes')
  }
  const goneRow = (await s.list()).entries.find((e) => e.branch === 'sn/gone-1')
  check(goneRow && goneRow.exists === false && goneRow.dirty === null && goneRow.managed, 'the list shows it as a deleted folder')
  check((await s.remove({ path: gone.worktree.path, deleteBranch: true })).ok && !gitOkSync(repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/sn/gone-1') && !manifest.find(gone.worktree.path), 'removing it drops the record and the branch')

  // Orphans by scan (FR-31), also of a repo the app never saw.
  const repo2 = path.join(base, 'other repo')
  write(path.join(repo2, 'a.txt'), 'a\n')
  git(repo2, 'init', '-q', '-b', 'main'); git(repo2, 'add', '-A'); git(repo2, 'commit', '-qm', 'init')
  const manualPath = path.join(wtRoot, W.repoFolderName(repo2), 'manual')
  git(repo2, 'worktree', 'add', '-q', '-b', 'sn/manual', manualPath)
  write(path.join(manualPath, 'scratch.txt'), 's\n')
  const fresh = make({ manifest: new M.WorktreeManifest(mfFile) })
  const rows = (await fresh.s.list()).entries
  const manual = rows.find((e) => e.branch === 'sn/manual')
  check(manual && manual.managed && manual.exists && manual.dirty === true && manual.repoName === 'other repo' && manual.base === git(repo2, 'rev-parse', 'HEAD').trim(), 'a scanned sn/ worktree of an unknown repo is adopted with its base and dirty state')
  check(fresh.manifest.find(manualPath) !== null, 'adoption writes it to the manifest')
  const foreignRow = rows.find((e) => e.branch === 'feat')
  check(foreignRow && !foreignRow.managed, 'a scanned worktree on a non sn/ branch is listed unmanaged')
  check(!fresh.manifest.find(foreign), 'and never adopted')
  check(rows.some((e) => e.branch === 'sn/from-base' && e.managed && e.dirty === false), 'manifest entries are listed with their state')
  check((await fresh.s.remove({ path: manualPath, deleteBranch: true, ...(await seen(fresh.s, manualPath)) })).ok && !fs.existsSync(manualPath) && !gitOkSync(repo2, 'rev-parse', '--verify', '--quiet', 'refs/heads/sn/manual'), 'an adopted orphan can be deleted from Settings')
  check(fresh.s.isManaged(fromBase.worktree.path) && !fresh.s.isManaged(foreign) && !fresh.s.isManaged(repo), 'reveal is offered only for manifest paths')

  // Another spelling of the same folders (CI's 8.3 TEMP, macOS's /var): git
  // answers with realpaths, so a repo, a root and a remove path spelled
  // through the link must still meet git's records and the manifest.
  if (alias) {
    const aRepo = path.join(alias, 'repo')
    const aRoot = path.join(alias, 'data', 'worktrees')
    const viaLink = make({ root: aRoot })
    const ar = await viaLink.s.create({ repoCwd: aRepo, slug: 'alias-1', copyEnv: false, linkNodeModules: true })
    check(ar.ok && canon(ar.worktree.path) === canon(path.join(wtRoot, folder, 'alias-1')) && ar.worktree.path === fs.realpathSync.native(ar.worktree.path), `a repo and a root spelled through a link land in the one <root>/<repo>-<hash6>, spelled as git spells it (${JSON.stringify(ar)})`)
    same(await viaLink.s.inspect({ path: path.join(aRoot, folder, 'alias-1') }), { exists: true, dirtyFiles: 0, commitsAhead: 0, mergedIntoHead: true, tip: head, headBranch: 'sn/alias-1', behindMain: 0 }, 'inspect through the link spelling finds the entry (its junction is not dirty)')
    same(await make({ root: path.join(aRepo, 'inner2') }).s.create({ repoCwd: repo, slug: 'x5', copyEnv: false, linkNodeModules: false }), { ok: false, error: 'root_inside_repo' }, 'a root inside the repo spelled through a link is still refused')
    check(!fs.existsSync(path.join(repo, 'inner2')), 'and writes nothing in the repo')
    const viaRows = (await viaLink.s.list()).entries
    check(viaRows.filter((e) => e.branch === 'sn/alias-1').length === 1 && new Set(viaRows.map((e) => canon(e.path))).size === viaRows.length, 'one row per worktree whatever spelling the roots use')
    check((await viaLink.s.remove({ path: path.join(aRoot, folder, 'alias-1'), deleteBranch: true })).ok && !fs.existsSync(ar.worktree.path) && !gitOkSync(repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/sn/alias-1') && !new M.WorktreeManifest(mfFile).find(ar.worktree.path),'remove through the link spelling: git lists it, folder, branch and entry go')
    check(fs.readFileSync(sentinel, 'utf8') === 'keep me\n', 'and its node_modules junction was unlinked, not followed')
  }

  // A9: another console of the saved config runs in the folder ("New console in this worktree"):
  // main refuses, before it kills or deletes anything, whatever the spelling of the folder.
  {
    const sh = (await s.create({ repoCwd: repo, slug: 'shared-1', copyEnv: false, linkNodeModules: false })).worktree
    const next = (await s.create({ repoCwd: repo, slug: 'shared-2', copyEnv: false, linkNodeModules: false })).worktree
    const otherSpelling = alias ? path.join(alias, 'data', 'worktrees', folder, 'shared-1') : process.platform === 'win32' ? `${sh.path.toUpperCase()}\\` : path.join(wtRoot, folder, 'shared-1')
    let panes = [{ paneId: 'pa', path: sh.path }, { paneId: 'pb', path: otherSpelling }, { paneId: 'pc', path: next.path }, { paneId: 'pd', path: 'shared-1' }]
    const guarded = make({ manifest, deps: { worktreePanes: () => panes } })
    const saw = await seen(s, sh.path)
    same(await guarded.s.remove({ path: sh.path, paneId: 'pa', deleteBranch: true, ...saw }), { ok: false, error: 'shared', users: 1 }, 'another pane on the folder (spelled another way) is shared, with the count; a pane on another worktree or a relative path does not count')
    check(guarded.kills.length === 0 && fs.existsSync(sh.path) && listed(repo).includes(canon(sh.path)) && branchAt('sn/shared-1') && guarded.manifest.find(sh.path), 'shared: no pty killed, folder, git record, branch and entry kept')
    same(await guarded.s.remove({ path: sh.path, deleteBranch: true, ...saw }), { ok: false, error: 'shared', users: 2 }, 'without a pane (Settings, a team) every pane on the folder counts')
    same(await guarded.s.remove({ path: otherSpelling, paneId: 'pb', deleteBranch: true, ...saw }), { ok: false, error: 'shared', users: 1 }, 'asked through the other spelling, the first pane still counts')
    panes = [{ paneId: 'pa', path: sh.path }, { paneId: 'pc', path: next.path }]
    const last = await guarded.s.remove({ path: sh.path, paneId: 'pa', deleteBranch: true, ...saw })
    check(last.ok && guarded.kills.join() === 'pa' && !fs.existsSync(sh.path) && !branchAt('sn/shared-1'), `the last pane on it deletes as before, killing only its own pty (${JSON.stringify(last)})`)
    panes = []
    check((await guarded.s.remove({ path: next.path, deleteBranch: true, ...(await seen(s, next.path)) })).ok && !fs.existsSync(next.path), 'a worktree no pane uses is deleted as before')
    // registerWorktreeIpc's feed: every pane of the saved config with a worktree, any workspace.
    const ipc = load('src/main/ipc/registerWorktreeIpc.ts', { require: (id) => (id === 'electron' ? { app: { getPath: () => base }, ipcMain: { handle() {} }, shell: {} } : require(id)) })
    same(ipc.worktreePanesOf({ workspaces: [
      { id: 'w1', panes: [{ id: 'a', worktree: { path: 'C:\\wt\\x' } }, { id: 'b' }] },
      { id: 'w2', panes: [{ id: 'c', worktree: { path: 'C:\\wt\\x' } }, { id: 'd', worktree: { path: '' } }] },
    ] }), [{ paneId: 'a', path: 'C:\\wt\\x' }, { paneId: 'c', path: 'C:\\wt\\x' }], 'worktreePanesOf: the panes of every workspace with a worktree path')
    same(ipc.worktreePanesOf(null), [], 'no config: no panes')
  }

  // "main -N" (app 2.7.0, A9): commits on the main checkout after the worktree was made.
  {
    const repo3 = path.join(base, 'repo-behind')
    write(path.join(repo3, 'a.txt'), 'a\n')
    git(repo3, 'init', '-q', '-b', 'main'); git(repo3, 'add', '-A'); git(repo3, 'commit', '-qm', 'init')
    const bw = (await s.create({ repoCwd: repo3, slug: 'behind-1', copyEnv: false, linkNodeModules: false })).worktree
    check((await s.inspect({ path: bw.path })).behindMain === 0, 'a fresh worktree: main has nothing it lacks')
    commitIn(repo3, 'b.txt', 'b\n', 'main 1')
    commitIn(repo3, 'c.txt', 'c\n', 'main 2')
    const i1 = await s.inspect({ path: bw.path })
    check(i1.behindMain === 2 && i1.commitsAhead === 0 && i1.mergedIntoHead && !i1.incomplete, `two commits on main after the worktree: main -2 (${JSON.stringify(i1)})`)
    commitIn(bw.path, 'w.txt', 'w\n', 'wt work')
    const i2 = await s.inspect({ path: bw.path })
    check(i2.behindMain === 2 && i2.commitsAhead === 1 && !i2.mergedIntoHead, 'its own commit does not change it')
    const hand = path.join(base, 'hand-wt')
    git(repo3, 'worktree', 'add', '-q', '-b', 'feat-hand', hand)
    check((await s.inspect({ path: hand })).behindMain === undefined && (await s.inspect({ path: repo3 })).behindMain === undefined, 'a worktree main does not manage, and the main checkout, have none')
    const repoKey = canon(repo3)
    const noCount = make({ deps: { runner: { run: (args, o) => (args[0] === 'rev-list' && canon(o.cwd) === repoKey ? Promise.reject(Object.assign(new Error('fatal: bad revision'), { code: 'git_error' })) : runner.run(args, o)) } } })
    const i3 = await noCount.s.inspect({ path: bw.path })
    check(i3.behindMain === undefined && !i3.incomplete && i3.commitsAhead === 1, `git cannot count: absent, and never incomplete (it does not block a delete) (${JSON.stringify(i3)})`)
    check(canon(s.repoOf(bw.path)) === repoKey && s.repoOf(hand) === null && s.repoOf('relative') === null, 'repoOf: the main checkout of a managed worktree only')

    // GitService: the chip's mainBehind of a pane on that worktree, cached by (tip, main HEAD).
    const G = load('src/main/git/GitService.ts')
    let revLists = 0
    const counting = { run: (args, o) => { if (args[0] === 'rev-list') revLists++; return runner.run(args, o) }, info: (f) => runner.info(f) }
    let now = 1e6
    const pending = []
    const watches = []
    const updates = []
    const svc = new G.GitService({
      runner: counting,
      emit: (e) => updates.push(e),
      now: () => now,
      timers: { setTimeout: (fn, ms) => { const h = { fn, ms }; pending.push(h); return h }, clearTimeout: (h) => { const i = pending.indexOf(h); if (i >= 0) pending.splice(i, 1) } },
      watch: (dir, recursive, onEvent) => { const w = { dir, recursive, onEvent, closed: false }; watches.push(w); return { close() { w.closed = true } } },
      managedRepoOf: (d) => s.repoOf(d),
    })
    const sum = (k) => svc.get(k)?.summary
    const again = async (keys) => { now += 5000; svc.refresh(keys, 'manual'); await svc.idle() }
    svc.setTargets([
      { key: 'pane:pb', cwd: bw.path, workspaceId: 'w', paneId: 'pb', active: true },
      { key: 'ws:w', cwd: repo3, workspaceId: 'w', active: true },
      { key: 'pane:pm', cwd: repo3, workspaceId: 'w', paneId: 'pm', active: true },
      { key: 'pane:ph', cwd: hand, workspaceId: 'w', paneId: 'ph', active: true },
    ])
    await svc.idle()
    check(sum('pane:pb') && sum('pane:pb').mainBehind === 2, `a pane on a managed worktree: mainBehind 2 (${JSON.stringify(sum('pane:pb'))})`)
    check(sum('ws:w').mainBehind === undefined && sum('pane:pm').mainBehind === undefined && sum('pane:ph').mainBehind === undefined, 'none for a workspace target, a pane on the main checkout or on a worktree main does not manage')
    check(revLists === 1, `one count for the one managed worktree (${revLists})`)
    const sent = updates.length
    await again(['pane:pb'])
    check(revLists === 1 && sum('pane:pb').mainBehind === 2 && updates.length === sent, 'nothing moved: no new count (cached by tip and main HEAD), no git:update')
    commitIn(repo3, 'd.txt', 'd\n', 'main 3')
    await again(['pane:pb'])
    check(revLists === 2 && sum('pane:pb').mainBehind === 3, 'main moved: counted again, main -3')
    commitIn(bw.path, 'w2.txt', 'w2\n', 'wt work 2')
    await again(['pane:pb'])
    check(revLists === 3 && sum('pane:pb').mainBehind === 3, 'the tip moved: counted again, same number')
    await again(['pane:pb'])
    check(revLists === 3, 'and cached again')
    const seen = updates.filter((e) => e.key === 'pane:pb').map((e) => e.summary && e.summary.mainBehind)
    check(seen.join() === '2,3,3', `git:update carries it: 2, then 3, then the new tip (${seen.join()})`)
    // A checkout in the main checkout moves only the common dir's HEAD: that refreshes the units counting "main -N".
    // With the main checkout's own unit gone, the one live watch on <repo>/.git is the common one.
    svc.setTargets([{ key: 'pane:pb', cwd: bw.path, workspaceId: 'w', paneId: 'pb', active: true }])
    const commonKey = canon(path.join(repo3, '.git'))
    const tops = watches.filter((w) => !w.recursive && !w.closed && canon(w.dir) === commonKey)
    check(tops.length === 1, `the common dir of the worktree is watched (${tops.length})`)
    const top = tops[0]
    git(repo3, 'checkout', '-q', '--detach', 'HEAD~3')
    pending.length = 0
    top.onEvent('HEAD.lock')
    check(pending.length === 0, 'a lock file is not a HEAD move')
    top.onEvent('HEAD')
    const debounce = pending.find((h) => h.ms === G.WATCH_DEBOUNCE_MS)
    check(!!debounce, 'the main HEAD moving schedules a refresh of the worktree pane')
    now += 5000
    pending.splice(pending.indexOf(debounce), 1)
    debounce.fn()
    await svc.idle()
    check(sum('pane:pb').mainBehind === 0 && revLists === 4, `main checked out at the base: main -0, counted once (${sum('pane:pb').mainBehind}, ${revLists})`)
    git(repo3, 'checkout', '-q', 'main')
    svc.dispose()
  }

  // app 2.7.0 (E10 B4, decision 63): a team task worktree carries its owner; Settings > Git never offers it as an
  // orphan, the IPC remove (which never passes an owner) is refused, its owner removes it, a removed team disowns it.
  {
    const owner = 'team:tm-0123456789ab:cafebabe:t-1'
    const ow = await s.create({ repoCwd: repo, slug: 'team-own-1', copyEnv: false, linkNodeModules: false }, { owner })
    check(ow.ok && manifest.find(ow.worktree.path).owner === owner && new M.WorktreeManifest(mfFile).find(ow.worktree.path).owner === owner, 'create with an owner: the manifest entry keeps it, also read back from the file')
    const plainWt = await s.create({ repoCwd: repo, slug: 'no-owner-1', copyEnv: false, linkNodeModules: false })
    check(plainWt.ok && manifest.find(plainWt.worktree.path).owner === undefined, 'a console create (the IPC call, create(req) alone) never has one')
    const lst = await s.list()
    const ownRow = lst.entries.find((e) => canon(e.path) === canon(ow.worktree.path))
    check(ownRow && ownRow.teamOwned === true && ownRow.managed && !lst.entries.find((e) => canon(e.path) === canon(plainWt.worktree.path)).teamOwned, 'list(): teamOwned on the owned row only')
    same(await s.remove({ path: ow.worktree.path, deleteBranch: true }), { ok: false, error: 'busy', detail: 'team' }, 'the IPC remove (no owner) of an owned entry: busy, detail team')
    same(await s.remove({ path: ow.worktree.path, deleteBranch: true }, { owner: 'team:tm-0123456789ab:deadbeef:t-1' }), { ok: false, error: 'busy', detail: 'team' }, 'another owner (an old gen of the team) cannot remove it either')
    check(fs.existsSync(ow.worktree.path) && gitOkSync(repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/sn/team-own-1'), 'and nothing was touched')
    check(s.ownedBy(owner) && canon(s.ownedBy(owner).path) === canon(ow.worktree.path) && s.ownedBy('team:tm-0123456789ab:cafebabe:t-2') === null, 'ownedBy finds the entry of exactly that owner')
    const owner2 = 'team:tm-0123456789ab:cafebabe:t-2'
    const ow2 = await s.create({ repoCwd: repo, slug: 'team-own-2', copyEnv: false, linkNodeModules: false }, { owner: owner2 })
    const in2 = await s.inspect({ path: ow2.worktree.path })
    same(await s.remove({ path: ow2.worktree.path, deleteBranch: true, expectTip: in2.tip, expectDirty: 0 }, { owner: owner2 }), { ok: true }, 'its own owner removes it')
    check(!fs.existsSync(ow2.worktree.path) && !manifest.find(ow2.worktree.path) && !gitOkSync(repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/sn/team-own-2'), 'folder, entry and branch gone')
    // A junk owner in the file is dropped at load, the entry kept.
    const raw = JSON.parse(fs.readFileSync(mfFile, 'utf8'))
    fs.writeFileSync(mfFile, JSON.stringify({ ...raw, entries: raw.entries.map((e) => (canon(e.path) === canon(plainWt.worktree.path) ? { ...e, owner: 'renderer:spoof' } : e)) }))
    const reread = new M.WorktreeManifest(mfFile)
    check(reread.find(plainWt.worktree.path) && reread.find(plainWt.worktree.path).owner === undefined && reread.find(ow.worktree.path).owner === owner, 'an owner off the team shape is dropped at load, the entry kept')
    fs.writeFileSync(mfFile, JSON.stringify(raw))
    // The team removed: its trees lose the owner and read as ordinary orphans (the user may delete them).
    const fresh = make({ manifest: new M.WorktreeManifest(mfFile) })
    check(fresh.s.disown('team:tm-0123456789ab:') === 1 && fresh.manifest.find(ow.worktree.path).owner === undefined && new M.WorktreeManifest(mfFile).find(ow.worktree.path).owner === undefined, 'disown clears the owner of every entry of the team, on disk too')
    check(!(await fresh.s.list()).entries.find((e) => canon(e.path) === canon(ow.worktree.path)).teamOwned && fresh.s.disown('nope') === 0 && fresh.s.disown('') === 0, 'list() no longer marks it; disown needs a team prefix')
    const in1 = await fresh.s.inspect({ path: ow.worktree.path })
    same(await fresh.s.remove({ path: ow.worktree.path, deleteBranch: true, expectTip: in1.tip, expectDirty: 0 }), { ok: true }, 'a disowned tree: the plain remove works again')
    const inP = await fresh.s.inspect({ path: plainWt.worktree.path })
    same(await fresh.s.remove({ path: plainWt.worktree.path, deleteBranch: true, expectTip: inP.tip, expectDirty: 0 }), { ok: true }, 'an unowned one as before')

    // list() adopting a folder whose create lands meanwhile (B4 review): the scan saw the folder with no entry, then
    // the create's put (with its owner) landed while adopt waited on git. Adopt re-checks under the create queue and
    // keeps that entry: the owner is never erased, the tree never reads as an orphan.
    const repoR = path.join(base, 'race repo')
    write(path.join(repoR, 'a.txt'), 'a\n')
    git(repoR, 'init', '-q', '-b', 'main'); git(repoR, 'add', '-A'); git(repoR, 'commit', '-qm', 'init')
    const racePath = path.join(wtRoot, W.repoFolderName(repoR), 'team-race-1')
    git(repoR, 'worktree', 'add', '-q', '-b', 'sn/team-race-1', racePath)
    const raceOwner = 'team:tm-0123456789ab:cafebabe:t-7'
    const raceMf = new M.WorktreeManifest(mfFile)
    const raceRepoKey = canon(repoR)
    let landed = false
    const landing = {
      run: async (args, o) => {
        const out = await runner.run(args, o)
        if (args[0] === 'merge-base' && !landed && canon(o.cwd) === raceRepoKey) {
          landed = true
          raceMf.put({ path: racePath, branch: 'sn/team-race-1', repoRoot: fs.realpathSync.native(repoR), baseRef: 'HEAD', baseSha: git(repoR, 'rev-parse', 'HEAD').trim(), linkedPaths: [], root: wtRoot, createdAt: 1, owner: raceOwner })
        }
        return out
      },
      info: (f) => runner.info(f),
    }
    const racing = make({ manifest: raceMf, deps: { runner: landing } })
    const raceRows = (await racing.s.list()).entries
    check(landed && raceMf.find(racePath)?.owner === raceOwner && new M.WorktreeManifest(mfFile).find(racePath).owner === raceOwner && raceMf.find(racePath).createdAt === 1, 'a create that lands while list() adopts its folder keeps its entry and its owner (on disk too)')
    check(raceRows.find((e) => canon(e.path) === canon(racePath))?.teamOwned === true, 'and list() reports it team owned, never an orphan')
    check(racing.s.disown('team:tm-0123456789ab:') === 1, 'cleanup: disowned')
    const inR = await racing.s.inspect({ path: racePath })
    same(await racing.s.remove({ path: racePath, deleteBranch: true, expectTip: inR.tip, expectDirty: 0 }), { ok: true }, 'cleanup: removed')
    // The other end of that wait: a create that failed rolls its folder back while adopt waits in the queue, and
    // adopt then finds no folder: it writes no entry for a tree that is gone.
    const gonePath = path.join(wtRoot, W.repoFolderName(repoR), 'team-race-2')
    git(repoR, 'worktree', 'add', '-q', '-b', 'sn/team-race-2', gonePath)
    let rolledBack = false
    const rollback = {
      run: async (args, o) => {
        const out = await runner.run(args, o)
        if (args[0] === 'merge-base' && !rolledBack && canon(o.cwd) === raceRepoKey) {
          rolledBack = true
          git(repoR, 'worktree', 'remove', '--force', gonePath)
        }
        return out
      },
      info: (f) => runner.info(f),
    }
    const goneMf = new M.WorktreeManifest(mfFile)
    const gone = make({ manifest: goneMf, deps: { runner: rollback } })
    const goneRows = (await gone.s.list()).entries
    check(rolledBack && !fs.existsSync(gonePath) && goneMf.find(gonePath) === null && new M.WorktreeManifest(mfFile).find(gonePath) === null, 'a folder gone while adopt waited: no entry is written for it')
    check(!goneRows.some((e) => canon(e.path) === canon(gonePath)), 'and list() does not show it')
    git(repoR, 'branch', '-D', 'sn/team-race-2')
  }

  return { repo, fromBase: fromBase.worktree, git }
}

// --- PtyManager: cwd_missing (FR-36 defense) ---------------------------------
async function ptyChecks() {
  const spawns = []
  let nextProc = null
  const fakeProc = (o = {}) => ({ pid: 0, cols: 80, rows: 24, onData() {}, onExit() {}, write() {}, resize() {}, kill() {}, pause() {}, resume() {}, ...o })
  const P = load('src/main/pty/PtyManager.ts', {
    require: (id) => (id === 'node-pty' ? { spawn: (...a) => { spawns.push(a); const p = nextProc ?? fakeProc(); nextProc = null; return p } } : id === 'electron' ? { app: { getPath: () => os.tmpdir() } } : require(id)),
    console: { ...console, warn() {} },
  })
  const pm = new P.PtyManager(() => ({ isDestroyed: () => false, send() {} }))
  pm.setEngine({ snapshotMode: 'off' })
  const exits = []
  pm.addSink({ id: 't', onSpawn() {}, onData() {}, onExit: (ptyId, paneId, code, info) => exits.push({ paneId, code, info }) })
  let err = null
  try { pm.spawn({ paneId: 'wt-pane', cols: 80, rows: 24, cwd: path.join(base, 'deleted-worktree') }) } catch (e) { err = e }
  check(err && err.code === 'cwd_missing' && String(err.message).startsWith('cwd_missing: '), 'a missing cwd throws the typed cwd_missing')
  check(spawns.length === 0, 'node-pty never runs in a missing folder')
  same(exits.map((e) => ({ paneId: e.paneId, code: e.code, error: e.info.error })), [{ paneId: 'wt-pane', code: -1, error: 'cwd_missing' }], 'the sinks hear a typed exit')
  const ok = pm.spawn({ paneId: 'ok', cols: 80, rows: 24, cwd: base })
  check(ok.ptyId && spawns.length === 1, 'an existing cwd spawns as before')

  // killPaneAndWait (FR-30): the shell holding the folder is gone before the delete starts.
  const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true })
  await new Promise((res) => child.once('spawn', res))
  nextProc = fakeProc({ pid: child.pid, kill: () => child.kill() })
  pm.spawn({ paneId: 'busy-pane', cols: 80, rows: 24, cwd: base })
  const t0 = Date.now()
  await pm.killPaneAndWait('busy-pane', 3000)
  let alive = true
  try { process.kill(child.pid, 0) } catch { alive = false }
  check(!alive && Date.now() - t0 < 3000 && pm.ptyIdForPane('busy-pane') === null, 'killPaneAndWait returns once the shell process is gone')
  const t1 = Date.now()
  await pm.killPaneAndWait('unknown-pane', 3000)
  check(Date.now() - t1 < 500, 'an unknown pane does not wait')
  return pm
}

async function rendererChecks(real) {
  const removes = []
  const snApi = {
    platform: process.platform,
    config: { save() {} },
    pty: { killPanes: async () => 0 },
    git: { worktreeRemove: async (r) => { removes.push(r); return { ok: true } } },
    remote: { onCommand: (cb) => { snApi._cmd = cb; return () => {} }, commandResult: (res) => snApi._results.push(res), pushState() {} },
    window: { reveal() {} },
    _results: [],
  }
  const r = loadRenderer(`
    export { useAppStore } from './store'
    export { useAgentStore } from './agentStore'
    export { useWorktreeStore } from './worktreeStore'
    export * from './worktrees'
    export { resolveLaunch } from './launch'
    export { initRemoteCommands } from './remoteCommands'
  `, { window: { snApi }, document: { hasFocus: () => true, querySelector: () => null }, requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame() {} })
  const S = r.useAppStore
  const WS = r.useWorktreeStore
  const preset = { id: 'preset-claude', name: 'Claude Code', type: 'claude', command: 'claude', args: [], color: '#d97757', icon: 'claude' }
  const other = { id: 'preset-other', name: 'Other', type: 'claude', command: 'claude', args: [], color: '#fff', icon: 'claude', defaultCwd: 'C:\\other-repo' }
  const wt = real ? real.fromBase : { repoRoot: 'C:\\repo', path: path.join(base, 'fake-wt'), branch: 'sn/from-base', base: sha }
  const cfg = parseConfig({
    version: 12,
    workspaces: [
      { id: 'w1', name: 'Uno', cwd: wt.repoRoot, panes: [
        { id: 'p1', type: 'shell', title: 'Shell', color: '#fff', icon: 'terminal' },
        { id: 'pw', type: 'claude', presetId: 'preset-claude', title: 'Claude Code · from-base', color: '#d97757', icon: 'claude', cwd: wt.path, worktree: wt },
        { id: 'po', type: 'claude', presetId: 'preset-other', title: 'Other', color: '#fff', icon: 'claude' },
      ] },
      { id: 'w2', name: 'SSH', cwd: 'C:\\r2', setupId: 'ssh', panes: [{ id: 'q1', type: 'shell', title: 'S', color: '#fff', icon: 'terminal' }] },
    ],
    presets: [preset, other],
    connections: [{ id: 'ssh', name: 'Box', steps: [{ send: 'ssh box' }] }],
    settings: { defaultShell: {}, fontFamily: 'mono', fontSize: 13, scrollback: 1000, restoreLastWorkspace: true, confirmCloseRunning: true, sidebarCollapsed: false, language: 'es' },
    activeWorkspaceId: 'w1',
  })
  S.getState().hydrate(cfg)
  const st = () => S.getState()
  const ws = (id) => st().workspaces.find((w) => w.id === id)
  const pane = (wsId, id) => ws(wsId).panes.find((p) => p.id === id)

  // Slugs.
  check(r.defaultSlug('Claude Code', () => 0.5) === 'claude-code-8000', 'default slug: preset name + 4 hex')
  check(['Claude Code', '¡Ñandú!', '', '   ', 'x'.repeat(80), 'C++ / Rust'].every((n) => r.isValidSlug(r.defaultSlug(n))), 'the default slug is always valid')
  check(r.defaultSlug('¡Ñandú!', () => 0).startsWith('nandu-') && r.defaultSlug('', () => 0) === 'console-0000', 'accents folded, empty falls back to console')

  // Offer rules (FR-27).
  const git = (o) => o
  same(r.worktreeOffer(ws('w1'), null, [preset, other], cfg.connections, git({})), { show: true, repoCwd: wt.repoRoot }, 'a workspace preset offers the workspace repo')
  check(!r.worktreeOffer(ws('w2'), null, [preset], cfg.connections, git({})).show && !r.worktreeOffer(ws('w2'), pane('w2', 'q1'), [preset], cfg.connections, git({})).show, 'a connection profile hides the entries')
  check(r.worktreeOffer(ws('w1'), null, [preset], [], git({ error: 'not_repo' })).blocked === 'worktree.notRepo', 'not a repo: disabled with its tooltip')
  check(r.worktreeOffer(ws('w1'), null, [preset], [], git({ summary: { unborn: true } })).blocked === 'worktree.unborn', 'no commits: disabled with its tooltip')
  const full = { ...ws('w1'), panes: Array.from({ length: 12 }, (_, i) => ({ id: `f${i}`, type: 'shell', title: 'x', color: '', icon: '' })) }
  check(r.worktreeOffer(full, null, [preset], [], git({})).blocked === 'worktree.full', '12 consoles: the workspace is full')
  const dupOther = r.worktreeOffer(ws('w1'), pane('w1', 'po'), [preset, other], [], git({ error: 'not_repo' }))
  check(dupOther.show && !dupOther.blocked && dupOther.repoCwd === 'C:\\other-repo', 'Duplicate of a pane whose preset has defaultCwd in another repo uses that repo')
  check(r.worktreeOffer(ws('w1'), pane('w1', 'pw'), [preset], [], git({})).repoCwd === wt.path, 'Duplicate of a worktree pane starts from its folder (main resolves the repo)')

  // Created worktree -> pane.
  const tpl = r.templateFromPreset(preset)
  same(r.paneFromWorktree(tpl, wt), { type: 'claude', presetId: 'preset-claude', title: 'Claude Code · from-base', color: '#d97757', icon: 'claude', cwd: wt.path, worktree: wt }, 'the new console: preset · slug, cwd = worktree')
  const created = r.applyCreatedWorktree({ workspaceId: 'w1', repoCwd: wt.repoRoot, template: tpl }, wt)
  check(pane('w1', created).worktree.path === wt.path && r.resolveLaunch(pane('w1', created), ws('w1'), [preset], []).cwd === wt.path, 'the console starts in the worktree')
  check(r.templateFromPane(pane('w1', 'pw'), [preset]).name === 'Claude Code', 'Duplicate copies the preset name, not the old slug')

  // Restart keeps the cwd (FR-32).
  check(r.resolveLaunch(pane('w1', 'pw'), ws('w1'), [preset], []).cwd === wt.path, 'a restart resolves the same worktree cwd')

  // Close routing (FR-30).
  r.requestClosePane('w1', 'pw')
  same(WS.getState().close, { workspaceId: 'w1', paneId: 'pw', path: wt.path, branch: wt.branch, base: wt.base }, 'closing a worktree console opens Keep / Delete')
  check(!!pane('w1', 'pw'), 'and the console stays until the user picks')
  WS.getState().closeClose()
  r.requestClosePane('w1', 'p1')
  check(!pane('w1', 'p1') && WS.getState().close === null, 'a plain console closes directly')
  check(r.deleteNeedsAck({ dirtyFiles: 1, commitsAhead: 0, mergedIntoHead: true }) && r.deleteNeedsAck({ dirtyFiles: 0, commitsAhead: 2, mergedIntoHead: false }) && !r.deleteNeedsAck({ dirtyFiles: 0, commitsAhead: 2, mergedIntoHead: true }) && !r.deleteNeedsAck({ dirtyFiles: 0, commitsAhead: 0, mergedIntoHead: false }), 'the checkbox is required only when work would be lost')
  same(r.removeExpectations({ exists: true, dirtyFiles: 2, commitsAhead: 1, mergedIntoHead: false, tip: sha }), { expectTip: sha, expectDirty: 2 }, 'a delete sends back the tip and the dirty count it was confirmed on')
  same(r.removeExpectations({ exists: true, dirtyFiles: 0, commitsAhead: 0, mergedIntoHead: false, incomplete: true, tip: sha }), { expectTip: sha }, 'an incomplete inspect (checkbox "may lose work") sends no dirty count')
  same(r.removeExpectations({ exists: false, dirtyFiles: 0, commitsAhead: 0, mergedIntoHead: false }), {}, 'nothing known, nothing sent (main then deletes only what loses nothing)')
  check(r.deleteBlock({ exists: true, inProgress: 'revert', headBranch: 'sn/x' }, 'sn/x') === 'inProgress' && r.deleteBlock({ exists: true, headBranch: 'main' }, 'sn/x') === 'branchMismatch' && r.deleteBlock({ exists: true }, 'sn/x') === null, 'deleteBlock: an operation, another branch; an older main without the fields blocks nothing')
  check(r.lostCommits({ commitsAhead: 3, mergedIntoHead: true }) === 0 && r.lostCommits({ commitsAhead: 3, mergedIntoHead: false }) === 3, 'merged commits are not lost')

  // FR-36: cwd_missing marks only worktree consoles; Remove goes back to the workspace cwd.
  r.noteSpawnFailure('po', 'cwd_missing: C:\\x')
  r.noteSpawnFailure('pw', 'Cannot create process')
  check(!WS.getState().missing.po && !WS.getState().missing.pw, 'only a worktree console with cwd_missing gets the card')
  r.noteSpawnFailure('pw', 'cwd_missing: ' + wt.path)
  check(WS.getState().missing.pw === true, 'cwd_missing on a worktree console shows the card')
  r.applyCreatedWorktree({ workspaceId: 'w1', repoCwd: wt.repoRoot, template: r.templateFromPane(pane('w1', 'pw'), [preset]), replacePaneId: 'pw' }, { ...wt, path: wt.path + '-2', branch: 'sn/again' })
  check(pane('w1', 'pw').worktree.branch === 'sn/again' && pane('w1', 'pw').cwd === wt.path + '-2' && pane('w1', 'pw').title === 'Claude Code · again' && !WS.getState().missing.pw, 'Recreate moves the same console onto the new worktree')
  st().setPaneWorktree('w1', 'pw', null)
  check(!pane('w1', 'pw').worktree && pane('w1', 'pw').cwd === undefined && r.resolveLaunch(pane('w1', 'pw'), ws('w1'), [preset], []).cwd === wt.repoRoot, 'Remove from pane runs it in the workspace cwd')
  st().setPaneWorktree('w1', 'pw', wt)

  // Orphans (FR-31): deleting a workspace never deletes its worktrees.
  const entries = [{ path: wt.path, branch: wt.branch, repoName: 'r', dirty: false, managed: true, exists: true }, { path: 'C:\\x\\y', branch: 'sn/y', repoName: 'r', dirty: false, managed: true, exists: true }]
  check(r.orphanWorktrees(entries, st().workspaces).map((e) => e.branch).join() === 'sn/y', 'a worktree a console uses is not an orphan (any spelling)')
  check(r.orphanWorktrees([{ ...entries[0], path: wt.path.toUpperCase().replace(/\\/g, '/') + '/' }], st().workspaces).length === 0, 'path spelling (case, slashes) does not matter')
  st().deleteWorkspace('w1')
  check(r.orphanWorktrees(entries, st().workspaces).length === 2 && removes.length === 0, 'deleting the workspace leaves its worktrees as orphans, no delete')
  check(r.orphanWorktrees([...entries, { path: 'C:\\x\\team-t-1', branch: 'sn/t-0123ab-1', repoName: 'r', dirty: false, managed: true, exists: true, teamOwned: true }], st().workspaces).length === 2, 'a team task worktree is never an orphan (app 2.7.0, decision 63)')
  if (real) check(fs.existsSync(wt.path), 'and the folder is still there')

  // Phone closePane keeps folder and branch (FR-32), through the real executor.
  S.getState().hydrate(cfg)
  r.initRemoteCommands()
  snApi._cmd({ id: 'c1', action: { kind: 'closePane', workspaceId: 'w1', paneId: 'pw' } })
  await new Promise((res) => setImmediate(res))
  check(snApi._results.at(-1).ok && !pane('w1', 'pw'), 'the phone closes the worktree console')
  check(removes.length === 0 && WS.getState().close === null, 'no worktreeRemove and no dialog')
  if (real) check(fs.existsSync(wt.path) && real.git(real.repo, 'rev-parse', '--verify', `refs/heads/${wt.branch}`).trim().length === 40, 'folder and branch are still there')
  const closed = r.useAgentStore.getState().closedStack.at(-1)
  check(closed && closed.pane.worktree && closed.pane.worktree.path === wt.path, 'the closed console keeps its worktree for Reopen')
}

;(async () => {
  let real = null
  if (!gitOk) console.log('SKIP: git not on PATH, real repository checks skipped')
  else real = await realRepoChecks()
  await ptyChecks()
  await rendererChecks(real)
  // The link first, as a link: never followed into base.
  if (alias) fs.unlinkSync(alias)
  alias = null
  fs.rmSync(base, { recursive: true, force: true })
  console.log(`PASS: ${checks} worktree checks (helpers, schema 13, manifest, create/inspect/remove/list on real repos, rollback, junction sentinel, not_managed, shared, cwd_missing, main -N in inspect and the chip cache, renderer offer/close/orphans, phone closePane, team task owner)`)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
