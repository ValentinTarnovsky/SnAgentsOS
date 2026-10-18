// Answer cards of the phone (R22-15, E2-FR-17..25) as pure logic in node:vm:
// cardFor picks the request (simple tools, generic permission, plan and
// elicitation without a card, the ask limits), and createAnswerer runs the
// E2-FR-21 sequence under a fake clock (lock, "already answered", the 24 group
// cap, one group per second, the checks before each later group, the abort
// on a dropped socket, "Sent" and "Not confirmed"). Also the promptCards
// preference (default on). No socket, no DOM.
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }

const code = buildSync({
  stdin: {
    resolveDir: root, loader: 'ts', contents: `
export { cardFor, needsGenericStrip, isSimplePermissionTool, SIMPLE_PERMISSION_TOOLS } from './src/mobile/src/lib/promptRules'
export { createAnswerer, answerGroups, usePromptUi, ASK_CONFIRM_MS, SENT_VISIBLE_MS } from './src/mobile/src/lib/answer'
export { ANSWER_STEP_MS, MAX_ANSWER_GROUPS, KEY_NEXT } from './src/shared/askAnswerKeys'
export { loadPromptCards, savePromptCards, PROMPT_CARDS_KEY, loadPrefs } from './src/mobile/src/lib/prefs'
` },
  bundle: true, platform: 'node', format: 'cjs', write: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  alias: { '@shared': path.join(root, 'src/shared') },
}).outputFiles[0].text

const local = new Map()
const localStorage = { get length() { return local.size }, key: i => [...local.keys()][i] ?? null, getItem: k => (local.has(k) ? local.get(k) : null), setItem: (k, v) => local.set(k, String(v)), removeItem: k => local.delete(k) }
const mod = { exports: {} }
vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, localStorage, setTimeout, clearTimeout })
const P = mod.exports

const opts = n => Array.from({ length: n }, (_, i) => ({ label: `Opcion ${i + 1}` }))
const perm = (id, toolName, summary = 'npm test') => ({ id, kind: 'permission', ...(toolName ? { toolName } : {}), summary })
const ask = (id, questions) => ({ id, kind: 'question', summary: questions[0]?.question ?? '', questions })
const single = (n = 3) => ({ question: 'Cual?', header: 'Elegir', multiSelect: false, options: opts(n) })
const multi = (n = 4) => ({ question: 'Cuales?', header: 'Varias', multiSelect: true, options: opts(n) })
const status = (pending, extra = {}) => ({ state: 'action', provider: 'claude', reason: pending[0]?.kind ?? 'permission', pendingCount: pending.length, stateSince: 1, pending, ...extra })

