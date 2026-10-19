// Worktree per console (E7-FR-27..32, FR-36): WorktreeService + WorktreeManifest
// on real repositories in os.tmpdir() (create with .env copy and node_modules
// junction, branch_exists leaves the branch alone, rollback of a failed step,
// remove that never follows the junction, not_managed guards, unlink failure
// aborting before anything else, orphans by scan), schema 13 round trip,
// PtyManager's cwd_missing, and the renderer side (offer rules, close routing,
// the phone's closePane keeping folder and branch). Bundled with esbuild and
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
const r_deleteNeedsAckProbe = (info) => loadRenderer(`export { deleteNeedsAck } from './worktrees'`, { window: { snApi: {} }, document: { hasFocus: () => true, querySelector: () => null } }).deleteNeedsAck(info)
const W = load('src/main/git/WorktreeService.ts')
const M = load('src/main/git/WorktreeManifest.ts')
const gx = load('src/main/git/gitExec.ts')
const { parseConfig } = load('src/main/store/schema.ts')

// --- Pure helpers ------------------------------------------------------------
check(['claude-3f2a', 'a', 'x-1-2', 'a'.repeat(40)].every(shared.isValidSlug), 'valid slugs')
check(!['', 'A', 'a b', '../x', 'a/b', 'a'.repeat(41), 'ñ', null, 3].some(shared.isValidSlug), 'invalid slugs (case, space, slash, length, non ASCII, non string)')
const f1 = W.repoFolderName('C:\\Users\\tarno\\Desktop\\Mi Repo')
check(/^Mi-Repo-[0-9a-f]{6}$/.test(f1), `repo folder is <name>-<hash6> (${f1})`)
check(W.repoFolderName('C:\\Users\\tarno\\Desktop\\Mi Repo').toLowerCase() === W.repoFolderName('c:\\users\\TARNO\\desktop\\mi repo\\').toLowerCase() || process.platform !== 'win32', 'same repo, same folder, whatever the spelling (Windows)')
check(W.repoFolderName('C:\\a\\repo') !== W.repoFolderName('C:\\b\\repo'), 'two repos of one name get different folders')
same(W.parseWorktreeList('worktree C:/r\nHEAD abc\nbranch refs/heads/main\n\nworktree C:/w/x\nHEAD def\nbranch refs/heads/sn/x\nprunable gitdir file points to non-existent location\n\nworktree C:/w/d\nHEAD 123\ndetached\n'), [
  { path: 'C:/r', branch: 'refs/heads/main', prunable: false },
  { path: 'C:/w/x', branch: 'refs/heads/sn/x', prunable: true },
  { path: 'C:/w/d', branch: null, prunable: false },
], 'worktree list --porcelain: path, branch, prunable, detached')
const gitFileRoot = W.repoRootFromGitFile('gitdir: C:/Users/x/repo/.git/worktrees/claude-1\n', 'C:\\wt\\repo-abc123\\claude-1')
check(gitFileRoot && path.resolve(gitFileRoot).toLowerCase() === path.resolve('C:/Users/x/repo').toLowerCase(), 'the .git file of a linked worktree names its repo')
check(W.repoRootFromGitFile('gitdir: C:/x/repo/.git\n', 'C:\\wt') === null && W.repoRootFromGitFile('nope', 'C:\\wt') === null && W.repoRootFromGitFile('gitdir: C:/bare.git/worktrees/a', 'C:\\wt') === null, 'a submodule, junk or a bare repo is not a linked worktree of a checkout')
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
  const listed = (repo) => git(repo, 'worktree', 'list', '--porcelain').split(/\r?\n/).filter((l) => l.startsWith('worktree ')).map((l) => path.resolve(l.slice(9)).toLowerCase())

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
  check(path.resolve(wt.path).toLowerCase() === path.join(wtRoot, folder, 'claude-ab12').toLowerCase(), `created at <root>/<repo>-<hash6>/<slug> (${wt.path})`)
  check(wt.branch === 'sn/claude-ab12' && wt.base === head && path.resolve(wt.repoRoot).toLowerCase() === path.resolve(repo).toLowerCase(), 'pane.worktree: branch sn/<slug>, base sha, repoRoot (from a subfolder)')
  check(!gitOkSync(repo, 'rev-parse', '--abbrev-ref', 'sn/claude-ab12@{upstream}'), 'the branch has no upstream (--no-track)')
  check(fs.readFileSync(path.join(wt.path, '.env'), 'utf8') === 'SECRET=1\n' && fs.existsSync(path.join(wt.path, '.env.local')), '.env and .env.local copied')
  check(!fs.existsSync(path.join(wt.path, 'dirty-in-main.txt')), 'uncommitted files of the main checkout are not copied')
  check(fs.lstatSync(path.join(wt.path, 'node_modules')).isSymbolicLink() && fs.existsSync(path.join(wt.path, 'node_modules', 'pkg', 'sentinel.txt')), 'node_modules is a junction to the repo')
  const ent = manifest.find(wt.path)
  check(ent && ent.branch === 'sn/claude-ab12' && ent.baseSha === head && ent.baseRef === 'HEAD' && ent.linkedPaths.length === 1 && path.dirname(ent.linkedPaths[0]).toLowerCase() === path.resolve(wt.path).toLowerCase(), 'manifest entry with baseRef, baseSha and the junction')
  check(fs.existsSync(mfFile), 'the manifest is dataDir()/worktrees.json')

  // Inspect (FR-30 / 36).
  same(await s.inspect({ path: wt.path }), { exists: true, dirtyFiles: 0, commitsAhead: 0, mergedIntoHead: true }, 'inspect clean: our own junction and the ignored .env are not dirty')
  write(path.join(wt.path, 'new.txt'), 'n\n')
  write(path.join(wt.path, 'src', 'app.js'), 'console.log(2)\n')
  same(await s.inspect({ path: wt.path }), { exists: true, dirtyFiles: 2, commitsAhead: 0, mergedIntoHead: true }, 'inspect dirty: 2 files')
  git(wt.path, 'add', 'src/app.js'); git(wt.path, 'commit', '-qm', 'work')
  same(await s.inspect({ path: wt.path }), { exists: true, dirtyFiles: 1, commitsAhead: 1, mergedIntoHead: false }, 'inspect: 1 commit over the base, not merged')
  const blind = make({ deps: { runner: { run: (args, o) => (args.includes('status') ? Promise.reject(Object.assign(new Error('fatal: unsafe repository'), { code: 'unsafe_repo' })) : runner.run(args, o)) } } })
  same(await blind.s.inspect({ path: wt.path }), { exists: true, dirtyFiles: 0, commitsAhead: 1, mergedIntoHead: false, incomplete: true }, 'inspect: a git status that fails is incomplete, never a silent clean')
  check(r_deleteNeedsAckProbe({ exists: true, dirtyFiles: 0, commitsAhead: 0, mergedIntoHead: true, incomplete: true }), 'an incomplete inspect still requires the checkbox')
  same(await s.inspect({ path: path.join(base, 'nope') }), { exists: false, dirtyFiles: 0, commitsAhead: 0, mergedIntoHead: false }, 'inspect of a missing folder')
  same(await s.inspect({ path: 'rel' }), { exists: false, dirtyFiles: 0, commitsAhead: 0, mergedIntoHead: false }, 'inspect of a relative path')

  // Duplicate from a worktree pane lands in the main repo.
  const dup = await s.create({ repoCwd: wt.path, slug: 'dup-1', copyEnv: false, linkNodeModules: false })
  check(dup.ok && path.resolve(dup.worktree.repoRoot).toLowerCase() === path.resolve(repo).toLowerCase() && path.dirname(dup.worktree.path).toLowerCase() === path.join(wtRoot, folder).toLowerCase(), 'a worktree as repoCwd resolves to the main checkout')
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
  check(!fs.existsSync(rbPath) && !gitOkSync(repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/sn/rollback-1') && !listed(repo).includes(rbPath.toLowerCase()) && !manifest.find(rbPath), 'rollback removed folder, branch, git record and manifest entry')
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

  // Unlink failure aborts before anything else (FR-30 acceptance).
  let treeCalls = 0
  const noUnlink = make({ deps: { fs: { ...fs.promises, unlink: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) }, rmdir: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) } }, removeTree: async () => { treeCalls++; return 'done' } } })
  same(await noUnlink.s.remove({ path: wt.path, paneId: 'p1', deleteBranch: true }), { ok: false, error: 'unlink_failed', detail: 'EACCES' }, 'a junction that cannot be unlinked is unlink_failed')
  check(treeCalls === 0 && fs.existsSync(wt.path) && listed(repo).includes(path.resolve(wt.path).toLowerCase()) && gitOkSync(repo, 'rev-parse', '--verify', 'refs/heads/sn/claude-ab12') && manifest.find(wt.path), 'unlink_failed: no folder delete, no git, no branch, entry kept')

  // Busy: files still locked after the retries.
  const busy = make({ deps: { removeTree: async () => ({ deferred: 'EBUSY' }) } })
  const dupBusy = await busy.s.remove({ path: dup.worktree.path, deleteBranch: true })
  same(dupBusy, { ok: false, error: 'busy', detail: 'EBUSY' }, 'locked files after the retries are busy')
  check(manifest.find(dup.worktree.path) && gitOkSync(repo, 'rev-parse', '--verify', 'refs/heads/sn/dup-1'), 'busy keeps the branch and the entry (Retry works)')

  // The real delete: never follows the junction.
  const okRm = await s.remove({ path: wt.path, paneId: 'pane-7', deleteBranch: true })
  check(okRm.ok, `remove ok (${JSON.stringify(okRm)})`)
  check(kills.includes('pane-7'), 'main killed the pane pty before deleting')
  check(!fs.existsSync(wt.path) && !gitOkSync(repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/sn/claude-ab12') && !listed(repo).includes(path.resolve(wt.path).toLowerCase()) && !manifest.find(wt.path), 'folder, branch, git record and manifest entry gone')
  check(fs.readFileSync(sentinel, 'utf8') === 'keep me\n', 'the repo node_modules sentinel survives (the junction was unlinked, not followed)')
  check(fs.readFileSync(path.join(repo, '.env'), 'utf8') === 'SECRET=1\n' && git(repo, 'rev-parse', 'HEAD').trim() === head, 'the repo .env and HEAD are untouched')
  check((await s.remove({ path: dup.worktree.path, deleteBranch: false })).ok && gitOkSync(repo, 'rev-parse', '--verify', 'refs/heads/sn/dup-1'), 'deleteBranch:false removes the folder and keeps the branch')

  // Folder deleted by hand (FR-36): inspect says so, remove just cleans up.
  const gone = await s.create({ repoCwd: repo, slug: 'gone-1', copyEnv: false, linkNodeModules: false })
  fs.rmSync(gone.worktree.path, { recursive: true, force: true })
  same(await s.inspect({ path: gone.worktree.path }), { exists: false, dirtyFiles: 0, commitsAhead: 0, mergedIntoHead: false }, 'a worktree deleted by hand inspects as missing')
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
  check((await fresh.s.remove({ path: manualPath, deleteBranch: true })).ok && !fs.existsSync(manualPath) && !gitOkSync(repo2, 'rev-parse', '--verify', '--quiet', 'refs/heads/sn/manual'), 'an adopted orphan can be deleted from Settings')
  check(fresh.s.isManaged(fromBase.worktree.path) && !fresh.s.isManaged(foreign) && !fresh.s.isManaged(repo), 'reveal is offered only for manifest paths')

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
  if (real) check(fs.existsSync(wt.path), 'and the folder is still there')

  // Phone closePane keeps folder and branch (FR-32), through the real executor.
  S.getState().hydrate(cfg)
  r.initRemoteCommands()
  snApi._cmd({ id: 'c1', action: { kind: 'closePane', workspaceId: 'w1', paneId: 'pw' } })
  await new Promise((res) => setImmediate(res))
  check(snApi._results.at(-1).ok && !pane('w1', 'pw'), 'the phone closes the worktree console')
  check(removes.length === 0 && WS.getState().close === null, 'no worktreeRemove and no dialog')
  if (real) check(fs.existsSync(wt.path) && execFileSync('git', ['rev-parse', '--verify', `refs/heads/${wt.branch}`], { cwd: real.repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().length === 40, 'folder and branch are still there')
  const closed = r.useAgentStore.getState().closedStack.at(-1)
  check(closed && closed.pane.worktree && closed.pane.worktree.path === wt.path, 'the closed console keeps its worktree for Reopen')
}

;(async () => {
  let real = null
  if (!gitOk) console.log('SKIP: git not on PATH, real repository checks skipped')
  else real = await realRepoChecks()
  await ptyChecks()
  await rendererChecks(real)
  fs.rmSync(base, { recursive: true, force: true })
  console.log(`PASS: ${checks} worktree checks (helpers, schema 13, manifest, create/inspect/remove/list on real repos, rollback, junction sentinel, not_managed, cwd_missing, renderer offer/close/orphans, phone closePane)`)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
