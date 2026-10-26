// Chat rows (app 2.7.0, A2): src/shared/chatRows.ts, the model the phone's
// Chat and the share guest's Chat re-export (src/mobile/src/lib/chatModel.ts,
// src/renderer/components/share/chat/chatModel.ts). The list rules (cap 500,
// cursor moves, prepend, replace by id), tool runs and their labels, run
// status, late and orphan results, safe links, the fold, both wrappers with
// their own key namespace (chat.* and shareGuest.chat.*), and phases: same
// family tool rows folded into one row with its count, files and items, ended
// by text, a user or system row, another family or an errored tool.
// Same esbuild + vm harness as test-status.cjs: no Electron, no DOM.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
// Values built inside the vm have another realm's prototypes; compare as JSON.
function same(actual, expected, label) { assert.deepEqual(JSON.parse(JSON.stringify(actual ?? null)), expected, label); checks++ }

const code = buildSync({
  stdin: {
    resolveDir: root,
    loader: 'ts',
    contents: `export * as S from './src/shared/chatRows'; export * as M from './src/mobile/src/lib/chatModel'; export * as R from './src/renderer/components/share/chat/chatModel'`,
  },
  bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') },
}).outputFiles[0].text
const mod = { exports: {} }
vm.runInNewContext(code, { module: mod, exports: mod.exports, console })
const { S, M, R } = mod.exports

const msg = (off, role = 'assistant', text = 'x' + off) => ({ id: String(off), role, ts: null, blocks: [{ t: 'text', text }] })
const use = (id, name, summary = '') => ({ id: String(id), role: 'assistant', ts: null, blocks: [{ t: 'toolUse', id: 'u' + id, name, summary }] })
const res = (id, extra = {}) => ({ id: id + '.r', role: 'tool', ts: null, blocks: [{ t: 'toolResult', toolUseId: 'u' + id, isError: false, text: 'ok', ...extra }] })
const err = (id) => res(id, { isError: true, text: 'boom' })
const kinds = (rows) => rows.map((r) => (r.kind === 'phase' ? `phase:${r.family}:${r.count}` : r.kind)).join()

// --- Lists (moved from test-chat.cjs testMobileModel) ---------------------------------

function listChecks(m, who) {
  check(m.CHAT_MEMORY_MAX === 500, `${who}: CHAT_MEMORY_MAX is 500`)
  same(m.EMPTY_LIST, { items: [], cursor: null, done: true, capped: false }, `${who}: EMPTY_LIST`)
  let list = m.replaceList({ items: Array.from({ length: 50 }, (_, i) => msg(1000 + i)), cursor: '1000', done: false })
  list = m.appendList(list, Array.from({ length: 460 }, (_, i) => msg(5000 + i)))
  check(list.items.length === 500 && list.items[0].id === '1010' && list.cursor === '1010' && !list.done, `${who}: appends keep 500 messages and move the cursor to the oldest kept`)
  const capped = m.prependList(list, { items: [msg(900), msg(950)], cursor: '900', done: false })
  check(capped.items.length === 500 && capped.capped && capped.items[0].id === '1010', `${who}: a prepend at the cap keeps the list and stops offering more`)
  let small = m.replaceList({ items: [msg(300), msg(400)], cursor: '300', done: false })
  small = m.prependList(small, { items: [msg(100), msg(200)], cursor: null, done: true })
  check(small.items.map((x) => x.id).join() === '100,200,300,400' && small.done && small.cursor === null, `${who}: a prepend goes in front and takes the page cursor`)
  check(m.appendList(small, [{ ...msg(400), blocks: [{ t: 'text', text: 'edited' }] }]).items.at(-1).blocks[0].text === 'edited', `${who}: an id seen again replaces its message`)
  check(m.appendList(small, []) === small, `${who}: an empty append keeps the same list`)
  const big = m.replaceList({ items: Array.from({ length: 520 }, (_, i) => msg(10 + i)), cursor: null, done: true })
  check(big.items.length === 500 && big.items[0].id === '30' && big.cursor === '30' && !big.done, `${who}: a first page over the cap keeps the last 500 and can load the rest`)
  const dup = m.prependList(small, { items: [msg(100), msg(50)], cursor: null, done: true })
  check(dup.items.map((x) => x.id).join() === '50,100,200,300,400', `${who}: a prepend skips ids already in the list`)
  const split = m.replaceList({ items: [{ ...msg(70), id: '70.1' }, ...Array.from({ length: 500 }, (_, i) => msg(100 + i))], cursor: '70', done: false })
  check(split.cursor === '100', `${who}: the cursor is the byte offset of the oldest kept message`)
}

