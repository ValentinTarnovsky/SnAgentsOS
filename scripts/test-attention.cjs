// "Needs you" (app 2.7.0, A2): src/shared/attention.ts. Ranking with
// compareAgents, `needs` as rank 1 (working included), `muted` and dormant
// consoles left out, the exclude option, junk statuses, and parity with the
// counting rules it replaces (sidebar badge, next waiting, phone counters) on
// the fixtures of test-agents.cjs, test-status-ui.cjs, test-hibernation.cjs
// and test-mobile-logic.cjs, with each intended difference pinned.
// Same esbuild + vm harness as test-status.cjs: no Electron, no user data.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
const alias = { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron'], alias }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, ...overrides })
  return mod.exports
}

const A = load('src/shared/attention.ts')
const S = load('src/shared/status.ts')
const G = load('src/shared/agents.ts')
const nav = load('src/renderer/lib/agentNav.ts')
const phone = load('src/mobile/src/lib/workspace.ts')

const ids = (rows) => rows.map((r) => r.id).join()
const item = (paneId, status, extra = {}) => ({ paneId, workspaceId: extra.ws ?? 'w', status, ...extra })
const st = (state, rest = {}) => ({ state, precise: true, stateSince: 0, ...rest })

function ranking() {
  const items = [
    item('a', st('action', { attention: true, stateSince: 300 })),
    item('w', st('working', { attention: false, stateSince: 900 })),
    item('b', st('done', { attention: true, stateSince: 100 })),
    item('n', st('working', { attention: false, stateSince: 800, needs: { text: 'Aprobá el deploy', at: 20 } })),
    item('m', st('error', { attention: true, stateSince: 50 })),
    item('i', st('idle', { attention: false, stateSince: 5 })),
    item('d', st('done', { attention: false, stateSince: 1 })),
  ]
  const rows = A.needsYouRows(items)
  check(ids(rows) === 'n,m,a,b', 'rows: rank 1 (needs, error, action) waiting longest first, then the unseen done (got ' + ids(rows) + ')')
  check(rows.every((r) => r.item === items.find((i) => i.paneId === r.id)), 'each row carries its input item')
  const n = rows.find((r) => r.id === 'n')
  check(n.rank === 1 && n.stateSince === 20 && n.unread === false, 'needs lifts a working console to rank 1, waiting since needs.at')
  check(G.agentRank('working', false) === 3, 'its own state alone would rank 3')
  const sorted = [...rows].sort(G.compareAgents).map((r) => r.id).join()
  check(sorted === ids(rows), 'the order is exactly compareAgents')
  check(A.needsYouCount(items) === rows.length, 'needsYouCount equals the rows')

  const both = A.needsYouRows([item('x', st('action', { attention: true, stateSince: 40, needs: { text: 'x', at: 90 } })), item('y', st('error', { attention: true, stateSince: 60 }))])
  check(ids(both) === 'x,y' && both[0].stateSince === 40, 'needs on a console already in action keeps the state since (it waited first)')
  const idle = A.needsYouRows([item('p', st('idle', { needs: { text: 'x', at: 7 } })), item('q', st('done', { attention: false, needs: { text: 'y', at: 3 } }))])
  check(ids(idle) === 'q,p' && idle.every((r) => r.rank === 1), 'needs counts on idle and on an acknowledged done too')
  const bad = A.needsYouRows([item('z', st('working', { stateSince: 77, needs: { text: 'x', at: Number.NaN } }))])
  check(bad.length === 1 && bad[0].stateSince === 77, 'a needs.at that is not a number falls back to stateSince')
  const upd = A.needsYouRows([item('u', { state: 'action', attention: true, updatedAt: 33 })])
  check(upd[0].stateSince === 33, 'without stateSince the row uses updatedAt (as workspaceAgents does)')
  const unk = A.needsYouRows([item('k', { state: 'done', attention: true })])
  check(unk[0].stateSince === 0, 'without either it is 0 (unknown, first)')

  // Stable ties and unread first inside rank 2.
  const ties = A.needsYouRows([item('b2', st('done', { attention: true, stateSince: 5 })), item('a2', st('done', { attention: true, stateSince: 5 })), item('c2', st('error', { attention: false, stateSince: 1 }), { marked: true })])
  check(ids(ties) === 'c2,a2,b2', 'equal ranks: oldest first, then the id')
  const marked = A.needsYouRows([item('s', st('done', { stateSince: 1 }), { marked: true }), item('t', st('working', { attention: false, stateSince: 9 }), { marked: true })])
  check(ids(marked) === 's,t' && marked[0].unread && marked[1].unread && marked[1].rank === 3, 'a mark reads unread and keeps the state rank')
}