// --- cardFor (E2-FR-17, 18) ---
{
  check(P.cardFor(status([perm('a', 'Bash')]), true)?.kind === 'permission' && !P.cardFor(status([perm('a', 'Bash')]), true).generic, 'a Bash permission gets the permission card')
  for (const tool of ['PowerShell', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'mcp__github__create_issue']) check(P.isSimplePermissionTool(tool), `${tool} is a simple permission tool`)
  check(!P.isSimplePermissionTool('Task') && !P.isSimplePermissionTool('ExitPlanMode') && !P.isSimplePermissionTool(undefined), 'other tools are not simple permissions')
  check(P.cardFor(status([perm('a', 'Task')]), true) === undefined, 'a permission for another tool makes no card')
  check(P.cardFor(status([perm('t', 'Task'), perm('b', 'Bash')]), true)?.pending.id === 'b', 'the first request that makes a card wins')
  const generic = P.cardFor(status([perm('fallback:permission', undefined, '')]), true)
  check(generic?.kind === 'permission' && generic.generic, 'a permission without toolName gets the generic card')
  check(P.cardFor(status([{ id: 'p', kind: 'plan', toolName: 'ExitPlanMode', summary: '' }, perm('fallback:permission', undefined, '')]), true) === undefined, 'with a plan request in the pane the generic permission makes no card')
  check(P.cardFor(status([{ id: 'e', kind: 'elicitation', summary: '' }, perm('fallback:permission', undefined, '')]), true) === undefined, 'an elicitation also blocks the generic card')
  check(P.cardFor(status([{ id: 'p', kind: 'plan', toolName: 'ExitPlanMode', summary: '' }]), true) === undefined, 'ExitPlanMode makes no card')
  check(P.cardFor(status([{ id: 'e', kind: 'elicitation', summary: '' }]), true) === undefined, 'an elicitation makes no card')
  const q = P.cardFor(status([ask('q', [single(), multi()])]), true)
  check(q?.kind === 'question' && q.questions.length === 2, 'a valid AskUserQuestion gets the wizard')
  check(P.cardFor(status([ask('q', [single(9)])]), true).questions === null, 'a question with 9 options says "Answer in the terminal"')
  check(P.cardFor(status([ask('q', Array.from({ length: 20 }, () => single()))]), true).questions === null, '20 questions say "Answer in the terminal"')
  check(P.cardFor(status([{ id: 'q', kind: 'question', summary: 'x' }]), true).questions === null, 'a question without questions says "Answer in the terminal"')
  check(P.cardFor(status([perm('a', 'Bash')], { provider: 'codex' }), true) === undefined, 'Codex panes get no card')
  check(P.cardFor(status([perm('a', 'Bash')], { provider: undefined }), true) === undefined, 'a status without provider gets no card')
  check(P.cardFor(status([perm('a', 'Bash')]), false) === undefined, 'promptCards off: no card')
  check(P.cardFor(status([]), true) === undefined && P.cardFor(undefined, true) === undefined, 'no pending, no card')
  check(P.needsGenericStrip(status([perm('a', 'Task')]), undefined) && !P.needsGenericStrip(status([perm('a', 'Bash')]), P.cardFor(status([perm('a', 'Bash')]), true)), 'the generic strip shows only in action without a card')
  check(!P.needsGenericStrip({ state: 'working', stateSince: 1 }, undefined), 'no strip outside action')
  check(P.answerGroups(perm('a', 'Bash'), { kind: 'allow' })[0].raw === '1' && P.answerGroups(perm('a', 'Bash'), { kind: 'deny' })[0].raw === '\x1b' && P.answerGroups(perm('a', 'Bash'), { kind: 'allow' }).length === 1, 'Allow is "1" and Deny is Esc, one group, no Enter')
  check(P.answerGroups(ask('q', [single()]), { kind: 'allow' }).length === 0 && P.answerGroups(perm('a', 'Bash'), { kind: 'ask', selections: [] }).length === 0, 'mismatched answers build nothing')
}

