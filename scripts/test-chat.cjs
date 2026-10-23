// Chat view (E3 M12, FR-21, 24..34) against the real main modules: the chat
// schemas, the Claude and Codex decoders over scripts/fixtures/chat, the tool
// summaries, the backward pages (50 messages or 48KB, 8MB scan cap, an
// unaligned `before`, a 50MB transcript under 1s), the tail (partial lines,
// a record over 2MB, truncation as a reset), the locator (slug, hooks path,
// symlink out of the root, CLAUDE_CONFIG_DIR, ambiguous, claimed, notLocal,
// Codex rollout) and ChatHub through RemoteManager + SessionManager with a
// fake socket, a fake pty table and a fake clock (first page, appends, more,
// notices, no `out` while in Chat, the owner in Chat without timers, the
// watcher closing 30s after the last reader, at most 4 watchers). Every file
// lives in a temp folder; nothing listens and no real ~/.claude is read.
const { build } = require('esbuild')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const fixtures = path.join(__dirname, 'fixtures', 'chat')
let checks = 0
function check(condition, label) { assert.ok(condition, label); checks++ }
const tick = () => new Promise(resolve => setImmediate(resolve))
async function settle(n = 6) { for (let i = 0; i < n; i++) await tick() }
/** Real time for real file I/O: wait until cond() holds (2s at most). */
async function until(cond, ms = 2000) {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await new Promise(r => setTimeout(r, 5))
  await settle()
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-chat-'))
const dataDir = path.join(tmp, 'data')
fs.mkdirSync(dataDir)
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
    b.onLoad({ filter: /^paths$/, namespace: 'stub' }, () => ({ loader: 'ts', contents: `export function dataDir() { return ${JSON.stringify(dataDir)} }` }))
  },
}
const entry = `
export { RemoteManager } from './src/main/remote/RemoteManager'
export { MAX_CHAT_SUBS } from './src/main/remote/SessionManager'
export { FIT_GRACE_MS, FIT_COALESCE_MS } from './src/main/remote/FitController'
export { parseRemoteClientMsg } from './src/shared/remote-protocol-schemas'
export { decodeClaude, patchOf } from './src/main/chat/decodeClaude'
export { decodeCodex } from './src/main/chat/decodeCodex'
export { toolSummary } from './src/main/chat/toolSummary'
export { readPage, readAppend, TranscriptWatcher, MAX_RECORD_BYTES, PAGE_SCAN_MAX } from './src/main/chat/TranscriptWatcher'
export { TranscriptLocator, cwdKey, pathKey, admit, awaitable, codexSessionMeta, PENDING_BOOT_MS } from './src/main/chat/TranscriptLocator'
export { ChatHub, noticePage, emptyPage, CHAT_CLOSE_DELAY_MS, CHAT_PENDING_POLL_MS, CHAT_PENDING_MAX_MS } from './src/main/chat/ChatHub'
export { shrinkMessage, splitAppend, jsonBytes } from './src/main/chat/chatFrames'
export { claudeConfigDir } from './src/main/status/statusDetails'
export { claudeSlug } from './src/main/agents/transcripts'
export { chatMessageOffset, chatNoticeOf, CHAT_SKIPPED_TEXT } from './src/shared/chat-types'
`
let code = ''
const FRAME_MAX = 49152

/** A fresh context: real timers, or a fake clock with advance(). */
function load(fake = false) {
  let clock = 0, seq = 0
  const timers = new Map()
  const add = (fn, ms, every) => { const id = ++seq; timers.set(id, { at: clock + Math.max(0, ms || 0), fn, every }); return { id, unref() {}, ref() {} } }
  const del = h => { if (h) timers.delete(typeof h === 'object' ? h.id : h) }
  function advance(ms) {
    const end = clock + ms
    for (;;) {
      let best = null
      for (const [id, t] of timers) if (t.at <= end && (!best || t.at < best[1].at)) best = [id, t]
      if (!best) break
      const [id, t] = best
      clock = Math.max(clock, t.at)
      if (t.every) t.at += t.every; else timers.delete(id)
      t.fn()
    }
    clock = end
  }
  class FakeDate extends Date { static now() { return 1700000000000 + clock } }
  const ctx = {
    module: { exports: {} }, require: id => id === 'qrcode' ? { toDataURL: async () => 'data:' } : require(id),
    console, process, Buffer, URL, queueMicrotask, TextDecoder, TextEncoder,
    setTimeout: fake ? (fn, ms) => add(fn, ms, 0) : setTimeout, clearTimeout: fake ? del : clearTimeout,
    setInterval: fake ? (fn, ms) => add(fn, ms, ms) : setInterval, clearInterval: fake ? del : clearInterval,
    Date: fake ? FakeDate : Date,
  }
  ctx.exports = ctx.module.exports
  ctx.globalThis = ctx
  vm.runInNewContext(code, ctx)
  return { api: ctx.module.exports, advance, timers }
}

const decodeFile = (api, file, decode) => {
  const out = []
  let offset = 0
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const bytes = Buffer.byteLength(line) + 1
    if (line.trim()) { let rec; try { rec = JSON.parse(line) } catch { rec = undefined } if (rec !== undefined) out.push(...decode(rec, offset)) }
    offset += bytes
  }
  return out
}

