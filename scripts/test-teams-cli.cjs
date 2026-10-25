// snaos team (app 2.7.0, E10 B3, design 5.1 to 5.3): the client parser (subcommands, the verb of
// `task` and `verdict`, the flags of each verb, --blocked-by and --options splitting, the client caps),
// the text of --file, --body-file and stdin (a BOM and the trailing CR/LF stripped, UTF-16LE and BE
// with a BOM or without one, U+FFFD refused with the hint) and teamCtl behind the real CtlServer and
// CtlHandlers with a team caller {paneId: 'team:<runId>', ptyId: same, workspaceId: '', team}: every
// method's params as the port gets them, the role and mode checks (a dev creates only with --parent =
// its task), every row of the 5.1 error mapping table with its exit code, the 120 reads and 60 writes a
// minute and forgetCaller at revoke, a revoked token (401 naming the run, exit 6), conflict concluded
// after a terminal tool (the port is a fake here: B3 stubs the store's terminal tools), redaction, Teams
// off answering disabled (never forbidden), each `cap` with its own hint (the board, a comment thread, the
// state file), the guide (Claude calls snaos team with its Bash tool only), and the fake agent's `cli`
// step running the real cli.js (`snaos team show --json`) with the run env.
// Last, the real TeamService behind teamCtl on a temp repo: a Lead run creates tasks with blockers
// through snaos team, a user reprioritization survives its next update (user_owned), a loop of
// blockers answers with every task of it (t-1 -> t-3 -> t-2 -> t-1), `team task get`
// delivers only the queued comments its reply carries (newest 30), a write past TEAM_STATE_MAX_BYTES
// answers "the team state is full", and Labs off answers disabled.
// Same esbuild + vm harness as test-status.cjs: no Electron, no user data, never a real agent.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const cp = require('node:child_process')
const root = path.resolve(__dirname, '..')
const win = process.platform === 'win32'
let checks = 0
function check(condition, label, detail) {
  assert.ok(condition, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  checks++
}
const EXTERNAL = ['electron', 'ws', 'node-pty', '@xterm/headless', '@xterm/addon-serialize', '@xterm/addon-unicode11']
const ALIAS = { '@shared': path.join(root, 'src/shared') }
const FAKE = path.join(__dirname, 'fixtures', 'teams', 'fake-agent.cjs')

function loadEntry(contents) {
  const code = buildSync({ stdin: { contents, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, external: EXTERNAL, alias: ALIAS, logLevel: 'silent' }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, URL, AbortController, TextEncoder, TextDecoder, structuredClone, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, queueMicrotask })
  return mod.exports
}

const M = loadEntry(`
export { CtlServer } from './src/main/cli/CtlServer'
export { CtlTokens, newToken } from './src/main/cli/CtlTokens'
export { CtlHandlers } from './src/main/cli/handlers'
export { createTeamCtl, teamCtlError } from './src/main/teams/teamCtl'
export { agentGuide } from './src/main/cli/agentGuide'
export { teamChannelText } from './src/shared/teamTools'
export * as C from './src/main/cli/cliEntry'
export { CTL_EXIT } from './src/shared/ctl-protocol'
export { redactCredentials } from './src/shared/redact'
export * from './src/shared/teams'
`)
const C = M.C

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-teams-cli-'))
const sockRoot = win ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'sn-'))
const rand = () => Math.random().toString(16).slice(2, 10)
const pipeName = () => (win ? `\\\\.\\pipe\\snaos-teams-test-${rand()}` : path.join(sockRoot, `t-${rand()}.sock`))

const RUN = 'r-0123456789ab'
const TEAM = 'tm-0123456789ab'
const TEAM_PANE = `team:${RUN}`

// ---- the fake port (TeamService's TeamCtlPort; B3-store builds the real one) ----------------------
function fakePort() {
  const port = {
    calls: [],
    live: null,
    readReply: null,
    applyReply: null,
    noteReply: undefined,
    setRun(o = {}) {
      const run = { id: RUN, agentId: o.agentId ?? o.roleKind ?? 'dev', roleId: o.roleKind ?? 'dev', roleKind: o.roleKind ?? 'dev', mode: o.mode ?? 'exec', state: o.state ?? 'running', ...(o.taskId === null ? {} : { taskId: o.taskId ?? 't-3' }), ...(o.concludedBy ? { concludedBy: o.concludedBy } : {}) }
      port.live = o.none ? null : { teamId: TEAM, run, agent: { id: run.agentId, roleKind: run.roleKind }, ...(run.taskId ? { task: { id: run.taskId, isolation: o.isolation ?? 'worktree' } } : {}), def: { def: {} } }
    },
    view: null,
  }
  port.impl = {
    live: (who) => {
      port.calls.push({ kind: 'live', who })
      return port.live
    },
    read: (teamId, method, params, who) => {
      port.calls.push({ kind: 'read', teamId, method, params, who })
      if (port.readReply) return port.readReply
      if (method === 'team.show') return { ok: true, data: SHOW }
      if (method === 'team.tasks') return { ok: true, data: { tasks: [SHOW.task, { id: 't-1', state: 'todo', phase: 'none', title: 'Escribir tests' }] } }
      return { ok: true, data: { task: DETAIL } }
    },
    apply: (teamId, call, who) => {
      port.calls.push({ kind: 'apply', teamId, call, who })
      if (typeof port.applyReply === 'function') return port.applyReply(call)
      if (port.applyReply) return port.applyReply
      return { ok: true, rt: {}, effects: [], result: RESULTS[call.method]?.(call.params) ?? {} }
    },
  }
  return port
}
const SHOW = {
  team: { id: TEAM, name: 'Equipo Login', goal: 'Un login nuevo\ncon dos factores' },
  you: { agentId: 'dev', roleId: 'dev', kind: 'dev' },
  run: { id: RUN, mode: 'exec', taskId: 't-3' },
  task: { id: 't-3', state: 'doing', phase: 'executing', title: 'Arreglar el login' },
}
const DETAIL = {
  id: 't-3', rev: 4, title: 'Arreglar el login', state: 'doing', phase: 'executing', priority: 'high', assignee: 'dev', body: 'El login falla con tildes.',
  plan: { rev: 1, text: 'Paso 1', status: 'approved', small: true, at: 1 },
  comments: [{ id: 'm-1', author: 'user', authorName: 'Vos', kind: 'comment', text: 'mirá el caso ñ', at: 1, queued: false }, { id: 'm-2', author: 'system', authorName: 'Sistema', kind: 'system', text: '', sys: { key: 'noQaRole' }, at: 2, queued: false }],
}
const RESULTS = {
  'team.task.create': () => ({ id: 't-9' }),
  'team.task.update': (p) => ({ id: p.task, rev: 5 }),
  'team.comment': () => ({ id: 'm-7' }),
  'team.ask': () => ({ cardId: 'k-1', concluded: 'ask' }),
  'team.needs': () => ({ cardId: 'k-2', concluded: 'needs' }),
  'team.plan': () => ({ approvalId: 'a-1', concluded: 'plan' }),
  'team.review': () => ({ concluded: 'review' }),
  'team.verdict': () => ({ concluded: 'verdict' }),
  'team.done': () => ({ approvalId: 'a-2', concluded: 'done' }),
  'team.approve': () => ({ concluded: 'approvePlan' }),
  'team.hire': () => ({ approvalId: 'a-3', concluded: 'hire' }),
}

// ---- the world: tokens, the real CtlServer and CtlHandlers, teamCtl on the fake port -------------------
async function world(o = {}) {
  const master = M.newToken()
  const tokens = new M.CtlTokens(master)
  const teamToken = tokens.issueTeam(RUN, { runId: RUN, teamId: TEAM, agentId: 'dev', roleKind: 'dev' })
  const consoleToken = tokens.issue('pty-p1', 'p1', 'w1')
  const port = fakePort()
  port.setRun()
  // teamCtl remembers the runs it saw conclude; every case here reuses RUN, so a case that starts a "new run" gets a new
  // view, and a minute passes (the budgets of section D are per run and minute).
  const clock = { t: 1_800_000_000_000 }
  const box = { view: M.createTeamCtl(port.impl) }
  const fresh = () => {
    box.view = M.createTeamCtl(port.impl)
    clock.t += 61_000
  }
  const bus = { ops: [], async request(op) { bus.ops.push(op); return { ok: true, data: { workspaces: [], statusLines: {} } } } }
  const pty = { submits: [], ptyIdForPane: () => null, async submitToPane() { pty.submits.push(1); return { ok: true } }, lastSubmitAt: () => undefined, lastOutputAt: () => undefined, tail: () => null }
  const h = new M.CtlHandlers({
    bus, pty, status: { stateOf: () => null, setNeeds: () => false }, config: () => null, notify: () => undefined, appVersion: '2.7.0', now: () => clock.t,
    services: () => (o.noTeams ? {} : { teams: box.view }),
  })
  const endpoint = pipeName()
  const server = new M.CtlServer({ kind: win ? 'named-pipe' : 'unix', endpoint }, (t) => tokens.resolve(t), h.handle)
  await server.start()
  const env = { SNAOS_CTL_ENDPOINT: endpoint, SNAOS_CTL_TOKEN: teamToken, SNAOS_TEAM_RUN: RUN }
  /** One CLI invocation through the pipe: exit code, stdout and stderr lines. */
  const run = async (argv, i = io(), e = env) => {
    const out = []
    const err = []
    const code = await C.run(argv, { io: i, env: e, out: (s) => out.push(s), err: (s) => err.push(s), appVersion: '2.7.0' })
    const last = out.at(-1)
    let json = null
    try { json = last ? JSON.parse(last) : null } catch { /* human output */ }
    return { code, out: out.join('\n'), err: err.join('\n'), json }
  }
  const raw = async (method, params = {}, token = teamToken) => rpcRaw(endpoint, { token, body: { v: 1, method, params } })
  /** The last call the port saw of a kind. */
  const last = (kind) => [...port.calls].reverse().find((c) => c.kind === kind)
  const applies = () => port.calls.filter((c) => c.kind === 'apply').length
  return { master, tokens, teamToken, consoleToken, port, fresh, clock, h, server, endpoint, env, run, raw, last, applies, bus, pty }
}

