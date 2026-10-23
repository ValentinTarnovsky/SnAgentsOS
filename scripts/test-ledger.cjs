// App 2.7.0 (A4): ConsoleLedger, rateCard and StatusManager.setUsage. Same
// esbuild + vm harness as test-status.cjs; every transcript lives in a temp
// dir (never the real ~/.claude or ~/.codex).
const { buildSync } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
function load(file, overrides = {}) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws'], alias: { '@shared': path.join(root, 'src/shared') } }).outputFiles[0].text
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console, process, Buffer, URL, setTimeout, clearTimeout, ...overrides })
  return mod.exports
}
const tmpDirs = []
function tmp(name) { const d = fs.mkdtempSync(path.join(os.tmpdir(), `snagentsos-ledger-${name}-`)); tmpDirs.push(d); return d }
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }

const { ConsoleLedger, LEDGER_DEDUP_MAX, LEDGER_SUBAGENTS_MAX, LEDGER_WALK_ENTRIES_MAX, LEDGER_LISTED_MAX, LEDGER_TOMBSTONES_MAX, LEDGER_PARTS_MAX } = load('src/main/usage/ConsoleLedger.ts')
const { refreshFile } = load('src/main/usage/custom.ts')
const rateCard = load('src/shared/rateCard.ts')

const nowIso = new Date().toISOString()
const u = (i, o, cc, cr) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: cc, cache_read_input_tokens: cr })
const msg = (id, usage, { model = 'claude-opus-5-5', extra = {} } = {}) =>
  JSON.stringify({ type: 'assistant', timestamp: nowIso, ...extra, message: { ...(id ? { id } : {}), model, role: 'assistant', usage } })