const userLine = (text, i = 0) => JSON.stringify({ type: 'user', uuid: 'q' + i, timestamp: '2026-10-01T10:00:00.000Z', message: { role: 'user', content: text } })
const asstLine = (text, i = 0) => JSON.stringify({ type: 'assistant', uuid: 'a' + i, timestamp: '2026-10-01T10:00:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text }] } })

// --- Schemas -------------------------------------------------------------------------

function testSchemas() {
  const { api } = load()
  const parse = obj => api.parseRemoteClientMsg(JSON.stringify({ v: 1, ...obj }))
  check(!!parse({ type: 'chatSub', paneId: 'p1' }) && !!parse({ type: 'chatUnsub', paneId: 'p1' }), 'chatSub and chatUnsub take a paneId')
  check(!parse({ type: 'chatSub' }) && !parse({ type: 'chatSub', paneId: 'x'.repeat(129) }), 'chatSub without a pane or with a 129-char id is malformed')
  check(!!parse({ type: 'chatMore', paneId: 'p1', before: '0' }) && !!parse({ type: 'chatMore', paneId: 'p1', before: '999999999999999' }), 'chatMore takes a numeric cursor up to 15 digits')
  check(!parse({ type: 'chatMore', paneId: 'p1', before: 'abc' }) && !parse({ type: 'chatMore', paneId: 'p1', before: '-1' }) && !parse({ type: 'chatMore', paneId: 'p1', before: '1234567890123456' }) && !parse({ type: 'chatMore', paneId: 'p1', before: 12 }), 'a non-numeric, negative, 16-digit or number cursor is malformed')
}

// --- Decoders -------------------------------------------------------------------------

function testDecodeClaude() {
  const { api } = load()
  const msgs = decodeFile(api, path.join(fixtures, 'claude-session.jsonl'), api.decodeClaude)
  const roles = msgs.map(m => m.role).join(',')
  check(msgs.length === 19, 'the fixture decodes to 19 messages (meta, compact summary, sidechain, summary, system and broken lines skipped): ' + msgs.length)
  check(roles === 'user,assistant,assistant,assistant,tool,assistant,tool,assistant,tool,assistant,tool,assistant,tool,tool,system,user,system,user,assistant', 'roles in order: ' + roles)
  const all = JSON.stringify(msgs)
  check(!all.includes('meta text that must not show') && !all.includes('continued from a previous') && !all.includes('subagent text') && !all.includes('Caveat: meta'), 'isMeta, isCompactSummary and sidechain text never shows')
  check(all.includes('meta result kept'), 'a meta record keeps its tool_result')
  check(msgs[1].blocks[0].t === 'thinking' && msgs[1].blocks[0].text.startsWith('Let me look'), 'thinking becomes a thinking block')
  const uses = msgs.flatMap(m => m.blocks).filter(b => b.t === 'toolUse')
  const results = msgs.flatMap(m => m.blocks).filter(b => b.t === 'toolResult')
  check(uses.length === 5 && uses.every(u => results.some(r => r.toolUseId === u.id)), 'every tool_use has its tool_result by id')
  check(uses.map(u => u.name + ':' + u.summary).join('|') === 'Read:auth.ts|Read:login.ts|Read:token.ts|Edit:App.tsx|Bash:npm test', 'summaries: file basenames and the first command line: ' + uses.map(u => u.summary).join('|'))
  const edit = results.find(r => r.toolUseId === 'toolu_e1')
  check(edit.patch && edit.patch.filePath.endsWith('App.tsx') && edit.patch.hunks.length === 1 && edit.patch.hunks[0].oldStart === 10 && edit.patch.hunks[0].lines.join('') === ' const x = 1-const y = 2+const y = 3+const z = 4 export {}', 'structuredPatch becomes a numbered patch')
  check(results.find(r => r.toolUseId === 'toolu_b1').isError === true && results.find(r => r.toolUseId === 'toolu_r1').isError === false, 'is_error marks the failed tool')
  check(results.find(r => r.toolUseId === 'toolu_r2').text === 'login body', 'a tool_result with text parts reads as text')
  check(msgs[14].role === 'system' && msgs[14].blocks[0].text === '[Request interrupted by user for tool use]', 'an interruption is a system row')
  check(msgs[15].blocks[0].text === '/model opus' && msgs[16].role === 'system' && msgs[16].blocks[0].text === 'Set model to opus', 'slash command wrappers read as the command, local output as a system row')
  check(msgs[17].blocks.some(b => b.t === 'image') && msgs[17].blocks[0].text.includes('<script>alert(1)</script>'), 'images are chips and raw HTML stays text for the phone')
  check(msgs.every(m => m.ts === null || typeof m.ts === 'number') && msgs[0].ts === Date.UTC(2026, 9, 1, 10, 0, 1), 'timestamps are epoch ms')
  check(msgs.every(m => api.chatMessageOffset(m.id) !== null), 'every id is the byte offset of its line')

  // Caps.
  const hunks = Array.from({ length: 50 }, (_, i) => ({ oldStart: i * 10, oldLines: 1, newStart: i * 10, newLines: 1, lines: Array.from({ length: 500 }, (_, j) => '+line ' + j) }))
  const capped = api.patchOf(hunks)
  check(capped.hunks.length === 40 && capped.hunks.every(h => h.lines.length === 400) && capped.cut, 'a patch is capped at 40 hunks x 400 lines')
  const big = api.decodeClaude({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(20000) }, { type: 'thinking', thinking: 'y'.repeat(9000) }] } }, 7)
  check(big[0].blocks[0].text.length === 16384 && big[0].blocks[0].truncated && big[0].blocks[1].text.length === 4096 && big[0].blocks[1].truncated, 'text is cut at 16KB and thinking at 4KB, both marked truncated')
  const out = api.decodeClaude({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'z'.repeat(10 * 1024) }] } }, 0)
  check(out[0].blocks[0].text.length === 4096 && out[0].blocks[0].truncated, 'a 10KB tool output keeps a 4KB preview')
  check(api.decodeClaude({ type: 'user', message: { content: 'hi\x1b[31m red\x07' } }, 0)[0].blocks[0].text === 'hi red', 'escapes and control characters are stripped')
  check(api.decodeClaude(null, 0).length === 0 && api.decodeClaude({ type: 'assistant' }, 0).length === 0 && api.decodeClaude({ type: 'user', message: { content: 42 } }, 0).length === 0, 'unknown shapes decode to nothing')
}

function testDecodeCodex() {
  const { api } = load()
  const msgs = decodeFile(api, path.join(fixtures, 'codex-rollout.jsonl'), api.decodeCodex)
  check(msgs.map(m => m.role).join(',') === 'user,assistant,assistant,tool,assistant,tool,assistant,system', 'the rollout decodes to user, reasoning, calls, outputs, reply and the interruption: ' + msgs.map(m => m.role).join(','))
  const all = JSON.stringify(msgs)
  check(!all.includes('environment_context') && !all.includes('developer instructions'), 'injected context and developer messages are skipped')
  check(msgs.filter(m => m.role === 'user').length === 1 && msgs.filter(m => m.blocks.some(b => b.t === 'text' && b.text === 'Fixed the failing test.')).length === 1, 'event_msg copies of the messages are not repeated')
  const uses = msgs.flatMap(m => m.blocks).filter(b => b.t === 'toolUse')
  check(uses[0].name === 'shell' && uses[0].summary === 'npm test' && uses[1].name === 'apply_patch' && uses[1].summary === 'a.ts', 'shell shows its command, apply_patch its files')
  const res = msgs.flatMap(m => m.blocks).filter(b => b.t === 'toolResult')
  check(res[0].toolUseId === 'call_1' && res[0].isError && res[0].text === '1 failing' && res[1].toolUseId === 'call_2' && !res[1].isError, 'outputs pair by call_id and a non-zero exit code is an error')
  check(msgs[1].blocks[0].t === 'thinking' && msgs[1].blocks[0].text === '**Running tests**', 'reasoning summaries are thinking')
  check(msgs[7].blocks[0].text === '[Request interrupted by user]', 'turn_aborted is the interruption row')
  check(api.decodeCodex({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'old format' }] }, 3)[0].blocks[0].text === 'old format', 'a rollout without the envelope decodes the same')
}

function testToolSummary() {
  const { api } = load()
  const s = api.toolSummary
  check(s('Bash', { command: '\n  git status\ngit diff' }) === 'git status', 'Bash: first non-empty command line')
  check(s('Write', { file_path: '/a/b/c.md' }) === 'c.md' && s('NotebookEdit', { notebook_path: 'C:\\n\\x.ipynb' }) === 'x.ipynb', 'file tools: basename')
  check(s('Grep', { pattern: 'TODO\\(' }) === 'TODO\\(' && s('Glob', { pattern: '**/*.ts' }) === '**/*.ts', 'Grep and Glob: the pattern')
  check(s('Task', { description: 'Find usages', prompt: 'long' }) === 'Find usages', 'Task: description')
  check(s('mcp__srv__do', { a: 1, query: 'find me' }) === 'find me', 'other tools: the first string of the input')
  check(s('Bash', { command: 'x'.repeat(300) }).length === 120, 'summaries are capped at 120')
}

// --- Pages and tail ---------------------------------------------------------------------

