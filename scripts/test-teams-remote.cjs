// Teams on the phone (app 2.7.0, E10 B8, design 6.2, 6.3 and 8 B8): the real RemoteManager and SessionManager with a
// fake socket (the HTTP server and dataDir() stubbed, like test-remote.cjs) in front of the real TeamService on a temp
// git repo (an isolated git config), wired as index.ts does it (setTeams(remoteView), emit -> teamChanged).
//  - Frames: every teamRes the phone gets is <= TEAM_FRAME_MAX_BYTES as the socket sends it: 300 tasks of the todo
//    column paged (each page as many as fit, the cursor walks every task once and in the desktop's order), a task with
//    a 16 KB body and 200 comments (the body cut, the comments paged with "Ver anteriores" until all 200 were read),
//    "Te necesita" with a hire diff of 2500 lines and a 32 KB plan (cut and marked), a run page walk that reads every
//    row of the run once, the Lead thread paged, a page without a column cut; phoneFit on crafted replies (paths and
//    the conflict `current` dropped, list items without the desktop fields, texts of lone surrogates, a run page cut
//    between two rows of one line never, a newest line too big for the frame kept whole, three hire diffs of long
//    lines in one frame). Tanda B close: the texts the user decides on are never cut (a long rule, its denied
//    commands, a final summary, a card question and options next to three hire diffs arrive whole); when even they do
//    not fit, the heaviest row goes read only (pcOnly) with its cut texts marked truncated, never a row with nothing to
//    cut (32 short rules stay decidable); a decided final summary cut in the drawer is marked too.
//  - Masking: no frame carries a credential or a piece of a live token of the app, while the desktop's reply does.
//  - Limits: 30 teamReq per 10 s per session, then `rate` (no strike) until the window passes; 2 in flight.
//  - The three ctls handled in main and never relayed: teamDecide on a hire approval and teamAnswer with resumeTeam
//    forbidden, teamDecide on an integrate approval bad_request, a permission with nothing to grant
//    `bad_request:nothingToGrant`, a second decide `conflict:already_decided`, a dispatch of all ok; Tanda B close: the
//    phone reads each approval's rev, a permission decided at an older rev (or with none) `conflict:stale`, at its rev
//    ok, on a task whose grants are full `bad_request:grantsFull`.
//  - teamChanged: a phone hears of a team change; one per team per 500 ms, scopes merged, the hint only when shared.
//  - Push: buildTeamPushMessage (the #team= link, the tag, urgent, never a state), notifyTeamPush behind https and
//    notifyAction, routeTeam (the away gate, never held, push false goes nowhere, Discord and ntfy as custom notices
//    with the deep link) and the TeamNotice of a new need row.
//  - Labs off answers disabled to teamReq and to a ctl; an old desktop (its schema without teamReq and the team ctls)
//    strikes each such frame as bad_msg (why the phone gates every one of them on 2.7.0); no team data in Share.
// Same esbuild + vm harness as test-remote.cjs; real git only in a temp repo. No Electron, no user data, no agent.
const { build } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label, extra) {
  assert.ok(condition, extra === undefined ? label : `${label}: ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`)
  checks++
}
const json = (v) => JSON.parse(JSON.stringify(v ?? null))
const tick = () => new Promise((r) => setImmediate(r))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MAX = 48 * 1024

const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-teams-remote-')))
const remoteData = path.join(TMP, 'remote')
fs.mkdirSync(remoteData)
const stubs = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /\/RemoteServer$/ }, () => ({ path: 'RemoteServer', namespace: 'stub' }))
    b.onResolve({ filter: /^\.\.\/paths$/ }, () => ({ path: 'paths', namespace: 'stub' }))
    b.onLoad({ filter: /^RemoteServer$/, namespace: 'stub' }, () => ({ loader: 'ts', contents: `
export class RemoteServer {
  constructor(port: number, handlers: any) { (globalThis as any).__server = { port, handlers } }
  start() { return Promise.resolve() }
  close() {}
}` }))
    b.onLoad({ filter: /^paths$/, namespace: 'stub' }, () => ({ loader: 'ts', contents: `export function dataDir() { return ${JSON.stringify(remoteData)} }` }))
  },
}
/** A 2.6.0 desktop: the real schema without the teamReq member and the three team ctls (the text cut must happen). */
const oldDesktop = {
  name: 'old-desktop',
  setup(b) {
    b.onLoad({ filter: /remote-protocol-schemas\.ts$/ }, (args) => {
      const src = fs.readFileSync(args.path, 'utf8')
      const cut = src.replace(/^.*type: z\.literal\('teamReq'\).*$/m, '').replace(/^\s*\.\.\.teamCtlActionSchemas,\s*$/m, '')
      assert.ok(cut !== src && !cut.includes("z.literal('teamReq')") && !cut.includes('...teamCtlActionSchemas'), 'the old-desktop plugin found the teamReq member and the team ctls to cut')
      return { loader: 'ts', contents: cut, resolveDir: path.dirname(args.path) }
    })
  },
}
const ENTRY = `
export { RemoteManager, TEAM_CHANGED_THROTTLE_MS } from './src/main/remote/RemoteManager'
export { fitTeamRes, TEAM_REQ_MAX, TEAM_REQ_WINDOW_MS, TEAM_REQ_IN_FLIGHT, TEAM_FRAME_MAX_BYTES, RATE_LIMITED_MSG_TYPES, RATE_LIMITED_CTL_KINDS } from './src/main/remote/SessionManager'
export { buildTeamPushMessage } from './src/main/remote/PushService'
export { createNoticeRouter, teamDeepLinkUrl, isTeamNotice } from './src/main/status/noticeRouter'
export * as F from './src/main/teams/phoneFit'
export { TeamService } from './src/main/teams/TeamService'
export { TeamDefinitionLoader } from './src/main/teams/TeamDefinitionLoader'
export { createGitRunner, gitEnv } from './src/main/git/gitExec'
export { CtlTokens, newToken } from './src/main/cli/CtlTokens'
export { APP_2_7_0, appVersionAtLeast } from './src/shared/agentTune'
export { PHONE_TEAM_OPS, TEAM_PHONE_BODY_MAX, TEAM_PHONE_PLAN_MAX, TEAM_PHONE_HIRE_LINES, TEAM_BOARD_PAGE } from './src/shared/team-protocol'
export { teamNeedsCount, teamNeedsRows } from './src/shared/teamNeeds'
export { parseRemoteClientMsg } from './src/shared/remote-protocol-schemas'
`
const EXTERNAL = ['electron', 'ws', 'qrcode', 'node-pty', '@xterm/headless', '@xterm/addon-serialize', '@xterm/addon-unicode11']
const bundleWith = (plugins) => build({
  stdin: { resolveDir: root, loader: 'ts', contents: ENTRY },
  bundle: true, platform: 'node', format: 'cjs', write: false, external: EXTERNAL, logLevel: 'silent',
  plugins, alias: { '@shared': path.join(root, 'src/shared') },
}).then((r) => r.outputFiles[0].text)

/** The clock of the sessions' windows: real time plus an offset the rate checks move forward. */
const shift = { ms: 0 }
function load(code) {
  const RealDate = Date
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + shift.ms) }
    static now() { return RealDate.now() + shift.ms }
  }
  const ctx = {
    module: { exports: {} }, require: (id) => (id === 'qrcode' ? { toDataURL: async () => 'data:' } : require(id)),
    console, process, Buffer, URL, queueMicrotask, structuredClone, TextEncoder, TextDecoder, AbortController,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
    Date: FakeDate,
  }
  ctx.exports = ctx.module.exports
  ctx.globalThis = ctx
  vm.runInNewContext(code, ctx)
  return { api: ctx.module.exports, ctx }
}

