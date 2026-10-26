// snaos team (app 2.7.0, E10 B3, design 5.1 to 5.3): the client parser (subcommands, the verb of
// `task` and `verdict`, the flags of each verb, --blocked-by and --options splitting, the client caps),
// the text of --file, --body-file and stdin (a BOM and the trailing CR/LF stripped, UTF-16LE and BE
// with a BOM or without one, U+FFFD refused with the hint) and teamCtl behind the real CtlServer and
// CtlHandlers with a team caller {paneId: 'team:<runId>', ptyId: same, workspaceId: '', team}: every
// method's params as the port gets them, the role and mode checks (a dev creates only with --parent =
// its task; a readonly Dev's exec run reports with done, never review, and a writing Dev's plan run has no
// done), every row of the 5.1 error mapping table with its exit code (a loop also as data.loop and
// data.loopMore; a refused hire's definition issues as data.issues, printed one escaped line each, B5), the 120 reads and 60 writes a
// minute and forgetCaller at revoke, a revoked token (401 naming the run, exit 6), conflict concluded
// after a terminal tool (the port is a fake here: B3 stubs the store's terminal tools), redaction, Teams
// off answering disabled (never forbidden), each `cap` with its own hint (the board, a comment thread, the
// state file), the guide (Claude calls snaos team with its Bash tool only), and the fake agent's `cli`
// step running the real cli.js (`snaos team show --json`) with the run env.
// Last, the real TeamService behind teamCtl on a temp repo: a Lead run creates tasks with blockers
// through snaos team, a user reprioritization survives its next update (user_owned), a loop of
// blockers answers with every task of it (t-1 -> t-3 -> t-2 -> t-1, also as a field, and TeamFail.loop on the
// user's path), `team task get`
// delivers only the queued comments its reply carries (newest 30), a write past TEAM_STATE_MAX_BYTES
// answers "the team state is full", and Labs off answers disabled.
// B5 integration, fourth round (security): team diff and team log, the reads main runs git for (the readonly
// profile lost git log, diff and show): the parser (paths only after --, -n 1..50, --task), teamCtl refusing a bad
// path, n or an unknown param before the port, and the real TeamService behind the real CtlServer on temp repos with
// an isolated git config (the global and system config empty files): a worktree task against its base (commits and
// uncommitted changes), a root task and a task-less run against HEAD, --task of another task of the team, the stat,
// the log of a branch since its base, an option-looking path after -- passed as a path only, literal pathspecs, a
// path with .. or absolute and one through a link that leaves the repo refused, an unknown task not_found, the caps
// with their marker line, a repo config whose diff.external, core.pager, textconv and gpg.program would leave a
// sentinel line never run (a control shows plain git runs them), and a token of another team reading its own team only.
// Fifth round (security): a live token of the app (the master one, a console's, a team run's; as is, in capitals or
// cut) in any text param answers bad_request with data.detail secret after the Labs gate, a revoked token or a SHA-256
// passes masked; inside a team run the client reads no file of the data folder (also through a link, or through a
// share of the same disk, by identity) and no
// runtime.json, .credentials.json or auth.json anywhere (exit 2, nothing sent); one git read in flight per run (busy,
// exit 7); after a rebase onto a newer main team diff and team log read from the merge base with the current main; an
// output past the runner's buffer with a stderr warning is too_big (a real child past a 1 KB maxBuffer).
// Sixth round (security): the client guard refuses every secret file name of the data folder anywhere (DATA_SECRET_FILES,
// the list the Read denies share; a repo's config.json passes, the data folder's does not), CtlTokens.maskTokens (in
// place, cut tokens mask the whole text, a piece of 16 hex characters or more is masked, revoked tokens stay), and a
// worktree task whose folder is gone answers io in words. Seventh round: paramText, the one reader of a call's params
// for the live-token check, exported for a Codex block (keys and string values, 8 levels deep).
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
/** Values built inside the vm have another realm's prototypes: compared as JSON. */
function same(actual, expected, label) {
  assert.deepEqual(JSON.parse(JSON.stringify(actual ?? null)), JSON.parse(JSON.stringify(expected ?? null)), label)
  checks++
}
const EXTERNAL = ['electron', 'ws', 'node-pty', '@xterm/headless', '@xterm/addon-serialize', '@xterm/addon-unicode11']
const ALIAS = { '@shared': path.join(root, 'src/shared') }
const FIX_DIR = path.join(__dirname, 'fixtures', 'teams')
const FAKE = path.join(FIX_DIR, 'fake-agent.cjs')

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
export { createTeamCtl, teamCtlError, paramText } from './src/main/teams/teamCtl'
export { agentGuide } from './src/main/cli/agentGuide'
export { teamChannelText } from './src/shared/teamTools'
export * as C from './src/main/cli/cliEntry'
export { CTL_EXIT } from './src/shared/ctl-protocol'
export { redactCredentials } from './src/shared/redact'
export { DATA_SECRET_FILES } from './src/shared/teamArgv'
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
      const run = { id: RUN, agentId: o.agentId ?? o.roleKind ?? 'dev', roleId: o.roleKind ?? 'dev', roleKind: o.roleKind ?? 'dev', mode: o.mode ?? 'exec', state: o.state ?? 'running', ...(o.taskId === null ? {} : { taskId: o.taskId ?? 't-3' }), ...(o.concludedBy ? { concludedBy: o.concludedBy } : {}), ...(o.profile ? { profile: o.profile } : {}) }
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
    // B5 integration, fifth round: the live tokens, as CliService wires them.
    secrets: tokens,
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
  const bomCrlf = Buffer.from('\uFEFF# Plan\r\n\r\npaso 1\r\n\r\n', 'utf8')
  check((await b(['team', 'plan', '--file', '-', '--small'], io({}, bomCrlf))).params.text === '# Plan\r\n\r\npaso 1', '--file - strips the BOM and the trailing CR/LF (decision 4)')
  check((await b(['team', 'task', 'create', '--title', 'x', '--body-file', '-'], io({}, bomCrlf))).params.body === '# Plan\r\n\r\npaso 1', '--body-file - strips them too')
  check((await b(['team', 'comment', 't-3', '-'], io({}, '\uFEFFhola\n'))).params.text === 'hola', 'a lone - positional reads stdin the same way')
  check((await b(['team', 'plan', '--file', 'plan.md'], io({ 'plan.md': '\uFEFFdesde archivo\r\n' }))).params.text === 'desde archivo', 'a --file path: BOM and trailing CR/LF stripped too')
  // Hygiene (B5 integration): nothing invisible sits in the code; the BOM and the zero width space are written as escapes.
  const invisible = /[\uFEFF\u200B]/
  const hidden = ['src/main/cli/cliEntry.ts', 'scripts/test-teams-cli.cjs', 'scripts/test-teams-runner.cjs'].filter((f) => invisible.test(fs.readFileSync(path.join(root, f), 'utf8')))
  check(hidden.length === 0, 'no raw U+FEFF or U+200B in the CLI source and its suites (escapes instead)', hidden)
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

  // B5 integration, fifth round (security, the client side): inside a team run no file of the data folder and no
  // runtime.json, .credentials.json or auth.json anywhere is read (exit 2, bad_request, nothing sent), real files on disk.
  const gd = path.join(TMP, 'guard')
  const dataDir = path.join(gd, 'snagentsos-data')
  const shimPath = path.join(dataDir, 'bin', win ? 'snaos.cmd' : 'snaos')
  const files = {
    runtime: path.join(dataDir, 'runtime.json'),
    state: path.join(dataDir, 'teams', TEAM, 'state.json'),
    notes: path.join(dataDir, 'notes', 'w1', 'nota.md'),
    claudeCreds: path.join(gd, 'home', '.claude', '.credentials.json'),
    codexAuth: path.join(gd, 'home', '.codex', 'auth.json'),
    upperRuntime: path.join(gd, 'elsewhere', 'RUNTIME.JSON'),
    repoFile: path.join(gd, 'repo', 'plan.md'),
    // Sixth round: the other secrets of the data folder by name, anywhere (DATA_SECRET_FILES); a repo's config.json is no secret.
    devices: path.join(gd, 'elsewhere', 'remote-devices.json'),
    pushKeys: path.join(gd, 'repo', 'push-keys.json'),
    shareGrants: path.join(gd, 'elsewhere', 'copia', 'share-grants.json'),
    oldBackup: path.join(gd, 'elsewhere', 'Migration-Backup-V1.zip'),
    repoConfig: path.join(gd, 'repo', 'config.json'),
    dataConfig: path.join(dataDir, 'config.json'),
  }
  for (const f of [...Object.values(files), shimPath]) {
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, f === files.repoFile ? 'el plan del repo' : f === files.repoConfig ? '{"port":3000}' : `{"token":"${'0'.repeat(64)}"}`)
  }
  // A link outside the data folder into it: only its realpath says where it reads.
  const link = path.join(gd, 'repo', 'atajo')
  fs.symlinkSync(path.join(dataDir, 'notes'), link, win ? 'junction' : 'dir')
  const guardIo = { ...C.nodeIo, cwd: () => path.join(gd, 'repo') }
  const teamEnv = { SNAOS_CTL_ENDPOINT: 'x', SNAOS_CTL_TOKEN: 'y'.repeat(64), SNAOS_TEAM_RUN: RUN, SNAOS_CLI: shimPath }
  const runGuard = async (argv, env = teamEnv) => {
    const out = []
    const err = []
    const sent = []
    const code = await C.run(argv, { io: guardIo, env, out: (s) => out.push(s), err: (s) => err.push(s), send: async (_c, call) => { sent.push(call); return { ok: true, data: { id: 'm-1' } } }, appVersion: '2.7.0' })
    let json = null
    try { json = JSON.parse(out.at(-1) ?? '') } catch { /* human */ }
    return { code, json, err: err.join('\n'), sent }
  }
  // The names of the refusal: the secrets of the data folder (DATA_SECRET_FILES, sixth round) and the two logins.
  const NAMES_RE = /a team run never reads a runtime\.json, remote-devices\.json, push-keys\.json, share-identity\.json, share-grants\.json, share-links\.json, migration-backup-v1\.zip, \.credentials\.json, auth\.json file/
  const refusedReads = [
    ['runtime.json of the data folder', ['team', 'comment', 't-3', '--file', files.runtime, '--json'], NAMES_RE],
    ['a team state file of the data folder', ['team', 'plan', '--file', files.state, '--json'], /a team run never reads a file of the SnAgentsOS data folder/],
    ['a note of the data folder', ['team', 'done', '--file', files.notes, '--json'], /data folder/],
    ['Claude\'s .credentials.json anywhere', ['team', 'comment', 'lead', '--file', files.claudeCreds, '--json'], NAMES_RE],
    ['Codex\'s auth.json anywhere', ['team', 'needs', '--file', files.codexAuth, '--json'], /\.credentials\.json, auth\.json file/],
    ['a RUNTIME.JSON in capitals elsewhere', ['team', 'review', '--file', files.upperRuntime, '--json'], /runtime\.json/],
    // Sixth round: every secret file name of the data folder, in any folder (a copy of it), in any case.
    ['a remote-devices.json elsewhere', ['team', 'comment', 't-3', '--file', files.devices, '--json'], NAMES_RE],
    ['a push-keys.json in the repo', ['team', 'plan', '--file', files.pushKeys, '--json'], NAMES_RE],
    ['a share-grants.json copied elsewhere', ['team', 'needs', '--file', files.shareGrants, '--json'], NAMES_RE],
    ['the 1.x backup zip in capitals elsewhere', ['team', 'review', '--file', files.oldBackup, '--json'], NAMES_RE],
    ['config.json of the data folder (ntfy and Discord secrets)', ['team', 'comment', 't-3', '--file', files.dataConfig, '--json'], /data folder/],
    ['a data folder file through a link outside it (realpath)', ['team', 'comment', 't-3', '--file', 'atajo/w1/nota.md', '--json'], /data folder/],
    ['--body-file of task create', ['team', 'task', 'create', '--title', 'x', '--body-file', files.runtime, '--json'], /cannot read --body-file .*runtime\.json: a team run never reads/],
    ['a relative path into the data folder', ['team', 'comment', 't-3', '--file', path.relative(path.join(gd, 'repo'), files.state), '--json'], /data folder/],
    ['another --runtime does not move the data folder', ['team', 'comment', 't-3', '--file', files.state, '--runtime', path.join(gd, 'elsewhere', 'x.json'), '--json'], /data folder/],
    ['send --file (any command of a team run)', ['send', '2', '--file', files.runtime, '--json'], /cannot read file .*runtime\.json: a team run never reads/],
  ]
  for (const [label, argv, re] of refusedReads) {
    const r = await runGuard(argv)
    check(r.code === 2 && r.code === M.CTL_EXIT.bad_request && r.json && r.json.ok === false && r.json.error.code === 'bad_request' && re.test(r.json.error.message) && r.sent.length === 0 && !JSON.stringify(r.json).includes('0'.repeat(64)), `team run guard: ${label} is refused (exit 2, nothing sent)`, r.json)
  }
  const human = await runGuard(['team', 'comment', 't-3', '--file', files.runtime])
  check(human.code === 2 && /^snaos: cannot read --file .*runtime\.json: a team run never reads/.test(human.err), 'human output: the error names the file and why', human.err)
  const fine = await runGuard(['team', 'plan', '--file', files.repoFile, '--json'])
  check(fine.code === 0 && fine.sent.length === 1 && fine.sent[0].params.text === 'el plan del repo', 'a repo file is read and sent as before')
  const repoConfig = await runGuard(['team', 'comment', 't-3', '--file', files.repoConfig, '--json'])
  check(repoConfig.code === 0 && repoConfig.sent.length === 1 && repoConfig.sent[0].params.text === '{"port":3000}', 'a config.json of the repo is read: only the data folder\'s is a secret (its name is common, sixth round)', repoConfig.json)
  const notTeam = await runGuard(['team', 'comment', 't-3', '--file', files.runtime, '--json'], { SNAOS_CTL_ENDPOINT: 'x', SNAOS_CTL_TOKEN: 'y'.repeat(64) })
  check(notTeam.sent.length === 1, 'outside a team run the client reads the file (main answers snaos team forbidden there)')
  // The default root of the task worktrees is <dataDir>/worktrees: a Dev or QA run's own tree stays readable, but a
  // link in it that leads back into the data folder does not (its realpath leaves the worktrees folder).
  const wtTree = path.join(dataDir, 'worktrees', 'repo-ab12', 'sn-t-1')
  fs.mkdirSync(wtTree, { recursive: true })
  fs.writeFileSync(path.join(wtTree, 'plan.md'), 'el plan del worktree')
  fs.writeFileSync(path.join(wtTree, 'auth.json'), '{}')
  fs.symlinkSync(path.join(dataDir, 'notes'), path.join(wtTree, 'vuelta'), win ? 'junction' : 'dir')
  const wtIo = { ...C.nodeIo, cwd: () => wtTree }
  const inTree = async (argv) => {
    const out = []
    const sent = []
    const code = await C.run(argv, { io: wtIo, env: teamEnv, out: (s) => out.push(s), err: () => undefined, send: async (_c, call) => { sent.push(call); return { ok: true, data: { id: 'm-1' } } }, appVersion: '2.7.0' })
    let json = null
    try { json = JSON.parse(out.at(-1) ?? '') } catch { /* human */ }
    return { code, json, sent }
  }
  const wtPlan = await inTree(['team', 'plan', '--file', 'plan.md', '--json'])
  check(wtPlan.code === 0 && wtPlan.sent.length === 1 && wtPlan.sent[0].params.text === 'el plan del worktree', 'a file of the run\'s own worktree under <dataDir>/worktrees is read and sent', wtPlan.json)
  const wtBack = await inTree(['team', 'comment', 't-3', '--file', 'vuelta/w1/nota.md', '--json'])
  const wtAuth = await inTree(['team', 'comment', 't-3', '--file', 'auth.json', '--json'])
  check(wtBack.code === 2 && /data folder/.test(wtBack.json.error.message) && wtBack.sent.length === 0 && wtAuth.code === 2 && /auth\.json file/.test(wtAuth.json.error.message) && wtAuth.sent.length === 0, 'in the worktree: a link back into the data folder and a file named auth.json are still refused', [wtBack.json, wtAuth.json])
  // The guard itself, with POSIX rules on any host: the shim folder's parent, --runtime's folder, never the root.
  const G = C.teamReadGuard({ runtime: '/home/u/.config/snagentsos-dev/runtime.json' }, { SNAOS_CLI: '/opt/data/bin/snaos', XDG_CONFIG_HOME: '/home/u/.config' }, 'linux', (p) => p)
  check(G('/opt/data/teams/x.json') !== null && G('/home/u/.config/snagentsos-dev/notes.md') !== null && G('/home/u/.config/snagentsos/a.md') !== null && G('/repo/auth.json') !== null && G('/repo/src/a.ts') === null && G('/opt/database/x') === null, 'teamReadGuard: the shim\'s data folder, --runtime\'s and the installed one; a sibling folder with the same prefix is not inside')
  check(G('/opt/data/worktrees/r/sn-t-1/plan.md') === null && G('/opt/data/worktrees-old/x.md') !== null && G('/opt/data/worktrees.json') !== null, 'the worktrees folder of the data folder stays readable, never a sibling with the same prefix nor the manifest')
  // Sixth round: one list for both sides. Every name of DATA_SECRET_FILES (the list TeamService.protectPaths turns into
  // the Read denies of a Claude run) is refused in any folder, also inside a worktree; a common name only in the data folder.
  check(M.DATA_SECRET_FILES.length === 7 && M.DATA_SECRET_FILES.every((n) => G(`/repo/src/${n}`) !== null && G(`/opt/data/worktrees/r/sn-t-1/${n.toUpperCase()}`) !== null), 'teamReadGuard: every DATA_SECRET_FILES name, anywhere and in any case', M.DATA_SECRET_FILES)
  check(G('/repo/config.json') === null && G('/repo/backups/config-1.json') === null && G('/repo/claude-accounts/a.bin') === null && G('/opt/data/config.json') !== null && G('/opt/data/backups/config-1.json') !== null && G('/opt/data/claude-accounts/a.bin') !== null, 'config.json, backups/ and claude-accounts/ are refused in the data folder only')
  const rootless = C.teamReadGuard({ runtime: 'runtime.json' }, { SNAOS_CLI: '/bin/snaos', XDG_CONFIG_HOME: '/c' }, 'linux', (p) => p)
  check(rootless('/repo/src/a.ts') === null && rootless('/bin/x') === null, 'a relative --runtime or a shim at the root never makes the whole disk the data folder')
  // By identity too (verifier of the fifth round): another path to the same folder (a share of the same disk, whose
  // realpath stays the share) is inside when a folder above the file is the data folder itself; its worktrees stay readable.
  const ids = { '/opt/data': 'v1:10', '/opt/data/worktrees': 'v1:11', '/mnt/share': 'v1:10', '/mnt/share/worktrees': 'v1:11', '/mnt/share/teams': 'v1:12', '/mnt/share/worktrees/r': 'v1:13' }
  const byId = C.teamReadGuard({}, { SNAOS_CLI: '/opt/data/bin/snaos', XDG_CONFIG_HOME: '/c' }, 'linux', (p) => p, (p) => ids[p] ?? null)
  check(byId('/mnt/share/teams/x.json') !== null && byId('/mnt/share/remote-devices.json') !== null && byId('/mnt/share/worktrees/r/plan.md') === null && byId('/repo/src/a.ts') === null, 'teamReadGuard: a folder above the file that is the data folder by identity (a share of it) is refused; its worktrees folder is not')
  const noIds = C.teamReadGuard({}, { SNAOS_CLI: '/opt/data/bin/snaos', XDG_CONFIG_HOME: '/c' }, 'linux', (p) => p, () => null)
  check(noIds('/mnt/share/teams/x.json') === null && noIds('/opt/data/teams/x.json') !== null, 'control: without identities only the path rule speaks (the share passes), the data folder path is still refused')
  if (win) {
    // The real thing: \\localhost\<drive>$\... reads the same file, and Node's realpath keeps the share form.
    const unc = (f) => `\\\\localhost\\${f[0]}$${f.slice(2)}`
    if (fs.existsSync(unc(files.state))) {
      const viaShare = await runGuard(['team', 'plan', '--file', unc(files.state), '--json'])
      check(viaShare.code === 2 && /data folder/.test(viaShare.json.error.message) && viaShare.sent.length === 0, 'a data folder file through the admin share of its disk (\\\\localhost\\C$) is refused (exit 2, nothing sent)', viaShare.json)
      const wtShare = await runGuard(['team', 'plan', '--file', unc(path.join(wtTree, 'plan.md')), '--json'])
      check(wtShare.code === 0 && wtShare.sent.length === 1, 'a worktree file through the same share stays readable', wtShare.json)
    } else console.log('note: \\\\localhost\\<drive>$ is not reachable here, the real share check was skipped (the identity check above ran)')
  }

  // Client caps (nothing is sent).
  check(/the plan is longer than 32768/.test(await bad(['team', 'plan', '--file', '-'], io({}, 'x'.repeat(M.TEAM_PLAN_MAX + 1)))), 'a plan over 32 KB is refused in the client')
  check(/the comment is longer than 8192/.test(await bad(['team', 'comment', 'lead', '-'], io({}, 'x'.repeat(M.COMMENT_TEXT_MAX + 1)))) && /the body is longer than 16384/.test(await bad(['team', 'task', 'create', '--title', 'x', '--body-file', '-'], io({}, 'x'.repeat(M.TASK_BODY_MAX + 1)))), 'comment 8 KB and body 16 KB caps in the client')
  check(/the role file is longer than 65536/.test(await bad(['team', 'hire', '--file', '-'], io({}, 'x'.repeat(M.HIRE_TEXT_MAX + 1)))) && /the note is longer/.test(await bad(['team', 'note', '-'], io({}, 'x'.repeat(M.COMMENT_TEXT_MAX + 1)))), 'hire 64 KB and note 8 KB caps in the client')
  const big = await bad(['team', 'hire', '--file', '-'], io({}, '\u0001'.repeat(M.HIRE_TEXT_MAX - 1) + 'x'))
  check(big === null, 'a 64 KB role file of control characters still fits once JSON-escaped (384 KB < 1 MB)', big)
  check(C.formatHuman('team.task.create', { id: 't-12' }) === 't-12 created' && C.formatHuman('team.plan', { approvalId: 'a-1', concluded: 'plan' }) === 'plan sent for approval (a-1); this run is concluded', 'human output: short English lines')
  const table = C.formatHuman('team.tasks', { tasks: [{ id: 't-12', state: 'doing', phase: 'executing', title: 'Arreglar login' }] })
  check(/^id +state +phase +title\nt-12 +doing +executing +Arreglar login$/.test(table) && C.formatHuman('team.tasks', { tasks: [] }) === 'no tasks', 'team tasks prints an id state phase title table', table)

  // B5 integration, fourth round: team diff and team log (main reads; no option of the agent reaches git).
  same(await b(['team', 'diff']), { method: 'team.diff', params: {} }, 'team diff alone: the run\'s own task (or the repo root)')
  same((await b(['team', 'diff', '--stat', '--task', 't-3', '--', 'src/a.ts', '--output=out.txt', '-n'])).params, { stat: true, task: 't-3', paths: ['src/a.ts', '--output=out.txt', '-n'] }, 'team diff --stat --task -- <paths>: an option-looking word after -- is a path')
  same((await b(['team', 'log', '-n', '5', '--', 'a.ts'])).params, { n: 5, paths: ['a.ts'] }, 'team log -n 5 -- a.ts')
  same((await b(['team', 'log', '--lines', '50'])).params, { n: 50 }, '-n is --lines (its alias), 50 at most')
  check(/team diff takes paths only after --/.test(await bad(['team', 'diff', 'src/a.ts'])) && /team log takes paths only after --/.test(await bad(['team', 'log', 'a.ts', '--', 'b.ts'])), 'a path before -- is a usage error')
  check((await Promise.all(['../x', 'src/../../x', '/etc/passwd', '\\\\host\\share\\x', 'C:/x', 'c:x', 'a\\..\\..\\b'].map((x) => bad(['team', 'diff', '--', x])))).every((m) => /is not relative to the repo/.test(m)), 'an absolute path, a drive, a UNC or a .. segment is refused in the client')
  check(/-n must be a whole number from 1 to 50/.test(await bad(['team', 'log', '-n', '51'])) && /-n must be a whole number from 1 to 50/.test(await bad(['team', 'log', '-n', '0'])) && /-n must be a whole number/.test(await bad(['team', 'log', '-n', '1e1'])), 'team log -n: 1 to 50')
  check(/--stat does not apply to team log/.test(usage(['team', 'log', '--stat'])) && /--lines does not apply to team diff/.test(usage(['team', 'diff', '-n', '3'])) && /unknown option --output=x/.test(usage(['team', 'diff', '--output=x'])) && /unknown option --no-index/.test(usage(['team', 'diff', '--no-index'])), 'flags are checked per subcommand; a git option before -- is an unknown option')
  check(/--task must be a task id/.test(await bad(['team', 'diff', '--task', '3'])) && /takes 32 paths at most/.test(await bad(['team', 'diff', '--', ...Array.from({ length: 33 }, (_, i) => `f${i}`)])), '--task is a task id; 32 paths at most')
  check(p(['team', 'diff', '--', 'x']).dashAt === 0 && p(['team', 'diff', '--', 'x']).positionals.join() === 'x' && p(['send', '2', '--', '-x']).positionals.join() === '2,-x' && p(['send', '2', '--', '-x']).dashAt === 1 && p(['ls']).dashAt === undefined, 'parseArgs: dashAt is where the words after -- start (other commands keep them as positionals)')
  check(/team needs one of/.test(usage(['team', '--', 'diff'])), 'a word after -- is never the subcommand')
  check(C.formatHuman('team.diff', { where: 'root', range: 'HEAD', text: 'diff --git a/x b/x' }) === 'diff --git a/x b/x' && C.formatHuman('team.diff', { where: 'root', range: 'HEAD', text: '' }) === 'no changes' && C.formatHuman('team.log', { where: 'root', range: 'HEAD', text: '' }) === 'no commits', 'human output: the text as is ("no changes", "no commits" when empty)')
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

    // B5 integration, fourth round: team diff and team log are reads; teamCtl checks their params before the port.
    const reads = () => port.calls.filter((c) => c.kind === 'read').length
    const r0 = reads()
    const refusedGit = [
      ['team.diff', { paths: ['../x'] }, /team diff: path 1 must stay inside the repo \(no \.\. segment\)/], ['team.diff', { paths: ['ok.ts', 'C:/Windows/x'] }, /path 2 must be relative to the repo, not absolute/],
      ['team.diff', { paths: ['/etc/passwd'] }, /not absolute/], ['team.diff', { paths: ['\\\\host\\share'] }, /not absolute/], ['team.log', { paths: ['a\\..\\..\\b'] }, /no \.\. segment/],
      ['team.diff', { paths: ['a\u0000b'] }, /control character/], ['team.diff', { paths: [''] }, /non-empty/], ['team.diff', { paths: 'src' }, /paths must be a list/],
      ['team.diff', { paths: Array.from({ length: 33 }, (_, i) => `f${i}`) }, /32 repo relative paths at most/], ['team.diff', { paths: ['x'.repeat(1025)] }, /longer than 1024/],
      ['team.log', { n: 0 }, /n must be a whole number from 1 to 50/], ['team.log', { n: 51 }, /from 1 to 50/], ['team.log', { n: 2.5 }, /whole number/], ['team.log', { n: '5' }, /whole number/],
      ['team.diff', { stat: 'yes' }, /stat must be true or false/], ['team.diff', { task: 'T-1' }, /task must be a task id/],
      ['team.diff', { teamId: 'tm-ffffffffffff', task: 't-1' }, /takes no param "teamId"/], ['team.log', { cwd: 'C:/' }, /takes no param "cwd"/], ['team.diff', { args: ['--output=x'] }, /takes no param "args"/],
    ]
    const gotGit = []
    for (const [method, params] of refusedGit) gotGit.push((await raw(method, params)).json)
    check(gotGit.every((g, i) => g.ok === false && g.error.code === 'bad_request' && refusedGit[i][2].test(g.error.message)) && reads() === r0, 'team diff and log: a bad path (.., absolute, drive, UNC, control), n, stat, task or an unknown param (teamId, cwd, args) is bad_request and never reaches the port', gotGit.map((g) => g.error?.message))
    await raw('team.diff', { stat: true, task: 't-1', paths: ['src/a.ts', '--output=x', 'src/a.ts'] })
    same({ method: last('read').method, params: last('read').params }, { method: 'team.diff', params: { stat: true, task: 't-1', paths: ['src/a.ts', '--output=x'] } }, 'a valid team diff reaches the port read (paths deduped; an option-looking path stays a path)')
    port.setRun({ roleKind: 'qa', mode: 'qa', profile: 'readonly' })
    await raw('team.log', { n: 7 })
    check(last('read').method === 'team.log' && last('read').params.n === 7, 'team log of a readonly QA run reaches the port (every role, every mode)')
    port.setRun()

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
      { role: () => port.setRun({ mode: 'plan' }), argv: ['team', 'plan', '--file', '-', '--small'], stdin: '\uFEFF# Plan\r\n', method: 'team.plan', params: { text: '# Plan', small: true }, out: 'plan sent for approval (a-1); this run is concluded' },
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

    // B5 integration, fifth round (security): a live token of the app never goes into the team state (a readonly run
    // could `--file` runtime.json). The master token and the run's own team token in a comment and in a plan, as is,
    // in capitals or cut by spaces and line ends, through the real CtlServer: bad_request, data.detail 'secret', exit 2,
    // a message that names no token, nothing applied.
    w.fresh()
    const spaced = (t) => t.match(/.{1,8}/g).join(' \n')
    const secretCases = [
      ['comment with the master token', () => port.setRun(), ['team', 'comment', 't-3', '-', '--json'], `mirá el runtime: {"token":"${w.master}"}`],
      ['comment with the team token', () => port.setRun(), ['team', 'comment', 'lead', '-', '--json'], `mi token es ${w.teamToken}.`],
      ['plan with the master token in capitals', () => port.setRun({ mode: 'plan' }), ['team', 'plan', '-', '--json'], `# Plan\n\nPaso 1: ${w.master.toUpperCase()}`],
      ['plan with the team token cut by spaces and line ends', () => port.setRun({ mode: 'plan' }), ['team', 'plan', '-', '--json'], `# Plan\n${spaced(w.teamToken)}`],
      ['comment with a console token', () => port.setRun(), ['team', 'comment', 't-3', '-', '--json'], `otro: SNAOS_CTL_TOKEN=${w.consoleToken}`],
    ]
    const nBefore = w.applies()
    for (const [label, setup, argv, text] of secretCases) {
      setup()
      const r = await run(argv, io({}, text))
      const all = JSON.stringify(r.json)
      check(r.code === 2 && r.json.ok === false && r.json.error.code === 'bad_request' && r.json.data.detail === 'secret' && /a text holds an access token of the app/.test(r.json.error.message), `${label}: bad_request, detail secret (exit 2)`, r.json)
      check(![w.master, w.teamToken, w.consoleToken].some((t) => all.toLowerCase().includes(t)), `${label}: the refusal names no token`)
    }
    check(w.applies() === nBefore, 'a text with a live token never reaches the store')
    // Any param: the options of ask, the title and body of a task, the text of hire (raw requests, no client caps).
    port.setRun({ roleKind: 'qa', mode: 'qa' })
    const askSecret = (await raw('team.ask', { text: '¿Cuál?', options: ['otra', `usá ${w.master}`] })).json
    port.setRun({ roleKind: 'lead', mode: 'lead', taskId: null })
    const titleSecret = (await raw('team.task.create', { title: `x ${w.teamToken}` })).json
    const bodySecret = (await raw('team.task.create', { title: 'x', body: `cuerpo\n${w.master}` })).json
    const hireSecret = (await raw('team.hire', { text: `---\nname: x\n---\n${w.master}` })).json
    check([askSecret, titleSecret, bodySecret, hireSecret].every((r) => r.ok === false && r.error.code === 'bad_request' && r.data.detail === 'secret') && w.applies() === nBefore, 'ask options, task title and body, hire text: refused the same way', [askSecret, titleSecret, bodySecret, hireSecret])
    // Seventh round: paramText is the one reader of a call's params for that check, exported for TeamService.applyRunBlock
    // (a Codex block action): every string value and key, nested lists and objects, PARAM_DEPTH levels at most.
    const deep = (n) => (n === 0 ? 'fondo' : { [`k${n}`]: deep(n - 1) })
    check(typeof M.paramText === 'function' && M.paramText({ text: 'uno', options: ['dos', { tres: 'cuatro' }], n: 5 }) === 'text\nuno\noptions\ndos\ntres\ncuatro\nn' && M.paramText(deep(8)).endsWith('k1\nfondo') && !M.paramText(deep(9)).includes('fondo') && M.paramText('solo') === 'solo', 'paramText: keys and string values in order, 8 levels deep, a number left out', [M.paramText(deep(8)), M.paramText(deep(9))])
    // A 64 hex text that is no live token (a revoked one, a SHA-256): it passes, masked by the redaction (second net).
    const revokedTok = w.tokens.issue('pty-gone', 'p-gone', 'w1')
    w.tokens.revoke('pty-gone')
    port.setRun()
    const passedHex = await run(['team', 'comment', 't-3', '-', '--json'], io({}, `uno revocado ${revokedTok} y un sha256 ${'ab12'.repeat(16)}`))
    check(passedHex.code === 0 && w.applies() === nBefore + 1 && last('apply').call.params.text === 'uno revocado [redacted] y un sha256 [redacted]', 'a revoked token or a SHA-256 is no live token: applied, and the 64 hex shape is masked', last('apply').call.params)
    // The Labs gate stays first: Teams off answers disabled, never the secret refusal.
    const liveBefore = port.live
    port.live = 'disabled'
    const offSecret = await run(['team', 'comment', 't-3', '-', '--json'], io({}, w.master))
    port.live = liveBefore
    check(offSecret.code === 7 && offSecret.json.error.code === 'disabled' && w.applies() === nBefore + 1, 'Teams off: disabled before the token check', offSecret.json)
    // CtlTokens.holdsToken: the live set only (master, console, team), as is, in capitals or cut; never a revoked token.
    const T = w.tokens
    const extra = T.issueTeam('r-ffffffffffff', { runId: 'r-ffffffffffff', teamId: TEAM, agentId: 'qa', roleKind: 'qa' })
    check(T.holdsToken(w.master) && T.holdsToken(`x${w.consoleToken}x`) && T.holdsToken(extra.toUpperCase()) && T.holdsToken(`${extra.slice(0, 20)}\n-${extra.slice(20, 50)} ${extra.slice(50)}`), 'holdsToken: the master, a console and a team token, inside a word, in capitals, cut by a line end, a dash and a space')
    // Sixth round: CtlTokens.maskTokens, what a run's chat rows go through (TeamService.maskRun): each live token as is
    // or in capitals becomes [redacted] and the rest of the text stays; a text that still holds a cut one is masked whole.
    check(T.maskTokens(`token=${w.master} y ${extra.toUpperCase()}x`) === 'token=[redacted] y [redacted]x' && T.maskTokens(`env SNAOS_CTL_TOKEN=${w.consoleToken}`) === 'env SNAOS_CTL_TOKEN=[redacted]', 'maskTokens: the master, a console and a team token (also in capitals, inside a word) masked in place')
    check(T.maskTokens(`antes\n${extra.slice(0, 30)}\n${extra.slice(30)}\ndespues`) === '[redacted]' && T.maskTokens('commit a94a8fe5ccb19ba61c4c0873d391e987982fbbd3, nada secreto') === 'commit a94a8fe5ccb19ba61c4c0873d391e987982fbbd3, nada secreto' && T.maskTokens('') === '' && T.maskTokens(`${revokedTok}`) === revokedTok, 'maskTokens: a token cut by line ends masks the whole text; a text without a live token (a git SHA, a revoked token) is left as it is')
    // A piece of a live token (16 hex characters in a row at least) is masked too: a decoder cuts a text at its cap
    // before main masks it (the end of a 4 KB tool result, the start of a stderr tail), so a token on the cut leaves a piece.
    check(T.maskTokens(`${'x'.repeat(20)} ${w.master.slice(0, 40)}`) === `${'x'.repeat(20)} [redacted]` && T.maskTokens(`${extra.slice(24)}\nfin`) === '[redacted]\nfin' && T.maskTokens(`beef${w.consoleToken.slice(0, 20)}`) === '[redacted]' && T.maskTokens(`${w.master.slice(10, 30)}!`) === '[redacted]!', 'maskTokens: a piece of a live token (cut at the end or the start of the text, after other hex, from its middle) is masked')
    check(T.maskTokens(`corto ${w.master.slice(0, 15)}`) === `corto ${w.master.slice(0, 15)}` && T.maskTokens(`otro hex ${'0123456789abcdef'.repeat(3)}`) === `otro hex ${'0123456789abcdef'.repeat(3)}`, 'maskTokens: 15 characters of a token or a hex run of no live token stay')
    T.revokeTeam('r-ffffffffffff')
    check(T.maskTokens(extra) === extra, 'maskTokens: a revoked team token is no live token (redactCredentials still masks its shape where main shows it)')
    check(!T.holdsToken(extra) && !T.holdsToken(revokedTok) && !T.holdsToken('') && !T.holdsToken(w.master.slice(0, 63)) && !T.holdsToken('commit a94a8fe5ccb19ba61c4c0873d391e987982fbbd3'), 'holdsToken: a revoked token, an empty text, 63 characters of a token or a git SHA are not a live token')

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
    // Decision 24 (B4 integration item 4): a Dev whose role is readonly runs its worktree task in the repo root and
    // commits nothing, so its exec run reports with done and has nothing to review; a writing Dev's plan run is
    // readonly only for its phase and still cannot call done.
    const roDev = () => port.setRun({ roleKind: 'dev', mode: 'exec', isolation: 'worktree', profile: 'readonly' })
    await roleCase(roDev, ['team', 'done', 'informe'], true)
    await roleCase(roDev, ['team', 'review'], false, /read-only and commits nothing to review: report the task with snaos team done/)
    await roleCase(() => port.setRun({ roleKind: 'dev', mode: 'plan', isolation: 'worktree', profile: 'readonly' }), ['team', 'done'], false, /not allowed in this run \(plan mode\)/)
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

    // team note: a port without note (the optional TeamCtlPort.note) -> disabled (exit 7); with one, its answer passes.
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
      [{ error: 'cycle', current: { loop: ['t-5', 't-1', 't-5'], more: 0 } }, ['team', 'task', 'update', 't-5', '--blocked-by', 't-1'], 'lead', 'bad_request', 2, /loop of blockers: t-5 -> t-1 -> t-5$/],
      [{ error: 'cycle', current: { loop: ['t-5', 't-1'], more: 7 } }, ['team', 'task', 'update', 't-5', '--blocked-by', 't-1'], 'lead', 'bad_request', 2, /loop of blockers: t-5 -> t-1 -> \.\.\. \(\+7 more\)$/],
      [{ error: 'cycle', loop: ['t-6', 't-2', 't-6'] }, ['team', 'task', 'update', 't-6', '--blocked-by', 't-2'], 'lead', 'bad_request', 2, /loop of blockers: t-6 -> t-2 -> t-6$/],
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
    // Item 6 of the B4 integration: the loop also travels as a field (data.loop, at most 20 ids, and data.loopMore).
    port.setRun({ roleKind: 'lead', mode: 'lead', taskId: null })
    for (const [current, loop, more] of [[{ loop: ['t-5', 't-1', 't-5'], more: 0 }, ['t-5', 't-1', 't-5'], undefined], [{ loop: ['t-5', 't-1'], more: 7 }, ['t-5', 't-1'], 7]]) {
      w.fresh()
      port.applyReply = { ok: false, error: 'cycle', current }
      const c = await run(['team', 'task', 'update', 't-5', '--blocked-by', 't-1', '--json'])
      check(JSON.stringify(c.json.data.loop) === JSON.stringify(loop) && c.json.data.loopMore === more && c.json.data.error === 'cycle', `cycle: data.loop ${loop.join(',')} and loopMore ${more}`, c.json)
    }
    w.fresh()
    port.applyReply = { ok: false, error: 'cycle', current: ['t-5', 't-1', 't-5'] }
    const shapeless = await run(['team', 'task', 'update', 't-5', '--blocked-by', 't-1', '--json'])
    check(shapeless.json.data.loop === undefined && /--blocked-by t-1 makes a loop of blockers/.test(shapeless.json.error.message), 'a loop in no known shape: the plain cycle words, no loop field', shapeless.json)
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

    // Item 8 (B5 integration): a refused `team hire` returns its definition issues to the agent (data.issues) and the
    // CLI prints one escaped line each, capped.
    port.setRun({ roleKind: 'lead', mode: 'lead', taskId: null })
    const issues = [
      { file: 'roles/designer.md', line: 6, key: 'count', code: 'bad_value', detail: '9', severity: 'error' },
      { file: 'roles/designer.md', line: 2, key: 'kind', code: 'bad_value', detail: 'x\u001b[31m\u{202e}evil', severity: 'error', extra: 'dropped' },
      { file: 'team.md', line: 0, code: 'two_leads', severity: 'error' },
    ]
    const roleFile = { 'role.md': '---\nname: Designer\nkind: custom\ncount: 9\n---\nDiseñá.\n' }
    w.fresh()
    port.applyReply = { ok: false, error: 'bad_request', current: { issues } }
    const hj = await run(['team', 'hire', '--file', 'role.md', '--json'], io(roleFile))
    check(hj.code === 2 && hj.json.error.code === 'bad_request' && /the role file does not fit the team definition \(3 issues\)/.test(hj.json.error.message) && hj.json.data.issues.length === 3, 'a refused hire: bad_request with its issues in data', hj.json)
    check(hj.json.data.issues[1].extra === undefined && !/[\u0000-\u001f]/.test(hj.json.data.issues[1].detail) && hj.json.data.issues[2].key === undefined && hj.json.data.issues[2].line === 0, 'teamCtl checks each issue: known fields only, controls out of its texts', hj.json.data.issues)
    w.fresh()
    port.applyReply = { ok: false, error: 'bad_request', current: { issues } }
    const hh = await run(['team', 'hire', '--file', 'role.md'], io(roleFile))
    const lines = hh.err.split('\n')
    check(hh.code === 2 && /^snaos: snaos team hire: the role file does not fit/.test(lines[0]) && lines[1] === '  roles/designer.md:6 count: bad_value (9)' && lines[2] === '  roles/designer.md:2 kind: bad_value (x [31m\\u{202e}evil)' && lines[3] === '  team.md two_leads', 'human output: the message, then one line per issue', lines)
    const esc = M.C.hireIssueLines('team.hire', { issues: [{ file: 'roles/x.md', line: 1, code: 'bad_value', detail: 'a\u{202e}b\u{200b}c\u{e0041}' }, ...Array.from({ length: 25 }, (_, i) => ({ file: `f${i}`, code: 'bad_value', detail: 'y'.repeat(500) }))] })
    check(esc[0] === '  roles/x.md:1 bad_value (a\\u{202e}b\\u{200b}c\\u{e0041})' && esc.length === 21 && esc[20] === '  ... 6 more' && esc.slice(1, 20).every((l) => l.length <= 300 && l.endsWith('...')), 'hireIssueLines: hidden characters escaped, 20 lines of 300 at most, then the rest counted', esc.slice(0, 2))
    check(M.C.hireIssueLines('team.comment', { issues }).length === 0 && M.C.hireIssueLines('team.hire', {}).length === 0, 'only for team hire, only with issues')
    w.fresh()
    port.applyReply = { ok: false, error: 'bad_request' }
    const plainHire = await run(['team', 'hire', '--file', 'role.md', '--json'], io(roleFile))
    check(plainHire.json.data.issues === undefined && /the role file was refused/.test(plainHire.json.error.message), 'a hire refused without issues (it changes nothing): no issues field, its own hint', plainHire.json)
    port.applyReply = null
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
  // B5 integration, fourth round: the reads main runs git for (the readonly profile has no git log, diff or show).
  check(/Read code changes with `snaos team diff` and history with `snaos team log`, never with `git log`,\s+`git diff` or `git show`/.test(teams) && teams.includes('team.diff') && teams.includes('team.log') && teams.includes('snaos team diff [--stat] [--task <t-N>] [-- <path>...]') && teams.includes('snaos team log [-n <1..50>] [--task <t-N>] [-- <path>...]'), 'guide: team diff and team log, never git log, diff or show', teams)
  check(/paths only after `--`, relative to the repo/.test(teams) && /256 KB \(diff\) or 64 KB \(log\)/.test(teams) && /`--task <t-N>` for another task of your team/.test(teams), 'guide: paths after --, the caps and --task', teams)
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
      { cli: ['team', 'comment', 't-3', '-', '--json'], bin: cliJs, stdin: '\uFEFFhola desde el agente ñ\r\n' },
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
export { createGitRunner, gitEnv, gitOverflowed } from './src/main/git/gitExec'
export { pidAlive, signalTree, treeKillSync } from './src/main/proc/treeKill'
export { WorktreeService } from './src/main/git/WorktreeService'
export { WorktreeManifest } from './src/main/git/WorktreeManifest'
export { teamGitRead, TEAM_GIT_GLOBAL } from './src/main/teams/ops/gitReads'
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
      holdsToken: (text) => tokens.holdsToken(text),
      maskTokens: (text) => tokens.maskTokens(text),
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
      // B5 review, second round: needsPlan changes only in todo; t-2 is blocked.
      ['team', 'task', 'update', 't-2', '--no-plan'],
    ])
    check(lead2.cli[0].code === 8 && lead2.cli[0].res.error.code === 'user_owned' && JSON.stringify(lead2.cli[0].res.data.fields) === '["priority"]', "the Lead's update of the user's priority: user_owned, exit 8, with the field", lead2.cli[0])
    check(lead2.cli[1].code === 0 && rt().tasks.find((t) => t.id === 't-2').title === 'API de notas v2' && rt().tasks.find((t) => t.id === 't-2').priority === 'urgent', "a field the user did not set still changes; the user's priority stays")
    check(lead2.cli[2].code === 0 && lead2.cli[2].res.data.id === 't-3', 't-3 created, blocked by t-2', lead2.cli[2])
    const loop = lead2.cli[3]
    check(loop.code === 2 && loop.res.error.code === 'bad_request' && loop.res.data.error === 'cycle' && loop.res.error.message === '--blocked-by makes a loop of blockers: t-1 -> t-3 -> t-2 -> t-1', 'a loop of blockers through TeamService names every task of it (bad_request, exit 2)', loop)
    check(JSON.stringify(loop.res.data.loop) === '["t-1","t-3","t-2","t-1"]' && loop.res.data.loopMore === undefined, 'and carries it as a field (data.loop, no loopMore for a short loop)', loop)
    const noPlan = lead2.cli[4]
    check(noPlan.code === 2 && noPlan.res.error.code === 'bad_request' && noPlan.res.data.error === 'bad_request' && rt().tasks.find((t) => t.id === 't-2').needsPlan === true, "the Lead's --no-plan on a blocked task through TeamService: bad_request (exit 2), the task keeps its plan", noPlan)
    check(/change only while the task is in todo/.test(noPlan.res.error.message), 'and its message says the plan flag changes only in todo', noPlan.res.error.message)
    const t2NoPlan = rt().tasks.find((t) => t.id === 't-2')
    same(await svc.request({ op: 'updateTask', teamId, taskId: 't-2', baseRev: t2NoPlan.rev, patch: { needsPlan: false } }, 'desktop'), { ok: false, error: 'bad_request' }, 'the user\'s path answers the same refusal (the drawer\'s words of repo and isolation)')
    // The user's path (teams:req) answers the same loop as TeamFail.loop.
    const t1rev = rt().tasks.find((t) => t.id === 't-1').rev
    const userLoop = await svc.request({ op: 'updateTask', teamId, taskId: 't-1', baseRev: t1rev, patch: { blockedBy: ['t-3'] } }, 'desktop')
    check(!userLoop.ok && userLoop.error === 'cycle' && JSON.stringify(userLoop.loop) === '["t-1","t-3","t-2","t-1"]' && userLoop.loopMore === undefined, 'the user path: the same loop as TeamFail.loop', userLoop)
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

