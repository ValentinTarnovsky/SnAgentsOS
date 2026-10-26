// Terminal links (app 2.7.0, A2): the pure link finder of src/shared/termLinks.ts,
// moved from the phone (src/mobile/src/lib/links.ts re-exports it, so the tap
// behaves as before). URLs and their trailing punctuation, Orca's path regexes
// (Windows drives, backslashes, spaced and quoted paths), :line:col suffixes and
// the exact span of each link next to punctuation.
// Same esbuild + vm harness as test-status.cjs: no Electron, no user data.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
// Values built inside the vm have another realm's prototypes; compare as JSON.
function same(actual, expected, label) { assert.deepEqual(JSON.parse(JSON.stringify(actual ?? null)), expected, label); checks++ }

// One bundle for both, so the phone's re-exports and the shared module are the same instances.
const code = buildSync({
  stdin: { resolveDir: root, loader: 'ts', contents: `
export * as T from './src/shared/termLinks'
export * as phone from './src/mobile/src/lib/links'
` },
  bundle: true, platform: 'node', format: 'cjs', write: false,
  alias: { '@shared': path.join(root, 'src/shared') },
}).outputFiles[0].text
const mod = { exports: {} }
vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, URL })
const { T, phone } = mod.exports

/** The link under `needle` (plus `offset`) in `text`. */
const at = (text, needle, offset = 1) => T.linkAt(text, text.indexOf(needle) + offset)
/** A path link as linkAt returns it. */
const pathLink = (raw, p, line = null, column = null) => ({ kind: 'path', raw, path: p, line, column })
/** The text a tap on `needle` covers: every index around it that yields the same link. */
function covered(text, needle) {
  const i = text.indexOf(needle)
  const key = JSON.stringify(T.linkAt(text, i))
  if (key === 'null') return null
  let s = i, e = i + 1
  while (s > 0 && JSON.stringify(T.linkAt(text, s - 1)) === key) s--
  while (e < text.length && JSON.stringify(T.linkAt(text, e)) === key) e++
  return text.slice(s, e)
}

