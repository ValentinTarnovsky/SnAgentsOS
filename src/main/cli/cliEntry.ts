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
  CTL_MAX_BODY,
  CTL_MAX_PROMPT,
  CTL_MAX_SEND,
  CTL_RPC_PATH,
  type CtlAccountInfo,
  type CtlAccountStatus,
  type CtlAccountUseResult,
  type CtlChatResult,
  type CtlConsoleInfo,
  type CtlErrorCode,
  type CtlMethod,
  type CtlPeekResult,
  type CtlResponse,
  type CtlUsageResult,
  type CtlWorkspaceInfo,
  type SnaosRuntimeFile,
} from '@shared/ctl-protocol'
import { WS_NOTE_MAX_BYTES, type WsNoteDoc, type WsNoteMeta } from '@shared/ws-notes'
import type { ChatMessage } from '@shared/chat-types'
import { agentGuide } from './agentGuide'

declare const __SNAOS_APP_VERSION__: string | undefined

const PRODUCT = 'SnAgentsOS'
const NOT_RUNNING = `${PRODUCT} is not running`

/** Flags that take a value (`--flag v` or `--flag=v`). Short aliases map to these. */
const VALUE_FLAGS = new Set(['workspace', 'console', 'path', 'prompt', 'prompt-file', 'title', 'file', 'lines', 'timeout', 'quiet-ms', 'task-state', 'runtime', 'turns', 'before', 'rev', 'provider'])
const BOOL_FLAGS = new Set(['json', 'focus', 'no-profile', 'enter', 'clear', 'local', 'idle', 'agent', 'help', 'tools', 'thinking', 'yes', 'resume', 'fresh', 'close', 'off', 'composer', 'open'])
const ALIASES: Record<string, string> = { w: 'workspace', c: 'console', n: 'lines', h: 'help', t: 'title', y: 'yes' }

const COMMANDS = ['ping', 'ls', 'open', 'spawn', 'send', 'read', 'wait', 'status', 'notify', 'note', 'chat', 'peek', 'kill', 'restart', 'rename', 'focus', 'ws', 'notes', 'usage', 'account', 'help'] as const
type Command = (typeof COMMANDS)[number]
const COMMAND_ALIASES: Record<string, Command> = { workspace: 'ws' }

/** Commands with subcommands, and the flags of each one. */
const SUBS: Partial<Record<Command, Record<string, string[]>>> = {
  ws: { new: ['path', 'focus', 'composer'], rename: [], close: ['yes'], fav: ['off'] },
  notes: { ls: ['workspace'], get: ['workspace'], new: ['workspace', 'title', 'file', 'open'], set: ['workspace', 'file', 'rev'], append: ['workspace', 'file'], rm: ['workspace'], open: ['workspace'] },
  account: { status: [], ls: ['provider'], use: ['provider'] },
}
/** `notes` alone lists, `account` alone is `account status`; `ws` alone is a usage error. */
const DEFAULT_SUB: Partial<Record<Command, string>> = { notes: 'ls', account: 'status' }

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
  chat: ['workspace', 'turns', 'before', 'tools', 'thinking'],
  peek: ['workspace', 'lines'],
  kill: ['workspace', 'close'],
  restart: ['workspace', 'resume', 'fresh'],
  rename: ['workspace'],
  focus: ['workspace'],
  ws: [],
  notes: [],
  usage: ['provider'],
  account: [],
  help: ['agent'],
}

