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

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`PASS: ${checks} files drawer checks (safe relative paths, root from the config, list order and .git, junction escape, CRLF and BOM, binary, 2 MB and 5 MB, images, rev conflicts, create, rename, trash, reveal, inert open, watch)`)
}

main().catch((e) => { console.error(e); process.exit(1) })