function rpcRaw(endpoint, { token, body }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request({ socketPath: endpoint, method: 'POST', path: '/v1/rpc', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json })
      })
    })
    req.on('error', reject)
    req.end(data)
  })
}

/** A client io whose files (by suffix) and stdin are raw bytes, the way nodeIo reads them. */
function io(files = {}, stdin = '') {
  const bytesOf = (v) => (Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8'))
  const find = (f) => {
    const k = Object.keys(files).find((x) => f.endsWith(x))
    if (!k) throw new Error('ENOENT')
    return bytesOf(files[k])
  }
  return {
    readFile: (f) => find(f).toString('utf8'),
    readFileBytes: (f) => find(f),
    readStdin: async () => bytesOf(stdin).toString('utf8'),
    readStdinBytes: async () => bytesOf(stdin),
    cwd: () => TMP,
  }
}
const utf16le = (s, bom = true) => Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(s, 'utf16le')])
const utf16be = (s) => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(s, 'utf16le').swap16()])

// ---- A. the client: parser, verbs, flags, splitting, caps ------------------------------------------
async function clientChecks() {
  const p = (argv) => C.parseArgs(argv)
  const usage = (argv) => { try { p(argv); return null } catch (e) { return e.message } }
  const b = (argv, i = io()) => C.buildCall(C.parseArgs(argv), i)
  const bad = async (argv, i) => { try { await b(argv, i); return null } catch (e) { return e.message } }
  check(/team needs one of: show, tasks, task/.test(usage(['team'])) && /unknown team command "frob"/.test(usage(['team', 'frob'])), 'snaos team alone and an unknown subcommand are usage errors')
  check(p(['team', 'task', 'get', 't-3']).sub === 'task' && p(['team', 'task', 'get', 't-3']).positionals.join(' ') === 'get t-3', 'one-level parser: task is the sub, its verb the next positional')
  check(/--options does not apply to team plan/.test(usage(['team', 'plan', '--options', 'a'])) && /--plan does not apply to team task/.test(usage(['team', 'task', 'get', 't-1', '--plan', 't-2'])), 'flags are checked per team subcommand')
  check(/team task needs one of: get, create, update/.test(await bad(['team', 'task'])) && /team task needs one of/.test(await bad(['team', 'task', 'delete', 't-1'])), 'team task needs a verb get|create|update')
  check(/--title does not apply to team task get/.test(await bad(['team', 'task', 'get', 't-1', '--title', 'x'])) && /--rev does not apply to team task create/.test(await bad(['team', 'task', 'create', '--title', 'x', '--rev', '2'])) && /--repo does not apply to team task update/.test(await bad(['team', 'task', 'update', 't-1', '--repo', 'main'])) && /--parent does not apply to team task update/.test(await bad(['team', 'task', 'update', 't-1', '--parent', 't-2'])), 'buildCall checks the flags of each task verb')
  check(/needs --title/.test(await bad(['team', 'task', 'create'])) && /takes the title in --title/.test(await bad(['team', 'task', 'create', 'Arreglar', 'login'])), 'team task create needs --title (not words)')
  check(/needs a field to change/.test(await bad(['team', 'task', 'update', 't-1'])) && /either --no-plan or --needs-plan/.test(await bad(['team', 'task', 'update', 't-1', '--no-plan', '--needs-plan'])), 'team task update needs a change; --no-plan and --needs-plan exclude each other')
  check(/team verdict needs approve or changes/.test(await bad(['team', 'verdict', 'maybe', 'x'])) && /team verdict needs a text/.test(await bad(['team', 'verdict', 'approve'])), 'team verdict checks its verb and needs a text')
  check(/team approve needs --plan/.test(await bad(['team', 'approve'])) && /team approve takes no argument/.test(await bad(['team', 'approve', 't-3'])), 'team approve takes the task in --plan')
  check(/team comment needs a target/.test(await bad(['team', 'comment', 'pepe', 'hola'])) && /team comment needs a text/.test(await bad(['team', 'comment', 't-3'])), 'team comment needs a target (t-N or lead) and a text')
  check(/--priority must be urgent, high, normal, low/.test(await bad(['team', 'task', 'create', '--title', 'x', '--priority', 'p1'])) && /--isolation must be worktree, main/.test(await bad(['team', 'task', 'create', '--title', 'x', '--isolation', 'tmp'])) && /--state must be todo, doing, review, done, blocked, cancelled, open/.test(await bad(['team', 'tasks', '--state', 'nope'])) && /--state must be todo, blocked, cancelled/.test(await bad(['team', 'task', 'update', 't-1', '--state', 'done'])), 'enums are checked in the client')
  check(/--assign must be an agent id/.test(await bad(['team', 'task', 'create', '--title', 'x', '--assign', 'Dev 2'])) && /--parent must be a task id/.test(await bad(['team', 'task', 'create', '--title', 'x', '--parent', '3'])) && /team task get takes one task/.test(await bad(['team', 'task', 'get'])), 'ids are checked in the client')

  // --blocked-by and --options splitting.
  const create = await b(['team', 'task', 'create', '--title', 'Login', '--blocked-by', ' t-1, t-2,,t-3 ,t-2'])
  check(JSON.stringify(create.params.blockedBy) === '["t-1","t-2","t-3"]', '--blocked-by splits on commas, trims, drops empty pieces and repeats', create.params)
  check(JSON.stringify(C.blockedByFlag('none')) === '[]' && C.blockedByFlag(undefined) === undefined, '--blocked-by none = []')
  check(/"t-x" is not a task id/.test(await bad(['team', 'task', 'create', '--title', 'x', '--blocked-by', 't-1,t-x'])), '--blocked-by refuses a malformed id')
  const upd = await b(['team', 'task', 'update', 't-3', '--blocked-by', 'none', '--assign', 'none', '--rev', '4', '--no-plan'])
  check(JSON.stringify(upd.params) === JSON.stringify({ task: 't-3', rev: 4, assign: null, blockedBy: [], needsPlan: false }), 'task update: --blocked-by none clears, --assign none unassigns, --rev is a number, --no-plan = needsPlan false', upd.params)
  const ask = await b(['team', 'ask', '¿Cuál', 'base?', '--options', 'A | B|| C', '--multi'])
  check(JSON.stringify(ask.params) === JSON.stringify({ text: '¿Cuál base?', options: ['A', 'B', 'C'], multi: true }), '--options splits on | (trimmed, empty pieces dropped)', ask.params)
  check(/1 to 6 answers/.test(await bad(['team', 'ask', 'q', '--options', 'a|b|c|d|e|f|g'])) && /longer than 120/.test(await bad(['team', 'ask', 'q', '--options', `a|${'x'.repeat(121)}`])) && /--multi needs --options/.test(await bad(['team', 'ask', 'q', '--multi'])) && /--confirm is a yes or no/.test(await bad(['team', 'ask', 'q', '--confirm', '--options', 'a|b'])), '--options: 6 answers of 120 at most; --multi needs them; --confirm excludes them')

  // Texts: --file -, --body-file -, files and stdin decoded the same way.
  const bomCrlf = Buffer.from('﻿# Plan\r\n\r\npaso 1\r\n\r\n', 'utf8')
  check((await b(['team', 'plan', '--file', '-', '--small'], io({}, bomCrlf))).params.text === '# Plan\r\n\r\npaso 1', '--file - strips the BOM and the trailing CR/LF (decision 4)')
  check((await b(['team', 'task', 'create', '--title', 'x', '--body-file', '-'], io({}, bomCrlf))).params.body === '# Plan\r\n\r\npaso 1', '--body-file - strips them too')
  check((await b(['team', 'comment', 't-3', '-'], io({}, '﻿hola\n'))).params.text === 'hola', 'a lone - positional reads stdin the same way')
  check((await b(['team', 'plan', '--file', 'plan.md'], io({ 'plan.md': '﻿desde archivo\r\n' }))).params.text === 'desde archivo', 'a --file path: BOM and trailing CR/LF stripped too')
  const ñ = 'Plan: ñandú, acción y 日本\r\nsegunda línea'
  check((await b(['team', 'plan', '--file', 'u16.md'], io({ 'u16.md': utf16le(`${ñ}\r\n`) }))).params.text === ñ, 'a UTF-16LE file with its BOM (PowerShell 5.1 Out-File) decodes')
  check((await b(['team', 'plan', '--file', '-'], io({}, utf16le(`${ñ}\r\n`)))).params.text === ñ, 'a UTF-16LE stdin with its BOM decodes')
  check((await b(['team', 'plan', '--file', 'be.md'], io({ 'be.md': utf16be(ñ) }))).params.text === ñ, 'a UTF-16BE file with its BOM decodes')
  check((await b(['team', 'needs', '--file', 'nobom.txt'], io({ 'nobom.txt': utf16le('logueate en npm\r\n', false) }))).params.text === 'logueate en npm', 'a BOM-less UTF-16LE text decodes (its NUL pattern)')
  check(C.decodeTeamText(Buffer.from('a\u0000b', 'utf8')) === 'a\u0000b', 'a lone NUL in UTF-8 is not mistaken for UTF-16')
  const latin1 = Buffer.from([0x50, 0x6c, 0xe1, 0x6e, 0x0d, 0x0a])
  const fffd = await bad(['team', 'plan', '--file', 'latin1.md'], io({ 'latin1.md': latin1 }))
  check(/U\+FFFD/.test(fffd) && fffd.includes('write the text to a UTF-8 file and pass --file <path>'), 'text with U+FFFD (a Latin-1 file) is refused with the hint', fffd)
  const fffdBody = await bad(['team', 'task', 'create', '--title', 'x', '--body-file', '-'], io({}, latin1))
  check(fffdBody.includes('pass --body-file <path>') && fffdBody.includes('stdin'), 'the hint names --body-file and stdin when that is where the text came from', fffdBody)
  check(/U\+FFFD/.test(await bad(['team', 'comment', 't-3', '--file', '-'], io({}, Buffer.from('ya hay � aca', 'utf8')))), 'a decoded U+FFFD in the text is refused too')
  const nul = await bad(['team', 'comment', 't-3', '--file', '-'], io({}, Buffer.from('a\u0000b', 'utf8')))
  check(/it has a NUL character/.test(nul) && !/U\+FFFD/.test(nul) && nul.includes('pass --file <path>'), 'a NUL in UTF-8 text is refused with the hint, named as a NUL', nul)
  check(/cannot read --file nope.md/.test(await bad(['team', 'plan', '--file', 'nope.md'])), 'a missing file is a usage error')
  check(/use either a text or --file/.test(await bad(['team', 'comment', 't-3', 'hola', '--file', 'x.md'], io({ 'x.md': 'y' }))), 'a text and --file together are a usage error')
  // The real nodeIo: raw bytes from disk.
  const real = path.join(TMP, 'real-u16.md')
  fs.writeFileSync(real, utf16le('desde disco ñ\r\n'))
  check((await C.buildCall(C.parseArgs(['team', 'plan', '--file', real]), C.nodeIo)).params.text === 'desde disco ñ', 'nodeIo reads the file bytes (a UTF-16LE file on disk decodes)')

  // Client caps (nothing is sent).
  check(/the plan is longer than 32768/.test(await bad(['team', 'plan', '--file', '-'], io({}, 'x'.repeat(M.TEAM_PLAN_MAX + 1)))), 'a plan over 32 KB is refused in the client')
  check(/the comment is longer than 8192/.test(await bad(['team', 'comment', 'lead', '-'], io({}, 'x'.repeat(M.COMMENT_TEXT_MAX + 1)))) && /the body is longer than 16384/.test(await bad(['team', 'task', 'create', '--title', 'x', '--body-file', '-'], io({}, 'x'.repeat(M.TASK_BODY_MAX + 1)))), 'comment 8 KB and body 16 KB caps in the client')
  check(/the role file is longer than 65536/.test(await bad(['team', 'hire', '--file', '-'], io({}, 'x'.repeat(M.HIRE_TEXT_MAX + 1)))) && /the note is longer/.test(await bad(['team', 'note', '-'], io({}, 'x'.repeat(M.COMMENT_TEXT_MAX + 1)))), 'hire 64 KB and note 8 KB caps in the client')
  const big = await bad(['team', 'hire', '--file', '-'], io({}, '\u0001'.repeat(M.HIRE_TEXT_MAX - 1) + 'x'))
  check(big === null, 'a 64 KB role file of control characters still fits once JSON-escaped (384 KB < 1 MB)', big)
  check(C.formatHuman('team.task.create', { id: 't-12' }) === 't-12 created' && C.formatHuman('team.plan', { approvalId: 'a-1', concluded: 'plan' }) === 'plan sent for approval (a-1); this run is concluded', 'human output: short English lines')
  const table = C.formatHuman('team.tasks', { tasks: [{ id: 't-12', state: 'doing', phase: 'executing', title: 'Arreglar login' }] })
  check(/^id +state +phase +title\nt-12 +doing +executing +Arreglar login$/.test(table) && C.formatHuman('team.tasks', { tasks: [] }) === 'no tasks', 'team tasks prints an id state phase title table', table)
}

