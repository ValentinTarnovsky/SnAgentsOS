// Teams definition (app 2.7.0, B1): src/shared/{teams,teamDefinition,teamDiff,team-protocol,teamNeeds}.ts.
// Id helpers and emptyRuntime; the frontmatter grammar with its line errors; folder caps (64 files, 64 KB,
// 512 KB), DEF_REL_RE (a misnamed file only warns, a dotfile is ignored), every issue with its severity,
// UNC and device repo paths refused on their line, reserved ids, exactly one lead, models and efforts, tool
// patterns, routines (cron and interval); normalizeDefText and canonicalDefText (CRLF and BOM hash equal); defaultTemplate es/en parses
// clean; renderTeamFiles and serializeRole round trips; lineDiff (hunks, truncation, whole replace, random
// cases applied back and minimal against an LCS); teamRiskFlags order; teamNeedsRows rules and order.
// Same esbuild + vm harness as test-status.cjs: no Electron, no user data.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
// Values built inside the vm have another realm's prototypes; compare as JSON.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, structuredClone, setTimeout, clearTimeout, ...overrides })
  return mod.exports
}
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')

const T = load('src/shared/teams.ts')
const D = load('src/shared/teamDefinition.ts')
const F = load('src/shared/teamDiff.ts')
const P = load('src/shared/team-protocol.ts')
const N = load('src/shared/teamNeeds.ts')
const W = load('src/shared/worktree-types.ts')

const SHARED = ['teams', 'teamDefinition', 'teamDiff', 'team-protocol', 'teamNeeds'].map((n) => `src/shared/${n}.ts`)

// ---- fixtures -------------------------------------------------------------------------------------
const teamMd = (front = 'name: Demo', body = 'Build the thing.') => ({ rel: 'team.md', text: `---\n${front}\n---\n\n${body}\n` })
const roleMd = (id, front, body = 'Do the work.') => ({ rel: `roles/${id}.md`, text: `---\n${front}\n---\n\n${body}\n` })
const routineMd = (id, front, body = 'Write the summary.') => ({ rel: `routines/${id}.md`, text: `---\n${front}\n---\n\n${body}\n` })
const LEAD = roleMd('lead', 'name: Lead\nkind: lead\nprovider: claude\npermission: readonly')
const DEV = roleMd('dev', 'name: Dev\nkind: dev\nprovider: claude\npermission: total\ncount: 2')
const base = (...extra) => [teamMd(), LEAD, DEV, ...extra]
const parse = (files) => D.parseDefinition(files)
const errs = (res) => (res.ok ? [] : res.errors)
const codes = (res) => errs(res).map((e) => e.code)
const errOf = (res, code) => errs(res).find((e) => e.code === code)
/** A folder with one extra role file (front matter as given). */
const withRole = (id, front, body) => parse(base(roleMd(id, front, body)))
const withTeam = (front, body) => parse([teamMd(front, body), LEAD, DEV])

