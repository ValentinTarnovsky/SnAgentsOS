/**
 * The `snaos` binary (E8-FR-14..21): out/main/cli.js, run by the shim with
 * ELECTRON_RUN_AS_NODE. Node core only (no Electron, no npm module): argument
 * parsing, `--file` / `--prompt-file` / stdin read here (main never opens a
 * path that came from the CLI), the HTTP client over the pipe or socket,
 * human or `--json` output and the exit codes. Output is English on purpose.
 */
import { readFileSync } from 'fs'
import { request } from 'http'
import { homedir } from 'os'
import { posix, resolve, win32 } from 'path'
import { CLI_ENV } from '@shared/brand'
import {
  CTL_EXIT,
  CTL_MAX_PROMPT,
  CTL_MAX_SEND,
  CTL_RPC_PATH,
  type CtlConsoleInfo,
  type CtlErrorCode,
  type CtlMethod,
  type CtlResponse,
  type CtlWorkspaceInfo,
  type SnaosRuntimeFile,
} from '@shared/ctl-protocol'
import { agentGuide } from './agentGuide'

declare const __SNAOS_APP_VERSION__: string | undefined

const PRODUCT = 'SnAgentsOS'
const NOT_RUNNING = `${PRODUCT} is not running`

/** Flags that take a value (`--flag v` or `--flag=v`). Short aliases map to these. */
const VALUE_FLAGS = new Set(['workspace', 'console', 'path', 'prompt', 'prompt-file', 'title', 'file', 'lines', 'timeout', 'quiet-ms', 'task-state', 'runtime'])
const BOOL_FLAGS = new Set(['json', 'focus', 'no-profile', 'enter', 'clear', 'local', 'idle', 'agent', 'help'])
const ALIASES: Record<string, string> = { w: 'workspace', c: 'console', n: 'lines', h: 'help', t: 'title' }

const COMMANDS = ['ping', 'ls', 'open', 'spawn', 'send', 'read', 'wait', 'status', 'notify', 'note', 'help'] as const
type Command = (typeof COMMANDS)[number]

/** Which flags each command accepts (plus the global json, runtime, help). */
const ALLOWED: Record<Command, string[]> = {
  ping: [],
  ls: ['workspace'],
  open: ['workspace', 'console', 'path'],
  spawn: ['workspace', 'prompt', 'prompt-file', 'title', 'focus', 'no-profile'],
  send: ['workspace', 'file', 'enter'],
  read: ['workspace', 'lines'],
  wait: ['workspace', 'idle', 'timeout', 'quiet-ms'],
  status: ['workspace', 'console', 'clear'],
  notify: ['title', 'local'],
  note: ['workspace', 'task-state', 'clear'],
  help: ['agent'],
}

export interface ParsedArgs {
  command: Command
  positionals: string[]
  flags: Record<string, string | true>
}

export class UsageError extends Error {}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = []
  const flags: Record<string, string | true> = {}
  let command: Command | null = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (arg.startsWith('-') && arg !== '-') {
      const long = arg.startsWith('--')
      let name = long ? arg.slice(2) : arg.slice(1)
      let value: string | undefined
      const eq = name.indexOf('=')
      if (eq >= 0) {
        value = name.slice(eq + 1)
        name = name.slice(0, eq)
      }
      if (!long) name = ALIASES[name] ?? `-${name}`
      if (VALUE_FLAGS.has(name)) {
        if (value === undefined) {
          if (i + 1 >= argv.length) throw new UsageError(`--${name} needs a value`)
          value = argv[++i]
        }
        flags[name] = value
      } else if (BOOL_FLAGS.has(name)) {
        if (value !== undefined) throw new UsageError(`--${name} takes no value`)
        flags[name] = true
      } else throw new UsageError(`unknown option ${arg}`)
      continue
    }
    if (command === null) {
      if (!(COMMANDS as readonly string[]).includes(arg)) throw new UsageError(`unknown command "${arg}" (try snaos help)`)
      command = arg as Command
    } else positionals.push(arg)
  }
  if (command === null) command = 'help'
  const allowed = new Set([...ALLOWED[command], 'json', 'runtime', 'help'])
  for (const name of Object.keys(flags)) if (!allowed.has(name)) throw new UsageError(`--${name} does not apply to ${command}`)
  return { command, positionals, flags }
}