// ---- the phone side: a fake socket on a real RemoteManager ------------------------------------------------
function remoteWorld(api, ctx, o = {}) {
  const commands = []
  const webContents = { isDestroyed: () => false, setBackgroundThrottling() {}, send: (ch, cmd) => { if (ch === 'remote:controlCmd') commands.push(cmd) } }
  const pty = {
    addSink() {}, removeSink() {}, setRunningChangeListener() {}, setForcedFast() {},
    runningPaneIds: () => [], exitedPaneCodes: () => new Map(), getReplay: () => null, ptyIdForPane: () => null, write() {}, sizeOf: () => null,
  }
  const manager = new api.RemoteManager(pty, () => webContents, '2.7.0', () => [], () => 'MI-PC', () => [], o.services ?? {})
  manager.applyConfig({ enabled: true, port: 4600, ...(o.https ? { https: { enabled: true, mode: 'tailscaleServe' } } : {}) })
  manager.pushState({ workspaces: [], activeWorkspaceId: null, themeTokens: {}, language: 'es', fontFamily: '', fontSize: 14 })
  class FakeSocket {
    constructor() { this.readyState = 1; this.bufferedAmount = 0; this.inbox = []; this.sizes = []; this.handlers = {}; this.closed = null }
    on(ev, fn) { this.handlers[ev] = fn }
    send(data) { this.inbox.push(JSON.parse(data)); this.sizes.push(Buffer.byteLength(data)) }
    close(code) { this.closed = code; this.readyState = 3; this.handlers.close && this.handlers.close() }
    terminate() { this.close(1006) }
    msg(obj) { this.handlers.message(JSON.stringify({ v: 1, ...obj })) }
    of(type) { return this.inbox.filter((m) => m.type === type) }
  }
  const socket = () => { const ws = new FakeSocket(); ctx.__server.handlers.onSocket(ws, '100.64.0.9', '100.64.0.9'); return ws }
  /** Pair a phone through the pairing route. */
  const pair = async () => {
    await tick()
    const payload = await manager.pairingBegin()
    const ws = socket()
    ws.msg({ type: 'hello', clientNonce: 'aa'.repeat(32) })
    ws.msg({ type: 'pair', code: payload.code, deviceName: 'Celu' })
    manager.pairingResolve(manager.getUiState().pendingPairing.requestId, true)
    assert.ok(ws.of('paired').length === 1, 'paired')
    return ws
  }
  let seq = 0
  /**
   * One teamReq and its teamRes (the frame as received and its byte size). The long walks send more than 30 in 10 s:
   * a `rate` answer moves the sessions' clock past the window and asks again, unless `o.rate` keeps it (the rate checks).
   */
  const ask = async (ws, req, o = {}) => {
    for (;;) {
      const id = `q${++seq}`
      const from = ws.inbox.length
      ws.msg({ type: 'teamReq', id, req })
      const end = Date.now() + 20000
      let got = null
      while (!got) {
        const i = ws.inbox.findIndex((m, k) => k >= from && m.type === 'teamRes' && m.id === id)
        if (i >= 0) got = { res: ws.inbox[i].res, bytes: ws.sizes[i], raw: JSON.stringify(ws.inbox[i]) }
        else if (Date.now() > end) throw new Error(`no teamRes for ${JSON.stringify(req)}`)
        else await sleep(5)
      }
      if (o.rate || got.res.ok !== false || got.res.error !== 'rate') return got
      shift.ms += api.TEAM_REQ_WINDOW_MS + 1
    }
  }
  /** One ctl and its ctlAck. */
  const ctl = async (ws, action) => {
    const id = `c${++seq}`
    ws.msg({ type: 'ctl', id, action })
    const end = Date.now() + 20000
    for (;;) {
      const ack = ws.of('ctlAck').find((a) => a.id === id)
      if (ack) return ack
      if (Date.now() > end) throw new Error(`no ctlAck for ${JSON.stringify(action)}`)
      await sleep(5)
    }
  }
  return { manager, commands, socket, pair, ask, ctl }
}

// ---- the desktop side: the real TeamService on a temp repo ----------------------------------------------
const cleanEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(TMP, 'gitconfig') }
for (const k of Object.keys(cleanEnv)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE)$/i.test(k)) delete cleanEnv[k]
fs.writeFileSync(cleanEnv.GIT_CONFIG_GLOBAL, '[core]\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n')
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] }).toString()

function manualTimers(start = 1_800_000_000_000) {
  const c = { now: start, timers: new Map(), seq: 0 }
  c.deps = {
    now: () => c.now,
    setTimeout: (fn, ms) => { const id = ++c.seq; c.timers.set(id, { fn, at: c.now + ms }); return id },
    clearTimeout: (id) => c.timers.delete(id),
  }
  return c
}

async function teamWorld(api, w) {
  const repo = path.join(TMP, 'app')
  fs.mkdirSync(repo, { recursive: true })
  fs.writeFileSync(path.join(repo, 'README.md'), '# app\n')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  const data = path.join(TMP, 'data')
  const clock = manualTimers()
  const master = api.newToken()
  const tokens = new api.CtlTokens(master)
  const cfg = { settings: { labs: { teams: true, consoleChat: false }, language: 'es', worktreesRoot: '', notifications: { notifyAction: true, notifyDone: true, onlyWhenAway: false } } }
  const t = { cfg, emitted: [], notices: [], logs: [], master, tokens, repo, data, clock }
  t.svc = new api.TeamService({
    dataDir: () => data,
    config: () => t.cfg,
    git: api.createGitRunner({ env: () => api.gitEnv(cleanEnv) }),
    emit: (e) => { t.emitted.push(json(e)); w.manager.teamChanged(e) },
    openPath: async () => '',
    log: (l) => t.logs.push(l),
    now: () => clock.now,
    timerDeps: clock.deps,
    loader: new api.TeamDefinitionLoader({ watch: () => ({ on() { return this }, close() {} }) }),
    strict: false,
    // The live tokens of the app (CtlTokens), as index.ts wires them; no CLI here, so no run ever starts.
    cli: { envForTeam: () => ({}), revokeTeam() {}, ready: () => false, holdsToken: (s) => tokens.holdsToken(s), maskTokens: (s) => tokens.maskTokens(s) },
    notice: (n) => t.notices.push(json(n)),
  })
  await t.svc.start(cfg)
  const desk = (req) => t.svc.request(req, 'desktop')
  t.desk = desk
  const probe = await desk({ op: 'setupProbe', dir: repo })
  assert.ok(probe.ok, `setupProbe: ${JSON.stringify(probe)}`)
  const draft = { ...probe.probe.defaults, name: 'Equipo Notas', goal: 'Una app de notas', verify: '' }
  const prev = await desk({ op: 'setupPreview', repoRoot: repo, draft })
  const made = await desk({ op: 'setupWrite', repoRoot: repo, draft, previewHash: prev.preview.hash })
  assert.ok(made.ok, `setupWrite: ${JSON.stringify(made)}`)
  t.teamId = made.teamId
  t.rec = () => t.svc.team(t.teamId)
  /** Commits a runtime built in place (approvals, cards, a plan) the way a reducer result lands. */
  t.inject = (fn, scopes = ['needs', 'board']) => {
    const rec = t.rec()
    rec.store.commit({ ok: true, rt: fn(rec.store.rt), effects: [], result: undefined }, scopes)
  }
  return t
}