// ---- B. teamCtl through the real server: params, roles, errors, budgets, concluded ---------------------
async function serverChecks() {
  const w = await world()
  try {
    const { run, port, raw, last } = w

    // Reads.
    const show = await run(['team', 'show', '--json'])
    check(show.code === 0 && JSON.stringify(show.json.data) === JSON.stringify(SHOW), 'team show --json: the port data, end to end', show)
    check(last('read').method === 'team.show' && last('read').teamId === TEAM && last('read').who.runId === RUN && last('live').who.agentId === 'dev', 'the read reaches the port with the team and the caller of the token')
    const human = await run(['team', 'show'])
    check(human.code === 0 && human.out === `team Equipo Login (${TEAM})\nyou: dev (dev), run ${RUN} (exec)\ntask: t-3     doing     executing     Arreglar el login\ngoal: Un login nuevo`, 'team show human output', human.out)
    const tasks = await run(['team', 'tasks', '--state', 'open', '--mine'])
    check(tasks.code === 0 && JSON.stringify(last('read').params) === JSON.stringify({ state: 'open', mine: true }) && tasks.out.split('\n').length === 3, 'team tasks --state open --mine', tasks.out)
    const get = await run(['team', 'task', 'get', 't-3'])
    check(get.code === 0 && last('read').method === 'team.task.get' && last('read').params.task === 't-3' && get.out.includes('--- comments') && get.out.includes('Vos (comment): mirá el caso ñ') && get.out.includes('[system note noQaRole]'), 'team task get: the port reads it (and marks delivered what its reply includes, 4.5); human output', get.out)

    // Every write method's params as the port gets them (roles set per call).
    const lead = () => port.setRun({ roleKind: 'lead', mode: 'lead', taskId: null })
    const cases = [
      { role: lead, argv: ['team', 'task', 'create', '--title', '  Arreglar   el login ', '--body-file', 'body.md', '--assign', 'dev-2', '--repo', 'main', '--isolation', 'main', '--blocked-by', 't-1,t-2', '--priority', 'high', '--no-plan'], files: { 'body.md': 'Cuerpo\r\n' },
        method: 'team.task.create', params: { title: 'Arreglar el login', body: 'Cuerpo', assign: 'dev-2', repo: 'main', isolation: 'main', blockedBy: ['t-1', 't-2'], priority: 'high', noPlan: true }, out: 't-9 created' },
      { role: lead, argv: ['team', 'task', 'update', 't-3', '--rev', '4', '--assign', 'none', '--blocked-by', 'none', '--state', 'blocked', '--needs-plan', '--priority', 'low', '--title', 'Nuevo'],
        method: 'team.task.update', params: { task: 't-3', rev: 4, title: 'Nuevo', assign: null, priority: 'low', blockedBy: [], state: 'blocked', needsPlan: true }, out: 't-3 updated (rev 5)' },
      { role: lead, argv: ['team', 'comment', 'lead', 'hola', 'equipo'], method: 'team.comment', params: { target: 'lead', text: 'hola equipo' }, out: 'comment m-7 added' },
      { role: () => port.setRun({ roleKind: 'qa', mode: 'qa' }), argv: ['team', 'ask', '¿Cuál', 'base?', '--options', 'main|dev', '--multi'], method: 'team.ask', params: { text: '¿Cuál base?', options: ['main', 'dev'], multi: true } },
      { role: () => port.setRun({ roleKind: 'research', mode: 'plan' }), argv: ['team', 'ask', 'Confirmás', 'que', 'borro', 'la', 'rama?', '--confirm'], method: 'team.ask', params: { text: 'Confirmás que borro la rama?', confirm: true } },
      { role: () => port.setRun(), argv: ['team', 'needs', 'logueate', 'en', 'npm'], method: 'team.needs', params: { text: 'logueate en npm' } },
      { role: () => port.setRun({ mode: 'plan' }), argv: ['team', 'plan', '--file', '-', '--small'], stdin: '﻿# Plan\r\n', method: 'team.plan', params: { text: '# Plan', small: true }, out: 'plan sent for approval (a-1); this run is concluded' },
      { role: () => port.setRun(), argv: ['team', 'review', 'listo,', 'commit', 'abc'], method: 'team.review', params: { text: 'listo, commit abc' } },
      { role: () => port.setRun(), argv: ['team', 'review'], method: 'team.review', params: {} },
      { role: () => port.setRun({ roleKind: 'qa', mode: 'qa' }), argv: ['team', 'verdict', 'changes', '--file', '-'], stdin: '1. falta el test\r\n', method: 'team.verdict', params: { verdict: 'changes', text: '1. falta el test' } },
      { role: () => port.setRun({ isolation: 'main' }), argv: ['team', 'done'], method: 'team.done', params: {} },
      { role: lead, argv: ['team', 'approve', '--plan', 't-3'], method: 'team.approve', params: { plan: 't-3' } },
      { role: lead, argv: ['team', 'hire', '--file', 'role.md'], files: { 'role.md': '---\nname: Docs\nkind: custom\n---\nEscribe docs.\n' }, method: 'team.hire', params: { text: '---\nname: Docs\nkind: custom\n---\nEscribe docs.' } },
    ]
    for (const c of cases) {
      c.role()
      w.fresh()
      const r = await run(c.argv, io(c.files ?? {}, c.stdin ?? ''))
      const a = last('apply')
      check(r.code === 0 && a.call.method === c.method && JSON.stringify(a.call.params) === JSON.stringify(c.params) && a.teamId === TEAM && a.who.runId === RUN, `${c.argv.slice(0, 3).join(' ')}: the port gets ${JSON.stringify(c.params)}`, { r, got: a.call })
      if (c.out) check(r.out === c.out, `${c.method} human output`, r.out)
    }

    // Server-side validation (raw requests, never through the client): nothing reaches the port.
    port.setRun({ roleKind: 'lead', mode: 'lead', taskId: null })
    w.fresh()
    const before = w.applies()
    const refused = [
      ['team.task.get', { task: 't-07x' }, /task must be a task id/],
      ['team.comment', { target: 't-1', text: 'x', caller: 'p1' }, /takes no param "caller"/],
      ['team.comment', { target: 'everyone', text: 'x' }, /target must be/],
      ['team.task.create', { title: '   ' }, /title is empty/],
      ['team.task.create', { title: 'x', blockedBy: ['t-1', 'nope'] }, /blockedBy must be a list of task ids/],
      ['team.task.create', { title: 'x', blockedBy: Array.from({ length: 17 }, (_, i) => `t-${i + 1}`) }, /16 tasks at most/],
      ['team.task.create', { title: 'x'.repeat(201) }, /longer than 200/],
      ['team.task.update', { task: 't-1' }, /needs a field to change/],
      ['team.task.update', { task: 't-1', rev: -1, title: 'x' }, /rev must be/],
      ['team.task.update', { task: 't-1', state: 'done' }, /state must be one of todo, blocked, cancelled/],
      ['team.ask', { text: 'q', multi: true }, /multi needs options/],
      ['team.ask', { text: 'q', options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }, /1 to 6 answers/],
      ['team.verdict', { verdict: 'maybe', text: 'x' }, /verdict must be one of approve, changes/],
      ['team.hire', { text: 'x'.repeat(M.HIRE_TEXT_MAX + 1) }, /longer than 65536/],
      ['team.approve', {}, /plan is required/],
    ]
    for (const [method, params, re] of refused) {
      const r = (await raw(method, params)).json
      check(r.ok === false && r.error.code === 'bad_request' && re.test(r.error.message), `${method} ${JSON.stringify(params).slice(0, 60)}: bad_request from teamCtl`, r)
    }
    check(w.applies() === before, 'a refused param never reaches the store')

    // Redaction: a credential in a text never reaches the store as is (it could reach a notice).
    const token = `ghp_${'A1b2C3d4'.repeat(5)}`
    port.setRun()
    w.fresh()
    await run(['team', 'comment', 't-3', '-'], io({}, `usá ${token} para el push\n`))
    check(last('apply').call.params.text === M.redactCredentials(`usá ${token} para el push`) && !last('apply').call.params.text.includes(token), 'texts are redacted before the store', last('apply').call.params)
    port.setRun({ roleKind: 'qa', mode: 'qa' })
    w.fresh()
    await raw('team.ask', { text: `clave ${token}`, options: [`usar ${token}`, 'otra'] })
    check(!JSON.stringify(last('apply').call.params).includes(token), 'ask: the question and its options are redacted too')

    // Roles and modes (allowedFor, 5.3), exit 7 forbidden, nothing applied.
    const roleCase = async (setup, argv, ok, re, files) => {
      setup()
      w.fresh()
      const n = w.applies()
      const r = await run(argv, io(files ?? {}))
      if (ok) check(r.code === 0 && w.applies() === n + 1, `${JSON.stringify(argv)} allowed`, r)
      else check(r.code === 7 && w.applies() === n && (!re || re.test(r.err)), `${JSON.stringify(argv)} forbidden`, r)
    }
    const dev = () => port.setRun({ roleKind: 'dev', mode: 'exec', taskId: 't-3' })
    await roleCase(dev, ['team', 'plan', 'x'], false, /works only in plan runs; this run is in exec mode/)
    await roleCase(dev, ['team', 'verdict', 'approve', 'ok'], false, /not a tool of the dev role/)
    await roleCase(dev, ['team', 'task', 'update', 't-3', '--title', 'x'], false, /not a tool of the dev role/)
    await roleCase(dev, ['team', 'note', 'x'], false, /not a tool of the dev role/)
    await roleCase(dev, ['team', 'approve', '--plan', 't-3'], false)
    await roleCase(dev, ['team', 'hire', 'x'], false)
    await roleCase(dev, ['team', 'done'], false, /with snaos team review, not done/)
    await roleCase(dev, ['team', 'review'], true)
    // A dev creates only a subtask of the task it runs (5.3, 10: dev create only with --parent = its task).
    await roleCase(dev, ['team', 'task', 'create', '--title', 'Sub'], false, /--parent t-3/)
    await roleCase(dev, ['team', 'task', 'create', '--title', 'Sub', '--parent', 't-4'], false, /only subtasks of its own task/)
    await roleCase(dev, ['team', 'task', 'create', '--title', 'Sub', '--parent', 't-3'], true)
    await roleCase(() => port.setRun({ roleKind: 'dev', mode: 'plan' }), ['team', 'task', 'create', '--title', 'Sub', '--parent', 't-3'], false, /in an exec run/)
    await roleCase(() => port.setRun({ roleKind: 'dev', mode: 'plan' }), ['team', 'review'], false, /works only in exec runs; this run is in plan mode/)
    await roleCase(() => port.setRun({ roleKind: 'dev', mode: 'plan' }), ['team', 'plan', 'paso 1'], true)
    await roleCase(() => port.setRun({ roleKind: 'dev', mode: 'exec', isolation: 'main' }), ['team', 'done', 'listo'], true)
    await roleCase(() => port.setRun({ roleKind: 'custom', mode: 'exec' }), ['team', 'task', 'create', '--title', 'Sub', '--parent', 't-3'], true)
    await roleCase(() => port.setRun({ roleKind: 'custom', mode: 'exec' }), ['team', 'done'], true)
    await roleCase(() => port.setRun({ roleKind: 'research', mode: 'plan' }), ['team', 'done', 'informe'], true)
    await roleCase(() => port.setRun({ roleKind: 'research', mode: 'plan' }), ['team', 'review'], false, /not a tool of the research role/)
    await roleCase(() => port.setRun({ roleKind: 'qa', mode: 'qa' }), ['team', 'plan', 'x'], false, /not a tool of the qa role/)
    await roleCase(() => port.setRun({ roleKind: 'qa', mode: 'qa' }), ['team', 'comment', 't-3', 'mirá'], true)
    await roleCase(lead, ['team', 'task', 'create', '--title', 'Sin padre', '--blocked-by', 't-1'], true)
    await roleCase(lead, ['team', 'review'], false, /not a tool of the lead role/)
    await roleCase(lead, ['team', 'plan', 'x'], false, /not a tool of the lead role/)
    await roleCase(() => port.setRun({ roleKind: 'lead', mode: 'free', taskId: null }), ['team', 'task', 'create', '--title', 'x'], false, /the Lead creates tasks in its lead runs only; this run is in free mode/)

    // team note until B7: no port.note -> disabled (exit 7); with one, its answer passes.
    lead()
    w.fresh()
    const note = await run(['team', 'note', 'resumen', '--json'])
    check(note.code === 7 && note.json.error.code === 'disabled' && /team note is not available in this build/.test(note.json.error.message), 'team note answers disabled while the port has no note (B7)', note)
    port.impl.note = async (teamId, text, title, who) => { port.calls.push({ kind: 'note', teamId, text, title, who }); return { ok: true, data: { id: 'n-1' } } }
    const noted = await run(['team', 'note', '--title', 'Resumen', 'hoy', 'avanzamos'])
    check(noted.code === 0 && noted.out === 'note n-1 saved' && last('note').text === 'hoy avanzamos' && last('note').title === 'Resumen', 'with a note port, team note goes to it')
    port.impl.note = async () => ({ ok: false, error: 'unsupported' })
    check((await run(['team', 'note', 'x'])).code === 7, "a port note answering a bare TeamError word is mapped (unsupported -> disabled)")
    delete port.impl.note

    // Terminal tools in B3: the store answers unsupported until B5 -> disabled, exit 7.
    port.setRun({ mode: 'plan' })
    w.fresh()
    port.applyReply = { ok: false, error: 'unsupported' }
    const plan = await run(['team', 'plan', 'paso 1', '--json'])
    check(plan.code === 7 && plan.json.error.code === 'disabled' && plan.json.error.message === 'snaos team plan is not available in this build', 'a terminal tool the store does not have yet: disabled "not available in this build" (exit 7)', plan.json)
    port.applyReply = null
    port.setRun({ mode: 'plan' })
    const after = await run(['team', 'comment', 't-3', 'sigo', '--json'])
    check(after.code === 0 && after.json.ok, 'a refused terminal concludes nothing: a later write still applies', after)

    // Concluded after a terminal (decision 35): later writes conflict (exit 8), reads go on.
    port.setRun({ isolation: 'main' })
    w.fresh()
    w.port.calls.length = 0
    const done = await run(['team', 'done', 'listo'])
    check(done.code === 0 && done.out === 'reported done (a-2); this run is concluded', 'team done concludes the run', done)
    const late = await run(['team', 'comment', 't-3', 'una', 'cosa', 'mas', '--json'])
    check(late.code === 8 && late.json.error.code === 'conflict' && late.json.error.message === 'this run already concluded with team done' && late.json.data.reason === 'concluded' && w.applies() === 1, 'a write after the terminal: conflict concluded, exit 8, never applied', late.json)
    check((await run(['team', 'task', 'get', 't-3'])).code === 0 && (await run(['team', 'show'])).code === 0, 'a concluded run keeps its reads')
    // The store's own record (run.concludedBy) counts the same, worded by the tool (approvePlan -> approve).
    port.setRun({ roleKind: 'lead', mode: 'lead', taskId: null, concludedBy: { tool: 'approvePlan', at: 1 } })
    const lateLead = await run(['team', 'task', 'create', '--title', 'x', '--json'])
    check(lateLead.code === 8 && lateLead.json.error.message === 'this run already concluded with team approve', 'run.concludedBy from the store: conflict concluded worded by the tool', lateLead.json)

    // Liveness: no live run, another run of the agent, a stopping run.
    port.setRun({ none: true })
    const gone = await run(['team', 'show', '--json'])
    check(gone.code === 7 && gone.json.error.code === 'forbidden' && /not active any more/.test(gone.json.error.message), 'no live run behind the token: forbidden', gone.json)
    port.setRun()
    port.live.run.id = 'r-ffffffffffff'
    check((await run(['team', 'show'])).code === 7, 'a live run of the agent that is not the token run: forbidden')
    // Teams off (Labs, a frozen or disposed service): disabled with the Labs wording, before any param or role check.
    port.live = 'disabled'
    const off = await run(['team', 'show', '--json'])
    check(off.code === 7 && off.json.error.code === 'disabled' && off.json.error.message === 'Teams is off (Settings > Labs): end your turn', 'the port says Teams is off: disabled (exit 7), never forbidden', off.json)
    const applied = w.applies()
    const offBad = (await raw('team.task.update', { task: 'nope' })).json
    const offWrite = (await raw('team.comment', { target: 't-3', text: 'x' })).json
    check(offBad.error.code === 'disabled' && offWrite.error.code === 'disabled' && w.applies() === applied, 'Labs off wins over a bad param and never reaches the store', { offBad, offWrite })
    port.setRun({ state: 'stopping' })
    const stopping = await run(['team', 'comment', 't-3', 'x', '--json'])
    check(stopping.code === 7 && stopping.json.error.code === 'busy' && /stopping/.test(stopping.json.error.message) && (await run(['team', 'show'])).code === 0, 'a stopping run: writes busy (exit 7), reads still answer', stopping.json)
  } finally {
    await w.server.stop()
  }
}