/** Reads what the client is responsible for: files and stdin (main never opens CLI paths). */
export interface ClientIo {
  readFile(path: string): string
  readStdin(): Promise<string>
  cwd(): string
}

export const nodeIo: ClientIo = {
  readFile: (path) => readFileSync(path, 'utf8'),
  readStdin: () =>
    new Promise((res, rej) => {
      const chunks: Buffer[] = []
      process.stdin.on('data', (c: Buffer) => chunks.push(c))
      process.stdin.on('end', () => res(Buffer.concat(chunks).toString('utf8')))
      process.stdin.on('error', rej)
    }),
  cwd: () => process.cwd(),
}

const stripBom = (s: string): string => s.replace(/^﻿/, '')

function readUserFile(io: ClientIo, path: string, label: string): string {
  try {
    return stripBom(io.readFile(resolve(io.cwd(), path)))
  } catch {
    throw new UsageError(`cannot read ${label} ${path}`)
  }
}

/** The text of `send`, `notify`, `status`, `note`: the remaining positionals, joined. */
const restText = (p: string[]): string | undefined => (p.length ? p.join(' ') : undefined)

export interface RpcCall {
  method: CtlMethod
  params: Record<string, unknown>
}

/** Parsed args -> the RPC to send (files and stdin read here). Null for `help`. */
export async function buildCall(args: ParsedArgs, io: ClientIo): Promise<RpcCall | null> {
  const { command, positionals: pos, flags } = args
  const flag = (name: string): string | undefined => (typeof flags[name] === 'string' ? (flags[name] as string) : undefined)
  const on = (name: string): boolean => flags[name] === true
  const ws = flag('workspace') !== undefined ? { workspace: flag('workspace') } : {}
  switch (command) {
    case 'help':
      return null
    case 'ping':
      return { method: 'ping', params: {} }
    case 'ls':
      return { method: 'ls', params: { ...ws } }
    case 'open': {
      if (flag('path') !== undefined) return { method: 'open', params: { path: resolve(io.cwd(), flag('path')!) } }
      const target = pos[0] ?? flag('workspace')
      if (target === undefined && flag('console') === undefined) throw new UsageError('open needs a workspace, --console or --path')
      return { method: 'open', params: { ...(target !== undefined ? { workspace: target } : {}), ...(flag('console') !== undefined ? { console: flag('console') } : {}) } }
    }
    case 'spawn': {
      const agent = pos[0]
      if (!agent) throw new UsageError('spawn needs an agent: claude, codex, shell or a preset name')
      if (pos.length > 1) throw new UsageError('spawn takes one agent; pass the prompt with --prompt, --prompt-file or --prompt -')
      let prompt: string | undefined
      if (flag('prompt') !== undefined && flag('prompt-file') !== undefined) throw new UsageError('use either --prompt or --prompt-file')
      if (flag('prompt-file') !== undefined) prompt = readUserFile(io, flag('prompt-file')!, 'prompt file')
      else if (flag('prompt') === '-') prompt = stripBom(await io.readStdin())
      else prompt = flag('prompt')
      if (prompt !== undefined && prompt.length > CTL_MAX_PROMPT) throw new UsageError(`the prompt is longer than ${CTL_MAX_PROMPT} characters`)
      return {
        method: 'spawn',
        params: {
          agent,
          ...ws,
          ...(prompt !== undefined ? { prompt } : {}),
          ...(flag('title') !== undefined ? { title: flag('title') } : {}),
          ...(on('focus') ? { focus: true } : {}),
          ...(on('no-profile') ? { noProfile: true } : {}),
        },
      }
    }
    case 'send': {
      const target = pos[0]
      if (!target) throw new UsageError('send needs a console')
      let text: string | undefined
      if (flag('file') !== undefined) {
        if (pos.length > 1) throw new UsageError('use either a text or --file')
        text = readUserFile(io, flag('file')!, 'file')
      } else if (pos.length === 2 && pos[1] === '-') text = stripBom(await io.readStdin())
      else text = restText(pos.slice(1))
      if (text === undefined && !on('enter')) throw new UsageError('send needs a text, - (stdin) or --file')
      if (Buffer.byteLength(text ?? '', 'utf8') > CTL_MAX_SEND) throw new UsageError('the text is larger than 256 KB')
      return { method: 'send', params: { console: target, text: text ?? '', ...(on('enter') ? { enter: true } : {}), ...ws } }
    }
    case 'read': {
      if (!pos[0]) throw new UsageError('read needs a console')
      const lines = flag('lines')
      if (lines !== undefined && !/^\d+$/.test(lines)) throw new UsageError('--lines must be a positive integer')
      return { method: 'read', params: { console: pos[0], ...(lines !== undefined ? { lines: Number(lines) } : {}), ...ws } }
    }
    case 'wait': {
      if (!pos[0]) throw new UsageError('wait needs a console')
      const timeout = flag('timeout')
      const quiet = flag('quiet-ms')
      if (timeout !== undefined && !(Number(timeout) > 0)) throw new UsageError('--timeout must be a positive number of seconds')
      if (quiet !== undefined && !/^\d+$/.test(quiet)) throw new UsageError('--quiet-ms must be a number of milliseconds')
      return { method: 'wait', params: { console: pos[0], ...(timeout !== undefined ? { timeout: Number(timeout) } : {}), ...(quiet !== undefined ? { quietMs: Number(quiet) } : {}), ...ws } }
    }
    case 'status':
      return { method: 'status', params: { ...(restText(pos) !== undefined ? { text: restText(pos) } : {}), ...(on('clear') ? { clear: true } : {}), ...(flag('console') !== undefined ? { console: flag('console') } : {}), ...ws } }
    case 'notify': {
      const text = restText(pos)
      if (!text) throw new UsageError('notify needs a text')
      return { method: 'notify', params: { text, ...(flag('title') !== undefined ? { title: flag('title') } : {}), ...(on('local') ? { local: true } : {}) } }
    }
    case 'note': {
      const text = restText(pos)
      if (text === undefined && flag('task-state') === undefined && !on('clear')) throw new UsageError('note needs a text, --task-state or --clear')
      return { method: 'note', params: { ...(text !== undefined ? { text } : {}), ...(flag('task-state') !== undefined ? { taskState: flag('task-state') } : {}), ...(on('clear') ? { clear: true } : {}), ...ws } }
    }
  }
}

