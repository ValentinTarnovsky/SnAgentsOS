// Logic of E7 (git, drops): dropping files on a pane (dropPaths modes, the
// in-app path payload, drop feedback, the paste registry) and the git chip
// (porcelain/numstat parsers, the git runner, the untracked budget, the
// GitService refresh policy under fake timers, real repos in temp, the chip
// helpers and the phone snapshot). Bundled with esbuild and run in a vm, like
// test-status.cjs. Real repos live in os.tmpdir() with an isolated git config.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
// Values built inside the vm have another realm's prototypes; compare as JSON.
function same(actual, expected, label) { assert.deepEqual(JSON.parse(JSON.stringify(actual ?? null)), expected, label); checks++ }
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, crypto: globalThis.crypto, ...overrides })
  return mod.exports
}

const drop = load('src/renderer/lib/dropPaths.ts')
const { buildDropPayload: build, isImagePath, canPasteRaw, escapeWindowsPath, hasControlChars } = drop
const paste = (text) => ({ kind: 'paste', text, parts: [text] })

// Image detection and escapes (fixtures adapted from Orca's cases).
check(['a.png', 'B.PNG', 'c.Jpg', 'd.jpeg', 'e.gif', 'f.WEBP', 'g.bmp'].every(isImagePath), 'image extensions match case-insensitively')
check(!['a.svg', 'a.tiff', 'a.pdf', 'png', 'a.png.txt', 'C:\\folder'].some(isImagePath), 'other extensions and folders are not images')
check(canPasteRaw('C:\\Users\\tarno\\Desktop\\bug.png'), 'plain Windows path is raw')
for (const ch of [' ', '\t', '"', "'", '`', '$', ';', '&', '|', '<', '>', '(', ')', '{', '}', '[', ']', '*', '?', '!', '#', '^', '%']) {
  check(!canPasteRaw(`C:\\tmp\\a${ch}b.png`), `unsafe char ${JSON.stringify(ch)} forces quotes`)
}
check(canPasteRaw('C:\\tmp\\a-b_c.d@e~f,g=h+i.png'), 'tilde, comma, equals and plus stay raw for images')
same(escapeWindowsPath('C:\\src\\app-1\\main.ts'), 'C:\\src\\app-1\\main.ts', 'Windows escape keeps plain chars raw')
same(escapeWindowsPath('/home/u/x@y:z.ts'), '/home/u/x@y:z.ts', 'POSIX style plain path stays raw')
same(escapeWindowsPath('C:\\tmp\\my file.ts'), '"C:\\tmp\\my file.ts"', 'space quotes in the Windows escape')
same(escapeWindowsPath('C:\\tmp\\a~b.ts'), '"C:\\tmp\\a~b.ts"', 'anything outside the plain set is quoted')
same(escapeWindowsPath('C:\\tmp\\informe \u00f1.txt'), '"C:\\tmp\\informe \u00f1.txt"', 'non ASCII is quoted')
check(hasControlChars('a\x07b') && hasControlChars('a\x00') && hasControlChars('a\x1b[2J') && hasControlChars('a\x7f') && hasControlChars('a\x9b') && hasControlChars('a\r') && hasControlChars('a\n'), 'C0, DEL and C1 are control bytes')
check(!hasControlChars('C:\\tmp\\\u00f1and\u00fa\u00a0x.png'), 'NBSP and letters are not control bytes')

// Agent mode (E7-FR-01, FR-02a): one term.paste per part, so each image path
// is a paste event of its own (what Claude and Codex attach as [Image #N]).
const agent = (...parts) => ({ kind: 'paste', text: parts.join(''), parts })
same(build(['C:\\Users\\tarno\\Desktop\\bug.png'], 'agent'), agent('C:\\Users\\tarno\\Desktop\\bug.png'), 'single raw image: no quotes, no space, no Enter')
same(build(['C:\\tmp\\mi captura.png'], 'agent'), agent('"C:\\tmp\\mi captura.png"'), 'image with a space is double quoted')
same(build(['C:\\a.png', 'C:\\b.PNG'], 'agent'), agent('C:\\a.png', 'C:\\b.PNG'), 'two raw images: two pastes, no space between them')
same(build(['C:\\a.png', 'C:\\b c.png'], 'agent'), agent('C:\\a.png', ' ', '"C:\\b c.png"'), 'raw then quoted image are space separated')
same(build(['C:\\b c.png', 'C:\\a.png'], 'agent'), agent('"C:\\b c.png"', ' ', 'C:\\a.png'), 'quoted then raw image are space separated')
same(build(['a.ts', 'b.png'], 'agent'), agent('a.ts ', 'b.png'), 'file, one space, then the image as its own paste')
same(build(['b.png', 'a.ts'], 'agent'), agent('b.png', ' ', 'a.ts '), 'image then file: space between, file keeps its trailing space')
same(build(['C:\\x\\a.ts', 'C:\\x\\b c.md'], 'agent'), agent('C:\\x\\a.ts ', '"C:\\x\\b c.md" '), 'files use the Windows escape, each followed by a space')
same(build(['C:\\repo\\src'], 'agent'), agent('C:\\repo\\src '), 'a folder is a non image file')
same(build(['C:\\a.png', 'C:\\b.png', 'c.ts', 'C:\\d.png'], 'agent'), agent('C:\\a.png', 'C:\\b.png', ' ', 'c.ts ', 'C:\\d.png'), 'mixed sequence keeps every separator rule')
check(build(['C:\\a.png', 'C:\\b c.png', 'x.ts'], 'agent').parts.every((p) => !/[\r\n]/.test(p) && !p.startsWith('cd ')), 'agent payload never has Enter or cd')
check(build(['C:\\a.png', 'x.ts', 'C:\\b c.png'], 'agent').parts.filter(isImagePath).every((p) => p.trim() === p), 'an image part is exactly its path, no separator inside')

// Safe mode (E7-FR-02b).
same(build(['C:\\a.png', 'C:\\b.png'], 'safe'), paste('C:\\a.png C:\\b.png '), 'safe shell: two images separated by a space')
same(build(['/tmp/a b.png', 'x.ts'], 'safe'), paste('"/tmp/a b.png" x.ts '), 'safe shell: Windows escape for every path')

// Plain mode (E7-FR-02c), the 1.14.1 behavior.
same(build(['a', 'b'], 'plain'), { kind: 'write', text: '"a" "b" ', parts: ['"a" "b" '] }, 'plain console writes quoted, space separated, trailing space')
same(build(['C:\\a.png'], 'plain'), { kind: 'write', text: '"C:\\a.png" ', parts: ['"C:\\a.png" '] }, 'plain console quotes images too')

// Control bytes void the whole drop in every mode; empty input writes nothing.
for (const mode of ['agent', 'safe', 'plain']) {
  same(build(['C:\\ok.png', 'C:\\bad\x07.png'], mode), null, `${mode}: a path with BEL drops nothing`)
  same(build(['C:\\x\x1b]0;pwn\x07.ts'], mode), null, `${mode}: an OSC sequence in a path drops nothing`)
  same(build(['C:\\x\u009b2J.ts'], mode), null, `${mode}: a C1 CSI drops nothing`)
  same(build(['C:\\x\r\n.ts'], mode), null, `${mode}: CR/LF drop nothing`)
  same(build([], mode), null, `${mode}: no paths`)
  same(build(['', ''], mode), null, `${mode}: only empty paths`)
}