// ---- C. the 5.1 error mapping table, row by row, through the server ------------------------------
async function mappingChecks() {
  const w = await world()
  try {
    const { run, port } = w
    const rows = [
      // [store error and extras, argv, role, ctl code, exit, message]
      [{ error: 'bad_request', detail: 'assign names the lead' }, ['team', 'task', 'create', '--title', 'x', '--assign', 'lead'], 'lead', 'bad_request', 2, /assign names the lead/],
      [{ error: 'bad_request' }, ['team', 'comment', 't-3', 'x'], 'dev', 'bad_request', 2, /team comment: the team refused these params/],
      [{ error: 'cycle', current: ['t-5', 't-1', 't-5'] }, ['team', 'task', 'update', 't-5', '--blocked-by', 't-1'], 'lead', 'bad_request', 2, /loop of blockers: t-5 -> t-1 -> t-5/],
      [{ error: 'cycle' }, ['team', 'task', 'update', 't-5', '--blocked-by', 't-1'], 'lead', 'bad_request', 2, /--blocked-by t-1 makes a loop of blockers/],
      [{ error: 'too_big' }, ['team', 'comment', 't-3', 'x'], 'dev', 'bad_request', 2, /too long/],
      [{ error: 'not_found' }, ['team', 'comment', 't-99', 'x'], 'dev', 'not_found', 3, /^t-99 not found$/],
      [{ error: 'not_found' }, ['team', 'task', 'create', '--title', 'x', '--assign', 'qa-3', '--blocked-by', 't-1'], 'lead', 'not_found', 3, /one of qa-3, t-1/],
      [{ error: 'forbidden', detail: 'only your own task' }, ['team', 'comment', 't-3', 'x'], 'dev', 'forbidden', 7, /only your own task/],
      [{ error: 'untrusted' }, ['team', 'comment', 't-3', 'x'], 'dev', 'forbidden', 7, /^the team definition changed; wait for the user$/],
      [{ error: 'disabled' }, ['team', 'comment', 't-3', 'x'], 'dev', 'disabled', 7, /not available in this build/],
      [{ error: 'unsupported' }, ['team', 'comment', 't-3', 'x'], 'dev', 'disabled', 7, /^snaos team comment is not available in this build$/],
      [{ error: 'busy' }, ['team', 'comment', 't-3', 'x'], 'dev', 'busy', 7, /try again later/],
      [{ error: 'running' }, ['team', 'task', 'update', 't-4', '--state', 'cancelled'], 'lead', 'busy', 7, /t-4 has an active run/],
      [{ error: 'stopping' }, ['team', 'comment', 't-3', 'x'], 'dev', 'busy', 7, /stopping/],
      [{ error: 'cap' }, ['team', 'task', 'create', '--title', 'x'], 'lead', 'busy', 7, /the board is full \(2000 live tasks\): this call cannot succeed as is/],
      // What is full decides the hint: state.json past TEAM_STATE_MAX_BYTES is never "the board is full".
      [{ error: 'cap', full: 'state' }, ['team', 'task', 'create', '--title', 'x'], 'lead', 'busy', 7, /^the team state is full \(8 MB\): archive or cancel old tasks; this call cannot succeed as is$/],
      [{ error: 'cap', full: 'state' }, ['team', 'comment', 't-3', 'x'], 'dev', 'busy', 7, /^the team state is full \(8 MB\)/],
      [{ error: 'cap' }, ['team', 'comment', 't-3', 'x'], 'dev', 'busy', 7, /^t-3 has no room for more comments \(too many wait to be read\): this call cannot succeed as is$/],
      [{ error: 'cap' }, ['team', 'comment', 'lead', 'x'], 'dev', 'busy', 7, /^the Lead thread has no room for more comments/],
      [{ error: 'deferred', defer: { reason: 'quota' } }, ['team', 'comment', 't-3', 'x'], 'dev', 'busy', 7, /deferred \(quota\)/],
      [{ error: 'rate' }, ['team', 'comment', 't-3', 'x'], 'dev', 'rate_limited', 7, /120 reads and 60 writes a minute/],
      [{ error: 'conflict', reason: 'rev', current: { rev: 5 } }, ['team', 'task', 'update', 't-3', '--rev', '2', '--title', 'x'], 'lead', 'conflict', 8, /t-3 changed since --rev 2 \(now rev 5\): read it again with snaos team task get t-3/],
      [{ error: 'conflict', reason: 'concluded' }, ['team', 'comment', 't-3', 'x'], 'dev', 'conflict', 8, /this run already concluded/],
      [{ error: 'conflict', reason: 'newer_comment_not_delivered' }, ['team', 'comment', 't-3', 'x'], 'dev', 'conflict', 8, /a newer comment for you is waiting: read it with snaos team task get t-3 first/],
      [{ error: 'user_owned', fields: ['priority', 'assignee'] }, ['team', 'task', 'update', 't-3', '--priority', 'low', '--assign', 'dev-2'], 'lead', 'user_owned', 8, /the user set priority, assignee of t-3: those fields stay theirs/],
      // The state through a side effect: --blocked-by would move a task the user placed (the agent never sent --state).
      [{ error: 'user_owned', fields: ['state'] }, ['team', 'task', 'update', 't-3', '--blocked-by', 't-1'], 'lead', 'user_owned', 8, /^the user set the state of t-3 and --blocked-by would move it: the whole update was refused, leave --blocked-by out$/],
      [{ error: 'user_owned', fields: ['state'] }, ['team', 'task', 'update', 't-3', '--state', 'todo'], 'lead', 'user_owned', 8, /^the user set state of t-3: those fields stay theirs, leave them out$/],
      [{ error: 'io' }, ['team', 'comment', 't-3', 'x'], 'dev', 'internal', 1, /could not apply/],
      [{ error: 'no_session' }, ['team', 'comment', 't-3', 'x'], 'dev', 'internal', 1, /could not apply/],
    ]
    for (const [f, argv, role, code, exit, re] of rows) {
      port.setRun(role === 'lead' ? { roleKind: 'lead', mode: 'lead', taskId: null } : {})
      w.fresh()
      port.applyReply = { ok: false, ...f }
      const r = await run([...argv, '--json'])
      check(r.code === exit && r.json?.ok === false && r.json.error.code === code && re.test(r.json.error.message) && r.json.data.error === f.error, `5.1: ${f.error}${f.reason ? ` ${f.reason}` : ''} -> ${code} (exit ${exit})`, r.json)
      check(exit === M.CTL_EXIT[code], `5.1: the exit of ${code} is CTL_EXIT's`)
    }
    const owned = rows.find((r) => r[0].error === 'user_owned')
    port.setRun({ roleKind: 'lead', mode: 'lead', taskId: null })
    port.applyReply = { ok: false, ...owned[0] }
    const ownedRes = await run([...owned[1], '--json'])
    check(JSON.stringify(ownedRes.json.data.fields) === '["priority","assignee"]', 'user_owned carries its fields in data')
    const human = await run(owned[1])
    check(human.code === 8 && /^snaos: the user set priority, assignee of t-3/.test(human.err), 'user_owned human output on stderr, exit 8', human.err)
    port.applyReply = null
    // A read error the port answers with a bare TeamError word is mapped the same way.
    port.setRun()
    port.readReply = { ok: false, error: 'not_found' }
    const nf = await run(['team', 'task', 'get', 't-99', '--json'])
    check(nf.code === 3 && nf.json.error.code === 'not_found' && nf.json.error.message === 't-99 not found', 'a read error word from the port (not_found) maps to not_found, exit 3', nf.json)
    port.readReply = { ok: false, error: { code: 'not_found', message: 'no task t-99 on this board' } }
    const passed = await run(['team', 'task', 'get', 't-99', '--json'])
    check(passed.code === 3 && passed.json.error.message === 'no task t-99 on this board', 'a ctl error from the port passes as is')
    port.readReply = null
    const direct = M.teamCtlError({ error: 'whatever' }, { method: 'team.comment' })
    check(direct.error.code === 'internal' && M.teamCtlError({ error: 'cap' }, { method: 'team.task.create' }).error.code === 'busy', 'teamCtlError: unmapped -> internal; cap -> busy (not retryable as is, never exit 2)')
  } finally {
    await w.server.stop()
  }
}