function excluded() {
  const muted = (state, extra = {}) => item('mu', st(state, { attention: true, muted: true, ...extra }))
  for (const s of ['action', 'done', 'error']) check(!A.needsYou(muted(s)), `a muted ${s} does not count`)
  check(!A.needsYou(muted('working', { needs: { text: 'x', at: 1 } })), 'a muted console with needs does not count')
  check(!A.needsYou({ ...muted('done'), marked: true }), 'a muted console with the local mark does not count')
  check(A.needsYou(item('mu', st('action', { attention: true, muted: false }))), 'muted false counts as usual')
  const dormant = { dormant: true }
  check(!A.needsYou(item('z', st('action', { attention: true }), dormant)) && !A.needsYou(item('z', st('working', { needs: { text: 'x', at: 1 } }), dormant)) && !A.needsYou(item('z', undefined, { ...dormant, marked: true })), 'a sleeping or not started console never counts')
  const items = [item('a', st('action', { attention: true, stateSince: 1 })), item('b', st('action', { attention: true, stateSince: 2 }))]
  check(ids(A.needsYouRows(items, { exclude: 'a' })) === 'b' && A.needsYouCount(items, { exclude: 'a' }) === 1, 'exclude leaves one console out of rows and count')
  check(ids(A.needsYouRows(items, { exclude: null })) === 'a,b' && ids(A.needsYouRows(items, {})) === 'a,b', 'exclude null or absent leaves nothing out')

  // Junk and missing statuses.
  check(!A.needsYou(item('g', undefined)) && !A.needsYou(item('g', null)), 'no status: nothing')
  check(!A.needsYou(item('g', { state: null, attention: true, needs: { text: 'x', at: 1 } })), 'state null (cleared pane): nothing, whatever it carries')
  const shell = A.needsYouRows([item('h', undefined, { marked: true })])
  check(shell.length === 1 && shell[0].rank === 4 && shell[0].unread && shell[0].stateSince === 0, 'a plain shell with the local mark counts (the badge counted it), rank 4')
  check(A.needsYouRows([]).length === 0 && A.needsYouCount([]) === 0, 'empty input: no rows')
}

/** The sidebar badge today (Sidebar.tsx): needsUser(status) || paneAttention. */
const badgeRule = (status, marked) => S.needsUser(status) || !!marked
/**
 * next waiting before A6 (agentNav.waitingIds over AgentEntry[]), and the
 * palette's "Waiting for you" before A6 (the top 6 of every agent console).
 * A6 switched both to needsYouRows; desktopParity pins that too.
 */
const oldWaiting = (entries) => entries.filter((e) => !e.notStarted && (e.rank === 1 || (e.rank === 2 && e.unread))).sort(G.compareAgents).map((e) => e.id)
const oldPalette = (entries, exclude) => entries.filter((e) => e.id !== exclude).sort(G.compareAgents).slice(0, 6).map((e) => e.id)
/** next waiting before A6 on one AgentEntry-like pane. */
const nextRule = (status, marked) => {
  const rank = G.agentRank(status?.state, status?.attention)
  const unread = status?.attention === true || !!marked
  return !!status && (rank === 1 || (rank === 2 && unread))
}