// ---- 1. phoneFit on crafted replies ------------------------------------------------------------------
function fitUnits(api) {
  const F = api.F
  const id = (s) => s
  const bytes = (res) => F.teamResBytes(res)
  check(api.TEAM_FRAME_MAX_BYTES === MAX && api.TEAM_REQ_MAX === 30 && api.TEAM_REQ_WINDOW_MS === 10000 && api.TEAM_REQ_IN_FLIGHT === 2, 'the B8 limits: 48 KB frames, 30 teamReq per 10 s, 2 in flight')
  check(api.RATE_LIMITED_MSG_TYPES.has('teamReq') && ['teamDecide', 'teamAnswer', 'teamDispatch'].every((k) => api.RATE_LIMITED_CTL_KINDS.has(k)), 'teamReq and the three ctls are behind the session bucket')
  // list: the desktop fields stay home.
  const item = { id: 'tm-0123456789ab', name: 'N', repoName: 'app', trust: 'trusted', paused: null, autoDispatch: false, agents: 5, running: 0, needsCount: 2, rev: 3, repoRoot: 'C:\\Users\\yo\\app', takeovers: [{ paneId: 'p1', agentId: 'dev', agentName: 'Dev', at: 1 }], workspaceId: 'w1' }
  const list = F.fitPhoneReply('list', { ok: true, teams: [item] }, id)
  check(list.ok && Object.keys(list.teams[0]).sort().join() === 'agents,autoDispatch,id,name,needsCount,paused,repoName,rev,running,trust', 'a list item travels as PhoneTeamListItem: no repoRoot, takeovers or workspaceId', list.teams[0])
  // A conflict never carries the current task; a fail keeps its reason and detail.
  const conflict = F.fitPhoneReply('task', { ok: false, error: 'conflict', reason: 'rev', current: { id: 't-1', body: 'x' } }, id)
  check(!('current' in conflict) && conflict.reason === 'rev', 'a conflict reaches the phone without `current` (the phone reloads)')
  // The task drawer: no path; a body and a plan cut and marked; comments paged with the cursor.
  const big = (n, unit = 'ñ') => unit.repeat(n)
  const comments = Array.from({ length: 50 }, (_, i) => ({ id: `m-${i + 1}`, author: 'user', authorName: 'Vos', kind: 'comment', text: big(2000, 'a'), at: i, queued: false }))
  const task = {
    id: 't-1', rev: 1, title: 'T', state: 'doing', phase: 'executing', column: 'doing', priority: 'normal', repoId: 'main', isolation: 'worktree', needsPlan: true, blockedBy: [], createdBy: 'user', createdAt: 1, updatedAt: 1, stateSince: 1, userOwned: [], needs: 0, queued: 0,
    body: big(16000), plan: { rev: 1, text: big(32000), status: 'pending', small: false, at: 1 },
    reviewInfo: { round: 0, max: 3 }, worktree: { path: 'C:\\Users\\yo\\wt\\t-1', branch: 'sn/t-1', base: 'a'.repeat(40), baseBranch: 'main', exists: true },
    comments, commentsCursor: null, commentsArchived: 0, runs: [], approvals: [{ id: 'a-1', taskId: 't-1', state: 'pending', decider: 'user', requestedBy: 'dev', at: 1, payload: { kind: 'plan', planRev: 1, small: false, text: big(32000) } }], cards: [],
  }
  const fitted = F.fitPhoneReply('task', { ok: true, task: json(task) }, id)
  const ft = fitted.task
  check(fitted.ok && bytes(fitted) <= MAX, 'a task with a 16 KB body, a 32 KB plan twice and 50 comments of 2 KB fits', bytes(fitted))
  check(!('path' in ft.worktree) && ft.worktree.branch === 'sn/t-1', 'the worktree path never travels (the branch does)')
  check(ft.body.length <= api.TEAM_PHONE_BODY_MAX && ft.truncated.body === true && task.body.startsWith(ft.body), 'the body is cut to TEAM_PHONE_BODY_MAX at most, marked truncated.body')
  check(ft.plan.text.length <= api.TEAM_PHONE_PLAN_MAX && ft.plan.truncated === true && ft.truncated.plan === true, 'the plan is cut to TEAM_PHONE_PLAN_MAX at most, marked in the plan and the task')
  check(ft.approvals[0].payload.text.length <= api.TEAM_PHONE_PLAN_MAX && ft.approvals[0].payload.truncated === true, 'the plan approval\'s text too')
  check(ft.comments.length > 0 && ft.comments.length < 50 && ft.comments.at(-1).id === 'm-50' && ft.commentsCursor === ft.comments[0].id && ft.truncated.comments === 50 - ft.comments.length, 'the newest comments that fit, the cursor at the oldest kept, truncated.comments = the ones left for Ver anteriores', { n: ft.comments.length, cursor: ft.commentsCursor })
  // Lone surrogates take 6 bytes each in JSON: the last pass still fits the frame.
  const lone = '\uD800'.repeat(8000)
  const worst = F.fitPhoneReply('comment', { ok: true, comment: { id: 'm-9', author: 'user', authorName: 'Vos', kind: 'comment', text: lone + lone, at: 1, queued: false } }, id)
  check(worst.ok && bytes(worst) <= MAX && worst.comment.id === 'm-9', 'a comment of 16000 lone surrogates (96 KB of JSON) is cut until the frame fits, its id intact', bytes(worst))
  // Too much structure: nothing left to cut answers too_big.
  const huge = { ok: true, needs: { teamId: 'tm-0123456789ab', rev: 1, trust: 'trusted', paused: null, approvals: [], cards: [], queue: Array.from({ length: 900 }, (_, i) => ({ id: `q-${i}`, agentId: 'dev', reason: 'assigned', mode: 'exec', priority: 'normal', at: i, approved: false })), tasks: {} } }
  same(F.fitPhoneReply('needs', huge, id), { ok: false, error: 'too_big' }, 'a reply whose structure alone is over 48 KB answers too_big')
  // Three pending hires that replace a role, each 400 lines of 300 characters (a Markdown paragraph per line): the last
  // pass cuts hundreds of lines of one length in a few passes, not one line per pass.
  const hireOf = (i) => ({ id: `a-${i}`, state: 'pending', decider: 'user', requestedBy: 'lead', at: 1, payload: { kind: 'hire', roleId: `ops${i}`, risks: [], diff: { rel: `roles/ops${i}.md`, status: 'modified', truncated: false, hunks: [{ oldStart: 1, newStart: 1, lines: Array.from({ length: 400 }, (_, k) => `${k % 2 ? '+' : '-'}${'p'.repeat(300)}`) }] } } })
  const hires = F.fitPhoneReply('needs', { ok: true, needs: { teamId: 'tm-0123456789ab', rev: 1, trust: 'trusted', paused: null, approvals: [1, 2, 3].map(hireOf), cards: [], queue: [], tasks: {} } }, id)
  check(hires.ok && bytes(hires) <= MAX && hires.needs.approvals.length === 3 && hires.needs.approvals.every((a) => a.payload.diff.truncated === true && a.payload.diff.hunks[0].lines.length === api.TEAM_PHONE_HIRE_LINES), 'three hire diffs of 400 long lines each fit one frame: every row kept, each diff cut and marked', hires.ok ? bytes(hires) : hires)
  decisionUnits(api, hireOf)
  // A run page: the newest whole lines, never between two rows of one line, the cursor at the oldest kept.
  const row = (offset, n, size) => ({ id: n === null ? String(offset) : `${offset}.${n}`, role: 'assistant', ts: null, blocks: [{ t: 'text', text: 'r'.repeat(size) }] })
  const items = [row(10, 0, 9000), row(10, 1, 9000), row(500, null, 9000), row(900, 0, 9000), row(900, 1, 9000), row(1300, null, 9000)]
  const page = F.fitPhoneReply('runPage', { ok: true, run: { id: 'r-0123456789ab', agentId: 'dev', roleId: 'dev', taskId: null, mode: 'free', trigger: 'manual', state: 'succeeded', provider: 'claude', resumed: false, queuedAt: 1, summary: 's'.repeat(2000) }, items, cursor: null, done: true, live: false }, id)
  check(page.ok && bytes(page) <= MAX && page.items.at(-1).id === '1300' && page.cursor === page.items[0].id.split('.')[0] && page.done === false, 'a run page keeps its newest rows, its cursor at the oldest line kept, done false', page.items.map((m) => m.id))
  check(page.items[0].id === '500' && page.cursor === '500', 'and never starts in the middle of a line: 10.1 left with 10.0, the page starts at line 500', page.items.map((m) => m.id))
  const wide = [row(10, 0, 9000), row(10, 1, 9000), row(800, 0, 13000), row(800, 1, 13000), row(800, 2, 13000), row(800, 3, 13000)]
  const one = F.fitPhoneReply('runPage', { ok: true, run: { id: 'r-0123456789ab', agentId: 'dev', roleId: 'dev', taskId: null, mode: 'free', trigger: 'manual', state: 'succeeded', provider: 'claude', resumed: false, queuedAt: 1 }, items: wide, cursor: null, done: true, live: false }, id)
  check(one.ok && bytes(one) <= MAX && one.items.map((m) => m.id).join() === '800.0,800.1,800.2,800.3' && one.cursor === '800' && one.done === false, 'a newest line that alone does not fit keeps that whole line (its texts cut), cursor at it; the older line goes to the next page', { ids: one.items.map((m) => m.id), cursor: one.cursor })
  const lonely = F.fitPhoneReply('runPage', { ok: true, run: { id: 'r-0123456789ab', agentId: 'dev', roleId: 'dev', taskId: null, mode: 'free', trigger: 'manual', state: 'succeeded', provider: 'claude', resumed: false, queuedAt: 1 }, items: [row(7, null, 60000)], cursor: null, done: true, live: false }, id)
  check(lonely.ok && bytes(lonely) <= MAX && lonely.items.length === 1 && lonely.items[0].blocks[0].truncated === true, 'a lone row past the budget is shrunk and marked truncated')
  // The masks: every string, deep.
  const masked = F.maskDeep({ a: 'x ghp_' + 'A'.repeat(36), b: ['y', { c: 'z' }], n: 3 }, (s) => s.replace(/ghp_[A-Za-z0-9]+/g, '[redacted]').replace('z', 'Z'))
  check(masked.a === 'x [redacted]' && masked.b[1].c === 'Z' && masked.n === 3, 'maskDeep masks every string of the reply, deep')
  // The ctls: requests and acks.
  same(F.teamCtlRequest({ kind: 'teamDecide', teamId: 'tm-0123456789ab', approvalId: 'a-1', decision: 'reject', note: 'n', extra: 1 }), { op: 'decide', teamId: 'tm-0123456789ab', approvalId: 'a-1', decision: 'reject', note: 'n' }, 'teamDecide -> the decide op, field by field')
  same(F.teamCtlRequest({ kind: 'teamDecide', teamId: 'tm-0123456789ab', approvalId: 'a-1', decision: 'approve', rev: 3 }), { op: 'decide', teamId: 'tm-0123456789ab', approvalId: 'a-1', decision: 'approve', rev: 3 }, 'teamDecide carries the rev of the approval the phone showed to the decide op (Tanda B close)')
  same(F.teamCtlRequest({ kind: 'teamDispatch', teamId: 'tm-0123456789ab', queueId: 'all', go: true }), { op: 'dispatch', teamId: 'tm-0123456789ab', queueId: 'all', go: true }, 'teamDispatch -> the dispatch op')
  same([F.teamCtlResult({ ok: true, approved: ['q-1'], dropped: [] }), F.teamCtlResult({ ok: false, error: 'conflict', reason: 'already_decided' }), F.teamCtlResult({ ok: false, error: 'bad_request', detail: 'nothingToGrant' }), F.teamCtlResult({ ok: false, error: 'busy', detail: 'C:\\x' })],
    [{ id: '', ok: true }, { id: '', ok: false, error: 'conflict:already_decided' }, { id: '', ok: false, error: 'bad_request:nothingToGrant' }, { id: '', ok: false, error: 'busy' }], 'acks: ok; a conflict with its reason; a detail the phone words; any other detail never travels')
  same(F.teamCtlResult({ ok: false, error: 'bad_request', detail: 'grantsFull' }), { id: '', ok: false, error: 'bad_request:grantsFull' }, 'a permission approve the task\'s full grants refuse: bad_request:grantsFull (the phone has its words)')
  // fitTeamRes: the real envelope.
  const fine = api.fitTeamRes('q1', { ok: true, teams: [] })
  check(fine.res.ok && fine.type === 'teamRes' && fine.id === 'q1' && fine.v === 1, 'fitTeamRes passes a reply that fits')
  same(api.fitTeamRes('q2', { ok: true, comment: { text: 'x'.repeat(MAX) } }).res, { ok: false, error: 'too_big' }, 'and answers too_big for one that would not')
}
function same(actual, expected, label) {
  assert.deepEqual(json(actual), json(expected), label)
  checks++
}

/**
 * Tanda B close (findings 13 and 16): the last pass never cuts what the user decides on (a pending permission's rules
 * and denied commands, a pending final OK's summary, an open card's question and options). A frame that cannot carry
 * them whole sends the heaviest such row read only (pcOnly: "En la PC", no Aprobar), its cut texts marked truncated.
 */