// --- Connection --------------------------------------------------------------

export interface Connection {
  endpoint: string
  token: string
  /** A console token (inside a SnAgentsOS console) vs the master token of runtime.json. */
  console: boolean
}

export class AppUnavailable extends Error {}

/**
 * Default dataDir()/runtime.json of an installed build (the shim always passes
 * --runtime), joined with the separators of `platform`, not the host's.
 */
export function defaultRuntimePath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: () => string = homedir): string {
  const p = platform === 'win32' ? win32 : posix
  const base =
    platform === 'win32'
      ? env.APPDATA || p.join(home(), 'AppData', 'Roaming')
      : platform === 'darwin'
        ? p.join(home(), 'Library', 'Application Support')
        : env.XDG_CONFIG_HOME || p.join(home(), '.config')
  return p.join(base, 'snagentsos', 'runtime.json')
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as { code?: unknown }).code === 'EPERM'
  }
}

/**
 * Endpoint and token, in this order (E8 Group C): SNAOS_CTL_ENDPOINT +
 * SNAOS_CTL_TOKEN (console token), then --runtime, then the default data dir.
 * A runtime.json whose pid is dead means the app is not running.
 */
export function resolveConnection(
  flags: Record<string, string | true>,
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
  alive: (pid: number) => boolean = pidAlive,
): Connection {
  const endpoint = env[CLI_ENV.ctlEndpoint]
  const token = env[CLI_ENV.ctlToken]
  if (endpoint && token) return { endpoint, token, console: true }
  const path = typeof flags.runtime === 'string' ? flags.runtime : defaultRuntimePath(env)
  let rt: SnaosRuntimeFile
  try {
    rt = JSON.parse(stripBom(readFile(path))) as SnaosRuntimeFile
  } catch {
    throw new AppUnavailable(NOT_RUNNING)
  }
  if (!rt || typeof rt.token !== 'string' || typeof rt.transport?.endpoint !== 'string' || !alive(rt.pid)) throw new AppUnavailable(NOT_RUNNING)
  return { endpoint: rt.transport.endpoint, token: rt.token, console: false }
}