async function testPages() {
  const { api } = load()
  const fixture = path.join(fixtures, 'claude-session.jsonl')
  const first = await api.readPage(fixture, api.decodeClaude, { before: null, paneId: 'p1' })
  check(first.items.length === 19 && first.done && first.cursor === null && first.liveEnd === fs.statSync(fixture).size, 'a small transcript is one page, done, no cursor')

  // 50-message cap.
  const many = path.join(tmp, 'many.jsonl')
  fs.writeFileSync(many, Array.from({ length: 120 }, (_, i) => asstLine('message ' + i, i)).join('\n') + '\n')
  const p1 = await api.readPage(many, api.decodeClaude, { before: null, paneId: 'p1' })
  check(p1.items.length === 50 && !p1.done && p1.items[49].blocks[0].text === 'message 119' && p1.items[0].blocks[0].text === 'message 70', 'the newest 50 messages, oldest first')
  check(p1.cursor === String(api.chatMessageOffset(p1.items[0].id)), 'the cursor is the offset of the oldest line in the page')
  const p2 = await api.readPage(many, api.decodeClaude, { before: Number(p1.cursor), paneId: 'p1' })
  check(p2.items.length === 50 && p2.items[49].blocks[0].text === 'message 69', 'the page before the cursor continues without a gap or overlap')
  // An unaligned before reads complete lines only.
  const unaligned = await api.readPage(many, api.decodeClaude, { before: Number(p1.cursor) + 5, paneId: 'p1' })
  check(unaligned.items.every(m => m.blocks[0].text.startsWith('message ')) && unaligned.items.at(-1).blocks[0].text === 'message 70', 'a before inside a line moves to the next line start and returns whole lines')
  const p3 = await api.readPage(many, api.decodeClaude, { before: Number(p2.cursor), paneId: 'p1' })
  check(p3.items.length === 20 && p3.done && p3.cursor === null, 'the oldest page is done')
  check((await api.readPage(many, api.decodeClaude, { before: 0, paneId: 'p1' })).items.length === 0, 'before 0 is an empty done page')

  // 48KB budget with 16KB messages.
  const fat = path.join(tmp, 'fat.jsonl')
  fs.writeFileSync(fat, Array.from({ length: 30 }, (_, i) => asstLine(String.fromCharCode(65 + (i % 26)).repeat(16000), i)).join('\n') + '\n')
  const fp = await api.readPage(fat, api.decodeClaude, { before: null, paneId: 'p1' })
  const frame = { v: 1, type: 'chatPage', paneId: 'p1', items: fp.items, cursor: fp.cursor, done: fp.done }
  check(fp.items.length < 50 && fp.items.length >= 2 && !fp.done && Buffer.byteLength(JSON.stringify(frame)) <= FRAME_MAX, 'with 16KB messages the page stops before 50, under 48KB, done:false (' + fp.items.length + ' items, ' + Buffer.byteLength(JSON.stringify(frame)) + ' bytes)')

  // A single huge tool result still fits a frame (patch then text trimmed).
  const huge = { type: 'user', message: { content: [1, 2, 3, 4, 5, 6].map(n => ({ type: 'tool_result', tool_use_id: 't' + n, content: '"\\'.repeat(2000) })) }, toolUseResult: {} }
  const hugeMsg = api.decodeClaude(huge, 0)[0]
  const shrunk = api.shrinkMessage(hugeMsg, 20000)
  check(api.jsonBytes(shrunk) <= 20000 && shrunk.blocks.some(b => b.truncated), 'a message over the budget is shrunk and marked truncated')
  const patchHeavy = api.decodeClaude({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'e', content: 'ok' }] }, toolUseResult: { filePath: 'a.ts', structuredPatch: Array.from({ length: 40 }, (_, i) => ({ oldStart: i, oldLines: 1, newStart: i, newLines: 1, lines: Array.from({ length: 400 }, () => '+' + 'q'.repeat(60)) })) } }, 0)[0]
  const pf = path.join(tmp, 'patch.jsonl')
  fs.writeFileSync(pf, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'e', content: 'ok' }] }, toolUseResult: { filePath: 'a.ts', structuredPatch: Array.from({ length: 40 }, (_, i) => ({ oldStart: i, oldLines: 1, newStart: i, newLines: 1, lines: Array.from({ length: 400 }, () => '+' + 'q'.repeat(60)) })) } }) + '\n')
  const pp = await api.readPage(pf, api.decodeClaude, { before: null, paneId: 'p1' })
  check(api.jsonBytes(patchHeavy) > 1000000 && pp.items.length === 1 && Buffer.byteLength(JSON.stringify({ v: 1, type: 'chatPage', paneId: 'p1', items: pp.items, cursor: pp.cursor, done: pp.done })) <= FRAME_MAX && pp.items[0].blocks[0].truncated, 'a 1MB+ diff arrives trimmed inside one 48KB page')

  // 8MB scan cap.
  const sparse = path.join(tmp, 'sparse.jsonl')
  const filler = JSON.stringify({ type: 'file-history-snapshot', snapshot: 'f'.repeat(1000) })
  const fd = fs.openSync(sparse, 'w')
  fs.writeSync(fd, userLine('old prompt') + '\n')
  const block = (filler + '\n').repeat(1000)
  for (let i = 0; i < 9; i++) fs.writeSync(fd, block)
  fs.closeSync(fd)
  const sp = await api.readPage(sparse, api.decodeClaude, { before: null, paneId: 'p1' })
  check(sp.items.length === 0 && !sp.done && sp.cursor !== null && Number(sp.cursor) > 0 && fs.statSync(sparse).size - Number(sp.cursor) <= api.PAGE_SCAN_MAX + 2000, 'past 8MB scanned the page stops with done:false and the cursor where it got to')
  const sp2 = await api.readPage(sparse, api.decodeClaude, { before: Number(sp.cursor), paneId: 'p1' })
  check(sp2.items.length === 1 && sp2.items[0].blocks[0].text === 'old prompt' && sp2.done, 'the next page reaches the old prompt')

  // A record over 2MB, backwards and in the tail.
  const giant = path.join(tmp, 'giant.jsonl')
  fs.writeFileSync(giant, userLine('before') + '\n' + JSON.stringify({ type: 'user', message: { content: 'g'.repeat(api.MAX_RECORD_BYTES + 1) } }) + '\n' + asstLine('after') + '\n')
  const gp = await api.readPage(giant, api.decodeClaude, { before: null, paneId: 'p1' })
  check(gp.items.map(m => m.role + ':' + (m.blocks[0].text || '')).join('|') === 'user:before|system:' + api.CHAT_SKIPPED_TEXT + '|assistant:after', 'a record over 2MB becomes a "record skipped" row in a page')
  const ga = await api.readAppend(giant, 0, api.decodeClaude)
  check(ga.items.length === 3 && ga.items[1].blocks[0].text === api.CHAT_SKIPPED_TEXT && ga.next === fs.statSync(giant).size, 'and in the tail')

  // A partial line written in two steps.
  const part = path.join(tmp, 'part.jsonl')
  const line = asstLine('two steps')
  fs.writeFileSync(part, line.slice(0, 20))
  const a1 = await api.readAppend(part, 0, api.decodeClaude)
  const pg = await api.readPage(part, api.decodeClaude, { before: null, paneId: 'p1' })
  check(a1.items.length === 0 && a1.next === 0 && pg.items.length === 0 && pg.liveEnd === 0, 'half a line is never decoded and the tail stays before it')
  fs.appendFileSync(part, line.slice(20) + '\n')
  const a2 = await api.readAppend(part, 0, api.decodeClaude)
  check(a2.items.length === 1 && a2.items[0].blocks[0].text === 'two steps', 'once complete it arrives whole')

  // 50MB transcript: the first page is fast.
  const fifty = path.join(tmp, 'fifty.jsonl')
  const chunk = (Array.from({ length: 200 }, (_, i) => (i % 2 ? asstLine('reply ' + 'r'.repeat(400), i) : userLine('prompt ' + 'p'.repeat(400), i))).join('\n') + '\n')
  const wfd = fs.openSync(fifty, 'w')
  const reps = Math.ceil((50 * 1024 * 1024) / Buffer.byteLength(chunk))
  for (let i = 0; i < reps; i++) fs.writeSync(wfd, chunk)
  fs.closeSync(wfd)
  const t0 = process.hrtime.bigint()
  const fiftyPage = await api.readPage(fifty, api.decodeClaude, { before: null, paneId: 'p1' })
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  console.log(`  first page of a ${(fs.statSync(fifty).size / 1048576).toFixed(0)}MB transcript: ${ms.toFixed(1)} ms`)
  check(fiftyPage.items.length === 50 && ms < 1000, 'the first page of a 50MB transcript takes under 1s')
  fs.rmSync(fifty)

  // splitAppend keeps each frame under 48KB.
  const items = Array.from({ length: 12 }, (_, i) => ({ id: String(i), role: 'assistant', ts: null, blocks: [{ t: 'text', text: 'w'.repeat(16000) }] }))
  const frames = api.splitAppend('p1', items)
  check(frames.length >= 4 && frames.flat().length === 12 && frames.every(f => Buffer.byteLength(JSON.stringify({ v: 1, type: 'chatAppend', paneId: 'p1', items: f })) <= FRAME_MAX), 'an append of 12 x 16KB splits into frames of 48KB or less')
}

