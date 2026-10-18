// Pure logic of E7 (git, drops). In this release it covers dropping files on a
// pane: dropPaths modes, the in-app path payload, drop feedback and the paste
// registry. Bundled with esbuild and run in a vm, like test-status.cjs.
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

console.log(`PASS: ${checks} git/drop checks (dropPaths agent/safe/plain, raw/quoted, control bytes, internal payload, overlay counter, paste registry)`)