export interface ParsedArgs {
  command: Command
  /** The subcommand of `ws` / `notes` / `account`. */
  sub?: string
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
      const name = COMMAND_ALIASES[arg] ?? arg
      if (!(COMMANDS as readonly string[]).includes(name)) throw new UsageError(`unknown command "${arg}" (try snaos help)`)
      command = name as Command
    } else positionals.push(arg)
  }
  if (command === null) command = 'help'
  const subs = SUBS[command]
  let sub: string | undefined
  let own = ALLOWED[command]
  if (subs && flags.help !== true) {
    sub = positionals.shift() ?? DEFAULT_SUB[command]
    const names = Object.keys(subs).join(', ')
    if (sub === undefined) throw new UsageError(`${command} needs one of: ${names}`)
    if (!Object.prototype.hasOwnProperty.call(subs, sub)) throw new UsageError(`unknown ${command} command "${sub}" (one of: ${names})`)
    own = subs[sub]
  }
  const allowed = new Set([...own, 'json', 'runtime', 'help'])
  const label = sub ? `${command} ${sub}` : command
  for (const name of Object.keys(flags)) if (!allowed.has(name)) throw new UsageError(`--${name} does not apply to ${label}`)
  return { command, ...(sub ? { sub } : {}), positionals, flags }
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

/** A note body: `--file`, a lone `-` (stdin), else the words joined. Read here, never by main. */
async function readBody(pos: string[], file: string | undefined, io: ClientIo): Promise<string | undefined> {
  if (file !== undefined) {
    if (pos.length) throw new UsageError('use either a text or --file')
    return readUserFile(io, file, 'file')
  }
  if (pos.length === 1 && pos[0] === '-') return stripBom(await io.readStdin())
  return restText(pos)
}

/** A note fits the store (1 MB) and the request still fits the body cap once JSON-escaped. */
function checkNoteCall(call: RpcCall): RpcCall {
  const text = call.params.text
  if (typeof text === 'string' && Buffer.byteLength(text, 'utf8') > WS_NOTE_MAX_BYTES) throw new UsageError('the note is larger than 1 MB')
  if (Buffer.byteLength(JSON.stringify({ v: 1, method: call.method, params: call.params }), 'utf8') > CTL_MAX_BODY)
    throw new UsageError('the note is too large to send in one request (1 MB after JSON escaping)')
  return call
}