async function testWatcher() {
  const { api } = load()
  const file = path.join(tmp, 'watch.jsonl')
  fs.writeFileSync(file, userLine('first') + '\n')
  const appends = [], resets = []
  let onChange = null
  const w = new api.TranscriptWatcher({
    path: file, decode: api.decodeClaude, paneId: 'p1',
    onAppend: items => appends.push(items), onReset: page => resets.push(page),
    watchFile: (_p, cb) => { onChange = cb; return { close() {} } }, debounceMs: 20, pollMs: 60000,
  })
  w.start()
  let delivered = null
  const page = await w.firstPage(p => { delivered = p })
  check(page.items.length === 1 && delivered === page, 'the first page is delivered inside the serialized step')
  fs.appendFileSync(file, asstLine('second') + '\n')
  const t0 = Date.now()
  onChange()
  while (!appends.length && Date.now() - t0 < 2000) await new Promise(r => setTimeout(r, 10))
  const took = Date.now() - t0
  check(appends.length === 1 && appends[0][0].blocks[0].text === 'second' && took < 700, 'a written line arrives as an append in under 700ms (' + took + ' ms)')
  // A second reader's first page includes the line and no duplicate append follows.
  fs.appendFileSync(file, asstLine('third') + '\n')
  const second = await w.firstPage()
  check(second.items.length === 3 && appends.length === 2 && appends[1][0].blocks[0].text === 'third', 'a later first page hands the pending tail to the current readers first')
  await w.check()
  check(appends.length === 2, 'nothing is appended twice')
  // Truncation resets.
  fs.writeFileSync(file, userLine('after clear') + '\n')
  await w.check()
  check(resets.length === 1 && resets[0].items.length === 1 && resets[0].items[0].blocks[0].text === 'after clear', 'a truncated file sends a new first page')
  const before = await w.pageBefore(0)
  check(before.items.length === 0 && before.done, 'pageBefore(0) is empty')
  w.close()
  check(w.isClosed, 'close stops it')
}

// --- Locator --------------------------------------------------------------------------

async function testLocator() {
  const { api } = load()
  // The locator answers with fs.promises.realpath, which is the native
  // realpath: on Windows it expands 8.3 short names (C:\Users\RUNNER~1 on CI)
  // that the JS fs.realpathSync keeps, so expectations use the native one.
  const real = p => fs.realpathSync.native(p)
  check(api.claudeSlug('C:\\Users\\tarno\\Desktop\\Repo') === 'C--Users-tarno-Desktop-Repo', 'the slug matches the ~/.claude/projects folder names')
  const prev = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude')
  check(api.claudeConfigDir() === path.join(tmp, 'claude'), 'CLAUDE_CONFIG_DIR is respected')
  if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev

  const claudeRoot = path.join(tmp, 'claude')
  const codexRoot = path.join(tmp, 'codex', 'sessions')
  const repo = path.join(tmp, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  const slugDir = path.join(claudeRoot, 'projects', api.claudeSlug(repo))
  fs.mkdirSync(slugDir, { recursive: true })
  const hooked = path.join(slugDir, '0b7c2f4e-1a2b-4c3d-8e9f-0123456789ab.jsonl')
  fs.writeFileSync(hooked, userLine('hi') + '\n')

  const cfg = {
    presets: [{ id: 'pc', name: 'Claude', type: 'claude', command: 'claude' }],
    settings: { defaultShell: { win32: 'powershell.exe', linux: 'bash', darwin: 'zsh' } },
    workspaces: [
      { id: 'w1', name: 'W', cwd: repo, panes: [
        { id: 'a', type: 'claude', presetId: 'pc', title: 'A', color: '', icon: '' },
        { id: 'b', type: 'claude', presetId: 'pc', title: 'B', color: '', icon: '' },
        { id: 's', type: 'shell', title: 'S', color: '', icon: '' },
        { id: 'ssh', type: 'claude', presetId: 'pc', setupId: 'prof', title: 'SSH', color: '', icon: '' },
        { id: 'wsl', type: 'shell', command: 'wsl.exe -d Ubuntu', title: 'WSL', color: '', icon: '' },
        { id: 'cx', type: 'codex', title: 'Codex', color: '', icon: '' },
      ] },
    ],
  }
  let running = ['a']
  const status = {}
  const claims = new Map()
  const spawned = { a: Date.now() - 60000, b: Date.now() - 60000 }
  const loc = new api.TranscriptLocator({
    claudeRoot: () => claudeRoot, codexSessions: () => codexRoot, config: () => cfg,
    status: id => status[id] ?? null, spawnCwd: () => repo, spawnedAt: id => spawned[id], runningPanes: () => running,
    claims: () => claims, now: () => new Date(2026, 9, 19, 12, 0, 0),
  })
  // Hooks path.
  status.a = { provider: 'claude', sessionId: '0b7c2f4e-1a2b-4c3d-8e9f-0123456789ab', transcriptPath: hooked }
  let r = await loc.locate('a')
  check(r.ok && api.pathKey(r.path) === api.pathKey(real(hooked)), 'with hooks the reported path is used')
  // The root and the file may be spelled differently (an 8.3 TEMP on Windows,
  // /var vs /private/var on macOS): both resolve to the same admitted file.
  const projects = path.join(claudeRoot, 'projects')
  const viaReal = await api.admit(real(projects), hooked), viaRaw = await api.admit(projects, real(hooked))
  check(viaReal && viaRaw && api.pathKey(viaReal) === api.pathKey(viaRaw) && api.pathKey(viaRaw) === api.pathKey(r.path), 'a root and a path in different spellings of one folder still admit the same realpath')
  // A hooks path through a link that leaves the root is refused.
  const outside = path.join(tmp, 'outside')
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(outside, 'evil.jsonl'), userLine('secret') + '\n')
  const link = path.join(claudeRoot, 'projects', 'link')
  let linked = true
  try { fs.symlinkSync(outside, link, 'junction') } catch { linked = false }
  if (linked) {
    status.a = { provider: 'claude', sessionId: 'x', transcriptPath: path.join(link, 'evil.jsonl') }
    check((await api.admit(path.join(claudeRoot, 'projects'), path.join(link, 'evil.jsonl'))) === null, 'a link out of <claudeRoot>/projects is not admitted')
  }
  check((await api.admit(path.join(claudeRoot, 'projects'), path.join(slugDir, 'nope.txt'))) === null, 'only .jsonl files are admitted')

  // Without hooks: the one fresh file of the slug folder.
  status.a = { provider: 'claude', sessionId: '' }
  r = await loc.locate('a')
  check(r.ok && api.pathKey(r.path) === api.pathKey(real(hooked)), 'without hooks one console and one fresh file: assigned')
  // An old file does not count.
  const old = path.join(slugDir, 'old.jsonl')
  fs.writeFileSync(old, userLine('old') + '\n')
  spawned.a = Date.now() + 60000
  r = await loc.locate('a')
  check(!r.ok && r.reason === 'noTranscript', 'files created before the spawn (minus 5s) are not candidates')
  spawned.a = Date.now() - 60000
  r = await loc.locate('a')
  check(!r.ok && r.reason === 'ambiguous', 'two fresh files: ambiguous')
  claims.set(api.pathKey(real(old)), 'b')
  r = await loc.locate('a')
  check(r.ok && r.path.toLowerCase().endsWith('0b7c2f4e-1a2b-4c3d-8e9f-0123456789ab.jsonl'), 'a file another console holds is never reassigned')
  claims.clear()
  fs.rmSync(old)
  // A console without a live pty has no spawn time to date the files against.
  const spawnedA = spawned.a
  delete spawned.a
  r = await loc.locate('a')
  check(!r.ok && r.reason === 'noTranscript', 'without a live pty the folder match is refused (no old transcript passes for this console)')
  spawned.a = spawnedA
  // Two Claude consoles in the same folder.
  running = ['a', 'b']
  status.b = { provider: 'claude', sessionId: '' }
  const ra = await loc.locate('a'), rb = await loc.locate('b')
  check(!ra.ok && ra.reason === 'ambiguous' && !rb.ok && rb.reason === 'ambiguous', 'two Claude consoles in one folder without hooks: both ambiguous')
  running = ['a']
  // notLocal.
  check((await loc.locate('ssh')).reason === 'notLocal' && (await loc.locate('wsl')).reason === 'notLocal', 'a Connection Profile or WSL is notLocal')
  check((await loc.locate('s')).reason === 'noTranscript' && (await loc.locate('zz')).reason === 'noTranscript', 'a plain shell or an unknown pane has no transcript')
  // Codex.
  const day = path.join(codexRoot, '2026', '10', '18')
  fs.mkdirSync(day, { recursive: true })
  const rollout = path.join(day, 'rollout-2026-10-18T09-00-00-7c4390bf-8192-43a4-9f60-789abcdef012.jsonl')
  fs.copyFileSync(path.join(fixtures, 'codex-rollout.jsonl'), rollout)
  status.cx = { provider: 'codex', sessionId: '7c4390bf-8192-43a4-9f60-789abcdef012' }
  r = await loc.locate('cx')
  check(r.ok && r.provider === 'codex' && api.pathKey(r.path) === api.pathKey(real(rollout)), 'a Codex thread finds its rollout in yesterday\'s folder')
  status.cx = { provider: 'codex', sessionId: '' }
  check((await loc.locate('cx')).reason === 'noTranscript', 'a Codex console without a thread id has no chat yet')
  const older = path.join(codexRoot, '2026', '01', '02')
  fs.mkdirSync(older, { recursive: true })
  fs.copyFileSync(path.join(fixtures, 'codex-rollout.jsonl'), path.join(older, 'rollout-2026-01-02T09-00-00-11111111-2222-3333-4444-555555555555.jsonl'))
  status.cx = { provider: 'codex', sessionId: '11111111-2222-3333-4444-555555555555' }
  check((await loc.locate('cx')).ok, 'an older thread is found by walking the day folders')

  // Pending: the transcript of a new session is written with its first message.
  const fixedNow = new Date(2026, 9, 19, 12, 0, 0).getTime()
  const unborn = path.join(slugDir, '5f6a7b8c-1a2b-4c3d-8e9f-0123456789ab.jsonl')
  status.a = { provider: 'claude', sessionId: '5f6a7b8c-1a2b-4c3d-8e9f-0123456789ab', transcriptPath: unborn }
  r = await loc.locate('a')
  check(!r.ok && r.pending === true && r.reason === 'noTranscript', 'a reported transcript that is not written yet is pending (the chat opens empty)')
  status.a = { ...status.a, transcriptPath: path.join(claudeRoot, 'projects', 'C--brand-new-folder', 'x.jsonl') }
  check((await loc.locate('a')).pending === true, 'pending even when its project folder does not exist yet')
  check((await api.awaitable(projects, path.join(outside, 'new.jsonl'))) === false, 'a path outside the root is never awaited')
  if (linked) check((await api.awaitable(projects, path.join(link, 'new.jsonl'))) === false, 'a path through a link out of the root is never awaited')
  check((await api.awaitable(projects, hooked)) === false, 'an existing file is not awaited (it is admitted)')
  const spawnedA2 = spawned.a
  delete spawned.a
  status.a = { provider: 'claude', sessionId: '5f6a7b8c-1a2b-4c3d-8e9f-0123456789ab', transcriptPath: unborn }
  check(!(await loc.locate('a')).pending, 'without a live pty nothing is pending')
  spawned.a = spawnedA2
  status.cx = { provider: 'codex', sessionId: '99999999-8888-7777-6666-555555555555' }
  spawned.cx = fixedNow - 10 * 60000
  check((await loc.locate('cx')).pending === true, 'a Codex thread without its rollout yet is pending')
  delete status.cx
  spawned.cx = fixedNow - 1000
  check((await loc.locate('cx')).pending === true, 'an agent console that just spawned (no session reported yet) is pending')
  spawned.cx = fixedNow - api.PENDING_BOOT_MS - 1000
  r = await loc.locate('cx')
  check(!r.ok && !r.pending && r.reason === 'noTranscript', 'after the boot window without a session it is the plain notice again')
  delete spawned.cx
  check(!(await loc.locate('ssh')).pending && !(await loc.locate('s')).pending, 'notLocal and non-agent consoles are never pending')
  status.a = { provider: 'claude', sessionId: '' }
}