// --- createAnswerer (E2-FR-21, 24) under a fake clock ---
function rig() {
  let clock = 0, seq = 0
  const timers = new Map()
  const statuses = {}
  const sent = [], states = [], stale = []
  let open = true, sendOk = true
  const answerer = P.createAnswerer({
    isOpen: () => open,
    send: (paneId, data) => { if (!sendOk) return false; sent.push({ at: clock, paneId, data }); return true },
    status: paneId => statuses[paneId],
    setState: (paneId, state) => states.push({ at: clock, paneId, state }),
    onStale: paneId => stale.push(paneId),
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: clock + ms, fn }); return id },
    clearTimeout: id => timers.delete(id),
  })
  const advance = ms => {
    const end = clock + ms
    for (;;) {
      let best = null
      for (const [id, t] of timers) if (t.at <= end && (!best || t.at < best[1].at)) best = [id, t]
      if (!best) break
      timers.delete(best[0]); clock = best[1].at; best[1].fn()
    }
    clock = end
  }
  return { answerer, statuses, sent, states, stale, advance, last: () => states.at(-1)?.state, setOpen: v => { open = v }, setSendOk: v => { sendOk = v }, get clock() { return clock } }
}
{
  // Permission: one "1", a lock against the second tap, "Sent", then cleared.
  const r = rig()
  r.statuses.p = status([perm('a', 'Bash')])
  check(r.answerer.answerCard('p', 'a', { kind: 'allow' }) === 'started', 'Allow starts the sequence')
  check(r.sent.length === 1 && r.sent[0].data === '1' && r.sent[0].paneId === 'p', 'Allow writes "1" to the pane at once, no Enter')
  check(r.last().phase === 'sending' && r.last().groups === 1 && r.answerer.busy('p'), '"Sending answer..." while the sequence runs')
  check(r.answerer.answerCard('p', 'a', { kind: 'deny' }) === 'busy' && r.sent.length === 1, 'a second tap during the sequence is ignored')
  // Main invalidates the request (E2-FR-48): the next status has no pending.
  r.statuses.p = status([], { pendingCount: 1, reason: 'permission' })
  r.advance(999)
  check(r.last().phase === 'sending', 'still sending until groups * 1000 ms')
  r.advance(1)
  check(r.last().phase === 'sent' && !r.answerer.busy('p'), '"Sent" after groups * 1000 ms and the lock is released')
  check(r.answerer.answerCard('p', 'a', { kind: 'allow' }) === 'stale' && r.stale.length === 1 && r.sent.length === 1, 'a tap on a request no longer in paneStatus says "Already answered" and writes nothing')
  r.advance(P.SENT_VISIBLE_MS)
  check(r.last() === null, '"Sent" clears after a moment')
  check(r.sent.every(s => !s.data.includes('\r')), 'a permission answer never writes \\r')
}
{
  // An ask of 17 groups: one per second, no ack needed, then "Not confirmed" if still asking.
  const r = rig()
  const q = ask('q', [multi(8), multi(8)])
  r.statuses.p = status([q], { reason: 'question' })
  const sel = [{ options: [0, 1, 2, 3, 4, 5, 6] }, { options: [0, 1, 2, 3, 4, 5, 6] }]
  check(r.answerer.answerCard('p', 'q', { kind: 'ask', selections: sel }) === 'started', 'a 17 group ask starts')
  r.statuses.p = status([], { reason: 'question', pendingCount: 1 })
  r.advance(16 * P.ANSWER_STEP_MS)
  check(r.sent.length === 17 && r.sent.every((s, i) => s.at === i * 1000), '17 groups go out exactly 1000 ms apart without waiting for any ack')
  check(r.sent.map(s => s.data).join('|') === `1|2|3|4|5|6|7|${P.KEY_NEXT}|1|2|3|4|5|6|7|${P.KEY_NEXT}|1`, 'the groups are the buildAskAnswerKeys sequence')
  r.advance(P.ANSWER_STEP_MS)
  check(r.last().phase === 'sent', '"Sent" one step after the last group')
  r.advance(P.ASK_CONFIRM_MS - P.ANSWER_STEP_MS - 1)
  check(r.last().phase === 'sent', 'not judged before 5 s after the last group')
  r.advance(1)
  check(r.last().phase === 'unconfirmed', 'still in action / question 5 s after the last group: "Not confirmed"')
  check(r.sent.length === 17, 'no automatic retry')
  r.answerer.dismiss('p')
  check(r.last() === null, 'dismiss clears the outcome')
}
{
  // The ask resolves in time: the outcome clears, no "Not confirmed".
  const r = rig()
  r.statuses.p = status([ask('q', [single()])], { reason: 'question' })
  r.answerer.answerCard('p', 'q', { kind: 'ask', selections: [{ options: [1] }] })
  r.statuses.p = { state: 'working', provider: 'claude', stateSince: 2 }
  r.advance(P.ASK_CONFIRM_MS + 10)
  check(r.sent.length === 1 && r.sent[0].data === '2' && r.last() === null, 'a resolved ask clears without "Not confirmed"')
}
{
  // Claude moved on to a new request (any kind): the old ask is not "Not confirmed".
  const r = rig()
  r.statuses.p = status([ask('q', [single()])], { reason: 'question' })
  r.answerer.answerCard('p', 'q', { kind: 'ask', selections: [{ options: [0] }] })
  r.statuses.p = status([perm('n', 'Bash')], { reason: 'question', pendingCount: 2 })
  r.advance(P.ASK_CONFIRM_MS + 10)
  check(r.last() === null, 'a newer permission request clears the ask outcome instead of "Not confirmed"')
}
{
  // The pane leaves action between groups: the rest is not written.
  const r = rig()
  r.statuses.p = status([ask('q', [multi(), multi()])], { reason: 'question' })
  r.answerer.answerCard('p', 'q', { kind: 'ask', selections: [{ options: [0, 1] }, { options: [2] }] })
  r.advance(1000)
  check(r.sent.length === 2, 'the second group goes out while the pane still asks')
  r.statuses.p = { state: 'working', provider: 'claude', stateSince: 3 }
  r.advance(5000)
  check(r.sent.length === 2 && r.last() === null && !r.answerer.busy('p'), 'once the pane leaves action the remaining groups are dropped')
}
{
  // The pane asks something else (reason changed): abort too.
  const r = rig()
  r.statuses.p = status([ask('q', [multi(), multi()])], { reason: 'question' })
  r.answerer.answerCard('p', 'q', { kind: 'ask', selections: [{ options: [0] }, { options: [1] }] })
  r.statuses.p = status([perm('x', 'Bash')], { reason: 'permission' })
  r.advance(1000)
  check(r.sent.length === 1, 'a pane in action for a permission is not a question: abort')
}
{
  // The socket drops mid sequence.
  const r = rig()
  r.statuses.p = status([ask('q', [multi(), multi()])], { reason: 'question' })
  r.answerer.answerCard('p', 'q', { kind: 'ask', selections: [{ options: [0, 1, 2] }, { options: [1] }] })
  r.advance(1000)
  r.setOpen(false)
  r.advance(1000)
  check(r.sent.length === 2 && r.last().phase === 'disconnected' && !r.answerer.busy('p'), 'a closed socket before a group aborts with "The connection dropped"')
  const r2 = rig()
  r2.statuses.p = status([ask('q', [multi(), multi()])], { reason: 'question' })
  r2.answerer.answerCard('p', 'q', { kind: 'ask', selections: [{ options: [0, 1, 2] }, { options: [1] }] })
  r2.answerer.abortAll()
  r2.advance(10000)
  check(r2.sent.length === 1 && r2.last().phase === 'disconnected', 'abortAll (the store saw the socket drop) stops the sequence at once')
  const r3 = rig()
  r3.statuses.p = status([perm('a', 'Bash')])
  r3.setOpen(false)
  check(r3.answerer.answerCard('p', 'a', { kind: 'allow' }) === 'offline' && r3.sent.length === 0 && r3.last().phase === 'disconnected', 'offline: nothing is written')
  const r4 = rig()
  r4.statuses.p = status([perm('a', 'Bash')])
  r4.setSendOk(false)
  r4.answerer.answerCard('p', 'a', { kind: 'allow' })
  check(r4.last().phase === 'disconnected' && !r4.answerer.busy('p'), 'a group that cannot go out ends the sequence as disconnected')
}
{
  // More than 24 groups, invalid answers and independent panes.
  const r = rig()
  r.statuses.p = status([ask('q', [multi(8), multi(8), multi(8)])], { reason: 'question' })
  const all = { options: [0, 1, 2, 3, 4, 5, 6, 7] }
  check(r.answerer.answerCard('p', 'q', { kind: 'ask', selections: [all, all, all] }) === 'tooLong' && r.sent.length === 0, 'more than 24 groups: nothing is sent (the card says "Answer in the terminal")')
  check(r.answerer.answerCard('p', 'q', { kind: 'ask', selections: [] }) === 'invalid' && r.sent.length === 0, 'an empty answer is invalid')
  r.statuses.p = status([perm('a', 'Bash')])
  r.statuses.o = status([perm('b', 'Edit')])
  r.answerer.answerCard('p', 'a', { kind: 'allow' })
  check(r.answerer.answerCard('o', 'b', { kind: 'deny' }) === 'started' && r.sent.at(-1).paneId === 'o' && r.sent.at(-1).data === '\x1b', 'the lock is per pane: another pane answers at once')
}