// In-app path payload (application/x-snaos-path).
const nonceMod = load('src/renderer/lib/dragNonce.ts')
const { parseInternalPath, encodeInternalPath, DRAG_NONCE, INTERNAL_PATH_MIME, MAX_DRAG_PATH, setKnownPathResolver } = nonceMod
check(INTERNAL_PATH_MIME === 'application/x-snaos-path', 'internal MIME name')
check(typeof DRAG_NONCE === 'string' && DRAG_NONCE.length >= 32, 'nonce is a random UUID')
check(load('src/renderer/lib/dragNonce.ts').DRAG_NONCE !== DRAG_NONCE, 'each renderer load gets a new nonce')
const listed = new Set(['C:\\repo\\src\\a.ts'])
const known = (p) => listed.has(p)
same(parseInternalPath(encodeInternalPath('C:\\repo\\src\\a.ts'), DRAG_NONCE, known), 'C:\\repo\\src\\a.ts', 'valid nonce and listed path pass')
same(parseInternalPath(encodeInternalPath('C:\\repo\\src\\a.ts', 'other'), DRAG_NONCE, known), null, 'foreign nonce is rejected')
same(parseInternalPath(JSON.stringify({ path: 'C:\\repo\\src\\a.ts' }), DRAG_NONCE, known), null, 'missing nonce is rejected')
same(parseInternalPath('rm -rf ~\r', DRAG_NONCE, () => true), null, 'external raw text payload is rejected')
same(parseInternalPath(encodeInternalPath('rm -rf ~\r'), DRAG_NONCE, () => true), null, 'path with CR is rejected even if listed')
same(parseInternalPath(encodeInternalPath('C:\\a\u2028b'), DRAG_NONCE, () => true), null, 'Unicode line separator is rejected')
same(parseInternalPath(encodeInternalPath('C:\\repo\\other.ts'), DRAG_NONCE, known), null, 'path outside the current list is rejected')
same(parseInternalPath(encodeInternalPath('C:\\' + 'a'.repeat(MAX_DRAG_PATH)), DRAG_NONCE, () => true), null, 'path over 1024 chars is rejected')
same(parseInternalPath(encodeInternalPath('C:\\' + 'a'.repeat(MAX_DRAG_PATH - 3)), DRAG_NONCE, () => true), 'C:\\' + 'a'.repeat(MAX_DRAG_PATH - 3), 'exactly 1024 chars passes')
same(parseInternalPath(JSON.stringify({ nonce: DRAG_NONCE, path: 42 }), DRAG_NONCE, () => true), null, 'non string path is rejected')
same(parseInternalPath('null', DRAG_NONCE, () => true), null, 'JSON null is rejected')
same(parseInternalPath('', DRAG_NONCE, () => true), null, 'empty payload is rejected')
same(parseInternalPath(encodeInternalPath('C:\\repo\\src\\a.ts')), null, 'with no list source registered every internal drop is rejected')
setKnownPathResolver(known)
same(parseInternalPath(encodeInternalPath('C:\\repo\\src\\a.ts')), 'C:\\repo\\src\\a.ts', 'registered list source is consulted by default')
setKnownPathResolver(() => { throw new Error('boom') })
same(parseInternalPath(encodeInternalPath('C:\\repo\\src\\a.ts')), null, 'a throwing list source rejects')
setKnownPathResolver(null)

// Drop feedback counter (E7-FR-03).
const { isPathDrag, nextDragDepth } = load('src/renderer/lib/dropHover.ts')
check(isPathDrag(['Files']) && isPathDrag(['text/plain', 'application/x-snaos-path']), 'files and in-app paths light the pane')
check(!isPathDrag([]) && !isPathDrag(['text/plain', 'text/html']) && !isPathDrag(null), 'pane reorder drag (no files) never lights the pane')
let depth = 0
for (const ev of ['enter', 'enter', 'leave', 'enter', 'leave']) { depth = nextDragDepth(depth, ev); check(depth > 0, `nested ${ev} keeps the overlay (depth ${depth})`) }
depth = nextDragDepth(depth, 'leave'); check(depth === 0, 'last leave hides the overlay')
check(nextDragDepth(0, 'leave') === 0, 'stray leave never goes negative')
check(nextDragDepth(5, 'reset') === 0, 'drop or dragend resets')

// Paste registry and agent pane definition.
const reg = load('src/renderer/lib/pasteRegistry.ts')
const pasted = []
let bracketed = true
const paster = { paste: (t) => pasted.push(t), bracketed: () => bracketed }
check(reg.isBracketedPaste('p1') === null && reg.pasteToPane('p1', 'x') === false, 'unmounted pane has no paster')
reg.registerPaster('p1', paster)
check(reg.pasteToPane('p1', 'C:\\a.png') === true && pasted.at(-1) === 'C:\\a.png', 'paste goes to the registered terminal')
check(reg.pasteToPane('p1', '') === false && pasted.length === 1, 'empty text is not pasted')
check(reg.isBracketedPaste('p1') === true, 'bracketed state is read live')
bracketed = false; check(reg.isBracketedPaste('p1') === false, 'bracketed state follows the terminal')
const newer = { paste: () => {}, bracketed: () => true }
reg.registerPaster('p1', newer); reg.unregisterPaster('p1', paster)
check(reg.isBracketedPaste('p1') === true, 'stale cleanup keeps the remounted terminal paster')
reg.unregisterPaster('p1', newer); check(reg.isBracketedPaste('p1') === null, 'own cleanup removes the paster')

const { isAgentPane } = load('src/renderer/lib/agentPane.ts')
check(isAgentPane({ id: 'a', type: 'claude' }, undefined, true) && isAgentPane({ id: 'a', type: 'codex' }, null, true), 'claude and codex panes with bracketed paste are agents')
check(isAgentPane({ id: 'a', type: 'shell' }, { provider: 'claude' }, true), 'shell running an agent (status provider) is an agent')
check(!isAgentPane({ id: 'a', type: 'claude' }, { provider: 'claude' }, false), 'no bracketed paste is never an agent')
check(!isAgentPane({ id: 'a', type: 'claude' }, undefined, null), 'unmounted terminal is never an agent')
check(!isAgentPane({ id: 'a', type: 'shell' }, undefined, true) && !isAgentPane({ id: 'a', type: 'custom' }, {}, true), 'plain shell with bracketed paste is safe, not agent')
check(!isAgentPane({ id: 'missing', type: 'claude' }, undefined), 'default bracketed lookup with no paster is not an agent')


// ---------------------------------------------------------------------------
// GitService, chip and git in the snapshot (E7-FR-05..10, R22-10).
// ---------------------------------------------------------------------------
const fs = require('node:fs')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const dropChecks = checks
// Main modules read process/Buffer/timers; the vm context has none by default.
const loadMain = (file) => load(file, { process, Buffer, setTimeout, clearTimeout, setImmediate, setInterval, clearInterval })

// Porcelain v2 parser with -z fixtures.
const { parseStatusV2, parseNumstatZ, sumNumstat, MAX_STATUS_ENTRIES } = loadMain('src/main/git/porcelain.ts')
const Z = (...recs) => recs.join('\0') + '\0'
const H = '1111111111111111111111111111111111111111'
const st = parseStatusV2(Z(
  `# branch.oid ${H}`, '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1',
  `1 M. N... 100644 100644 100644 ${H} ${H} src/a b.ts`,
  `1 .M N... 100644 100644 100644 ${H} ${H} docs/\u00f1and\u00fa.md`,
  `1 MM N... 100644 100644 100644 ${H} ${H} both.ts`,
  `2 R. N... 100644 100644 100644 ${H} ${H} R100 new name.ts`, 'old name.ts',
  `1 A. N... 000000 100644 100644 ${'0'.repeat(40)} ${H} added.ts`,
  `1 .D N... 100644 100644 000000 ${H} ${H} gone.ts`,
  `1 .T N... 100644 100644 120000 ${H} ${H} link`,
  `u UU N... 100644 100644 100644 100644 ${H} ${H} ${H} conf lict.ts`,
  '? un tracked.txt', '? dir/\u65e5\u672c.txt',
))
same(st.branch, { oid: H, head: 'main', upstream: 'origin/main', ahead: 2, behind: 1 }, 'branch headers: oid, head, upstream, ahead/behind')
check(st.staged === 4 && st.unstaged === 4 && st.untracked === 2 && st.conflicts === 1, `area counts (staged ${st.staged}, unstaged ${st.unstaged})`)
check(st.files === 10, `distinct paths: a staged+modified file counts once (got ${st.files})`)
same(st.entries.filter((e) => e.path === 'both.ts').map((e) => e.area), ['staged', 'unstaged'], 'staged and modified file is in both areas')
same(st.entries.find((e) => e.path === 'new name.ts'), { path: 'new name.ts', oldPath: 'old name.ts', area: 'staged', status: 'R', added: null, removed: null, binary: false }, 'rename keeps the original path after the NUL')
check(st.entries.some((e) => e.path === 'src/a b.ts') && st.entries.some((e) => e.path === 'docs/\u00f1and\u00fa.md') && st.entries.some((e) => e.path === 'dir/\u65e5\u672c.txt'), 'spaces and unicode survive (-z, quotePath off)')
same(st.entries.find((e) => e.area === 'conflict'), { path: 'conf lict.ts', area: 'conflict', status: 'U', added: null, removed: null, binary: false }, 'unmerged entry is a conflict')
check(st.entries.find((e) => e.path === 'gone.ts').status === 'D' && st.entries.find((e) => e.path === 'link').status === 'T' && st.entries.find((e) => e.path === 'added.ts').status === 'A', 'D, T and A letters')
check(!st.truncated && st.totalEntries === 11, 'no truncation below the cap')
const det = parseStatusV2(Z(`# branch.oid ${H}`, '# branch.head (detached)'))
check(det.branch.head === null && det.branch.oid === H && det.branch.upstream === null && det.files === 0, 'detached HEAD: no branch name, clean')
const unb = parseStatusV2(Z('# branch.oid (initial)', '# branch.head main', `1 A. N... 000000 100644 100644 ${'0'.repeat(40)} ${H} a.txt`))
check(unb.branch.oid === null && unb.branch.head === 'main' && unb.staged === 1, 'unborn repo: oid (initial)')
const big = parseStatusV2(Z(`# branch.oid ${H}`, '# branch.head main', ...Array.from({ length: MAX_STATUS_ENTRIES + 7 }, (_, i) => `? f${i}.txt`)))
check(big.truncated && big.entries.length === MAX_STATUS_ENTRIES && big.files === MAX_STATUS_ENTRIES + 7 && big.untracked === MAX_STATUS_ENTRIES + 7, 'over 5000 entries: truncated list, full counts')
same(parseStatusV2(''), { branch: { oid: null, head: null, upstream: null, ahead: 0, behind: 0 }, entries: [], totalEntries: 0, files: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0, truncated: false }, 'empty output')