function staticChecks() {
  for (const file of SHARED) {
    const text = fs.readFileSync(path.join(root, file), 'utf8')
    const imports = [...text.matchAll(/^import\s+(type\s+)?[^'"]*from\s+'([^']+)'/gm)]
    check(imports.length > 0 || file.endsWith('teams.ts'), `${file}: has imports`)
    check(imports.every((m) => m[2].startsWith('./')), `${file}: imports only other shared modules`)
    check(!/from\s+'(?:node:|fs|path|os|crypto|electron)/.test(text) && !/\b(?:window|document|Buffer|TextEncoder)\./.test(text), `${file}: no Node, Electron or DOM`)
    check(!/[\u2013\u2014]/.test(text), `${file}: no en or em dash`)
  }
  const teamsSrc = fs.readFileSync(path.join(root, 'src/shared/teams.ts'), 'utf8')
  check([...teamsSrc.matchAll(/^import\s+(type\s+)?/gm)].every((m) => m[1]), 'teams.ts: type-only imports')
}

function idChecks() {
  check(T.TEAM_ID_RE.test('tm-0123456789ab') && !T.TEAM_ID_RE.test('tm-0123456789AB') && !T.TEAM_ID_RE.test('tm-0123'), 'TEAM_ID_RE: tm- and 12 lowercase hex')
  check(T.ROLE_ID_RE.test('a'.repeat(22)) && !T.ROLE_ID_RE.test('a'.repeat(23)) && T.AGENT_ID_RE.test(`${'a'.repeat(22)}-4`), 'ROLE_ID_RE 22 chars so <roleId>-4 fits AGENT_ID_RE (decision 20)')
  check(T.REPO_ID_RE.test('main') && T.REPO_ID_RE.test('lib-2') && !T.REPO_ID_RE.test('2lib'), 'REPO_ID_RE: main or a lowercase id')
  check(T.teamPaneId('r-0123456789ab') === 'team:r-0123456789ab' && T.isTeamPaneId('team:r-0123456789ab'), 'teamPaneId / isTeamPaneId')
  check(!T.isTeamPaneId('team:r-123') && !T.isTeamPaneId('pane-1') && !T.isTeamPaneId(null) && !T.isTeamPaneId('r-0123456789ab'), 'isTeamPaneId refuses other ids and non strings')
  check(T.agentIdOf('dev', 1) === 'dev' && T.agentIdOf('dev', 2) === 'dev-2' && T.agentIdOf('dev', 4) === 'dev-4', 'agentIdOf: first is the role id, then -2..-4')
  check(T.agentIndexOf('dev', 'dev') === 1 && T.agentIndexOf('dev-3', 'dev') === 3 && T.agentIndexOf('dev-1', 'dev') === null && T.agentIndexOf('dev-5', 'dev') === null && T.agentIndexOf('devops', 'dev') === null && T.agentIndexOf('dev-10', 'dev') === null, 'agentIndexOf: 1..4, never -1, -5 or another role')
  check(T.taskIdOf(12) === 't-12' && T.taskNumOf('t-12') === 12 && T.taskNumOf('t-07') === null && T.taskNumOf('t-x') === null && T.taskNumOf('t-123456') === null, 'taskIdOf / taskNumOf round trip, no leading zero')
  const slug = T.taskSlug('tm-ab12cd345678', 12)
  check(slug === 't-ab12cd-12' && W.WORKTREE_SLUG_RE.test(slug) && W.WORKTREE_BRANCH_RE.test(`sn/${T.taskSlug('tm-ab12cd345678', 99999)}`), 'taskSlug t-<team6>-<n> passes WORKTREE_SLUG_RE and the branch RE')
  check(T.sessionKeyOf('exec', 't-3') === 't-3' && T.sessionKeyOf('plan', 't-3') === 't-3' && T.sessionKeyOf('lead') === 'lead' && T.sessionKeyOf('free') === 'free' && T.sessionKeyOf('free', 't-3') === 'free', 'sessionKeyOf: task id, lead, free')
  check(T.isActiveRun('queued') && T.isActiveRun('stopping') && !T.isActiveRun('succeeded') && !T.isActiveRun('takenOver'), 'isActiveRun = RUN_ACTIVE')
  const col = (state, phase) => T.columnOf({ state, phase })
  check(col('todo', 'none') === 'todo' && col('doing', 'planApproval') === 'doing' && col('review', 'integrating') === 'review' && col('done', 'none') === 'done' && col('blocked', 'qa') === 'blocked' && col('cancelled', 'none') === null, 'columnOf: plan 3.8 table, cancelled -> null')
  check(T.teamWorktreeOwner('tm-0123456789ab', 'deadbeef', 't-4') === 'team:tm-0123456789ab:deadbeef:t-4', 'teamWorktreeOwner')
  const rt = T.emptyRuntime('tm-0123456789ab', 'deadbeef')
  check(rt.v === T.TEAM_STATE_VERSION && rt.rev === 0 && rt.gen === 'deadbeef' && rt.autoDispatch === false && rt.paused === null && same(rt.nextIds, { task: 1, comment: 1, approval: 1, card: 1, queue: 1 }), 'emptyRuntime: rev 0, autonomy off, counters at 1')
  check(same(rt.agents, []) && same(rt.comments, {}) && same(rt.activeRuns, []) && same(rt.providerBlockedUntil, {}) && rt.needsSeen === undefined && T.TEAM_GEN_RE.test(rt.gen), 'emptyRuntime: every collection empty')
  check(T.emptyRuntime('tm-0123456789ab', 'deadbeef') !== rt && T.emptyRuntime('tm-0123456789ab', 'deadbeef').tasks !== rt.tasks, 'emptyRuntime returns fresh objects')
  check(T.PRIORITY_RANK.urgent === 0 && T.PRIORITY_RANK.low === 3 && same(T.TASK_PRIORITIES, ['urgent', 'high', 'normal', 'low']), 'priority words and ranks')
  check(T.CONTINUATIONS_MAX === 1 && T.NO_PROGRESS_BLOCK_AT === 3 && same(T.NO_PROGRESS_COOLDOWN_MIN, [5, 10]) && T.TEAM_PLAN_MAX === 32 * 1024, 'flow constants of decisions 31 and 32')
  check(same(T.DESKTOP_ONLY_CARD_ACTIONS, ['resumeTeam', 'killOrphan']), 'desktop-only card actions (decision 50)')
  check(P.PHONE_TEAM_OPS.length === 9 && P.isPhoneTeamOp('leadSay') && P.isPhoneTeamOp('lead') && !P.isPhoneTeamOp('trust') && !P.isPhoneTeamOp('integrate') && !P.isPhoneTeamOp('takeover'), 'phone ops: the plan list plus lead; trust, integrate and takeover stay desktop only')
  check(P.TEAM_FRAME_MAX_BYTES === 48 * 1024 && P.TEAM_BOARD_PAGE === 150, 'phone frame caps')
}

function textChecks() {
  check(D.normalizeDefText('\uFEFFa\r\nb\rc\n') === 'a\nb\nc\n', 'normalizeDefText: BOM stripped, CRLF and CR to LF')
  check(D.normalizeDefText('a\uFEFFb') === 'a\uFEFFb', 'normalizeDefText: only a leading BOM')
  const lf = [{ rel: 'team.md', text: '---\nname: X\n---\n\nGoal\n' }, { rel: 'roles/lead.md', text: 'L\n' }]
  const crlf = [{ rel: 'roles/lead.md', text: 'L\r\n' }, { rel: 'team.md', text: '\uFEFF---\r\nname: X\r\n---\r\n\r\nGoal\r\n' }]
  check(D.canonicalDefText(lf) === 'roles/lead.md\0L\n\0team.md\0---\nname: X\n---\n\nGoal\n\0', 'canonicalDefText: sorted by rel, rel NUL text NUL')
  check(sha(D.canonicalDefText(lf)) === sha(D.canonicalDefText(crlf)), 'CRLF, BOM and file order hash the same')
  check(sha(D.canonicalDefText(lf)) !== sha(D.canonicalDefText([{ rel: 'team.md', text: lf[0].text }, { rel: 'roles/lead.md', text: 'L2\n' }])), 'a changed byte changes the hash')
}

function frontmatterChecks() {
  const fm = D.parseFrontmatter('team.md', '---\nname: "Mi equipo"\n# a comment\n\nverify:  npm test  \nempty:\n---\nBody line\n\nmore')
  check(fm.ok && same(fm.fields, [{ key: 'name', value: 'Mi equipo', line: 2 }, { key: 'verify', value: 'npm test', line: 5 }, { key: 'empty', value: '', line: 6 }]), 'fields with their lines, quotes stripped, comments and blank lines skipped')
  check(fm.ok && fm.body === 'Body line\n\nmore' && fm.bodyLine === 8, 'body after the closing line, bodyLine 1-based')
  const q = D.parseFrontmatter('x', '---\na: "\nb: ""x""\nc: x "y" z\n---\n')
  check(q.ok && same(q.fields.map((f) => f.value), ['"', '"x"', 'x "y" z']), 'only one pair of surrounding quotes is stripped')
  const crlf = D.parseFrontmatter('x', '\uFEFF---\r\nname: A\r\n---\r\nB\r\n')
  check(crlf.ok && crlf.fields[0].value === 'A' && crlf.body === 'B\n', 'BOM and CRLF normalized before parsing')
  const noOpen = D.parseFrontmatter('team.md', 'name: x\n---\n')
  check(!noOpen.ok && same(noOpen.error, { file: 'team.md', line: 1, code: 'frontmatter', detail: 'open', severity: 'error' }), 'missing opening --- at line 1')
  const noClose = D.parseFrontmatter('team.md', '---\nname: x\n')
  check(!noClose.ok && noClose.error.code === 'frontmatter' && noClose.error.detail === 'close', 'missing closing ---')
  const bad = D.parseFrontmatter('team.md', '---\nname: x\njust words\n---\n')
  check(!bad.ok && bad.error.line === 3 && bad.error.detail === 'line', 'a line without key: value fails with its line')
  const badKey = D.parseFrontmatter('team.md', '---\n: x\n---\n')
  check(!badKey.ok && badKey.error.line === 2, 'an empty key fails')
  const dup = D.parseFrontmatter('team.md', '---\nname: a\nverify: b\nname: c\n---\n')
  check(!dup.ok && same(dup.error, { file: 'team.md', line: 4, key: 'name', code: 'duplicate_key', severity: 'error' }), 'duplicate key with the line of the second')
  check(!D.parseFrontmatter('x', '').ok, 'an empty file has no frontmatter')
}

function teamFileChecks() {
  const ok = parse(base())
  check(ok.ok && ok.def.name === 'Demo' && ok.def.goal === 'Build the thing.' && ok.def.rules === '' && same(ok.warnings, []), 'minimal folder parses')
  check(ok.ok && ok.def.verifyTimeoutMin === 20 && ok.def.maxRunMinutes === 45 && ok.def.maxConcurrent === 2 && ok.def.leadApprovesSmallPlans === true && same(ok.def.extraRepos, []) && ok.def.baseBranch === undefined && ok.def.verify === undefined, 'team defaults: 20, 45, 2, true')
  const full = withTeam('name: Demo\nbaseBranch: develop\nverify: npm test\nverifyTimeoutMin: 60\nmaxRunMinutes: 5\nmaxConcurrent: 3\nleadApprovesSmallPlans: false', 'Goal line\n\n## Reglas\n\n- rule one')
  check(full.ok && full.def.baseBranch === 'develop' && full.def.verify === 'npm test' && full.def.verifyTimeoutMin === 60 && full.def.maxRunMinutes === 5 && full.def.maxConcurrent === 3 && full.def.leadApprovesSmallPlans === false, 'every team key read')
  check(full.ok && full.def.goal === 'Goal line' && full.def.rules === '- rule one', '## Reglas splits goal and rules')
  const en = withTeam('name: Demo', 'G\n## Rules\nR')
  check(en.ok && en.def.goal === 'G' && en.def.rules === 'R', '## Rules splits too')
  const unknown = withTeam('name: Demo\nmaxRuns: 3')
  check(same(errs(unknown), [{ file: 'team.md', line: 3, key: 'maxRuns', code: 'unknown_key', severity: 'error' }]), 'unknown key with its line')
  check(codes(withTeam('name: Demo\nname: Other')).includes('duplicate_key'), 'duplicate key in team.md')
  check(errOf(withTeam('verify: npm test'), 'required')?.key === 'name', 'name is required')
  check(errOf(withTeam('name:'), 'required')?.line === 2, 'an empty name is required at its line')
  check(errOf(withTeam(`name: ${'n'.repeat(61)}`), 'too_large')?.key === 'name', 'name over 60 chars')
  for (const [key, bad, good] of [['verifyTimeoutMin', '4', '5'], ['verifyTimeoutMin', '61', '60'], ['maxRunMinutes', '121', '120'], ['maxRunMinutes', '4', '5'], ['maxConcurrent', '0', '1'], ['maxConcurrent', '4', '3'], ['maxConcurrent', '2.5', '2']]) {
    const e = errOf(withTeam(`name: Demo\n${key}: ${bad}`), 'bad_value')
    check(e?.key === key && e.line === 3, `${key}: ${bad} refused`)
    check(withTeam(`name: Demo\n${key}: ${good}`).ok, `${key}: ${good} accepted`)
  }
  check(errOf(withTeam('name: Demo\nleadApprovesSmallPlans: yes'), 'bad_value')?.detail === 'true|false', 'booleans are true or false')
  for (const b of ['-x', 'a..b', 'a b', 'a~1', 'feature/', 'x.lock', 'x.lock/y', '.hidden', 'a//b', 'a@{1}'])check(errOf(withTeam(`name: Demo\nbaseBranch: ${b}`), 'bad_value')?.key === 'baseBranch', `baseBranch ${b} refused`)
  for (const b of ['main', 'release/2.7', 'feat/equipos-b1']) check(withTeam(`name: Demo\nbaseBranch: ${b}`).ok, `baseBranch ${b} accepted`)
  check(errOf(withTeam(`name: Demo\nverify: ${'x'.repeat(301)}`), 'too_large')?.key === 'verify' && withTeam(`name: Demo\nverify: ${'x'.repeat(300)}`).ok, 'verify capped at 300')
  check(errOf(withTeam('name: Demo', 'g'.repeat(8 * 1024 + 1)), 'too_large')?.key === 'goal', 'goal capped at 8 KB')
  check(errOf(withTeam('name: Demo', `g\n## Rules\n${'r'.repeat(16 * 1024 + 1)}`), 'too_large')?.key === 'rules', 'rules capped at 16 KB')
  check(codes(parse([teamMd('name: Demo', '')])).includes('no_lead') && withTeam('name: Demo', '').ok, 'an empty goal is allowed')
}

function repoChecks() {
  const r = withTeam('name: Demo\nrepo.lib.path: ../lib\nrepo.lib.baseBranch: main\nrepo.lib.verify: mvn -q package\nrepo.docs.path: C:\\work\\docs')
  check(r.ok && same(r.def.extraRepos, [{ id: 'lib', path: '../lib', baseBranch: 'main', verify: 'mvn -q package' }, { id: 'docs', path: 'C:\\work\\docs' }]), 'extra repos in order, relative and absolute paths kept as written')
  check(errOf(withTeam('name: Demo\nrepo.lib.baseBranch: main'), 'required')?.key === 'repo.lib.path', 'an extra repo needs a path')
  check(errOf(withTeam('name: Demo\nrepo.main.path: ../x'), 'bad_name')?.key === 'repo.main.path', 'repo id main is the team repo')
  check(errOf(withTeam('name: Demo\nrepo.Lib.path: ../x'), 'bad_name')?.detail === 'Lib', 'repo ids follow REPO_ID_RE')
  check(errOf(withTeam('name: Demo\nrepo.lib.url: x'), 'unknown_key')?.key === 'repo.lib.url', 'unknown repo property')
  const five = ['a', 'b', 'c', 'd', 'e'].map((id) => `repo.${id}.path: ../${id}`).join('\n')
  const tooMany = withTeam(`name: Demo\n${five}`)
  check(errOf(tooMany, 'too_many')?.key === 'repo.e.path' && errOf(tooMany, 'too_many').line === 7, 'more than 4 extra repos')
  check(errOf(withTeam(`name: Demo\nrepo.lib.path: ${'p'.repeat(1025)}`), 'too_large')?.key === 'repo.lib.path', 'extra repo path capped at 1024')
  check(errOf(withTeam('name: Demo\nrepo.lib.path: x\nrepo.lib.verify: a\u0007b'), 'bad_value')?.key === 'repo.lib.verify' && errOf(withTeam('name: Demo\nrepo.lib.path: x\u0001y'), 'bad_value')?.key === 'repo.lib.path', 'control characters refused in repo values')
  check(same(codes(withTeam('name: Demo\nrepo.lib.path: x\u0001y')), ['bad_value']), 'a refused path is one error, not also "required"')
  // Finding 4: a UNC share or a device path is refused lexically, on its line, before main ever resolves it.
  for (const p of ['\\\\203.0.113.5\\s\\lib', '//host/share/lib', '\\\\?\\C:\\work\\lib', '\\\\.\\pipe\\x', '/\\host\\share', '\\/host/share', '\\\\?\\UNC\\host\\share']) {
    const res = withTeam(`name: Demo\nrepo.lib.path: ${p}`)
    check(same(errs(res), [{ file: 'team.md', line: 3, key: 'repo.lib.path', code: 'repo', detail: 'unc', severity: 'error' }]), `UNC or device path ${p}: one repo error (unc) on its line`)
  }
  check(D.UNC_PATH_RE.test('\\\\x') && D.UNC_PATH_RE.test('//x') && !D.UNC_PATH_RE.test('/home/u/lib') && !D.UNC_PATH_RE.test('C:\\work\\lib') && !D.UNC_PATH_RE.test('..\\lib') && !D.UNC_PATH_RE.test('\\work\\lib'), 'UNC_PATH_RE: two leading separators only')
  check(withTeam('name: Demo\nrepo.lib.path: /home/u/lib\nrepo.docs.path: \\work\\docs').ok, 'a POSIX absolute and a rooted Windows path are still accepted')
  check(errOf(withTeam('name: De\u0007mo'), 'bad_value')?.key === 'name', 'control characters refused in the name')
}

function folderChecks() {
  const many = base(...Array.from({ length: 62 }, (_, i) => ({ rel: `notes-${i}.txt`, text: 'x' })))
  check(many.length === 65 && errOf(parse(many), 'too_many')?.file === D.TEAM_DIR, 'more than 64 files')
  check(base(...Array.from({ length: 61 }, (_, i) => ({ rel: `n${i}.txt`, text: 'x' }))).length === 64 && parse(base(...Array.from({ length: 61 }, (_, i) => ({ rel: `n${i}.txt`, text: 'x' })))).ok, '64 files are fine (unknown files only warn)')
  const big = parse(base({ rel: 'roles/qa.md', text: `---\nname: QA\nkind: qa\nprovider: claude\npermission: readonly\n---\n${'q'.repeat(64 * 1024)}` }))
  check(errOf(big, 'too_large')?.file === 'roles/qa.md' && errOf(big, 'too_large').line === 0, 'a file over 64 KB')
  const ascii = 'a'.repeat(64 * 1024 - 100)
  const ok64 = parse(base(roleMd('qa', 'name: QA\nkind: qa\nprovider: claude\npermission: readonly', ascii)))
  check(ok64.ok, 'a file just under 64 KB is fine')
  check(errOf(parse(base(roleMd('qa', 'name: QA\nkind: qa\nprovider: claude\npermission: readonly', 'ñ'.repeat(33 * 1024)))), 'too_large')?.file === 'roles/qa.md', 'the cap counts UTF-8 bytes, not characters')
  const total = base(...Array.from({ length: 9 }, (_, i) => routineMd(`r${i}`, 'cron: 0 9 * * *\nrole: lead', 'w'.repeat(60 * 1024))))
  check(errs(parse(total)).some((e) => e.code === 'too_large' && e.file === D.TEAM_DIR), 'the folder over 512 KB')
  check(errOf(parse([LEAD, DEV]), 'missing_team')?.file === 'team.md', 'no team.md')
  const readme = parse(base({ rel: 'README.md', text: 'notes' }))
  check(readme.ok && same(readme.warnings, [{ file: 'README.md', line: 0, code: 'bad_name', severity: 'warning' }]), 'a README only warns')
  // Orchestrator decision (a): a misnamed .md of roles/ or routines/ is a warning too; it is never part of the definition.
  const dev2 = parse(base(roleMd('Dev2', 'name: x\nkind: dev\nprovider: claude\npermission: total')))
  check(dev2.ok && same(dev2.warnings, [{ file: 'roles/Dev2.md', line: 0, code: 'bad_name', severity: 'warning' }]) && !dev2.def.roles.some((r) => r.id === 'Dev2'), 'roles/Dev2.md only warns and is no role')
  const oddNames = parse(base({ rel: 'routines/a_b.md', text: 'x' }, { rel: 'TEAM.md', text: 'x' }))
  check(oddNames.ok && same(oddNames.warnings.map((w) => [w.file, w.code, w.severity]), [['TEAM.md', 'bad_name', 'warning'], ['routines/a_b.md', 'bad_name', 'warning']]), 'bad routine and team file names only warn')
  check(same(codes(parse([LEAD, DEV, { rel: 'TEAM.md', text: 'x' }])), ['missing_team']), 'a TEAM.md never stands in for team.md')
  // The loader passes a misnamed file of roles/ or routines/ by name only (empty text): its one issue is the name.
  const writer = parse(base({ rel: 'roles/Writer.md', text: '' }))
  check(writer.ok && same(writer.warnings, [{ file: 'roles/Writer.md', line: 0, code: 'bad_name', severity: 'warning' }]), 'a misnamed role passed with an empty text: one bad_name warning with its name')
  const strayNote = parse(base({ rel: 'routines/notes.txt', text: '' }))
  check(strayNote.ok && same(strayNote.warnings, [{ file: 'routines/notes.txt', line: 0, code: 'bad_name', severity: 'warning' }]), 'a stray non-.md file with an empty text only warns')
  // A name starting with "." (a macOS resource fork, an editor temp file) is ignored entirely.
  const dot = parse(base({ rel: 'roles/._dev.md', text: '\u0000\u0001' }, { rel: 'routines/.daily.md.swp', text: '' }, { rel: 'roles/.Dev.md', text: '' }))
  check(dot.ok && same(dot.warnings, []) && dot.def.roles.length === 2, 'dotfiles are ignored: no warning, no role')
  check(D.ignoredDefName('._dev.md') && D.ignoredDefName('.x') && !D.ignoredDefName('dev.md') && !D.ignoredDefName('a.md'), 'ignoredDefName: a leading dot')
  // Warnings travel on the failing side too, and every issue says its severity.
  const both = parse([teamMd('name: Demo\nmaxRuns: 3'), LEAD, DEV, { rel: 'README.md', text: '' }])
  check(!both.ok && same(both.warnings.map((w) => w.file), ['README.md']) && both.errors.every((e) => e.severity === 'error'), 'a failing parse keeps its warnings')
  check(same(D.definitionIssues(both).map((i) => [i.code, i.severity]), [['unknown_key', 'error'], ['bad_name', 'warning']]), 'definitionIssues: errors first, then warnings')
  check(same(D.definitionIssues(readme).map((i) => i.severity), ['warning']), 'definitionIssues of a clean parse: its warnings')
  check(D.DEF_REL_RE.test('team.md') && D.DEF_REL_RE.test(`roles/${'a'.repeat(22)}.md`) && !D.DEF_REL_RE.test(`roles/${'a'.repeat(23)}.md`) && D.DEF_REL_RE.test(`routines/${'a'.repeat(24)}.md`) && !D.DEF_REL_RE.test('roles/sub/x.md') && !D.DEF_REL_RE.test('roles\\x.md'), 'DEF_REL_RE: role ids 22, routine ids 24, no subfolders or backslashes')
  check(errOf(parse([teamMd(), LEAD, DEV, { rel: 'roles/dev.md', text: DEV.text }]), 'bad_name')?.detail === 'duplicate', 'a duplicate rel')
}

function roleChecks() {
  const reserved = withRole('user', 'name: U\nkind: dev\nprovider: claude\npermission: total')
  check(errOf(reserved, 'reserved_name')?.file === 'roles/user.md', 'reserved role id')
  for (const id of ['system', 'free', 'all', 'none', 'team']) check(codes(withRole(id, 'name: U\nkind: dev\nprovider: claude\npermission: total')).includes('reserved_name'), `reserved: ${id}`)
  check(errOf(parse([teamMd(), DEV]), 'no_lead')?.file === 'roles', 'no lead')
  const two = withRole('boss', 'name: Boss\nkind: lead\nprovider: claude\npermission: readonly')
  check(same(errs(two), [{ file: 'roles/lead.md', line: 0, code: 'two_leads', severity: 'error' }]), 'two leads: the second in rel order is reported')
  check(errOf(parse([teamMd(), roleMd('lead', 'name: Lead\nkind: lead\nprovider: claude\npermission: readonly\ncount: 2'), DEV]), 'lead_count')?.line === 6, 'the lead is count 1')
  check(same(codes(parse([teamMd(), roleMd('lead', 'name: Lead\nkind: lead\nprovider: claude\npermission: readonly\ncount: 2'), DEV])), ['lead_count']), 'a lead with count 2 is not also "no lead"')
  const badLead = parse([teamMd(), roleMd('lead', 'name: Lead\nkind: lead\nprovider: claude\nmodel: gpt-x\npermission: readonly'), DEV, routineMd('daily', 'cron: 0 18 * * 1-5\nrole: lead')])
  check(same(codes(badLead), ['bad_model']), 'a lead with a bad model: only its own error, no "no lead" nor routine_role')
  check(same(codes(parse([teamMd(), roleMd('lead', 'name: Lead\nprovider: claude\npermission: readonly'), DEV])), ['required']), 'a role whose kind cannot be read is not reported as "no lead"')
  check(same(codes(parse(base(roleMd('boss', 'name: Boss\nkind: lead\nprovider: gemini\npermission: readonly')))), ['bad_value', 'two_leads']), 'a second lead still counts when it fails')
  check(errOf(withRole('dev-2', 'name: X\nkind: dev\nprovider: claude\npermission: total'), 'bad_name')?.detail === 'dev', 'dev-2 next to dev would share agent ids')
  check(withRole('dev-5', 'name: X\nkind: dev\nprovider: claude\npermission: total').ok && withRole('dev2', 'name: X\nkind: dev\nprovider: claude\npermission: total').ok, 'dev-5 and dev2 do not collide')
  const missing = withRole('qa', 'name: QA')
  check(same(codes(missing), ['required', 'required', 'required']) && same(errs(missing).map((e) => e.key), ['kind', 'provider', 'permission']), 'kind, provider and permission are required')
  check(errOf(withRole('qa', 'name: QA\nkind: tester\nprovider: claude\npermission: readonly'), 'bad_value')?.key === 'kind', 'unknown kind')
  check(errOf(withRole('qa', 'name: QA\nkind: qa\nprovider: gemini\npermission: readonly'), 'bad_value')?.key === 'provider', 'unknown provider')
  check(errOf(withRole('qa', 'name: QA\nkind: qa\nprovider: claude\npermission: admin'), 'bad_value')?.key === 'permission', 'unknown permission')
  check(errOf(withRole('qa', 'name: QA\nkind: qa\nprovider: claude\npermission: readonly\ncolor: red'), 'unknown_key')?.line === 6, 'unknown role key with its line')
  const role = (front) => withRole('qa', `name: QA\nkind: qa\npermission: readonly\n${front}`)
  const qaOf = (res) => res.ok && res.def.roles.find((r) => r.id === 'qa')
  check(qaOf(role('provider: claude\nmodel: opus\neffort: max'))?.model === 'opus' && qaOf(role('provider: claude\nmodel: opus\neffort: max')).effort === 'max', 'claude alias and effort')
  check(qaOf(role('provider: claude\nmodel: claude-opus-4-5'))?.model === 'claude-opus-4-5', 'claude full model id')
  check(qaOf(role('provider: claude\nmodel: default'))?.model === undefined, 'model default = omitted')
  check(errOf(role('provider: claude\nmodel: gpt-6-luna'), 'bad_model')?.key === 'model', 'a codex model on claude')
  check(errOf(role('provider: claude\neffort: minimal'), 'bad_effort')?.detail === 'low|medium|high|xhigh|max', 'claude efforts from agentTune')
  check(qaOf(role('provider: codex\nmodel: gpt-6-luna\neffort: minimal'))?.effort === 'minimal', 'codex model and effort')
  check(errOf(role('provider: codex\nmodel: GPT 6'), 'bad_model') && errOf(role('provider: codex\neffort: max'), 'bad_effort'), 'codex model RE and efforts')
  check(qaOf(role('provider: claude\ncount: 4'))?.count === 4 && errOf(role('provider: claude\ncount: 5'), 'bad_value')?.key === 'count' && errOf(role('provider: claude\ncount: 0'), 'bad_value'), 'count 1..4')
  const custom = (tools, provider = 'claude') => withRole('ops', `name: Ops\nkind: custom\nprovider: ${provider}\npermission: custom\nallowedTools: ${tools}`)
  const ops = custom('Read, Bash(git log:*), Bash(npm run a,b), Read')
  check(ops.ok && same(ops.def.roles.find((r) => r.id === 'ops').allowedTools, ['Read', 'Bash(git log:*)', 'Bash(npm run a,b)']) && same(ops.warnings, []), 'allowedTools split at paren depth 0, deduped')
  check(errOf(custom('Bash(rm "x")'), 'tool_pattern')?.detail === 'Bash(rm "x")' && errOf(custom('Bash(a(b))'), 'tool_pattern') && errOf(custom('9x'), 'tool_pattern'), 'tool patterns by TOOL_PATTERN_RE')
  check(errOf(custom(Array.from({ length: 33 }, (_, i) => `T${i}`).join(',')), 'too_many')?.key === 'allowedTools', 'at most 32 tools')
  check(errOf(withRole('qa', 'name: QA\nkind: qa\nprovider: claude\npermission: readonly\nallowedTools: Read'), 'bad_value')?.detail === 'custom', 'allowedTools only on custom roles')
  const codexCustom = custom('Read', 'codex')
  check(codexCustom.ok && same(codexCustom.warnings.map((w) => [w.code, w.key, w.detail, w.severity]), [['bad_value', 'allowedTools', 'codex', 'warning']]), 'allowedTools on a codex role only warns (no allowlist there)')
  check(D.validToolPattern('mcp__srv__tool') && D.validToolPattern('WebFetch(domain:example.com)') && !D.validToolPattern('Bash()') && !D.validToolPattern(`Bash(${'x'.repeat(121)})`) && !D.validToolPattern(42), 'validToolPattern')
  const instr = withRole('qa', 'name: QA\nkind: qa\nprovider: claude\npermission: readonly', '\n\n  Review carefully.\n\n')
  check(instr.ok && instr.def.roles.find((r) => r.id === 'qa').instructions === 'Review carefully.', 'instructions = trimmed body')
  check(codes(parse(base(...Array.from({ length: 11 }, (_, i) => roleMd(`r${i}`, 'name: R\nkind: dev\nprovider: claude\npermission: total'))))).includes('too_many'), 'more than 12 roles')
}

function routineChecks() {
  const withRoutine = (front, body) => parse(base(routineMd('daily', front, body)))
  const ok = withRoutine('cron:  0  18 * * 1-5\nrole: lead\ntitle: Daily')
  check(ok.ok && same(ok.def.routines, [{ id: 'daily', cron: '0 18 * * 1-5', action: 'wake', role: 'lead', title: 'Daily', prompt: 'Write the summary.', enabled: true }]), 'routine: cron normalized, wake and enabled by default')
  check(withRoutine('cron: 0 9 * * *\nrole: dev\naction: task\nenabled: false').ok, 'a disabled task routine for a dev')
  check(errOf(withRoutine('cron: 61 * * * *\nrole: lead'), 'cron')?.line === 2, 'invalid cron with its line')
  check(errOf(withRoutine('cron: 0 0 30 2 *\nrole: lead'), 'cron'), 'a cron that never runs (Feb 30)')
  check(errOf(withRoutine('cron: */5 * * * *\nrole: lead'), 'cron_interval'), 'a cron closer than 15 minutes')
  check(withRoutine('cron: */15 * * * *\nrole: lead').ok, 'every 15 minutes is fine')
  check(errOf(withRoutine('cron: 0 9 * * *\nrole: ghost'), 'routine_role')?.detail === 'ghost', 'a routine names an existing role')
  check(errOf(withRoutine('cron: 0 9 * * *\nrole: lead\naction: task'), 'routine_role')?.detail === 'lead', 'a task routine is never for the lead')
  check(errOf(withRoutine('cron: 0 9 * * *\nrole: lead\naction: ping'), 'bad_value')?.key === 'action', 'action wake or task')
  check(errOf(withRoutine('cron: 0 9 * * *\nrole: lead', ''), 'required')?.key === 'prompt', 'the prompt body is required')
  check(same(errs(withRoutine('role: lead')).map((e) => e.key), ['cron']), 'cron is required')
  check(errOf(withRoutine('cron: 0 9 * * *\nrole: lead\nenabled: no'), 'bad_value')?.key === 'enabled', 'enabled is a boolean')
  check(errOf(withRoutine('cron: 0 9 * * *\nrole: lead\nevery: day'), 'unknown_key'), 'unknown routine key')
  check(codes(parse(base(...Array.from({ length: 17 }, (_, i) => routineMd(`r${i}`, 'cron: 0 9 * * *\nrole: lead'))))).includes('too_many'), 'more than 16 routines')
}

function templateChecks() {
  for (const lang of ['es', 'en']) {
    const files = D.defaultTemplate(lang)
    const res = parse(files)
    check(res.ok && same(res.warnings, []), `defaultTemplate ${lang} parses clean`)
    check(same(files.map((f) => f.rel), ['team.md', 'roles/lead.md', 'roles/dev.md', 'roles/qa.md', 'roles/research.md', 'routines/daily-summary.md']), `defaultTemplate ${lang}: team, four roles, daily summary`)
    const r = Object.fromEntries(res.def.roles.map((x) => [x.id, x]))
    check(r.lead.kind === 'lead' && r.lead.model === 'opus' && r.lead.effort === 'high' && r.lead.permission === 'readonly' && r.lead.count === 1, `${lang}: lead opus high readonly`)
    check(r.dev.model === 'sonnet' && r.dev.effort === 'medium' && r.dev.permission === 'total' && r.dev.count === 2, `${lang}: dev sonnet medium total x2`)
    check(r.qa.model === 'sonnet' && r.qa.permission === 'readonly' && r.research.model === 'sonnet' && r.research.permission === 'readonly' && Object.values(r).every((x) => x.provider === 'claude'), `${lang}: qa and research sonnet readonly`)
    check(same(res.def.routines.map((x) => [x.id, x.cron, x.action, x.role, x.enabled]), [['daily-summary', '0 18 * * 1-5', 'wake', 'lead', true]]), `${lang}: daily summary 0 18 * * 1-5 wakes the lead`)
    check(/snaos team task create/.test(r.lead.instructions) && /--no-plan/.test(r.lead.instructions) && /snaos team note/.test(r.lead.instructions), `${lang}: the lead is told task create, --no-plan and note`)
    check(/snaos team note/.test(res.def.routines[0].prompt), `${lang}: the summary routine uses snaos team note`)
    // 2.7.0 runtime walkthrough: a readonly QA cannot run a compound command; it reads the change through main and runs
    // one test command at a time, and a denied one becomes a permission request for the user.
    const qa = r.qa.instructions
    check(/`snaos team diff`/.test(qa) && /`snaos team log`/.test(qa), `${lang}: the QA reads the change with snaos team diff and its history with snaos team log`)
    check((lang === 'es' ? /de a un comando por vez \(por ejemplo `npm test`\)/ : /one command at a time \(for example `npm test`\)/).test(qa) && /`&&`, `;` o `\|`|`&&`, `;` or `\|`/.test(qa), `${lang}: the QA runs the tests one command at a time, never chained`)
    check((lang === 'es' ? /pedido de permiso para el usuario/ : /permission request for the user/).test(qa), `${lang}: the QA is told a denied command becomes a permission request for the user`)
    check(files.every((f) => !/[\u2013\u2014\r]/.test(f.text) && f.text.endsWith('\n') && !f.text.startsWith('\uFEFF')), `${lang}: LF, no BOM, no dashes`)
    check(same(D.renderTeamFiles(D.defaultDraft(lang)), files) && same(D.defaultTemplate(lang), files), `${lang}: deterministic`)
  }
  const es = parse(D.defaultTemplate('es'))
  const esLead = es.def.roles.find((r) => r.id === 'lead')
  check(same(es.def.roles.map((r) => r.id), ['dev', 'lead', 'qa', 'research']), 'roles come in rel order')
  check(es.def.name === 'Equipo' && esLead.name === 'Líder' && /Sos el Líder/.test(esLead.instructions) && /preguntá/.test(es.def.rules) && es.def.roles.find((r) => r.id === 'research').name === 'Investigación', 'es: tildes and voseo')
  check(/Corré las pruebas/.test(es.def.roles.find((r) => r.id === 'qa').instructions) && /Si te niegan un comando/.test(es.def.roles.find((r) => r.id === 'qa').instructions), 'es: the QA in voseo too')
  const en = parse(D.defaultTemplate('en'))
  check(en.def.name === 'Team' && /^You are the team Lead/.test(en.def.roles.find((r) => r.id === 'lead').instructions), 'en: English')
}

function renderChecks() {
  const draft = {
    lang: 'en', name: '"Quoted" team', goal: 'Ship\r\nthe app', rules: undefined, baseBranch: 'develop', maxConcurrent: 3, leadApprovesSmallPlans: false, verify: 'npm test',
    roles: [
      { id: 'boss', name: 'Boss', kind: 'lead', provider: 'codex', model: 'gpt-6-luna', effort: 'high', permission: 'readonly', count: 3, enabled: true },
      { id: 'dev', name: '  Dev\tOne  ', kind: 'dev', provider: 'claude', model: 'default', permission: 'total', count: 2, enabled: true },
      { id: 'qa', name: 'QA', kind: 'qa', provider: 'claude', permission: 'readonly', count: 1, enabled: false },
    ],
    dailySummary: true,
  }
  const files = D.renderTeamFiles(draft)
  check(same(files.map((f) => f.rel), ['team.md', 'roles/boss.md', 'roles/dev.md', 'routines/daily-summary.md']), 'disabled roles are not written')
  const res = parse(files)
  check(res.ok, 'a rendered draft parses: ' + JSON.stringify(errs(res)))
  const d = res.def
  check(d.name === '"Quoted" team' && d.goal === 'Ship\nthe app' && d.rules === '' && d.baseBranch === 'develop' && d.verify === 'npm test' && d.maxConcurrent === 3 && d.leadApprovesSmallPlans === false, 'team fields round trip (quotes kept, CRLF normalized)')
  check(d.roles[0].id === 'boss' && d.roles[0].provider === 'codex' && d.roles[0].model === 'gpt-6-luna' && d.roles[0].effort === 'high' && d.roles[0].count === 1, 'the lead is written with count 1')
  check(d.roles[1].name === 'Dev One' && d.roles[1].model === undefined && d.roles[1].count === 2, 'names to one line, model default omitted')
  check(d.routines[0].role === 'boss', 'the daily summary wakes the draft lead')
  check(files[0].text === '---\nname: "Quoted" team\nbaseBranch: develop\nverify: npm test\nmaxConcurrent: 3\nleadApprovesSmallPlans: false\n---\n\nShip\nthe app\n', 'team.md exact text')
  const wrapped = D.renderTeamFiles({ ...draft, name: '"Wrapped"', dailySummary: false, rules: 'R1' })
  const w = parse(wrapped)
  check(w.ok && w.def.name === '"Wrapped"' && w.def.rules === 'R1' && w.def.goal === 'Ship\nthe app' && wrapped.length === 3, 'a name wrapped in quotes survives; rules under ## Rules; no routine')
  check(/\n## Reglas\n/.test(D.renderTeamFiles({ ...draft, lang: 'es', rules: 'R' })[0].text), 'es writes ## Reglas')
  const noName = parse(D.renderTeamFiles({ ...draft, name: '' }))
  check(errOf(noName, 'required')?.key === 'name', 'an empty draft name renders "" and fails required')
  const role = { id: 'ops', name: 'Ops', kind: 'custom', provider: 'claude', model: 'sonnet', effort: 'low', permission: 'custom', allowedTools: ['Read', 'Bash(git log:*)'], count: 3, instructions: 'Line one\n\n- two' }
  const text = D.serializeRole(role)
  check(text === '---\nname: Ops\nkind: custom\nprovider: claude\nmodel: sonnet\neffort: low\npermission: custom\nallowedTools: Read, Bash(git log:*)\ncount: 3\n---\n\nLine one\n\n- two\n', 'serializeRole exact text')
  const back = parse(base({ rel: 'roles/ops.md', text }))
  check(back.ok && same(back.def.roles.find((r) => r.id === 'ops'), role), 'serializeRole round trips through parseDefinition')
  const plain = { id: 'qa', name: 'QA', kind: 'qa', provider: 'claude', permission: 'readonly', count: 1, instructions: '' }
  check(D.serializeRole(plain) === '---\nname: QA\nkind: qa\nprovider: claude\npermission: readonly\ncount: 1\n---\n' && same(parse(base({ rel: 'roles/qa.md', text: D.serializeRole(plain) })).def.roles.find((r) => r.id === 'qa'), plain), 'optional keys omitted; empty instructions')
}

// ---- lineDiff -----------------------------------------------------------------------------------
const L = (n, f = (i) => `l${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n') + (n ? '\n' : '')
function applyHunks(before, hunks) {
  const a = before === '' ? [] : before.replace(/\n$/, '').split('\n')
  const out = []
  let i = 0
  for (const h of hunks) {
    const start = h.oldLines > 0 ? h.oldStart - 1 : h.oldStart
    assert.ok(start >= i, 'hunks in order')
    while (i < start) out.push(a[i++])
    assert.equal(out.length, h.newLines > 0 ? h.newStart - 1 : h.newStart, 'newStart matches')
    let o = 0, n = 0
    for (const line of h.lines) {
      const t = line[0], s = line.slice(1)
      if (t !== '+') { assert.equal(a[i], s, 'old line matches'); i++; o++ }
      if (t !== '-') { out.push(s); n++ }
    }
    assert.equal(o, h.oldLines); assert.equal(n, h.newLines)
  }
  while (i < a.length) out.push(a[i++])
  return out.length ? out.join('\n') + '\n' : ''
}
function lcs(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
  return dp[a.length][b.length]
}

function diffChecks() {
  check(same(F.lineDiff('a\nb\n', 'a\nb\n'), { hunks: [], add: 0, del: 0, truncated: false }), 'identical text: no hunks')
  const ten = L(10)
  const mid = F.lineDiff(ten, ten.replace('l5\n', 'L5\n'))
  check(mid.add === 1 && mid.del === 1 && mid.hunks.length === 1 && same(mid.hunks[0], { oldStart: 2, oldLines: 7, newStart: 2, newLines: 7, lines: [' l2', ' l3', ' l4', '-l5', '+L5', ' l6', ' l7', ' l8'] }), 'one change with 3 lines of context')
  const added = F.lineDiff('', 'x\ny\n')
  check(same(added.hunks, [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+x', '+y'] }]), 'a new file: @@ -0,0 +1,2 @@')
  check(same(F.lineDiff('x\n', '').hunks, [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ['-x'] }]), 'a removed file')
  const twenty = L(20)
  const far = F.lineDiff(twenty, twenty.replace('l2\n', 'X\n').replace('l18\n', 'Y\n'))
  check(far.hunks.length === 2 && far.hunks[1].oldStart === 15, 'changes 16 lines apart: two hunks')
  const near = F.lineDiff(twenty, twenty.replace('l5\n', 'X\n').replace('l11\n', 'Y\n'))
  check(near.hunks.length === 1 && near.hunks[0].oldLines === 13, 'changes 6 lines apart: one hunk')
  check(F.lineDiff(twenty, twenty.replace('l5\n', 'X\n'), { context: 0 }).hunks[0].lines.length === 2, 'context 0')
  const many = F.lineDiff('', L(500))
  check(many.truncated && many.add === 500 && many.hunks.length === 1 && many.hunks[0].lines.length === 400 && many.hunks[0].newLines === 400, '500 added lines: truncated to 400 changed lines, counts stay whole')
  const cut = F.lineDiff(L(60), L(60, (i) => (i % 10 === 0 ? `X${i}` : `l${i}`)), { maxLines: 7 })
  check(cut.truncated && cut.del === 6 && cut.add === 6 && cut.hunks.reduce((s, h) => s + h.lines.filter((l) => l[0] !== ' ').length, 0) === 7, 'maxLines counts changed lines across hunks')
  const a = L(1500, (i) => `a${i}`), b = L(1500, (i) => `b${i}`)
  const t0 = Date.now()
  const whole = F.lineDiff(a, b, { maxLines: 1e6 })
  check(whole.del === 1500 && whole.add === 1500 && whole.hunks.length === 1 && whole.hunks[0].lines[0] === '-a1' && whole.hunks[0].lines[1500] === '+b1' && applyHunks(a, whole.hunks) === b, 'edit distance over 2000: one whole replace')
  check(Date.now() - t0 < 5000, 'whole replace stays fast')
  const keep = F.lineDiff(`head\n${a}tail\n`, `head\n${b}tail\n`, { maxLines: 1e6 })
  check(keep.hunks[0].lines[0] === ' head' && keep.hunks[0].lines[keep.hunks[0].lines.length - 1] === ' tail', 'the common head and tail stay as context')
  // Random cases: the hunks rebuild `after` from `before` and the edit count is minimal.
  let seed = 7
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
  let minimal = true, rebuilt = true
  for (let c = 0; c < 400; c++) {
    const xs = Array.from({ length: rnd(25) }, () => 'abcd'[rnd(4)])
    const ys = Array.from({ length: rnd(25) }, () => 'abcd'[rnd(4)])
    const before = xs.length ? xs.join('\n') + '\n' : ''
    const after = ys.length ? ys.join('\n') + '\n' : ''
    const d = F.lineDiff(before, after, { maxLines: 1e6, context: rnd(4) })
    if (applyHunks(before, d.hunks) !== after) rebuilt = false
    if (d.add + d.del !== xs.length + ys.length - 2 * lcs(xs, ys)) minimal = false
  }
  check(rebuilt, '400 random diffs apply back to the after text')
  check(minimal, '400 random diffs are minimal (add + del = n + m - 2 LCS)')

  const files = F.diffTeamFiles(
    [{ rel: 'team.md', text: 'a\n' }, { rel: 'roles/qa.md', text: 'q\n' }, { rel: 'roles/dev.md', text: 'd\n' }],
    [{ rel: 'team.md', text: 'b\n' }, { rel: 'roles/dev.md', text: 'd\n' }, { rel: 'routines/x.md', text: 'r\n' }],
  )
  check(same(files.map((f) => [f.rel, f.status, f.add, f.del]), [['roles/qa.md', 'removed', 0, 1], ['routines/x.md', 'added', 1, 0], ['team.md', 'changed', 1, 1]]), 'diffTeamFiles: sorted by rel, unchanged files skipped')
  check(F.diffTeamFiles([], [{ rel: 'team.md', text: L(10) }], { maxLinesPerFile: 3 })[0].truncated === true, 'maxLinesPerFile')
}

function riskChecks() {
  const role = (id, o = {}) => ({ id, name: id, kind: 'dev', provider: 'claude', permission: 'readonly', count: 1, instructions: `i-${id}`, ...o })
  const def = (o = {}) => ({ name: 'T', goal: 'g', rules: '', verifyTimeoutMin: 20, maxRunMinutes: 45, maxConcurrent: 2, leadApprovesSmallPlans: true, extraRepos: [], routines: [], roles: [], ...o })
  const before = def({
    verify: 'npm test',
    extraRepos: [{ id: 'lib', path: '../lib', verify: 'mvn test' }],
    routines: [{ id: 'daily', cron: '0 18 * * 1-5', action: 'wake', role: 'lead', prompt: 'p', enabled: true }, { id: 'off', cron: '0 9 * * *', action: 'task', role: 'dev', prompt: 'p', enabled: false }],
    roles: [role('lead', { kind: 'lead' }), role('dev', { permission: 'total', count: 2 }), role('qa'), role('ops', { kind: 'custom', permission: 'custom', allowedTools: ['Read'] })],
  })
  const after = def({
    verify: 'npm run build',
    extraRepos: [{ id: 'lib', path: '../lib2', verify: 'mvn test' }, { id: 'docs', path: '../docs', verify: 'make' }],
    routines: [{ id: 'daily', cron: '0 9 * * *', action: 'wake', role: 'lead', prompt: 'other', enabled: true }, { id: 'off', cron: '0 9 * * *', action: 'task', role: 'dev', prompt: 'p', enabled: true }, { id: 'weekly', cron: '0 9 * * 1', action: 'task', role: 'dev', prompt: 'w', enabled: true }],
    roles: [role('lead', { kind: 'lead', instructions: 'changed' }), role('dev', { permission: 'total', count: 3, provider: 'codex' }), role('qa', { permission: 'total' }), role('ops', { kind: 'custom', permission: 'custom', allowedTools: ['Read', 'Bash(git log:*)'] }), role('scout')],
  })
  const flags = F.teamRiskFlags(before, after)
  check(same(flags, [
    { code: 'permissionUp', roleId: 'qa', from: 'readonly', to: 'total' },
    { code: 'toolsAdded', roleId: 'ops', tools: ['Bash(git log:*)'] },
    { code: 'providerChanged', roleId: 'dev', from: 'claude', to: 'codex' },
    { code: 'countUp', roleId: 'dev', from: 2, to: 3 },
    { code: 'verifyChanged', repoId: 'main', to: 'npm run build', from: 'npm test' },
    { code: 'verifyChanged', repoId: 'docs', to: 'make' },
    { code: 'extraRepo', repoId: 'lib', path: '../lib2' },
    { code: 'extraRepo', repoId: 'docs', path: '../docs' },
    { code: 'routineAdded', routineId: 'off', cron: '0 9 * * *', action: 'task' },
    { code: 'routineAdded', routineId: 'weekly', cron: '0 9 * * 1', action: 'task' },
    { code: 'instructionsChanged', roleId: 'lead' },
    { code: 'instructionsChanged', roleId: 'scout' },
  ]), 'teamRiskFlags: every code in the fixed order: ' + JSON.stringify(flags))
  check(same(F.teamRiskFlags(after, after), []), 'no change, no flags')
  check(F.teamRiskFlags(after, before).every((f) => f.code !== 'permissionUp' && f.code !== 'countUp'), 'lowering permission or count is not flagged')
  const first = F.teamRiskFlags(null, parse(D.defaultTemplate('es')).def)
  check(same(first.map((f) => [f.code, f.roleId ?? f.routineId]), [['permissionUp', 'dev'], ['routineAdded', 'daily-summary']]) && first[0].from === null, 'first trust: only the writer role and the routine are flagged')
  const prev = D.defaultTemplate('en')
  const next = prev.map((f) => (f.rel === 'roles/dev.md' ? { rel: f.rel, text: f.text.replace('count: 2', 'count: 3') } : f))
  const dd = F.diffDefinitions({ files: prev, def: parse(prev).def }, { files: next, def: parse(next).def })
  check(dd.files.length === 1 && dd.files[0].rel === 'roles/dev.md' && same(dd.risks, [{ code: 'countUp', roleId: 'dev', from: 2, to: 3 }]) && dd.truncated === false, 'diffDefinitions: file diff plus risks')
  const broken = F.diffDefinitions({ files: prev, def: null }, { files: [{ rel: 'team.md', text: L(500) }], def: null })
  check(same(broken.risks, []) && broken.truncated === true, 'an invalid definition: no risks, truncated when a file is')
}

function needsChecks() {
  const ap = (id, o = {}) => ({ id, state: 'pending', decider: 'user', requestedBy: 'dev', at: 100, payload: { kind: 'plan', planRev: 1, small: false, text: '' }, ...o })
  const card = (id, o = {}) => ({ id, kind: 'choice', state: 'open', at: 100, ...o })
  const q = (id, o = {}) => ({ id, agentId: 'dev', reason: 'assigned', mode: 'exec', priority: 'normal', at: 100, approved: false, ...o })
  const input = {
    trust: 'changed', trustSince: 500, paused: { reason: 'auth', at: 50 },
    approvals: [
      ap('a-2', { at: 300, taskId: 't-1' }),
      ap('a-1', { at: 300, payload: { kind: 'hire', roleId: 'x', diff: {}, risks: [] } }),
      ap('a-3', { decider: 'lead' }),
      ap('a-4', { state: 'applying', at: 10, payload: { kind: 'final', summary: '' } }),
      ap('a-5', { state: 'approved' }),
    ],
    cards: [card('k-1', { at: 200, taskId: 't-2' }), card('k-2', { state: 'answered' }), card('k-3', { state: 'dismissed' })],
    queue: [q('q-1', { at: 50, priority: 'low' }), q('q-2', { at: 50, priority: 'urgent' }), q('q-3', { at: 10, approved: true }), q('q-4', { at: 40, taskId: 't-1' })],
  }
  const rows = N.teamNeedsRows(input)
  check(same(rows.map((r) => r.id), ['paused', 'trust', 'a-4', 'k-1', 'a-1', 'a-2', 'q-4', 'q-2', 'q-1']), 'order: rank, at, queue priority, id: ' + rows.map((r) => r.id).join(','))
  check(same(rows.map((r) => r.rank), [1, 1, 2, 2, 2, 2, 3, 3, 3]) && same(rows.map((r) => r.push), [true, true, true, true, true, true, false, false, false]), 'ranks and push: 1 and 2 push, 3 does not')
  check(rows[0].at === 50 && rows[1].at === 500 && rows[2].approvalKind === 'final' && rows[4].approvalKind === 'hire' && rows[5].taskId === 't-1' && rows[3].taskId === 't-2', 'at, approvalKind and taskId carried')
  check(N.teamNeedsCount(input) === 9, 'teamNeedsCount = rows')
  check(same(N.needsOfTask(rows, 't-1').map((r) => r.id), ['a-2', 'q-4']), 'needsOfTask')
  check(N.teamNeedsCount({ trust: 'trusted', paused: { reason: 'user', at: 1 }, approvals: [ap('a-1', { decider: 'lead' })], cards: [], queue: [q('q-1', { approved: true })] }) === 0, 'a user pause, a lead-decided approval and an approved queue item never count')
  check(N.teamNeedsRows({ trust: 'missing', paused: null, approvals: [], cards: [], queue: [] })[0].at === 0, 'trust without trustSince sorts at 0')
  check(N.teamNeedsCount({ trust: 'trusted', paused: { reason: 'billing', at: 1 }, approvals: [], cards: [], queue: [] }) === 1, 'a billing pause counts')
  check(same(rows.map(N.teamNeedKey), ['teams.need.paused', 'teams.need.trust', 'teams.need.approval.final', 'teams.need.card', 'teams.need.approval.hire', 'teams.need.approval.plan', 'teams.need.dispatch', 'teams.need.dispatch', 'teams.need.dispatch']), 'teamNeedKey')
}

staticChecks()
idChecks()
textChecks()
frontmatterChecks()
teamFileChecks()
repoChecks()
folderChecks()
roleChecks()
routineChecks()
templateChecks()
renderChecks()
diffChecks()
riskChecks()
needsChecks()
console.log(`PASS: ${checks} teams definition checks (ids, emptyRuntime, frontmatter grammar and line errors, folder caps, DEF_REL_RE, reserved ids, one lead, models, efforts, tool patterns, routines, CRLF and BOM hash, template es/en, render and serializeRole round trips, lineDiff, risk flags, needs rows)`)