const userLine = () => JSON.stringify({ type: 'user', timestamp: nowIso, message: { role: 'user', content: 'hi' } })
const fixtureCost = fs.readFileSync(path.join(root, 'scripts/fixtures/teams/claude-transcript-cost-state.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean)

/**
 * A ledger over temp transcripts. `reads` lists every refreshFile call (path),
 * `lines` every line fed to the parser (path, line), `published` every
 * setUsage call.
 */
function harness(opts = {}) {
  const published = [], reads = [], lines = []
  const state = { info: opts.info ?? null, model: opts.model }
  const ledger = new ConsoleLedger({
    transcript: () => state.info,
    model: () => state.model,
    publish: (paneId, usage, context) => published.push({ paneId, usage, context }),
    refresh: (cache, f, budget, limits, fresh, onLine) => {
      reads.push(f.path)
      return refreshFile(cache, f, budget, limits, fresh, (data, line) => { lines.push({ path: f.path, line }); onLine(data, line) })
    },
    ...(opts.fs ? { fs: opts.fs } : {}),
    ...(opts.limits ? { limits: opts.limits } : {}),
  })
  const claudeEvt = (paneId = 'pane') => ({ paneId, state: 'done', precise: true, notify: false, provider: 'claude' })
  const done = (paneId = 'pane') => ledger.onStatus(claudeEvt(paneId), { paneId, ptyId: 'pty', provider: 'claude', sessionId: 'sid', kind: 'done' })
  const last = () => published.at(-1)
  return { ledger, published, reads, lines, state, done, last, claudeEvt }
}

/** The real files through a stat that can be held: after `hold()` the next stat waits for `release()`. */
function gatedFs() {
  let gate = null
  let open = () => {}
  const g = {
    waiting: false,
    hold() { gate = new Promise(resolve => { open = resolve }) },
    release() { gate = null; open() },
    readdir: async (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] } },
    stat: async (p) => {
      if (gate) { g.waiting = true; await gate; g.waiting = false }
      try { const st = fs.statSync(p); return st.isFile() ? { path: p, mtimeMs: st.mtimeMs, size: st.size } : null } catch { return null }
    },
  }
  return g
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const r6 = v => Math.round(v * 1e6) / 1e6

async function claudeChecks() {
  const projects = path.join(tmp('claude'), 'projects', 'C--repo')
  const main = path.join(projects, 'sid1.jsonl')
  const h = harness({ info: { provider: 'claude', sessionId: 'sid1', transcriptPath: main } })

  // Dedup: one message per content block, usage repeated, output growing while it streams.
  write(main, [
    userLine(),
    msg('msg_A', u(2, 7, 100, 0)),
    msg('msg_A', u(2, 478, 100, 0)),
    msg(null, u(1, 1, 0, 0)),
    msg('msg_B', u(10, 20, 0, 5)),
    msg('msg_B', u(10, 20, 0, 5)),
    '{"type":"assistant", broken json usage',
  ].join('\n') + '\n')
  await h.done()
  let usage = h.last().usage
  check(usage && usage.inputTokens === 13 && usage.outputTokens === 499 && usage.cacheWriteTokens === 100 && usage.cacheReadTokens === 5, `a duplicated message id counts once, at its max per field (got ${JSON.stringify(usage)})`)
  check(usage.estimated === true && usage.model === 'claude-opus-5-5', 'the usage is marked estimated and names the last main-thread model')
  check(usage.unknownCost === true && !('costUSD' in usage), 'a session with usage and no cost-state has an unknown cost')

  // Subagent transcripts: agent-*.jsonl under <sid>/subagents (one level deeper for workflows), never journal.jsonl or other folders.
  write(path.join(projects, 'sid1', 'subagents', 'agent-a1.jsonl'), [msg('msg_C', u(5, 5, 0, 0), { extra: { isSidechain: true } }), msg('msg_B', u(10, 20, 0, 5))].join('\n') + '\n')
  write(path.join(projects, 'sid1', 'subagents', 'workflows', 'wf_1', 'agent-a2.jsonl'), msg('msg_D', u(3, 0, 0, 0)) + '\n')
  write(path.join(projects, 'sid1', 'subagents', 'workflows', 'wf_1', 'journal.jsonl'), msg('msg_E', u(5000, 0, 0, 0)) + '\n')
  write(path.join(projects, 'sid1', 'tool-results', 'x.jsonl'), msg('msg_F', u(7000, 0, 0, 0)) + '\n')
  await h.done()
  usage = h.last().usage
  check(usage.inputTokens === 13 + 5 + 3 && usage.outputTokens === 499 + 5, `a subagent transcript adds its own messages and a repeat of the parent's counts once (got ${usage.inputTokens}/${usage.outputTokens})`)
  check(!h.reads.some(p => /journal|tool-results/.test(p)), 'journal.jsonl and other folders are never read')
  check(h.last().context.used === 10 + 20 + 5 && h.last().context.exact === false, 'the context is the last main-thread message; a subagent message never becomes it')

  // Incremental: only the appended lines are read.
  const before = h.lines.filter(l => l.path === main).length
  fs.appendFileSync(main, [msg('msg_G', u(4, 6, 0, 1000)), msg('msg_G', u(4, 9, 0, 1000))].join('\n') + '\n')
  await h.done()
  const fed = h.lines.filter(l => l.path === main).length - before
  check(fed === 2, `an append feeds only the new lines (got ${fed})`)
  check(h.lines.filter(l => path.basename(l.path).startsWith('agent-')).length === 3, 'an unchanged subagent transcript is not read again')
  usage = h.last().usage
  check(usage.inputTokens === 25 && usage.outputTokens === 513 && usage.cacheReadTokens === 1005, 'the appended message counts once at its max')

  // cost-state: cumulative per session, the last one wins (E10 SPIKE S7 fixture).
  fs.appendFileSync(main, fixtureCost.join('\n') + '\n')
  await h.done()
  usage = h.last().usage
  const lastCost = JSON.parse(fixtureCost.at(-1)).totalCostUSD
  check(usage.costUSD === Math.round(lastCost * 1e6) / 1e6 && usage.costUSD !== Math.round(JSON.parse(fixtureCost[0]).totalCostUSD * 1e6) / 1e6, `the last cost-state record gives costUSD (got ${usage.costUSD})`)
  check(!('unknownCost' in usage), 'a known cost-state with hasUnknownModelCost false leaves no unknown cost')
  // A cost-state in a subagent transcript is not the session's.
  fs.appendFileSync(path.join(projects, 'sid1', 'subagents', 'agent-a1.jsonl'), JSON.stringify({ type: 'cost-state', totalCostUSD: 99, hasUnknownModelCost: true }) + '\n')
  await h.done()
  check(h.last().usage.costUSD === usage.costUSD && !('unknownCost' in h.last().usage), 'only the main transcript carries the session cost')

  // Unknown model cost: hasUnknownModelCost true keeps the known part and flags the rest.
  fs.appendFileSync(main, JSON.stringify({ type: 'cost-state', sessionId: 'sid1', totalCostUSD: 0.5, modelUsage: {}, hasUnknownModelCost: true }) + '\n')
  await h.done()
  usage = h.last().usage
  check(usage.costUSD === 0.5 && usage.unknownCost === true, 'hasUnknownModelCost gives a lower-bound cost with unknownCost')

  // A second session of the same console adds up; the context follows the current one.
  const second = path.join(projects, 'sid2.jsonl')
  write(second, [msg('msg_A', u(2, 478, 100, 0)), msg('msg_K', u(1, 2, 0, 0)), JSON.stringify({ type: 'cost-state', totalCostUSD: 0.25, hasUnknownModelCost: false })].join('\n') + '\n')
  h.state.info = { provider: 'claude', sessionId: 'sid2', transcriptPath: second }
  await h.done()
  usage = h.last().usage
  check(usage.inputTokens === 26 && usage.outputTokens === 515 && usage.costUSD === 0.75 && usage.unknownCost === true, `a second session sums with the first (copied messages once), and so do their costs (got ${JSON.stringify(usage)})`)
  check(h.last().context.used === 3, 'the context is the current session\'s last main-thread message')

  // Recompute only on a done: a working event, a Codex done or a subagent done read nothing.
  const readsBefore = h.reads.length
  fs.appendFileSync(second, msg('msg_L', u(1, 1, 0, 0)) + '\n')
  check(h.ledger.onStatus({ ...h.claudeEvt(), state: 'working' }, { paneId: 'pane', ptyId: 'pty', provider: 'claude', sessionId: 'sid2', kind: 'working' }) === undefined, 'a working event schedules nothing')
  h.ledger.onStatus(h.claudeEvt(), { paneId: 'pane', ptyId: 'pty', provider: 'claude', sessionId: 'sid2', kind: 'done', subagent: true })
  h.ledger.onStatus(h.claudeEvt(), { paneId: 'pane', ptyId: 'pty', provider: 'codex', sessionId: 'sid2', kind: 'done' })
  h.ledger.onStatus(h.claudeEvt(), undefined)
  await new Promise(resolve => setImmediate(resolve))
  check(h.reads.length === readsBefore, 'a working event (or any non-done of the main Claude agent) does not read the file')
  const pubBefore = h.published.length
  await h.done()
  check(h.reads.length > readsBefore && h.published.length === pubBefore + 1, 'the done reads and publishes once')

  // Forget on a cleared status: the next done starts from scratch (the whole transcript again).
  h.ledger.onStatus({ paneId: 'pane', state: null, precise: false, notify: false })
  const linesBefore = h.lines.length
  await h.done()
  check(h.lines.length - linesBefore === 4, 'a cleared status forgets the pane: the next done reads its transcript again from the start')
  usage = h.last().usage
  check(usage.inputTokens === 4 && usage.outputTokens === 481 && usage.costUSD === 0.25 && !('unknownCost' in usage), 'and only what it reads now counts')

  // A pane forgotten while its read is still queued reads nothing and publishes nothing.
  fs.appendFileSync(second, msg('msg_M', u(1, 1, 0, 0)) + '\n')
  const queued = h.done()
  h.ledger.forget('pane')
  const pubs = h.published.length, queuedReads = h.reads.length
  await queued
  check(h.reads.length === queuedReads && h.published.length === pubs, 'a read still queued when the pane is forgotten reads and publishes nothing')

  // No transcript (title-only track, Codex, a relative path) reads nothing.
  for (const info of [null, { provider: 'claude', sessionId: '' }, { provider: 'codex', sessionId: 'x', transcriptPath: main }, { provider: 'claude', sessionId: 'x', transcriptPath: 'rel/sid1.jsonl' }]) {
    h.state.info = info
    const r = h.reads.length
    await h.done()
    check(h.reads.length === r, `no hook-reported Claude transcript, no read (${JSON.stringify(info)})`)
  }
}

async function flightChecks() {
  // A read that is really in flight (waiting on its stat) when the console changes.
  const projects = path.join(tmp('flight'), 'projects', 'C--f')
  const a = path.join(projects, 'sidA.jsonl'), b = path.join(projects, 'sidB.jsonl')
  write(a, msg('fa1', u(5, 5, 0, 0)) + '\n')
  write(b, msg('fb1', u(7, 7, 0, 0)) + '\n')
  const infoA = { provider: 'claude', sessionId: 'sidA', transcriptPath: a }
  const g = gatedFs()
  const h = harness({ info: infoA, fs: g })
  await h.done()
  check(h.last().usage.inputTokens === 5 && h.last().context.used === 10, 'a first read publishes the session\'s usage and context')

  // Forgotten while the read waits: nothing goes out.
  fs.appendFileSync(a, msg('fa2', u(1, 1, 0, 0)) + '\n')
  let pubs = h.published.length
  g.hold()
  let flight = h.done()
  await tick()
  check(g.waiting, 'the read is in flight, waiting on its stat')
  h.ledger.forget('pane')
  g.release()
  await flight
  check(h.published.length === pubs, 'a pane forgotten while its read is in flight publishes nothing')

  // A /clear or a resume while the read waits: the console's usage goes out, the old session's context does not.
  await h.done()
  check(h.last().usage.inputTokens === 6 && h.last().context.used === 2, 'the next done reads the forgotten pane again from the start')
  fs.appendFileSync(a, msg('fa3', u(2, 2, 0, 0)) + '\n')
  pubs = h.published.length
  g.hold()
  flight = h.done()
  await tick()
  h.state.info = { provider: 'claude', sessionId: 'sidB', transcriptPath: b }
  g.release()
  await flight
  check(h.published.length === pubs + 1 && h.last().usage.inputTokens === 8 && h.last().context === null, `a read that ends after the console moved to another session of the agent publishes the usage without a context (got ${JSON.stringify(h.last())})`)

  // Another agent took the console while the read waits: nothing at all.
  h.state.info = infoA
  fs.appendFileSync(a, msg('fa4', u(3, 3, 0, 0)) + '\n')
  pubs = h.published.length
  g.hold()
  flight = h.done()
  await tick()
  h.state.info = { provider: 'codex', sessionId: 'thread-1' }
  g.release()
  await flight
  check(h.published.length === pubs, 'a read that ends after another agent took the console publishes nothing')

  // A status of the other agent forgets the ledger, even before that agent reports any usage.
  h.state.info = infoA
  await h.done()
  check(h.last().usage.inputTokens === 11 && h.ledger.claude.has('pane'), 'the Claude ledger follows the console')
  h.ledger.onStatus({ paneId: 'pane', state: 'idle', precise: false, notify: false, provider: 'codex' })
  check(!h.ledger.claude.has('pane'), 'a Codex status in the console forgets its Claude ledger')
  h.state.info = { provider: 'claude', sessionId: 'sidB', transcriptPath: b }
  await h.done()
  check(h.last().usage.inputTokens === 7, `so the next Claude session starts from zero (got ${h.last().usage.inputTokens})`)
  const cx = { totalTokens: 11, inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 }
  h.ledger.codexUsage('pane', 'pty-cx', { threadId: 'T1', turnId: 't', total: cx, last: cx, modelContextWindow: 1000 })
  check(h.ledger.codex.has('pane') && !h.ledger.claude.has('pane'), 'a Codex usage takes the console from the Claude ledger')
  h.ledger.onStatus({ paneId: 'pane', state: 'working', precise: true, notify: false, provider: 'claude' })
  check(!h.ledger.codex.has('pane'), 'and a Claude status forgets the Codex one')

  // While the main transcript catches up (past the read budget) there is no context: its last message read is mid-history.
  const big = path.join(projects, 'sidC.jsonl')
  const bigLines = [msg('c1', u(1, 1, 0, 90000)), msg('c2', u(1, 1, 0, 90001), { model: 'claude-old-1' }), msg('c3', u(1, 1, 0, 20000)), msg('c4', u(1, 1, 0, 20001))]
  write(big, bigLines.join('\n') + '\n')
  const slow = harness({ info: { provider: 'claude', sessionId: 'sidC', transcriptPath: big }, model: 'claude-opus-5-5', limits: { bytes: Buffer.byteLength(bigLines[0] + '\n') * 2 + 4 } })
  await slow.done()
  check(slow.last().usage.inputTokens === 2 && slow.last().context === null && slow.last().usage.model === 'claude-opus-5-5', `a main transcript still catching up has no context and no model from its middle (got ${JSON.stringify(slow.last())})`)
  await slow.done()
  check(slow.last().usage.inputTokens === 4 && slow.last().context.used === 20003, 'once caught up, the context is its last message')

  // A read that fails mid-file keeps what it consumed and still says true (refreshFile's catch): not caught up either.
  const torn = path.join(projects, 'sidD.jsonl')
  write(torn, bigLines.join('\n') + '\n')
  let tear = true
  const tornOut = []
  const tornLedger = new ConsoleLedger({
    transcript: () => ({ provider: 'claude', sessionId: 'sidD', transcriptPath: torn }),
    model: () => 'claude-opus-5-5',
    publish: (paneId, usage, context) => tornOut.push({ usage, context }),
    refresh: async (cache, f, budget, limits, fresh, onLine) => {
      if (!tear) return refreshFile(cache, f, budget, limits, fresh, onLine)
      tear = false
      await refreshFile(cache, f, { ...budget }, { ...limits, bytes: Buffer.byteLength(bigLines[0] + '\n') * 2 + 4 }, fresh, onLine)
      return true
    },
  })
  const tornDone = () => tornLedger.onStatus({ paneId: 'pane', state: 'done', precise: true, notify: false, provider: 'claude' }, { paneId: 'pane', ptyId: 'pty', provider: 'claude', sessionId: 'sidD', kind: 'done' })
  await tornDone()
  check(tornOut.at(-1).usage.inputTokens === 2 && tornOut.at(-1).context === null, `a main transcript whose read failed mid-file has no context from its middle (got ${JSON.stringify(tornOut.at(-1))})`)
  await tornDone()
  check(tornOut.at(-1).usage.inputTokens === 4 && tornOut.at(-1).context.used === 20003, 'the next read resumes where it failed and the context is its last message')
}

async function contextChecks() {
  const dir = path.join(tmp('context'), 'projects', 'C--ctx')
  const run = async (lines, model) => {
    const file = path.join(dir, `s${Math.random().toString(16).slice(2)}.jsonl`)
    write(file, lines.join('\n') + '\n')
    const h = harness({ info: { provider: 'claude', sessionId: 's', transcriptPath: file }, model })
    await h.done()
    return h.last().context
  }
  // 200k: input + cache read + cache creation + output of the last main-thread message.
  let ctx = await run([msg('m1', u(2, 4, 18684, 17010))])
  check(ctx && ctx.used === 35700 && ctx.window === 200_000 && ctx.pct === 0.1785 && ctx.exact === false, `a 200k model: approximate context of the last message (got ${JSON.stringify(ctx)})`)
  ctx = await run([msg('m1', u(2, 4, 18684, 17010))], 'claude-opus-5-5[1m]')
  check(ctx.window === 1_000_000 && ctx.pct === 0.0357, 'a [1m] model (from the status) has a 1M window')
  ctx = await run([msg('m1', u(2, 4, 18684, 17010), { model: 'claude-haiku-5-5' })])
  check(ctx.window === 1_000_000, 'claude-haiku-5-5 has a 1M window (S1)')
  ctx = await run([msg('m1', u(1000, 1000, 48000, 200000))])
  check(ctx.used === 250000 && ctx.window === 1_000_000 && ctx.pct === 0.25, 'usage above the assumed 200k window bumps it to 1M')
  ctx = await run([msg('m1', u(10, 10, 0, 0)), msg('m2', u(50, 50, 0, 0), { extra: { isSidechain: true } }), msg('m3', u(0, 0, 0, 0), { model: '<synthetic>' })])
  check(ctx.used === 20, 'sidechain and synthetic messages never become the context')
  ctx = await run([userLine()])
  check(ctx === null, 'no assistant message, no context')

  // rateCard
  check(rateCard.claudeContextWindow(undefined) === 200_000 && rateCard.claudeContextWindow('opus[1m]') === 1_000_000 && rateCard.claudeContextWindow('claude-sonnet-4-5[1m]') === 1_000_000, 'claudeContextWindow: 200k by default, 1M with the [1m] suffix (alias or id)')
  check(rateCard.claudeContextWindow('claude-haiku-5-5-20261001') === 1_000_000 && rateCard.claudeContextWindow('claude-haiku-5-50') === 200_000 && rateCard.claudeContextWindow('claude-opus-5-5') === 200_000, 'claude-haiku-5-5 with a date suffix is 1M, another digit is not')
  check(rateCard.fitContextWindow(150_000, 200_000) === 200_000 && rateCard.fitContextWindow(200_001, 200_000) === 1_000_000, 'fitContextWindow bumps only above the window')
  check(rateCard.RATE_CARD_DATE === '2026-10-23' && typeof rateCard.RATE_CARD_VERSION === 'number', 'the rate card is versioned and dated')
}

function codexChecks() {
  const h = harness({ model: 'gpt-6-luna' })
  const b = (input, cached, output) => ({ totalTokens: input + output, inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0 })
  const usage = (threadId, total, last, window = 258400) => ({ threadId, turnId: 't', total, last, modelContextWindow: window })
  // A resumed thread (S4 fixture totals 19731 -> 43860 -> 73235): the first sight is total - last.
  h.ledger.codexUsage('cx', 'pty-1', usage('T1', b(43860, 19584, 10), b(24129, 19584, 5)))
  let out = h.last()
  check(out.paneId === 'cx' && out.usage.inputTokens === 24129 - 19584 && out.usage.cacheReadTokens === 19584 && out.usage.outputTokens === 5, `a resumed thread counts from its baseline (total - last at first sight) (got ${JSON.stringify(out.usage)})`)
  check(out.context.exact === true && out.context.used === 24134 && out.context.window === 258400 && out.context.pct === Math.round((24134 / 258400) * 1e4) / 1e4, 'Codex context is exact: (last.input + last.output) / modelContextWindow')
  check(out.usage.unknownCost === true && !('costUSD' in out.usage) && out.usage.model === 'gpt-6-luna', 'an unknown Codex model has no cost')
  h.ledger.codexUsage('cx', 'pty-1', usage('T1', b(73235, 43520, 16), b(29375, 23936, 6)))
  out = h.last()
  check(out.usage.inputTokens === (73235 - 19731) - 43520 && out.usage.cacheReadTokens === 43520 && out.usage.outputTokens === 11, 'the next update of the thread adds total - baseline')
  // A new thread in the same console adds its whole total.
  h.ledger.codexUsage('cx', 'pty-1', usage('T2', b(19731, 0, 5), b(19731, 0, 5)))
  out = h.last()
  check(out.usage.inputTokens === (73235 - 19731 - 43520) + 19731 && out.usage.outputTokens === 16, 'a new thread in the same console adds up with the resumed one')
  check(out.context.used === 19736, 'the context follows the latest update')
  h.ledger.codexUsage('cx', 'pty-1', usage('T2', b(19731, 0, 5), b(19731, 0, 5), null))
  check(h.last().context === null, 'no modelContextWindow, no context')
  // A new pty is a new process: it starts over.
  h.ledger.codexUsage('cx', 'pty-2', usage('T3', b(100, 0, 1), b(100, 0, 1)))
  check(h.last().usage.inputTokens === 100 && h.last().usage.outputTokens === 1, 'a new pty of the pane starts its own ledger')
  // Codex never reads a file.
  check(h.reads.length === 0, 'a Codex usage update reads no file')
  // rateCard: an empty card prices nothing; a row prices input (cached apart) and output.
  check(Object.keys(rateCard.CODEX_RATES).length === 0, 'the Codex rate card has no unverified price')
  check(rateCard.codexCost('gpt-6-luna', { inputTokens: 10, cachedInputTokens: 0, outputTokens: 1 }) === undefined && rateCard.codexCost('constructor', { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }) === undefined, 'a model without a row has no cost (never a prototype key)')
  const rates = { 'm-test': { input: 2, cachedInput: 0.5, output: 8 } }
  check(Math.abs(rateCard.codexCost('M-Test', { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 100_000 }, rates) - 2.2) < 1e-9, 'codexCost prices the uncached input, the cached input and the output per 1M')
}

async function walkChecks() {
  // At most LEDGER_SUBAGENTS_MAX subagent transcripts are read per turn, the
  // newest first whatever the directory order; the rest wait for the next turn.
  const base = path.join(tmp('walk'), 'projects', 'C--w')
  const main = path.join(base, 'sid.jsonl')
  write(main, msg('m1', u(1, 1, 0, 0)) + '\n')
  const subRoot = path.join(base, 'sid', 'subagents')
  const subCount = LEDGER_SUBAGENTS_MAX + 40
  for (let i = 0; i < subCount; i++) {
    // The directory lists them oldest first: agent-0000 is the oldest.
    const f = path.join(subRoot, `agent-${String(i).padStart(4, '0')}.jsonl`)
    write(f, msg(`sub${i}`, u(1, 0, 0, 0)) + '\n')
    const at = new Date(Date.now() - (subCount - i) * 1000)
    fs.utimesSync(f, at, at)
  }
  const h = harness({ info: { provider: 'claude', sessionId: 'sid', transcriptPath: main } })
  await h.done()
  const fedSubs = () => new Set(h.lines.filter(l => l.path !== main).map(l => path.basename(l.path)))
  let subs = fedSubs()
  check(subs.size === LEDGER_SUBAGENTS_MAX && h.last().usage.inputTokens === 1 + LEDGER_SUBAGENTS_MAX, `at most ${LEDGER_SUBAGENTS_MAX} subagent transcripts per turn (got ${subs.size})`)
  check(subs.has(`agent-${String(subCount - 1).padStart(4, '0')}.jsonl`) && !subs.has('agent-0000.jsonl'), 'the newest subagent transcripts are read first, not the first ones the directory lists')
  await h.done()
  subs = fedSubs()
  check(subs.size === subCount && h.last().usage.inputTokens === 1 + subCount, `the next turn reads the ones the budget left (got ${subs.size})`)

  // The walk is bounded: depth like custom.ts (3 levels under subagents/) and LEDGER_WALK_ENTRIES_MAX entries.
  const dirent = (name, dir) => ({ name, isFile: () => !dir, isDirectory: () => dir })
  let stats = 0
  const fakeFs = {
    readdir: async (dir) => {
      const rel = path.relative(subRoot, dir)
      if (rel === '') return [...Array.from({ length: LEDGER_WALK_ENTRIES_MAX + 100 }, (_, i) => dirent(`agent-${i}.jsonl`, false)), dirent('d1', true)]
      const depth = rel.split(path.sep).length
      return depth <= 5 ? [dirent(`agent-deep${depth}.jsonl`, false), dirent(`d${depth + 1}`, true)] : []
    },
    stat: async (p) => (p === main ? { path: p, mtimeMs: 1, size: fs.statSync(p).size } : (stats++, { path: p, mtimeMs: 2, size: 0 })),
  }
  const wide = harness({ info: { provider: 'claude', sessionId: 'sid', transcriptPath: main }, fs: fakeFs })
  await wide.done()
  check(stats === LEDGER_WALK_ENTRIES_MAX && !wide.reads.some(p => path.basename(p).startsWith('agent-deep')), `the walk looks at most at ${LEDGER_WALK_ENTRIES_MAX} entries per turn (got ${stats})`)
  const wideSubs = wide.reads.filter(p => p !== main).length
  check(wideSubs === LEDGER_LISTED_MAX && wide.ledger.claude.get('pane').files.size === LEDGER_LISTED_MAX + 1, `only the newest ${LEDGER_LISTED_MAX} are listed, so the cache never evicts a file the turn lists (got ${wideSubs})`)
  const deep = harness({ info: { provider: 'claude', sessionId: 'sid', transcriptPath: main }, fs: { ...fakeFs, readdir: async (dir) => (path.relative(subRoot, dir) === '' ? [dirent('d1', true)] : fakeFs.readdir(dir)) } })
  await deep.done()
  const names = deep.reads.filter(p => p !== main).map(p => path.basename(p)).sort()
  check(names.join() === 'agent-deep1.jsonl,agent-deep2.jsonl,agent-deep3.jsonl', `the walk goes 3 levels under subagents/, like custom.ts (got ${names.join()})`)

  // The tombstones of evicted transcripts are capped too: every turn lists a new set of (empty) subagents.
  let wave = 0
  const churn = harness({ info: { provider: 'claude', sessionId: 'sid', transcriptPath: main }, fs: {
    readdir: async (dir) => (path.relative(subRoot, dir) === '' ? Array.from({ length: LEDGER_LISTED_MAX }, (_, i) => dirent(`agent-w${wave}-${i}.jsonl`, false)) : []),
    stat: async (p) => (p === main ? { path: p, mtimeMs: 1, size: fs.statSync(p).size } : { path: p, mtimeMs: 2, size: 0 }),
  } })
  for (wave = 0; wave < 10; wave++) await churn.done()
  const churned = churn.ledger.claude.get('pane')
  check(churned.files.size === LEDGER_LISTED_MAX + 1 && churned.gone.size === LEDGER_TOMBSTONES_MAX, `the cache keeps the turn's files and at most ${LEDGER_TOMBSTONES_MAX} tombstones (got ${churned.files.size}/${churned.gone.size})`)

  // The dedup set is capped per pane.
  const capFile = path.join(base, 'cap.jsonl')
  const many = Array.from({ length: LEDGER_DEDUP_MAX + 10 }, (_, i) => msg(`id${i}`, u(1, 0, 0, 0)))
  write(capFile, many.join('\n') + '\n')
  const cap = harness({ info: { provider: 'claude', sessionId: 'cap', transcriptPath: capFile } })
  await cap.done()
  check(cap.last().usage.inputTokens === LEDGER_DEDUP_MAX + 10, 'every distinct message counts even past the dedup cap')
  fs.appendFileSync(capFile, msg(`id${LEDGER_DEDUP_MAX + 9}`, u(1, 0, 0, 0)) + '\n')
  await cap.done()
  check(cap.last().usage.inputTokens === LEDGER_DEDUP_MAX + 10, 'a recent repeat is still deduplicated with the capped set')
}

async function evictionChecks() {
  // More subagents than the cache holds, several messages each (more ids than
  // the dedup window): once caught up, a new subagent per turn adds only its own
  // messages and nothing is read again.
  const base = path.join(tmp('evict'), 'projects', 'C--e')
  const per = 10
  const ids = (prefix) => Array.from({ length: per }, (_, k) => msg(`${prefix}-${k}`, u(1, 0, 0, 0))).join('\n') + '\n'
  const main = path.join(base, 'sid.jsonl')
  write(main, msg('e-main', u(1, 0, 0, 0)) + '\n')
  const t0 = Date.now() - 10 * 24 * 60 * 60 * 1000
  const sub = (name, i) => {
    const f = path.join(base, 'sid', 'subagents', `agent-${name}.jsonl`)
    write(f, ids(name))
    const at = new Date(t0 + i * 1000)
    fs.utimesSync(f, at, at)
  }
  const subCount = LEDGER_LISTED_MAX + 89
  for (let i = 0; i < subCount; i++) sub(`s${i}`, i)
  const h = harness({ info: { provider: 'claude', sessionId: 'sid', transcriptPath: main } })
  for (let i = 0; i < 3; i++) await h.done()
  const caught = 1 + LEDGER_LISTED_MAX * per
  check(h.last().usage.inputTokens === caught, `after the catch-up the newest ${LEDGER_LISTED_MAX} subagents count once each (got ${h.last().usage.inputTokens})`)
  for (let turn = 1; turn <= 4; turn++) {
    sub(`n${turn}`, subCount + turn)
    const fed = h.lines.length
    await h.done()
    check(h.last().usage.inputTokens === caught + turn * per && h.lines.length - fed === per, `turn ${turn}: a new subagent adds only its own messages (got ${h.last().usage.inputTokens - caught}, ${h.lines.length - fed} lines read)`)
  }
  const evicted = h.ledger.claude.get('pane')
  check(evicted.files.size === LEDGER_LISTED_MAX + 1 && evicted.gone.size === 4, `the subagent each turn pushed out of the listing leaves the cache as a tombstone (got ${evicted.files.size}/${evicted.gone.size})`)

  // Sessions that push an earlier one out of the cache: resuming it reads and counts only what it appended.
  const session = (sid, mainMsgs, subs, cost) => {
    const file = path.join(base, `${sid}.jsonl`)
    write(file, Array.from({ length: mainMsgs }, (_, k) => msg(`${sid}-m${k}`, u(1, 0, 0, 0))).join('\n') + '\n' + JSON.stringify({ type: 'cost-state', totalCostUSD: cost, hasUnknownModelCost: false }) + '\n')
    for (let i = 0; i < subs; i++) write(path.join(base, sid, 'subagents', `agent-${sid}-${i}.jsonl`), ids(`${sid}-${i}`))
    return { provider: 'claude', sessionId: sid, transcriptPath: file }
  }
  const infoA = session('sA', 100, 300, 1)
  const r = harness({ info: infoA })
  await r.done()
  await r.done()
  check(r.last().usage.inputTokens === 3100, `session A counts its main transcript and its subagents (got ${r.last().usage.inputTokens})`)
  r.state.info = session('sB', 100, 250, 0.5)
  await r.done()
  await r.done()
  check(r.last().usage.inputTokens === 5700 && r.ledger.claude.get('pane').gone.has(infoA.transcriptPath), `session B adds up and pushes session A's files out of the cache (got ${r.last().usage.inputTokens})`)
  fs.appendFileSync(infoA.transcriptPath, msg('sA-back', u(1, 0, 0, 0)) + '\n' + JSON.stringify({ type: 'cost-state', totalCostUSD: 1.25, hasUnknownModelCost: false }) + '\n')
  r.state.info = infoA
  const fedBefore = r.lines.length
  await r.done()
  const back = r.last()
  check(back.usage.inputTokens === 5701 && r.lines.length - fedBefore === 2, `resuming session A reads and counts only what it appended (got ${back.usage.inputTokens}, ${r.lines.length - fedBefore} lines read)`)
  check(back.usage.costUSD === 1.75 && back.context.used === 1, 'its cost-state still replaces its own earlier one, and the context is its newest message')

  // More sessions than the ledger keeps apart: one folded into the carried sum that comes back is not counted twice.
  const fold = harness({ info: null })
  let sum = 0
  const folds = []
  for (let i = 0; i < LEDGER_PARTS_MAX + 2; i++) {
    const file = path.join(base, `fold-${i}.jsonl`)
    write(file, msg(`fold-${i}`, u(1, 0, 0, 0)) + '\n' + JSON.stringify({ type: 'cost-state', totalCostUSD: (i + 1) / 100, hasUnknownModelCost: false }) + '\n')
    folds.push({ provider: 'claude', sessionId: `fold-${i}`, transcriptPath: file })
    fold.state.info = folds[i]
    await fold.done()
    sum += (i + 1) / 100
  }
  check(fold.last().usage.costUSD === r6(sum) && fold.last().usage.inputTokens === LEDGER_PARTS_MAX + 2, `past ${LEDGER_PARTS_MAX} sessions the oldest fold into one sum (got ${fold.last().usage.costUSD})`)
  fs.appendFileSync(folds[0].transcriptPath, JSON.stringify({ type: 'cost-state', totalCostUSD: 0.5, hasUnknownModelCost: false }) + '\n')
  fold.state.info = folds[0]
  await fold.done()
  check(fold.last().usage.costUSD === r6(sum - 0.01 + 0.5) && !('unknownCost' in fold.last().usage), `a folded session that comes back leaves the carried sum before it counts again (got ${fold.last().usage.costUSD}, want ${r6(sum - 0.01 + 0.5)})`)
}

function statusChecks() {
  let clock = 1_000_000
  const timers = new Map()
  let seq = 0
  const { StatusManager } = load('src/main/status/StatusManager.ts', {
    require: id => (id === 'electron' ? { Notification: { isSupported: () => false } } : require(id)),
    setTimeout: fn => { timers.set(++seq, fn); return seq }, clearTimeout: id => timers.delete(id),
    Date: class extends Date { static now() { return clock } },
  })
  const events = []
  const manager = new StatusManager(() => ({ isDestroyed: () => false, isFocused: () => false, webContents: { send: (_ch, e) => events.push(e) }, flashFrame() {} }), () => null, () => {})
  manager.onSpawn('pty', 'pane')
  const flush = () => { const fns = [...timers.values()]; timers.clear(); fns.forEach(fn => fn()) }
  const usage = { inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8, unknownCost: true, model: 'claude-opus-5-5', estimated: true }
  const context = { pct: 0.25, used: 50000, window: 200000, exact: false }
  // A title-only track takes nothing.
  manager.reportTitle('pane', '\u2802 Working')
  manager.setUsage('pane', usage, context)
  check(!manager.stateOf('pane')?.usage, 'an approximate (title-only) track takes no usage')
  manager.onAgentEvent({ paneId: 'pane', ptyId: 'pty', provider: 'claude', sessionId: 'session-1', kind: 'start' })
  const before = events.length
  manager.setUsage('pane', usage, context)
  check(events.length === before, 'setUsage is detail-only: within the 500 ms throttle it waits for the trailing emission')
  flush()
  check(events.length === before + 1 && events.at(-1).usage.inputTokens === 5 && events.at(-1).context.pct === 0.25, 'and then it is published once, with usage and context')
  check(manager.stateOf('pane').usage.cacheWriteTokens === 8 && manager.snapshot()[0].context.window === 200000, 'event() carries them (stateOf and snapshot too)')
  clock += 1000
  manager.setUsage('pane', { ...usage }, { ...context })
  check(events.length === before + 1, 'the same values again publish nothing')
  manager.setUsage('pane', { ...usage, outputTokens: 60 }, context)
  check(events.length === before + 2 && events.at(-1).usage.outputTokens === 60, 'past the throttle a change goes out at once')
  // A new session of the console keeps the usage, not the context.
  clock += 1000
  manager.onAgentEvent({ paneId: 'pane', ptyId: 'pty', provider: 'claude', sessionId: 'session-2', kind: 'start', source: 'clear' })
  check(events.at(-1).usage?.outputTokens === 60 && !('context' in events.at(-1)), 'a new session of the console keeps its usage and drops the context')
  manager.setUsage('pane', null, null)
  flush()
  check(!('usage' in manager.stateOf('pane')) && !('context' in manager.stateOf('pane')), 'null clears them')
}

async function integrationChecks() {
  // StatusManager -> listener -> ledger -> setUsage, the way index.ts wires it.
  const timers = new Map()
  let seq = 0
  const { StatusManager } = load('src/main/status/StatusManager.ts', {
    require: id => (id === 'electron' ? { Notification: { isSupported: () => false } } : require(id)),
    setTimeout: fn => { timers.set(++seq, fn); return seq }, clearTimeout: id => timers.delete(id),
  })
  const manager = new StatusManager(() => null, () => null, () => {})
  manager.onSpawn('pty', 'pane')
  const flush = () => { const fns = [...timers.values()]; timers.clear(); fns.forEach(fn => fn()) }
  const claudeDir = tmp('wired')
  const file = path.join(claudeDir, 'projects', 'C--repo', 'sess-0001.jsonl')
  write(file, [userLine(), msg('m1', u(3, 4, 0, 1000))].join('\n') + '\n')
  const reads = []
  const ledger = new ConsoleLedger({
    transcript: (paneId) => manager.transcriptFor(paneId),
    model: (paneId) => manager.stateOf(paneId)?.model,
    publish: (paneId, u2, c) => manager.setUsage(paneId, u2, c),
    refresh: (...args) => { reads.push(args[1].path); return refreshFile(...args) },
  })
  const pending = []
  manager.addListener((evt, cause) => { const p = ledger.onStatus(evt, cause); if (p) pending.push(p) })
  const ev = (kind, rest = {}) => manager.onAgentEvent({ paneId: 'pane', ptyId: 'pty', provider: 'claude', sessionId: 'sess-0001', transcriptPath: file, kind, ...rest })
  ev('start'); ev('working', { prompt: 'go', turnId: 'prompt:1' }); ev('working', { tool: 'Bash: ls', toolUseId: 't1' })
  check(pending.length === 0 && reads.length === 0, 'start and working events read nothing')
  ev('done')
  check(pending.length === 0, 'the Stop itself waits for the 700 ms done')
  flush()
  check(pending.length === 1, 'the settled done recomputes once')
  await Promise.all(pending)
  flush()
  const st = manager.stateOf('pane')
  check(st.usage && st.usage.inputTokens === 3 && st.usage.cacheReadTokens === 1000 && st.context && st.context.used === 1007, `the console's status carries the ledger's usage and context (got ${JSON.stringify(st.usage)})`)
  check(ledger.claude.size === 1, 'the ledger follows the console')
  manager.onExit('pty', 'pane')
  check(!manager.stateOf('pane') && ledger.claude.size === 0, 'an exit clears the status and the ledger forgets the console')
}

async function main() {
  await claudeChecks()
  await flightChecks()
  await contextChecks()
  codexChecks()
  await walkChecks()
  await evictionChecks()
  statusChecks()
  await integrationChecks()
  console.log(`PASS: ${checks} ledger checks (Claude dedup, subagents, incremental reads, eviction and resume, reads in flight, cost-state, context windows, Codex baselines, rate card, setUsage)`)
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }) })