// ---- D. budgets, forgetCaller, revoked token, gate, no service ----------------------------------------
async function budgetChecks() {
  const w = await world()
  try {
    const { raw, port, clock, h, tokens, run } = w
    port.setRun()
    let reads = 0
    for (let i = 0; i < M.TEAM_READS_PER_MIN; i++) if ((await raw('team.show')).json.ok) reads++
    const r121 = (await raw('team.tasks')).json
    check(reads === 120 && r121.error.code === 'rate_limited' && /120 team reads and 60 team writes per minute/.test(r121.error.message), 'the 121st read of the run in a minute: rate_limited', r121)
    let writes = 0
    for (let i = 0; i < M.TEAM_WRITES_PER_MIN; i++) if ((await raw('team.comment', { target: 't-3', text: `c${i}` })).json.ok) writes++
    const w61 = await run(['team', 'comment', 't-3', 'otra', '--json'])
    check(writes === 60 && w61.code === 7 && w61.json.error.code === 'rate_limited', 'reads and writes have their own budgets: 60 writes pass after 120 reads, the 61st is rate_limited (exit 7)', { writes, w61 })
    clock.t += 60_001
    check((await raw('team.show')).json.ok && (await raw('team.comment', { target: 't-3', text: 'x' })).json.ok, 'a minute later both budgets are back')
    for (let i = 0; i < 119; i++) await raw('team.show')
    check((await raw('team.show')).json.error.code === 'rate_limited', 'reads spent again')
    // CliService.revokeTeam = tokens.revokeTeam + handlers.forgetCaller (B2): the windows of that run go.
    tokens.revokeTeam(RUN)
    h.forgetCaller(TEAM_PANE)
    const again = tokens.issueTeam(RUN, { runId: RUN, teamId: TEAM, agentId: 'dev', roleKind: 'dev' })
    check((await raw('team.show', {}, again)).json.ok, 'forgetCaller at revoke: the run key starts with a fresh budget')
    // A revoked token: 401, exit 6, the message names the team run (never "this console's token").
    tokens.revokeTeam(RUN)
    const lost = await run(['team', 'show'], io(), { ...w.env, SNAOS_CTL_TOKEN: again })
    check(lost.code === 6 && lost.err.includes(`team run ${RUN}`) && /end your turn/.test(lost.err) && !/console/.test(lost.err), 'a revoked team token: 401 naming the team run, exit 6', lost.err)
    const lostJson = await run(['team', 'show', '--json'], io(), { ...w.env, SNAOS_CTL_TOKEN: again })
    check(lostJson.code === 6 && lostJson.json.error.code === 'unauthorized', 'a revoked team token --json: unauthorized')
    // The gate (B2) still stands in front of teamCtl.
    const fromConsole = (await raw('team.show', {}, w.consoleToken)).json
    const fromMaster = (await raw('team.comment', { target: 't-3', text: 'x' }, w.master)).json
    check(fromConsole.error.code === 'forbidden' && fromMaster.error.code === 'forbidden', 'a console token and the master token still get forbidden for team.*')
    const t2 = tokens.issueTeam(RUN, { runId: RUN, teamId: TEAM, agentId: 'dev', roleKind: 'dev' })
    const send = (await raw('send', { console: '1', text: 'x', enter: true }, t2)).json
    check(send.error.code === 'forbidden' && w.pty.submits.length === 0 && w.bus.ops.length === 0, 'a team token still cannot send to a console')
  } finally {
    await w.server.stop()
  }
  const n = await world({ noTeams: true })
  try {
    const r = await n.run(['team', 'show', '--json'])
    check(r.code === 7 && r.json.error.code === 'disabled' && /snaos team is not available/.test(r.json.error.message), 'no teams service attached: disabled (exit 7)', r.json)
  } finally {
    await n.server.stop()
  }
}