function main() {
  // The module: one implementation shared by the phone, pure text in and out.
  const src = fs.readFileSync(path.join(root, 'src/shared/termLinks.ts'), 'utf8')
  check(!/^\s*import\s/m.test(src) && !/\bfrom\s*['"]/.test(src) && !/\b(?:require|import)\(/.test(src), 'src/shared/termLinks.ts imports and re-exports nothing (no Node, DOM or xterm)')
  // A regex, not the literal phrase: test-docs requires the header on line 1 of any file that spells it out.
  check(/^\/\/ Adaptado de stablyai\/orca \(MIT\) - mobile\/src\/terminal\/document\/path-tap\.ts /.test(src.split('\n')[0]), 'the Orca attribution moved with the regexes, on line 1')
  check(phone.linkAt === T.linkAt && phone.pathAt === T.pathAt && phone.urlRanges === T.urlRanges && phone.parsePathLineCol === T.parsePathLineCol, 'the phone re-exports the shared functions under the same names')

  // Moved from test-mobile-text.cjs (E2-FR-28/29), now against the shared module.
  let l = at('  Local:   http://localhost:5173/ ready', 'http')
  same(l, { kind: 'url', url: 'http://localhost:5173/' }, 'an http URL under the tap')
  same(at('see (https://en.wikipedia.org/wiki/Foo_(bar)).', 'https'), { kind: 'url', url: 'https://en.wikipedia.org/wiki/Foo_(bar)' }, 'trailing punctuation trimmed, a balanced paren kept')
  same(at('docs: https://example.com/a?b=1, more', 'https'), { kind: 'url', url: 'https://example.com/a?b=1' }, 'a trailing comma is not part of the URL')
  same(at('error in src/App.tsx:12:5 here', 'App'), pathLink('src/App.tsx:12:5', 'src/App.tsx', 12, 5), 'a relative path with :line:col')
  same(at('  modified:   README.md', 'README'), pathLink('README.md', 'README.md'), 'a bare file name with an extension')
  same(at('Wrote C:\\Users\\me\\proj\\notes.md.', 'notes'), pathLink('C:\\Users\\me\\proj\\notes.md', 'C:\\Users\\me\\proj\\notes.md'), 'a Windows absolute path, trailing period trimmed')
  same(at('open ~/Documents/My Project/plan.md now', 'plan'), pathLink('~/Documents/My Project/plan.md', '~/Documents/My Project/plan.md'), 'a spaced path ends at its extension, prose after it excluded')
  check(at('version 1.5 is out', '1.5') === null, 'a bare number is not a path')
  check(at('just some words', 'some') === null, 'plain prose is no link')
  check(at('https://x.com/a/b.md', 'b.md').kind === 'url', 'a path-looking tail inside a URL stays the URL')

  // parsePathLineCol: the suffix, never a drive colon, no directories, no zero.
  same(T.parsePathLineCol('src/App.tsx:12:3'), { path: 'src/App.tsx', line: 12, column: 3 }, 'path:line:col')
  same(T.parsePathLineCol('src/App.tsx:12'), { path: 'src/App.tsx', line: 12, column: null }, 'path:line without a column')
  same(T.parsePathLineCol('README.md'), { path: 'README.md', line: null, column: null }, 'a plain name has no position')
  same(T.parsePathLineCol('C:\\x\\y.ts'), { path: 'C:\\x\\y.ts', line: null, column: null }, 'the drive colon is not a line suffix')
  same(T.parsePathLineCol('C:\\x\\y.ts:5'), { path: 'C:\\x\\y.ts', line: 5, column: null }, 'a drive path with :line')
  same(T.parsePathLineCol('f.ts:12:3:4'), { path: 'f.ts:12', line: 3, column: 4 }, 'only the last two numeric suffixes are the position')
  check(T.parsePathLineCol('a/') === null && T.parsePathLineCol('a\\') === null && T.parsePathLineCol('') === null, 'a directory-looking or empty value is no path')
  check(T.parsePathLineCol('x.ts:0') === null && T.parsePathLineCol('x.ts:1:0') === null, 'a zero line or column is rejected')
  same(T.parsePathLineCol('f.ts(1,2)'), { path: 'f.ts(1,2)', line: null, column: null }, 'a (line,col) suffix is not a position: it stays in the path')

  // Windows drive paths and backslashes.
  same(at('C:/Users/me/x.ts:7', 'x.ts'), pathLink('C:/Users/me/x.ts:7', 'C:/Users/me/x.ts', 7), 'a drive path with forward slashes and :line')
  same(at('at foo (C:\\repo\\src\\index.ts:10:3)', 'index'), pathLink('C:\\repo\\src\\index.ts:10:3', 'C:\\repo\\src\\index.ts', 10, 3), 'a drive path in a stack frame, parens trimmed')
  check(covered('at foo (C:\\repo\\src\\index.ts:10:3)', 'index') === 'C:\\repo\\src\\index.ts:10:3', 'the stack frame link covers the path and its suffix, not the parens')
  same(at('D:\\work\\a b\\c.txt:3:4 failed', 'c.txt'), pathLink('D:\\work\\a b\\c.txt:3:4', 'D:\\work\\a b\\c.txt', 3, 4), 'a spaced drive path with :line:col')
  check(covered('D:\\work\\a b\\c.txt:3:4 failed', 'work') === 'D:\\work\\a b\\c.txt:3:4', 'the spaced drive path ends at its suffix, the word after it is not the link')
  check(covered('Wrote C:\\Users\\me\\proj\\notes.md.', 'Users') === 'C:\\Users\\me\\proj\\notes.md', 'the trailing period is outside the tap area')
  same(at('src\\main\\index.ts:120', 'index'), pathLink('src\\main\\index.ts:120', 'src\\main\\index.ts', 120), 'a relative backslash path with :line')
  same(at('C:\\repo/src\\a.ts', 'src'), pathLink('C:\\repo/src\\a.ts', 'C:\\repo/src\\a.ts'), 'mixed separators stay one path')
  same(at('\\\\server\\share\\file.txt', 'file'), pathLink('\\\\server\\share\\file.txt', '\\\\server\\share\\file.txt'), 'a UNC path')

  // file:line and file:line:col.
  const two = 'package.json:3:1 and tsconfig.json:9'
  same(at(two, 'package'), pathLink('package.json:3:1', 'package.json', 3, 1), 'a bare name with :line:col')
  same(at(two, 'tsconfig'), pathLink('tsconfig.json:9', 'tsconfig.json', 9), 'a second link on the same line with :line')
  check(covered(two, 'package') === 'package.json:3:1' && covered(two, 'tsconfig') === 'tsconfig.json:9' && at(two, ' and ', 2) === null, 'each link covers exactly its text, the prose between them is no link')
  same(at('at foo (/home/me/repo/src/index.ts:10:3)', 'index'), pathLink('/home/me/repo/src/index.ts:10:3', '/home/me/repo/src/index.ts', 10, 3), 'a POSIX absolute path in a stack frame')
  check(at('error: path/to/file.rs:0:1 bad', 'file') === null, 'a zero line makes no link')
  const line = 'error in src/App.tsx:12:5 here'
  check(T.linkAt(line, 8) === null && T.linkAt(line, 9) !== null && T.linkAt(line, 24) !== null && T.linkAt(line, 25) === null, 'the link starts at its first character and ends after its last')

  // (line,col) and (line): compiler formats are not parsed into a position today.
  same(at('src/App.tsx(12,5): error TS2322: Type', 'App'), pathLink('src/App.tsx(12', 'src/App.tsx(12'), 'tsc (line,col): the link keeps "(12" and has no line (main finds no such file)')
  same(at('src/Program.cs(42): warning CS0168', 'Program'), pathLink('src/Program.cs(42', 'src/Program.cs(42'), '(line) after a relative path: the link keeps "(42" and has no line')
  same(at('C:\\repo\\App.cs(10,7): error CS1002', 'App'), pathLink('C:\\repo\\App.cs(10', 'C:\\repo\\App.cs(10'), '(line,col) after a drive path: no line either')
  check(at('Program.cs(42): warning CS0168', 'Program') === null, 'a bare name with (line) has no separator nor a clean extension: no link')

  // URLs: trailing punctuation and parentheses.
  same(at('http://example.com/path).', 'http'), { kind: 'url', url: 'http://example.com/path' }, 'an unbalanced closing paren and a period are trimmed')
  same(at('https://example.com/a_(b)_c?x=(1) end', 'https'), { kind: 'url', url: 'https://example.com/a_(b)_c?x=(1)' }, 'balanced parens inside and at the end are kept')
  same(at('Visit https://example.com!', 'https'), { kind: 'url', url: 'https://example.com' }, 'a trailing ! is trimmed')
  same(at('Is it https://example.com/q?', 'https'), { kind: 'url', url: 'https://example.com/q' }, 'a trailing ? is trimmed')
  same(at('url: "https://example.com/quoted"', 'https'), { kind: 'url', url: 'https://example.com/quoted' }, 'quotes around a URL are not part of it')
  same(at('<https://example.com/x>', 'https'), { kind: 'url', url: 'https://example.com/x' }, 'angle brackets around a URL are not part of it')
  same(T.urlRanges('a https://a.com/x b http://b.org/y.'), [{ text: 'https://a.com/x', start: 2, end: 17 }, { text: 'http://b.org/y', start: 20, end: 34 }], 'urlRanges: every URL of a line with its span, the trailing period trimmed')
  same(T.urlRanges('docs: https://example.com/a?b=1, more'), [{ text: 'https://example.com/a?b=1', start: 6, end: 31 }], 'urlRanges: the span ends before the comma')
  same(T.urlRanges('see https:// now'), [], 'a scheme without a host is no URL')
  same(T.urlRanges('ftp://example.com/x and file:///C:/x/y.md'), [], 'only http and https are URLs')

  // Quoted paths with spaces.
  same(at('"C:\\Program Files\\App\\config.json"', 'App'), pathLink('C:\\Program Files\\App\\config.json', 'C:\\Program Files\\App\\config.json'), 'a double-quoted drive path with a space, quotes trimmed')
  same(at("'/Users/me/My Docs/report final.pdf'", 'report'), pathLink('/Users/me/My Docs/report final.pdf', '/Users/me/My Docs/report final.pdf'), 'a single-quoted POSIX path with spaces in folder and file')
  check(covered('open "./My Folder/notes.md" now', 'notes') === './My Folder/notes.md', 'a quoted relative spaced path covers exactly the path')

  // Paths next to punctuation.
  const prose = 'see ./scripts/test-docs.cjs, then ../shared/x.ts; done.'
  same(at(prose, 'scripts'), pathLink('./scripts/test-docs.cjs', './scripts/test-docs.cjs'), 'a ./ path before a comma')
  same(at(prose, 'shared'), pathLink('../shared/x.ts', '../shared/x.ts'), 'a ../ path before a semicolon')
  check(covered(prose, 'scripts') === './scripts/test-docs.cjs' && covered(prose, 'shared') === '../shared/x.ts', 'the comma and the semicolon are outside the tap area')
  const brackets = '[src/a.ts] {lib/b.ts} (c/d.md)'
  check(covered(brackets, 'src') === 'src/a.ts' && covered(brackets, 'lib') === 'lib/b.ts' && covered(brackets, 'c/d') === 'c/d.md', 'brackets, braces and parens around a path are trimmed')
  check(covered('Error: src/a.ts!', 'src') === 'src/a.ts' && covered('is it src/a.ts?', 'src') === 'src/a.ts', 'a trailing ! or ? is outside the path')
  check(covered('src/a.ts: error', 'src') === 'src/a.ts', 'a colon without digits after a path is punctuation')
  check(covered('use `src/a.ts` here', 'src') === 'src/a.ts' && covered('see <src/a.ts>', 'src') === 'src/a.ts', 'backticks and angle brackets around a path are trimmed')
  check(covered('node_modules/.bin/tsc --noEmit', 'tsc') === 'node_modules/.bin/tsc', 'a path followed by a flag ends at the space')
  same(at('~/x/y.z', 'y'), pathLink('~/x/y.z', '~/x/y.z'), 'a home-relative path')
  same(at('cp .env.example .env', '.env', 0), pathLink('.env.example', '.env.example'), 'a dotfile counts as a name with an extension')

  // pathAt proposes, linkAt filters; repeated calls do not leak regex state.
  same(T.pathAt('version 1.5 is out', 9), pathLink('1.5', '1.5'), 'pathAt proposes 1.5 (the regex sees an extension)')
  check(T.linkAt('version 1.5 is out', 9) === null, 'linkAt drops a token without a separator or a letter extension')
  check(T.pathAt(line, 0) === null, 'pathAt is null away from any path')
  const first = JSON.stringify(T.linkAt(prose, prose.indexOf('shared')))
  T.urlRanges('https://a.b/c https://d.e/f'); T.pathAt('x/y.ts z/w.ts', 9); T.linkAt(two, 0)
  check(JSON.stringify(T.linkAt(prose, prose.indexOf('shared'))) === first, 'the same call gives the same answer after other lines (global regexes are reset)')

  console.log(`PASS: ${checks} term links checks (shared module, moved phone cases, drives, backslashes, line:col, compiler forms, URLs, quoted paths, punctuation)`)
}

try {
  main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