function decisionUnits(api, hireOf) {
  const F = api.F
  const id = (s) => s
  const bytes = (res) => F.teamResBytes(res)
  const needsOf = (approvals, cards = []) => ({ ok: true, needs: { teamId: 'tm-0123456789ab', rev: 1, trust: 'trusted', paused: null, approvals, cards, queue: [], tasks: {} } })
  const perm = (aid, tools, denied) => ({ id: aid, taskId: 't-1', state: 'pending', decider: 'user', requestedBy: 'dev', at: 1, rev: 1, payload: { kind: 'permission', roleId: 'dev', tools, ...(denied ? { denied } : {}) } })
  const fin = (aid, summary, state = 'pending') => ({ id: aid, taskId: 't-2', state, decider: 'user', requestedBy: 'qa', at: 1, rev: 1, payload: { kind: 'final', summary } })
  const card = (cid, question, options) => ({ id: cid, taskId: 't-1', agentId: 'dev', kind: 'choice', state: 'open', at: 1, question, options, multi: false })
  // A 131 character exact rule: the flag the user must read sits past where the water level would cut it.
  const rule = `Bash(npm run ${'build:web-'.repeat(10)} --flag=yyyyyyyyy)`
  const denied = Array.from({ length: 3 }, (_, i) => `npm run ${'build:web-'.repeat(25)} --try=${i}`.slice(0, 300))
  const question = `¿Qué base de datos usamos? ${'Contame por qué, ñandú. '.repeat(32)}`.slice(0, 800)
  const options = ['sqlite '.repeat(17).slice(0, 120), 'postgres '.repeat(14).slice(0, 120)]
  const summary = 'Listo: '.repeat(215).slice(0, 1500)
  check(rule.length === 131, 'the rule is 131 characters')
  const src = needsOf([1, 2, 3].map(hireOf).concat([perm('a-10', [rule], denied), fin('a-11', summary)]), [card('k-10', question, options)])
  check(bytes(src) > MAX, 'the needs view (three long hires, a permission, a final OK, a card) is over 48 KB')
  const out = F.fitPhoneReply('needs', json(src), id)
  const ap = (aid) => out.needs.approvals.find((a) => a.id === aid)
  check(out.ok && bytes(out) <= MAX, 'it fits one frame', out.ok ? bytes(out) : out)
  check(ap('a-10').payload.tools[0] === rule && ap('a-10').payload.denied.join('\n') === denied.join('\n'), 'a long rule and its denied commands next to three hire diffs arrive whole (the last pass used to cut them with no mark)', ap('a-10').payload)
  check(ap('a-11').payload.summary === summary && out.needs.cards[0].question === question && out.needs.cards[0].options.join() === options.join(), 'so do a final OK\'s summary and a card\'s question and options')
  check(!('pcOnly' in ap('a-10')) && !('pcOnly' in ap('a-11')) && !('pcOnly' in out.needs.cards[0]) && !('truncated' in ap('a-10').payload) && !('truncated' in ap('a-11').payload) && !('truncated' in out.needs.cards[0]), 'nothing goes read only nor reads as cut while the rest can give way')
  check([1, 2, 3].every((i) => ap(`a-${i}`).payload.diff.truncated === true && ap(`a-${i}`).payload.diff.hunks[0].lines[0].length < 301), 'the hire diffs give way instead (cut and marked)')

  // The decisions alone are over the frame: the heaviest goes read only first, cut and marked; the rest arrive whole.
  const bigSummary = 'ś'.repeat(30000)
  const heavy = F.fitPhoneReply('needs', json(needsOf([fin('a-20', bigSummary), perm('a-21', [rule], denied)], [card('k-21', question, options)])), id)
  const ha = (aid) => heavy.needs.approvals.find((a) => a.id === aid)
  check(heavy.ok && bytes(heavy) <= MAX, 'a final OK whose summary alone is over 48 KB still fits', heavy.ok ? bytes(heavy) : heavy)
  check(ha('a-20').pcOnly === true && ha('a-20').payload.truncated === true && ha('a-20').payload.summary.length < bigSummary.length && bigSummary.startsWith(ha('a-20').payload.summary), 'that approval goes read only (pcOnly: "En la PC", no Aprobar) and its cut summary is marked truncated ("Sigue en la PC")', { pcOnly: ha('a-20').pcOnly, truncated: ha('a-20').payload.truncated })
  check(!('pcOnly' in ha('a-21')) && ha('a-21').payload.tools[0] === rule && !('pcOnly' in heavy.needs.cards[0]) && heavy.needs.cards[0].question === question, 'the other rows stay decidable, whole')

  // Sixteen permission approvals of 32 rules and 10 denied commands each: only as many go read only as the frame needs.
  const rules = (n) => Array.from({ length: 32 }, (_, i) => `Bash(npm run task-${n}-${i} ${'x'.repeat(100)})`)
  const lines = (n) => Array.from({ length: 10 }, (_, i) => `npm run task-${n}-${i} ${'y'.repeat(280)}`)
  const crowd = F.fitPhoneReply('needs', json(needsOf(Array.from({ length: 16 }, (_, n) => perm(`a-${30 + n}`, rules(n), lines(n))))), id)
  const pc = crowd.ok ? crowd.needs.approvals.filter((a) => a.pcOnly === true) : []
  const live = crowd.ok ? crowd.needs.approvals.filter((a) => a.pcOnly !== true) : []
  check(crowd.ok && bytes(crowd) <= MAX && crowd.needs.approvals.length === 16, 'sixteen permission approvals of 32 long rules each fit one frame, every row kept', crowd.ok ? bytes(crowd) : crowd)
  check(pc.length > 0 && live.length > 0 && pc.every((a) => a.payload.truncated === true), `the ones that cannot travel whole go read only, marked truncated (${pc.length} of 16)`)
  check(live.every((a) => { const n = Number(a.id.slice(2)) - 30; return a.payload.tools.join() === rules(n).join() && a.payload.denied.join() === lines(n).join() && !('truncated' in a.payload) }), 'every row left to decide on the phone carries its rules and denied commands whole')

  // A permission of 32 short rules (each under 64 characters: going read only frees nothing of it) next to many long
  // questions: it is the heaviest row, yet it arrives whole and stays decidable; questions go read only instead.
  const shortRules = Array.from({ length: 32 }, (_, i) => `Bash(npm run task-${String(i).padStart(2, '0')}-${'x'.repeat(30)})`)
  const shortDenied = Array.from({ length: 10 }, (_, i) => `npm run task-${i} ${'y'.repeat(40)}`)
  const asks = Array.from({ length: 24 }, (_, n) => card(`k-${40 + n}`, `q${n} ${'w'.repeat(1000)}`, ['a', 'b']))
  const short = F.fitPhoneReply('needs', json(needsOf([1, 2, 3].map(hireOf).concat([perm('a-50', shortRules, shortDenied)]), asks)), id)
  const sp = short.ok ? short.needs.approvals.find((a) => a.id === 'a-50') : null
  check(short.ok && bytes(short) <= MAX && short.needs.cards.some((c) => c.pcOnly === true && c.truncated === true), 'many long questions next to a permission of 32 short rules fit one frame, some questions read only and marked', short.ok ? bytes(short) : short)
  check(!('pcOnly' in sp) && !('truncated' in sp.payload) && sp.payload.tools.join() === shortRules.join() && sp.payload.denied.join() === shortDenied.join(), 'that permission, with nothing a cut could free, arrives whole and stays decidable (never read only while whole)', sp)

  // A decided final OK in the task drawer: its summary may be cut (nothing to decide), and then it says so.
  const done = {
    id: 't-2', rev: 1, title: 'T', state: 'done', phase: 'none', column: 'done', priority: 'normal', repoId: 'main', isolation: 'worktree', needsPlan: false, blockedBy: [], createdBy: 'user', createdAt: 1, updatedAt: 1, stateSince: 1, userOwned: [], needs: 0, queued: 0,
    body: 'b', reviewInfo: { round: 0, max: 3 }, comments: [], commentsCursor: null, commentsArchived: 0, runs: [], approvals: [fin('a-40', bigSummary, 'approved')], cards: [],
  }
  const drawer = F.fitPhoneReply('task', { ok: true, task: json(done) }, id)
  const df = drawer.ok ? drawer.task.approvals[0] : null
  check(drawer.ok && bytes(drawer) <= MAX && df.payload.summary.length < bigSummary.length && df.payload.truncated === true && !('pcOnly' in df), 'a decided final OK\'s summary cut in the task drawer carries truncated (and no pcOnly: nothing to decide)', df && { truncated: df.payload.truncated, len: df.payload.summary.length })
}