const positiveInt = (v: string | undefined, name: string): number | undefined => {
  if (v === undefined) return undefined
  if (!/^\d+$/.test(v) || Number(v) < 1) throw new UsageError(`--${name} must be a positive integer`)
  return Number(v)
}

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
    case 'chat': {
      if (!pos[0]) throw new UsageError('chat needs a console')
      if (pos.length > 1) throw new UsageError('chat takes one console')
      const turns = positiveInt(flag('turns'), 'turns')
      const before = flag('before')
      if (before !== undefined && !/^\d{1,16}$/.test(before)) throw new UsageError('--before must be a cursor printed by an earlier snaos chat')
      return {
        method: 'chat',
        params: { console: pos[0], ...(turns !== undefined ? { turns } : {}), ...(before !== undefined ? { before } : {}), ...(on('tools') ? { tools: true } : {}), ...(on('thinking') ? { thinking: true } : {}), ...ws },
      }
    }
    case 'peek': {
      if (!pos[0]) throw new UsageError('peek needs a console')
      if (pos.length > 1) throw new UsageError('peek takes one console')
      const lines = positiveInt(flag('lines'), 'lines')
      return { method: 'peek', params: { console: pos[0], ...(lines !== undefined ? { lines } : {}), ...ws } }
    }
    case 'kill':
      if (!pos[0]) throw new UsageError('kill needs a console')
      return { method: 'kill', params: { console: pos[0], ...(on('close') ? { close: true } : {}), ...ws } }
    case 'restart': {
      if (!pos[0]) throw new UsageError('restart needs a console')
      if (on('resume') && on('fresh')) throw new UsageError('use either --resume or --fresh')
      return { method: 'restart', params: { console: pos[0], ...(on('resume') ? { resume: true } : on('fresh') ? { resume: false } : {}), ...ws } }
    }
    case 'rename': {
      const title = restText(pos.slice(1))
      if (!pos[0] || title === undefined) throw new UsageError('rename needs a console and a title')
      return { method: 'rename', params: { console: pos[0], title, ...ws } }
    }
    case 'focus':
      // The existing `open --console`: shows that console on the desktop.
      if (!pos[0]) throw new UsageError('focus needs a console')
      return { method: 'open', params: { console: pos[0], ...ws } }
    case 'ws':
      switch (args.sub) {
        case 'new': {
          const name = restText(pos)
          return {
            method: 'ws.new',
            params: { ...(name !== undefined ? { name } : {}), path: resolve(io.cwd(), flag('path') ?? '.'), ...(on('focus') ? { focus: true } : {}), ...(on('composer') ? { composer: true } : {}) },
          }
        }
        case 'rename': {
          const name = restText(pos.slice(1))
          if (!pos[0] || name === undefined) throw new UsageError('ws rename needs a workspace and a name')
          return { method: 'ws.rename', params: { workspace: pos[0], name } }
        }
        case 'close':
          if (!pos[0]) throw new UsageError('ws close needs a workspace')
          if (pos.length > 1) throw new UsageError('ws close takes one workspace')
          if (!on('yes')) throw new UsageError('closing a workspace ends its consoles; add --yes')
          return { method: 'ws.close', params: { workspace: pos[0], yes: true } }
        default:
          if (!pos[0]) throw new UsageError('ws fav needs a workspace')
          return { method: 'ws.fav', params: { workspace: pos[0], favorite: !on('off') } }
      }
    case 'notes': {
      const note = pos[0]
      const needNote = (): string => {
        if (!note) throw new UsageError(`notes ${args.sub} needs a note (an id or its exact title)`)
        return note
      }
      switch (args.sub) {
        case 'get':
          return { method: 'notes.get', params: { note: needNote(), ...ws } }
        case 'rm':
          return { method: 'notes.rm', params: { note: needNote(), ...ws } }
        case 'open':
          return { method: 'notes.open', params: { note: needNote(), ...ws } }
        case 'new': {
          const text = await readBody(pos, flag('file'), io)
          return checkNoteCall({ method: 'notes.new', params: { ...(text !== undefined ? { text } : {}), ...(flag('title') !== undefined ? { title: flag('title') } : {}), ...(on('open') ? { open: true } : {}), ...ws } })
        }
        case 'set':
        case 'append': {
          const id = needNote()
          const text = await readBody(pos.slice(1), flag('file'), io)
          if (text === undefined) throw new UsageError(`notes ${args.sub} needs a text, - (stdin) or --file`)
          const rev = args.sub === 'set' ? flag('rev') : undefined
          return checkNoteCall({ method: args.sub === 'set' ? 'notes.set' : 'notes.append', params: { note: id, text, ...(rev !== undefined ? { rev } : {}), ...ws } })
        }
        default:
          if (pos.length) throw new UsageError('notes ls takes no argument')
          return { method: 'notes.ls', params: { ...ws } }
      }
    }
    case 'usage': {
      if (pos.length) throw new UsageError('usage takes no argument (use --provider claude|codex)')
      const provider = flag('provider')
      if (provider !== undefined && provider !== 'claude' && provider !== 'codex') throw new UsageError('--provider must be claude or codex')
      return { method: 'usage', params: { ...(provider !== undefined ? { provider } : {}) } }
    }
    case 'account': {
      const provider = flag('provider')
      if (provider !== undefined && provider !== 'claude') throw new UsageError('--provider must be claude (only Claude accounts are saved)')
      const prov = provider !== undefined ? { provider } : {}
      switch (args.sub) {
        case 'ls':
          if (pos.length) throw new UsageError('account ls takes no argument')
          return { method: 'account.ls', params: prov }
        case 'use':
          if (!pos[0]) throw new UsageError('account use needs an account: primary, secondary, an id or a label')
          return { method: 'account.use', params: { account: pos.join(' '), ...prov } }
        default:
          if (pos.length) throw new UsageError('account status takes no argument')
          return { method: 'account.status', params: {} }
      }
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

const two = (n: number): string => String(n).padStart(2, '0')
/** Local `YYYY-MM-DD HH:MM` (or `HH:MM` for today). */
export function clock(ms: number, now: number = Date.now()): string {
  const d = new Date(ms)
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`
  return new Date(now).toDateString() === d.toDateString() ? hm : `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${hm}`
}

/** `snaos chat`: one header per message (tool output follows its call), then the blocks. */
function chatHuman(d: CtlChatResult): string {
  const out: string[] = []
  for (const m of (d.items ?? []) as ChatMessage[]) {
    if (m.role !== 'tool') out.push(`--- ${m.role}${m.ts ? ` (${clock(m.ts)})` : ''}`)
    for (const b of m.blocks) {
      if (b.t === 'text') out.push(b.text + (b.truncated ? ' [truncated]' : ''))
      else if (b.t === 'thinking') out.push(`(thinking) ${b.text}${b.truncated ? ' [truncated]' : ''}`)
      else if (b.t === 'toolUse') out.push(`-> ${b.name}${b.summary ? `: ${b.summary}` : ''}`)
      else if (b.t === 'toolResult') out.push(`<- ${b.isError ? 'error' : 'result'}${b.text ? `: ${b.text}` : ''}${b.truncated ? ' [truncated]' : ''}`)
      else if (b.t === 'image') out.push(`[image ${b.label}]`)
    }
  }
  if (!out.length) out.push(d.pending ? 'no messages yet' : 'no messages')
  if (d.nextCursor) out.push(`older: snaos chat ${d.paneId} --before ${d.nextCursor}`)
  return out.join('\n')
}

/** `snaos peek`: state lines, then the screen. */
function peekHuman(d: CtlPeekResult): string {
  const state = d.state ? `${d.state}${d.precise ? '' : '?'}${d.reason ? ` (${d.reason})` : ''}` : 'no agent state'
  const out = [`${d.title} (${d.paneId})  ${d.provider ?? d.type}  ${state}${d.stateSince ? ` since ${clock(d.stateSince)}` : ''}  ${d.running ? 'running' : 'stopped'}`]
  if (d.attention !== undefined) out.push(`attention: ${d.attention ? 'needs the user' : 'no'}`)
  for (const p of d.pending ?? []) out.push(`pending: ${p.kind}${p.toolName ? ` ${p.toolName}` : ''}: ${p.summary}`)
  if (d.activity) out.push(`activity: ${d.activity}`)
  if (d.waiting) out.push(`waiting: ${d.waiting.kind} (${d.waiting.count})`)
  if (d.statusLine) out.push(`status: ${d.statusLine}`)
  const tune = [d.model ? `model ${d.model}` : '', d.effort ? `effort ${d.effort}` : '', d.ultracode !== undefined ? `ultracode ${d.ultracode ? 'on' : 'off'}` : ''].filter(Boolean)
  if (tune.length) out.push(tune.join(', '))
  if (d.lastMessage) out.push(`last: ${d.lastMessage}`)
  if (d.lines?.length) out.push(`--- screen (last ${d.lines.length} lines)`, ...d.lines)
  return out.join('\n')
}

/** Time left until an ISO reset: `2h 10m`, `3d 4h`, `5m`, `now`; '' when unknown. */
export function resetIn(iso: string | null | undefined, now: number = Date.now()): string {
  const at = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(at)) return ''
  const mins = Math.ceil((at - now) / 60_000)
  if (mins <= 0) return 'now'
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return h ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`
  return `${m}m`
}

const pct = (p: number | null | undefined): string => (typeof p === 'number' ? `${Math.round(p)}%` : '-')
const accountName = (a: { label?: string; slot?: string; id?: string } | null | undefined): string => (a ? a.label || a.slot || a.id || '?' : 'none')
/** The account name, plus ` (slot)` only when a label names it (the slot alone is not repeated). */
const accountNameSlot = (a: { label?: string; slot?: string; id?: string } | null | undefined): string => `${accountName(a)}${a?.label && a.slot ? ` (${a.slot})` : ''}`
/** A column that always leaves one space after the value, however long it is. */
const col = (s: string, n: number): string => pad(s, n - 1) + ' '

/** `snaos usage`: one row per window, then the active Claude account. */
function usageHuman(d: CtlUsageResult, now: number): string {
  const out = (d.rows ?? []).map((r) => {
    const left = r.status === 'ok' ? (resetIn(r.resetsAt, now) ? `resets in ${resetIn(r.resetsAt, now)}` : '') : r.status
    return `${col(r.provider, 7)}${col(r.label, 16)}${col(pct(r.percent), 6)}${left}${r.planType ? `  [${r.planType}]` : ''}${r.stale ? ' (stale)' : ''}`.trimEnd()
  })
  if (!out.length) out.push('no usage rows (turn them on in Settings > AI Usage)')
  if (d.account) out.push(`claude account: ${accountNameSlot(d.account)}`)
  return out.join('\n')
}

function accountRow(a: CtlAccountInfo, now: number): string {
  const win = (label: string, w: CtlAccountInfo['fiveHour']): string => `${label} ${pct(w.percent)}${w.source === 'parked' && w.resetsAt ? ` (resets in ${resetIn(w.resetsAt, now) || 'now'})` : ''}`
  return `${a.active ? '* ' : '  '}${col(a.slot, 11)}${col(a.label || '-', 18)}${col(a.plan ?? '', 8)}${win('5h', a.fiveHour)}  ${win('7d', a.sevenDay)}${a.ready ? '' : '  (capture it again on the desktop)'}`.trimEnd()
}

/** `snaos account status`: the live login, the last switch and the automatic switch. */
function accountStatusHuman(d: CtlAccountStatus): string {
  if (!d.supported) return 'saved Claude logins are not supported on this machine'
  if (!d.accounts?.length) return 'no saved Claude accounts (save them in Settings > Claude accounts)'
  const byId = (id: string | null): string => (id ? accountName(d.accounts.find((a) => a.id === id) ?? { id }) : 'none')
  const out = [d.live === 'unknown' ? 'active: a Claude login that is not saved here' : d.live === 'none' ? 'active: no Claude login' : `active: ${accountNameSlot(d.active)}`]
  if (d.unverified) out.push('the live Claude login changed and is not identified yet: switches wait until a Claude console used it')
  if (d.lastSwitch) out.push(`last switch: ${byId(d.lastSwitch.from)} to ${byId(d.lastSwitch.to)} (${d.lastSwitch.reason}, ${clock(d.lastSwitch.at)})`)
  out.push(`automatic switch: ${d.auto.enabled ? `on at ${d.auto.switchAtPercent}%` : 'off'}${d.auto.paused ? ` (paused: ${d.auto.paused})` : ''}`)
  return out.join('\n')
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
        out.push(`${pad(String(w.index), 3)}${w.name}${w.active ? ' *' : ''}${w.favorite ? ' [fav]' : ''}  ${w.cwd}${w.taskState ? `  [${w.taskState}]` : ''}${w.note ? `  "${w.note}"` : ''}`)
        for (const c of w.consoles) out.push(consoleRow(c))
      }
      return out.join('\n') || 'no workspaces'
    }
    case 'open':
      return d.composer ? 'no workspace with that folder: opened the new workspace card' : 'ok'
    case 'spawn':
      return `spawned console ${String(d.index)} (${String(d.paneId)}), prompt: ${String(d.promptDelivery)}`
    case 'send':
      return d.enter ? 'sent with Enter' : 'typed, not submitted (add --enter to submit)'
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
    case 'chat':
      return chatHuman(d as unknown as CtlChatResult)
    case 'peek':
      return peekHuman(d as unknown as CtlPeekResult)
    case 'kill':
      return `${d.killed ? `stopped console ${String(d.paneId)}` : `console ${String(d.paneId)} was not running`}${d.closed ? ', closed (reopen it from the desktop)' : ''}`
    case 'restart':
      return `restarting console ${String(d.paneId)} (${String(d.mode)})`
    case 'rename':
      return `renamed to "${String(d.title)}"`
    case 'ws.new':
      return d.composer ? `opened the new workspace card for ${String(d.cwd)}` : `created workspace ${String(d.index)} "${String(d.name)}" (${String(d.workspaceId)})`
    case 'ws.rename':
      return `renamed workspace to "${String(d.name)}"`
    case 'ws.close': {
      const n = Number(d.consolesEnded ?? 0)
      return `closed workspace "${String(d.name)}" (${n} ${n === 1 ? 'console' : 'consoles'} ended; its notes move to the trash)`
    }
    case 'ws.fav':
      return `"${String(d.name)}" ${d.favorite ? 'is now a favorite' : 'is no longer a favorite'}`
    case 'notes.ls': {
      const notes = (d.notes as WsNoteMeta[]) ?? []
      return notes.map((n) => `${pad(n.id, 20)}${pad(clock(n.updatedAt, 0), 18)}${pad(`${n.size} B`, 10)}${n.title || '(untitled)'}`).join('\n') || 'no notes'
    }
    case 'notes.get':
      return (d.note as WsNoteDoc | undefined)?.text ?? ''
    case 'notes.new': {
      const note = d.note as WsNoteMeta | undefined
      return `created note ${note?.id ?? ''}${d.opened ? ' (opened in the Notes drawer)' : ''}`
    }
    case 'notes.set':
    case 'notes.append': {
      const note = d.note as WsNoteMeta | undefined
      return `saved note ${note?.id ?? ''} (rev ${note?.rev ?? ''})`
    }
    case 'notes.rm':
      return `moved note ${String(d.noteId)} to the trash (kept 30 days)`
    case 'notes.open':
      return 'opened in the Notes drawer'
    case 'usage':
      return usageHuman(d as unknown as CtlUsageResult, Date.now())
    case 'account.ls': {
      const list = (d.accounts as CtlAccountInfo[] | undefined) ?? []
      return list.map((a) => accountRow(a, Date.now())).join('\n') || 'no saved Claude accounts (save them in Settings > Claude accounts)'
    }
    case 'account.status':
      return accountStatusHuman(d as unknown as CtlAccountStatus)
    case 'account.use': {
      const r = d as unknown as CtlAccountUseResult
      return `${r.changed ? 'switched to' : 'already on'} ${accountNameSlot(r.active)}`
    }
  }
}