// --- v2.2.1: Codex without a thread id (bridge off, --no-daemon) and title-only ambiguity --

async function testCodexByCwd() {
  const { api } = load()
  const real = p => fs.realpathSync.native(p)
  const base = path.join(tmp, 'by-cwd')
  const codexRoot = path.join(base, 'codex', 'sessions')
  const repo = path.join(base, 'repo'), other = path.join(base, 'other')
  fs.mkdirSync(repo, { recursive: true }); fs.mkdirSync(other, { recursive: true })
  const today = path.join(codexRoot, '2026', '10', '19'), yesterday = path.join(codexRoot, '2026', '10', '18')
  const fixedNow = new Date(2026, 9, 19, 12, 0, 0).getTime()
  const cfg = {
    presets: [{ id: 'pc', name: 'Claude', type: 'claude', command: 'claude' }, { id: 'px', name: 'cdx', type: 'codex', command: 'cdx' }],
    settings: { defaultShell: { win32: 'powershell.exe', linux: 'bash', darwin: 'zsh' } },
    workspaces: [{ id: 'w', name: 'W', cwd: repo, panes: [
      { id: 'cx', type: 'codex', presetId: 'px', title: 'Codex', color: '', icon: '' },
      { id: 'cx2', type: 'codex', title: 'Codex 2', color: '', icon: '' },
      { id: 'ca', type: 'claude', presetId: 'pc', title: 'A', color: '', icon: '' },
      { id: 'cb', type: 'claude', presetId: 'pc', title: 'B', color: '', icon: '' },
    ] }],
  }
  let running = ['cx', 'ca']
  const status = {}, claims = new Map(), cwds = { cx: repo, cx2: repo, ca: repo, cb: repo }
  const spawned = { cx: Date.now() - 1000, ca: Date.now() - 1000, cb: Date.now() - 1000 }
  const loc = new api.TranscriptLocator({
    claudeRoot: () => path.join(base, 'claude'), codexSessions: () => codexRoot, config: () => cfg,
    status: id => status[id] ?? null, spawnCwd: id => cwds[id], spawnedAt: id => spawned[id], runningPanes: () => running,
    claims: () => claims, now: () => new Date(fixedNow),
  })
  let n = 0
  const rollout = (dir, cwd, extra = {}, pad = 0) => {
    fs.mkdirSync(dir, { recursive: true })
    const id = `01a1595b-9b51-7ee2-ad61-${String(++n).padStart(12, '0')}`
    const p = path.join(dir, `rollout-2026-10-19T11-00-0${n % 10}-${id}.jsonl`)
    const meta = { timestamp: '2026-10-19T14:00:00.000Z', type: 'session_meta', payload: { id, session_id: id, cwd, originator: 'codex-tui', cli_version: '0.163.0', source: 'cli', base_instructions: { text: 'x'.repeat(pad) }, ...extra } }
    fs.writeFileSync(p, JSON.stringify(meta) + '\n' + JSON.stringify({ timestamp: '2026-10-19T14:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hola' }] } }) + '\n')
    return p
  }
  const reset = () => fs.rmSync(codexRoot, { recursive: true, force: true })

  const mine = rollout(today, repo)
  let r = await loc.locate('cx')
  check(r.ok && r.provider === 'codex' && api.pathKey(r.path) === api.pathKey(real(mine)), 'no thread id and no status: the one fresh rollout of the console\'s folder is its chat')
  status.cx = { provider: 'codex', sessionId: '' }
  r = await loc.locate('cx')
  check(r.ok && api.pathKey(r.path) === api.pathKey(real(mine)), 'a title-only Codex track (no session id) goes to the folder match too')
  check(api.pathKey((await api.codexSessionMeta(mine)).cwd) === api.pathKey(repo), 'the session_meta payload is read from the first line')
  reset(); const prev = rollout(yesterday, repo.toUpperCase() + path.sep)
  r = await loc.locate('cx')
  check(process.platform !== 'win32' || (r.ok && api.pathKey(r.path) === api.pathKey(real(prev))), 'yesterday\'s folder counts, and the folder compares like a cwd (case, trailing separator)')

  reset(); rollout(today, other)
  r = await loc.locate('cx')
  check(!r.ok && r.reason === 'noTranscript' && r.pending === true, 'a rollout of another folder is not a match (pending while it boots)')
  rollout(today, repo); rollout(today, repo)
  r = await loc.locate('cx')
  check(!r.ok && r.reason === 'ambiguous', 'two matching rollouts: ambiguous')
  reset(); const tui = rollout(today, repo); rollout(today, repo, { source: 'vscode', originator: 'Codex Desktop' })
  r = await loc.locate('cx')
  check(r.ok && api.pathKey(r.path) === api.pathKey(real(tui)), 'between the TUI rollout and a Codex Desktop one, the TUI one is the console\'s')
  reset(); rollout(today, repo, { source: 'exec' }); rollout(today, repo, { source: { subagent: { thread_spawn: { parent_thread_id: 'x', depth: 1 } } } }); rollout(today, repo, { source: 'mcp' })
  r = await loc.locate('cx')
  check(!r.ok && r.reason === 'noTranscript', 'a codex exec, an MCP run or a subagent in the folder never passes for the console')
  reset(); rollout(today, repo, {}, 70 * 1024)
  r = await loc.locate('cx')
  check(!r.ok && r.reason === 'noTranscript', 'a first line over 64KB is not read')
  reset(); const held = rollout(today, repo)
  claims.set(api.pathKey(real(held)), 'cx2')
  r = await loc.locate('cx')
  check(!r.ok && r.reason === 'noTranscript', 'a rollout another console holds is skipped')
  claims.set(api.pathKey(real(held)), 'cx')
  check((await loc.locate('cx')).ok, 'its own claim does not hide it')
  claims.clear()
  spawned.cx = Date.now() + 60000
  r = await loc.locate('cx')
  check(!r.ok && r.reason === 'noTranscript', 'a rollout created before the spawn (minus 5s) is not a candidate')
  spawned.cx = Date.now() - 1000
  running = ['cx', 'cx2', 'ca']
  r = await loc.locate('cx')
  check(!r.ok && r.reason === 'ambiguous' && r.pending === true, 'another Codex console in the folder: ambiguous, pending while a title-only track boots')
  spawned.cx = fixedNow - api.PENDING_BOOT_MS - 1000
  r = await loc.locate('cx')
  check(!r.ok && r.reason === 'ambiguous' && !r.pending, 'past the boot window the peer is the plain ambiguous notice')
  delete status.cx; spawned.cx = Date.now() - 1000
  r = await loc.locate('cx')
  check(!r.ok && r.reason === 'ambiguous' && !r.pending, 'with no track at all, ambiguous stays ambiguous')
  running = ['cx', 'ca']
  delete spawned.cx
  check((await loc.locate('cx')).reason === 'noTranscript', 'without a live pty the folder match is refused')
  spawned.cx = Date.now() - 1000

  // The orPending rule shared with Claude (bug 8): a title-only track whose folder another Claude console shares.
  running = ['ca', 'cb']
  status.ca = { provider: 'claude', sessionId: '' }
  r = await loc.locate('ca')
  check(!r.ok && r.reason === 'ambiguous' && r.pending === true, 'a title-only Claude track sharing its folder is pending while it boots, not the notice')
  spawned.ca = fixedNow - api.PENDING_BOOT_MS - 1000
  r = await loc.locate('ca')
  check(!r.ok && r.reason === 'ambiguous' && !r.pending, 'past PENDING_BOOT_MS it is the ambiguous notice again')
  spawned.ca = Date.now() - 1000
  delete status.ca
  r = await loc.locate('ca')
  check(!r.ok && r.reason === 'ambiguous' && !r.pending, 'with no status at all it stays ambiguous')
  status.ca = { provider: 'claude', sessionId: '0b7c2f4e-1a2b-4c3d-8e9f-0123456789ab' }
  r = await loc.locate('ca')
  check(!r.ok && r.reason === 'ambiguous' && !r.pending, 'a reported session never turns ambiguous into pending')
}

