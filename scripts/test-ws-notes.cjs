// Workspace notes (v2.2, E9): WsNoteStore on a temp folder (list, read,
// write with rev conflicts, create, delete to the trash, prune and the 30-day
// purge, id validation, BOM and size limits), the shared helpers, the phone's
// notesReq schema and what a note looks like on its way to the phone. Same
// esbuild + vm harness as test-status.cjs: no Electron, no user data.
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
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, URL, setTimeout, clearTimeout, ...overrides })
  return mod.exports
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-wsnotes-'))
  const notesRoot = path.join(tmp, 'notes')
  const shared = load('src/shared/ws-notes.ts')

  // --- shared helpers ---
  check(shared.noteTitle('# Plan del login\nresto') === 'Plan del login', 'the title is the first heading')
  check(shared.noteTitle('\n\n  - **tarea** uno\n') === '- tarea uno', 'else the first non-empty line, without markdown marks')
  check(shared.noteTitle('') === '' && shared.noteTitle('\n \n') === '', 'an empty note has no title')
  check(shared.noteTitle('# ' + 'x'.repeat(200)).length === 80, 'titles are clipped to 80')
  check(shared.isNoteId('ws-1a2b3c4d') && !shared.isNoteId('../x') && !shared.isNoteId('a/b') && !shared.isNoteId('') && !shared.isNoteId('x'.repeat(65)) && !shared.isNoteId(5), 'ids are plain ASCII names')

  // --- the store ---
  let clock = 1_700_000_000_000, id = 0
  const events = []
  const { WsNoteStore, WS_NOTE_TRASH_MS } = load('src/main/notes/WsNoteStore.ts')
  const store = new WsNoteStore({ root: () => notesRoot, emit: (e) => events.push(e), now: () => clock, newId: () => `n-${++id}` })
  check((await store.list('w1')).ok && (await store.list('w1')).notes.length === 0, 'a workspace without notes lists none')
  check(!(await store.list('../w1')).ok, 'a bad workspace id lists nothing')
  let res = await store.create({ workspaceId: 'w1', text: '# Primera\nhola' })
  check(res.ok && res.note.id === 'n-1' && res.note.title === 'Primera' && events.at(-1).workspaceId === 'w1' && events.at(-1).noteId === 'n-1', 'create writes the .md and tells who listens')
  const file = path.join(notesRoot, 'w1', 'n-1.md')
  check(fs.existsSync(file) && fs.readFileSync(file, 'utf8') === '# Primera\nhola', 'a real .md file under <root>/<workspace>/<note>.md, as typed')
  check(fs.readFileSync(file)[0] !== 0xef, 'written without BOM')
  res = await store.read({ workspaceId: 'w1', noteId: 'n-1' })
  check(res.ok && res.note.text === '# Primera\nhola' && res.note.path === file && res.note.rev, 'read returns the text, its path and its rev')
  const rev1 = res.note.rev
  await new Promise((r) => setTimeout(r, 20))
  res = await store.write({ workspaceId: 'w1', noteId: 'n-1', text: '# Primera\nchau', baseRev: rev1 })
  check(res.ok && res.note.rev !== rev1, 'a write with the loaded rev goes through and changes the rev')
  const rev2 = res.note.rev
  res = await store.write({ workspaceId: 'w1', noteId: 'n-1', text: 'pisada', baseRev: rev1 })
  check(!res.ok && res.error === 'conflict' && res.current.text === '# Primera\nchau' && fs.readFileSync(file, 'utf8') === '# Primera\nchau', 'a write with an old rev is a conflict that carries the note as it is, and writes nothing')
  res = await store.write({ workspaceId: 'w1', noteId: 'n-1', text: 'pisada' })
  check(res.ok && fs.readFileSync(file, 'utf8') === 'pisada', 'without baseRev it overwrites (Keep mine)')
  check(rev2 !== res.note.rev, 'and the rev moves again')
  fs.writeFileSync(file, '\ufeff# Con BOM\n')
  res = await store.read({ workspaceId: 'w1', noteId: 'n-1' })
  check(res.ok && res.note.text === '# Con BOM\n' && res.note.title === 'Con BOM', 'a BOM written by another editor is dropped on read')
  check((await store.write({ workspaceId: 'w1', noteId: 'n-1', text: 'x'.repeat(1024 * 1024 + 1) })).error === 'too_large', 'more than 1 MB is too_large')
  fs.writeFileSync(file, 'y'.repeat(1024 * 1024 + 10))
  check((await store.read({ workspaceId: 'w1', noteId: 'n-1' })).error === 'too_large', 'a note grown past 1 MB elsewhere does not open')
  fs.writeFileSync(file, '# Primera\n')
  for (const bad of [{ workspaceId: 'w1', noteId: '..\\..\\x' }, { workspaceId: '../../etc', noteId: 'n-1' }, { workspaceId: 'w1', noteId: 'n-1/../../x' }, null, 'w1']) {
    check((await store.read(bad)).error === 'invalid', 'invalid request ' + JSON.stringify(bad))
  }
  check((await store.write({ workspaceId: 'w1', noteId: 'n-1', text: 5 })).error === 'invalid' && (await store.write({ workspaceId: 'w1', noteId: 'n-1', text: 'x', baseRev: 1 })).error === 'invalid', 'a write needs text and a string rev')
  check((await store.read({ workspaceId: 'w1', noteId: 'nope' })).error === 'not_found', 'an unknown note is not_found')
  clock += 1000
  await store.create({ workspaceId: 'w1', text: 'segunda sin titulo' })
  await new Promise((r) => setTimeout(r, 20))
  await store.write({ workspaceId: 'w1', noteId: 'n-2', text: 'segunda sin titulo, editada' })
  fs.writeFileSync(path.join(notesRoot, 'w1', 'not a note.md'), 'x')
  fs.writeFileSync(path.join(notesRoot, 'w1', 'readme.txt'), 'x')
  const list = (await store.list('w1')).notes
  check(list.length === 2 && list[0].id === 'n-2' && list[1].id === 'n-1', 'the list is newest first and skips files that are not notes')
  check(list[0].title === 'segunda sin titulo, editada' && typeof list[0].size === 'number', 'the list carries title and size')

  // Delete to the trash.
  res = await store.delete({ workspaceId: 'w1', noteId: 'n-2' })
  const trashed = fs.readdirSync(path.join(notesRoot, '.trash', 'w1'))
  check(res.ok && !fs.existsSync(path.join(notesRoot, 'w1', 'n-2.md')) && trashed.length === 1 && trashed[0] === `n-2-${clock}.md`, 'delete moves the note to <root>/.trash/<workspace>/ with the time in its name')
  check((await store.delete({ workspaceId: 'w1', noteId: 'n-2' })).error === 'not_found', 'deleting it again is not_found')
  check((await store.pathOf({ workspaceId: 'w1', noteId: 'n-1' })) === file && (await store.pathOf({ workspaceId: 'w1', noteId: 'n-2' })) === null, 'pathOf only for an existing note')

  // Prune: the notes of a deleted workspace go to the trash; old trash is purged.
  await store.create({ workspaceId: 'w2', text: 'otra' })
  await store.prune(['w1'])
  check(!fs.existsSync(path.join(notesRoot, 'w2')) && fs.readdirSync(path.join(notesRoot, '.trash')).some((n) => n.startsWith('w2-')), 'prune moves the folder of a workspace that no longer exists to the trash')
  check(fs.existsSync(file), 'and keeps the live ones')
  await store.prune('nope'); await store.prune([1])
  check(fs.existsSync(file), 'a malformed prune does nothing')
  clock += WS_NOTE_TRASH_MS + 1000
  await store.prune(['w1'])
  check(!fs.readdirSync(path.join(notesRoot, '.trash')).some((n) => n.startsWith('w2-')) && fs.readdirSync(path.join(notesRoot, '.trash', 'w1')).length === 0, 'trash older than 30 days is purged')

  // --- the phone's view ---
  const ph = load('src/main/remote/RemoteManager.ts', { require: (m) => (m === 'electron' ? {} : require(m)) })
  const doc = { id: 'n-1', title: 't', updatedAt: 1, size: 3, rev: '1-3', text: 'abc', path: 'C:\\secret\\n-1.md' }
  let pn = ph.phoneNote(doc)
  check(pn.text === 'abc' && !('path' in pn) && !pn.readOnly, 'a note goes to the phone without its path')
  const big = 'ñ'.repeat(30000)
  pn = ph.phoneNote({ ...doc, text: big })
  check(pn.readOnly === true && Buffer.byteLength(pn.text) <= shared.WS_NOTE_PHONE_MAX && !pn.text.includes('\ufffd') && big.startsWith(pn.text), 'past 40000 UTF-8 bytes it travels cut on a whole character, read-only')

  const { parseRemoteClientMsg } = load('src/shared/remote-protocol-schemas.ts')
  const msg = (o) => parseRemoteClientMsg(JSON.stringify({ v: 1, type: 'notesReq', id: 'r1', workspaceId: 'w1', ...o }))
  check(!!msg({ op: 'list' }) && !!msg({ op: 'read', noteId: 'n-1' }) && !!msg({ op: 'write', noteId: 'n-1', text: 'hola', baseRev: '1-3' }), 'notesReq: list, read and write parse')
  check(!msg({ op: 'read', noteId: '../x' }) && !msg({ op: 'list', workspaceId: '..\\w' }) && !msg({ op: 'nuke' }) && !msg({ op: 'write', noteId: 'n-1', text: 'x'.repeat(40001) }), 'notesReq refuses path-like ids, unknown ops and text over the phone limit')

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`PASS: ${checks} workspace notes checks (titles, ids, store: list, read, write, rev conflicts, BOM, 1 MB, create, delete to trash, prune, 30-day purge; phone note and notesReq schema)`)
}

main().catch((e) => { console.error(e); process.exit(1) })