// Numstat -z with renames and binaries.
const ns = parseNumstatZ('10\t2\tsrc/a.ts\0-\t-\timg.png\0' + '0\t0\t\0old name.ts\0new name.ts\0' + '3\t0\t\u00f1 dir/x y.ts\0')
same(ns, [
  { path: 'src/a.ts', added: 10, removed: 2, binary: false },
  { path: 'img.png', added: null, removed: null, binary: true },
  { path: 'new name.ts', oldPath: 'old name.ts', added: 0, removed: 0, binary: false },
  { path: '\u00f1 dir/x y.ts', added: 3, removed: 0, binary: false },
], 'numstat: plain, binary, rename (empty path then old/new), unicode')
same(sumNumstat(ns), { added: 13, removed: 2 }, 'numstat sum ignores binaries')
same(parseNumstatZ('garbage\0\0'), [], 'malformed numstat records are skipped')

// git process wrapper: env, error classes, version, semaphore.
const gx = loadMain('src/main/git/gitExec.ts')
const env = gx.gitEnv({ PATH: 'p', GIT_DIR: 'x', git_work_tree: 'y', Git_Index_File: 'z', GIT_COMMON_DIR: 'c', GIT_OBJECT_DIRECTORY: 'o', GIT_CEILING_DIRECTORIES: 'd', GIT_AUTHOR_NAME: 'keep' })
same(env, { PATH: 'p', GIT_AUTHOR_NAME: 'keep', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }, 'env drops GIT_DIR and friends case-insensitively and adds the fixed vars')
check(gx.classifyGitError({ code: 'ENOENT' }, '') === 'git_missing', 'ENOENT -> git_missing')
check(gx.classifyGitError({ code: 128 }, "fatal: detected dubious ownership in repository at 'C:/x'\nTo add an exception...") === 'unsafe_repo', 'dubious ownership -> unsafe_repo')
check(gx.classifyGitError({ code: 128 }, 'fatal: not a git repository (or any of the parent directories): .git') === 'not_repo', 'not a git repository -> not_repo')
check(gx.classifyGitError({ killed: true, signal: 'SIGTERM' }, '') === 'timeout', 'killed by the timeout -> timeout')
check(gx.classifyGitError({ code: 1 }, 'fatal: something else') === 'git_error', 'anything else -> git_error')
same(gx.parseGitVersion('git version 2.45.1.windows.1'), [2, 45, 1], 'windows version string')
check(gx.versionTooOld([2, 19, 9]) && gx.versionTooOld([1, 9, 0]) && !gx.versionTooOld([2, 20, 0]) && !gx.versionTooOld([3, 0, 0]), 'minimum git is 2.20')
check(gx.GIT_PREFIX.join(' ') === '-c core.quotePath=false -c core.fsmonitor=false -c diff.autoRefreshIndex=false', 'fixed -c prefix')

// git binary lookup: absolute PATH entries only, never the cwd (a repo's own git.exe).
{
  const seen = []
  const files = new Set(['C:\\Git\\cmd\\git.exe', 'D:\\rel\\git.exe', '/usr/bin/git'])
  const isFile = (p) => { seen.push(p); return files.has(p) }
  check(gx.resolveGitBin({ Path: '.;rel;\\Git\\cmd;"C:\\Git\\cmd"' }, 'win32', isFile) === 'C:\\Git\\cmd\\git.exe', 'windows: Path key in any case, quoted entry, .exe')
  check(!seen.some((p) => !/^[A-Z]:\\/.test(p)), `windows: ".", relative and drive-relative PATH entries are never probed (${seen.filter((p) => !/^[A-Z]:\\/.test(p)).join(', ')})`)
  check(gx.resolveGitBin({ PATH: 'C:\\nogit' }, 'win32', isFile) === null && gx.resolveGitBin({}, 'win32', isFile) === null, 'no git in PATH: null')
  check(gx.resolveGitBin({ PATH: 'bin:/usr/bin' }, 'linux', isFile) === '/usr/bin/git', 'posix: absolute entries only')
  check(gx.resolveGitBin({ PATH: 'C:\\Git\\cmd' }, 'win32', (p) => p === 'C:\\Git\\cmd\\git.cmd') === null, 'windows: a git.cmd alone is not run (no shell)')
}