/** POST /v1/rpc over the pipe / socket. Transport failures throw AppUnavailable. */
export function rpc(conn: Connection, call: RpcCall, timeoutMs: number | null): Promise<CtlResponse> {
  const body = JSON.stringify({ v: 1, method: call.method, params: call.params })
  return new Promise((res, rej) => {
    const req = request(
      {
        socketPath: conn.endpoint,
        method: 'POST',
        path: CTL_RPC_PATH,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${conn.token}` },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (c: Buffer) => chunks.push(c))
        response.on('end', () => {
          const status = response.statusCode ?? 0
          const fail = (code: CtlErrorCode, message: string): void => res({ ok: false, error: { code, message } })
          if (status === 401)
            return fail('unauthorized', conn.console ? "this console's token is no longer valid, restart the console" : 'unauthorized: runtime.json is stale, restart the terminal')
          if (status === 403) return fail('forbidden', 'forbidden')
          if (status === 413) return fail('bad_request', 'request too large')
          try {
            res(JSON.parse(Buffer.concat(chunks).toString('utf8')) as CtlResponse)
          } catch {
            fail('internal', `unexpected answer (HTTP ${status})`)
          }
        })
        response.on('error', () => rej(new AppUnavailable(`${PRODUCT} closed the connection`)))
      },
    )
    if (timeoutMs !== null) req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
    req.on('error', (e: NodeJS.ErrnoException) => {
      if (e.message === 'timeout') res({ ok: false, error: { code: 'internal', message: `${PRODUCT} did not answer in time` } })
      else rej(new AppUnavailable(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? NOT_RUNNING : `${PRODUCT} is unreachable (${e.code ?? e.message})`))
    })
    req.end(body)
  })
}

// --- Output ------------------------------------------------------------------

const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length))

function consoleRow(c: CtlConsoleInfo): string {
  const state = c.agentState ? `${c.agentState}${c.precise ? '' : '?'}${c.reason ? ` (${c.reason})` : ''}` : c.running ? 'running' : 'stopped'
  const tags = [c.self ? 'self' : '', c.sshProtected ? 'ssh' : ''].filter(Boolean).join(',')
  return `   ${pad(String(c.index), 3)}${pad(c.title, 22)} ${pad(c.presetName ?? c.type, 14)} ${pad(state, 22)}${tags ? `[${tags}] ` : ''}${c.statusLine ?? ''}`.trimEnd()
}

/** Human output of a successful call. */
export function formatHuman(method: CtlMethod, data: unknown): string {
  const d = (data ?? {}) as Record<string, unknown>
  switch (method) {
    case 'ping':
      return `pong (${PRODUCT} ${String(d.appVersion ?? '')})${d.self ? `, this console is ${String(d.self)}` : ''}`
    case 'ls': {
      const out: string[] = []
      for (const w of (d.workspaces as CtlWorkspaceInfo[]) ?? []) {
        out.push(`${pad(String(w.index), 3)}${w.name}${w.active ? ' *' : ''}  ${w.cwd}${w.taskState ? `  [${w.taskState}]` : ''}${w.note ? `  "${w.note}"` : ''}`)
        for (const c of w.consoles) out.push(consoleRow(c))
      }
      return out.join('\n') || 'no workspaces'
    }
    case 'open':
      return d.composer ? 'no workspace with that folder: opened the new workspace card' : 'ok'
    case 'spawn':
      return `spawned console ${String(d.index)} (${String(d.paneId)}), prompt: ${String(d.promptDelivery)}`
    case 'send':
      return d.enter ? 'sent with Enter' : 'sent'
    case 'read':
      return ((d.lines as string[]) ?? []).join('\n')
    case 'wait':
      return `${String(d.state ?? 'no agent state')}${d.precise === false && d.state ? ' (approximate)' : ''}${d.noTurnObserved ? ' (no turn observed)' : ''}`
    case 'status':
      if ('state' in d) return `${String(d.state ?? 'no agent state')}${d.statusLine ? `: ${String(d.statusLine)}` : ''}`
      return d.statusLine ? `status: ${String(d.statusLine)}` : 'status cleared'
    case 'notify':
      return 'notified'
    case 'note':
      return d.note === null && d.taskState === null ? 'note cleared' : 'note saved'
  }
}

export const USAGE = `snaos: drive ${PRODUCT} consoles from any terminal.

  snaos ls [--workspace <ws>]
  snaos open <ws> [--console <c>] | --path <dir>
  snaos spawn <claude|codex|shell|preset> [--prompt <text> | --prompt-file <path> | --prompt -]
              [--workspace <ws>] [--title <t>] [--focus] [--no-profile]
  snaos send <console> <text|-> [--file <path>] [--enter]
  snaos read <console> [--lines N]
  snaos wait <console> --idle [--timeout <s>] [--quiet-ms <ms>]
  snaos status ["<text>" | --clear] [--console <c>]
  snaos notify "<text>" [--title <t>] [--local]
  snaos note "<text>" [--task-state todo|doing|review|done] | --clear
  snaos help [--agent]

Every command accepts --json. A console is self, an index (2), <ws>:<index>, an id or a title.`

export interface RunDeps {
  io: ClientIo
  env: NodeJS.ProcessEnv
  out: (s: string) => void
  err: (s: string) => void
  connect?: (flags: Record<string, string | true>, env: NodeJS.ProcessEnv) => Connection
  send?: (conn: Connection, call: RpcCall, timeoutMs: number | null) => Promise<CtlResponse>
  appVersion?: string
}

/** One CLI invocation; resolves to the process exit code. */
export async function run(argv: readonly string[], deps: RunDeps): Promise<number> {
  let json = argv.includes('--json')
  const fail = (code: CtlErrorCode | 'usage', message: string, exit: number): number => {
    if (json) deps.out(JSON.stringify({ ok: false, error: { code: code === 'usage' ? 'bad_request' : code, message } }))
    else deps.err(`snaos: ${message}`)
    return exit
  }
  let args: ParsedArgs
  let call: RpcCall | null
  try {
    args = parseArgs(argv)
    json = args.flags.json === true
    if (args.flags.help === true && args.command !== 'help') {
      deps.out(USAGE)
      return 0
    }
    call = await buildCall(args, deps.io)
  } catch (e) {
    if (e instanceof UsageError) return fail('usage', e.message, 2)
    return fail('internal', e instanceof Error ? e.message : String(e), 1)
  }
  if (!call) {
    const version = deps.appVersion ?? 'dev'
    if (json) deps.out(JSON.stringify({ ok: true, data: { usage: args.flags.agent ? agentGuide(version) : USAGE } }))
    else deps.out(args.flags.agent ? agentGuide(version) : USAGE)
    return 0
  }
  let conn: Connection
  try {
    conn = (deps.connect ?? ((f, env) => resolveConnection(f, env)))(args.flags, deps.env)
  } catch (e) {
    return fail('desktop_unavailable', e instanceof Error ? e.message : NOT_RUNNING, CTL_EXIT.desktop_unavailable)
  }
  let res: CtlResponse
  try {
    res = await (deps.send ?? rpc)(conn, call, call.method === 'wait' ? null : 60_000)
  } catch (e) {
    return fail('desktop_unavailable', e instanceof Error ? e.message : NOT_RUNNING, CTL_EXIT.desktop_unavailable)
  }
  if (json) deps.out(JSON.stringify(res))
  if (!res.ok) {
    if (!json) deps.err(`snaos: ${res.error.message}`)
    return CTL_EXIT[res.error.code] ?? 1
  }
  if (!json) {
    const text = formatHuman(call.method, res.data)
    if (text) deps.out(text)
  }
  return 0
}

/** Entry point when run as out/main/cli.js. */
async function main(): Promise<void> {
  const code = await run(process.argv.slice(2), {
    io: nodeIo,
    env: process.env,
    out: (s) => process.stdout.write(s + '\n'),
    err: (s) => process.stderr.write(s + '\n'),
    appVersion: typeof __SNAOS_APP_VERSION__ === 'string' ? __SNAOS_APP_VERSION__ : undefined,
  })
  // Let stdout drain (a pipe) before leaving.
  process.stdout.write('', () => process.exit(code))
}

if (typeof require !== 'undefined' && require.main === module) void main()