// --- folded cards, wizard resets and the preference ---
{
  const ui = P.usePromptUi
  ui.getState().setFolded('a', true)
  check(ui.getState().folded.a === true, 'a card folds by request id')
  check(!ui.getState().folded.b, 'a new request starts unfolded')
  ui.getState().openCard('a')
  check(!ui.getState().folded.a && ui.getState().wizardSeq.a === 1, 'openCard unfolds it and restarts its wizard')
  ui.getState().setAnswer('p', { pendingId: 'a', kind: 'permission', phase: 'sending', groups: 1 })
  ui.getState().setAnswer('p', null)
  check(!('p' in ui.getState().answers), 'setAnswer(null) clears the pane')
  check(P.loadPromptCards() === true && P.loadPrefs().promptCards === true, 'promptCards defaults on')
  P.savePromptCards(false)
  check(local.get(P.PROMPT_CARDS_KEY) === '0' && P.loadPromptCards() === false && P.PROMPT_CARDS_KEY === 'snagentsos.promptCards', 'off is stored as "0" under snagentsos.promptCards')
  P.savePromptCards(true)
  check(!local.has(P.PROMPT_CARDS_KEY) && P.loadPromptCards() === true, 'on removes the key')
}

console.log(`PASS: ${checks} mobile answer card checks (cardFor, answer sequence, folding, promptCards)`)