// ---- R30-01: schema 13 git keys (pane.worktree, worktreesRoot) --------------
const schema13Start = checks
// zod's z.object() strips unknown keys, so without paneWorktreeSchema the
// link to a worktree would vanish on the next reload (E7 Diseno F).
{
  const { parseConfig, CONFIG_VERSION } = load('src/main/store/schema.ts', { console: { ...console, warn() {} } })
  const wt = { repoRoot: 'C:\\repo\\app', path: 'C:\\data\\worktrees\\app-3f2a1b\\claude-3f2a', branch: 'sn/claude-3f2a', base: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' }
  const v12 = () => ({
    version: 12,
    workspaces: [{ id: 'w1', name: 'App', cwd: 'C:\\repo\\app', layout: { grid: 2, order: ['p1', 'p2'] }, panes: [
      { id: 'p1', type: 'claude', presetId: 'preset-claude', cwd: wt.path, title: 'Claude \u00b7 claude-3f2a', color: '#d97757', icon: 'claude' },
      { id: 'p2', type: 'shell', title: 'Shell', color: '#fff', icon: 'terminal' },
    ] }],
    presets: [{ id: 'preset-claude', name: 'Claude Code', type: 'claude', command: 'claude', args: [], color: '#d97757', icon: 'claude' }],
    settings: { defaultShell: {}, fontFamily: 'mono', fontSize: 13, scrollback: 1000, restoreLastWorkspace: true, confirmCloseRunning: true, sidebarCollapsed: false, gitChip: false },
    activeWorkspaceId: 'w1',
  })
  check(CONFIG_VERSION === 13, 'schema 13 carries the worktree keys')
  const up = parseConfig(v12())
  check(up.version === 13 && up.settings.worktreesRoot === '' && up.settings.gitChip === false && up.workspaces[0].panes[0].cwd === wt.path, 'v12 -> v13: worktreesRoot defaults to empty (dataDir()/worktrees), gitChip and pane cwd kept')
  check(up.workspaces[0].panes.every((p) => !('worktree' in p)), 'a pane without worktree stays without one')
  const cfg = v12(); cfg.version = 13; cfg.workspaces[0].panes[0].worktree = { ...wt }; cfg.settings.worktreesRoot = 'D:\\wt'
  const once = parseConfig(JSON.parse(JSON.stringify(cfg)))
  same(once.workspaces[0].panes[0].worktree, wt, 'pane.worktree survives the parse')
  check(once.settings.worktreesRoot === 'D:\\wt', 'a custom worktreesRoot is kept')
  same(parseConfig(JSON.parse(JSON.stringify(once))), JSON.parse(JSON.stringify(once)), 'a second parse (reload) changes nothing')
  for (const [label, bad] of [
    ['a branch outside sn/', { ...wt, branch: 'main' }],
    ['a non-hex base', { ...wt, base: 'HEAD' }],
    ['an empty path', { ...wt, path: '' }],
    ['a missing repoRoot', { path: wt.path, branch: wt.branch, base: wt.base }],
    ['a string', 'C:\\x'],
  ]) {
    const c = v12(); c.workspaces[0].panes[0].worktree = bad
    const p = parseConfig(c)
    check(p && p.workspaces[0].panes[0].title.startsWith('Claude') && p.workspaces[0].panes[0].worktree === undefined, `${label} drops only the worktree, never the config`)
  }

  // ConfigStore on a temp dir: save, then a fresh store (an app restart) reloads it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-wt-schema-'))
  try {
    const app = { getPath: () => dir, isPackaged: false }
    const csCode = buildSync({ entryPoints: [path.join(root, 'src/main/store/ConfigStore.ts')], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
    const csMod = { exports: {} }
    vm.runInNewContext(csCode, { module: csMod, exports: csMod.exports, require: (id) => (id === 'electron' ? { app } : require(id)), process: { ...process, env: {}, argv: ['electron'] }, console: { ...console, warn() {} }, Buffer })
    const { ConfigStore } = csMod.exports
    new ConfigStore().save(once)
    const reloaded = new ConfigStore().load({ upgrade: true })
    same(reloaded.workspaces[0].panes[0].worktree, wt, 'the worktree is still there after a save and a restart')
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(v12()))
    new ConfigStore().load({ upgrade: true })
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))
    check(onDisk.version === 13 && onDisk.settings.worktreesRoot === '' && onDisk.workspaces[0].panes.length === 2, 'a v12 file upgrades on disk to 13 keeping its panes')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }

  // Renderer store -> persisted blob -> schema keeps the worktree.
  const code = buildSync({ stdin: { contents: `export { startPersistence } from './persist'; export { useAppStore } from './store'`, resolveDir: path.join(root, 'src/renderer/lib'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text
  const saves = [], timers = new Map()
  let seq = 0
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, crypto: globalThis.crypto,
    window: { snApi: { config: { save: (c) => saves.push(JSON.parse(JSON.stringify(c))) }, pty: { killPanes: async () => 0 } } },
    document: { hasFocus: () => false },
    setTimeout: (fn) => { timers.set(++seq, fn); return seq }, clearTimeout: (id) => timers.delete(id) })
  const S = mod.exports.useAppStore
  S.getState().hydrate(once)
  const stop = mod.exports.startPersistence()
  S.getState().renamePane('w1', 'p2', 'Shell 2')
  for (const fn of [...timers.values()]) fn()
  timers.clear()
  const blob = saves.at(-1)
  check(blob && blob.version === 13, 'the store writes a v13 blob')
  same(blob.workspaces[0].panes[0].worktree, wt, 'the persisted blob carries pane.worktree')
  same(parseConfig(blob).workspaces[0].panes[0].worktree, wt, 'and the reload keeps it')
  check(parseConfig(blob).settings.worktreesRoot === 'D:\\wt', 'worktreesRoot persists through the store')
  stop()
}
const schema13Checks = checks - schema13Start
// ---- end R30-01 -------------------------------------------------------------

function fakeExec() {
  const calls = []
  const fn = (file, args, opts, cb) => calls.push({ file, args, opts, done: (out = '', err = null, stderr = '') => cb(err, out, stderr) })
  return { calls, fn }
}
const tick = () => new Promise((r) => setImmediate(r))
let asyncDone = false
// A promise that never settles would end the process silently with code 0.
process.on('exit', (code) => {
  if (!asyncDone && code === 0) {
    console.error('FAIL: test-git async checks never finished (after check ' + checks + ')')
    process.exitCode = 1
  }
})

;(async () => {
  {
    const fx = fakeExec()
    const runner = gx.createGitRunner({ execFile: fx.fn, env: () => ({ X: '1' }), gitBin: 'git' })
    const p = [1, 2, 3].map(() => runner.run(['status'], { cwd: 'C:\\r' }))
    await tick()
    check(runner.running === 2 && fx.calls.length === 2, 'at most 2 git processes at once')
    check(fx.calls[0].args.slice(0, 6).join(' ') === gx.GIT_PREFIX.join(' ') && fx.calls[0].args[6] === 'status' && fx.calls[0].opts.windowsHide === true && fx.calls[0].opts.cwd === 'C:\\r', 'prefix, windowsHide and cwd reach execFile')
    fx.calls[0].done('out0')
    check((await p[0]) === 'out0', 'stdout resolves the run')
    await tick()
    check(fx.calls.length === 3 && runner.running === 2, 'a finished run frees its slot for the queue')
    fx.calls[1].done('', Object.assign(new Error('x'), { code: 128 }), 'fatal: not a git repository')
    await p[1].then(() => check(false, 'error must reject'), (e) => check(e.code === 'not_repo', 'git failure rejects with its class'))
    fx.calls[2].done('')
    await p[2]
    const r2 = [runner.run(['a'], { cwd: 'c', priority: 'remote' }), runner.run(['b'], { cwd: 'c', priority: 'remote' })]
    await tick()
    check(runner.running === 1, 'a remote request never takes the desktop slot')
    const d = runner.run(['c'], { cwd: 'c' })
    await tick()
    check(runner.running === 2 && fx.calls.at(-1).args.at(-1) === 'c', 'the desktop runs next to a remote request')
    fx.calls[3].done('')
    await tick()
    check(fx.calls.at(-1).args.at(-1) === 'b' && runner.running === 2, 'the queued remote request starts when the remote slot frees')
    fx.calls.slice(4).forEach((c) => c.done(''))
    await Promise.all([...r2, d])
    check(runner.running === 0, 'every slot released')
  }

  // Untracked line count: budget, size cap, binary, cache by (size, mtime).
  {
    const { UntrackedCounter, countLines, UNTRACKED_BUDGET_BYTES } = loadMain('src/main/git/untrackedLines.ts')
    same([countLines(Buffer.from('a\nb\n')), countLines(Buffer.from('a\nb')), countLines(Buffer.from('')), countLines(Buffer.from('a\0b'))], [2, 2, 0, null], 'line count like numstat: last line without newline counts, NUL is binary')
    const files = new Map()
    let reads = 0
    let readBytes = 0
    const vfs = {
      stat: async (p) => { const f = files.get(p); if (!f) throw new Error('ENOENT'); return { size: f.size, mtimeMs: f.mtime, isFile: () => true } },
      readFile: async (p) => { reads++; const f = files.get(p); readBytes += f.size; return f.buf ?? Buffer.alloc(f.size, 10) },
    }
    const root = path.join(os.tmpdir(), 'snaos-git-vfs')
    const put = (rel, size, mtime = 1, buf) => files.set(path.join(root, rel), { size, mtime, buf })
    put('a.txt', 0, 1, Buffer.from('1\n2\n3\n'))
    files.get(path.join(root, 'a.txt')).size = 6
    put('b.bin', 4, 1, Buffer.from([1, 0, 2, 3]))
    put('big.log', 2 * 1024 * 1024)
    const c = new UntrackedCounter(vfs)
    const r1 = await c.count(root, ['a.txt', 'b.bin', 'big.log', 'missing.txt'])
    check(r1.lines === 3 && r1.approx === true && reads === 2, `counts text, skips binary, a >1MB file marks approx (lines ${r1.lines}, reads ${reads})`)
    const r2 = await c.count(root, ['a.txt', 'b.bin', 'big.log'])
    check(r2.lines === 3 && r2.bytesRead === 0 && reads === 2, 'second refresh with no changes reads nothing')
    files.get(path.join(root, 'a.txt')).mtime = 2
    files.get(path.join(root, 'a.txt')).buf = Buffer.from('1\n')
    files.get(path.join(root, 'a.txt')).size = 2
    const r3 = await c.count(root, ['a.txt'])
    check(r3.lines === 1 && reads === 3 && c.size === 1, 'a changed mtime re-reads; files no longer untracked leave the cache')
    files.clear(); reads = 0; readBytes = 0
    const many = Array.from({ length: 300 }, (_, i) => { put(`f${i}.txt`, 900 * 1024); return `f${i}.txt` })
    const r4 = await new UntrackedCounter(vfs).count(root, many)
    check(r4.approx && r4.bytesRead <= UNTRACKED_BUDGET_BYTES && readBytes <= UNTRACKED_BUDGET_BYTES, `300 untracked of 900KB: approx and at most 8MB read (read ${readBytes})`)
    check(reads <= 200, 'never more than 200 files per refresh')
  }

  // GitService policy with fake timers, watchers and git.
  const svcMod = loadMain('src/main/git/GitService.ts')
  const { GitService, sanitizeTargets, ACTIVE_POLL_MS, MIN_RUN_GAP_MS, WATCH_DEBOUNCE_MS, AGENT_DEBOUNCE_MS, PANEL_POLL_MS, HOT_MS, MAX_WATCHED, FOCUS_BATCH_GAP_MS } = svcMod
  function harness(opts = {}) {
    let now = 1_000_000
    let seq = 0
    const timers = []
    const t = {
      setTimeout: (fn, ms) => { const h = { at: now + ms, fn, id: seq++ }; timers.push(h); return h },
      clearTimeout: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1) },
    }
    const watches = []
    const watch = (dir, recursive, onEvent) => { const h = { dir, recursive, onEvent, closed: false, close() { this.closed = true } }; watches.push(h); return h }
    const statusOut = new Map()
    let indexMtime = null
    const calls = []
    let gate = null
    const runner = {
      info: async () => opts.info ?? { available: true, version: '2.45.0', tooOld: false },
      run: async (args, o) => {
        calls.push({ args, cwd: o.cwd })
        if (gate) await gate.promise
        const cwd = o.cwd
        if (args[0] === 'rev-parse') {
          if (opts.notRepo?.has(cwd)) { const e = new gx.GitExecError('not_repo', 'nope'); throw e }
          return `${cwd}\n${cwd}\\.git\n.git\n`
        }
        if (args[0] === 'status') return statusOut.get(cwd) ?? Z(`# branch.oid ${H}`, '# branch.head main')
        if (args[0] === 'diff') return '5\t1\tx.ts\0'
        return ''
      },
    }
    const emitted = []
    const svc = new GitService({ runner, emit: (e) => emitted.push(e), now: () => now, timers: t, watch, exists: () => false, mtimeOf: () => indexMtime, platform: 'win32', untracked: { count: async () => ({ lines: 0, approx: false, bytesRead: 0 }), forget() {} } })
    const flush = async () => { for (let i = 0; i < 6; i++) { await tick(); await svc.idle() } }
    const advance = async (ms) => {
      const end = now + ms
      for (;;) {
        await flush()
        timers.sort((a, b) => a.at - b.at || a.id - b.id)
        const next = timers[0]
        if (!next || next.at > end) break
        timers.shift()
        now = Math.max(now, next.at)
        next.fn()
      }
      now = end
      await flush()
    }
    const statusCalls = (cwd) => calls.filter((c) => c.args[0] === 'status' && (!cwd || c.cwd === cwd)).length
    const gate$ = () => { let resolve; const promise = new Promise((r) => (resolve = r)); gate = { promise, resolve }; return () => { gate = null; resolve() } }
    return { svc, emitted, calls, watches, statusOut, advance, flush, statusCalls, gate: gate$, get now() { return now }, timers, setIndexMtime: (m) => { indexMtime = m } }
  }
  const T = (key, cwd, active = false, extra = {}) => ({ key, cwd, workspaceId: key.slice(3), active, ...extra })
  {
    const h = harness()
    h.svc.setTargets([T('ws:a', 'C:\\repo', true), T('ws:b', 'c:\\REPO', false)])
    await h.flush()
    check(h.statusCalls() === 1, 'two workspaces on the same folder share one run')
    check(h.emitted.length === 2 && h.emitted.every((e) => e.summary && e.summary.branch === 'main' && e.summary.files === 0), 'each key gets the summary')
    check(!h.calls.some((c) => c.args[0] === 'diff'), 'clean repo: no diff process (status reports no tracked change)')
    await h.advance(60_000)
    check(h.statusCalls() === 1, 'unfocused window: no periodic git processes')
    h.svc.setFocused(true)
    await h.flush()
    check(h.statusCalls() === 2, 'focus refreshes the active workspace')
    const before = h.emitted.length
    await h.advance(ACTIVE_POLL_MS)
    check(h.statusCalls() === 3 && h.emitted.length === before, 'focused: active poll every 10 s, and no emit when nothing changed')
    h.statusOut.set('C:\\repo', Z(`# branch.oid ${H}`, '# branch.head main', `1 .M N... 100644 100644 100644 ${H} ${H} x.ts`))
    await h.advance(ACTIVE_POLL_MS)
    const last = h.emitted.at(-1)
    check(h.emitted.length === before + 2 && last.summary.added === 5 && last.summary.removed === 1 && last.summary.updatedAt === h.now - 0, 'a change emits once per key with fresh counts and updatedAt')
    check(h.calls.filter((c) => c.args[0] === 'diff').at(-1).args.join(' ') === 'diff HEAD --no-ext-diff --no-textconv -z --numstat -M', 'tracked change: one diff HEAD numstat with rename detection and no external diff')
    h.svc.setFocused(false)
    await h.advance(5 * ACTIVE_POLL_MS)
    check(h.statusCalls() === 4, 'blur stops the poll')
    h.svc.setTargets([T('ws:a', 'C:\\repo', true), T('ws:b', 'c:\\REPO', false)])
    check(h.emitted.slice(-2).every((e) => e.summary.added === 5), 'setWatch re-emits cached results (a reloaded renderer catches up)')
    h.svc.dispose()
  }
  {
    const h = harness()
    h.svc.setTargets([T('ws:a', 'C:\\r1', true)])
    await h.flush()
    h.svc.refresh(['ws:a'], 'manual')
    await h.flush()
    check(h.statusCalls() === 1, 'a manual refresh right after a run waits out the 1.5 s minimum gap')
    await h.advance(MIN_RUN_GAP_MS)
    check(h.statusCalls() === 2, 'and runs once the gap is over')
    await h.advance(MIN_RUN_GAP_MS)
    // Gated run: never call advance/flush while gated (they await the run).
    const release = h.gate()
    h.svc.refresh(['ws:a'], 'manual')
    for (let i = 0; i < 4; i++) await tick()
    check(h.statusCalls() === 3, 'the gated run started')
    const inflightCalls = h.calls.length
    h.svc.refresh(['ws:a'], 'manual'); h.svc.refresh(['ws:a'], 'manual'); h.svc.refresh(['ws:a'], 'manual')
    for (let i = 0; i < 4; i++) await tick()
    check(h.calls.length === inflightCalls, 'single flight: no second process while one runs')
    release()
    await h.advance(MIN_RUN_GAP_MS * 3)
    check(h.statusCalls() === 4, `three requests during a run collapse into one rerun (status runs ${h.statusCalls()})`)
    h.svc.dispose()
  }
  {
    const h = harness()
    h.svc.setTargets([T('ws:a', 'C:\\w', true)])
    await h.flush()
    const gitdir = h.watches.find((w) => w.dir === 'C:\\w\\.git' && !w.recursive && h.watches.indexOf(w) === 0)
    const common = h.watches.filter((w) => w.dir === 'C:\\w\\.git')[1]
    const refs = h.watches.find((w) => w.recursive)
    check(gitdir && common && refs && refs.dir === path.join('C:\\w\\.git', 'refs'), 'watchers: gitdir, common dir and recursive refs')
    const runs = h.svc.stats.runs
    gitdir.onEvent('index')
    await h.advance(WATCH_DEBOUNCE_MS * 4)
    check(h.svc.stats.runs === runs, 'index event right after our own run is ignored (no refresh loop)')
    gitdir.onEvent('index.lock'); gitdir.onEvent('config'); gitdir.onEvent(null)
    await h.advance(WATCH_DEBOUNCE_MS * 4)
    check(h.svc.stats.runs === runs, 'unrelated gitdir names never refresh')
    gitdir.onEvent('index')
    await h.advance(WATCH_DEBOUNCE_MS - 1)
    check(h.svc.stats.runs === runs, 'watch refresh is debounced 500 ms')
    await h.advance(1)
    check(h.svc.stats.runs === runs + 1, 'git add (index) refreshes after the debounce')
    await h.advance(MIN_RUN_GAP_MS)
    gitdir.onEvent('HEAD'); gitdir.onEvent('HEAD'); gitdir.onEvent('rebase-merge')
    await h.advance(WATCH_DEBOUNCE_MS)
    check(h.svc.stats.runs === runs + 2, 'a burst of HEAD/rebase events is one refresh')
    await h.advance(MIN_RUN_GAP_MS)
    refs.onEvent('heads\\sn\\x')
    await h.advance(WATCH_DEBOUNCE_MS)
    check(h.svc.stats.runs === runs + 3, 'checkout -b sn/x (refs/heads) refreshes')
    await h.advance(MIN_RUN_GAP_MS)
    refs.onEvent('tags/v1'); common.onEvent('config')
    await h.advance(WATCH_DEBOUNCE_MS * 2)
    check(h.svc.stats.runs === runs + 3, 'tags and config do not refresh')
    common.onEvent('FETCH_HEAD')
    await h.advance(WATCH_DEBOUNCE_MS)
    check(h.svc.stats.runs === runs + 4, 'a fetch (FETCH_HEAD) refreshes')
    await h.advance(MIN_RUN_GAP_MS)
    h.setIndexMtime(1)
    h.svc.refresh(['ws:a'], 'manual')
    await h.flush()
    const r5 = h.svc.stats.runs
    gitdir.onEvent('index')
    await h.advance(WATCH_DEBOUNCE_MS * 4)
    check(h.svc.stats.runs === r5, 'inside the window, an index event with an unchanged mtime is ours and ignored')
    h.svc.refresh(['ws:a'], 'manual')
    await h.flush()
    h.setIndexMtime(2)
    gitdir.onEvent('index')
    await h.advance(WATCH_DEBOUNCE_MS + MIN_RUN_GAP_MS)
    check(h.svc.stats.runs === r5 + 2, 'a real git add right after a run (index mtime moved) still refreshes')
    const quiet = h.svc.stats.runs
    await h.advance(120_000)
    check(h.svc.stats.runs === quiet, 'at rest git.runs does not grow')
    h.svc.setEnabled(false)
    check(h.watches.every((w) => w.closed), 'gitChip off closes every watcher')
    h.svc.setFocused(true)
    h.svc.refresh(['ws:a'], 'agent')
    await h.advance(ACTIVE_POLL_MS * 3)
    check(h.svc.stats.runs === quiet, 'gitChip off: no focus, poll or agent refresh')
    h.svc.refresh(['ws:a'], 'manual')
    await h.flush()
    check(h.svc.stats.runs === quiet + 1, 'gitChip off: a manual refresh still runs')
    h.svc.setFocused(false)
    h.svc.setEnabled(true)
    await h.flush()
    check(h.watches.filter((w) => !w.closed).length === 3, 'gitChip on again reopens the watchers')
    h.svc.dispose()
    check(h.watches.every((w) => w.closed), 'dispose closes every watcher')
  }
  {
    const h = harness()
    h.svc.setTargets([T('ws:a', 'C:\\ag', true)])
    await h.advance(MIN_RUN_GAP_MS)
    const runs = h.svc.stats.runs
    h.svc.refresh(['ws:a'], 'agent')
    await h.advance(AGENT_DEBOUNCE_MS - 100)
    h.svc.refresh(['ws:a'], 'agent')
    await h.advance(AGENT_DEBOUNCE_MS - 1)
    check(h.svc.stats.runs === runs, 'agent nudges are debounced 1500 ms')
    await h.advance(1)
    check(h.svc.stats.runs === runs + 1, 'agent done refreshes its target within 2 s')
    h.svc.refresh(['ws:nope'], 'agent')
    await h.advance(AGENT_DEBOUNCE_MS * 2)
    check(h.svc.stats.runs === runs + 1, 'unknown keys are ignored')
    h.svc.dispose()
  }
  {
    // Focus: active now, then stale inactive targets 2 at a time every 250 ms.
    const h = harness()
    h.svc.setEnabled(false)
    h.svc.setTargets([T('ws:act', 'C:\\act', true), ...[1, 2, 3, 4, 5].map((i) => T(`ws:i${i}`, `C:\\i${i}`))])
    h.svc.setEnabled(true)
    await h.flush()
    check(h.statusCalls() === 6, 'enabling refreshes every target once')
    await h.advance(31_000)
    h.svc.setFocused(true)
    await h.flush()
    check(h.statusCalls('C:\\act') === 2 && h.statusCalls() === 7, 'focus: the active workspace refreshes at once')
    await h.advance(FOCUS_BATCH_GAP_MS)
    check(h.statusCalls() === 9, 'first batch: 2 stale targets')
    await h.advance(FOCUS_BATCH_GAP_MS)
    check(h.statusCalls() === 11, 'second batch: 2 more')
    await h.advance(FOCUS_BATCH_GAP_MS)
    check(h.statusCalls() === 12, 'last batch: the remaining one')
    h.svc.setFocused(false)
    await h.advance(5_000)
    h.svc.setFocused(true)
    await h.advance(FOCUS_BATCH_GAP_MS * 4)
    check(h.statusCalls() === 13, 'a quick alt-tab refreshes only the active workspace (others are fresh)')
    h.svc.dispose()
  }
  {
    // Hot target (phone) polls unfocused for 60 s; panel target polls every 3 s.
    const h = harness()
    h.svc.setTargets([T('ws:a', 'C:\\hot', false)])
    await h.flush()
    h.svc.markHot('ws:a')
    await h.advance(HOT_MS)
    const hot = h.statusCalls()
    check(hot >= 6 && hot <= 8, `hot target polls every 10 s unfocused (${hot} runs in 60 s)`)
    await h.advance(HOT_MS)
    check(h.statusCalls() <= hot + 1, 'the hot window ends')
    h.svc.setFocused(true)
    await h.flush()
    const base = h.statusCalls()
    h.svc.setPanelTarget('ws:a')
    await h.advance(PANEL_POLL_MS * 4)
    check(h.statusCalls() - base >= 4, 'panel target polls every 3 s while focused')
    h.svc.setPanelTarget(null)
    const after = h.statusCalls()
    await h.advance(PANEL_POLL_MS * 4)
    check(h.statusCalls() === after, 'closing the panel stops its poll (inactive target)')
    const fresh = await h.svc.ensureFresh('ws:a', 60_000)
    check(fresh && fresh.summary && h.statusCalls() === after, 'ensureFresh serves a recent cache without a run')
    await h.advance(3_000)
    const forced = h.svc.ensureFresh('ws:a', 2_000)
    await h.advance(MIN_RUN_GAP_MS)
    check((await forced).summary.branch === 'main' && h.statusCalls() === after + 1, 'ensureFresh refreshes a stale cache first')
    check((await h.svc.ensureFresh('ws:none', 0)) === null, 'unknown target gives null')
    h.svc.dispose()
  }
  {
    // 26 targets: 24 hold watchers (active first), 2 poll/focus/agent only.
    const h = harness()
    const many = Array.from({ length: 26 }, (_, i) => T(`ws:t${i}`, `C:\\t${i}`, i === 25))
    h.svc.setTargets(many)
    await h.flush()
    check(h.svc.watchedCount() === MAX_WATCHED, `cap of ${MAX_WATCHED} watched targets (got ${h.svc.watchedCount()})`)
    check(h.watches.some((w) => w.dir === 'C:\\t25\\.git' && !w.closed), 'the active target always has a watcher')
    h.svc.setTargets(many.slice(0, 3))
    check(h.svc.watchedCount() === 3 && h.watches.filter((w) => !w.closed).length === 9, 'removed targets drop their watchers')
    h.svc.dispose()
  }
  {
    // Errors: not a repo and too old a git; error emitted once.
    const h = harness({ notRepo: new Set(['C:\\plain']) })
    h.svc.setTargets([T('ws:p', 'C:\\plain', true)])
    await h.flush()
    check(h.emitted.length === 1 && h.emitted[0].summary === null && h.emitted[0].error === 'not_repo', 'a folder without repo: no summary, not_repo')
    h.svc.refresh(undefined, 'manual')
    await h.advance(MIN_RUN_GAP_MS)
    check(h.emitted.length === 1 && h.watches.length === 0, 'same error is not re-emitted and there is nothing to watch')
    h.svc.dispose()
    const old = harness({ info: { available: true, version: '2.19.0', tooOld: true } })
    old.svc.setTargets([T('ws:o', 'C:\\o', true)])
    await old.flush()
    check(old.emitted[0].error === 'git_old' && old.statusCalls() === 0, 'git older than 2.20: git_old, no status run')
    old.svc.dispose()
    const none = harness({ info: { available: false } })
    none.svc.setTargets([T('ws:n', 'C:\\n', true)])
    await none.flush()
    check(none.emitted[0].error === 'git_missing', 'no git on PATH: git_missing')
    none.svc.dispose()
  }
  same(sanitizeTargets([
    { key: 'ws:a', cwd: 'C:\\a', workspaceId: 'a', active: true },
    { key: 'ws:a', cwd: 'C:\\dup', workspaceId: 'a', active: true },
    { key: 'pane:p1', cwd: 'C:\\wt', workspaceId: 'a', paneId: 'p1', active: 1 },
    { key: 'ws:rel', cwd: 'relative\\x', workspaceId: 'rel', active: true },
    { key: 'evil', cwd: 'C:\\x', workspaceId: 'x', active: true },
    { key: 'ws:nl', cwd: 'C:\\x\ny', workspaceId: 'nl', active: true },
    null, 42,
  ], path.win32.isAbsolute), [
    { key: 'ws:a', cwd: 'C:\\a', workspaceId: 'a', active: true },
    { key: 'pane:p1', cwd: 'C:\\wt', workspaceId: 'a', paneId: 'p1', active: false },
  ], 'setWatch payload: absolute cwds, known key shapes, no duplicates')
  same(sanitizeTargets('nope', path.isAbsolute), [], 'non array payload')

  // Real repositories in temp (E7-FR-05 acceptance).
  let gitOk = true
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }) } catch { gitOk = false }
  if (!gitOk) {
    console.log('SKIP: git not on PATH, real repository checks skipped')
  } else {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'snaos-git-'))
    const cleanEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(base, 'gitconfig') }
    fs.writeFileSync(cleanEnv.GIT_CONFIG_GLOBAL, '[core]\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n')
    for (const k of Object.keys(cleanEnv)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE)$/i.test(k)) delete cleanEnv[k]
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
    const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s) }
    const lines = (n, tag = 'l') => Array.from({ length: n }, (_, i) => `${tag}${i}`).join('\n') + '\n'
    const realRunner = gx.createGitRunner({ env: () => gx.gitEnv(cleanEnv) })
    async function summarize(cwd, runner = realRunner, untracked) {
      const emitted = []
      const svc = new GitService({ runner, emit: (e) => emitted.push(e), ...(untracked ? { untracked } : {}), watch: () => null })
      svc.setTargets([{ key: 'ws:x', cwd, workspaceId: 'x', active: false }])
      await svc.idle()
      const view = svc.get('ws:x')
      svc.dispose()
      return view
    }
    try {
      // 1 staged, 1 unstaged, 1 rename, 1 untracked of 10 lines -> files=4.
      const mix = path.join(base, 'mix')
      fs.mkdirSync(mix)
      git(mix, 'init', '-q', '-b', 'main')
      write(path.join(mix, 'staged.txt'), lines(3)); write(path.join(mix, 'work.txt'), lines(4)); write(path.join(mix, 'old name.txt'), lines(5))
      git(mix, 'add', '-A'); git(mix, 'commit', '-qm', 'init')
      write(path.join(mix, 'staged.txt'), lines(3) + lines(2, 's')); git(mix, 'add', 'staged.txt')
      write(path.join(mix, 'work.txt'), lines(3))
      git(mix, 'mv', 'old name.txt', 'new name.txt')
      write(path.join(mix, '\u00f1 dir', 'un tracked.txt'), lines(10))
      const v = await summarize(mix)
      const s = v.summary
      check(s && s.files === 4 && s.staged === 2 && s.unstaged === 1 && s.untracked === 1, `staged + unstaged + rename + untracked: files=4 (got ${JSON.stringify(s && { files: s.files, staged: s.staged, unstaged: s.unstaged, untracked: s.untracked })})`)
      check(s.added === 12 && s.removed === 1, `lines: +2 staged +10 untracked, -1 unstaged (got +${s.added} -${s.removed})`)
      check(s.branch === 'main' && !s.detached && !s.unborn && s.headShort.length === 7 && s.upstream === null && s.op === null && !s.approx, 'branch main, no upstream, no operation')
      check(path.resolve(s.repoRoot).toLowerCase() === path.resolve(mix).toLowerCase(), 'repoRoot resolved')
      check(v.files.some((f) => f.path === '\u00f1 dir/un tracked.txt') && v.files.some((f) => f.path === 'new name.txt' && f.oldPath === 'old name.txt'), 'unicode untracked path and rename in the file list')

      // +10 staged whose lines are rewritten afterwards: +10 against HEAD, not +20 -10.
      const sm = path.join(base, 'sm')
      fs.mkdirSync(sm)
      git(sm, 'init', '-q', '-b', 'main')
      write(path.join(sm, 'f.txt'), lines(5)); git(sm, 'add', '-A'); git(sm, 'commit', '-qm', 'init')
      write(path.join(sm, 'f.txt'), lines(5) + lines(10, 'a')); git(sm, 'add', 'f.txt')
      write(path.join(sm, 'f.txt'), lines(5) + lines(10, 'b'))
      const smv = (await summarize(sm)).summary
      check(smv.added === 10 && smv.removed === 0 && smv.files === 1 && smv.staged === 1 && smv.unstaged === 1, `staged then modified: +10 vs HEAD, one file in two areas (got +${smv.added} -${smv.removed})`)

      // Unborn: counts from the index plus the working tree.
      const ub = path.join(base, 'unborn')
      fs.mkdirSync(ub)
      git(ub, 'init', '-q', '-b', 'main')
      write(path.join(ub, 'a.txt'), lines(3)); git(ub, 'add', 'a.txt')
      write(path.join(ub, 'b.txt'), lines(2))
      const ubv = (await summarize(ub)).summary
      check(ubv.unborn && ubv.branch === 'main' && ubv.headShort === '' && ubv.added === 5 && ubv.files === 2, `unborn repo: index + working tree (got +${ubv.added}, files ${ubv.files})`)

      // Ahead/behind against a local bare remote.
      const bare = path.join(base, 'remote.git')
      git(base, 'init', '-q', '--bare', '-b', 'main', bare)
      const c1 = path.join(base, 'c1')
      const c2 = path.join(base, 'c2')
      git(base, 'clone', '-q', bare, c1)
      write(path.join(c1, 'r.txt'), lines(1)); git(c1, 'add', '-A'); git(c1, 'commit', '-qm', 'one'); git(c1, 'push', '-q', '-u', 'origin', 'main')
      git(base, 'clone', '-q', bare, c2)
      write(path.join(c2, 'r2.txt'), lines(1)); git(c2, 'add', '-A'); git(c2, 'commit', '-qm', 'two'); git(c2, 'push', '-q')
      write(path.join(c1, 'l.txt'), lines(1)); git(c1, 'add', '-A'); git(c1, 'commit', '-qm', 'local')
      git(c1, 'fetch', '-q')
      const abv = (await summarize(c1)).summary
      check(abv.upstream === 'origin/main' && abv.ahead === 1 && abv.behind === 1 && abv.files === 0, `ahead/behind as of the last fetch (got ${abv.upstream} +${abv.ahead}/-${abv.behind})`)

      // Merge conflict: conflicts=1, op=merge.
      const mg = path.join(base, 'merge')
      fs.mkdirSync(mg)
      git(mg, 'init', '-q', '-b', 'main')
      write(path.join(mg, 'c.txt'), 'base\n'); git(mg, 'add', '-A'); git(mg, 'commit', '-qm', 'base')
      git(mg, 'checkout', '-q', '-b', 'other'); write(path.join(mg, 'c.txt'), 'other\n'); git(mg, 'commit', '-qam', 'other')
      git(mg, 'checkout', '-q', 'main'); write(path.join(mg, 'c.txt'), 'mine\n'); git(mg, 'commit', '-qam', 'mine')
      try { git(mg, 'merge', '-q', 'other') } catch { /* conflict expected */ }
      const mgv = (await summarize(mg)).summary
      check(mgv.conflicts === 1 && mgv.op === 'merge', `merge conflict: 1 conflict, MERGE tag (got ${mgv.conflicts}, ${mgv.op})`)

      // GIT_DIR polluted in the app env: the summary is still the cwd's.
      const polluted = gx.createGitRunner({ env: () => gx.gitEnv({ ...cleanEnv, GIT_DIR: path.join(mix, '.git'), git_work_tree: mix }) })
      const pv = (await summarize(sm, polluted)).summary
      check(pv && pv.files === 1 && pv.added === 10 && path.resolve(pv.repoRoot).toLowerCase() === path.resolve(sm).toLowerCase(), 'GIT_DIR / GIT_WORK_TREE in the env never redirect the query')

      // A folder holding its own git.exe never runs it (Windows searches the cwd first for a bare name).
      check(path.isAbsolute((await realRunner.info()).path || ''), 'the runner reports git by its absolute path')
      const sys32Host = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'hostname.exe')
      if (process.platform === 'win32' && fs.existsSync(sys32Host)) {
        const trap = path.join(base, 'trap')
        fs.mkdirSync(trap)
        fs.copyFileSync(sys32Host, path.join(trap, 'git.exe'))
        const tv = await summarize(trap)
        check(tv.summary === null && tv.error === 'not_repo', `a planted git.exe in the cwd is not run (got ${tv.error})`)
      }
      const gone = await summarize(path.join(base, 'does-not-exist'))
      check(gone.error === 'not_repo', `a deleted workspace folder is not_repo, not git_missing (got ${gone.error})`)

      // Not a repo.
      const plain = path.join(base, 'plain')
      fs.mkdirSync(plain)
      const nv = await summarize(plain)
      check(nv.summary === null && nv.error === 'not_repo', 'a folder without repo gives not_repo (no chip)')

      // No index.lock is ever taken by a refresh.
      check(!fs.existsSync(path.join(mix, '.git', 'index.lock')), 'refresh leaves no index.lock behind')

      // Untracked cache on a real tree: a second refresh reads nothing.
      const { UntrackedCounter } = loadMain('src/main/git/untrackedLines.ts')
      let realReads = 0
      const counting = new UntrackedCounter({ stat: (p) => fs.promises.stat(p), readFile: (p) => { realReads++; return fs.promises.readFile(p) } })
      let clock = 1_000_000
      const cached = new GitService({ runner: realRunner, emit: () => {}, untracked: counting, watch: () => null, now: () => clock })
      cached.setTargets([{ key: 'ws:x', cwd: mix, workspaceId: 'x', active: false }])
      await cached.idle()
      const firstReads = realReads
      clock += 5_000
      cached.refresh(['ws:x'], 'manual')
      await cached.idle()
      check(cached.stats.runs === 2 && firstReads === 1 && realReads === 1, `real tree: untracked file read once, then served from cache (${firstReads}, ${realReads})`)
      cached.dispose()

      // Real fs.watch on the gitdir and refs: git add and checkout -b refresh on their own.
      const live = []
      const watched = new GitService({ runner: realRunner, emit: (e) => live.push(e) })
      watched.setTargets([{ key: 'ws:x', cwd: mix, workspaceId: 'x', active: false }])
      await watched.idle()
      const waitFor = async (pred, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 50)) } return false }
      check(watched.watchedCount() === 1, 'real repo gets its gitdir watcher')
      git(mix, 'add', 'work.txt')
      const addOk = await waitFor(() => live.at(-1)?.summary?.staged === 3)
      if (!addOk) console.error('DEBUG', JSON.stringify(live.map((e) => e.summary && e.summary.staged)), watched.stats)
      check(addOk, 'git add refreshes the chip through the watcher')
      git(mix, 'checkout', '-q', '-b', 'sn/x')
      check(await waitFor(() => live.at(-1)?.summary?.branch === 'sn/x'), 'git checkout -b sn/x refreshes the branch through the watcher')
      const settled = watched.stats.runs
      await new Promise((r) => setTimeout(r, 2500))
      check(watched.stats.runs === settled, `no refresh loop from our own runs (runs ${settled} -> ${watched.stats.runs})`)
      watched.dispose()

      // gitInfo on the real PATH.
      const info = await realRunner.info()
      check(info.available && /^\d+\.\d+/.test(info.version) && info.tooOld === false, `git info: ${info.version} at ${info.path}`)
      const noGit = await gx.createGitRunner({ gitBin: 'git-does-not-exist-snaos' }).info()
      check(noGit.available === false, 'missing git binary: available=false ("git not found")')
    } finally {
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
    }
  }

  // Renderer: chip helpers, gitStore, gitSync and the phone snapshot.
  const chip = load('src/renderer/lib/gitChip.ts')
  const sum = (o = {}) => ({ repoRoot: 'C:\\fixture\\secret-repo', branch: 'main', detached: false, unborn: false, headShort: 'abc1234', upstream: 'origin/main', ahead: 2, behind: 1, files: 5, added: 142, removed: 37, approx: false, staged: 1, unstaged: 3, untracked: 1, conflicts: 0, op: null, truncated: false, updatedAt: 5, ...o })
  check(chip.compactChip(sum()) === 'main +142 -37' && chip.compactChip(sum({ files: 0 })) === 'main', 'sidebar text: "main +142 -37", only the branch when clean')
  check(chip.addedLabel(sum({ approx: true })) === '+142+', 'approx count reads +N+')
  check(chip.chipBranch(sum({ branch: null, detached: true })) === 'abc1234', 'detached shows the short sha')
  same(chip.aheadBehind(sum({ upstream: null })), { ahead: 0, behind: 0 }, 'no upstream: no arrows')
  same(chip.remoteGitChip(sum()), { branch: 'main', ahead: 2, behind: 1, added: 142, removed: 37, files: 5 }, 'phone chip has exactly the contract fields')
  check(chip.remoteGitChip(null) === undefined, 'no summary: no phone chip')
  check(chip.gitChipEnabled({}) && chip.gitChipEnabled({ gitChip: true }) && !chip.gitChipEnabled({ gitChip: false }), 'gitChip absent counts as on')
  const wsList = [
    { id: 'w1', name: 'A', cwd: 'C:\\a', panes: [{ id: 'p1', type: 'claude' }, { id: 'p2', type: 'claude', worktree: { path: 'C:\\wt\\x', repoRoot: 'C:\\a', branch: 'sn/x', base: 'abc' } }] },
    { id: 'w2', name: 'B', cwd: '', panes: [] },
  ]
  same(chip.buildGitTargets(wsList, 'w1'), [
    { key: 'ws:w1', cwd: 'C:\\a', workspaceId: 'w1', active: true },
    { key: 'pane:p2', cwd: 'C:\\wt\\x', workspaceId: 'w1', paneId: 'p2', active: true },
  ], 'targets: workspace cwd and pane worktrees; a workspace without cwd has none')
  check(chip.agentFinished('working', 'done') && chip.agentFinished('working', 'idle') && chip.agentFinished('working', 'action'), 'working -> done/idle/action is a finish')
  check(!chip.agentFinished('idle', 'done') && !chip.agentFinished('working', 'error') && !chip.agentFinished('working', undefined) && !chip.agentFinished(undefined, 'done'), 'other transitions are not')

  const pushes = []
  const gitCalls = { watch: [], config: [], refresh: [] }
  let updateCb = null
  const fakeWin = {
    snApi: {
      remote: { pushState: (s) => pushes.push(JSON.parse(JSON.stringify(s))) },
      git: { setWatch: (t) => gitCalls.watch.push(t), setConfig: (c) => gitCalls.config.push(c), refresh: (r) => gitCalls.refresh.push(r), info: async () => ({ available: true, version: '2.45.0' }), onUpdate: (cb) => { updateCb = cb; return () => { updateCb = null } } },
    },
    addEventListener() {}, removeEventListener() {},
  }
  const entry = `export { startRemoteSnapshotSync } from './src/renderer/lib/remoteSnapshot'\nexport { startGitSync } from './src/renderer/lib/gitSync'\nexport { useAppStore } from './src/renderer/lib/store'\nexport { useGitStore } from './src/renderer/lib/gitStore'\n`
  const bundle = buildSync({ stdin: { contents: entry, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') } }).outputFiles[0].text
  const rmod = { exports: {} }
  vm.runInNewContext(bundle, { module: rmod, exports: rmod.exports, require, console, process, window: fakeWin, setTimeout, clearTimeout, crypto: globalThis.crypto })
  const { startRemoteSnapshotSync, startGitSync, useAppStore, useGitStore } = rmod.exports
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const pane = (id) => ({ id, type: 'claude', title: id, color: '#fff', icon: 'bot' })
  useAppStore.setState({ workspaces: [{ id: 'w1', name: 'A', cwd: 'C:\\fixture\\secret-repo', panes: [pane('p1')] }], activeWorkspaceId: 'w1' })
  const stopGit = startGitSync()
  same(gitCalls.config, [{ gitChip: true }], 'gitSync pushes settings.gitChip')
  same(gitCalls.watch.at(-1), [{ key: 'ws:w1', cwd: 'C:\\fixture\\secret-repo', workspaceId: 'w1', active: true }], 'gitSync pushes the targets')
  const stopSnap = startRemoteSnapshotSync()
  const p0 = pushes.length
  updateCb({ key: 'ws:w1', cwd: 'C:\\fixture\\secret-repo', summary: sum() })
  await sleep(160)
  const snap = pushes.at(-1)
  same(snap.workspaces[0].git, { branch: 'main', ahead: 2, behind: 1, added: 142, removed: 37, files: 5 }, 'state carries RemoteWorkspaceInfo.git')
  check(pushes.length === p0 + 1 && !JSON.stringify(snap).includes('secret-repo') && !JSON.stringify(snap).includes('repoRoot'), 'no state ever contains the repo root or the cwd')
  updateCb({ key: 'ws:w1', cwd: 'C:\\fixture\\secret-repo', summary: sum() })
  await sleep(160)
  check(pushes.length === p0 + 1, 'an unchanged summary does not push a new state')
  updateCb({ key: 'ws:w1', cwd: 'C:\\fixture\\secret-repo', summary: sum({ staged: 2, unstaged: 2, updatedAt: 9 }) })
  updateCb({ key: 'pane:p9', cwd: 'C:\\wt', summary: sum({ branch: 'sn/x' }) })
  await sleep(160)
  check(pushes.length === p0 + 1 && useGitStore.getState().summaries['ws:w1'].staged === 2, 'a change the phone cannot see (areas, updatedAt, a pane worktree) pushes no state')
  useAppStore.setState((s) => ({ settings: { ...s.settings, gitChip: false } }))
  await sleep(160)
  check(pushes.length === p0 + 2 && pushes.at(-1).workspaces[0].git === undefined, 'gitChip off omits git from the state')
  same(gitCalls.config.at(-1), { gitChip: false }, 'gitChip off reaches main')
  useAppStore.setState((s) => ({ settings: { ...s.settings, gitChip: true } }))
  updateCb({ key: 'ws:w1', cwd: 'C:\\fixture\\secret-repo', summary: null, error: 'not_repo' })
  await sleep(160)
  check(pushes.at(-1).workspaces[0].git === undefined && useGitStore.getState().errors['ws:w1'] === 'not_repo', 'an error drops the chip and keeps the error')
  useAppStore.setState({ paneStatus: { p1: { state: 'working', precise: true } } })
  useAppStore.setState({ paneStatus: { p1: { state: 'done', precise: true } } })
  same(gitCalls.refresh.at(-1), { keys: ['ws:w1'], reason: 'agent' }, 'an agent finishing nudges its workspace target')
  const nRefresh = gitCalls.refresh.length
  useAppStore.setState({ paneStatus: { p1: { state: 'idle', precise: true } } })
  check(gitCalls.refresh.length === nRefresh, 'done -> idle is not a new nudge')
  useAppStore.setState({ workspaces: [], activeWorkspaceId: null })
  check(gitCalls.watch.at(-1).length === 0 && Object.keys(useGitStore.getState().errors).length === 0, 'a deleted workspace leaves the targets and the store')
  stopSnap()
  stopGit()

  asyncDone = true
  console.log(`PASS: ${checks} git checks (${dropChecks} drop/paste, ${schema13Checks} schema 13 worktree, ${checks - dropChecks - schema13Checks} GitService: porcelain, numstat, exec env + semaphore, untracked budget, refresh policy, watchers, real repos, chip, snapshot)`)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