export const USAGE = `snaos: drive ${PRODUCT} consoles from any terminal.

  snaos ls [--workspace <ws>]
  snaos open <ws> [--console <c>] | --path <dir>
  snaos spawn <claude|codex|shell|preset> [--prompt <text> | --prompt-file <path> | --prompt -]
              [--workspace <ws>] [--title <t>] [--focus] [--no-profile]
  snaos send <console> <text|-> [--file <path>] [--enter]
  snaos read <console> [--lines N]
  snaos peek <console> [--lines N]
  snaos chat <console> [--turns N] [--before <cursor>] [--tools] [--thinking]
  snaos wait <console> --idle [--timeout <s>] [--quiet-ms <ms>]
  snaos status ["<text>" | --clear] [--console <c>]
  snaos notify "<text>" [--title <t>] [--local]
  snaos note "<text>" [--task-state todo|doing|review|done] | --clear
  snaos notes [ls] | get <note> | rm <note> | open <note>        [--workspace <ws>]
  snaos notes new ["<text>" | - | --file <path>] [--title <t>] [--open]
  snaos notes set <note> <text|-> | --file <path> [--rev <rev>]
  snaos notes append <note> <text|-> | --file <path>
  snaos focus <console>
  snaos rename <console> <title>
  snaos restart <console> [--resume | --fresh]
  snaos kill <console> [--close]
  snaos ws new [<name>] [--path <dir>] [--focus] [--composer]
  snaos ws rename <ws> <name> | ws fav <ws> [--off] | ws close <ws> --yes
  snaos usage [--provider claude|codex]
  snaos account [status] | account ls | account use <primary|secondary|id|label>
  snaos help [--agent]

Every command accepts --json. A console is self, an index (2), <ws>:<index>, an id or a title.
A note is its id or its exact title.`

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
