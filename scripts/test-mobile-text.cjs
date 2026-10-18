// Pure logic of the phone's usable text (E2-FR-26..34), run in node:vm: the
// link finder (URLs, Orca's path regexes, localhost, the open/reveal label),
// word bounds and selection lengths, the pill placement, the momentum math,
// the scroll thumb geometry and the text size presets of the fit solver.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }

const code = buildSync({
  stdin: {
    resolveDir: root, loader: 'tsx', contents: `
export * as links from './src/mobile/src/lib/links'
export * as sel from './src/mobile/src/lib/selection'
export * as touch from './src/mobile/src/lib/touchScroll'
export * as fit from './src/mobile/src/lib/fit'
export { thumbGeometry, SCROLL_THUMB_MIN_PX } from './src/mobile/src/components/ScrollThumb'
export * as inert from './src/shared/inertOpen'
` },
  bundle: true, platform: 'node', format: 'cjs', write: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  alias: { '@shared': path.join(root, 'src/shared') },
}).outputFiles[0].text

const store = new Map()
const mod = { exports: {} }
vm.runInNewContext(code, {
  module: mod, exports: mod.exports, require, console, URL,
  localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
})
const { links, sel, touch, fit, thumbGeometry, SCROLL_THUMB_MIN_PX, inert } = mod.exports

// --- links (E2-FR-28/29) ---
{
  const at = (text, needle, offset = 1) => links.linkAt(text, text.indexOf(needle) + offset)
  let l = at('  Local:   http://localhost:5173/ ready', 'http')
  check(l && l.kind === 'url' && l.url === 'http://localhost:5173/', 'an http URL under the tap')
  check(links.isLocalUrl(l.url) && links.isLocalUrl('http://127.0.0.1:3000') && links.isLocalUrl('http://0.0.0.0') && links.isLocalUrl('http://[::1]:8080/') && !links.isLocalUrl('https://example.com'), 'localhost, 127.0.0.1, 0.0.0.0 and ::1 count as local')
  l = at('see (https://en.wikipedia.org/wiki/Foo_(bar)).', 'https')
  check(l.url === 'https://en.wikipedia.org/wiki/Foo_(bar)', 'trailing punctuation trimmed, a balanced paren kept')
  l = at('docs: https://example.com/a?b=1, more', 'https')
  check(l.url === 'https://example.com/a?b=1', 'a trailing comma is not part of the URL')
  l = at('error in src/App.tsx:12:5 here', 'App')
  check(l && l.kind === 'path' && l.path === 'src/App.tsx' && l.line === 12 && l.column === 5 && l.raw === 'src/App.tsx:12:5', 'a relative path with :line:col')
  l = at('  modified:   README.md', 'README')
  check(l && l.kind === 'path' && l.path === 'README.md', 'a bare file name with an extension')
  l = at('Wrote C:\\Users\\me\\proj\\notes.md.', 'notes')
  check(l && l.path === 'C:\\Users\\me\\proj\\notes.md', 'a Windows absolute path, trailing period trimmed')
  l = at('open ~/Documents/My Project/plan.md now', 'plan')
  check(l && l.path === '~/Documents/My Project/plan.md', 'a spaced path ends at its extension, prose after it excluded')
  check(at('version 1.5 is out', '1.5') === null, 'a bare number is not a path')
  check(at('just some words', 'some') === null, 'plain prose is no link')
  check(at('https://x.com/a/b.md', 'b.md') .kind === 'url', 'a path-looking tail inside a URL stays the URL')
  check(links.pcActionFor('notes.md') === 'open' && links.pcActionFor('src/App.tsx:12') === 'reveal' && links.pcActionFor('run.js') === 'reveal' && links.pcActionFor('page.HTML') === 'reveal' && links.pcActionFor('a.PDF') === 'open', 'open only for the inert allowlist (case-insensitive), reveal the rest')
  check(links.INERT_OPEN_EXTENSIONS === inert.INERT_OPEN_EXTENSIONS && !inert.INERT_OPEN_EXTENSIONS.some(e => ['.js', '.mjs', '.cjs', '.vbs', '.ps1', '.py', '.html', '.htm', '.svg'].includes(e)), 'the phone and main share one allowlist without script formats')
  check(inert.stripLineCol('a/b.ts:3:9') === 'a/b.ts' && inert.stripLineCol('C:\\x\\y.md') === 'C:\\x\\y.md', 'stripLineCol keeps drive letters')
  // Logical lines across xterm wraps, with a fake buffer of 10 columns.
  const rows = ['see https:', '//example.', 'com/x ok  ']
  const fakeCell = () => { let ch = ''; return { getWidth: () => 1, getChars: () => ch, set: c => { ch = c } } }
  const term = { cols: 10, buffer: { active: {
    length: rows.length,
    getNullCell: fakeCell,
    getLine: r => r < rows.length ? { isWrapped: r > 0, getCell: (c, cell) => { if (c >= 10) return undefined; cell.set(rows[r][c] === ' ' ? '' : rows[r][c]); return cell } } : undefined,
  } } }
  const wrapped = links.linkAtCell(term, 3, 1)
  check(wrapped && wrapped.kind === 'url' && wrapped.url === 'https://example.com/x', 'a URL that wraps over three rows is one link from any of its cells')
  check(links.linkAtCell(term, 8, 2) === null, 'the word after the URL is no link')
}

