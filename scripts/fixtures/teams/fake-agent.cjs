// Fake agent of the Teams suites (app 2.7.0, E10 B2, design 9.2): plays a scenario in place of
// `claude -p` or `codex exec`. No network, no real agent. The scenario path is argv[2] (the test's
// resolveCli override puts it there, decision 61: never env); the real Claude or Codex argv follows.
// It reads all of stdin first (saved to `saveStdin` when set), learns the session from
// `--session-id` / `--resume` / `exec resume <thread>`, then runs the steps in order:
//   { fixture, from?, to?, rewriteSession?, delayMs? }   sanitized spike lines of this folder
//   { emit: <object or string> }  { stderr: "text" }      one stdout / stderr line
//   { emitBig: { fixture, type, path, bytes, rewriteSession? } }  the last line of `type` in the
//       fixture with the string at `path` padded to `bytes` (a giant `result` line)
//   { echoArgv: true }  { echoEnv: ["NAME", ...] }        what the run got (TOKEN vars: presence only)
//   { cli: [...args], stdin?, bin? }                      the real CLI with the run env
//   { spawnChild: { holdStdout?, detached?, ms } }        a grandchild (drain, tree kill, orphan); only a
//       detached one outlives the agent on Windows (libuv puts children in a kill-on-close job)
//   { sleepMs: n }  { hang: true }  { writeFile: { path, text } }  { exit: n }
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const scenarioPath = process.argv[2]
const argv = process.argv.slice(3)
const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'))

function sessionOf(args) {
  const i = args.indexOf('--session-id')
  if (i >= 0) return args[i + 1]
  const r = args.indexOf('--resume')
  if (r >= 0) return args[r + 1]
  const e = args.indexOf('exec')
  if (e >= 0 && args[e + 1] === 'resume') return args[e + 2]
  return null
}
const session = sessionOf(argv) || scenario.sessionId || '019a0000-0000-7000-8000-000000000001'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** One stdout line, written before the next step runs (the callback keeps the order through the pipe). */
const out = (line) => new Promise((resolve) => process.stdout.write(line + '\n', () => resolve()))
const err = (line) => new Promise((resolve) => process.stderr.write(line + '\n', () => resolve()))

function rewrite(obj) {
  if (obj && typeof obj === 'object') {
    if (typeof obj.session_id === 'string') obj.session_id = session
    if (typeof obj.thread_id === 'string') obj.thread_id = session
  }
  return obj
}

function fixtureLines(name) {
  return fs.readFileSync(path.join(__dirname, name), 'utf8').split('\n').filter((l) => l.trim() !== '')
}

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

async function step(s) {
  if (s.fixture) {
    const lines = fixtureLines(s.fixture).slice(s.from ?? 0, s.to ?? undefined)
    for (const l of lines) {
      if (s.delayMs) await sleep(s.delayMs)
      await out(s.rewriteSession ? JSON.stringify(rewrite(JSON.parse(l))) : l)
    }
  } else if ('emit' in s) {
    await out(typeof s.emit === 'string' ? s.emit : JSON.stringify(s.rewriteSession ? rewrite(s.emit) : s.emit))
  } else if (s.emitBig) {
    const b = s.emitBig
    const base = fixtureLines(b.fixture).map((l) => JSON.parse(l)).filter((o) => o.type === b.type).pop()
    let at = base
    for (const k of b.path.slice(0, -1)) at = at[k]
    at[b.path[b.path.length - 1]] = 'x'.repeat(b.bytes)
    await out(JSON.stringify(b.rewriteSession ? rewrite(base) : base))
  } else if ('stderr' in s) {
    await err(s.stderr)
  } else if (s.echoArgv) {
    await out(JSON.stringify({ type: 'fake.argv', argv, cwd: process.cwd() }))
  } else if (s.echoEnv) {
    const env = {}
    for (const name of s.echoEnv) {
      const key = Object.keys(process.env).find((k) => k.toUpperCase() === name.toUpperCase())
      const v = key ? process.env[key] : undefined
      env[name] = /TOKEN/i.test(name) ? v !== undefined : v === undefined ? null : v
    }
    await out(JSON.stringify({ type: 'fake.env', env }))
  } else if (s.cli) {
    const r = s.bin
      ? spawnSync(process.execPath, [s.bin, ...s.cli], { env: process.env, input: s.stdin ?? '', encoding: 'utf8', windowsHide: true })
      : spawnSync(process.env.SNAOS_CLI, s.cli, { env: process.env, input: s.stdin ?? '', encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' })
    await out(JSON.stringify({ type: 'fake.cli', code: r.status, stdout: r.stdout, stderr: r.stderr }))
  } else if (s.spawnChild) {
    const c = s.spawnChild
    const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${Number(c.ms) || 60000})`], {
      stdio: c.holdStdout ? ['ignore', 'inherit', 'inherit'] : 'ignore',
      detached: !!c.detached,
      windowsHide: true,
    })
    if (c.detached) child.unref()
    await out(JSON.stringify({ type: 'fake.child', pid: child.pid }))
  } else if (s.sleepMs) {
    await sleep(s.sleepMs)
  } else if (s.hang) {
    setInterval(() => undefined, 1 << 30)
    await new Promise(() => undefined)
  } else if (s.writeFile) {
    fs.writeFileSync(s.writeFile.path, s.writeFile.text)
  } else if ('exit' in s) {
    process.exit(s.exit)
  }
}

async function main() {
  const stdin = await readStdin()
  if (scenario.saveStdin) fs.writeFileSync(scenario.saveStdin, stdin)
  for (const s of scenario.steps ?? []) await step(s)
  process.exit(scenario.exitCode ?? 0)
}

main().catch((e) => {
  process.stderr.write(String(e && e.stack ? e.stack : e) + '\n')
  process.exit(70)
})
