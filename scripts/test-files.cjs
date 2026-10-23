// Files drawer (v2.2, E9): FileService on a temp workspace folder. The root
// comes from the config only; relative paths are checked (no `..`, no drive,
// no `.git`) and every target's realpath stays inside the folder (a junction
// or symlink out is refused). Text keeps its BOM and CRLF, binaries and big
// files are refused, images come as data URLs, saves detect a newer file on
// disk, create / rename / trash / reveal / open behave, and the watch
// gathers changes per folder. Same esbuild + vm harness as test-status.cjs.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, URL, Intl, setTimeout, clearTimeout, ...overrides })
  return mod.exports
}

async function main() {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-files-')))
  const repo = path.join(tmp, 'repo')
  const outside = path.join(tmp, 'outside')
  fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true })
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret')
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  fs.writeFileSync(path.join(repo, 'README.md'), '# Hola\n')
  fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'const a = 1\n')
  fs.writeFileSync(path.join(repo, 'src', 'file10.ts'), '')
  fs.writeFileSync(path.join(repo, 'src', 'file2.ts'), '')
  fs.writeFileSync(path.join(repo, 'win.txt'), Buffer.from('\ufeffuno\r\ndos\r\n', 'utf8'))
  fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([1, 2, 0, 3]))
  fs.writeFileSync(path.join(repo, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  fs.writeFileSync(path.join(repo, 'big.log'), Buffer.alloc(5 * 1024 * 1024 + 1, 0x61))
  fs.writeFileSync(path.join(repo, 'mid.log'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x62))
  let linked = true
  try { fs.symlinkSync(outside, path.join(repo, 'escape'), 'junction') } catch { linked = false }

  const shared = load('src/shared/files.ts')
  check(shared.isSafeRel('') && shared.isSafeRel('src/app.ts') && shared.isSafeRel('a b/c.d'), 'plain relative paths are safe')
  for (const bad of ['../x', 'src/../../x', '/etc/passwd', 'C:\\Windows', 'C:/x', 'a//b', 'a/./b', 'a\\b', 'a\u0000b', 'trailing.', 'trailing ', 'x:stream', 5, null]) check(!shared.isSafeRel(bad), 'unsafe rel ' + JSON.stringify(bad))
  check(shared.isSafeName('nuevo.ts') && !shared.isSafeName('a/b') && !shared.isSafeName('') && !shared.isSafeName('..'), 'a new name is one safe segment')
  check(shared.inGitDir('.git') && shared.inGitDir('.git/HEAD') && !shared.inGitDir('.github/x'), '.git and only .git')

  const calls = { trash: [], reveal: [], open: [], emit: [] }
  let cfg = { workspaces: [{ id: 'w1', name: 'Repo', cwd: repo, panes: [] }, { id: 'w2', name: 'Sin carpeta', cwd: '', panes: [] }, { id: 'w3', name: 'Relativa', cwd: 'repo', panes: [] }] }
  let watchCb = null, watchClosed = 0
  const timers = []
  const { FileService } = load('src/main/files/FileService.ts', {
    setTimeout: (fn) => { timers.push(fn); return timers.length },
    clearTimeout: () => {},
  })
  const fsvc = new FileService({
    config: () => cfg,
    emit: (e) => calls.emit.push(e),
    trash: async (p) => { calls.trash.push(p); fs.rmSync(p, { recursive: true, force: true }) },
    reveal: (p) => calls.reveal.push(p),
    openPath: async (p) => { calls.open.push(p); return '' },
    watchRoot: (r, onEvent) => { watchCb = onEvent; return { close() { watchClosed++ } } },
  })
  const R = (rel) => ({ workspaceId: 'w1', rel })

  // Root.
  let rootRes = fsvc.rootInfo('w1')
  check(rootRes.ok && rootRes.root === repo && rootRes.name === 'repo', 'the root is the workspace folder from the config')
  check(fsvc.rootInfo('w2').error === 'no_root' && fsvc.rootInfo('w3').error === 'no_root' && fsvc.rootInfo('nope').error === 'not_found' && fsvc.rootInfo('../w').error === 'invalid', 'no folder, a relative folder, an unknown or a bad workspace id: no root')

  // List.
  let list = await fsvc.list(R(''))
  const names = list.entries.map((e) => e.name)
  check(list.ok && !names.includes('.git'), '.git is never listed')
  check(names.indexOf('src') < names.indexOf('README.md') && list.entries.find((e) => e.name === 'src').kind === 'dir', 'folders first')
  check(!linked || !names.includes('escape'), 'a junction out of the folder is not listed')
  list = await fsvc.list(R('src'))
  check(list.entries.map((e) => e.name).join() === 'deep,app.ts,file2.ts,file10.ts', 'natural order (file2 before file10)')
  check((await fsvc.list(R('../outside'))).error === 'invalid' && (await fsvc.list(R('.git'))).error === 'invalid' && (await fsvc.list(R('nope'))).error === 'not_found', 'list refuses .., .git and a missing folder')
  if (linked) check((await fsvc.list(R('escape'))).error === 'denied_path' && (await fsvc.read(R('escape/secret.txt'))).error === 'denied_path', 'a junction out of the folder is denied by realpath')

  // Read.
  let rd = await fsvc.read(R('win.txt'))
  check(rd.ok && rd.kind === 'text' && rd.text === 'uno\ndos\n' && rd.eol === 'crlf' && rd.bom === true && !rd.readOnly, 'a CRLF file with BOM reads as \\n text, reporting eol and BOM')
  rd = await fsvc.read(R('README.md'))
  check(rd.ok && rd.eol === 'lf' && rd.bom === false && rd.text === '# Hola\n', 'a plain LF file')
  check((await fsvc.read(R('bin.dat'))).error === 'binary', 'a NUL byte: binary')
  check((await fsvc.read(R('big.log'))).error === 'too_large', 'over 5 MB does not open')
  rd = await fsvc.read(R('mid.log'))
  check(rd.ok && rd.readOnly === true, 'over 2 MB opens read-only')
  rd = await fsvc.read(R('logo.png'))
  check(rd.ok && rd.kind === 'image' && rd.dataUrl.startsWith('data:image/png;base64,'), 'an image comes as a data URL')
  check((await fsvc.read(R('src'))).error === 'invalid' && (await fsvc.read(R('.git/HEAD'))).error === 'invalid', 'a folder or .git does not read')

  // Write.
  const before = (await fsvc.read(R('win.txt'))).rev
  await new Promise((r) => setTimeout(r, 20))
  let wr = await fsvc.write({ ...R('win.txt'), text: 'uno\ndos\ntres\n', eol: 'crlf', bom: true, baseRev: before })
  check(wr.ok && fs.readFileSync(path.join(repo, 'win.txt')).equals(Buffer.from('\ufeffuno\r\ndos\r\ntres\r\n', 'utf8')), 'a save restores the CRLF endings and the BOM')
  wr = await fsvc.write({ ...R('win.txt'), text: 'pisado', eol: 'lf', bom: false, baseRev: before })
  check(!wr.ok && wr.error === 'conflict' && fs.readFileSync(path.join(repo, 'win.txt'), 'utf8').includes('tres'), 'a save with an old rev is a conflict and writes nothing (an agent changed it)')
  wr = await fsvc.write({ ...R('win.txt'), text: 'pisado\n', eol: 'lf', bom: false })
  check(wr.ok && fs.readFileSync(path.join(repo, 'win.txt'), 'utf8') === 'pisado\n', 'without a rev it overwrites (Keep mine)')
  check((await fsvc.write({ ...R('nuevo.txt'), text: 'x', eol: 'lf', bom: false })).error === 'not_found', 'write only replaces an existing file')
  check((await fsvc.write({ ...R('README.md'), text: 'x', eol: 'mac', bom: false })).error === 'invalid' && (await fsvc.write({ ...R('.git/HEAD'), text: 'x', eol: 'lf', bom: false })).error === 'invalid', 'bad eol or .git: invalid')
  check((await fsvc.write({ ...R('README.md'), text: 'x'.repeat(2 * 1024 * 1024 + 1), eol: 'lf', bom: false })).error === 'too_large', 'more than 2 MB does not save')
  check(!fs.readdirSync(repo).some((n) => n.endsWith('.tmp')), 'no temp file left behind')

  // Create, rename, trash.
  check((await fsvc.create({ ...R('src/nuevo.ts'), kind: 'file' })).ok && fs.readFileSync(path.join(repo, 'src', 'nuevo.ts'), 'utf8') === '', 'create a file')
  check((await fsvc.create({ ...R('src/nuevo.ts'), kind: 'file' })).error === 'exists', 'not over an existing one')
  check((await fsvc.create({ ...R('docs'), kind: 'dir' })).ok && fs.statSync(path.join(repo, 'docs')).isDirectory(), 'create a folder')
  check((await fsvc.create({ ...R('nope/x.ts'), kind: 'file' })).error === 'not_found' && (await fsvc.create({ ...R('../x.ts'), kind: 'file' })).error === 'invalid' && (await fsvc.create({ ...R('x'), kind: 'link' })).error === 'invalid', 'create needs an existing parent inside and a known kind')
  check((await fsvc.rename({ workspaceId: 'w1', from: 'src/nuevo.ts', to: 'docs/movido.ts' })).ok && fs.existsSync(path.join(repo, 'docs', 'movido.ts')), 'rename moves inside the folder')
  check((await fsvc.rename({ workspaceId: 'w1', from: 'docs/movido.ts', to: 'README.md' })).error === 'exists' && (await fsvc.rename({ workspaceId: 'w1', from: '', to: 'x' })).error === 'invalid' && (await fsvc.rename({ workspaceId: 'w1', from: 'docs', to: '../afuera' })).error === 'invalid', 'rename never over an existing name, never the root, never out')
  check((await fsvc.trash(R('docs'))).ok && calls.trash.at(-1) === path.join(repo, 'docs'), 'trash goes to the OS trash with the real path')
  check((await fsvc.trash(R(''))).error === 'invalid', 'never the root itself')

  // Reveal and open outside.
  check(fsvc.reveal(R('README.md')).ok && calls.reveal.at(-1) === path.join(repo, 'README.md'), 'reveal in the file manager')
  calls.reveal.length = 0
  check((await fsvc.openExternal(R('README.md'))).ok && calls.open.at(-1) === path.join(repo, 'README.md') && calls.reveal.length === 0, 'an inert format (.md) opens with its app')
  fs.writeFileSync(path.join(repo, 'run.bat'), 'echo hi')
  check((await fsvc.openExternal(R('run.bat'))).ok && calls.open.length === 1 && calls.reveal.at(-1) === path.join(repo, 'run.bat'), 'anything else (a .bat) is only revealed, never run')

  // Watch: gathered per folder, .git ignored, one folder at a time.
  fsvc.watch('w1')
  check(typeof watchCb === 'function', 'the drawer watches its folder')
  watchCb('src\\app.ts'); watchCb('src/file2.ts'); watchCb('README.md'); watchCb('.git/index')
  check(calls.emit.length === 0 && timers.length === 1, 'changes are gathered (one timer)')
  timers.shift()()
  check(calls.emit.length === 1 && calls.emit[0].workspaceId === 'w1' && calls.emit[0].dirs.sort().join() === ',src' && !calls.emit[0].all, 'one event with the folders that changed, .git left out')
  watchCb(null); timers.shift()()
  check(calls.emit.at(-1).all === true, 'an event without a name reloads everything shown')
  fsvc.watch('w1')
  check(watchClosed === 0, 'watching the same folder again keeps the watch')
  fsvc.watch(null)
  check(watchClosed === 1, 'null stops it')

  // The .git guard in any case and at any depth (app 2.6.0): the drawer and share guests.
  check(shared.inGitDir('.GIT/config') && shared.inGitDir('sub/.git/HEAD') && shared.inGitDir('a/.Git') && !shared.inGitDir('.gitignore') && !shared.inGitDir('x.git/y') && !shared.inGitDir('.github/x'), '.git in any case and at any depth, nothing else')
  fs.mkdirSync(path.join(repo, 'sub', '.git'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'sub', '.git', 'config'), '[remote] url = https://token@example.invalid')
  check((await fsvc.read(R('sub/.git/config'))).error === 'invalid' && (await fsvc.read(R('.GIT/HEAD'))).error === 'invalid' && (await fsvc.list(R('sub/.git'))).error === 'invalid', 'a nested .git or another case neither reads nor lists')
  check(!(await fsvc.list(R('sub'))).entries.some((e) => e.name.toLowerCase() === '.git'), 'a nested .git is not listed')
  let gitLinked = true
  try { fs.symlinkSync(path.join(repo, '.git'), path.join(repo, 'gitlink'), 'junction') } catch { gitLinked = false }
  if (gitLinked) {
    check(!(await fsvc.list(R(''))).entries.some((e) => e.name === 'gitlink'), 'a junction into .git is not listed')
    check((await fsvc.read(R('gitlink/HEAD'))).error === 'invalid' && (await fsvc.list(R('gitlink'))).error === 'invalid', 'nor read or listed through')
  }

  // Share guests (app 2.6.0): no secret names, names a guest accepts, bounded reads.
  check(shared.isShareSecretName('.env') && shared.isShareSecretName('.ENV.local') && !shared.isShareSecretName('.env.example') && !shared.isShareSecretName('.env.template'), '.env and .env.* are secrets, the example is not')
  check(['server.PEM', 'a.key', 'cert.p12', 'c.pfx', 'id_rsa', 'id_ed25519.pub', 'ID_ECDSA', '.npmrc', '.netrc', '.pypirc'].every((n) => shared.isShareSecretName(n)) && !['keyboard.ts', 'monkey', 'key.md', 'ids.json', 'README.md'].some((n) => shared.isShareSecretName(n)), 'keys and credential files are secrets, look-alikes are not')
  check(shared.relHasShareSecret('certs/.env/x') && !shared.relHasShareSecret('') && !shared.relHasShareSecret('src/env.ts'), 'any segment of a path can hide it')
  check(shared.shareFileNameOk('a.ts') && !shared.shareFileNameOk('.git') && !shared.shareFileNameOk('.GIT') && !shared.shareFileNameOk('a' + String.fromCharCode(0x202e) + 'b') && !shared.shareFileNameOk('a/b') && !shared.shareFileNameOk('x'.repeat(256)), 'a name a guest gets is one safe segment without bidi')
  fs.writeFileSync(path.join(repo, '.env'), 'TOKEN=1')
  fs.writeFileSync(path.join(repo, '.env.example'), 'TOKEN=')
  fs.mkdirSync(path.join(repo, 'certs'))
  fs.writeFileSync(path.join(repo, 'certs', 'server.pem'), 'KEY')
  fs.writeFileSync(path.join(repo, 'certs', 'ca.txt'), 'public')
  const LIM = { textMax: 1024, imageMax: 1024 }
  const gl = await fsvc.guestList('w1', '', 2000)
  const gn = gl.entries.map((e) => e.name)
  check(gl.ok && !gn.includes('.env') && gn.includes('.env.example') && !gn.includes('.git') && gn.includes('README.md') && gn.includes('certs'), 'a guest never lists a secret name')
  check((await fsvc.guestList('w1', 'certs', 2000)).entries.map((e) => e.name).join() === 'ca.txt', 'nor a key inside a folder')
  check((await fsvc.guestRead('w1', '.env', LIM)).error === 'not_found' && (await fsvc.guestRead('w1', 'certs/server.pem', LIM)).error === 'not_found' && (await fsvc.guestRead('w1', '.git/HEAD', LIM)).error === 'invalid' && (await fsvc.guestRead('w1', '../outside/secret.txt', LIM)).error === 'invalid', 'nor reads a secret (not_found), .git or a path out')
  let envLinked = true
  try { fs.symlinkSync(path.join(repo, 'certs'), path.join(repo, 'pub'), 'junction'); fs.mkdirSync(path.join(repo, 'cfg')); fs.symlinkSync(path.join(repo, 'cfg'), path.join(repo, '.env.d'), 'junction') } catch { envLinked = false }
  if (envLinked) {
    check((await fsvc.guestRead('w1', 'pub/server.pem', LIM)).error === 'not_found' && (await fsvc.guestRead('w1', 'pub/ca.txt', LIM)).ok, 'a key read through a junction is still hidden')
  }
  const cut3 = await fsvc.guestList('w1', '', 3)
  check(cut3.entries.length === 3 && cut3.truncated, 'a guest list stops at its max (truncated)')
  let gr = await fsvc.guestRead('w1', 'README.md', LIM)
  check(gr.ok && gr.kind === 'text' && gr.text === '# Hola\n' && !gr.partial, 'a small file reads whole')
  fs.writeFileSync(path.join(repo, 'long.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('ñ'.repeat(10) + '\r\n' + 'x'.repeat(50), 'utf8')]))
  gr = await fsvc.guestRead('w1', 'long.txt', { textMax: 9, imageMax: 1024 })
  check(gr.ok && gr.partial && gr.bom && gr.text === 'ññññ' && !gr.text.includes(String.fromCharCode(0xfffd)), 'a long one is cut at textMax bytes on a whole character (BOM aside), partial')
  gr = await fsvc.guestRead('w1', 'big.log', LIM)
  check(gr.ok && gr.partial && gr.text.length === 1024, 'past 5 MB a guest still reads the head')
  check((await fsvc.guestRead('w1', 'logo.png', { textMax: 10, imageMax: 3 })).error === 'too_large' && (await fsvc.guestRead('w1', 'logo.png', LIM)).kind === 'image', 'an image up to imageMax')
  check((await fsvc.guestRead('w1', 'bin.dat', LIM)).error === 'binary' && (await fsvc.guestRead('w1', 'src', LIM)).error === 'invalid', 'binary and folders do not read')

  // Watches shared by the drawer and share guests: one per folder, at most FILES_WATCH_MAX folders.
  const ids = ['a', 'b', 'c', 'd', 'e']
  for (const n of ids) fs.mkdirSync(path.join(tmp, 'ws-' + n))
  const cfg2 = { workspaces: ids.map((n) => ({ id: 'x' + n, name: n, cwd: path.join(tmp, 'ws-' + n), panes: [] })) }
  const opened = [], closedRoots = [], emitted = [], timers2 = []
  const { FileService: FS2, FILES_WATCH_MAX } = load('src/main/files/FileService.ts', { setTimeout: (fn) => { timers2.push(fn); return timers2.length }, clearTimeout: () => {} })
  const f2 = new FS2({ config: () => cfg2, emit: (e) => emitted.push(e), trash: async () => {}, reveal: () => {}, openPath: async () => '', watchRoot: (r, onEvent) => { opened.push({ r, onEvent }); return { close() { closedRoots.push(r) } } } })
  f2.watch('xa')
  const got = []
  check(f2.acquireWatch('xa', 'share:g1', (e) => got.push(e)) && opened.length === 1, 'a share guest on the drawer folder shares its watch')
  opened[0].onEvent('src/a.ts'); timers2.shift()()
  check(emitted.length === 1 && got.length === 1 && got[0].dirs[0] === 'src', 'one change reaches the drawer and the guest')
  f2.watch(null)
  check(closedRoots.length === 0, 'the drawer closing keeps the watch a guest holds')
  f2.releaseWatch('xa', 'share:g1')
  check(closedRoots.length === 1 && f2.watchedCount === 0, 'the last reader out closes it')
  check(['xa', 'xb', 'xc', 'xd'].every((id) => f2.acquireWatch(id, 'o', () => {})) && !f2.acquireWatch('xe', 'o', () => {}) && f2.watchedCount === FILES_WATCH_MAX && FILES_WATCH_MAX === 4, 'at most 4 folders watched')
  check(!f2.acquireWatch('nope', 'o', () => {}), 'no root, no watch')

  fs.rmSync(tmp, { recursive: true, force: true })

  // The editor's find widget (v2.3): keys, counter, capped count, and its es/en strings.
  const find = load('src/renderer/components/ui/findLogic.ts')
  const k = (key, mods = {}, code) => ({ key, code, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods })
  check(find.findKeyAction(k('Enter'), 'find') === 'next' && find.findKeyAction(k('Enter', { shiftKey: true }), 'find') === 'prev', 'Enter / Shift+Enter in the query: next / previous')
  check(find.findKeyAction(k('F3'), 'other') === 'next' && find.findKeyAction(k('F3', { shiftKey: true }), 'replace') === 'prev', 'F3 / Shift+F3 anywhere in the widget')
  check(find.findKeyAction(k('Escape'), 'find') === 'close' && find.findKeyAction(k('Escape'), 'other') === 'close' && find.findKeyAction(k('Escape', { ctrlKey: true }), 'find') === null, 'Esc closes (plain Esc only)')
  check(find.findKeyAction(k('c', { altKey: true }, 'KeyC'), 'find') === 'toggleCase' && find.findKeyAction(k('w', { altKey: true }, 'KeyW'), 'replace') === 'toggleWord' && find.findKeyAction(k('®', { altKey: true }, 'KeyR'), 'find') === 'toggleRegex', 'Alt+C / Alt+W / Alt+R toggle the options (by code when Alt composes)')
  check(find.findKeyAction(k('c', { altKey: true, ctrlKey: true }, 'KeyC'), 'find') === null && find.findKeyAction(k('c'), 'find') === null, 'Ctrl+Alt+C and a plain c are not toggles')
  check(find.findKeyAction(k('h', { ctrlKey: true }, 'KeyH'), 'find') === 'openReplace' && find.findKeyAction(k('h', { ctrlKey: true }, 'KeyH'), 'replace') === 'openReplace' && find.findKeyAction(k('f', { ctrlKey: true }, 'KeyF'), 'replace') === 'focusFind', 'Ctrl+H opens replace (also from its field), Ctrl+F goes back to the query')
  check(find.findKeyAction(k('Enter'), 'replace') === 'replace' && find.findKeyAction(k('Enter', { ctrlKey: true, altKey: true }), 'replace') === 'replaceAll' && find.findKeyAction(k('Enter', { ctrlKey: true, altKey: true }), 'find') === 'replaceAll', 'Enter in replace: one; Ctrl+Alt+Enter: all')
  check(find.findKeyAction(k('Enter'), 'other') === null && find.findKeyAction(k('Enter', { ctrlKey: true }), 'find') === null && find.findKeyAction(k('a'), 'find') === null, 'Enter on a button stays the button, other keys are not the widget')
  const tr = (key, vars) => key + (vars ? ':' + vars.index + '/' + vars.total : '')
  check(find.resultLabel('', null, false, tr) === '' && find.resultLabel('x', null, false, tr) === 'find.none' && find.resultLabel('x', { index: -1, total: 0, capped: false }, false, tr) === 'find.none', 'nothing to find: no label; no matches: No results')
  check(find.resultLabel('x', { index: 2, total: 12, capped: false }, false, tr) === 'find.count:3/12' && find.resultLabel('x', { index: 0, total: 1, capped: false }, false, tr) === 'find.count:1/1', '3 of 12, 1 of 1 (1-based)')
  check(find.resultLabel('x', { index: -1, total: 4, capped: false }, false, tr) === 'find.count:?/4' && find.resultLabel('x', { index: 0, total: 9999, capped: true }, false, tr) === 'find.countCapped:1/9999', 'off a match: ? of 4; over the cap: 9999+')
  check(find.resultLabel('(', { index: 0, total: 3, capped: false }, true, tr) === 'find.invalidRegex', 'an invalid regex says so')
  const cursor = (n) => { let i = 0; return { next: () => (i < n ? { done: false, value: { from: i * 10, to: i++ * 10 + 3 } } : { done: true, value: undefined }) } }
  let cm = find.countMatches(cursor(12), { from: 20, to: 23 })
  check(cm.index === 2 && cm.total === 12 && !cm.capped, 'the selection on the third of 12 matches')
  cm = find.countMatches(cursor(12), { from: 20, to: 22 })
  check(cm.index === -1 && cm.total === 12, 'a selection that is not a whole match: no current index')
  cm = find.countMatches(cursor(20000), { from: 0, to: 3 })
  check(cm.total === find.FIND_COUNT_CAP && cm.capped && cm.index === 0 && find.FIND_COUNT_CAP === 9999, 'counting stops at 9999 and says capped')
  cm = find.countMatches(cursor(9999), { from: 99980, to: 99983 })
  check(cm.total === 9999 && !cm.capped && cm.index === 9998, 'exactly 9999 matches is not capped')
  const { en } = load('src/renderer/i18n/en.ts')
  const { es } = load('src/renderer/i18n/es.ts')
  const findKeys = Object.keys(en).filter((key) => key.startsWith('find.'))
  check(findKeys.length >= 14 && findKeys.every((key) => typeof es[key] === 'string' && es[key].trim() && en[key].trim()), 'every find.* string exists in es and en ' + findKeys.length)
  check(Object.keys(es).filter((key) => key.startsWith('find.')).length === findKeys.length, 'es has no extra find.* key')
  for (const key of ['find.count', 'find.countCapped']) check(en[key].includes('{index}') && en[key].includes('{total}') && es[key].includes('{index}') && es[key].includes('{total}'), key + ' carries {index} and {total} in both')
  check(['drawer.pin', 'drawer.unpin', 'files.collapse'].every((key) => es[key] && en[key]) && en['files.collapse'] === 'Collapse folders' && es['files.collapse'] === 'Contraer carpetas', 'drawer pin and collapse strings in es and en')

  console.log(`PASS: ${checks} files drawer checks (safe relative paths, root from the config, list order and .git, junction escape, CRLF and BOM, binary, 2 MB and 5 MB, images, rev conflicts, create, rename, trash, reveal, inert open, watch, .git in any case and through links, share guest reads and secrets, shared watches, find widget keys / counter / cap / es-en strings)`)
}

main().catch((e) => { console.error(e); process.exit(1) })