// --- selection math (E2-FR-26/27) ---
{
  const cells = 'git  status --short'.split('')
  check(JSON.stringify(sel.wordBounds(cells, 6)) === '{"start":5,"end":10}', 'the word under the finger')
  check(JSON.stringify(sel.wordBounds(cells, 3)) === '{"start":3,"end":3}', 'a blank cell selects just itself')
  const wide = ['a', '\u4e2d', '', 'b', ' ', 'c']
  check(JSON.stringify(sel.wordBounds(wide, 2)) === '{"start":0,"end":3}', 'the spacer half of a wide char belongs to the word')
  check(sel.selectionLength(80, { col: 5, row: 2 }, { col: 9, row: 2 }) === 5 && sel.selectionLength(80, { col: 70, row: 2 }, { col: 4, row: 3 }) === 15, 'term.select length for one and two rows')
  const [a, b] = sel.orderCells({ col: 4, row: 9 }, { col: 7, row: 3 })
  check(a.row === 3 && b.row === 9, 'a handle dragged past the other end swaps the order')
  const g = { left: 0, top: 100, width: 400, height: 240, cols: 40, rows: 12, viewportY: 50, lastRow: 61 }
  const c = sel.pointToCell(g, 105, 145)
  check(c.col === 10 && c.row === 52, 'a point maps to the absolute buffer cell')
  check(sel.cellToPoint(g, { col: 10, row: 49 }) === null && sel.cellToPoint(g, { col: 10, row: 52 }).y === 140, 'a row scrolled out has no point; a visible one maps back')
  check(sel.edgeScrollDir(120, 100, 340) === -1 && sel.edgeScrollDir(320, 100, 340) === 1 && sel.edgeScrollDir(200, 100, 340) === 0, 'auto-scroll within 40 px of the edges')
  let p = sel.pillPosition({ selTop: 100, selBottom: 120, anchorX: 200, pillW: 180, pillH: 40, boxW: 360, boxH: 500 })
  check(p.placement === 'above' && p.top === 52 && p.left === 110, 'the pill sits 8 px above the selection, centred')
  p = sel.pillPosition({ selTop: 20, selBottom: 40, anchorX: 10, pillW: 180, pillH: 40, boxW: 360, boxH: 500 })
  check(p.placement === 'below' && p.top === 48 && p.left === 8, 'without room above it goes below, 8 px from the left edge')
  p = sel.pillPosition({ selTop: 0, selBottom: 500, anchorX: 355, pillW: 180, pillH: 40, boxW: 360, boxH: 500 })
  check(p.top === 452 && p.left === 172, 'a full-screen selection keeps the pill inside, 8 px from the edges')
  check(sel.LONG_PRESS_MS === 500 && sel.LONG_PRESS_SLOP === 10 && sel.TAP_SLOP === 24 && sel.TAP_MAX_MS === 300 && sel.EDGE_SCROLL_PX === 40 && sel.EDGE_SCROLL_MS === 60 && sel.HANDLE_HIT_PX === 44, 'the gesture constants of the PRD')
}

// --- momentum (E2-FR-31) ---
{
  check(Math.abs(touch.blendVelocity(1, 2) - (0.55 + 0.9)) < 1e-9, 'v = v*0.55 + inst*0.45')
  check(Math.abs(touch.decayVelocity(1, 16) - 0.972) < 1e-9 && Math.abs(touch.decayVelocity(1, 32) - 0.972 ** 2) < 1e-9, 'friction 0.972 per 16 ms, frame-rate independent')
  const d = touch.momentumDistance(2)
  check(d > 500 && d < 2000, 'a 2 px/ms release coasts a bounded distance (' + Math.round(d) + ' px)')
  check(touch.momentumDistance(0.01) === 0, 'under 0.012 px/ms there is no momentum')
  check(touch.MAX_WHEEL_PER_FRAME === 8, 'mouse mode sends at most 8 wheel reports per frame')
}

// --- scroll thumb (E2-FR-33) ---
{
  let t = thumbGeometry(0, 0, 24, 480)
  check(t.height === 480 && t.top === 0, 'without scrollback the thumb fills the track')
  t = thumbGeometry(976, 976, 24, 480)
  check(t.height === SCROLL_THUMB_MIN_PX && t.top === 480 - SCROLL_THUMB_MIN_PX, 'a long buffer clamps to 24 px and sits at the bottom when at the end')
  t = thumbGeometry(0, 24, 24, 480)
  check(t.height === 240 && t.top === 0, 'height is rows/(baseY+rows) of the track')
}

// --- text size presets (E2-FR-34) ---
{
  check(JSON.stringify(fit.FONT_SCALE_PRESETS) === '[0.5,0.75,1,1.25,1.5,2]', 'the six presets')
  check(fit.snapFontScale(1.4) === 1.5 && fit.snapFontScale(0.1) === 0.5 && fit.snapFontScale(9) === 2 && fit.snapFontScale(1.1) === 1 && fit.snapFontScale(NaN) === 1, 'a pinch snaps to the nearest preset')
  check(fit.loadFontScale() === 1, 'no saved scale means 100%')
  fit.saveFontScale(1.5)
  check(store.get('snagentsos.fontScale') === '1.5' && fit.loadFontScale() === 1.5, "the scale persists under 'snagentsos.fontScale'")
  store.set('snagentsos.fontScale', '3')
  check(fit.loadFontScale() === 1, 'a saved value that is not a preset falls back to 100%')
  // 0.6 advance ratio (no canvas in node): 40 cols over 480 px fit at 20 px.
  const one = fit.solveFont(40, 480, 1), big = fit.solveFont(40, 480, 2), small = fit.solveFont(200, 480, 0.5)
  check(one.fontSize === 20 && !one.overflow, 'scale 1 is the plain fit')
  check(big.fontSize === 32 && big.overflow, 'scale 2 clamps to 32 px and pans')
  check(small.fontSize === 6 && small.overflow, 'a tiny scale clamps to 6 px')
  check(fit.solveFont(80, 480, 1.25).fontSize === 13, 'the scale multiplies the fitted size and rounds')
}

console.log(`PASS: ${checks} mobile text checks (links, selection, momentum, thumb, text size)`)