// --- Pending transcripts: empty first page, then the real one -------------------------

async function testHubPending() {
  const { api, advance } = load(true)
  const file = path.join(tmp, 'pending.jsonl')
  fs.rmSync(file, { force: true })
  let result = { ok: false, reason: 'noTranscript', pending: true }
  const watchers = []
  const hub = new api.ChatHub({
    locate: async () => result,
    createWatcher: deps => { const w = new api.TranscriptWatcher({ ...deps, watchFile: () => ({ close() {} }), pollMs: 60000 }); watchers.push(w); return w },
  })
  const got = []
  hub.sub({}, 'p1', f => got.push(f))
  await until(() => got.length > 0)
  check(got[0].type === 'chatPage' && got[0].items.length === 0 && got[0].done && api.chatNoticeOf(got[0].items) === null, 'a pending transcript answers an empty first page, not the notice (the phone stays in Chat)')
  check(hub.openWatchers === 0, 'nothing is watched yet')
  advance(api.CHAT_PENDING_POLL_MS)
  await settle()
  check(got.length === 1, 'a poll that still finds nothing sends nothing')
  // The first message writes the file: the next poll opens it.
  fs.writeFileSync(file, userLine('primer mensaje') + '\n')
  result = { ok: true, path: file, provider: 'claude' }
  advance(api.CHAT_PENDING_POLL_MS)
  await until(() => got.length > 1)
  check(got.at(-1).type === 'chatPage' && got.at(-1).items.length === 1 && got.at(-1).items[0].blocks[0].text === 'primer mensaje', 'when the file appears the reader gets its first page')
  fs.appendFileSync(file, asstLine('respuesta') + '\n')
  await watchers.at(-1).check()
  await settle()
  check(got.at(-1).type === 'chatAppend' && got.at(-1).items[0].blocks[0].text === 'respuesta', 'and then its appends')
  // /clear: a new session whose file is not written yet empties the chat.
  result = { ok: false, reason: 'noTranscript', pending: true }
  let n = got.length
  hub.transcriptChanged('p1')
  await until(() => got.length > n)
  check(got.at(-1).type === 'chatPage' && got.at(-1).items.length === 0 && api.chatNoticeOf(got.at(-1).items) === null && hub.openWatchers === 0, 'a new session not written yet empties the chat instead of sending the notice')
  // A transcript that never comes gives up with the notice.
  n = got.length
  for (let i = 0; i < 700 && got.length === n; i++) { advance(api.CHAT_PENDING_POLL_MS); await settle(3) }
  check(got.length === n + 1 && api.chatNoticeOf(got.at(-1).items) === 'noTranscript', 'after 10 minutes the wait ends with the notice')
  const after = got.length
  advance(api.CHAT_PENDING_POLL_MS * 5)
  await settle()
  check(got.length === after, 'and the polling stops')
  // No reader, no polling.
  result = { ok: false, reason: 'noTranscript', pending: true }
  const got2 = []
  const owner = {}
  hub.sub(owner, 'p2', f => got2.push(f))
  await until(() => got2.length > 0)
  let calls = 0
  hub.deps.locate = async () => { calls++; return result }
  hub.unsub(owner, 'p2')
  advance(api.CHAT_PENDING_POLL_MS * 3)
  await settle()
  check(calls === 0, 'a pending chat nobody reads is not polled')
  hub.dispose()
}

// --- ChatHub through RemoteManager + SessionManager ------------------------------------

const snapshot = {
  workspaces: [{ id: 'w1', name: 'One', layoutOrder: ['p1', 'p2'], panes: [
    { id: 'p1', title: 'A', type: 'claude', color: '', icon: '', running: true },
    { id: 'p2', title: 'B', type: 'claude', color: '', icon: '', running: true },
  ] }],
  activeWorkspaceId: 'w1', themeTokens: {}, language: 'en', fontFamily: '', fontSize: 14,
}

