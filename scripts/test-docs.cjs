// Project docs checks (R21-00: E4-FR-01, E4-FR-02, MIT notices and the v2.1
// contract amendments; app 2.7.0: E10-FR-05 and E10-FR-06). Plain node, no
// build: check() counts assertions, one PASS line at the end, like the other suites.
//   - docs/STYLEGUIDE.md: 80 to 140 lines, the 12 numbered sections in order,
//     mobile tokens, one primary per screen, and state tokens that match the
//     @theme blocks of the desktop and the mobile CSS.
//   - CLAUDE.md: at most 60 lines with the rules E4-FR-02 lists.
//   - THIRD_PARTY_NOTICES.md: a section with the full MIT text of every adapted
//     project (UPSTREAMS), shipped with the app; an attribution header is well
//     formed and on line 1.
//   - docs/snagentsos/FEATURES.md: the capability map, at most 400 lines, unique
//     ids in strict code point order, every verify cell names suites that exist,
//     linked from the docs README.
//   - CONTRATOS.md and FEATURES.md: every row of every Markdown table has its
//     header's cell count, counted the way GFM does (gfmCells).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { listFiles, isBinary, DASH_RE } = require('./check-brand.cjs')

const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const lineCount = text => text.replace(/\n$/, '').split(/\r?\n/).length
const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

// Projects whose code SnAgentsOS ports or adapts, with the copyright line of their MIT license.
const UPSTREAMS = [
  { name: 'stablyai/orca', copyright: 'Copyright (c) 2026 Lovecast Inc.' },
  { name: 'paperclipai/paperclip', copyright: 'Copyright (c) 2025 Paperclip AI' },
]
// First line of every source file that ports or adapts upstream code (PRD principle 10).
const HEADER_RE = new RegExp(`^(//|#) Adaptado de (${UPSTREAMS.map(u => escapeRe(u.name)).join('|')}) \\(MIT\\) - \\S+`)
const SOURCE_EXT = /\.(c?js|mjs|tsx?|css|nsh)$/
const FEATURES_HEADER = '| id | capacidad | superficies | archivos | verify | desde |'
const FEATURE_ID_RE = /^`[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+`$/

/** True when a source file that carries the attribution starts with the well-formed header. */
function headerOk(text) {
  const lines = text.split(/\r?\n/)
  const first = lines[0].startsWith('#!') ? lines[1] || '' : lines[0]
  return HEADER_RE.test(first)
}