// --- Rows, labels, links (moved from test-chat.cjs testMobileModel) --------------------

function rowChecks() {
  const tr = (k, v) => ({ 'chat.tools.files': `${v?.name} ${v?.n} files`, 'chat.tools.commands': `${v?.name} ${v?.n} commands`, 'chat.tools.times': `${v?.name} x${v?.n}`, 'chat.tools.mixed': `${v?.n} tools: ${v?.names}`, 'chat.tools.result': `${v?.n} results` })[k] ?? k
  const trGuest = (k, v) => tr(k.replace(/^shareGuest\./, ''), v)
  const patch = { hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 14, lines: [...Array(12).fill('+n'), ...Array(3).fill('-o')] }] }
  const items = [msg(1, 'user', 'go'), use(2, 'Read', 'a.ts'), res(2), use(3, 'Read', 'b.ts'), res(3), use(4, 'Read', 'c.ts'), res(4), use(5, 'Edit', 'App.tsx'), res(5, { patch }), use(6, 'Bash', 'npm test'), msg(7, 'assistant', 'done')]
  for (const [m, t, who] of [[M, tr, 'phone'], [R, trGuest, 'guest']]) {
    const rows = m.buildRows(items)
    check(rows.map((x) => x.kind).join() === 'message,tools,tools,tools,message', `${who}: three Reads, then the Edit, then the Bash: one row per tool run`)
    check(m.runLabel(rows[1].calls, t) === 'Read 3 files' && m.runLabel(rows[2].calls, t) === 'Edit App.tsx +12 -3' && m.runLabel(rows[3].calls, t) === 'Bash npm test', `${who}: labels "Read 3 files", "Edit App.tsx +12 -3", "Bash npm test"`)
    check(m.runStatus(rows[3].calls) === 'pending' && m.runStatus(rows[1].calls) === 'done' && m.runStatus([{ id: 'x', name: 'Bash', summary: '', result: { t: 'toolResult', toolUseId: 'x', isError: true, text: '' } }]) === 'error', `${who}: a call without a result is pending, an error wins`)
    const late = m.buildRows([use(2, 'Read', 'a.ts'), msg(3), res(2)])
    check(late.length === 2 && late[0].calls[0].result && late[0].calls[0].result.text === 'ok', `${who}: a result after other messages completes its earlier call`)
    const orphan = m.buildRows([res(9)])
    check(orphan.length === 1 && orphan[0].kind === 'tools' && orphan[0].calls[0].name === '' && m.runLabel(orphan[0].calls, t) === '1 results', `${who}: a result whose call is not loaded shows alone`)
    check(m.safeHref('https://a.b/c') === 'https://a.b/c' && m.safeHref('javascript:alert(1)') === null && m.safeHref('data:text/html,x') === null && m.safeHref(' HTTP://x ') === 'HTTP://x' && m.safeHref(null) === null && m.safeHref('') === null, `${who}: only http and https links are offered`)
    check(m.needsFold('a\nb\nc\nd\ne') && !m.needsFold('a\nb\nc\nd') && m.needsFold('x'.repeat(281)) && !m.needsFold('x'.repeat(280)) && m.USER_FOLD_LINES === 4, `${who}: a prompt folds past 4 lines or 280 characters`)
    check(m.messageText([{ t: 'text', text: 'a' }, { t: 'image', label: 'i' }, { t: 'thinking', text: 'b' }, { t: 'toolUse', id: 'u', name: 'Bash', summary: 's' }]) === 'a\n\nb', `${who}: Copy takes text and thinking, joined by a blank line`)
    same(m.patchCounts(patch.hunks), { add: 12, del: 3 }, `${who}: patchCounts`)
    // Label branches.
    const calls = (name, n) => Array.from({ length: n }, (_, i) => ({ id: name + i, name, summary: 's' + i, result: null }))
    check(m.runLabel(calls('Write', 2), t) === 'Write 2 files' && m.runLabel(calls('shell', 3), t) === 'shell 3 commands' && m.runLabel(calls('local_shell', 2), t) === 'local_shell 2 commands' && m.runLabel(calls('Grep', 2), t) === 'Grep x2', `${who}: files, commands and times labels`)
    check(m.runLabel([...calls('Read', 1), ...calls('Edit', 1)], t) === '2 tools: Read, Edit' && m.runLabel([{ id: 'n', name: 'Read', summary: '', result: null }], t) === 'Read', `${who}: mixed names, and one call without a summary`)
    check(m.runLabel([{ id: 'e', name: 'Edit', summary: 'a.ts', result: null }], t) === 'Edit a.ts' && m.runLabel([{ id: 'r', name: 'Read', summary: 'a.ts', result: { t: 'toolResult', toolUseId: 'r', isError: false, text: '', patch } }], t) === 'Read a.ts', `${who}: diff counts only for a file tool with a patch`)
  }
  // The two wrappers keep their own namespaces.
  check(M.systemKey('[Request interrupted by user for tool use]') === 'chat.interrupted' && M.systemKey('[Request interrupted by user]') === 'chat.interrupted' && M.systemKey('[Record skipped: too large]') === 'chat.skipped' && M.systemKey('Set model') === null, 'phone: interrupt and skipped rows are chat.* keys')
  check(R.systemKey('[Request interrupted by user for tool use]') === 'shareGuest.chat.interrupted' && R.systemKey('[Record skipped: too large]') === 'shareGuest.chat.skipped' && R.systemKey('Set model') === null, 'guest: interrupt and skipped rows are shareGuest.chat.* keys')
  const seen = []
  const spy = (k, v) => { seen.push([k, v]); return 'T' }
  M.runLabel([{ id: 'a', name: 'Read', summary: '', result: null }, { id: 'b', name: 'Read', summary: '', result: null }], spy)
  R.runLabel([{ id: 'a', name: 'Read', summary: '', result: null }, { id: 'b', name: 'Read', summary: '', result: null }], spy)
  same(seen, [['chat.tools.files', { name: 'Read', n: 2 }], ['shareGuest.chat.tools.files', { name: 'Read', n: 2 }]], 'each wrapper translates its own key with the same vars')
  // The shared model itself returns keys, never translated text.
  same(S.runLabelOf([{ id: 'a', name: 'Grep', summary: '', result: null }, { id: 'b', name: 'Grep', summary: '', result: null }], 'chat.'), { key: 'chat.tools.times', vars: { name: 'Grep', n: 2 } }, 'runLabelOf: a key of the namespace plus vars')
  same(S.runLabelOf([{ id: 'r', name: '', summary: '', result: null }], 'shareGuest.chat.'), { key: 'shareGuest.chat.tools.result', vars: { n: 1 } }, 'runLabelOf: orphan results in the guest namespace')
  same(S.runLabelOf([{ id: 'b', name: 'Bash', summary: 'npm test', result: null }], 'chat.'), { text: 'Bash npm test' }, 'runLabelOf: one call is literal text (a tool name and its summary)')
  check(S.systemKeyOf('[Record skipped: too large]', 'chat.') === 'chat.skipped' && S.systemKeyOf('[Request interrupted by user]', 'shareGuest.chat.') === 'shareGuest.chat.interrupted' && S.systemKeyOf('hi', 'chat.') === null, 'systemKeyOf: a key of the namespace')
  // Both wrappers are the shared functions (one model, two names).
  for (const name of ['buildRows', 'replaceList', 'prependList', 'appendList', 'runStatus', 'patchCounts', 'safeHref', 'messageText', 'needsFold', 'phaseCalls']) {
    check(M[name] === S[name] && R[name] === S[name], `${name} is re-exported by both chatModel files`)
  }
  check(M.EMPTY_LIST === S.EMPTY_LIST && R.EMPTY_LIST === S.EMPTY_LIST && M.CHAT_MEMORY_MAX === 500 && R.USER_FOLD_LINES === 4, 'constants are re-exported too')
}