// ---- 2. the world: frames, masking, paging --------------------------------------------------------------
async function worldChecks(api, ctx) {
  const w = remoteWorld(api, ctx)
  const t = await teamWorld(api, w)
  w.manager.setTeams(t.svc.remoteView)
  const ws = await w.pair()
  const relayed0 = w.commands.length
  const TEAM = t.teamId
  const secret = 'ghp_' + 'Q7'.repeat(18)
  const piece = t.master.slice(10, 40)

  // list
  const L = await w.ask(ws, { op: 'list' })
  check(L.res.ok && L.res.teams.length === 1 && L.res.teams[0].id === TEAM && !('repoRoot' in L.res.teams[0]) && !('takeovers' in L.res.teams[0]) && L.bytes <= MAX, 'list: the team, without repoRoot or takeovers', L.res)
  check(!L.raw.includes(t.repo) && !L.raw.includes(t.repo.replace(/\\/g, '\\\\')), 'no desktop path in the list frame')

  // 300 tasks in todo, long titles (one with a credential), then the phone pages the column.
  for (let i = 1; i <= 300; i++) {
    const title = `Tarea ${i}: ${i === 7 ? `${secret} ` : ''}${'ñandú y acción, '.repeat(11)}`.slice(0, 200)
    const r = await t.desk({ op: 'createTask', teamId: TEAM, task: { title } })
    assert.ok(r.ok, `createTask ${i}: ${JSON.stringify(r)}`)
  }
  const deskTodo = await t.desk({ op: 'board', teamId: TEAM, column: 'todo', limit: 500 })
  check(deskTodo.ok && deskTodo.page.tasks.length === 300, 'the desktop board holds 300 todo tasks')
  check(JSON.stringify(deskTodo).includes(secret), 'the desktop board carries the title as it is (the renderer is local)')
  const seen = []
  let cursor
  let pages = 0
  let firstPage = null
  for (;;) {
    const r = await w.ask(ws, { op: 'board', teamId: TEAM, column: 'todo', ...(cursor ? { cursor } : {}) })
    assert.ok(r.res.ok, `board page ${pages}: ${JSON.stringify(r.res).slice(0, 300)}`)
    pages++
    firstPage ??= r
    check(r.bytes <= MAX, `board page ${pages} fits 48 KB as sent (${r.bytes} bytes)`)
    check(!r.raw.includes(secret) && !r.raw.includes('ghp_'), `board page ${pages} carries no credential`)
    seen.push(...r.res.page.tasks.map((x) => x.id))
    if (r.res.page.done) break
    cursor = r.res.page.cursor
    assert.ok(cursor && pages < 50, 'a page that is not done names its cursor')
  }
  check(firstPage.res.page.tasks.length < api.TEAM_BOARD_PAGE && firstPage.res.page.cursor !== null, `150 summaries do not fit: the first page holds ${firstPage.res.page.tasks.length} with a cursor (asked again with a smaller limit)`)
  check(pages >= 3 && seen.length === 300 && new Set(seen).size === 300 && seen.join() === deskTodo.page.tasks.map((x) => x.id).join(), `the cursor walks the 300 tasks once each, in the desktop's order (${pages} pages)`)
  check(firstPage.res.page.counts.todo === 300, 'every page counts the whole column')
  const all = await w.ask(ws, { op: 'board', teamId: TEAM })
  check(all.res.ok && all.bytes <= MAX && all.res.page.tasks.length < 300 && all.res.page.cursor === null && all.res.page.done === false, 'a page without a column that does not fit comes cut, cursor null and done false (the phone pages by column)', { n: all.res.page.tasks.length, bytes: all.bytes })

  // A task with a 16 KB body and 200 comments (one with a credential, one with a piece of the master token).
  const body = `Descripción ${secret}\n` + Array.from({ length: 800 }, (_, i) => `línea ${i} ñandú y acción`).join('\n')
  const made = await t.desk({ op: 'createTask', teamId: TEAM, task: { title: 'La tarea larga', body: body.slice(0, 16000) } })
  assert.ok(made.ok, JSON.stringify(made))
  const TID = made.task.id
  for (let i = 1; i <= 200; i++) {
    const text = `Comentario ${i} ${i === 50 ? secret : ''}${i === 120 ? `token ${piece}` : ''} ${'é'.repeat(900)}`
    const r = await t.desk({ op: 'comment', teamId: TEAM, taskId: TID, text })
    assert.ok(r.ok, `comment ${i}: ${JSON.stringify(r)}`)
  }
  const deskTask = await t.desk({ op: 'task', teamId: TEAM, taskId: TID })
  check(deskTask.ok && deskTask.task.body.length === 16000 && Buffer.byteLength(JSON.stringify(deskTask)) > MAX, 'the desktop task view is over 48 KB (the whole body, 50 comments)')
  const T1 = await w.ask(ws, { op: 'task', teamId: TEAM, taskId: TID })
  check(T1.res.ok && T1.bytes <= MAX, `the phone task fits 48 KB as sent (${T1.bytes} bytes)`)
  check(T1.res.task.body.length <= api.TEAM_PHONE_BODY_MAX && T1.res.task.truncated.body === true, 'its body is cut to TEAM_PHONE_BODY_MAX and marked: "Sigue en la PC"')
  const collected = [...T1.res.task.comments.map((c) => c.id)]
  let before = T1.res.task.commentsCursor
  let cpages = 1
  let raws = T1.raw
  while (before) {
    const r = await w.ask(ws, { op: 'task', teamId: TEAM, taskId: TID, commentsBefore: before })
    assert.ok(r.res.ok, JSON.stringify(r.res).slice(0, 300))
    cpages++
    check(r.bytes <= MAX, `Ver anteriores page ${cpages} fits 48 KB (${r.bytes} bytes)`)
    raws += r.raw
    collected.unshift(...r.res.task.comments.map((c) => c.id))
    before = r.res.task.commentsCursor
    assert.ok(cpages < 100, 'the comment cursor ends')
  }
  const ids = deskTaskComments(t, TID)
  check(collected.length === 200 && new Set(collected).size === 200 && collected.join() === ids.join(), `Ver anteriores reads all 200 comments once each, oldest first (${cpages} pages)`)
  check(!raws.includes(secret) && !raws.includes(piece) && raws.includes('[redacted]'), 'no frame of the task carries the credential or the piece of a live token: both masked')
  check(JSON.stringify(deskTask).includes(secret), 'while the desktop view still has the credential (redaction is for what leaves the PC)')

  // Te necesita: a hire of 2500 lines, a 32 KB plan, two permission asks, an integrate, a resumeTeam card.
  const now = t.clock.now
  const planTask = (await t.desk({ op: 'createTask', teamId: TEAM, task: { title: 'Plan grande', assignee: 'dev' } })).task.id
  const roleText = '---\nname: Ops\nkind: custom\nprovider: claude\npermission: readonly\ncount: 1\n---\n\n' + Array.from({ length: 2500 }, (_, i) => `Regla ${i}: revisá todo, ñandú.`).join('\n') + '\n'
  const system = { kind: 'system' }
  // Tanda B close: a task whose grants are at GRANTS_MAX (every role counts), for a permission none of whose rules can land.
  const fullTask = (await t.desk({ op: 'createTask', teamId: TEAM, task: { title: 'Sin lugar para reglas', assignee: 'dev' } })).task.id
  const fullGrants = Array.from({ length: 32 }, (_, i) => ({ roleId: 'qa', tool: `Bash(make t${i})`, at: now, approvalId: 'a-1' }))
  t.inject((rt) => ({
    ...rt,
    tasks: rt.tasks.map((x) => (x.id === planTask ? { ...x, plan: { rev: 1, text: `# Plan ${secret}\n` + 'paso ñandú y acción\n'.repeat(1700), status: 'pending', small: false, at: now } } : x.id === fullTask ? { ...x, grants: fullGrants } : x)),
    approvals: [
      ...rt.approvals,
      { id: 'a-901', kind: 'hire', state: 'pending', decider: 'user', createdAt: now, createdBy: system, payload: { roleId: 'ops', text: roleText, sha256: 'b'.repeat(64), baseDefHash: 'c'.repeat(64), replaces: false } },
      { id: 'a-902', kind: 'plan', taskId: planTask, state: 'pending', decider: 'user', createdAt: now, createdBy: system, payload: { planRev: 1, small: false } },
      { id: 'a-903', kind: 'permission', taskId: planTask, state: 'pending', decider: 'user', createdAt: now, createdBy: system, payload: { roleId: 'dev', runId: 'r-0123456789ab', tools: ['Bash(npm test:*)'] } },
      { id: 'a-904', kind: 'permission', taskId: planTask, state: 'pending', decider: 'user', createdAt: now, createdBy: system, payload: { roleId: 'dev', runId: 'r-0123456789ab', tools: ['PowerShell(npm test:*)'] } },
      { id: 'a-905', kind: 'integrate', taskId: planTask, state: 'pending', decider: 'user', createdAt: now, createdBy: system, payload: { branch: 'sn/t-x', base: 'main' } },
      // Tanda B close: a permission a later run grew (rev 2), and one on the task with no room left for grants.
      { id: 'a-906', kind: 'permission', taskId: planTask, rev: 2, state: 'pending', decider: 'user', createdAt: now, createdBy: system, payload: { roleId: 'qa', runId: 'r-0123456789ab', tools: ['Bash(npm test:*)', 'Bash(npm run lint:*)'] } },
      { id: 'a-907', kind: 'permission', taskId: fullTask, state: 'pending', decider: 'user', createdAt: now, createdBy: system, payload: { roleId: 'dev', runId: 'r-0123456789ab', tools: ['Bash(npm test:*)'] } },
    ],
    cards: [...rt.cards, { id: 'k-901', kind: 'confirm', question: '', options: [], multi: false, state: 'open', from: { kind: 'system', why: 'auth', actions: ['resumeTeam', 'dismiss'] }, createdAt: now }],
  }))
  const deskNeeds = await t.desk({ op: 'needs', teamId: TEAM })
  check(deskNeeds.ok && deskNeeds.needs.approvals.some((a) => a.id === 'a-901') && Buffer.byteLength(JSON.stringify(deskNeeds)) > MAX, 'the desktop Te necesita (a 2500 line hire, a 32 KB plan) is over 48 KB')
  const N = await w.ask(ws, { op: 'needs', teamId: TEAM })
  check(N.res.ok && N.bytes <= MAX, `the phone Te necesita fits 48 KB as sent (${N.bytes} bytes)`)
  const hire = N.res.needs.approvals.find((a) => a.id === 'a-901')
  const lines = hire.payload.diff.hunks.reduce((n, h) => n + h.lines.length, 0)
  check(lines > 0 && lines <= api.TEAM_PHONE_HIRE_LINES && hire.payload.diff.truncated === true, `the hire diff is cut to ${api.TEAM_PHONE_HIRE_LINES} lines at most and marked (${lines})`)
  const plan = N.res.needs.approvals.find((a) => a.id === 'a-902')
  check(plan.payload.text.length > 0 && plan.payload.text.length <= api.TEAM_PHONE_PLAN_MAX && plan.payload.truncated === true && !N.raw.includes(secret), 'the plan is cut and marked, its credential masked')
  check(N.res.needs.approvals.length === deskNeeds.needs.approvals.length && N.res.needs.cards.length === deskNeeds.needs.cards.length && api.teamNeedsCount(N.res.needs) === api.teamNeedsCount(deskNeeds.needs), 'the phone gets every row: the same Te necesita count as the desktop')
  const grown = N.res.needs.approvals.find((a) => a.id === 'a-906')
  check(grown.rev === 2 && N.res.needs.approvals.find((a) => a.id === 'a-903').rev === 1, 'each approval reaches the phone with its rev (a permission a later run grew: 2)', grown)

  // The ctls, handled in main, never relayed.
  const relayed = w.commands.length
  const hireAck = await w.ctl(ws, { kind: 'teamDecide', teamId: TEAM, approvalId: 'a-901', decision: 'approve' })
  check(hireAck.ok === false && hireAck.error === 'forbidden', 'teamDecide on a hire approval: forbidden (it rewrites a role file and trusts it: PC only)', hireAck)
  const intAck = await w.ctl(ws, { kind: 'teamDecide', teamId: TEAM, approvalId: 'a-905', decision: 'approve' })
  check(intAck.ok === false && intAck.error === 'bad_request', 'teamDecide on an integrate approval: bad_request (only the PC lands it)', intAck)
  const resumeAck = await w.ctl(ws, { kind: 'teamAnswer', teamId: TEAM, cardId: 'k-901', answer: { action: 'resumeTeam' } })
  check(resumeAck.ok === false && resumeAck.error === 'forbidden', 'teamAnswer with resumeTeam: forbidden (it lifts an auth or billing pause: PC only)', resumeAck)
  const nothing = await w.ctl(ws, { kind: 'teamDecide', teamId: TEAM, approvalId: 'a-904', decision: 'approve', rev: 1 })
  check(nothing.ok === false && nothing.error === 'bad_request:nothingToGrant', 'a permission with no rule left to grant: bad_request:nothingToGrant (the phone has its words)', nothing)
  const rej = await w.ctl(ws, { kind: 'teamDecide', teamId: TEAM, approvalId: 'a-903', decision: 'reject', rev: 1 })
  check(rej.ok === true && t.rec().store.rt.approvals.find((a) => a.id === 'a-903').state === 'rejected' && t.rec().store.rt.approvals.find((a) => a.id === 'a-903').decidedBy.via === 'phone', 'teamDecide reject of a permission: ok, decided by the user via the phone', rej)
  const again = await w.ctl(ws, { kind: 'teamDecide', teamId: TEAM, approvalId: 'a-903', decision: 'approve', rev: 1 })
  check(again.ok === false && again.error === 'conflict:already_decided', 'a second decide: conflict:already_decided', again)
  // Tanda B close: a permission decide is bound to the rev the phone showed; the ctl carries it to the decide op.
  const older = await w.ctl(ws, { kind: 'teamDecide', teamId: TEAM, approvalId: 'a-906', decision: 'approve', rev: 1 })
  const bare = await w.ctl(ws, { kind: 'teamDecide', teamId: TEAM, approvalId: 'a-906', decision: 'approve' })
  check(older.ok === false && older.error === 'conflict:stale' && bare.ok === false && bare.error === 'conflict:stale' && t.rec().store.rt.approvals.find((a) => a.id === 'a-906').state === 'pending', 'a permission decided at an older rev, or with none: conflict:stale and nothing changes (the phone reloads Te necesita)', { older, bare })
  const atRev = await w.ctl(ws, { kind: 'teamDecide', teamId: TEAM, approvalId: 'a-906', decision: 'reject', rev: grown.rev })
  check(atRev.ok === true && t.rec().store.rt.approvals.find((a) => a.id === 'a-906').state === 'rejected', 'with the rev it showed, the decide goes through', atRev)
  const full = await w.ctl(ws, { kind: 'teamDecide', teamId: TEAM, approvalId: 'a-907', decision: 'approve', rev: 1 })
  check(full.ok === false && full.error === 'bad_request:grantsFull' && t.rec().store.rt.approvals.find((a) => a.id === 'a-907').state === 'pending', 'an approve on a task whose grants are full: bad_request:grantsFull (the phone has its words), still pending', full)
  const dismiss = await w.ctl(ws, { kind: 'teamAnswer', teamId: TEAM, cardId: 'k-901', answer: { action: 'dismiss' } })
  check(dismiss.ok === true && t.rec().store.rt.cards.find((c) => c.id === 'k-901').state !== 'open', 'teamAnswer dismiss of that card: ok', dismiss)
  const unknown = await w.ctl(ws, { kind: 'teamDecide', teamId: TEAM, approvalId: 'a-999', decision: 'approve' })
  const otherTeam = await w.ctl(ws, { kind: 'teamAnswer', teamId: 'tm-ffffffffffff', cardId: 'k-1', answer: { confirm: true } })
  check(unknown.error === 'not_found' && otherTeam.error === 'not_found', 'an unknown approval or team: not_found')
  const dispatch = await w.ctl(ws, { kind: 'teamDispatch', teamId: TEAM, queueId: 'all', go: false })
  check(dispatch.ok === true, 'teamDispatch of all (drop): ok', dispatch)
  check(w.commands.length === relayed && w.commands.length === relayed0, 'none of the ctls (nor any teamReq) reached the renderer relay')
  const direct = await Promise.all([
    t.svc.request({ op: 'decide', teamId: TEAM, approvalId: 'a-903', decision: 'approve' }, 'phone'),
    t.svc.request({ op: 'answer', teamId: TEAM, cardId: 'k-901', answer: { action: 'dismiss' } }, 'phone'),
    t.svc.request({ op: 'dispatch', teamId: TEAM, queueId: 'all', go: false }, 'phone'),
  ])
  check(direct.every((r) => r.ok === false && r.error === 'bad_request'), 'TeamService.request from the phone still refuses decide, answer and dispatch: only remoteView.ctl lets the three ctls past PHONE_TEAM_OPS', direct)

  // Writes from the phone: createTask, comment, leadSay; each change reaches the phone as teamChanged.
  const tc0 = ws.of('teamChanged').length
  const nt = await w.ask(ws, { op: 'createTask', teamId: TEAM, task: { title: 'Desde el celu', body: 'Dictado', priority: 'high' } })
  check(nt.res.ok && nt.res.task.createdBy === 'user' && nt.res.task.priority === 'high', 'createTask from the phone: a todo task of the user')
  const cm = await w.ask(ws, { op: 'comment', teamId: TEAM, taskId: nt.res.task.id, text: 'Mirá esto' })
  check(cm.res.ok && cm.res.comment.text === 'Mirá esto', 'comment from the phone')
  await sleep(700)
  const changes = ws.of('teamChanged').slice(tc0)
  check(changes.length >= 1 && changes.every((c) => c.teamId === TEAM && typeof c.rev === 'number') && changes.some((c) => (c.scopes ?? []).includes('board')), 'the phone hears of those changes as teamChanged (board scope)', changes)

  // The Lead thread: 60 messages of 3 KB, paged.
  for (let i = 1; i <= 60; i++) {
    const r = await t.desk({ op: 'leadSay', teamId: TEAM, text: `Mensaje ${i} ${'ü'.repeat(1500)}` })
    assert.ok(r.ok, JSON.stringify(r))
  }
  const said = await w.ask(ws, { op: 'leadSay', teamId: TEAM, text: 'Hola Líder' })
  check(said.res.ok && said.res.comment.text === 'Hola Líder', 'leadSay from the phone')
  const leadIds = []
  let lb
  let lpages = 0
  for (;;) {
    const r = await w.ask(ws, { op: 'lead', teamId: TEAM, ...(lb ? { before: lb } : {}) })
    assert.ok(r.res.ok, JSON.stringify(r.res).slice(0, 200))
    lpages++
    check(r.bytes <= MAX, `Lead page ${lpages} fits 48 KB (${r.bytes} bytes)`)
    leadIds.unshift(...r.res.lead.messages.map((m) => m.id))
    lb = r.res.lead.cursor
    if (!lb) break
    assert.ok(lpages < 50, 'the Lead cursor ends')
  }
  const leadAll = (t.rec().store.rt.comments.lead ?? []).map((c) => c.id)
  check(lpages >= 2 && leadIds.join() === leadAll.join(), `the Lead thread walks every message once, oldest first (${leadAll.length} in ${lpages} pages)`)

  // A run page walk: every row once, each frame <= 48 KB.
  const runId = 'r-00000000feed'
  const runFile = path.join(t.data, 'teams', TEAM, 'runs', `${runId}.jsonl`)
  fs.mkdirSync(path.dirname(runFile), { recursive: true })
  const runLines = [JSON.stringify({ type: 'snaos.prompt', at: new Date(now).toISOString(), mode: 'free', trigger: 'manual', text: `Hacé algo ${secret}` })]
  for (let i = 0; i < 120; i++) runLines.push(JSON.stringify({ type: 'assistant', message: { id: `msg_${i}`, role: 'assistant', content: [{ type: 'text', text: `Respuesta ${i} ${i === 3 ? piece : ''}${'ä'.repeat(2400)}` }] }, session_id: '00000001-0000-4000-8000-000000000000' }))
  fs.writeFileSync(runFile, runLines.join('\n') + '\n')
  t.rec().store.recordRun({ id: runId, agentId: 'dev', roleId: 'dev', roleKind: 'dev', sessionKey: 'free', provider: 'claude', profile: 'readonly', resumed: false, cwd: t.repo, repoId: 'main', mode: 'free', trigger: { reason: 'manual', by: 'user' }, state: 'succeeded', outcome: 'progress', reachedRunning: true, resultSeen: true, queuedAt: now - 5000, startedAt: now - 4000, endedAt: now - 1000, summary: `Listo ${secret} ${'s'.repeat(1900)}` })
  const walk = async (askPage) => {
    const out = []
    let b
    let n = 0
    const sizes = []
    let text = ''
    for (;;) {
      const r = await askPage(b)
      assert.ok(r.res.ok, JSON.stringify(r.res).slice(0, 200))
      n++
      sizes.push(r.bytes)
      text += r.raw
      out.unshift(...r.res.items.map((m) => m.id))
      b = r.res.cursor
      if (!b || r.res.done) break
      assert.ok(n < 100, 'the run cursor ends')
    }
    return { ids: out, pages: n, sizes, text }
  }
  const deskRun = await walk(async (b) => { const res = await t.desk({ op: 'runPage', teamId: TEAM, runId, ...(b ? { before: b } : {}) }); return { res, bytes: Buffer.byteLength(JSON.stringify(res)), raw: JSON.stringify(res) } })
  const phoneRun = await walk((b) => w.ask(ws, { op: 'runPage', teamId: TEAM, runId, ...(b ? { before: b } : {}) }))
  check(deskRun.ids.length === 121 && new Set(deskRun.ids).size === 121, `the desktop pages read the 121 rows of the run (${deskRun.ids.length})`)
  check(phoneRun.sizes.every((s) => s <= MAX), `every phone run page fits 48 KB as sent (${phoneRun.sizes.join(', ')})`)
  check(phoneRun.ids.join() === deskRun.ids.join(), `the phone walk reads the same rows once each, in order (${phoneRun.pages} pages)`)
  check(!phoneRun.text.includes(secret) && !phoneRun.text.includes(piece), 'no run page (rows or summary) carries the credential or the token piece')

  // Limits: 30 per 10 s per session, then rate; 2 in flight.
  const ws2 = await w.pair()
  shift.ms += api.TEAM_REQ_WINDOW_MS + 1
  const answers = []
  for (let i = 0; i < 31; i++) answers.push((await w.ask(ws2, { op: 'list' }, { rate: true })).res)
  check(answers.slice(0, 30).every((r) => r.ok) && answers[30].ok === false && answers[30].error === 'rate' && ws2.closed === null, 'the 31st teamReq in 10 s answers rate, no strike, the socket stays')
  shift.ms += api.TEAM_REQ_WINDOW_MS + 1
  check((await w.ask(ws2, { op: 'list' })).res.ok, 'once the window passes teamReq answers again')
  const waiting = []
  w.manager.setTeams({ request: () => new Promise((resolve) => waiting.push(resolve)), ctl: t.svc.remoteView.ctl })
  const pending = [w.ask(ws2, { op: 'list' }, { rate: true }), w.ask(ws2, { op: 'list' }, { rate: true })]
  await sleep(20)
  const third = await w.ask(ws2, { op: 'list' }, { rate: true })
  check(waiting.length === 2 && third.res.error === 'rate', 'with 2 teamReq in flight the third answers rate at once')
  for (const resolve of waiting) resolve({ ok: true, teams: [] })
  check((await Promise.all(pending)).every((r) => r.res.ok), 'the two waiting ones answer when main does')
  w.manager.setTeams(t.svc.remoteView)

  // The notices: a new need row gave a TeamNotice of main's words with the push tag.
  const n = t.notices.find((x) => x.tag === `team:${TEAM}:a-901`)
  check(n && n.kind === 'team' && n.teamId === TEAM && n.push === true && !JSON.stringify(t.notices).includes(secret), 'a new need row (the hire) gave one TeamNotice, tag team:<teamId>:<rowId>, push true, never agent text', n)

  // Labs off: disabled to the phone too.
  t.cfg = { ...t.cfg, settings: { ...t.cfg.settings, labs: { teams: false, consoleChat: false } } }
  t.svc.setConfig(t.cfg)
  await sleep(50)
  const off = await w.ask(ws, { op: 'list' })
  const offCtl = await w.ctl(ws, { kind: 'teamDispatch', teamId: TEAM, queueId: 'all', go: false })
  check(off.res.ok === false && off.res.error === 'disabled' && offCtl.ok === false && offCtl.error === 'disabled', 'Labs off: teamReq answers disabled and a ctl acks disabled')
  check(w.commands.length === relayed0, 'nothing ever reached the renderer relay')
  t.svc.dispose()
  w.manager.applyConfig({ enabled: false, port: 4600 })
  return w
}