function world(locateImpl) {
  for (const f of fs.readdirSync(dataDir)) fs.rmSync(path.join(dataDir, f), { recursive: true, force: true })
  const { api, advance } = load(true)
  const sizes = new Map([['p1', { cols: 120, rows: 40 }], ['p2', { cols: 100, rows: 30 }]])
  let sink = null
  const pty = {
    addSink(s) { sink = s }, removeSink() { sink = null }, setRunningChangeListener() {}, setForcedFast() {},
    runningPaneIds: () => [...sizes.keys()], exitedPaneCodes: () => new Map(),
    getReplay: id => sizes.has(id) ? { ptyId: 'pty-' + id, replay: 'R:' + id, ...sizes.get(id) } : null,
    getExited: () => null, ptyIdForPane: id => sizes.has(id) ? 'pty-' + id : null,
    sizeOf: id => sizes.has(id) ? { ...sizes.get(id) } : null, write() {},
    data(id, d) { sink && sink.onData('pty-' + id, id, d) },
    resizePane(id, cols, rows) { const c = sizes.get(id); if (!c || (c.cols === cols && c.rows === rows)) return; sizes.set(id, { cols, rows }); sink && sink.onResize('pty-' + id, id, cols, rows) },
  }
  const commands = []
  const webContents = {
    isDestroyed: () => false, setBackgroundThrottling() {},
    send: (ch, cmd) => {
      if (ch !== 'remote:controlCmd') return
      commands.push(cmd)
      if (cmd.action.kind === 'fitPane') pty.resizePane(cmd.action.paneId, cmd.action.cols, cmd.action.rows)
      queueMicrotask(() => manager.onControlResult({ id: cmd.id, ok: true }))
    },
  }
  const manager = new api.RemoteManager(pty, () => webContents, '2.0.0', () => [], () => 'PC')
  const watchers = []
  const hub = new api.ChatHub({
    locate: locateImpl,
    createWatcher: deps => { const w = new api.TranscriptWatcher({ ...deps, watchFile: () => ({ close() {} }) }); watchers.push(w); return w },
  })
  manager.setChat(hub)
  manager.applyConfig({ enabled: true, port: 4600, phoneFit: true })
  manager.pushState(snapshot)
  class FakeSocket {
    constructor() { this.readyState = 1; this.bufferedAmount = 0; this.inbox = []; this.handlers = {} }
    on(ev, fn) { this.handlers[ev] = fn }
    send(data) { this.inbox.push(JSON.parse(data)) }
    close() { this.readyState = 3; this.handlers.close && this.handlers.close() }
    terminate() { this.close() }
    msg(obj) { this.handlers.message(JSON.stringify({ v: 1, ...obj })) }
    of(type) { return this.inbox.filter(m => m.type === type) }
  }
  async function pair() {
    await tick()
    const payload = await manager.pairingBegin()
    const ws = new FakeSocket()
    globalThisCtx(api).__server.handlers.onSocket(ws, '100.64.0.9', '100.64.0.9')
    ws.msg({ type: 'hello', clientNonce: 'aa'.repeat(32) })
    ws.msg({ type: 'pair', code: payload.code, deviceName: 'Phone' })
    manager.pairingResolve(manager.getUiState().pendingPairing.requestId, true)
    return ws
  }
  return { api, manager, hub, pty, sizes, commands, watchers, advance, pair }
}
// The bundle's globalThis is its vm context; the stub RemoteServer parks its handlers there.
let lastCtx = null
function globalThisCtx() { return lastCtx }

async function testHub() {
  const file = path.join(tmp, 'hub.jsonl')
  fs.copyFileSync(path.join(fixtures, 'claude-session.jsonl'), file)
  const located = []
  const w = world(async paneId => { located.push(paneId); return paneId === 'p1' ? { ok: true, path: file, provider: 'claude' } : { ok: false, reason: 'ambiguous' } })
  const ws = await w.pair()
  check(w.watchers.length === 0 && located.length === 0, 'without a chatSub no watcher opens and nothing is located (FR-35)')

  // Terminal first, phone mode on.
  ws.msg({ type: 'sub', paneId: 'p1' })
  ws.msg({ type: 'ctl', id: 'f1', action: { kind: 'fitPane', workspaceId: 'w1', paneId: 'p1', cols: 50, rows: 40 } })
  await tick(); w.advance(w.api.FIT_COALESCE_MS); await settle()
  check(w.manager.fit.stateOf('p1').state === 'phone', 'the phone owns the pane')

  // FR-25: unsub, then chatSub.
  ws.msg({ type: 'unsub', paneId: 'p1' })
  ws.msg({ type: 'chatSub', paneId: 'p1' })
  await until(() => ws.of('chatPage').length > 0)
  const page = ws.of('chatPage').at(-1)
  check(page && page.paneId === 'p1' && page.items.length === 19 && page.done && page.cursor === null, 'chatSub answers a first chatPage with the decoded transcript')
  check(ws.inbox.filter(m => m.type === 'chatPage' || m.type === 'chatAppend').every(m => Buffer.byteLength(JSON.stringify(m)) <= FRAME_MAX), 'every chat frame is 48KB or less')
  const st = w.manager.fit.stateOf('p1')
  check(st.state === 'phone' && st.chat === true && w.commands.filter(c => c.action.kind === 'fitPane').at(-1).fit.chat === true, 'the owner in Chat stays the owner and the desktop strip hears "(Chat)" (FR-21)')
  // No out while in Chat.
  const outs = ws.of('out').length
  w.pty.data('p1', 'hello from the pty')
  w.advance(50)
  check(ws.of('out').length === outs, 'in Chat the xterm stream to that socket is paused (no out frames)')
  // Ten minutes in Chat: no grace, no held, no restore.
  for (let i = 0; i < 30; i++) { ws.msg({ type: 'ping', t: 1 }); w.advance(20000) }
  await settle()
  check(w.manager.fit.stateOf('p1').state === 'phone' && !w.commands.some(c => c.action.kind === 'releaseFit'), 'ten minutes in Chat start no timer')

  // Appends.
  fs.appendFileSync(file, asstLine('live line') + '\n')
  await w.watchers[0].check()
  await settle()
  const app = ws.of('chatAppend').at(-1)
  check(app && app.items.length === 1 && app.items[0].blocks[0].text === 'live line', 'a new line reaches the phone as chatAppend')
  // chatMore.
  ws.msg({ type: 'chatMore', paneId: 'p1', before: '300' })
  await until(() => ws.of('chatPage').length > 1)
  const more = ws.of('chatPage').at(-1)
  check(more !== page && more.items.length === 1 && more.items[0].role === 'user' && more.done, 'chatMore answers the page before the cursor, aligned to whole lines')
  // A chatMore for a pane not read as Chat is ignored.
  const pages = ws.of('chatPage').length
  ws.msg({ type: 'chatMore', paneId: 'p2', before: '10' })
  await settle()
  check(ws.of('chatPage').length === pages, 'chatMore for a pane without chatSub is ignored')
  // Truncation: a new first page.
  fs.writeFileSync(file, userLine('after /clear') + '\n')
  await w.watchers[0].check()
  await settle()
  check(ws.of('chatPage').at(-1).items.length === 1 && ws.of('chatPage').at(-1).items[0].blocks[0].text === 'after /clear', 'a truncated transcript sends a new chatPage (the phone replaces its list)')

  // Notice for a pane without a chat (FR-33).
  ws.msg({ type: 'chatSub', paneId: 'p2' })
  await until(() => ws.of('chatPage').some(m => m.paneId === 'p2'))
  const notice = ws.of('chatPage').filter(m => m.paneId === 'p2').at(-1)
  check(notice && w.api.chatNoticeOf(notice.items) === 'ambiguous' && notice.done && notice.cursor === null, 'no assignable transcript answers the ambiguous notice')
  ws.msg({ type: 'chatUnsub', paneId: 'p2' })

  // The assignment changes (a resume): new first page; lost: the notice.
  const other = path.join(tmp, 'hub2.jsonl')
  fs.writeFileSync(other, asstLine('resumed session') + '\n')
  let target = { ok: true, path: other, provider: 'claude' }
  w.hub.deps.locate = async () => target
  let n = ws.of('chatPage').length
  w.hub.transcriptChanged('p1')
  await until(() => ws.of('chatPage').length > n)
  check(ws.of('chatPage').at(-1).items[0].blocks[0].text === 'resumed session', 'another session for the pane sends its first page')
  target = { ok: false, reason: 'noTranscript' }
  n = ws.of('chatPage').length
  w.hub.transcriptChanged('p1')
  await until(() => ws.of('chatPage').length > n)
  check(w.api.chatNoticeOf(ws.of('chatPage').at(-1).items) === 'noTranscript', 'a lost assignment sends the notice')
  target = { ok: true, path: other, provider: 'claude' }
  n = ws.of('chatPage').length
  w.hub.transcriptChanged('p1')
  await until(() => ws.of('chatPage').length > n)

  // Back to Terminal: chatUnsub + sub keeps the owner, chat flag off.
  ws.msg({ type: 'chatUnsub', paneId: 'p1' })
  ws.msg({ type: 'sub', paneId: 'p1' })
  await settle()
  w.advance(1000)
  await settle()
  const back = w.manager.fit.stateOf('p1')
  check(back.state === 'phone' && back.chat === false && ws.of('replay').at(-1).paneId === 'p1', 'back to Terminal the owner stays, without "(Chat)", and the replay repaints')
  // Chat again, then chatUnsub without a sub: released after the grace (v2.2.1).
  n = ws.of('chatPage').length
  ws.msg({ type: 'unsub', paneId: 'p1' })
  ws.msg({ type: 'chatSub', paneId: 'p1' })
  await until(() => ws.of('chatPage').length > n)
  ws.msg({ type: 'chatUnsub', paneId: 'p1' })
  w.advance(w.api.FIT_GRACE_MS)
  await settle()
  check(w.manager.fit.stateOf('p1') === null && w.manager.fit.ownerOf('p1') === 'desktop', 'chatUnsub without a sub within 250ms gives the size back to the PC')

  // The watcher closes 30s after its last reader.
  const open = w.hub.openWatchers
  w.advance(w.api.CHAT_CLOSE_DELAY_MS - w.api.FIT_GRACE_MS - 10)
  check(w.hub.openWatchers === open && open >= 1, 'the watcher stays open for 30s after the last chatUnsub')
  w.advance(20)
  check(w.hub.openWatchers === 0, 'then it closes')

  // A closed socket ends its chats.
  n = ws.of('chatPage').length
  ws.msg({ type: 'chatSub', paneId: 'p1' })
  await until(() => ws.of('chatPage').length > n)
  check(w.hub.openWatchers === 1, 'a chatSub opens it again')
  ws.close()
  w.advance(w.api.CHAT_CLOSE_DELAY_MS + 10)
  check(w.hub.openWatchers === 0, 'a closed socket releases its chats')
}