// ---- D2. the guide: Claude calls snaos team with its Bash tool (E10 SPIKE, deviation of decision 2) ----------
function guideChecks() {
  const guide = M.agentGuide('2.7.0')
  const teams = guide.slice(guide.indexOf('## Teams (snaos team)'), guide.indexOf('## Exit codes'))
  check(teams.includes(M.teamChannelText(false, { win32: false, provider: 'claude' })) && teams.includes('with your Bash tool') && teams.includes('never with the PowerShell tool'), 'guide: the Claude channel, the Bash tool and never the PowerShell tool', teams)
  check(/runs `snaos team` with its Bash tool \(Git Bash on Windows\), never with the PowerShell\s+tool nor through `\$env:SNAOS_CLI`/.test(teams) && /allow `Bash\(snaos team:\*\)` only/.test(teams) && !teams.includes('PowerShell(snaos team'), 'guide: why (snaos.cmd and cmd.exe), Bash(snaos team:*) only, no PowerShell rule', teams)
}

// ---- E. the fake agent's `cli` step: the real cli.js with the run env ---------------------------------
async function fakeAgentChecks() {
  const cliJs = path.join(TMP, 'cli.js')
  buildSync({ entryPoints: [path.join(root, 'src/main/cli/cliEntry.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: cliJs, external: EXTERNAL, alias: ALIAS, logLevel: 'silent' })
  const w = await world()
  try {
    w.port.setRun()
    const scenario = path.join(TMP, 'cli-scenario.json')
    fs.writeFileSync(scenario, JSON.stringify({ steps: [
      { cli: ['team', 'show', '--json'], bin: cliJs },
      { cli: ['team', 'comment', 't-3', '-', '--json'], bin: cliJs, stdin: '﻿hola desde el agente ñ\r\n' },
      { cli: ['ls', '--json'], bin: cliJs },
    ] }))
    // Never the SNAOS_* of the console running this suite: only the run env.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^SNAOS_/i.test(k) && k.toUpperCase() !== 'ELECTRON_RUN_AS_NODE'))
    Object.assign(env, w.env)
    const res = await new Promise((resolve, reject) => {
      const child = cp.spawn(process.execPath, [FAKE, scenario], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      const out = []
      const err = []
      child.stdout.on('data', (c) => out.push(c))
      child.stderr.on('data', (c) => err.push(c))
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8') }))
      child.stdin.end('el prompt del run')
    })
    const lines = res.out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((o) => o.type === 'fake.cli')
    check(res.code === 0 && lines.length === 3, 'the fake agent ran its three cli steps', res)
    const show = JSON.parse(lines[0].stdout.trim())
    check(lines[0].code === 0 && show.ok && JSON.stringify(show.data) === JSON.stringify(SHOW) && w.last('read').who.runId === RUN, 'fake agent: snaos team show --json with the run env, through the real cli.js and pipe', lines[0])
    check(lines[1].code === 0 && w.last('apply').call.params.text === 'hola desde el agente ñ', 'fake agent: a comment on stdin (BOM and CRLF stripped) reaches the store', { line: lines[1], got: w.last('apply')?.call })
    check(lines[2].code === 7 && /may only use snaos team, ping and usage/.test(lines[2].stdout), 'fake agent: snaos ls from the run answers forbidden (exit 7)', lines[2])
  } finally {
    await w.server.stop()
  }
}

// ---- F. the real TeamService behind teamCtl: a Lead run that plans through snaos team ----------------
const electronStub = { app: { getPath: (name) => (name === 'userData' ? path.join(TMP, 'ud') : TMP), isPackaged: false, commandLine: { hasSwitch: () => false } } }
function loadService() {
  const code = buildSync({ stdin: { contents: `
export { TeamService } from './src/main/teams/TeamService'
export { TeamDefinitionLoader } from './src/main/teams/TeamDefinitionLoader'
export { createGitRunner, gitEnv } from './src/main/git/gitExec'
export { pidAlive, signalTree, treeKillSync } from './src/main/proc/treeKill'
`, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, external: EXTERNAL, alias: ALIAS, logLevel: 'silent' }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require: (id) => (id === 'electron' ? electronStub : require(id)), console, process, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, queueMicrotask, structuredClone, TextEncoder, TextDecoder })
  return mod.exports
}

async function serviceChecks() {
  const S = loadService()
  const dir = path.join(TMP, 'svc')
  const repo = path.join(dir, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  const gitCfg = path.join(dir, 'gitconfig')
  fs.writeFileSync(gitCfg, '[core]\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n')
  const gitEnvVars = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitCfg }
  for (const k of Object.keys(gitEnvVars)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE)$/i.test(k)) delete gitEnvVars[k]
  const git = (...args) => cp.execFileSync('git', args, { cwd: repo, env: gitEnvVars, stdio: ['ignore', 'pipe', 'pipe'] })
  fs.writeFileSync(path.join(repo, 'README.md'), '# r\n')
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-qm', 'init')
  const cliJs = path.join(TMP, 'cli.js')
  if (!fs.existsSync(cliJs)) buildSync({ entryPoints: [path.join(root, 'src/main/cli/cliEntry.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: cliJs, external: EXTERNAL, alias: ALIAS, logLevel: 'silent' })

  // The CLI side for real: tokens, handlers and the server; the service issues a team token per run.
  const tokens = new M.CtlTokens(M.newToken())
  let svc = null
  const h = new M.CtlHandlers({ bus: { request: async () => ({ ok: false, error: 'desktop_unavailable' }) }, pty: { ptyIdForPane: () => null, submitToPane: async () => ({ ok: true }), lastSubmitAt: () => undefined, lastOutputAt: () => undefined, tail: () => null }, status: { stateOf: () => null, setNeeds: () => false }, config: () => null, notify: () => undefined, appVersion: '2.7.0', services: () => (svc ? { teams: svc.ctlView } : {}) })
  const endpoint = pipeName()
  const server = new M.CtlServer({ kind: win ? 'named-pipe' : 'unix', endpoint }, (t) => tokens.resolve(t), h.handle)
  await server.start()
  const shim = path.join(dir, 'bin', win ? 'snaos.cmd' : 'snaos')
  fs.mkdirSync(path.dirname(shim), { recursive: true })
  fs.writeFileSync(shim, '')
  const cfg = { settings: { labs: { teams: true, consoleChat: false }, language: 'es', worktreesRoot: '' }, workspaces: [] }
  let scenario = ''
  const use = (steps) => {
    scenario = path.join(dir, `scenario-${rand()}.json`)
    fs.writeFileSync(scenario, JSON.stringify({ steps }))
  }
  const logs = []
  svc = new S.TeamService({
    dataDir: () => path.join(dir, 'data'),
    config: () => cfg,
    git: S.createGitRunner({ env: () => S.gitEnv(gitEnvVars) }),
    emit: () => undefined,
    openPath: async () => '',
    log: (l) => logs.push(l),
    loader: new S.TeamDefinitionLoader({ watch: () => ({ on() { return this }, close() {} }) }),
    strict: true,
    status: { snapshot: () => [], stateOf: () => null, paneForSession: () => null },
    sessionHolder: () => null,
    accounts: () => null,
    cli: {
      envForTeam: (runId, teamId, agentId, roleKind) => ({ SNAOS_CTL_ENDPOINT: endpoint, SNAOS_CTL_TOKEN: tokens.issueTeam(runId, { runId, teamId, agentId, roleKind }), SNAOS_CLI: shim, SNAOS_TEAM_RUN: runId }),
      revokeTeam: (runId) => { tokens.revokeTeam(runId); h.forgetCaller(`team:${runId}`) },
      ready: () => true,
    },
    awake: () => undefined,
    sendRun: () => undefined,
    resolveCli: () => ({ file: process.execPath, args: [FAKE, scenario], kind: 'exe' }),
    procStartTime: async () => null,
    treeKill: { sync: (pid) => S.treeKillSync(pid), signal: (pid, sig) => S.signalTree(pid, sig), alive: (pid) => S.pidAlive(pid) },
    platform: process.platform,
  })
  try {
    await svc.start(cfg)
    const probe = await svc.request({ op: 'setupProbe', dir: repo }, 'desktop')
    const draft = { ...probe.probe.defaults, goal: 'Una app de notas', verify: '' }
    const prev = await svc.request({ op: 'setupPreview', repoRoot: repo, draft }, 'desktop')
    const wr = await svc.request({ op: 'setupWrite', repoRoot: repo, draft, previewHash: prev.preview.hash }, 'desktop')
    check(wr.ok, 'a trusted team on a temp repo', wr)
    const teamId = wr.teamId
    const rt = () => svc.team(teamId).store.rt
    const ended = (id) => svc.team(teamId).store.recentRuns().find((r) => r.id === id)
    const until = async (fn, label) => {
      const end = Date.now() + 20000
      while (!fn()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
        await new Promise((r) => setTimeout(r, 20))
      }
    }
    const runOf = async (agentId, steps, prompt) => {
      use([...steps.map((cli) => (Array.isArray(cli) ? { cli: [...cli, '--json'], bin: cliJs } : cli)), { fixture: 'claude-simple.jsonl', rewriteSession: true }])
      const r = await svc.request({ op: 'runNow', teamId, agentId, ...(prompt ? { prompt } : {}) }, 'desktop')
      check(r.ok, `runNow ${agentId}`, r)
      await until(() => !!ended(r.runId), `run ${r.runId} ended`)
      const file = path.join(dir, 'data', 'teams', teamId, 'runs', `${r.runId}.jsonl`)
      const cli = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter((o) => o && o.type === 'fake.cli').map((o) => ({ code: o.code, res: (() => { try { return JSON.parse(o.stdout.trim()) } catch { return o.stdout } })() }))
      return { runId: r.runId, cli }
    }

    // The Lead plans the board through snaos team (B3 acceptance): tasks with blockers, live in the store.
    const lead = await runOf('lead', [
      ['team', 'task', 'create', '--title', 'Base de datos', '--assign', 'dev'],
      ['team', 'task', 'create', '--title', 'API de notas', '--assign', 'dev-2', '--blocked-by', 't-1', '--priority', 'high'],
      ['team', 'show'],
      ['team', 'tasks'],
    ], 'Armá el tablero')
    check(lead.cli.length === 4 && lead.cli.every((c) => c.code === 0), 'the Lead run: four snaos team calls through the real cli.js answer ok', lead.cli)
    check(lead.cli[0].res.data.id === 't-1' && lead.cli[1].res.data.id === 't-2', 'team task create answers the new ids')
    check(lead.cli[2].res.data.you.agentId === 'lead' && lead.cli[2].res.data.run.id === lead.runId && lead.cli[2].res.data.team.id === teamId, 'team show names the Lead, its run and its team')
    check(lead.cli[3].res.data.tasks.map((t) => t.id).sort().join(',') === 't-1,t-2', 'team tasks lists both')
    const t1 = rt().tasks.find((t) => t.id === 't-1')
    const t2 = rt().tasks.find((t) => t.id === 't-2')
    check(t1.state === 'todo' && t1.assignee === 'dev' && t1.createdBy.kind === 'agent' && t1.createdBy.agentId === 'lead', 't-1 todo, assigned to dev, created by the Lead')
    check(t2.state === 'blocked' && t2.blocked?.reason?.kind === 'deps' && JSON.stringify(t2.blockedBy) === '["t-1"]' && t2.priority === 'high', 't-2 blocked by t-1 (deps), high priority')
    check(ended(lead.runId).state === 'succeeded', 'the Lead run succeeded')

    // A user reprioritization survives the Lead's next update (user_owned, exit 8).
    const up = await svc.request({ op: 'updateTask', teamId, taskId: 't-2', baseRev: t2.rev, patch: { priority: 'urgent' } }, 'desktop')
    check(up.ok && rt().tasks.find((t) => t.id === 't-2').userOwned.includes('priority'), 'the user sets t-2 urgent: the priority is theirs', up)
    const lead2 = await runOf('lead', [
      ['team', 'task', 'update', 't-2', '--priority', 'low'],
      ['team', 'task', 'update', 't-2', '--title', 'API de notas v2'],
      // A loop through the real store: t-3 waits on t-2, which waits on t-1, which would wait on t-3.
      ['team', 'task', 'create', '--title', 'Tests de la API', '--blocked-by', 't-2'],
      ['team', 'task', 'update', 't-1', '--blocked-by', 't-3'],
    ])
    check(lead2.cli[0].code === 8 && lead2.cli[0].res.error.code === 'user_owned' && JSON.stringify(lead2.cli[0].res.data.fields) === '["priority"]', "the Lead's update of the user's priority: user_owned, exit 8, with the field", lead2.cli[0])
    check(lead2.cli[1].code === 0 && rt().tasks.find((t) => t.id === 't-2').title === 'API de notas v2' && rt().tasks.find((t) => t.id === 't-2').priority === 'urgent', "a field the user did not set still changes; the user's priority stays")
    check(lead2.cli[2].code === 0 && lead2.cli[2].res.data.id === 't-3', 't-3 created, blocked by t-2', lead2.cli[2])
    const loop = lead2.cli[3]
    check(loop.code === 2 && loop.res.error.code === 'bad_request' && loop.res.data.error === 'cycle' && loop.res.error.message === '--blocked-by makes a loop of blockers: t-1 -> t-3 -> t-2 -> t-1', 'a loop of blockers through TeamService names every task of it (bad_request, exit 2)', loop)
    check(JSON.stringify(rt().tasks.find((t) => t.id === 't-1').blockedBy) === '[]', 'and t-1 keeps its blockers')

    // team task get delivers only the queued comments its reply carries (newest 30, 4.5).
    for (let i = 1; i <= 32; i++) {
      const c = await svc.request({ op: 'comment', teamId, taskId: 't-1', text: `nota ${i}` }, 'desktop')
      if (!c.ok) check(false, 'a user comment on t-1', c)
    }
    const queuedFor = (agent) => (rt().comments['t-1'] ?? []).filter((c) => c.forAgent === agent && !c.deliveredRunId)
    check(queuedFor('dev').length === 32, 'the 32 user comments on t-1 wait for its assignee')
    const dev = await runOf('dev', [['team', 'task', 'get', 't-1']], 'Mirá t-1')
    check(dev.cli[0].code === 0 && dev.cli[0].res.data.task.comments.length === 30, 'team task get answers the newest 30 comments', dev.cli[0])
    const thread = rt().comments['t-1']
    const delivered = thread.filter((c) => c.deliveredRunId === dev.runId).map((c) => c.text)
    check(delivered.length === 30 && delivered.includes('nota 32') && delivered.includes('nota 3') && !delivered.includes('nota 2'), 'the 30 comments of the reply are delivered to that run', delivered)
    check(queuedFor('dev').map((c) => c.text).join(',') === 'nota 1,nota 2', 'the 2 older ones the reply left out stay queued')
    check(ended(dev.runId).state === 'succeeded', 'the dev run succeeded')

    // state.json at TEAM_STATE_MAX_BYTES: an agent write answers cap with its own hint (never "the board is full"); reads pass.
    const store = svc.team(teamId).store
    Object.defineProperty(store, 'lastBytes', { configurable: true, get: () => M.TEAM_STATE_MAX_BYTES })
    const full = await runOf('lead', [['team', 'comment', 't-1', 'otro'], ['team', 'show']])
    delete store.lastBytes
    check(full.cli[0].code === 7 && full.cli[0].res.error.code === 'busy' && full.cli[0].res.data.error === 'cap' && /^the team state is full \(8 MB\): archive or cancel old tasks/.test(full.cli[0].res.error.message) && !/board is full/.test(full.cli[0].res.error.message), 'a write past TEAM_STATE_MAX_BYTES: busy (cap), "the team state is full", exit 7', full.cli[0])
    check(full.cli[1].code === 0 && !(rt().comments['t-1'] ?? []).some((c) => c.text === 'otro'), 'the read still answers and nothing was written')

    // Every run token was revoked at its end: the last one gets 401 now.
    const revoked = await rpcRaw(endpoint, { token: 'x'.repeat(64), body: { v: 1, method: 'team.show', params: {} } })
    check(revoked.status === 401 && tokens.size === 0, 'every team token was revoked at the end of its run')

    // Labs off: a team.* call that still reaches the service answers disabled with the Labs wording, never forbidden.
    svc.setConfig({ ...cfg, settings: { ...cfg.settings, labs: { teams: false, consoleChat: false } } })
    const off = await svc.ctlView.handle('team.show', {}, { runId: lead.runId, teamId, agentId: 'lead', roleKind: 'lead' })
    check(off.ok === false && off.error.code === 'disabled' && off.error.message === 'Teams is off (Settings > Labs): end your turn', 'TeamService with Labs off: team.* answers disabled (exit 7), not forbidden', off)
    const offWrite = await svc.ctlView.handle('team.comment', { target: 't-1', text: 'x' }, { runId: lead.runId, teamId, agentId: 'lead', roleKind: 'lead' })
    check(offWrite.ok === false && offWrite.error.code === 'disabled', 'a write with Labs off: disabled too', offWrite)
  } finally {
    svc.dispose()
    await server.stop()
  }
}

async function main() {
  try {
    await clientChecks()
    await serverChecks()
    await mappingChecks()
    await budgetChecks()
    guideChecks()
    await fakeAgentChecks()
    await serviceChecks()
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true })
    if (sockRoot) fs.rmSync(sockRoot, { recursive: true, force: true })
  }
  console.log(`PASS: ${checks} team cli checks (parser, verbs and flags, --blocked-by and --options, texts: BOM, CRLF, UTF-16, U+FFFD, client caps, params per method, server validation, redaction, roles and modes, dev subtasks, note until B7, terminals until B5, concluded, liveness, the 5.1 table, budgets, forgetCaller, revoked token, gate, the fake agent cli step, the real TeamService: Lead tasks with blockers, user_owned, a named loop of blockers, task get delivery)`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