// ---- G. team diff and team log for real: TeamService, the real CtlServer and git on temp repos -----------
// B5 integration, fourth round (security): the readonly profile lost git log, diff and show; main reads for the run.
async function gitReadChecks() {
  const S = loadService()
  const dir = path.join(TMP, 'git-reads')
  fs.mkdirSync(dir, { recursive: true })
  // Isolated git config: the global and the system config are empty files.
  const emptyGlobal = path.join(dir, 'gitconfig-global')
  const emptySystem = path.join(dir, 'gitconfig-system')
  fs.writeFileSync(emptyGlobal, '')
  fs.writeFileSync(emptySystem, '')
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyGlobal, GIT_CONFIG_SYSTEM: emptySystem }
  for (const k of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|EXTERNAL_DIFF|PAGER)$/i.test(k) || /^SNAOS_/i.test(k)) delete env[k]
  const git = (cwd, ...args) => cp.execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
  const gitIn = (cwd, input, ...args) => cp.execFileSync('git', args, { cwd, env, input, stdio: ['pipe', 'pipe', 'pipe'] }).toString()
  const makeRepo = (p) => {
    fs.mkdirSync(p, { recursive: true })
    fs.writeFileSync(path.join(p, 'README.md'), '# r\n')
    fs.writeFileSync(path.join(p, 'big.txt'), 'uno\n')
    git(p, 'init', '-q', '-b', 'main')
    git(p, 'add', '-A')
    git(p, 'commit', '-qm', 'init')
    return p
  }
  const repoA = makeRepo(path.join(dir, 'repo-a'))
  const repoB = makeRepo(path.join(dir, 'repo-b'))

  // A command git would run from the repo config: it leaves a line in the sentinel file.
  const sentinel = path.join(dir, 'sentinel.txt')
  const sentinelJs = path.join(dir, 'sentinel.cjs')
  fs.writeFileSync(sentinelJs, `require('fs').appendFileSync(${JSON.stringify(sentinel)}, (process.argv[2] || '?') + '\\n'); process.exit(1)\n`)
  const cmd = (word) => `"${process.execPath.replace(/\\/g, '/')}" "${sentinelJs.replace(/\\/g, '/')}" ${word}`
  // gpg.program is run without a shell: a script with its #! line (Git for Windows reads it too).
  const sentinelSh = path.join(dir, 'gpg-sentinel.sh')
  fs.writeFileSync(sentinelSh, `#!/bin/sh\nprintf 'gpg\\n' >> '${sentinel.replace(/\\/g, '/')}'\nexit 1\n`)
  fs.chmodSync(sentinelSh, 0o755)
  const fired = () => (fs.existsSync(sentinel) ? fs.readFileSync(sentinel, 'utf8').split('\n').filter(Boolean) : [])
  const clearSentinel = () => fs.rmSync(sentinel, { force: true })

  const tokens = new M.CtlTokens(M.newToken())
  const issued = new Map()
  let svc = null
  const h = new M.CtlHandlers({ bus: { request: async () => ({ ok: false, error: 'desktop_unavailable' }) }, pty: { ptyIdForPane: () => null, submitToPane: async () => ({ ok: true }), lastSubmitAt: () => undefined, lastOutputAt: () => undefined, tail: () => null }, status: { stateOf: () => null, setNeeds: () => false }, config: () => null, notify: () => undefined, appVersion: '2.7.0', services: () => (svc ? { teams: svc.ctlView } : {}) })
  const endpoint = pipeName()
  const server = new M.CtlServer({ kind: win ? 'named-pipe' : 'unix', endpoint }, (t) => tokens.resolve(t), h.handle)
  await server.start()
  const shim = path.join(dir, 'bin', win ? 'snaos.cmd' : 'snaos')
  fs.mkdirSync(path.dirname(shim), { recursive: true })
  fs.writeFileSync(shim, '')
  const data = path.join(dir, 'data')
  const cfg = { settings: { labs: { teams: true, consoleChat: false }, language: 'es', worktreesRoot: '' }, workspaces: [] }
  let scenario = path.join(FIX_DIR, 'claude-simple.json')
  const runner = S.createGitRunner({ env: () => S.gitEnv(env) })
  // Fifth round (one git read in flight per run): while `gate.hold` is set, a team read of that tree waits on it.
  const gate = { hold: null, cwd: null, hits: 0 }
  const svcGit = {
    get running() { return runner.running },
    info: (force) => runner.info(force),
    run: async (args, opts) => {
      if (gate.hold && opts.cwd === gate.cwd && args.includes('--literal-pathspecs')) {
        gate.hits++
        await gate.hold
      }
      return runner.run(args, opts)
    },
  }
  const manifest = new S.WorktreeManifest(path.join(data, 'worktrees.json'))
  const wtRoot = path.join(data, 'worktrees')
  const wts = new S.WorktreeService({ runner, manifest, root: () => wtRoot, defaultRoot: () => wtRoot, removeOptions: { delayMs: 0, retries: 1 } })
  svc = new S.TeamService({
    dataDir: () => data,
    config: () => cfg,
    git: svcGit,
    emit: () => undefined,
    openPath: async () => '',
    log: () => undefined,
    loader: new S.TeamDefinitionLoader({ watch: () => ({ on() { return this }, close() {} }) }),
    strict: true,
    status: { snapshot: () => [], stateOf: () => null, paneForSession: () => null },
    sessionHolder: () => null,
    accounts: () => null,
    worktrees: wts,
    cli: {
      envForTeam: (runId, teamId, agentId, roleKind) => {
        const token = tokens.issueTeam(runId, { runId, teamId, agentId, roleKind })
        issued.set(runId, token)
        return { SNAOS_CTL_ENDPOINT: endpoint, SNAOS_CTL_TOKEN: token, SNAOS_CLI: shim, SNAOS_TEAM_RUN: runId }
      },
      revokeTeam: (runId) => { tokens.revokeTeam(runId); h.forgetCaller(`team:${runId}`) },
      ready: () => true,
      holdsToken: (text) => tokens.holdsToken(text),
      maskTokens: (text) => tokens.maskTokens(text),
    },
    awake: () => undefined,
    sendRun: () => undefined,
    resolveCli: () => ({ file: process.execPath, args: [FAKE, scenario], kind: 'exe' }),
    procStartTime: async () => null,
    treeKill: { sync: (pid) => S.treeKillSync(pid), signal: (pid, sig) => S.signalTree(pid, sig), alive: (pid) => S.pidAlive(pid) },
    platform: process.platform,
  })
  const until = async (fn, label) => {
    const end = Date.now() + 20000
    while (!fn()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  try {
    await svc.start(cfg)
    const setup = async (repo) => {
      const probe = await svc.request({ op: 'setupProbe', dir: repo }, 'desktop')
      const draft = { ...probe.probe.defaults, goal: 'Una app de notas', verify: '' }
      const prev = await svc.request({ op: 'setupPreview', repoRoot: repo, draft }, 'desktop')
      const wr = await svc.request({ op: 'setupWrite', repoRoot: repo, draft, previewHash: prev.preview.hash }, 'desktop')
      check(wr.ok, `a trusted team on ${path.basename(repo)}`, wr)
      return wr.teamId
    }
    const teamA = await setup(repoA)
    const teamB = await setup(repoB)
    const rt = (teamId) => svc.team(teamId).store.rt
    const ended = (teamId, id) => svc.team(teamId).store.recentRuns().find((r) => r.id === id)
    const createTask = async (teamId, task) => {
      const r = await svc.request({ op: 'createTask', teamId, task }, 'desktop')
      check(r.ok, `createTask ${task.title}`, r)
      return r.task.id
    }
    /** A run that stays live (hang.json) until stopped: its token reaches the real server in the meantime. */
    const live = async (teamId, agentId, taskId) => {
      scenario = path.join(FIX_DIR, 'hang.json')
      const r = await svc.request({ op: 'runNow', teamId, agentId, ...(taskId ? { taskId } : {}) }, 'desktop')
      check(r.ok, `runNow ${agentId}${taskId ? ` ${taskId}` : ''}`, r)
      await until(() => rt(teamId).activeRuns.some((x) => x.id === r.runId && x.state === 'running'), `run ${r.runId} running`)
      const runEnv = { SNAOS_CTL_ENDPOINT: endpoint, SNAOS_CTL_TOKEN: issued.get(r.runId), SNAOS_TEAM_RUN: r.runId }
      return {
        runId: r.runId,
        /** The real CLI client in this process, through the pipe. */
        cli: async (argv) => {
          const out = []
          const err = []
          const code = await C.run(argv, { io: io(), env: runEnv, out: (s) => out.push(s), err: (s) => err.push(s), appVersion: '2.7.0' })
          let json = null
          try { json = JSON.parse(out.at(-1) ?? '') } catch { /* human output */ }
          return { code, out: out.join('\n'), err: err.join('\n'), json }
        },
        raw: async (method, params = {}) => (await rpcRaw(endpoint, { token: runEnv.SNAOS_CTL_TOKEN, body: { v: 1, method, params } })).json,
        stop: async () => {
          await svc.request({ op: 'stop', teamId, runId: r.runId }, 'desktop')
          await until(() => !!ended(teamId, r.runId), `run ${r.runId} ended`)
        },
      }
    }

    // Team A, t-1: a Dev task in worktree isolation; its first run (the plan run) makes the worktree.
    const t1 = await createTask(teamA, { title: 'Login', assignee: 'dev' })
    scenario = path.join(FIX_DIR, 'claude-simple.json')
    const first = await svc.request({ op: 'runNow', teamId: teamA, agentId: 'dev', taskId: t1 }, 'desktop')
    check(first.ok, 'the first run of t-1', first)
    await until(() => !!ended(teamA, first.runId), 'the first run of t-1 ended')
    const wt = rt(teamA).tasks.find((t) => t.id === t1).worktree
    check(wt && /^[0-9a-f]{40}$/.test(wt.base) && fs.existsSync(wt.path), 'the plan run made the worktree of t-1', wt)
    fs.writeFileSync(path.join(wt.path, 'feature.txt'), 'linea uno\n')
    fs.writeFileSync(path.join(wt.path, '-n.txt'), 'parece una opcion\n')
    git(wt.path, 'add', '-A')
    git(wt.path, 'commit', '-qm', 'feature del login')
    fs.writeFileSync(path.join(wt.path, 'README.md'), '# r\nsin commitear\n')
    // A root task of team A (isolation main): no worktree, the repo root.
    const t2 = await createTask(teamA, { title: 'Docs', assignee: 'dev', isolation: 'main' })
    // The root of repo A has its own uncommitted change; repo B too (team B's own t-1).
    fs.writeFileSync(path.join(repoA, 'README.md'), '# r\ncambio en la raiz de A\n')
    fs.writeFileSync(path.join(repoB, 'README.md'), '# r\ncambio en la raiz de B\n')
    const tB = await createTask(teamB, { title: 'Otra', assignee: 'dev', isolation: 'main' })
    check(tB === 't-1', 'team B has its own t-1')

    // The repo config names commands for diff.external, core.pager, a textconv driver and gpg (log.showSignature): git
    // runs the external diff, the textconv and gpg when nothing turns them off (checked below), the pager on a terminal.
    git(repoA, 'config', 'diff.external', cmd('external'))
    git(repoA, 'config', 'core.pager', cmd('pager'))
    git(repoA, 'config', 'diff.snx.textconv', cmd('textconv'))
    git(repoA, 'config', 'gpg.program', sentinelSh.replace(/\\/g, '/'))
    git(repoA, 'config', 'log.showSignature', 'true')
    fs.writeFileSync(path.join(wt.path, '.gitattributes'), '*.txt diff=snx\n')
    // A commit with a signature header on the worktree branch (its tip): git log verifies it with gpg.program.
    const tree = git(wt.path, 'rev-parse', 'HEAD^{tree}').trim()
    const parent = git(wt.path, 'rev-parse', 'HEAD').trim()
    const signed = gitIn(wt.path, `tree ${tree}\nparent ${parent}\nauthor t <t@x> 1700000000 +0000\ncommitter t <t@x> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE\n -----END PGP SIGNATURE-----\n\ncommit firmado\n`, 'hash-object', '-t', 'commit', '-w', '--stdin').trim()
    git(wt.path, 'update-ref', `refs/heads/${wt.branch}`, signed)
    clearSentinel()
    try { git(wt.path, 'diff') } catch { /* the sentinel exits 1 */ }
    try { git(wt.path, 'diff', '--no-ext-diff', wt.base) } catch { /* idem */ }
    try { git(wt.path, 'log', '-1') } catch { /* idem */ }
    const control = fired()
    check(control.includes('external') && control.includes('textconv') && control.includes('gpg'), 'control: a plain git diff, diff --no-ext-diff and log in that tree run the external diff, the textconv and gpg of the repo config', control)
    clearSentinel()

    // A plan run of t-1 (readonly, the profile without git log, diff or show) reads its worktree through main.
    const dev = await live(teamA, 'dev', t1)
    const d = await dev.cli(['team', 'diff', '--json'])
    check(d.code === 0 && d.json.ok && d.json.data.where === 'worktree' && d.json.data.task === t1 && d.json.data.range === wt.base && !d.json.data.cut, 'team diff of the run\'s own worktree task: where worktree, the range is its merge base with main (its base while main has not moved)', d.json)
    check(d.json.data.text.includes('feature.txt') && d.json.data.text.includes('+linea uno') && d.json.data.text.includes('+sin commitear') && d.json.data.text.includes('-n.txt'), 'the worktree against its base: its commits (feature.txt, -n.txt) and its uncommitted change (README.md)', d.json.data.text)
    check(!d.json.data.text.includes('cambio en la raiz de A'), 'never the repo root\'s changes')
    const human = await dev.cli(['team', 'diff'])
    check(human.code === 0 && human.out === d.json.data.text, 'human output: the text as is')
    const st = await dev.cli(['team', 'diff', '--stat', '--json'])
    check(st.code === 0 && /feature\.txt +\| +1 \+/.test(st.json.data.text) && /README\.md +\| +1 \+/.test(st.json.data.text) && /-n\.txt +\| +1 \+/.test(st.json.data.text) && !st.json.data.text.includes('+linea uno'), '--stat: the files only', st.json?.data?.text)
    const lg = await dev.cli(['team', 'log', '--json'])
    check(lg.code === 0 && lg.json.data.range === `refs/heads/${wt.baseBranch}..refs/heads/${wt.branch}` && wt.baseBranch === 'main' && lg.json.data.text.includes('commit firmado') && lg.json.data.text.includes('feature del login') && !/\n {4}init\n?/.test(lg.json.data.text) && !/gpg|Good signature|BAD signature/i.test(lg.json.data.text), 'team log of the worktree: the commits of its branch since its base (never the base\'s own), no signature check', lg.json?.data)
    const lg1 = await dev.cli(['team', 'log', '-n', '1', '--', 'feature.txt', '--json'])
    check(lg1.code === 0 && lg1.json === null && lg1.out.includes('feature del login'), 'after -- every word is a path, --json too (human output)', lg1)
    const lgPath = await dev.cli(['team', 'log', '--json', '-n', '1', '--', 'feature.txt'])
    check(lgPath.code === 0 && lgPath.json.data.text.includes('feature del login') && !lgPath.json.data.text.includes('commit firmado'), 'team log -n 1 -- feature.txt: the newest commit that touched it', lgPath.json?.data?.text)
    // An option-looking path after -- is a literal path: git writes nothing, reads only that name.
    const opt = await dev.cli(['team', 'diff', '--json', '--', '--output=out.txt', '-n.txt'])
    check(opt.code === 0 && opt.json.data.text.includes('-n.txt') && !opt.json.data.text.includes('feature.txt') && !fs.existsSync(path.join(wt.path, 'out.txt')) && !fs.existsSync(path.join(repoA, 'out.txt')), '-- --output=out.txt -n.txt: both are paths (no out.txt written; -n.txt shown)', opt.json)
    const glob = await dev.cli(['team', 'diff', '--json', '--', '*.txt', ':(top)README.md'])
    check(glob.code === 0 && glob.json.data.text === '', 'literal pathspecs: a glob or a :(magic) is a file name that does not exist (nothing shown)', glob.json)
    check(fired().length === 0, 'the external diff, the pager, the textconv and gpg of the repo config never ran for team diff and team log', fired())
    // Paths main refuses (the client refuses them first; a raw request still meets main's check).
    const refused = []
    for (const paths of [['../repo-b/README.md'], [path.join(repoB, 'README.md')], ['C:/Windows/win.ini'], ['/etc/passwd'], ['src/../../x']]) refused.push(await dev.raw('team.diff', { paths }))
    check(refused.every((r) => r.ok === false && r.error.code === 'bad_request'), 'a path with .. or an absolute one: bad_request from main', refused)
    check((await dev.cli(['team', 'diff', '--', '../x'])).code === 2, 'and exit 2 in the client')
    // Another task of the same team: t-2 has no worktree, so the repo root against HEAD.
    const other = await dev.cli(['team', 'diff', '--task', t2, '--json'])
    check(other.code === 0 && other.json.data.where === 'root' && other.json.data.task === t2 && other.json.data.range === 'HEAD' && other.json.data.text.includes('cambio en la raiz de A') && !other.json.data.text.includes('sin commitear'), '--task t-2 (isolation main): the repo root of team A against HEAD', other.json)
    const missing = await dev.cli(['team', 'diff', '--task', 't-99', '--json'])
    check(missing.code === 3 && missing.json.error.code === 'not_found' && /no task t-99/.test(missing.json.error.message), 'an unknown task: not_found (exit 3)', missing.json)

    // Fifth round: one git read in flight per run. The first waits at the gate; a second one meanwhile answers busy.
    let release = null
    gate.cwd = wt.path
    gate.hold = new Promise((r) => { release = r })
    gate.hits = 0
    const held = dev.cli(['team', 'diff', '--stat', '--json'])
    await until(() => gate.hits === 1, 'the first team read waits at the gate')
    const busy = await dev.cli(['team', 'log', '--json'])
    const busyDiff = await dev.cli(['team', 'diff', '--json'])
    check(busy.code === 7 && busy.code === M.CTL_EXIT.busy && busy.json.error.code === 'busy' && busy.json.error.message === 'another snaos team diff or log of this run is still reading: wait for its answer, then run snaos team log again', 'a second git read of the run while one runs: busy (exit 7) with a short retry hint', busy.json)
    check(busyDiff.code === 7 && /then run snaos team diff again/.test(busyDiff.json.error.message) && gate.hits === 1, 'a team diff meanwhile too, and neither reached git', busyDiff.json)
    gate.hold = null
    release()
    const heldDone = await held
    check(heldDone.code === 0 && heldDone.json.data.text.includes('feature.txt'), 'the first read answers once git runs')
    const after1 = await dev.cli(['team', 'log', '--json'])
    check(after1.code === 0 && after1.json.ok, 'then the next read of the run runs (the slot is free again)', after1.json)

    // Fifth round: the Dev rebases onto a newer main. team diff and team log read against the current base branch
    // (the merge base, like qaStat), so main's own new commit is not the task's work.
    fs.writeFileSync(path.join(repoA, 'base-nueva.md'), 'algo de main\n')
    git(repoA, 'add', 'base-nueva.md')
    git(repoA, 'commit', '-qm', 'base nueva en main')
    const mainTip = git(repoA, 'rev-parse', 'refs/heads/main').trim()
    git(wt.path, '-c', 'commit.gpgSign=false', 'rebase', '-q', '--autostash', 'main')
    clearSentinel()
    const mergeBase = git(wt.path, 'merge-base', 'refs/heads/main', `refs/heads/${wt.branch}`).trim()
    const oldLog = git(wt.path, 'log', '--format=%s', `${wt.base}..refs/heads/${wt.branch}`)
    check(mergeBase === mainTip && mergeBase !== wt.base && oldLog.includes('base nueva en main') && fs.existsSync(path.join(wt.path, 'base-nueva.md')), 'control: after the rebase the merge base is main\'s new tip, and the old base..branch range holds main\'s commit', { mergeBase, mainTip, base: wt.base, oldLog })
    const rd = await dev.cli(['team', 'diff', '--json'])
    check(rd.code === 0 && rd.json.data.range === mainTip && rd.json.data.text.includes('feature.txt') && rd.json.data.text.includes('+sin commitear') && !rd.json.data.text.includes('base-nueva.md') && !rd.json.data.text.includes('algo de main'), 'team diff after a rebase: from the merge base with main (its new tip) to the working tree, never main\'s own file', rd.json?.data)
    const rl = await dev.cli(['team', 'log', '--json'])
    check(rl.code === 0 && rl.json.data.range === `refs/heads/main..refs/heads/${wt.branch}` && rl.json.data.text.includes('feature del login') && !rl.json.data.text.includes('base nueva en main'), 'team log after a rebase: the branch over the current main, never main\'s own commit', rl.json?.data)
    const rs = await dev.cli(['team', 'diff', '--stat', '--json'])
    check(rs.code === 0 && /feature\.txt/.test(rs.json.data.text) && !/base-nueva\.md/.test(rs.json.data.text), '--stat after the rebase: the task\'s files only', rs.json?.data?.text)
    check(fired().length === 0, 'the commands of the repo config never ran for the reads after the rebase', fired())
    await dev.stop()

    // The Lead (no task): the repo root; --task t-1 reads that worktree (any role reads any task of its team).
    // A link inside the root that leaves it, an output past the caps.
    const outside = path.join(dir, 'outside')
    fs.mkdirSync(outside, { recursive: true })
    fs.symlinkSync(outside, path.join(repoA, 'fuera'), win ? 'junction' : 'dir')
    fs.writeFileSync(path.join(repoA, 'big.txt'), Array.from({ length: 6000 }, (_, i) => `linea ${i} ${'x'.repeat(50)}`).join('\n') + '\n')
    const lead = await live(teamA, 'lead')
    const root = await lead.cli(['team', 'diff', '--json'])
    check(root.code === 0 && root.json.data.where === 'root' && root.json.data.task === undefined && root.json.data.range === 'HEAD' && root.json.data.cut === true, 'the Lead (no task): the repo root against HEAD, cut', root.json && { ...root.json.data, text: root.json.data.text.slice(0, 80) })
    const cutText = root.json.data.text
    check(Buffer.byteLength(cutText, 'utf8') <= 256 * 1024 && cutText.endsWith('\n[... cut at 256 KB: narrow it with --stat, or name paths after --]') && cutText.includes('cambio en la raiz de A'), 'the diff cut at 256 KB at a line end, with its marker line last', Buffer.byteLength(cutText, 'utf8'))
    const rootStat = await lead.cli(['team', 'diff', '--stat', '--json'])
    check(rootStat.code === 0 && !rootStat.json.data.cut && /big\.txt/.test(rootStat.json.data.text), '--stat of the same diff fits')
    const viaLink = await lead.cli(['team', 'diff', '--json', '--', 'fuera/x.txt'])
    check(viaLink.code === 2 && viaLink.json.error.code === 'bad_request' && /path 1 leaves the repo/.test(viaLink.json.error.message), 'a path through a link that leaves the repo: bad_request after realpath', viaLink.json)
    const leadWt = await lead.cli(['team', 'diff', '--task', t1, '--stat', '--json'])
    check(leadWt.code === 0 && leadWt.json.data.where === 'worktree' && leadWt.json.data.text.includes('feature.txt'), 'the Lead reads t-1\'s worktree with --task', leadWt.json?.data)
    // A long log: one commit with a 70 KB message, cut at 64 KB.
    const msg = path.join(dir, 'msg.txt')
    fs.writeFileSync(msg, `mensaje largo\n\n${Array.from({ length: 1200 }, (_, i) => `renglon ${i} ${'y'.repeat(50)}`).join('\n')}\n`)
    git(repoA, 'commit', '-q', '--allow-empty', '-F', msg)
    const longLog = await lead.cli(['team', 'log', '-n', '1', '--json'])
    check(longLog.code === 0 && longLog.json.data.cut === true && Buffer.byteLength(longLog.json.data.text, 'utf8') <= 64 * 1024 && longLog.json.data.text.endsWith('\n[... cut at 64 KB: ask for fewer commits with -n, or name paths after --]') && longLog.json.data.text.includes('mensaje largo'), 'the log cut at 64 KB with its marker line', longLog.json && Buffer.byteLength(longLog.json.data.text, 'utf8'))
    check(fired().length === 0, 'the commands of the repo config never ran for the Lead either', fired())
    await lead.stop()

    // Team B's run: its token names team B, so --task t-1 is team B's own t-1 (its repo root), never team A's worktree.
    const b = await live(teamB, 'lead')
    const bt = await b.cli(['team', 'diff', '--task', 't-1', '--json'])
    check(bt.code === 0 && bt.json.data.where === 'root' && bt.json.data.text.includes('cambio en la raiz de B') && !bt.json.data.text.includes('feature.txt') && !bt.json.data.text.includes('cambio en la raiz de A'), 'a team B token reads team B\'s t-1 only', bt.json)
    const forged = await b.raw('team.diff', { teamId: teamA, task: 't-1' })
    check(forged.ok === false && forged.error.code === 'bad_request' && /takes no param "teamId"/.test(forged.error.message), 'naming team A in the request is refused (the token names the team)', forged)
    const bt2 = await b.cli(['team', 'diff', '--task', t2, '--json'])
    check(bt2.code === 3 && bt2.json.error.code === 'not_found', 'team A\'s t-2 does not exist for team B: not_found', bt2.json)
    await b.stop()
    // A revoked token (the run ended) reads nothing.
    const after = await rpcRaw(endpoint, { token: issued.get(b.runId), body: { v: 1, method: 'team.diff', params: {} } })
    check(after.status === 401, 'the token of an ended run: 401')
    // A git that execFile kills at its timeout says only `Command failed: <its argv>`: the agent reads what happened.
    const killedExec = (_file, _args, _opts, cb) => setImmediate(() => cb(Object.assign(new Error('Command failed: git diff HEAD --'), { killed: true, signal: 'SIGTERM' }), '', ''))
    const slowRunner = S.createGitRunner({ gitBin: 'git', execFile: killedExec })
    const slowDiff = await S.teamGitRead({ git: slowRunner, realpath: async (p) => p }, { cwd: repoA, where: 'root' }, { method: 'team.diff', stat: false, paths: [] })
    const slowLog = await S.teamGitRead({ git: slowRunner, realpath: async (p) => p }, { cwd: repoA, where: 'root' }, { method: 'team.log', n: 5, paths: [] })
    check(slowDiff.ok === false && slowDiff.error === 'io' && slowDiff.detail === 'git took longer than 15 s: narrow it with --stat or -- <path>' && slowLog.detail === 'git took longer than 15 s: narrow it with -n or -- <path>', 'a git killed at its timeout: io in words, never its argv', [slowDiff, slowLog])

    // Fifth round: an output past the runner's buffer is too_big even when git also wrote a warning to stderr (gitExec
    // keeps Node's ERR_CHILD_PROCESS_STDIO_MAXBUFFER; before, the warning was the message and it read as io). The fake
    // execFile runs a real child with a 1 KB maxBuffer: Node's own error, the git argv recorded.
    const loud = path.join(dir, 'loud.cjs')
    fs.writeFileSync(loud, "process.stderr.write(\"warning: in the working copy of 'big.txt', LF will be replaced by CRLF the next time Git touches it\\n\"); process.stdout.write('diff --git a/x b/x\\n'.repeat(5000))\n")
    const seen = []
    const overflowExec = (_file, args, opts, cb) => {
      seen.push(args)
      return cp.execFile(process.execPath, [loud], { ...opts, maxBuffer: 1024 }, cb)
    }
    const overRunner = S.createGitRunner({ gitBin: 'git', execFile: overflowExec })
    let overErr = null
    try { await overRunner.run(['diff'], { cwd: repoA }) } catch (e) { overErr = e }
    check(overErr && overErr.maxBuffer === true && /LF will be replaced/.test(overErr.message) && S.gitOverflowed(overErr) && !S.gitOverflowed(new Error('x')), 'gitExec: an overflow with stderr keeps its maxBuffer flag (the message is still git\'s stderr)', overErr && { msg: overErr.message, maxBuffer: overErr.maxBuffer, code: overErr.code })
    const overDiff = await S.teamGitRead({ git: overRunner, realpath: async (p) => p }, { cwd: repoA, where: 'root' }, { method: 'team.diff', stat: false, paths: [] })
    const overLog = await S.teamGitRead({ git: overRunner, realpath: async (p) => p }, { cwd: repoA, where: 'root' }, { method: 'team.log', n: 5, paths: [] })
    check(overDiff.ok === false && overDiff.error === 'too_big' && overDiff.detail === 'the diff is too large to read at once: narrow it with --stat or -- <path>' && overLog.error === 'too_big' && overLog.detail === 'the log is too large to read at once: narrow it with -n or -- <path>', 'team diff and team log past the buffer with a stderr warning: too_big with how to narrow it', [overDiff, overLog])
    check(seen.length === 3 && seen.slice(1).every((a) => a.join(' ').includes('-c core.safecrlf=false')) && S.TEAM_GIT_GLOBAL.join(' ').includes('-c core.safecrlf=false'), 'the fixed options turn off the line end warnings (core.safecrlf=false)', seen.map((a) => a.join(' ')))
    // A worktree whose base branch is gone: the merge base fails in words, with git's first stderr line, never its argv.
    const goneBase = await S.teamGitRead({ git: runner, realpath: async (p) => p }, { cwd: wt.path, where: 'worktree', base: wt.base, baseBranch: 'gone', branch: wt.branch, task: t1 }, { method: 'team.diff', stat: false, paths: [] })
    check(goneBase.ok === false && goneBase.error === 'io' && goneBase.detail.startsWith(`git found no commit where ${wt.branch} left gone`) && !/Command failed|merge-base|core\./.test(goneBase.detail), 'a worktree whose base branch is gone: io in words (no argv)', goneBase)
    const badRef = await S.teamGitRead({ git: runner, realpath: async (p) => p }, { cwd: wt.path, where: 'worktree', base: wt.base, baseBranch: '-x', branch: wt.branch }, { method: 'team.log', n: 1, paths: [] })
    check(badRef.ok === false && badRef.error === 'io' && /no base branch or branch git can read/.test(badRef.detail), 'a base branch that is no plain ref name never reaches git', badRef)
    // Sixth round: a worktree task whose folder is gone (removed or moved) says so, diff and log, with paths or none,
    // with the realpath TeamService passes (fs.promises.realpath): never the merge base message nor git's spawn error.
    const MISSING = `the worktree folder of ${t1} is missing (it was removed or moved), so git cannot read its changes`
    const goneTree = { cwd: `${wt.path}-borrado`, where: 'worktree', base: wt.base, baseBranch: 'main', branch: wt.branch, task: t1 }
    const realpath = (p) => fs.promises.realpath(p)
    const goneReads = [
      await S.teamGitRead({ git: runner, realpath }, goneTree, { method: 'team.diff', stat: false, paths: [] }),
      await S.teamGitRead({ git: runner, realpath }, goneTree, { method: 'team.diff', stat: true, paths: ['README.md'] }),
      await S.teamGitRead({ git: runner, realpath }, goneTree, { method: 'team.log', n: 5, paths: [] }),
    ]
    check(goneReads.every((r) => r.ok === false && r.error === 'io' && r.detail === MISSING), 'a worktree task whose folder is gone: io saying its worktree folder is missing (diff, diff with a path, log)', goneReads)
    const hereDiff = await S.teamGitRead({ git: runner, realpath }, { ...goneTree, cwd: wt.path }, { method: 'team.diff', stat: true, paths: [] })
    check(hereDiff.ok === true && hereDiff.data.where === 'worktree', 'control: the same task with its folder in place reads its diff', hereDiff)
  } finally {
    svc.dispose()
    await server.stop()
    fs.rmSync(path.join(repoA, 'fuera'), { recursive: true, force: true })
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
    await gitReadChecks()
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true })
    if (sockRoot) fs.rmSync(sockRoot, { recursive: true, force: true })
  }
  console.log(`PASS: ${checks} team cli checks (parser, verbs and flags, --blocked-by and --options, texts: BOM, CRLF, UTF-16, U+FFFD, client caps, params per method, server validation, redaction, roles and modes, dev subtasks, team note through the port (disabled without one), terminals until B5, concluded, liveness, the 5.1 table, budgets, forgetCaller, revoked token, gate, the fake agent cli step, the real TeamService: Lead tasks with blockers, user_owned, a named loop of blockers, task get delivery; team diff and team log: worktree, root, --task, stat, log, literal paths, refused paths, caps, no repo config command, another team; fifth round: live tokens refused, the client guard, busy, merge base after a rebase, too_big with stderr; sixth round: every secret file name refused, maskTokens, a missing worktree folder)`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