function rulesTable() {
  // Every state x attention x pendingCount x mark against the rules it replaces.
  for (const state of ['working', 'action', 'done', 'error', 'idle', 'unknown']) {
    for (const attention of [true, false, undefined]) {
      for (const pendingCount of [0, 2]) {
        for (const marked of [false, true]) {
          const status = { state, precise: true, stateSince: 1, pendingCount, ...(attention === undefined ? {} : { attention }) }
          const got = A.needsYou(item('p', status, { marked }))
          const label = `${state} attention=${attention} pending=${pendingCount} mark=${marked}`
          const legacyAction = attention === undefined && state === 'action' && pendingCount === 0 && !marked
          if (legacyAction) check(got && !badgeRule(status, marked), 'intended: a legacy action without pendingCount counts (next waiting and the phone did): ' + label)
          else check(got === badgeRule(status, marked), 'same as the sidebar badge: ' + label)
          if (attention !== undefined) {
            // Where they differ on purpose: a mark on a console that is not done or
            // error (the badge counted it), and main's attention on a state it
            // never flags today (A3 sets it with needs, which ranks 1).
            const calm = state === 'working' || state === 'idle' || state === 'unknown'
            const differs = (marked && (calm || (state === 'action' && attention === false))) || (attention === true && calm)
            check(got === (nextRule(status, marked) || differs), (differs ? 'intended difference from next waiting: ' : 'same as next waiting: ') + label)
          }
          if (attention === undefined && state === 'error' && pendingCount === 0 && !marked) check(!got && nextRule(status, marked), 'intended: a legacy error without attention does not count (the badge and the phone never did)')
          if (!marked) {
            const phoneNow = S.waitsOnUser(status)
            if (state === 'action') check(got === (phoneNow || pendingCount > 0 && attention === undefined), 'action: the phone rule (waitsOnUser), plus legacy open requests: ' + label)
            if ((state === 'done' || state === 'error') && attention === true) check(got && !phoneNow, 'intended: the phone now also counts an unseen ' + state)
          }
        }
      }
    }
  }
}