async function testWatcherCap() {
  const files = Array.from({ length: 6 }, (_, i) => { const f = path.join(tmp, `cap${i}.jsonl`); fs.writeFileSync(f, userLine('c' + i) + '\n'); return f })
  const { api } = load()
  const hub = new api.ChatHub({
    locate: async id => ({ ok: true, path: files[Number(id.slice(1))], provider: 'claude' }),
    createWatcher: deps => new api.TranscriptWatcher({ ...deps, watchFile: () => ({ close() {} }), pollMs: 60000 }),
  })
  const got = []
  for (let i = 0; i < 6; i++) { hub.sub({ n: i }, 'x' + i, f => got.push(f)); await until(() => got.length > i) }
  check(got.filter(f => f.type === 'chatPage').length === 6 && hub.openWatchers === 4, 'six chats keep at most 4 watchers open (LRU)')
  hub.dispose()
  check(hub.openWatchers === 0, 'dispose closes them all')
}

async function testHubRaces() {
  const file = path.join(tmp, 'race.jsonl')
  fs.writeFileSync(file, userLine('race') + '\n')
  const { api } = load()
  const gates = []
  const hub = new api.ChatHub({
    locate: () => new Promise(res => gates.push(() => res({ ok: true, path: file, provider: 'claude' }))),
    createWatcher: deps => new api.TranscriptWatcher({ ...deps, watchFile: () => ({ close() {} }), pollMs: 60000 }),
  })
  const reader = {}
  const got = []
  hub.sub(reader, 'p', f => got.push(f))
  // The hooks report a session while the chatSub is still locating: the
  // re-locate supersedes it and the first answer must come from it.
  hub.transcriptChanged('p')
  gates[0]()
  await settle()
  check(got.length === 0, 'a chatSub whose locate was superseded waits for the re-locate instead of answering "no chat"')
  gates[1]()
  await until(() => got.length > 0)
  await settle()
  check(got.every(f => f.type === 'chatPage' && api.chatNoticeOf(f.items) === null && f.items.length === 1), 'and then it gets the first page')
  // One chatMore at a time per reader: a repeat while one scans is dropped.
  const mores = []
  hub.more(reader, 'p', 0, f => mores.push(f))
  hub.more(reader, 'p', 0, f => mores.push(f))
  await until(() => mores.length > 0)
  await settle()
  check(mores.length === 1, 'a second chatMore while one is in flight is dropped')
  hub.more(reader, 'p', 0, f => mores.push(f))
  await until(() => mores.length > 1)
  check(mores.length === 2, 'the next chatMore after the answer is served')
  hub.dispose()
}

async function testChatSubCap() {
  const w = world(async () => ({ ok: false, reason: 'ambiguous' }))
  const ws = await w.pair()
  const max = w.api.MAX_CHAT_SUBS
  for (let i = 0; i <= max; i++) ws.msg({ type: 'chatSub', paneId: 'q' + i })
  await until(() => ws.of('chatPage').length > max)
  const codes = ws.of('chatPage').map(p => p.paneId + ':' + w.api.chatNoticeOf(p.items))
  check(codes.filter(c => c.endsWith(':ambiguous')).length === max && codes.includes(`q${max}:noTranscript`), 'past ' + max + ' chats per session a chatSub is refused with the notice, not registered: ' + codes.join(','))
  ws.msg({ type: 'chatUnsub', paneId: 'q0' })
  ws.msg({ type: 'chatSub', paneId: 'q' + max })
  await until(() => ws.of('chatPage').length > max + 1)
  check(w.api.chatNoticeOf(ws.of('chatPage').at(-1).items) === 'ambiguous', 'after a chatUnsub there is room again')
  ws.close()
}

// --- The phone's saved view (src/mobile/src/lib/chatView.ts) -----------------------------
// The list and row model (chatModel.ts over src/shared/chatRows.ts) is in test-chat-rows.cjs.

async function testMobileModel() {
  const r = await build({
    stdin: { resolveDir: root, loader: 'ts', contents: `export { resolvePaneView, chatEligible } from './src/mobile/src/lib/chatView'` },
    bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@shared': path.join(root, 'src/shared') },
  })
  const mod = { exports: {} }
  vm.runInNewContext(r.outputFiles[0].text, { module: mod, exports: mod.exports, console })
  const m = mod.exports
  check(m.resolvePaneView(undefined, false, true) === 'terminal' && m.resolvePaneView(undefined, true, true) === 'chat' && m.resolvePaneView('chat', false, false) === 'terminal' && m.resolvePaneView('terminal', true, true) === 'terminal', 'Chat only for an eligible console: saved choice, then chatDefault')
  check(m.chatEligible({ provider: 'claude' }) && m.chatEligible({ provider: 'codex' }) && !m.chatEligible({}) && !m.chatEligible(null), 'eligible = status provider claude or codex')
  // v2.2.1: a Claude or Codex console whose status names no provider is eligible by type.
  check(m.chatEligible(null, 'codex') && m.chatEligible({}, 'claude') && m.chatEligible(undefined, 'claude'), 'no provider in the status: a claude or codex pane type is eligible')
  check(!m.chatEligible({}, 'shell') && !m.chatEligible(null, 'custom') && !m.chatEligible(null) && m.chatEligible({ provider: 'codex' }, 'shell'), 'a shell needs its status to name the agent; a status provider wins over the type')
  check(m.resolvePaneView(undefined, true, true, true) === 'terminal' && m.resolvePaneView(undefined, true, true, false) === 'chat' && m.resolvePaneView('chat', true, true, true) === 'terminal', 'a chat refused on this open (FR-33) shows Terminal, even over chatDefault or a saved Chat')
}

async function main() {
  code = await build({
    stdin: { resolveDir: root, loader: 'ts', contents: entry },
    bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron', 'ws', 'qrcode'],
    plugins: [stubs], alias: { '@shared': path.join(root, 'src/shared') },
  }).then(r => r.outputFiles[0].text)
  // Keep the vm context of each load reachable for the stub server handlers.
  const runInNewContext = vm.runInNewContext
  vm.runInNewContext = (src, ctx) => { lastCtx = ctx; return runInNewContext(src, ctx) }
  testSchemas()
  testDecodeClaude()
  testDecodeCodex()
  testToolSummary()
  await testPages()
  await testWatcher()
  await testLocator()
  await testCodexByCwd()
  await testHub()
  await testHubPending()
  await testWatcherCap()
  await testHubRaces()
  await testChatSubCap()
  await testMobileModel()
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`PASS: ${checks} chat checks (schemas, Claude and Codex decoders, tool summaries, pages under 48KB, 8MB scan cap, 50MB first page, tail, locator, pending transcripts, ChatHub with phone-fit presence)`)
}

main().catch(error => { console.error(error); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(1) })