/** Every comment id of a task the runtime holds, oldest first. */
function deskTaskComments(t, taskId) {
  return (t.rec().store.rt.comments[taskId] ?? []).map((c) => c.id)
}

// ---- 3. teamChanged throttle -------------------------------------------------------------------------
async function throttleChecks(api, ctx) {
  const w = remoteWorld(api, ctx)
  const ws = await w.pair()
  const T = 'tm-aaaaaaaaaaaa'
  const frames = () => ws.of('teamChanged').filter((f) => f.teamId === T)
  check(api.TEAM_CHANGED_THROTTLE_MS === 500, 'one teamChanged per team per 500 ms')
  w.manager.teamChanged({ teamId: T, rev: 1, scopes: ['board'], taskId: 't-1' })
  check(frames().length === 1 && frames()[0].rev === 1 && frames()[0].scopes.join() === 'board' && frames()[0].taskId === 't-1', 'the first change goes out at once, with its hint')
  w.manager.teamChanged({ teamId: T, rev: 2, scopes: ['task'], taskId: 't-1' })
  w.manager.teamChanged({ teamId: T, rev: 4, scopes: ['needs', 'task'], taskId: 't-2' })
  w.manager.teamChanged({ teamId: T, rev: 3, scopes: ['list'] })
  w.manager.teamChanged({ teamId: 'tm-bbbbbbbbbbbb', rev: 9, scopes: ['run'], runId: 'r-0123456789ab' })
  check(frames().length === 1 && ws.of('teamChanged').some((f) => f.teamId === 'tm-bbbbbbbbbbbb' && f.runId === 'r-0123456789ab'), 'the next ones of that team wait; another team has its own window')
  await sleep(650)
  const merged = frames()[1]
  check(frames().length === 2 && merged.rev === 4 && merged.scopes.slice().sort().join() === 'list,needs,task' && !('taskId' in merged), 'they leave as one: the newest rev, every scope, no task hint (they named different tasks)', merged)
  w.manager.teamChanged({ teamId: T, rev: 5, scopes: ['task'], taskId: 't-3' })
  w.manager.teamChanged({ teamId: T, rev: 6, scopes: ['task'], taskId: 't-3' })
  check(frames().length === 2, 'a change right after the merged one waits for its window too')
  await sleep(650)
  check(frames().length === 3 && frames()[2].rev === 6 && frames()[2].taskId === 't-3', 'and keeps the hint every merged change shared', frames()[2])
  w.manager.applyConfig({ enabled: false, port: 4600 })
  w.manager.teamChanged({ teamId: T, rev: 7, scopes: ['board'] })
  check(frames().length === 3, 'no server: nothing sent, nothing held')
}

