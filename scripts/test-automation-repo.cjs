// R30-12: per-repo .snagentsos.json (E8-FR-23..27). Called from
// test-automation.cjs with its harness (check, load, loadRenderer). Covers the
// cwd containment (lexical, junction/symlink, UNC, `C:foo`), the hash (stable
// across BOM and CRLF), needsTrust (a profile alone asks), the trust store,
// main's handlers (stale hash = changed, export trusted, no silent overwrite),
// the 2 s read timeout, the renderer draft/export helpers, the setup hold in
// the store, reload and the export -> import round trip.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

async function run({ check, load, loadRenderer }) {
  const RC = load('src/main/repoConfig/repoConfig.ts')
  const { TrustStore, normTrustPath, TRUST_MAX_ENTRIES } = load('src/main/repoConfig/TrustStore.ts')
  const { repoConfigHandlers } = load('src/main/ipc/registerRepoConfigIpc.ts', {
    require: (id) => (id === 'electron' ? { ipcMain: { handle() {} }, app: { getPath: () => os.tmpdir(), isPackaged: false } } : require(id)),
  })
  const SH = load('src/shared/repo-config.ts')
  const win = process.platform === 'win32'
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-repocfg-'))
  const repo = path.join(tmp, 'repo')
  const outside = path.join(tmp, 'outside')
  fs.mkdirSync(path.join(repo, 'web'), { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  const writeCfg = (obj, opts = {}) => {
    let text = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)
    if (opts.crlf) text = text.replace(/\n/g, '\r\n')
    if (opts.bom) text = '\uFEFF' + text
    fs.writeFileSync(path.join(repo, '.snagentsos.json'), text)
  }
  try {
    // --- hash: stable across BOM and CRLF, sensitive to content ---------------
    const body = '{\n  "version": 1,\n  "consoles": [{}]\n}\n'
    const h = RC.hashContent(Buffer.from(body))
    check(/^[0-9a-f]{64}$/.test(h), 'hashContent is sha256 hex')
    check(RC.hashContent(Buffer.from('\uFEFF' + body.replace(/\n/g, '\r\n'))) === h, 'a BOM and CRLF line endings hash like the LF original')
    check(RC.hashContent(Buffer.from(body.replace(/\n/g, '\r'))) === h, 'lone CR line endings too')
    check(RC.hashContent(Buffer.from(body.replace('{}', '{ "command": "x" }'))) !== h, 'a changed command changes the hash')

    // --- cwd containment ------------------------------------------------------
    for (const bad of ['C:foo', '..\\x', '../x', 'a/../..', '\\\\srv\\share', '//srv/share', '/etc', 'C:\\Windows', 'web/../../x', 'a:b']) {
      check(SH.repoCwdProblem(bad) !== null && RC.validateCwd(repo, bad) !== null, `cwd ${JSON.stringify(bad)} is rejected`)
    }
    for (const good of ['web', './web', 'web/../web', 'a/b/c', 'web\\sub']) {
      check(SH.repoCwdProblem(good) === null && RC.validateCwd(repo, good) === null, `cwd ${JSON.stringify(good)} stays inside`)
    }

    // --- needsTrust -----------------------------------------------------------
    check(SH.repoConfigNeedsTrust({ version: 1, grid: 4, connectionProfile: 'dedi', consoles: [{ title: 'a' }] }) === true, 'a file with only a grid and a connectionProfile needs trust')
    check(SH.repoConfigNeedsTrust({ version: 1, grid: 2, consoles: [{ title: 'a' }, { title: 'b', agent: 'shell' }] }) === false, 'grid and shell titles only: no trust')
    check(SH.repoConfigNeedsTrust({ version: 1, consoles: [{ agent: 'claude' }] }) === false, 'an agent console alone runs a local preset: no trust')
    check(SH.repoConfigNeedsTrust({ version: 1, consoles: [{ agent: 'claude', prompt: 'hola' }] }) && SH.repoConfigNeedsTrust({ version: 1, consoles: [{ command: 'npm run dev' }] }), 'a prompt or a command needs trust')
    check(SH.repoConfigNeedsTrust({ version: 1, setup: { command: 'pnpm i' }, consoles: [{}] }) && SH.repoConfigNeedsTrust({ version: 1, consoles: [{}], quickCommands: [{ label: 'x', action: 'send', text: 'y' }] }), 'a setup or quick commands need trust')

    // --- readRepoConfig -------------------------------------------------------
    let r = await RC.readRepoConfig(repo, null)
    check(r.status === 'none' && r.needsTrust === false, 'no file: none')
    check((await RC.readRepoConfig('relative/dir', null)).status === 'none' && (await RC.readRepoConfig(42, null)).status === 'none', 'a relative or non-string dir is none')
    const full = {
      version: 1,
      name: 'Api',
      grid: 4,
      setup: { command: 'pnpm install', waitForSetup: true },
      consoles: [{ title: 'Claude', agent: 'claude', prompt: 'lee el README' }, { title: 'Web', cwd: 'web', command: 'npm run dev' }, { title: 'Gem', agent: 'gemini' }],
      quickCommands: [{ label: 'Tests', action: 'send', text: 'npm test', enter: true }, { label: 'Review', action: 'agent', agent: 'claude', prompt: 'revisa' }],
    }
    writeCfg(full, { bom: true, crlf: true })
    r = await RC.readRepoConfig(repo, null)
    check(r.status === 'ok' && r.config.name === 'Api' && r.config.consoles.length === 3 && r.needsTrust === true && r.trusted === false, 'a valid file with BOM and CRLF reads ok')
    check(r.consoleCwds[0] === null && r.consoleCwds[1] === path.resolve(repo, 'web') && r.consoleCwds[2] === null, 'console cwds resolve inside the repo')
    const okSha = r.sha256
    writeCfg('{ "version": 1, "consoles": [ }')
    r = await RC.readRepoConfig(repo, null)
    check(r.status === 'invalid' && r.errorCode === 'json' && /^JSON:/.test(r.error), 'broken JSON is invalid with the parser message')
    writeCfg({ version: 1, consoles: [{ title: 'ok' }, { title: 'x'.repeat(61) }] })
    r = await RC.readRepoConfig(repo, null)
    check(r.status === 'invalid' && r.errorCode === 'schema' && r.error.startsWith('consoles[1].title:'), 'the first schema problem is reported with its JSON path')
    writeCfg({ version: 2, consoles: [{}] })
    check((await RC.readRepoConfig(repo, null)).error.startsWith('version:'), 'an unknown version is rejected')
    writeCfg({ version: 1, consoles: [] })
    check((await RC.readRepoConfig(repo, null)).status === 'invalid', 'zero consoles is rejected')
    writeCfg({ version: 1, setup: { command: 'x' }, consoles: Array.from({ length: 12 }, () => ({})) })
    check((await RC.readRepoConfig(repo, null)).error.startsWith('consoles:'), 'a setup plus 12 consoles exceeds the grid')
    writeCfg({ version: 1, consoles: [{}], quickCommands: Array.from({ length: 21 }, (_, i) => ({ label: `q${i}`, action: 'send', text: 'x' })) })
    check((await RC.readRepoConfig(repo, null)).error.startsWith('quickCommands:'), 'more than 20 quick commands is rejected')
    writeCfg({ version: 1, consoles: [{ color: 'red; background: url(x)' }] })
    check((await RC.readRepoConfig(repo, null)).error.startsWith('consoles[0].color:'), 'a color that is not a color is rejected')
    for (const bad of ['C:foo', '..\\x', '\\\\srv\\share\\x']) {
      writeCfg({ version: 1, consoles: [{}, { cwd: bad }] })
      r = await RC.readRepoConfig(repo, null)
      check(r.status === 'invalid' && r.errorCode === 'cwd_escape' && r.error.startsWith('consoles[1].cwd:'), `a cwd ${JSON.stringify(bad)} in the file is an error`)
    }
    // A junction (Windows) / symlink (POSIX) inside the repo that points out of it.
    const link = path.join(repo, 'escape')
    fs.symlinkSync(outside, link, win ? 'junction' : 'dir')
    writeCfg({ version: 1, consoles: [{ cwd: 'escape' }] })
    r = await RC.readRepoConfig(repo, null)
    check(r.status === 'invalid' && r.errorCode === 'cwd_escape' && /junction or symlink/.test(r.error), 'a cwd through a junction out of the repo is rejected by realpath')
    const inner = path.join(repo, 'inner-link')
    fs.symlinkSync(path.join(repo, 'web'), inner, win ? 'junction' : 'dir')
    writeCfg({ version: 1, consoles: [{ cwd: 'inner-link' }, { cwd: 'gone/away' }] })
    r = await RC.readRepoConfig(repo, null)
    check(r.status === 'ok' && r.consoleCwds[0] === inner, 'a junction that stays inside the repo is fine')
    check(r.consoleCwds[1] === null && r.warnings.length === 1 && r.warnings[0].code === 'cwd_missing' && r.warnings[0].at === 'consoles[1].cwd', 'a missing cwd falls back to the repo with a warning')
    writeCfg('{"version":1,"consoles":[{}],"pad":"' + 'x'.repeat(66 * 1024) + '"}')
    r = await RC.readRepoConfig(repo, null)
    check(r.status === 'too_large' && r.config === undefined, 'a file over 64 KB is not read')
    const hang = { stat: () => new Promise(() => {}), readFile: async () => Buffer.from(''), realpath: async (p) => p }
    const t0 = Date.now()
    r = await RC.readRepoConfig(repo, null, { fs: hang, timeoutMs: 40 })
    check(r.status === 'none' && Date.now() - t0 < 1500, 'a stalled read (slow network drive) answers none after the timeout')
    check(RC.READ_TIMEOUT_MS === 2000, 'the read timeout is 2 s')

    // --- TrustStore -----------------------------------------------------------
    const trustFile = path.join(tmp, 'data', 'trusted-repos.json')
    let clock = 1000
    const store = new TrustStore({ file: () => trustFile, now: () => ++clock })
    check(store.get(repo) === null, 'nothing is trusted at first (missing file)')
    store.set(repo, okSha)
    check(store.get(repo).sha256 === okSha && store.get(repo + path.sep).sha256 === okSha, 'the trailing separator does not matter')
    if (win) check(store.get(repo.toUpperCase()).sha256 === okSha, 'the path is case-insensitive on Windows')
    check(normTrustPath('C:\\Repos\\Api\\', 'win32') === 'c:\\repos\\api' || !win, 'normTrustPath lowercases and strips the trailing separator on win32')
    const onDisk = JSON.parse(fs.readFileSync(trustFile, 'utf8'))
    check(onDisk.version === 1 && Object.values(onDisk.entries)[0].sha256 === okSha && !fs.readdirSync(path.dirname(trustFile)).some((f) => f.endsWith('.tmp')), 'trusted-repos.json is written atomically with version 1')
    check(new TrustStore({ file: () => trustFile }).get(repo).sha256 === okSha, 'a new store reads the file back')
    store.set(repo, 'not-a-sha')
    check(store.get(repo).sha256 === okSha, 'a malformed hash is never stored')
    fs.writeFileSync(trustFile, '{ corrupt')
    check(new TrustStore({ file: () => trustFile }).get(repo) === null, 'a corrupt file trusts nothing')
    const capFile = path.join(tmp, 'cap.json')
    const cap = new TrustStore({ file: () => capFile, now: () => ++clock })
    for (let i = 0; i < TRUST_MAX_ENTRIES + 3; i++) cap.set(path.join(tmp, `r${i}`), okSha)
    const capped = JSON.parse(fs.readFileSync(capFile, 'utf8')).entries
    check(Object.keys(capped).length === TRUST_MAX_ENTRIES && cap.get(path.join(tmp, 'r0')) === null && cap.get(path.join(tmp, `r${TRUST_MAX_ENTRIES + 2}`)) !== null, 'past 500 repos the oldest approvals go')

    // --- trust through main's handlers ---------------------------------------
    const trust = new TrustStore({ file: () => path.join(tmp, 'h', 'trusted-repos.json') })
    const H = repoConfigHandlers(trust)
    writeCfg(full)
    r = await H.read(repo)
    check(r.status === 'ok' && r.trusted === false && r.changedSinceTrust === false, 'an unknown repo is neither trusted nor changed')
    check((await H.trust({ dir: repo, sha256: 'f'.repeat(64) })).changed === true, 'a stale hash answers changed and stores nothing')
    check((await H.read(repo)).trusted === false, 'nothing was trusted by the stale answer')
    check((await H.trust({ dir: 'rel', sha256: r.sha256 })).error === 'bad_request' && (await H.trust(null)).error === 'bad_request', 'malformed trust requests are refused')
    check((await H.trust({ dir: repo, sha256: r.sha256 })).ok === true && (await H.read(repo)).trusted === true, 'the current hash is trusted')
    writeCfg(full, { crlf: true, bom: true })
    check((await H.read(repo)).trusted === true, 'only CRLF/BOM changed: still trusted (no new dialog)')
    writeCfg({ ...full, consoles: [{ title: 'Web', command: 'npm run build' }] })
    r = await H.read(repo)
    check(r.trusted === false && r.changedSinceTrust === true, 'a changed command asks again under "the file changed"')

    // --- export ---------------------------------------------------------------
    const expDir = path.join(tmp, 'exp')
    fs.mkdirSync(expDir)
    const expFile = { version: 1, name: 'Exp', grid: 2, consoles: [{ title: 'Claude', agent: 'claude' }, { title: 'Dev', command: 'npm run dev', cwd: 'web' }] }
    let pv = await H.previewExport({ dir: expDir, file: expFile })
    check(pv.ok && pv.exists === false && pv.json.endsWith('}\n') && !pv.json.includes('\r') && pv.json.startsWith('{\n  "version": 1,'), 'the preview is the exact text: version first, 2 spaces, LF')
    check(!fs.existsSync(path.join(expDir, '.snagentsos.json')), 'previewing writes nothing')
    check((await H.previewExport({ dir: expDir, file: { ...expFile, consoles: [{ cwd: '../x' }] } })).ok === false, 'an export cwd outside the repo never validates')
    let ex = await H.export({ dir: expDir, file: expFile, overwrite: false })
    check(ex.ok && fs.readFileSync(ex.path, 'utf8') === pv.json, 'export writes exactly the preview')
    r = await H.read(expDir)
    check(r.status === 'ok' && r.trusted === true && r.sha256 === ex.sha256, 'the exported content is trusted right away')
    pv = await H.previewExport({ dir: expDir, file: expFile })
    check(pv.exists === true, 'the preview then reports an existing file (Replace)')
    ex = await H.export({ dir: expDir, file: { ...expFile, name: 'Otro' }, overwrite: false })
    check(ex.ok === false && ex.error === 'exists' && JSON.parse(fs.readFileSync(path.join(expDir, '.snagentsos.json'), 'utf8')).name === 'Exp', 'without overwrite an existing file is never replaced')
    ex = await H.export({ dir: expDir, file: { ...expFile, name: 'Otro' }, overwrite: true })
    check(ex.ok && JSON.parse(fs.readFileSync(ex.path, 'utf8')).name === 'Otro', 'Replace overwrites')
    check((await H.export({ dir: expDir, file: { version: 1, consoles: [] }, overwrite: true })).error === 'invalid', 'an invalid export is refused')

    // --- renderer helpers -----------------------------------------------------
    const L = loadRenderer(`export * from './repoConfig'`)
    const presets = [
      { id: 'preset-shell', name: 'Shell', type: 'shell', command: '', args: [], color: '#6366f1', icon: 'terminal' },
      { id: 'preset-claude', name: 'Claude Code', type: 'claude', command: 'claude', args: [], color: '#d97757', icon: 'claude' },
      { id: 'preset-codex', name: 'Codex', type: 'codex', command: 'codex', args: [], color: '#10a37f', icon: 'openai' },
      { id: 'preset-bash', name: 'Git Bash', type: 'shell', command: 'bash', args: [], color: '#111111', icon: 'terminal' },
    ]
    check(L.resolveRepoAgent('claude', presets).preset.id === 'preset-claude' && L.resolveRepoAgent('Claude Code', presets).preset.id === 'preset-claude' && L.resolveRepoAgent('git bash', presets).preset.id === 'preset-bash', 'agent: type keyword or preset name (case-insensitive)')
    const unk = L.resolveRepoAgent('gemini', presets)
    check(unk.unknown && unk.preset.id === 'preset-shell' && !L.resolveRepoAgent(undefined, presets).unknown, 'an unknown preset falls back to a shell')
    check(L.exportAgentName(presets[1], presets) === 'claude' && L.exportAgentName(presets[3], presets) === 'Git Bash', 'export names: type keyword for the first of its type, else the preset name')
    check(L.oneShotLaunch('pnpm i', undefined, 'win32', false).args.join('|') === '-NoLogo|-Command|pnpm i', 'setup: PowerShell gets -Command (default shell on Windows)')
    check(L.oneShotLaunch('pnpm i', 'C:\\Windows\\System32\\cmd.exe', 'win32', false).args.join('|') === '/d|/s|/c|pnpm i', 'setup: cmd gets /d /s /c')
    check(L.oneShotLaunch('pnpm i', '/bin/zsh', 'darwin', false).args.join('|') === '-lc|pnpm i' && L.oneShotLaunch('pnpm i', undefined, 'linux', false).args[0] === '-lc', 'setup: POSIX shells get -lc')
    check(L.oneShotLaunch('pnpm i', 'nu.exe', 'win32', false).initialCommand === 'pnpm i' && L.oneShotLaunch('pnpm i', undefined, 'win32', true).initialCommand === 'pnpm i', 'unknown shell or a profile: typed as the initial command')

    writeCfg(full)
    const fullRes = await H.read(repo)
    const conns = [{ id: 'conn-1', name: 'dedi', steps: [{ send: 'ssh x' }] }]
    let d = L.draftFromRepoConfig({ dir: repo, res: fullRes, presets, connections: conns, profileId: '', quickCount: 0, shell: undefined, platform: 'win32' })
    check(d.draft.name === 'Api' && d.draft.cwd === repo && d.draft.grid === 4 && d.draft.panes.length === 3, 'draft: name, cwd, grid and consoles')
    check(d.draft.panes[0].presetId === 'preset-claude' && d.draft.panes[0].prompt === 'lee el README' && d.draft.panes[1].command === 'npm run dev' && d.draft.panes[1].cwd === path.resolve(repo, 'web'), 'draft panes keep preset, prompt, command and the checked cwd')
    check(d.draft.panes[2].type === 'shell' && d.warnings.some((w) => w.key === 'repo.warn.unknownAgent' && w.vars.agent === 'gemini' && w.vars.at === 'consoles[2].agent'), 'an unknown preset is a warning and that console is a shell')
    check(d.draft.setup.command === 'pnpm install' && d.draft.setup.wait === true, 'waitForSetup holds the consoles when the exit is observable')
    check(d.draft.quickCommands.length === 2 && d.draft.quickCommands[1].presetId === 'preset-claude' && d.draft.quickCommands[1].enter === true && d.draft.quickCommands[0].enter === true, 'quick commands map label -> name, agent -> presetId')
    check(d.draft.repoConfig.sha256 === fullRes.sha256 && d.draft.setupId === undefined, 'the draft carries the hash; no profile by default')
    d = L.draftFromRepoConfig({ dir: repo, res: fullRes, presets, connections: conns, profileId: 'conn-1', quickCount: 0, shell: undefined, platform: 'win32' })
    check(d.draft.setupId === 'conn-1' && d.draft.setup.wait === false && d.warnings.some((w) => w.key === 'repo.warn.setupNoWait'), 'with a profile the setup is typed and does not hold (warned)')
    d = L.draftFromRepoConfig({ dir: repo, res: fullRes, presets, connections: [], profileId: '', quickCount: 99, shell: undefined, platform: 'win32' })
    check(d.draft.quickCommands.length === 1 && d.skippedQuick === 1 && d.warnings.some((w) => w.key === 'repo.warn.quickSkipped' && w.vars.count === 1), 'the 100 cap cuts the repo quick commands and warns')
    const tenQuick = { version: 1, consoles: [{}], quickCommands: Array.from({ length: 10 }, (_, i) => ({ label: `q${i}`, action: 'send', text: `t${i}` })) }
    d = L.draftFromRepoConfig({ dir: repo, res: { status: 'ok', config: tenQuick, sha256: okSha, needsTrust: true, warnings: [], consoleCwds: [null] }, presets, connections: [], profileId: '', quickCount: 95, shell: undefined, platform: 'win32' })
    check(d.draft.quickCommands.length === 5 && d.skippedQuick === 5, '95 own + 10 in the repo: 5 imported, 5 skipped')
    const small = { version: 1, grid: 1, connectionProfile: 'nope', consoles: [{}, {}, {}] }
    d = L.draftFromRepoConfig({ dir: repo, res: { status: 'ok', config: small, sha256: okSha, needsTrust: true, warnings: [{ code: 'cwd_missing', at: 'consoles[0].cwd' }], consoleCwds: [null, null, null] }, presets, connections: conns, profileId: '', quickCount: 0, shell: undefined, platform: 'win32' })
    check(d.draft.grid === 4 && d.warnings.some((w) => w.key === 'repo.warn.gridSmall') && d.warnings.some((w) => w.key === 'repo.warn.profileMissing' && w.vars.name === 'nope') && d.warnings.some((w) => w.key === 'repo.warn.cwdMissing'), 'a small grid grows to fit, a missing profile and cwd warn')
    check(d.draft.name === 'repo', 'no name: the folder basename')

    check(L.relativeInside('C:\\Repos\\Api', 'c:/repos/api/web/src', 'win32') === 'web/src' && L.relativeInside('C:\\Repos\\Api\\', 'C:\\Repos\\Api', 'win32') === '', 'relativeInside: case-insensitive on Windows, empty for the repo itself')
    check(L.relativeInside('C:\\Repos\\Api', 'C:\\Repos\\Api2', 'win32') === null && L.relativeInside('/home/me/api', '/home/me/API/x', 'linux') === null && L.relativeInside('/home/me/api', '/home/me/api/../x', 'linux') === null, 'relativeInside: siblings, case on POSIX and .. escapes are outside')

    // trust items and the dialog decision
    const items = L.trustItemsFor(full, 'dedi', 4)
    check(items[0].kind === 'profile' && items[0].count === 4 && items[1].kind === 'setup' && items.map((i) => i.kind).join() === 'profile,setup,command,agent,agent,quickSend,quickAgent', 'trust lines: profile first, then setup, commands, agents + prompts, quick commands')
    check(L.trustItemsFor({ version: 1, grid: 4, connectionProfile: 'dedi', consoles: [{ title: 'x' }] }, 'dedi', 1)[0].kind === 'profile', 'a file with only a profile shows the profile line first')
    const okRes = (extra) => ({ status: 'ok', config: { version: 1, consoles: [{}] }, sha256: okSha, needsTrust: true, trusted: false, warnings: [], ...extra })
    check(L.trustDialogNeeded(okRes(), undefined).dialog && L.trustDialogNeeded(okRes(), undefined).store, 'executable and untrusted: dialog and store')
    check(!L.trustDialogNeeded(okRes({ trusted: true }), undefined).dialog, 'the same hash again: no dialog')
    check(!L.trustDialogNeeded(okRes({ needsTrust: false }), undefined).dialog, 'nothing executable: no dialog')
    const manual = L.trustDialogNeeded(okRes({ trusted: true }), 'dedi')
    check(manual.dialog && !manual.store, 'a profile picked by hand asks even on a trusted hash (nothing new to store)')
    check(!L.trustDialogNeeded(okRes({ trusted: true, config: { version: 1, connectionProfile: 'dedi', consoles: [{}] } }), 'dedi').dialog, 'the file\'s own profile on a trusted hash does not ask')
    const sum = L.repoSummary({ ...full, setup: { command: 'x'.repeat(80) } })
    check(sum.count === 3 && sum.grid === 4 && sum.titles === 'Claude, Web, Gem' && sum.setup.length === 63, 'card summary: count, titles, grid and the first 60 setup characters')

    // --- export -> import round trip -----------------------------------------
    const ws = {
      id: 'ws-1', name: 'Api', cwd: repo,
      panes: [
        { id: 'p1', type: 'claude', presetId: 'preset-claude', title: 'Claude', color: '#d97757', icon: 'claude' },
        { id: 'p2', type: 'shell', title: 'PowerShell', color: '#6366f1', icon: 'terminal', command: 'npm run dev', cwd: path.join(repo, 'web') },
        { id: 'p3', type: 'shell', presetId: 'preset-bash', title: 'Bash', color: '#111111', icon: 'terminal', cwd: outside },
        { id: 'p4', type: 'codex', presetId: 'preset-codex', title: 'Codex', color: '#10a37f', icon: 'openai', cwd: outside, worktree: { repoRoot: repo, path: outside, branch: 'sn/x', base: 'abcdef1' } },
      ],
      layout: { grid: 4, order: ['p2', 'p1', 'p3', 'p4'] },
      setupId: 'conn-1',
    }
    const qcs = [
      { id: 'qc-1', name: 'Tests', text: 'npm test', action: 'send', enter: true, workspaceId: 'ws-1' },
      { id: 'qc-2', name: 'Review', text: 'revisa', action: 'agent', enter: true, presetId: 'preset-claude', workspaceId: 'ws-1' },
      { id: 'qc-3', name: 'Global', text: 'x', action: 'send', enter: false },
    ]
    const exp = L.repoConfigFromWorkspace(ws, presets, conns, qcs, process.platform)
    check(exp.file.consoles.map((c) => c.title).join() === 'PowerShell,Claude,Bash,Codex' && exp.file.consoles[0].cwd === 'web' && exp.file.consoles[0].command === 'npm run dev', 'export follows the grid order, relative cwd inside the repo, own command')
    check(exp.file.consoles[1].agent === 'claude' && exp.file.consoles[2].agent === 'Git Bash' && exp.file.consoles[0].agent === undefined, 'export names presets portably')
    check(exp.file.consoles[2].cwd === undefined && exp.warnings.filter((w) => w.key === 'repo.warn.cwdOutside').length === 2, 'cwds outside the repo (and worktrees) are left out with a warning')
    check(exp.file.connectionProfile === 'dedi' && !JSON.stringify(exp.file).includes('ssh x'), 'the profile goes by name, never its steps')
    check(exp.file.quickCommands.length === 2 && exp.quickCommandIds.join() === 'qc-1,qc-2' && exp.file.quickCommands[1].agent === 'claude', 'only this workspace\'s quick commands are exported')
    const rtDir = path.join(tmp, 'rt')
    fs.mkdirSync(path.join(rtDir, 'web'), { recursive: true })
    const wrote = await H.export({ dir: rtDir, file: exp.file, overwrite: false })
    check(wrote.ok, 'the exported workspace always validates')
    const back = await H.read(rtDir)
    check(back.status === 'ok' && back.trusted === true, 'reopening the export does not ask for trust')
    const rd = L.draftFromRepoConfig({ dir: rtDir, res: back, presets, connections: conns, profileId: 'conn-1', quickCount: 0, shell: undefined, platform: process.platform })
    check(rd.draft.grid === 4 && rd.draft.panes.map((p) => p.title).join() === 'PowerShell,Claude,Bash,Codex', 'round trip: same grid and titles')
    check(rd.draft.panes.map((p) => p.presetId ?? '-').join() === 'preset-shell,preset-claude,preset-bash,preset-codex' && rd.draft.panes[0].command === 'npm run dev', 'round trip: same presets and command')
    check(rd.draft.quickCommands.length === 2 && rd.warnings.every((w) => w.key !== 'repo.warn.unknownAgent'), 'round trip: quick commands come back, no unknown preset')

    // --- store: setup hold, retry, reload --------------------------------------
    const killed = []
    const R = loadRenderer(`export { useAppStore } from './store'; export { confirmRepoTrust } from './repoConfigFlow'; export { registerPty } from './ptyRegistry'`, {
      window: { snApi: { platform: 'win32', config: { save() {} }, pty: { killPanes: async (ids) => { killed.push(...ids); return 0 } } } },
      document: { hasFocus: () => false },
    })
    const S = R.useAppStore
    S.getState().hydrate({ version: 13, workspaces: [], presets, settings: { ...S.getState().settings } })
    for (let i = 0; i < 3; i++) S.getState().saveQuickCommand({ id: `qc-own${i}`, name: `own ${i}`, text: 'x', action: 'send', enter: false })
    d = L.draftFromRepoConfig({ dir: repo, res: fullRes, presets, connections: [], profileId: '', quickCount: 3, shell: undefined, platform: 'win32' })
    const wsId = S.getState().createWorkspaceFull(d.draft)
    let st = S.getState()
    const made = st.workspaces.find((w) => w.id === wsId)
    const setupId = made.panes[0].id
    check(made.panes.length === 4 && made.panes[0].title === 'Setup' && made.panes[0].type === 'shell' && made.layout.grid === 4, 'the setup console is added first')
    check(made.repoConfig.sha256 === fullRes.sha256 && made.repoConfig.quickCommandIds.length === 2 && st.quickCommands.filter((c) => c.workspaceId === wsId).length === 2, 'repo quick commands are scoped and listed in repoConfig')
    check(st.pendingPrompts[made.panes[1].id].source === 'repo' && st.pendingPrompts[made.panes[1].id].text === 'lee el README' && !st.pendingPrompts[made.panes[2].id], 'console prompts go through pendingPrompts (source repo)')
    check(made.panes.slice(1).every((p) => st.heldPanes[p.id] && st.heldPanes[p.id].state === 'waiting') && !st.heldPanes[setupId], 'with waitForSetup the other consoles wait')
    check(S.getState().takeRepoSetupCommand(setupId) === 'pnpm install' && S.getState().takeRepoSetupCommand(setupId) === null, 'the setup command is taken once')
    S.getState().setPaneExit(setupId, 1)
    st = S.getState()
    check(made.panes.slice(1).every((p) => st.heldPanes[p.id].state === 'failed' && st.heldPanes[p.id].code === 1) && st.repoSetups[setupId].status === 'failed', 'exit code 1 marks the held consoles failed (Retry / Start anyway)')
    S.getState().retryRepoSetup(setupId)
    st = S.getState()
    check(made.panes.slice(1).every((p) => st.heldPanes[p.id].state === 'waiting') && st.repoSetups[setupId].status === 'pending' && killed.includes(setupId), 'Retry re-arms the setup and restarts its console')
    S.getState().releaseHeldPanes([made.panes[3].id])
    check(!S.getState().heldPanes[made.panes[3].id], '"Start now" releases one console')
    S.getState().takeRepoSetupCommand(setupId)
    S.getState().setPaneExit(setupId, null)
    S.getState().setPaneExit(setupId, 0)
    st = S.getState()
    check(Object.keys(st.heldPanes).length === 0 && st.repoSetups[setupId].status === 'ok', 'exit 0 releases every held console')
    S.getState().setPaneExit(setupId, null)
    S.getState().setPaneExit(setupId, 3)
    check(Object.keys(S.getState().heldPanes).length === 0, 'a later exit of the (now plain) setup console changes nothing')
    const noWait = L.draftFromRepoConfig({ dir: repo, res: { ...fullRes, config: { ...fullRes.config, setup: { command: 'pnpm i' } } }, presets, connections: [], profileId: '', quickCount: 0, shell: undefined, platform: 'win32' })
    S.getState().createWorkspaceFull({ ...noWait.draft, quickCommands: [] })
    check(Object.keys(S.getState().heldPanes).length === 0, 'without waitForSetup nothing is held')

    // reload: live consoles and hand-made commands stay
    const manualQc = { id: 'qc-manual', name: 'Mio', text: 'y', action: 'send', enter: false, workspaceId: wsId }
    S.getState().saveQuickCommand(manualQc)
    R.registerPty(made.panes[1].id, 'pty-live')
    const changedCfg = { version: 1, grid: 2, consoles: [{ title: 'Nueva' }], quickCommands: [{ label: 'Nuevo', action: 'send', text: 'z' }] }
    const rr = L.draftFromRepoConfig({ dir: repo, res: { status: 'ok', config: changedCfg, sha256: 'a'.repeat(64), needsTrust: true, warnings: [], consoleCwds: [null] }, presets, connections: [], profileId: '', quickCount: 0, shell: undefined, platform: 'win32' })
    killed.length = 0
    const res2 = S.getState().reloadWorkspaceFromRepo(wsId, rr.draft, [made.panes[1].id])
    st = S.getState()
    const after = st.workspaces.find((w) => w.id === wsId)
    check(res2.kept === 1 && after.panes.map((p) => p.title).join() === 'Claude,Nueva' && after.layout.grid === 2, 'reload keeps the live console and replaces the rest')
    check(killed.length === 3 && !killed.includes(made.panes[1].id), 'dropped consoles are killed by pane id, the live one is not')
    const scoped = st.quickCommands.filter((c) => c.workspaceId === wsId).map((c) => c.name)
    check(scoped.includes('Mio') && scoped.includes('Nuevo') && !scoped.includes('Tests') && after.repoConfig.quickCommandIds.length === 1 && after.repoConfig.sha256 === 'a'.repeat(64), 'reload replaces only the listed quick commands, hand-made ones stay')
    S.getState().setWorkspaceRepoConfig(wsId, null)
    check(!('repoConfig' in S.getState().workspaces.find((w) => w.id === wsId)), 'setWorkspaceRepoConfig(null) clears the trace')

    // trust flow: changed -> read again -> ask again under "changed"
    const asks = []
    let reads = 0
    const fakeApi = {
      trust: async ({ sha256 }) => (sha256 === 'b'.repeat(64) ? { ok: true } : { ok: false, changed: true }),
      read: async () => { reads++; return okRes({ sha256: 'b'.repeat(64) }) },
    }
    let out = await R.confirmRepoTrust(repo, okRes({ sha256: 'c'.repeat(64) }), undefined, { api: fakeApi, ask: async (req) => { asks.push(req); return true } })
    check(out.ok && out.res.sha256 === 'b'.repeat(64) && asks.length === 2 && asks[0].changed === false && asks[1].changed === true && reads === 1, 'a file changed during the dialog is read and asked again under "changed"')
    out = await R.confirmRepoTrust(repo, okRes(), undefined, { api: fakeApi, ask: async () => false })
    check(out.ok === false && out.error === undefined, 'Cancel creates nothing')
    asks.length = 0
    out = await R.confirmRepoTrust(repo, okRes({ trusted: true }), undefined, { api: fakeApi, ask: async (req) => { asks.push(req); return true } })
    check(out.ok && asks.length === 0, 'a trusted file opens without the dialog')
    out = await R.confirmRepoTrust(repo, okRes({ changedSinceTrust: true }), 'dedi', { api: { ...fakeApi, trust: async () => ({ ok: true }) }, ask: async (req) => { asks.push(req); return true } })
    check(out.ok && asks[0].changed === true && asks[0].items[0].kind === 'profile', 'a changed file opens the dialog with the changed header and the profile line first')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  assert.ok(true)
}

module.exports = { run }