/** `--color-state-<name>: #hex` pairs declared in a CSS file. */
function stateTokens(css) {
  return Object.fromEntries([...css.matchAll(/--color-state-([a-z]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map(m => [m[1], m[2].toLowerCase()]))
}

/** Body of the `## <name>` section of a Markdown text, up to the next `#` or `##` heading ('' when missing). */
function section(text, name) {
  const m = text.match(new RegExp(`^## ${escapeRe(name)}\\r?\\n([\\s\\S]*?)(?=^#{1,2} |(?![\\s\\S]))`, 'm'))
  return m ? m[1] : ''
}

/** Rows of the FEATURES table (the lines that follow its header and separator), split into trimmed cells. */
function featureRows(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.indexOf(FEATURES_HEADER)
  if (start < 0) return []
  const rows = []
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break
    rows.push(line.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(cell => cell.trim()))
  }
  return rows
}

/**
 * Cells of a Markdown table row as GFM counts them: the outer pipes are
 * dropped and every other pipe separates, except an escaped `\|`; a code span
 * does not hide a pipe (GFM splits the row before it reads the inline spans).
 */
function gfmCells(line) {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/)
}

const GFM_DELIMITER_CELL_RE = /^\s*:?-+:?\s*$/
/** A line that starts another block (heading, quote, list item, fence, rule), which ends a GFM table. */
const GFM_BLOCK_START_RE = /^ {0,3}(#{1,6}(\s|$)|>|[-*+]\s|\d{1,9}[.)]\s|`{3,}|~{3,}|([-*_])(\s*\3){2,}\s*$)/
const GFM_FENCE_RE = /^ {0,3}(`{3,}|~{3,})/

/**
 * The GFM tables of a Markdown text, outside code fences: the 1-based line of
 * each header, its cell count, the delimiter row's and every row's, up to the
 * blank line or the block that ends the table (a line with no pipe there is a
 * row too, of one cell, as GFM reads it).
 */
function gfmTables(text) {
  const lines = text.split(/\r?\n/)
  const tables = []
  let fence = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const f = line.match(GFM_FENCE_RE)
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null
      continue
    }
    if (f) {
      fence = f[1]
      continue
    }
    const next = lines[i + 1]
    if (next === undefined || !/(?<!\\)\|/.test(line) || !/(?<!\\)\|/.test(next)) continue
    const delimiter = gfmCells(next)
    if (!delimiter.every(cell => GFM_DELIMITER_CELL_RE.test(cell))) continue
    const rows = []
    let j = i + 2
    for (; j < lines.length && lines[j].trim() !== '' && !GFM_BLOCK_START_RE.test(lines[j]); j++) rows.push({ line: j + 1, cells: gfmCells(lines[j]).length })
    tables.push({ line: i + 1, head: gfmCells(line).length, delimiter: delimiter.length, rows })
    i = j - 1
  }
  return tables
}

/** "file:line" of every table row (and delimiter row) whose cell count is not its header's. */
function tableOffenders(file, text) {
  const out = []
  for (const table of gfmTables(text)) {
    if (table.delimiter !== table.head) out.push(`${file}:${table.line + 1} (delimiter ${table.delimiter}, header ${table.head})`)
    for (const row of table.rows) if (row.cells !== table.head) out.push(`${file}:${row.line} (${row.cells} cells, header ${table.head})`)
  }
  return out
}

/** True when `a` sorts strictly before `b` by code point (`<` compares UTF-16 code units). */
function codePointLess(a, b) {
  const x = [...a]
  const y = [...b]
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0)
    if (d !== 0) return d < 0
  }
  return x.length < y.length
}

function main() {
  // Unit checks of the helpers.
  check(headerOk('// Adaptado de stablyai/orca (MIT) - src/main/agent-awake-service.ts\nexport {}'), 'header on line 1 accepted')
  check(headerOk('#!/usr/bin/env node\n// Adaptado de stablyai/orca (MIT) - bin/x.js\n'), 'header after a shebang accepted')
  check(headerOk('// Adaptado de paperclipai/paperclip (MIT) - packages/adapters/claude-local/src/server/parse.ts\nexport {}'), 'paperclip header on line 1 accepted')
  check(!headerOk('// see stablyai/orca\n'), 'plain mention is not a header')
  check(!headerOk('import x from "y"\n// Adaptado de stablyai/orca (MIT) - a.ts\n'), 'header below line 1 rejected')
  check(!headerOk('// Adaptado de stablyai/orca - a.ts\n'), 'header without the license rejected')
  check(!headerOk('// Adaptado de paperclipai/paperclip - a.ts\n'), 'paperclip header without the license rejected')
  check(!headerOk('// Adaptado de someone/else (MIT) - a.ts\n'), 'header of a project outside UPSTREAMS rejected')
  assert.deepStrictEqual(stateTokens('  --color-state-done: #22C55E;\n --color-accent-blue: #60a5fa;'), { done: '#22c55e' }); checks++
  assert.deepStrictEqual(section('# T\n## a/b\nx\n## c\ny\n', 'a/b'), 'x\n'); checks++
  assert.deepStrictEqual(section('## c\ny', 'c'), 'y'); checks++
  assert.deepStrictEqual(featureRows(`intro\n\n${FEATURES_HEADER}\n|---|---|---|---|---|---|\n| \`a.b\` | x | y | z | v | 2.7.0 |\n\n| no | table |\n`), [['`a.b`', 'x', 'y', 'z', 'v', '2.7.0']]); checks++
  assert.deepStrictEqual(gfmCells('| a | b |'), [' a ', ' b ']); checks++
  check(gfmCells('a | b').length === 2, 'a row without outer pipes has its cells')
  check(gfmCells('| a \\| b | c |').length === 2, 'an escaped pipe is no separator')
  check(gfmCells('| `x | y` | c |').length === 3, 'a pipe inside a code span separates, as in GFM')
  check(gfmCells('| `x \\| y` | c |').length === 2, 'an escaped pipe inside a code span is no separator')
  check(gfmCells('| a | b \\|').length === 2, 'an escaped last pipe stays in its cell')
  assert.deepStrictEqual(gfmTables('| a | b |\n|---|:-:|\n| 1 | 2 |\n| 3 | `4 | 5` |\nloose\n\n| c |\n'), [{ line: 1, head: 2, delimiter: 2, rows: [{ line: 3, cells: 2 }, { line: 4, cells: 3 }, { line: 5, cells: 1 }] }]); checks++
  assert.deepStrictEqual(gfmTables('```\n| a | b |\n|---|---|\n| 1 |\n```\n| a |\n|---|\n| 1 |\n## h\n| x |\n'), [{ line: 6, head: 1, delimiter: 1, rows: [{ line: 8, cells: 1 }] }]); checks++
  assert.deepStrictEqual(tableOffenders('f.md', '| a | b |\n|---|---|---|\n| 1 \\| 2 | 3 |\n| 1 | 2 | 3 |\n'), ['f.md:2 (delimiter 3, header 2)', 'f.md:4 (3 cells, header 2)']); checks++
  check(codePointLess('teams.runSilence', 'teams.runs') && !codePointLess('teams.runs', 'teams.runSilence'), 'an uppercase letter sorts before a lowercase one')
  check(codePointLess('a.b', 'a.bc') && !codePointLess('a.b', 'a.b'), 'a prefix sorts first and equal ids are not in strict order')
  // U+FF61 sorts before U+1F600 by code point, after its surrogate pair by UTF-16 code unit.
  const halfwidthStop = String.fromCodePoint(0xff61)
  const emoji = String.fromCodePoint(0x1f600)
  check(codePointLess(halfwidthStop, emoji) && !(halfwidthStop < emoji), 'code points, not UTF-16 code units')

  // E4-FR-01: STYLEGUIDE.
  const guide = read('docs/STYLEGUIDE.md')
  const guideLines = lineCount(guide)
  check(guideLines >= 80 && guideLines <= 140, `STYLEGUIDE has 80 to 140 lines (${guideLines})`)
  const sections = [...guide.matchAll(/^## (\d+)\. (.+)$/gm)].map(m => Number(m[1]))
  assert.deepStrictEqual(sections, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 'STYLEGUIDE has the 12 sections in order'); checks++
  for (const needle of ['0 a 100 ms', 'Hasta 1 s', '1 a 3 s', 'Mas de 3 s']) check(guide.includes(needle), `duration table row "${needle}"`)
  for (const needle of ['Toast', 'Error inline', 'Modal']) check(guide.includes(needle), `primitive "${needle}" covered`)
  check(/Cancelar y Cerrar van siempre como ghost/.test(guide), 'Cancel and Close are ghost')
  check(guide.includes('las sesiones no se interrumpen'), 'copy rule carries its example')
  check(/\| 13 \|[\s\S]*\| 15 \|[\s\S]*\| 16 \|[\s\S]*\| 18 \|/.test(guide), 'lucide scale 13/15/16/18')
  for (const token of ['rounded-btn', 'rounded-card', 'bg-card', 'text-text-secondary']) check(guide.includes(token), `desktop token ${token}`)
  check(guide.includes('src/mobile') && guide.includes('PrimaryButton'), 'mobile tokens documented')
  check(/unico boton primario por pantalla, en desktop y en mobile/.test(guide), 'one primary per screen, desktop and mobile')
  check(/tildes y con voseo/.test(guide) && guide.includes('src/mobile/src/lib/i18n.ts') && guide.includes('src/main/i18n.ts'), 'i18n rule names the three catalogs')
  check(guide.includes('U+2014') && guide.includes('U+2013'), 'dash rule names the code points')
  check(guide.includes('THIRD_PARTY_NOTICES.md'), 'MIT attribution footer points to the notices')
  for (const u of UPSTREAMS) check(guide.includes(u.name), `MIT attribution footer names ${u.name}`)

  // State tokens: the STYLEGUIDE table, the desktop @theme and the mobile @theme agree.
  const docTokens = Object.fromEntries([...guide.matchAll(/^\| `[a-z]+` \| `state-([a-z]+)` \| `(#[0-9a-f]{6})` \|/gm)].map(m => [m[1], m[2]]))
  const desktopTokens = stateTokens(read('src/renderer/styles/globals.css'))
  const mobileTokens = stateTokens(read('src/mobile/src/index.css'))
  assert.deepStrictEqual(Object.keys(docTokens).sort(), ['action', 'done', 'error', 'idle', 'working'], 'STYLEGUIDE lists the five colored states'); checks++
  assert.deepStrictEqual(desktopTokens, docTokens, 'desktop state tokens match the STYLEGUIDE'); checks++
  assert.deepStrictEqual(mobileTokens, docTokens, 'mobile state tokens match the STYLEGUIDE'); checks++

  // E4-FR-02: CLAUDE.md.
  const claude = read('CLAUDE.md')
  check(lineCount(claude) <= 60, `CLAUDE.md has at most 60 lines (${lineCount(claude)})`)
  check(claude.includes('docs/STYLEGUIDE.md'), 'CLAUDE.md points to the STYLEGUIDE')
  for (const cmd of ['npm run typecheck', 'npm test', 'npm run test:ui', 'npm run test:mobile']) check(claude.includes(cmd), `verification command ${cmd}`)
  check(/Enter automatico/.test(claude) && /opt-in/.test(claude), 'no automatic Enter without opt-in')
  check(/Canvas es el renderer por defecto/.test(claude), 'Canvas default renderer')
  const deps = JSON.parse(read('package.json')).dependencies
  for (const pkg of ['@xterm/xterm', '@xterm/addon-canvas', '@xterm/headless', '@xterm/addon-serialize', '@xterm/addon-unicode11']) check(/^\d+\.\d+\.\d+$/.test(deps[pkg] || ''), `${pkg} pinned exact as CLAUDE.md says (${deps[pkg]})`)
  check(deps['@xterm/xterm'] === '5.5.0' && claude.includes('5.5.0'), 'xterm stays on 5.5.0')
  check(claude.includes('CONFIG_VERSION') && /zod/.test(claude), 'CONFIG_VERSION rule')
  check(/`src\/shared` no importa nada de Node/.test(claude) && /ni del DOM/.test(claude), 'src/shared rule')
  check(/nunca mata su pty/.test(claude) && /kills son explicitos/.test(claude), 'explicit kills rule')
  check(claude.includes('dataDir()') && claude.includes('src/main/paths.ts'), 'dataDir() rule')
  check(claude.includes('src/main/DeadlineTimer.ts') && /setInterval/.test(claude), 'background work at rest rule')
  for (const u of UPSTREAMS) check(claude.includes(`Adaptado de ${u.name} (MIT)`), `attribution header rule for ${u.name}`)
  check(claude.includes('--user-data-dir'), 'separate --user-data-dir note')
  const brand = read('src/shared/brand.ts')
  const brandValue = key => brand.match(new RegExp(`\\b${key}: '([^']+)'`))[1]
  for (const key of ['envPrefix', 'cliBin', 'repoConfigFile', 'mobileStoragePrefix']) check(claude.includes(brandValue(key)), `naming convention ${key} = ${brandValue(key)}`)
  check(claude.includes(`~/.claude/skills/${brandValue('skillDir')}`), 'skill dir naming')

  // Notices: one section per upstream with its source and full MIT text, shipped with the app.
  const notices = read('THIRD_PARTY_NOTICES.md')
  for (const u of UPSTREAMS) {
    const body = section(notices, u.name)
    check(body.includes(`- Source: https://github.com/${u.name}`) && body.includes('- License: MIT') && body.includes('MIT License'), `notices name ${u.name} and its license`)
    check(body.includes(u.copyright), `notices keep the ${u.name} copyright line`)
    check(body.includes('The above copyright notice and this permission notice shall be included in all') && body.includes('THE SOFTWARE IS PROVIDED "AS IS"'), `notices carry the full ${u.name} permission and warranty text`)
  }
  check(/from: THIRD_PARTY_NOTICES\.md\s+to: THIRD_PARTY_NOTICES\.md/.test(read('electron-builder.yml')), 'electron-builder ships the notices')

  // A file that carries the attribution has it well formed on line 1. Files that
  // only name the project (an idea, no code) need no header (PRD principle 10).
  const { files } = listFiles(root)
  const offenders = []
  let adapted = 0
  for (const file of files) {
    if (!SOURCE_EXT.test(file) || file === 'scripts/test-docs.cjs') continue
    let buf
    try { if (!fs.lstatSync(path.join(root, file)).isFile()) continue; buf = fs.readFileSync(path.join(root, file)) } catch { continue }
    if (isBinary(buf)) continue
    const text = buf.toString('utf8')
    if (!UPSTREAMS.some(u => text.includes(`Adaptado de ${u.name}`))) continue
    adapted++
    if (!headerOk(text)) offenders.push(file)
  }
  check(offenders.length === 0, `adapted files without the attribution header: ${offenders.join(', ')}`)

  // E10-FR-06: FEATURES.md, one row per capability with the suites that verify it.
  const features = read('docs/snagentsos/FEATURES.md')
  check(lineCount(features) <= 400, `FEATURES.md has at most 400 lines (${lineCount(features)})`)
  const featureLines = features.split(/\r?\n/)
  const headerAt = featureLines.indexOf(FEATURES_HEADER)
  check(headerAt >= 0 && /^\|(\s*:?-+:?\s*\|){6}$/.test(featureLines[headerAt + 1] || ''), 'FEATURES.md has the capability table (header and separator)')
  const rows = featureRows(features)
  check(rows.length > 0, 'FEATURES.md lists at least one capability')
  // A blank line inside the table would end it early and leave the rows below it unchecked.
  const tableLines = featureLines.filter(line => line.trimStart().startsWith('|')).length
  check(tableLines === rows.length + 2, `FEATURES.md has a single table with no blank line inside (${tableLines - 2} table rows, ${rows.length} read)`)
  for (const cells of rows) {
    const id = cells[0] || '?'
    check(cells.length === 6 && cells.every(Boolean), `FEATURES ${id}: six non-empty cells, no "|" inside a cell`)
    check(FEATURE_ID_RE.test(id), `FEATURES ${id}: id like \`status.failure\``)
    check(/^\d+\.\d+\.\d+$/.test(cells[5] || ''), `FEATURES ${id}: desde is an app version (${cells[5]})`)
    const suites = (cells[4] || '').match(/[\w./-]+\.cjs\b/g) || []
    check(suites.length > 0, `FEATURES ${id}: verify names a suite`)
    for (const suite of suites) check(/^scripts\/[\w.-]+\.cjs$/.test(suite) && fs.existsSync(path.join(root, suite)), `FEATURES ${id}: ${suite} exists (as scripts/<name>.cjs)`)
  }
  const ids = rows.map(cells => cells[0])
  check(new Set(ids).size === ids.length, `FEATURES ids are unique: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(', ')}`)
  // The id itself, without its backticks (the closing one would sort `a.b` after `a.bC`).
  const bare = ids.map(id => id.replace(/^`|`$/g, ''))
  const unordered = bare.flatMap((id, i) => (i > 0 && !codePointLess(bare[i - 1], id) ? [`${bare[i - 1]} before ${id}`] : []))
  check(unordered.length === 0, `FEATURES ids are in strict code point order: ${unordered.join(', ')}`)
  check(read('docs/snagentsos/README.md').includes('](FEATURES.md)'), 'docs/snagentsos/README.md links FEATURES.md')

  // The docs carry no en/em dash (check-brand covers the repo; fail here with a precise label).
  for (const file of ['docs/STYLEGUIDE.md', 'CLAUDE.md', 'THIRD_PARTY_NOTICES.md', 'docs/snagentsos/FEATURES.md']) check(!DASH_RE.test(read(file)), `${file} has no en/em dash`)

  // v2.1 contract amendments (closed by R21-00).
  const contracts = read('docs/snagentsos/CONTRATOS.md')
  for (const needle of [
    'RemotePaneStatus.precise?', 'RemotePaneInfo.resumable?', 'RemoteStateSnapshot.terminalUnicode?', 'replay.exitCode?', 'RemotePaneInfo.exitCode?',
    '`pty:restart`', '`status:sessionEnd`', '`agents:list`', '`agents:changed`', 'cacheSince', 'firstPrompt',
    'settings.notifications.inAppWhenFocused', 'settings.agents.resumeOnStartup', 'workspaces[].agentsCollapsed', 'settings.terminalAgentEndChip',
    'alerts.inPage', 'snagentsos.reloadFor', 'agent-sessions.json', 'Registro de enmiendas', '`power:getState` | invoke | `-> PowerState`', 'workingCount?: number', 'releaseAt?: number',
  ]) check(contracts.includes(needle), `contract amendment ${needle}`)

  // Every table row keeps its header's columns: a stray pipe in a cell (GFM splits
  // on it, inside backticks too) would shift the cells after it under the wrong header.
  let tables = 0
  for (const [file, text] of [['docs/snagentsos/CONTRATOS.md', contracts], ['docs/snagentsos/FEATURES.md', features]]) {
    const found = gfmTables(text)
    check(found.length > 0, `${file} has Markdown tables`)
    tables += found.length
    const offenders = tableOffenders(file, text)
    check(offenders.length === 0, `${file}: every table row has its header's cell count (escape a pipe in a cell as \\|): ${offenders.join(', ')}`)
  }

  console.log(`PASS: ${checks} docs checks (styleguide, CLAUDE.md, notices of ${UPSTREAMS.length} upstreams, ${adapted} adapted files, ${rows.length} features, contract amendments, ${tables} tables)`)
}

main()