// ---- 4. push, deep link and the router -----------------------------------------------------------------
async function pushChecks(api, ctx) {
  const n = { kind: 'team', teamId: 'tm-0123456789ab', taskId: 't-12', tag: 'team:tm-0123456789ab:a-3', title: 'Equipo Notas', body: 'Aprobá el plan de t-12', urgent: false, push: true }
  const msg = api.buildTeamPushMessage(n)
  same(msg, { title: 'Equipo Notas', body: 'Aprobá el plan de t-12', tag: 'team:tm-0123456789ab:a-3', url: './#team=tm-0123456789ab&task=t-12', urgent: false }, 'buildTeamPushMessage: the #team=..&task=.. link, the tag, urgent')
  check(!('state' in msg), 'never a state (the tray reconcile reads a state\'s tag as a pane id)')
  const noTask = api.buildTeamPushMessage({ ...n, taskId: undefined, tag: 'team:tm-0123456789ab:trust', urgent: true, body: 'x'.repeat(400) })
  check(noTask.url === './#team=tm-0123456789ab' && noTask.urgent === true && noTask.body.length === 200, 'a team-wide row links the board only; urgent for a row that blocks the team; the body cut like every push')
  check(api.teamDeepLinkUrl('http://100.64.0.9:4517/', 'tm-0123456789ab', 't-1') === 'http://100.64.0.9:4517/#team=tm-0123456789ab&task=t-1' && api.teamDeepLinkUrl('https://pc.ts.net', 'tm-0123456789ab') === 'https://pc.ts.net/#team=tm-0123456789ab' && api.teamDeepLinkUrl(null, 'tm-0123456789ab') === undefined, 'teamDeepLinkUrl: base + #team= (+ &task=), none without a base')
  check(/^#?(?:.*&)?team=(tm-[a-f0-9]{12})(?:&task=(t-[0-9]{1,5}))?(?:&|$)/.test(msg.url.slice(2)) && /^#team=tm-[a-f0-9]{12}(?:&task=t-[0-9]{1,5})?$/.test(msg.url.slice(2)) && /^#team=tm-[a-f0-9]{12}(?:&task=t-[0-9]{1,5})?$/.test(noTask.url.slice(2)),'the link matches the phone\'s TEAM_LINK_RE and openHashOf rule (design 6.3)')

  // notifyTeamPush: behind https and notifyAction, through PushService.notify.
  const pushed = []
  const fakePush = { notify: async (m, c) => { pushed.push({ m: json(m), enabled: c.enabled }); return 1 }, ensureKeys() {}, publicKey: () => null, handleSubscribe() {}, removeDevice() {} }
  const secure = { enable: async () => ({ ok: false, error: 'cli' }), disable: async () => ({ ok: true }) }
  const off = remoteWorld(api, ctx, { services: { push: fakePush, secure } })
  check((await off.manager.notifyTeamPush(n, null)) === 0 && pushed.length === 0, 'https off: no team push (FR-46)')
  off.manager.applyConfig({ enabled: false, port: 4600 })
  const on = remoteWorld(api, ctx, { https: true, services: { push: fakePush, secure } })
  check((await on.manager.notifyTeamPush(n, null)) === 1 && pushed.length === 1 && pushed[0].m.url === './#team=tm-0123456789ab&task=t-12' && pushed[0].m.tag === n.tag && pushed[0].enabled === true, 'https on: one push of buildTeamPushMessage')
  check((await on.manager.notifyTeamPush(n, { settings: { notifications: { notifyAction: false, notifyDone: true } } })) === 0 && pushed.length === 1, 'notifyAction off: none')
  check((await on.manager.notifyTeamPush({ ...n, push: false }, null)) === 0 && pushed.length === 1, 'a push: false notice: none')
  on.manager.applyConfig({ enabled: false, port: 4600, https: { enabled: false, mode: 'tailscaleServe' } })

  // routeTeam: the away gate, never held, Discord and ntfy as custom notices with the deep link.
  const calls = []
  let cfg = { settings: { notifications: { onlyWhenAway: false, notifyAction: true, notifyDone: true } } }
  let away = true
  const router = api.createNoticeRouter({
    discord: { notify: () => calls.push(['discord.notify']), notifyCustom: (c) => calls.push(['discord.custom', json(c)]), wants: () => true, wantsCustom: () => true },
    ntfy: { notify: () => calls.push(['ntfy.notify']), wants: () => true, notifyCustom: (c, _cfg, click) => calls.push(['ntfy.custom', json(c), click]), wantsCustom: () => true },
    loadConfig: () => cfg,
    isAway: () => away,
    isPaneViewed: () => true,
    deepLinkBase: () => 'http://100.64.0.9:4517',
    push: () => calls.push(['push']),
    pushTeam: (x) => calls.push(['pushTeam', json(x)]),
  })
  router.routeTeam(n)
  check(calls.length === 3 && calls[0][0] === 'pushTeam' && calls[0][1].tag === n.tag, 'routeTeam: the team push first', calls)
  check(calls[1][0] === 'discord.custom' && calls[1][1].title === n.title && calls[1][1].body === n.body && calls[1][1].paneId === null, 'Discord gets main\'s title and body as a custom notice')
  check(calls[2][0] === 'ntfy.custom' && calls[2][2] === 'http://100.64.0.9:4517/#team=tm-0123456789ab&task=t-12', 'ntfy gets them with the #team= deep link (no pane to skip)', calls[2])
  calls.length = 0
  for (let i = 0; i < 6; i++) router.routeTeam({ ...n, tag: `team:tm-0123456789ab:k-${i}` })
  check(calls.filter((c) => c[0] === 'pushTeam').length === 6 && calls.filter((c) => c[0] === 'ntfy.custom').length === 6, 'a burst of 6 team notices: none held (a team that needs the user is action-like)')
  calls.length = 0
  router.routeTeam({ ...n, push: false })
  check(calls.length === 0, 'a push: false notice (a desktop toast only) goes nowhere')
  cfg = { settings: { notifications: { onlyWhenAway: true, notifyAction: true, notifyDone: true } } }
  away = false
  router.routeTeam(n)
  check(calls.length === 0, 'the away gate: at the PC with "only when away", nothing')
  away = true
  router.routeTeam(n)
  check(calls.length === 3, 'away again: delivered')
  check(api.isTeamNotice(n) && !api.isTeamNotice({ kind: 'custom', paneId: null, title: 't', body: 'b' }) && !api.isTeamNotice({ paneId: 'p', provider: 'claude', state: 'action' }), 'isTeamNotice tells the three notices apart')
}

// ---- 5. an old desktop, the phone gate, Share ----------------------------------------------------------
async function oldDesktopChecks(api, oldApi, oldCtx) {
  check(!api.appVersionAtLeast('2.6.0', api.APP_2_7_0) && !api.appVersionAtLeast('', api.APP_2_7_0) && api.appVersionAtLeast('2.7.0', api.APP_2_7_0) && api.appVersionAtLeast('dev', api.APP_2_7_0), 'the phone gate: a 2.6.0 (or unknown) desktop gets no team frame; 2.7.0 and dev do')
  const old = remoteWorld(oldApi, oldCtx)
  const ws = await old.pair()
  const relayed = old.commands.length
  const mark = ws.inbox.length
  ws.msg({ type: 'teamReq', id: 'q1', req: { op: 'list' } })
  await tick()
  check(ws.inbox.slice(mark).some((m) => m.type === 'err' && m.code === 'bad_msg') && !ws.of('teamRes').length, 'to a 2.6.0 desktop a teamReq is bad_msg and gets no teamRes')
  ws.msg({ type: 'ctl', id: 'c1', action: { kind: 'teamDecide', teamId: 'tm-0123456789ab', approvalId: 'a-1', decision: 'approve' } })
  await tick()
  check(!ws.of('ctlAck').some((a) => a.id === 'c1') && ws.closed === null && old.commands.length === relayed, 'a team ctl too: bad_msg, no ack at all (the phone would wait 10 s)')
  ws.msg({ type: 'ctl', id: 'c2', action: { kind: 'teamDispatch', teamId: 'tm-0123456789ab', queueId: 'all', go: true } })
  await tick()
  check(ws.closed === 1008, 'the third strike closes the socket (1008): why the phone gates every team frame on 2.7.0')
  old.manager.applyConfig({ enabled: false, port: 4600 })

  // Share never gets team data: no module of src/main/share reads Teams, and index.ts hands ShareHost no teams dep.
  const shareDir = path.join(root, 'src', 'main', 'share')
  const readers = fs.readdirSync(shareDir).filter((f) => f.endsWith('.ts') && /team-protocol|teams\/|TeamService|teamNeeds|RemoteTeamsView/.test(fs.readFileSync(path.join(shareDir, f), 'utf8')))
  check(readers.length === 0, 'no module of src/main/share imports Teams', readers)
  const index = fs.readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8')
  const start = index.indexOf('new ShareHost({')
  const block = index.slice(start, index.indexOf('\n  })', start))
  check(start > 0 && block.length > 0 && !/team/i.test(block), 'the ShareHost construction in index.ts carries no team dep (ShareState never holds team data)')
  check(/remoteManager\.setTeams\(teams\.remoteView\)/.test(index) && /remoteManager\.teamChanged\(evt\)/.test(index) && /noticeRouter\?\.routeTeam\(n\)/.test(index) && /pushTeam: \(notice, config\) => void remoteManager\.notifyTeamPush\(notice, config\)/.test(index), 'index.ts wires setTeams, the teamChanged relay, routeTeam and the team push (design 3.12 steps 7 and 11)')
}

async function main() {
  const code = await bundleWith([stubs])
  const oldCode = await bundleWith([stubs, oldDesktop])
  const { api, ctx } = load(code)
  fitUnits(api)
  await worldChecks(api, ctx)
  await throttleChecks(api, ctx)
  await pushChecks(api, ctx)
  const old = load(oldCode)
  await oldDesktopChecks(api, old.api, old.ctx)
  fs.rmSync(TMP, { recursive: true, force: true })
  console.log(`PASS: ${checks} teams remote checks (phoneFit units, 300 tasks paged under 48 KB, a long task with 200 comments, Te necesita with a hire diff, run and Lead pages, masking, rate and in flight, the three ctls in main and never relayed, teamChanged throttle, team push and routeTeam, Labs off, an old desktop's strikes, no team data in Share)`)
}

main().catch((error) => {
  console.error(error)
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* leave it */ }
  process.exit(1)
})