function desktopParity() {
  // test-agents.cjs fixture (legacy statuses, no attention field).
  const preset = { id: 'pc', name: 'Claude Code', type: 'claude', command: 'claude', args: [], color: '#d97757', icon: 'claude' }
  const pane = (id, extra = {}) => ({ id, type: 'claude', presetId: 'pc', title: 'Claude Code', color: '#d97757', icon: 'claude', ...extra })
  const ws1 = { id: 'w1', name: 'Uno', cwd: '', panes: [pane('a'), pane('b'), pane('c'), pane('m')], layout: { grid: 4, order: ['c', 'a', 'b', 'm'] } }
  const ws2 = { id: 'w2', name: 'Dos', cwd: '', panes: [pane('x'), pane('y'), pane('s', { setupId: 'ssh' })] }
  const view = (paneId, extra = {}) => ({ paneId, provider: 'claude', sessionId: '0b7c2f4e-1a2b-4c3d-8e9f-0123456789ab', spawnCwd: 'C:/r', activity: 'idle', updatedAt: 50, available: true, ...extra })
  const input = {
    workspaces: [ws1, ws2], presets: [preset], policy: 'ask',
    mountedWorkspaces: { w1: 'full' },
    paneStatus: { a: { state: 'action', precise: true, stateSince: 300 }, b: { state: 'done', precise: true, stateSince: 100 }, c: { state: 'working', precise: true, stateSince: 200 }, m: { state: 'action', precise: true, stateSince: 50 } },
    paneAttention: { b: true },
    sessions: { x: view('x', { topic: 'Fix login' }), y: view('y', { endedAt: 9 }), s: view('s') },
  }
  /** What A6 hands in: every AgentEntry, sleeping and not started as dormant. */
  const fromEntries = (inp) => nav.allAgents(inp).map((e) => ({ paneId: e.id, workspaceId: e.ws.id, status: e.status, marked: !!inp.paneAttention[e.id], dormant: !!(e.sleeping || e.notStarted) }))
  /** What the badge reads: every pane of every workspace. */
  const fromPanes = (inp) => inp.workspaces.flatMap((w) => w.panes.map((p) => ({ paneId: p.id, workspaceId: w.id, status: inp.paneStatus[p.id], marked: !!inp.paneAttention[p.id], dormant: !!inp.sleeping?.[p.id] })))
  const badgeOf = (inp, w) => w.panes.filter((p) => S.needsUser(inp.paneStatus[p.id]) || inp.paneAttention[p.id]).length
  check(oldWaiting(nav.allAgents(input)).join() === 'm,a,b', 'fixture: next waiting today walks m,a,b')
  check(ids(A.needsYouRows(fromEntries(input))) === 'm,a,b', 'needsYouRows walks the same m,a,b (x, not started, is out)')
  const seen = { ...input, paneAttention: {} }
  check(ids(A.needsYouRows(fromEntries(seen))) === oldWaiting(nav.allAgents(seen)).join(), 'a seen done is out of both (m,a)')
  const att = { ...input, paneAttention: {}, paneStatus: { ...input.paneStatus, a: { state: 'action', precise: true, stateSince: 300, attention: false }, b: { state: 'done', precise: true, stateSince: 100, attention: true }, m: { state: 'error', precise: true, stateSince: 50, attention: false } } }
  check(ids(A.needsYouRows(fromEntries(att))) === 'b' && oldWaiting(nav.allAgents(att)).join() === 'b', 'v2.3 attention: an answered action and an acknowledged error are out, an unseen done is in (b)')
  check(ids(A.needsYouRows(fromEntries({ ...att, paneAttention: { m: true } }))) === oldWaiting(nav.allAgents({ ...att, paneAttention: { m: true } })).join(), 'an acknowledged error with the local mark: same as next waiting (m,b)')
  for (const inp of [att, { ...att, paneAttention: { b: true, m: true } }]) {
    for (const w of inp.workspaces) check(A.needsYouCount(fromPanes(inp).filter((i) => i.workspaceId === w.id)) === badgeOf(inp, w), `badge of ${w.id} matches with attention (${badgeOf(inp, w)})`)
  }
  // Palette "Waiting for you": the same function with the looked-at console out.
  check(oldPalette(nav.allAgents(input), 'm').join() === 'a,b,c,x', 'fixture: the palette today lists working and not started consoles too')
  check(ids(A.needsYouRows(fromEntries(input), { exclude: 'm' })) === 'a,b', 'intended: with needsYouRows it lists only who needs you (a,b)')
  // A6: the desktop now hands in every pane (agentNav.attentionPanes) for all three surfaces.
  for (const inp of [input, seen, att, { ...att, paneAttention: { m: true } }]) {
    const want = ids(A.needsYouRows(fromEntries(inp)))
    check(nav.waitingIds(inp).join() === want && nav.paletteWaiting(inp, null).join() === want && ids(A.needsYouRows(nav.attentionPanes(inp))) === want, 'A6: next waiting and the palette are needsYouRows over every pane (' + want + ')')
  }

  // test-status-ui.cjs fixture: one shell pane per state, legacy pendingCount, pane-1 marked.
  const states = ['working', 'action', 'done', 'error', 'unknown', 'idle']
  const ui = {
    workspaces: states.map((state, i) => ({ id: 'ws-' + i, name: 'Workspace ' + i, cwd: '', panes: [{ id: 'pane-' + i, type: 'shell', title: 'Console ' + i, icon: 'terminal' }] })),
    paneStatus: Object.fromEntries(states.map((state, i) => ['pane-' + i, { state, precise: true, provider: i % 2 ? 'claude' : 'codex', pendingCount: state === 'action' ? 2 : 0 }])),
    paneAttention: { 'pane-1': true },
  }
  const badges = (inp) => inp.workspaces.map((w, i) => [i, A.needsYouCount(fromPanes(inp).filter((x) => x.workspaceId === w.id))]).filter(([, n]) => n > 0).map(([i, n]) => i + ':' + n).join()
  check(badges(ui) === '1:1', 'status-ui legacy badges: the action workspace only (1:1), the legacy error is out')
  const ui2 = { ...ui, paneAttention: {}, paneStatus: { ...ui.paneStatus, 'pane-1': { ...ui.paneStatus['pane-1'], attention: false }, 'pane-2': { ...ui.paneStatus['pane-2'], attention: true }, 'pane-3': { ...ui.paneStatus['pane-3'], attention: false } } }
  check(badges(ui2) === '2:1', 'status-ui attention badges: an answered action (pendingCount 2) is out, an unseen done is in (2:1)')

  // test-hibernation.cjs fixture (e with attention true, z also marked): a sleeping console never counts.
  const MIN = 60_000, now = 1_000 * MIN
  const hp = (id) => ({ id, type: 'claude', title: 'T ' + id, color: '#fff', icon: 'claude' })
  const hst = (state, ago, extra = {}) => ({ state, precise: true, provider: 'claude', stateSince: now - ago * MIN, ...extra })
  const hib = {
    workspaces: [{ id: 'w', name: 'W', cwd: 'C:/w', panes: ['a', 'b', 'c', 'd', 'e', 'f', 'z'].map(hp), layout: { grid: 7, order: ['a', 'b', 'c', 'd', 'e', 'f', 'z'] } }],
    paneStatus: { a: hst('action', 3), b: hst('working', 1), c: hst('done', 2), d: hst('idle', 9), e: hst('error', 1, { attention: true }), f: hst('done', 5) },
    paneAttention: { f: true, z: true }, mountedWorkspaces: { w: 'full' }, sessions: {}, presets: [], policy: 'ask',
    sleeping: { z: { at: now - 120 * MIN } },
  }
  const hibRows = A.needsYouRows(fromEntries(hib))
  check(ids(hibRows) === oldWaiting(nav.allAgents(hib)).join() && ids(hibRows) === 'a,e,f', 'hibernation fixture: a,e,f like next waiting; the sleeping z is out even with a mark')
  check(A.needsYouCount(fromPanes(hib)) === 3, 'and the count fed from every pane (z dormant) is the same 3')
}