// --- Phases ---------------------------------------------------------------------------

function phaseChecks() {
  const b = S.buildRows
  // Two families in a row: Grep then Glob fold into one search phase.
  let rows = b([msg(1, 'user', 'find it'), use(2, 'Grep', 'TODO'), res(2), use(3, 'Glob', '**/*.ts'), res(3), msg(4, 'assistant', 'found')])
  check(kinds(rows) === 'message,phase:search:2,message', 'Grep then Glob: one search phase: ' + kinds(rows))
  const p = rows[1]
  check(p.id === 'p:t:2:u2' && p.items.length === 2 && p.items.every((r) => r.kind === 'tools') && p.items[0].calls[0].name === 'Grep' && p.items[1].calls[0].name === 'Glob', 'the phase keeps its tool rows as items; its id is p:<first row id>')
  same(p.files, [], 'search tools name no files')
  check(S.runStatus(S.phaseCalls(p)) === 'done' && S.phaseCalls(p).length === 2, 'phaseCalls: every call of the phase')
  // A lone tool row stays a plain tools row, even with several calls of one tool.
  rows = b([use(1, 'Read', 'a.ts'), res(1), use(2, 'Read', 'b.ts'), res(2), use(3, 'Read', 'c.ts'), res(3)])
  check(kinds(rows) === 'tools' && rows[0].calls.length === 3, 'three Reads are one run, a lone row: no phase')
  check(kinds(b([use(1, 'Grep', 'x'), res(1)])) === 'tools', 'a single call stays a tools row')
  // Rows of one family with several calls each: count is every named call.
  rows = b([use(1, 'Read', 'a.ts'), res(1), use(2, 'Read', 'b.ts'), res(2), use(3, 'LS', 'C:\\repo\\src'), res(3), use(4, 'Read', 'c.ts'), res(4)])
  check(kinds(rows) === 'phase:read:4' && rows[0].items.length === 3, 'Read x2, LS, Read: one read phase of 4 calls over 3 rows: ' + kinds(rows))
  same(rows[0].files, ['a.ts', 'b.ts', 'repo/src', 'c.ts'], 'files from the summaries, through fileOfToolInput (the LS folder as its last two segments)')
  // Edit family: files deduped and capped at 5.
  rows = b([use(1, 'Edit', 'a.ts'), use(2, 'Write', 'b.ts'), use(3, 'MultiEdit', 'a.ts'), use(4, 'Edit', 'c.ts')])
  check(kinds(rows) === 'phase:edit:4', 'Edit, Write, MultiEdit, Edit fold (pending calls too): ' + kinds(rows))
  same(rows[0].files, ['a.ts', 'b.ts', 'c.ts'], 'a file edited twice is listed once')
  check(S.runStatus(S.phaseCalls(rows[0])) === 'pending', 'a phase with calls still waiting is pending')
  rows = b(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((f, i) => use(i + 1, i % 2 ? 'Write' : 'Edit', f + '.ts')))
  check(kinds(rows) === 'phase:edit:7', 'seven alternating edits: one phase of 7')
  same(rows[0].files, ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'], 'at most DIGEST_FILES_MAX files, the first ones')
  // Codex names: a patch lists its files; shell and exec_command are one family.
  rows = b([use(1, 'apply_patch', 'a.ts, b.ts'), res(1), use(2, 'Edit', 'c.ts'), res(2), msg(3), use(4, 'exec_command', 'npm test'), res(4), use(5, 'shell', 'git status'), res(5)])
  check(kinds(rows) === 'phase:edit:2,message,phase:run:2', 'Codex apply_patch + Edit, then exec_command + shell: ' + kinds(rows))
  same(rows[0].files, ['a.ts', 'b.ts', 'c.ts'], 'every file of a Codex patch')
  same(rows[2].files, [], 'commands name no files')
  // What ends a phase.
  check(kinds(b([use(1, 'Grep'), msg(2), use(3, 'Glob')])) === 'tools,message,tools', 'a text row ends the phase')
  check(kinds(b([use(1, 'Grep'), { id: '2', role: 'assistant', ts: null, blocks: [{ t: 'thinking', text: 'hmm' }] }, use(3, 'Glob')])) === 'tools,message,tools', 'a thinking row ends the phase')
  check(kinds(b([use(1, 'Grep'), msg(2, 'user', 'and?'), use(3, 'Glob')])) === 'tools,message,tools', 'a user row (the next turn) ends the phase')
  check(kinds(b([use(1, 'Grep'), msg(2, 'system', '[Request interrupted by user]'), use(3, 'Glob')])) === 'tools,message,tools', 'a system row ends the phase')
  check(kinds(b([use(1, 'Grep'), use(2, 'Read'), use(3, 'Glob')])) === 'tools,tools,tools', 'another family ends the phase')
  check(kinds(b([use(1, 'Grep'), use(2, 'Glob'), use(3, 'Read'), use(4, 'LS'), use(5, 'Bash')])) === 'phase:search:2,phase:read:2,tools', 'families one after another: one phase each')
  // An errored tool ends the phase and stays visible as its own row.
  rows = b([use(1, 'Grep'), res(1), use(2, 'Glob'), res(2), use(3, 'Grep'), err(3), use(4, 'Glob'), res(4), use(5, 'ToolSearch'), res(5)])
  check(kinds(rows) === 'phase:search:2,tools,phase:search:2', 'Grep, Glob, Grep (error), Glob, ToolSearch: phase, the error alone, phase: ' + kinds(rows))
  check(S.runStatus(rows[1].calls) === 'error' && rows[1].calls[0].id === 'u3', 'the errored row is a plain tools row with status error')
  check(kinds(b([use(1, 'Grep'), res(1), use(2, 'Glob'), err(2), use(3, 'Grep'), res(3)])) === 'tools,tools,tools', 'an error in the middle leaves its neighbours alone')
  // Results land late: phases are folded over finished runs.
  check(kinds(b([use(1, 'Grep'), use(2, 'Glob'), res(1), err(2)])) === 'tools,tools', 'an error that arrives after both calls still splits the phase')
  check(kinds(b([use(1, 'Grep'), use(2, 'Glob'), res(1), res(2)])) === 'phase:search:2', 'results that arrive after both calls keep the phase')
  // Several calls in one message are rows like any other.
  rows = b([{ id: '9', role: 'assistant', ts: null, blocks: [{ t: 'toolUse', id: 'a', name: 'Grep', summary: 'x' }, { t: 'toolUse', id: 'b', name: 'Glob', summary: 'y' }] }, { id: '10', role: 'tool', ts: null, blocks: [{ t: 'toolResult', toolUseId: 'a', isError: false, text: '' }, { t: 'toolResult', toolUseId: 'b', isError: false, text: '' }] }])
  check(kinds(rows) === 'phase:search:2' && rows[0].id === 'p:t:9:a', 'parallel calls in one message fold too')
  // Orphan results: their row stays plain.
  rows = b([res(7), msg(8), use(1, 'Grep'), use(2, 'Glob')])
  check(kinds(rows) === 'tools,message,phase:search:2' && rows[0].calls[0].name === '', 'a row of orphan results stays a tools row')
  // The phase id stays as rows join it (a stable React key while the turn grows).
  const grow = [use(1, 'Grep'), use(2, 'Glob')]
  const before = b(grow)[0].id
  const after = b([...grow, use(3, 'ToolSearch')])
  check(after.length === 1 && after[0].id === before && after[0].count === 3, 'a row that joins keeps the phase id')
  // Opt out: the raw runs.
  check(kinds(b([use(1, 'Grep'), use(2, 'Glob')], { phases: false })) === 'tools,tools' && kinds(b([use(1, 'Grep'), use(2, 'Glob')], {})) === 'phase:search:2', 'phases: false gives the raw tool runs')
  // Unknown and MCP tools have families too.
  check(kinds(b([use(1, 'mcp__a__x'), use(2, 'mcp__b__y')])) === 'phase:mcp:2' && kinds(b([use(1, 'Skill'), use(2, 'Frob')])) === 'phase:other:2', 'MCP and other tools fold by family as well')
  // Ids stay unique across message, tools and phase rows.
  rows = b([msg(1, 'user'), use(2, 'Grep'), use(3, 'Glob'), msg(4), use(5, 'Read'), msg(6, 'user'), { id: '7', role: 'user', ts: null, blocks: [{ t: 'text', text: 'a' }, { t: 'toolResult', toolUseId: 'u5', isError: false, text: '' }, { t: 'text', text: 'b' }] }])
  const ids = rows.map((r) => r.id)
  check(new Set(ids).size === ids.length && ids.includes('7') && ids.includes('7#1'), 'row ids stay unique: ' + ids.join())
  // Big lists: one pass, no surprises.
  const many = []
  for (let i = 0; i < 500; i++) many.push(use(1000 + i, ['Grep', 'Glob', 'Read', 'Edit', 'Write'][i % 5], 'f' + (i % 7) + '.ts'))
  rows = b(many)
  check(rows.every((r) => r.kind !== 'message') && rows.reduce((n, r) => n + (r.kind === 'phase' ? r.count : r.calls.length), 0) === 500, '500 calls: every call lands in one row')
}

function main() {
  listChecks(S, 'shared')
  listChecks(M, 'phone')
  listChecks(R, 'guest')
  rowChecks()
  phaseChecks()
  console.log(`PASS: ${checks} chat rows checks (lists capped at 500, tool runs and labels, late and orphan results, safe links, fold, chat.* and shareGuest.chat.* wrappers, phases by tool family)`)
}

try {
  main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
