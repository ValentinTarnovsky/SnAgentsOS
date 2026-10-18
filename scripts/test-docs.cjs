// Project docs checks (R21-00: E4-FR-01, E4-FR-02, MIT notices and the v2.1
// contract amendments). Plain node, no build: check() counts assertions, one
// PASS line at the end, like the other suites.
//   - docs/STYLEGUIDE.md: 80 to 140 lines, the 12 numbered sections in order,
//     mobile tokens, one primary per screen, and state tokens that match the
//     @theme blocks of the desktop and the mobile CSS.
//   - CLAUDE.md: at most 60 lines with the rules E4-FR-02 lists.
//   - THIRD_PARTY_NOTICES.md: full MIT text of every adapted project, shipped
//     with the app; an attribution header is well formed and on line 1.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { listFiles, isBinary, DASH_RE } = require('./check-brand.cjs')

const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const lineCount = text => text.replace(/\n$/, '').split(/\r?\n/).length

const UPSTREAM = 'stablyai/orca'
// First line of every source file that ports or adapts upstream code (PRD principle 10).
const HEADER_RE = /^(\/\/|#) Adaptado de stablyai\/orca \(MIT\) - \S+/
const SOURCE_EXT = /\.(c?js|mjs|tsx?|css|nsh)$/

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

function main() {
  // Unit checks of the helpers.
  check(headerOk('// Adaptado de stablyai/orca (MIT) - src/main/agent-awake-service.ts\nexport {}'), 'header on line 1 accepted')
  check(headerOk('#!/usr/bin/env node\n// Adaptado de stablyai/orca (MIT) - bin/x.js\n'), 'header after a shebang accepted')
  check(!headerOk('// see stablyai/orca\n'), 'plain mention is not a header')
  check(!headerOk('import x from "y"\n// Adaptado de stablyai/orca (MIT) - a.ts\n'), 'header below line 1 rejected')
  check(!headerOk('// Adaptado de stablyai/orca - a.ts\n'), 'header without the license rejected')
  assert.deepStrictEqual(stateTokens('  --color-state-done: #22C55E;\n --color-accent-blue: #60a5fa;'), { done: '#22c55e' }); checks++

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
  check(guide.includes(UPSTREAM) && guide.includes('THIRD_PARTY_NOTICES.md'), 'MIT attribution footer')

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
  check(claude.includes('Adaptado de stablyai/orca (MIT)'), 'attribution header rule')
  check(claude.includes('--user-data-dir'), 'separate --user-data-dir note')
  const brand = read('src/shared/brand.ts')
  const brandValue = key => brand.match(new RegExp(`\\b${key}: '([^']+)'`))[1]
  for (const key of ['envPrefix', 'cliBin', 'repoConfigFile', 'mobileStoragePrefix']) check(claude.includes(brandValue(key)), `naming convention ${key} = ${brandValue(key)}`)
  check(claude.includes(`~/.claude/skills/${brandValue('skillDir')}`), 'skill dir naming')

  // Notices: full MIT text, shipped with the app.
  const notices = read('THIRD_PARTY_NOTICES.md')
  check(notices.includes(`https://github.com/${UPSTREAM}`) && notices.includes('MIT License'), 'notices name the project and license')
  check(notices.includes('Copyright (c) 2026 Lovecast Inc.'), 'notices keep the upstream copyright line')
  check(notices.includes('The above copyright notice and this permission notice shall be included in all') && notices.includes('THE SOFTWARE IS PROVIDED "AS IS"'), 'notices carry the full permission and warranty text')
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
    if (!text.includes(`Adaptado de ${UPSTREAM}`)) continue
    adapted++
    if (!headerOk(text)) offenders.push(file)
  }
  check(offenders.length === 0, `adapted files without the attribution header: ${offenders.join(', ')}`)

  // The three docs carry no en/em dash (check-brand covers the repo; fail here with a precise label).
  for (const file of ['docs/STYLEGUIDE.md', 'CLAUDE.md', 'THIRD_PARTY_NOTICES.md']) check(!DASH_RE.test(read(file)), `${file} has no en/em dash`)

  // v2.1 contract amendments (closed by R21-00).
  const contracts = read('docs/snagentsos/CONTRATOS.md')
  for (const needle of [
    'RemotePaneStatus.precise?', 'RemotePaneInfo.resumable?', 'RemoteStateSnapshot.terminalUnicode?', 'replay.exitCode?', 'RemotePaneInfo.exitCode?',
    '`pty:restart`', '`status:sessionEnd`', '`agents:list`', '`agents:changed`', 'cacheSince', 'firstPrompt',
    'settings.notifications.inAppWhenFocused', 'settings.agents.resumeOnStartup', 'workspaces[].agentsCollapsed', 'settings.terminalAgentEndChip',
    'alerts.inPage', 'snagentsos.reloadFor', 'agent-sessions.json', 'Registro de enmiendas', '`power:getState` | invoke | `-> PowerState`', 'workingCount?: number', 'releaseAt?: number',
  ]) check(contracts.includes(needle), `contract amendment ${needle}`)

  console.log(`PASS: ${checks} docs checks (styleguide, CLAUDE.md, notices, ${adapted} adapted files, contract amendments)`)
}

main()