function phoneParity() {
  // test-mobile-logic.cjs fixtures: actionCount / actionTotal / waitingPanes.
  const ws = { id: 'w', name: 'W', layoutOrder: ['a', 'b', 'c', 'd', 'e', 'f'], panes: ['f', 'e', 'd', 'c', 'b', 'a'].map((id) => ({ id, title: id, type: 'claude', running: true })) }
  const statuses = { b: st('working'), c: st('done', { stateSince: 50 }), d: st('error'), e: st('done', { stateSince: 50 }), f: st('action', { reason: 'question' }) }
  /** What A8 hands in from a snapshot: one item per pane, no marks (the phone has none). */
  const fromWs = (w, map) => w.panes.map((p) => ({ paneId: p.id, workspaceId: w.id, status: map[p.id] }))
  for (const map of [{ ...statuses, a: st('action') }, { ...statuses, a: st('action', { attention: false }) }, statuses, {}]) {
    check(A.needsYouCount(fromWs(ws, map)) === phone.actionCount(ws, map), `phone legacy fixture: needsYouCount = actionCount (${phone.actionCount(ws, map)})`)
  }
  const snap = {
    workspaces: [
      { id: 'w1', name: 'Front', layoutOrder: ['a2', 'a1'], panes: [{ id: 'a1', title: 'A1', type: 'claude', running: true }, { id: 'a2', title: 'A2', type: 'claude', running: true }] },
      { id: 'w2', name: 'Back', layoutOrder: ['b1', 'b2', 'b3'], panes: [{ id: 'b1', title: 'B1', type: 'claude', running: true }, { id: 'b2', title: 'B2', type: 'claude', running: false }, { id: 'b3', title: 'B3', type: 'claude', running: true }] },
    ],
  }
  const all = (map) => snap.workspaces.flatMap((w) => fromWs(w, map))
  const waiting = { a1: st('action', { stateSince: 9 }), a2: st('action', { stateSince: 4 }), b1: st('action', { stateSince: 6 }), b3: st('working') }
  check(A.needsYouCount(all(waiting)) === phone.waitingPanes(snap, waiting, null).length, 'phone: the same consoles as waitingPanes (3)')
  check(ids(A.needsYouRows(all(waiting))) === 'a2,b1,a1', 'ordered by urgency (longest waiting first) instead of layout order')
  check(A.needsYouCount(all(waiting), { exclude: 'a1' }) === phone.waitingPanes(snap, waiting, 'a1').length, 'the viewed console left out: 2, like waitingPanes')
  const answered = { ...waiting, a2: st('action', { attention: false }), b1: st('action', { attention: true }) }
  check(A.needsYouCount(all(answered)) === phone.waitingPanes(snap, answered, null).length, 'an answered action is out on both')
  const unseen = { ...answered, b3: st('done', { attention: true, stateSince: 2 }), b2: st('error', { attention: false }) }
  // A8: the phone's selectors moved to the shared rule, so an unseen done counts on both.
  check(A.needsYouCount(all(unseen)) === phone.waitingPanes(snap, unseen, null).length && phone.waitingPanes(snap, unseen, null).some((r) => r.paneId === 'b3'), 'the phone counts an unseen done too (the desktop badge did)')
}

ranking()
excluded()
rulesTable()
desktopParity()
phoneParity()
console.log(`PASS: ${checks} attention checks (compareAgents order, needs as rank 1, muted and dormant out, exclude, parity with the sidebar badge, next waiting, the palette and the phone counters on their fixtures)`)
