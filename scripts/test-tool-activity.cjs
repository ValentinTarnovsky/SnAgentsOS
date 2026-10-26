// Tool activity (app 2.7.0, A2): src/shared/toolActivity.ts. Every entry of
// the Claude and Codex tables (Codex in snake_case and camelCase, with and
// without a provider), MCP names and their edge cases, unknown names as
// `other`, the i18n key helpers, fileOfToolInput (separators, key order,
// patches, the families that name no file), the turn digest (pure add,
// dedupe, cap, last family) and digestLine (order, ties, max, files, junk),
// and the 24 tool.verb.* / tool.family.* keys in en and es of the renderer,
// phone and main catalogs. Same esbuild + vm harness as test-status.cjs: no
// Electron, no user data.
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
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, ...overrides })
  return mod.exports
}
function loadSource(contents) {
  const code = buildSync({ stdin: { contents, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, console })
  return mod.exports
}

const A = load('src/shared/toolActivity.ts')
const FAMILIES = ['read', 'search', 'edit', 'run', 'web', 'agent', 'plan', 'ask', 'todo', 'mcp', 'notebook', 'other']

// Exact Claude Code names, as the plan lists them plus the real ones found in
// the fixtures and in Claude Code 2.x (TaskOutput, TaskStop, LSP, ListAgents, the MCP resource tools).
const CLAUDE = {
  read: ['Read', 'LS'],
  search: ['Grep', 'Glob', 'ToolSearch', 'LSP'],
  edit: ['Edit', 'Write', 'MultiEdit'],
  notebook: ['NotebookEdit', 'NotebookRead'],
  run: ['Bash', 'PowerShell', 'BashOutput', 'KillShell', 'KillBash', 'Monitor', 'TaskOutput', 'TaskStop'],
  web: ['WebFetch', 'WebSearch'],
  agent: ['Task', 'Agent', 'Workflow', 'SendMessage', 'ListAgents'],
  plan: ['ExitPlanMode', 'EnterPlanMode'],
  ask: ['AskUserQuestion'],
  todo: ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'],
  mcp: ['ListMcpResourcesTool', 'ReadMcpResourceTool'],
  other: ['Skill', 'SlashCommand', 'StructuredOutput', 'CronCreate', 'EnterWorktree'],
}
// Codex: hook / function tool names, exec --json item types, app-server ThreadItem types; each in both spellings.
const CODEX = {
  run: ['shell', 'exec_command', 'execCommand', 'local_shell', 'localShell', 'unified_exec', 'unifiedExec', 'write_stdin', 'writeStdin', 'container.exec', 'command_execution', 'commandExecution'],
  edit: ['apply_patch', 'applyPatch', 'file_change', 'fileChange'],
  todo: ['update_plan', 'updatePlan', 'todo_list', 'todoList'],
  web: ['web_search', 'webSearch'],
  read: ['view_image', 'viewImage', 'imageView', 'image_view'],
  mcp: ['mcp_tool_call', 'mcpToolCall'],
  agent: ['collab_tool_call', 'collabToolCall', 'collabAgentToolCall', 'collab_agent_tool_call', 'subAgentActivity', 'sub_agent_activity', 'spawn_agent', 'spawnAgent', 'send_input', 'resume_agent', 'close_agent', 'interrupt_agent', 'followup_task', 'list_agents'],
  plan: ['plan'],
  other: ['dynamicToolCall', 'dynamic_tool_call', 'imageGeneration', 'sleep', 'agentMessage'],
}

function familyChecks() {
  same(A.TOOL_FAMILIES, FAMILIES, 'TOOL_FAMILIES has the 12 families in display order')
  for (const f of FAMILIES) check(A.isToolFamily(f), `isToolFamily(${f})`)
  for (const junk of ['Read', 'files', '', null, undefined, 3, {}, 'toString']) check(!A.isToolFamily(junk), `isToolFamily(${JSON.stringify(junk)}) is false`)

  for (const [family, names] of Object.entries(CLAUDE)) {
    for (const name of names) {
      check(A.familyOf(name) === family, `Claude ${name} -> ${family} (got ${A.familyOf(name)})`)
      check(A.familyOf(name, 'claude') === family, `Claude ${name} -> ${family} with provider claude`)
      check(A.familyOf(name, 'codex') === family, `Claude ${name} -> ${family} even with provider codex (the provider only orders the lookups)`)
    }
  }
  for (const [family, names] of Object.entries(CODEX)) {
    for (const name of names) {
      check(A.familyOf(name, 'codex') === family, `Codex ${name} -> ${family} (got ${A.familyOf(name, 'codex')})`)
      check(A.familyOf(name) === family, `Codex ${name} -> ${family} with no provider`)
      check(A.familyOf(name, 'claude') === family, `Codex ${name} -> ${family} with provider claude`)
    }
  }
  // Claude names are exact; only Codex names fold case and separators.
  for (const name of ['read', 'READ', 'bash', 'Bash ', 'grep', 'todowrite', 'Todo_Write', 'webfetch']) check(A.familyOf(name) === 'other', `Claude names are exact: ${JSON.stringify(name)} is other`)
  check(A.familyOf('WEB_SEARCH') === 'web' && A.familyOf('Apply-Patch') === 'edit' && A.familyOf('COMMAND_EXECUTION', 'codex') === 'run', 'Codex names fold case, `_`, `.` and `-`')
  // Unknown, empty, missing and prototype names.
  for (const name of ['', undefined, null, 'Frobnicate', 'toString', '__proto__', 'constructor', 'hasOwnProperty', 'valueOf']) {
    check(A.familyOf(name) === 'other' && A.familyOf(name, 'codex') === 'other', `unknown ${JSON.stringify(name)} is other`)
  }
}

function mcpChecks() {
  const cases = [
    ['mcp__github__create_issue', { server: 'github', tool: 'create_issue' }],
    ['mcp__claude_ai_Claude_Docs__batch', { server: 'claude_ai_Claude_Docs', tool: 'batch' }],
    ['mcp__fleet-board__fleet_status', { server: 'fleet-board', tool: 'fleet_status' }],
    ['mcp__minecraft-plugin-docs__get_api_reference', { server: 'minecraft-plugin-docs', tool: 'get_api_reference' }],
    ['mcp__plugin_playwright_playwright__browser_click', { server: 'plugin_playwright_playwright', tool: 'browser_click' }],
    ['mcp__srv__a__b', { server: 'srv', tool: 'a__b' }],
    ['mcp__a___b', { server: 'a_', tool: 'b' }],
    ['mcp__a____b', { server: 'a__', tool: 'b' }],
    ['mcp__x__y', { server: 'x', tool: 'y' }],
  ]
  for (const [name, want] of cases) {
    same(A.parseMcpTool(name), want, `parseMcpTool(${name})`)
    check(A.familyOf(name) === 'mcp' && A.familyOf(name, 'claude') === 'mcp' && A.familyOf(name, 'codex') === 'mcp', `${name} is mcp with any provider`)
  }
  for (const name of ['mcp__', 'mcp__srv', 'mcp__srv__', 'mcp____tool', 'mcp___tool', 'mcp_srv__tool', 'MCP__srv__tool', 'xmcp__srv__tool', 'Read', '', 'mcp']) {
    check(A.parseMcpTool(name) === null, `parseMcpTool(${JSON.stringify(name)}) is null`)
  }
  for (const junk of [null, undefined, 42, {}, ['mcp__a__b']]) check(A.parseMcpTool(junk) === null, `parseMcpTool(${JSON.stringify(junk)}) is null`)
  check(A.familyOf('mcp__srv') === 'other' && A.familyOf('mcp____tool') === 'other', 'a broken MCP name is other')
}

function keyChecks() {
  for (const f of FAMILIES) {
    check(A.toolVerbKey(f) === `tool.verb.${f}`, `toolVerbKey(${f})`)
    check(A.toolFamilyKey(f) === `tool.family.${f}`, `toolFamilyKey(${f})`)
  }
  for (const junk of ['Read', '', undefined, null, 'toString']) {
    check(A.toolVerbKey(junk) === 'tool.verb.other' && A.toolFamilyKey(junk) === 'tool.family.other', `junk family ${JSON.stringify(junk)} gives the other keys`)
  }
}

function fileChecks() {
  const f = A.fileOfToolInput
  check(f('Read', { file_path: 'C:\\repo\\src\\a.ts' }) === 'src/a.ts', 'Windows path: the last two segments, joined by /')
  check(f('Edit', { file_path: '/home/me/repo/lib/b.ts' }) === 'lib/b.ts', 'POSIX path: the last two segments')
  check(f('Write', { file_path: 'C:/repo\\mixed/dir\\c.ts' }) === 'dir/c.ts', 'mixed separators')
  check(f('MultiEdit', { file_path: 'c.ts' }) === 'c.ts' && f('Read', { file_path: '/c.ts' }) === 'c.ts', 'a bare name stays itself')
  check(f('Read', { file_path: 'C:\\repo\\src\\' }) === 'repo/src' && f('LS', { path: '/home/me/repo/' }) === 'me/repo', 'a trailing separator is dropped (LS shows its folder)')
  check(f('NotebookEdit', { notebook_path: 'C:\\nb\\work\\x.ipynb' }) === 'work/x.ipynb' && f('NotebookRead', { notebook_path: 'y.ipynb' }) === 'y.ipynb', 'notebook_path')
  check(f('view_image', { path: '/tmp/shots/s.png' }) === 'shots/s.png' && f('imageView', { path: 'C:\\a\\b.png' }) === 'a/b.png', 'Codex view_image / imageView path')
  check(f('Read', { file_path: '/a/one.ts', path: '/b/two.ts', notebook_path: '/c/three.ts' }) === 'a/one.ts', 'file_path wins over path and notebook_path')
  check(f('Read', { path: '/b/two.ts', notebook_path: '/c/three.ts' }) === 'b/two.ts', 'path wins over notebook_path')
  check(f('Read', { file_path: '', path: '/b/two.ts' }) === 'b/two.ts' && f('Read', { file_path: 7, path: '/b/two.ts' }) === 'b/two.ts', 'an empty or non string file_path falls to path')
  const patch = '*** Begin Patch\n*** Update File: src/app/main.ts\n@@\n-a\n+b\n*** Add File: src/new.ts\n+x\n*** End Patch'
  check(f('apply_patch', patch) === 'app/main.ts' && f('applyPatch', '*** Delete File: C:\\r\\old\\gone.ts\n') === 'old/gone.ts', 'a Codex patch names its first file')
  check(f('apply_patch', 'no header here') === undefined && f('Read', 'just text') === undefined, 'a string without a patch header names no file')
  check(f('fileChange', { changes: [{ path: 'C:\\r\\x\\y.ts', kind: 'update' }, { path: 'z.ts' }] }) === 'x/y.ts' && f('file_change', { changes: [] }) === undefined, 'a Codex fileChange item names its first change')
  for (const [name, input] of [['Grep', { path: 'src', pattern: 'x' }], ['Glob', { path: '/repo' }], ['Bash', { command: 'cat a.ts', file_path: 'a.ts' }], ['WebFetch', { url: 'https://x', path: '/y' }], ['Task', { file_path: 'a.ts' }], ['mcp__fs__read_file', { path: '/a/b.ts' }], ['Skill', { file_path: 'a.ts' }], ['', { file_path: 'a.ts' }]]) {
    check(f(name, input) === undefined, `${name || '(empty)'} names no file`)
  }
  for (const input of [undefined, null, {}, [], ['a.ts'], 42, { file_path: '   ' }, { file_path: '///' }]) check(f('Read', input) === undefined, `Read with ${JSON.stringify(input)} names no file`)
  check(f('Read', { file_path: 'C:\\re\u0007po\\a\u001b[31m.ts' }) === 'repo/a[31m.ts', 'control characters are stripped')
  check(f('Write', { file_path: '/x/dl/a\u202etxt.exe' }) === 'dl/atxt.exe' && f('Edit', { file_path: '/x/\ufeffs\u200brc\u2066/b\u2028.ts' }) === 'src/b.ts', 'bidi, zero-width, separator and BOM characters are stripped')
  const long = f('Read', { file_path: 'C:\\' + 'd'.repeat(300) + '\\file.ts' })
  check(long.length === 120 && long.endsWith('/file.ts'), 'a very long path keeps its last 120 characters (the name included)')
  const astral = f('Read', { file_path: '/x/' + '\u{1F600}'.repeat(80) + '.ts' })
  check(astral.length <= 120 && !/^[\udc00-\udfff]/.test(astral), 'the cut never starts on half a surrogate pair')
}

function digestChecks() {
  same(A.emptyDigest(), { tools: 0, families: {}, files: [] }, 'emptyDigest')
  check(A.emptyDigest() !== A.emptyDigest(), 'emptyDigest is fresh each time')
  check(A.DIGEST_FILES_MAX === 5, 'DIGEST_FILES_MAX is 5')
  const d0 = A.emptyDigest()
  const d1 = A.addTool(d0, 'Read', { file: 'src/a.ts' })
  same(d0, { tools: 0, families: {}, files: [] }, 'addTool leaves its input as it was')
  same(d1, { tools: 1, families: { read: 1 }, files: ['src/a.ts'], lastFamily: 'read' }, 'one Read')
  const d2 = A.addTool(d1, 'Read', { file: 'src/a.ts' })
  same(d2.files, ['src/a.ts'], 'the same file twice counts once')
  check(d2.tools === 2 && d2.families.read === 2 && d1.families.read === 1 && d1.files.length === 1 && d2.files !== d1.files, 'counts grow on a new object; the old one keeps its own')
  let d = d2
  for (const [name, file] of [['Edit', 'b.ts'], ['Grep'], ['Edit', 'c.ts'], ['Bash'], ['Write', 'd.ts'], ['Edit', 'e.ts'], ['Edit', 'f.ts'], ['Edit', 'b.ts']]) d = A.addTool(d, name, file ? { file } : undefined)
  same(d.files, ['src/a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'], 'files: distinct, first DIGEST_FILES_MAX kept')
  same(d.families, { read: 2, edit: 6, search: 1, run: 1 }, 'calls per family')
  check(d.tools === 10 && d.lastFamily === 'edit', 'tools counts every call; lastFamily is the latest')
  check(A.addTool(d, 'shell', { provider: 'codex' }).lastFamily === 'run' && A.addTool(d, 'mcp__s__t').families.mcp === 1 && A.addTool(d, 'Nope').families.other === 1, 'provider, MCP and unknown names go through familyOf')
  same(A.addTool(A.emptyDigest(), 'Read', { file: '  x.ts  ' }).files, ['x.ts'], 'a file is trimmed')
  same(A.addTool(A.emptyDigest(), 'Read', { file: '   ' }).files, [], 'a blank file is ignored')
  same(A.addTool(A.emptyDigest(), 'Read', { file: 42 }).files, [], 'a non string file is ignored')
  check(A.addTool(A.emptyDigest(), 'Read').files.length === 0, 'no opts is fine')
}

function lineChecks() {
  const words = { read: 'Read', search: 'Search', edit: 'Edit', run: 'Run', web: 'Web', agent: 'Agent', plan: 'Plan', ask: 'Ask', todo: 'Tasks', mcp: 'MCP', notebook: 'Notebook', other: 'Other' }
  const label = (f) => words[f]
  const build = (calls) => calls.reduce((d, [name, file]) => A.addTool(d, name, file ? { file } : undefined), A.emptyDigest())
  const d = build([['Edit', 'a.ts'], ['Read'], ['Edit', 'b.ts'], ['Bash'], ['Read'], ['Edit', 'a.ts']])
  check(A.digestLine(d, label) === 'Edit 3, Read 2, Run 1 (a.ts, b.ts)', 'digestLine: ' + A.digestLine(d, label))
  check(A.digestLine(A.emptyDigest(), label) === '', 'an empty digest is an empty line')
  check(A.digestLine(build([['Grep'], ['Bash']]), label) === 'Search 1, Run 1', 'no files: no parentheses; a tie keeps TOOL_FAMILIES order')
  check(A.digestLine(build([['Nope'], ['TodoWrite'], ['WebFetch'], ['Read']]), label) === 'Read 1, Web 1, Tasks 1', 'ties in TOOL_FAMILIES order, at most 3 families by default')
  check(A.digestLine(build([['Nope'], ['Nope'], ['Bash'], ['Read'], ['Grep'], ['Grep']]), label, 2) === 'Search 2, Other 2', 'max 2: the two biggest, tie by TOOL_FAMILIES order')
  check(A.digestLine(d, label, 1) === 'Edit 3 (a.ts, b.ts)' && A.digestLine(d, label, 0) === 'Edit 3 (a.ts, b.ts)' && A.digestLine(d, label, -4) === 'Edit 3 (a.ts, b.ts)', 'max is at least 1')
  check(A.digestLine(d, label, 12) === 'Edit 3, Read 2, Run 1 (a.ts, b.ts)' && A.digestLine(d, label, NaN) === 'Edit 3, Read 2, Run 1 (a.ts, b.ts)', 'a big max shows every family; NaN is the default')
  check(A.digestLine(d, (f) => 'tool.family.' + f) === 'tool.family.edit 3, tool.family.read 2, tool.family.run 1 (a.ts, b.ts)', 'the label callback names each family')
  const many = build([['Read', 'a'], ['Read', 'b'], ['Read', 'c'], ['Read', 'd'], ['Read', 'e'], ['Read', 'f']])
  check(A.digestLine(many, label) === 'Read 6 (a, b, c, d, e)', 'at most DIGEST_FILES_MAX files')
  // A digest from the wire: junk counts and files are skipped.
  const junk = { tools: 9, families: { edit: 2, read: 'x', run: -1, web: NaN, agent: Infinity, bogus: 5, todo: 1.7 }, files: ['a.ts', 3, '', null, 'b.ts'] }
  check(A.digestLine(junk, label) === 'Edit 2, Tasks 1 (a.ts, b.ts)', 'junk counts and files are skipped: ' + A.digestLine(junk, label))
  check(A.digestLine({ tools: 3, families: null, files: ['a.ts'] }, label) === '' && A.digestLine({ tools: 1, families: {}, files: 'a.ts' }, label) === '', 'no usable families: empty line')
  check(A.digestLine({ tools: 1, families: { read: 1 } }, label) === 'Read 1', 'a digest without files')
  const all = build(FAMILIES.map((f) => [CLAUDE[f]?.[0] ?? 'Nope', f + '.ts']))
  const line = A.digestLine(all, label, 12)
  check(!/[\u2013\u2014]/.test(line) && !line.includes(' - ') && line.split(', ').length >= 12, 'no dashes in a line: ' + line)
}

function catalogChecks() {
  const EN = {
    'tool.verb.read': 'Reading', 'tool.verb.search': 'Searching', 'tool.verb.edit': 'Editing', 'tool.verb.run': 'Running', 'tool.verb.web': 'Browsing', 'tool.verb.agent': 'Delegating',
    'tool.verb.plan': 'Planning', 'tool.verb.ask': 'Asking', 'tool.verb.todo': 'Updating tasks', 'tool.verb.mcp': 'Using MCP', 'tool.verb.notebook': 'Editing notebook', 'tool.verb.other': 'Working',
    'tool.family.read': 'Read', 'tool.family.search': 'Search', 'tool.family.edit': 'Edit', 'tool.family.run': 'Run', 'tool.family.web': 'Web', 'tool.family.agent': 'Agent',
    'tool.family.plan': 'Plan', 'tool.family.ask': 'Ask', 'tool.family.todo': 'Tasks', 'tool.family.mcp': 'MCP', 'tool.family.notebook': 'Notebook', 'tool.family.other': 'Other',
  }
  const ES = {
    'tool.verb.read': 'Leyendo', 'tool.verb.search': 'Buscando', 'tool.verb.edit': 'Editando', 'tool.verb.run': 'Ejecutando', 'tool.verb.web': 'Navegando', 'tool.verb.agent': 'Delegando',
    'tool.verb.plan': 'Planificando', 'tool.verb.ask': 'Preguntando', 'tool.verb.todo': 'Actualizando tareas', 'tool.verb.mcp': 'Usando MCP', 'tool.verb.notebook': 'Editando notebook', 'tool.verb.other': 'Trabajando',
    'tool.family.read': 'Lectura', 'tool.family.search': 'Búsqueda', 'tool.family.edit': 'Edición', 'tool.family.run': 'Comando', 'tool.family.web': 'Web', 'tool.family.agent': 'Agente',
    'tool.family.plan': 'Plan', 'tool.family.ask': 'Pregunta', 'tool.family.todo': 'Tareas', 'tool.family.mcp': 'MCP', 'tool.family.notebook': 'Notebook', 'tool.family.other': 'Otro',
  }
  const keys = FAMILIES.flatMap((f) => [A.toolVerbKey(f), A.toolFamilyKey(f)])
  check(keys.length === 24 && keys.every((k) => k in EN && k in ES) && Object.keys(EN).length === 24, 'the helpers name exactly the 24 expected keys')
  const toolKeys = (dict) => Object.keys(dict).filter((k) => k.startsWith('tool.')).sort()

  // Renderer: the exported dictionaries.
  const r = loadSource(`export { en } from './src/renderer/i18n/en'; export { es } from './src/renderer/i18n/es'`)
  same(toolKeys(r.en), Object.keys(EN).sort(), 'renderer en carries exactly the 24 tool.* keys')
  same(toolKeys(r.es), Object.keys(EN).sort(), 'renderer es carries exactly the 24 tool.* keys')
  for (const k of keys) {
    check(r.en[k] === EN[k], `renderer en ${k} = ${EN[k]} (got ${r.en[k]})`)
    check(Object.prototype.hasOwnProperty.call(r.es, k) && r.es[k] === ES[k], `renderer es ${k} = ${ES[k]} (got ${r.es[k]})`)
  }

  // Phone: t() per language, plus each key written in both dictionaries (t falls back to en).
  const m = load('src/mobile/src/lib/i18n.ts')
  const phoneSrc = fs.readFileSync(path.join(root, 'src/mobile/src/lib/i18n.ts'), 'utf8')
  const phoneEsAt = phoneSrc.indexOf('\nconst es')
  check(phoneEsAt > 0, 'phone catalog: the es dictionary is found')
  for (const k of keys) {
    m.setLang('en')
    check(m.t(k) === EN[k], `phone en ${k} = ${EN[k]} (got ${m.t(k)})`)
    m.setLang('es')
    check(m.t(k) === ES[k], `phone es ${k} = ${ES[k]} (got ${m.t(k)})`)
    check(phoneSrc.slice(0, phoneEsAt).includes(`'${k}': '${EN[k]}'`) && phoneSrc.slice(phoneEsAt).includes(`'${k}': '${ES[k]}'`), `phone ${k} is written in en and in es`)
  }
  m.setLang('en')

  // Main: mainTLang per language, plus each key written in both blocks (mainTLang falls back to en).
  const { mainTLang } = load('src/main/i18n.ts')
  const mainSrc = fs.readFileSync(path.join(root, 'src/main/i18n.ts'), 'utf8')
  const mainEsAt = mainSrc.indexOf('\n  es: {')
  check(mainEsAt > 0, 'main catalog: the es block is found')
  for (const k of keys) {
    check(mainTLang('en', k) === EN[k], `main en ${k} = ${EN[k]} (got ${mainTLang('en', k)})`)
    check(mainTLang('es', k) === ES[k], `main es ${k} = ${ES[k]} (got ${mainTLang('es', k)})`)
    check(mainSrc.slice(0, mainEsAt).includes(`'${k}': '${EN[k]}'`) && mainSrc.slice(mainEsAt).includes(`'${k}': '${ES[k]}'`), `main ${k} is written in en and in es`)
  }
}

function main() {
  familyChecks()
  mcpChecks()
  keyChecks()
  fileChecks()
  digestChecks()
  lineChecks()
  catalogChecks()
  console.log(`PASS: ${checks} tool activity checks (Claude and Codex tables, MCP names, unknown as other, i18n keys, fileOfToolInput, turn digest, digestLine, tool.* keys in the three catalogs)`)
}

try {
  main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
