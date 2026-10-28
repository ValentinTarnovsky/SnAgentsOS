/**
 * The `snaos` binary (E8-FR-14..21): out/main/cli.js, run by the shim with
 * ELECTRON_RUN_AS_NODE. Node core only (no Electron, no npm module): argument
 * parsing, `--file` / `--prompt-file` / stdin read here (main never opens a
 * path that came from the CLI), the HTTP client over the pipe or socket,
 * human or `--json` output and the exit codes. Output is English on purpose.
 */
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { request } from 'http'
import { homedir, tmpdir } from 'os'
import { join, posix, resolve, win32 } from 'path'
import { CLI_ENV } from '@shared/brand'
import {
  CTL_EXIT,
  CTL_MAX_BODY,
  CTL_MAX_PROMPT,
  CTL_MAX_SEND,
  CTL_RPC_PATH,
  CTL_TEAM_LOG_N_MAX,
  CTL_TEAM_PATH_MAX,
  CTL_TEAM_PATHS_MAX,
  type CtlAccountInfo,
  type CtlAccountStatus,
  type CtlAccountUseResult,
  type CtlChatResult,
  type CtlConsoleInfo,
  type CtlErrorCode,
  type CtlMethod,
  type CtlPeekResult,
  type CtlResponse,
  type CtlStatusSignals,
  type CtlUsageResult,
  type CtlWorkspaceInfo,
  type SnaosRuntimeFile,
} from '@shared/ctl-protocol'
import { WS_NOTE_MAX_BYTES, WS_NOTE_TITLE_MAX, type WsNoteDoc, type WsNoteMeta } from '@shared/ws-notes'
import type { ChatMessage } from '@shared/chat-types'
import {
  AGENT_ID_RE,
  BLOCKED_BY_MAX,
  CARD_OPTION_MAX,
  CARD_OPTIONS_MAX,
  CARD_QUESTION_MAX,
  COMMENT_TEXT_MAX,
  HIRE_TEXT_MAX,
  LEAD_THREAD,
  REPO_ID_RE,
  TASK_BODY_MAX,
  TASK_ID_RE,
  TASK_PRIORITIES,
  TASK_TITLE_MAX,
  TEAM_PLAN_MAX,
} from '@shared/teams'
import { DATA_SECRET_FILES } from '@shared/teamArgv'
import type { TeamCtlMethod } from '@shared/teamTools'
import { agentGuide } from './agentGuide'

declare const __SNAOS_APP_VERSION__: string | undefined

const PRODUCT = 'SnAgentsOS'
const NOT_RUNNING = `${PRODUCT} is not running`

/** Flags that take a value (`--flag v` or `--flag=v`). Short aliases map to these. */
const VALUE_FLAGS = new Set([
  'workspace', 'console', 'path', 'prompt', 'prompt-file', 'title', 'file', 'lines', 'timeout', 'quiet-ms', 'task-state', 'runtime', 'turns', 'before', 'rev', 'provider',
  // app 2.7.0 (Teams): snaos team.
  'body-file', 'assign', 'repo', 'isolation', 'blocked-by', 'priority', 'parent', 'state', 'options', 'plan', 'task',
  // app 2.9.0: team ask --recommended.
  'recommended',
])
const BOOL_FLAGS = new Set([
  'json', 'focus', 'no-profile', 'enter', 'clear', 'local', 'idle', 'agent', 'help', 'tools', 'thinking', 'yes', 'resume', 'fresh', 'close', 'off', 'composer', 'open',
  'mine', 'no-plan', 'needs-plan', 'small', 'multi', 'confirm', 'stat',
  // app 2.9.1: team plan / hire --part.
  'part',
])
const ALIASES: Record<string, string> = { w: 'workspace', c: 'console', n: 'lines', h: 'help', t: 'title', y: 'yes' }

const COMMANDS = ['ping', 'ls', 'open', 'spawn', 'send', 'read', 'wait', 'status', 'notify', 'note', 'chat', 'peek', 'kill', 'restart', 'rename', 'focus', 'ws', 'notes', 'usage', 'account', 'needs', 'team', 'help'] as const
type Command = (typeof COMMANDS)[number]
const COMMAND_ALIASES: Record<string, Command> = { workspace: 'ws' }

/**
 * Commands with subcommands, and the flags of each one. One level only: `team task` and `team verdict` take their
 * verb as the next positional (get|create|update, approve|changes), and buildCall checks the flags of that verb.
 */
const SUBS: Partial<Record<Command, Record<string, string[]>>> = {
  ws: { new: ['path', 'focus', 'composer'], rename: [], close: ['yes'], fav: ['off'] },
  notes: { ls: ['workspace'], get: ['workspace'], new: ['workspace', 'title', 'file', 'open'], set: ['workspace', 'file', 'rev'], append: ['workspace', 'file'], rm: ['workspace'], open: ['workspace'] },
  account: { status: [], ls: ['provider'], use: ['provider'] },
  team: {
    show: [],
    tasks: ['state', 'mine'],
    task: ['title', 'body-file', 'assign', 'repo', 'isolation', 'blocked-by', 'priority', 'no-plan', 'needs-plan', 'parent', 'state', 'rev'],
    // -n is the alias of --lines.
    diff: ['stat', 'task'],
    log: ['lines', 'task'],
    comment: ['file'],
    note: ['file', 'title'],
    ask: ['file', 'options', 'multi', 'confirm', 'recommended'],
    needs: ['file'],
    plan: ['file', 'small', 'part'],
    review: ['file'],
    verdict: ['file'],
    done: ['file'],
    approve: ['plan'],
    hire: ['file', 'part'],
  },
}
/** `notes` alone lists, `account` alone is `account status`; `ws` and `team` alone are usage errors. */
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
  needs: ['workspace', 'console', 'clear'],
  team: [],
  help: ['agent'],
}

export interface ParsedArgs {
  command: Command
  /** The subcommand of `ws` / `notes` / `account` / `team`. */
  sub?: string
  positionals: string[]
  flags: Record<string, string | true>
  /** App 2.7.0 (team diff, team log): the index in `positionals` where the words after `--` start; absent without `--`. */
  dashAt?: number
}

export class UsageError extends Error {}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = []
  const flags: Record<string, string | true> = {}
  let command: Command | null = null
  let dashAt: number | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      dashAt = positionals.length
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
    // A subcommand is a word before `--` (after it, every word is data).
    sub = dashAt !== 0 ? positionals.shift() : undefined
    if (sub !== undefined && dashAt !== undefined) dashAt--
    sub ??= DEFAULT_SUB[command]
    const names = Object.keys(subs).join(', ')
    if (sub === undefined) throw new UsageError(`${command} needs one of: ${names}`)
    if (!Object.prototype.hasOwnProperty.call(subs, sub)) throw new UsageError(`unknown ${command} command "${sub}" (one of: ${names})`)
    own = subs[sub]
  }
  const allowed = new Set([...own, 'json', 'runtime', 'help'])
  const label = sub ? `${command} ${sub}` : command
  for (const name of Object.keys(flags)) if (!allowed.has(name)) throw new UsageError(`--${name} does not apply to ${label}`)
  return { command, ...(sub ? { sub } : {}), positionals, flags, ...(dashAt !== undefined ? { dashAt } : {}) }
}

/** Reads what the client is responsible for: files and stdin (main never opens CLI paths). */
export interface ClientIo {
  readFile(path: string): string
  readStdin(): Promise<string>
  cwd(): string
  /** App 2.7.0 (snaos team): the raw bytes, decoded by decodeTeamText. Without them the UTF-8 text is used. */
  readFileBytes?(path: string): Uint8Array
  readStdinBytes?(): Promise<Uint8Array>
  /**
   * B5 integration, fifth round: why the client must not read this absolute path, or null. run() sets it inside a team
   * run (teamReadGuard); every `--file`, `--body-file` and `--prompt-file` asks it before reading.
   */
  refuse?(path: string): string | null
  /** App 2.9.1: the `--part` store of one team run (teamPartsOf); run() sets `parts` from it inside a team run. */
  teamParts?(runId: string): TeamParts
  parts?: TeamParts
}

/**
 * App 2.9.1: the parts of a long `team plan` or `team hire` text a run sent with `--part`, per sub. Claude Code refuses
 * a Bash command over 10,000 characters and a team run has nobody to approve it, while a plan may hold
 * TEAM_PLAN_MAX: the run sends it in parts and the call without `--part` sends them joined by a line break.
 */
export interface TeamParts {
  read(sub: string): string[]
  append(sub: string, text: string): string[]
  clear(sub: string): void
}

/** The subs that take `--part` (SUBS.team), with the cap of their whole text. */
const PART_CAPS: Readonly<Record<string, readonly [number, string]>> = { plan: [TEAM_PLAN_MAX, 'the plan'], hire: [HIRE_TEXT_MAX, 'the role file'] }

/** A `--part` call: nothing goes to the app, the part waits in the client store (run() prints it). */
class TeamPartSaved {
  constructor(readonly parts: number, readonly chars: number) {}
}

/** One JSON file per run and sub under the OS temp folder, never in the data folder or the run cwd. */
function teamPartsOf(runId: string): TeamParts {
  const dir = join(tmpdir(), 'snagentsos-team-parts')
  const safe = runId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'run'
  const file = (sub: string): string => join(dir, `${safe}.${sub}.json`)
  const read = (sub: string): string[] => {
    try {
      const j = JSON.parse(readFileSync(file(sub), 'utf8')) as { parts?: unknown }
      return Array.isArray(j.parts) && j.parts.every((p) => typeof p === 'string') ? (j.parts as string[]) : []
    } catch {
      return []
    }
  }
  return {
    read,
    append(sub, text) {
      const parts = [...read(sub), text]
      mkdirSync(dir, { recursive: true })
      const tmp = `${file(sub)}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ parts }), 'utf8')
      renameSync(tmp, file(sub))
      return parts
    },
    clear(sub) {
      rmSync(file(sub), { force: true })
    },
  }
}

function stdinBytes(): Promise<Buffer> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = []
    process.stdin.on('data', (c: Buffer) => chunks.push(c))
    process.stdin.on('end', () => res(Buffer.concat(chunks)))
    process.stdin.on('error', rej)
  })
}

export const nodeIo: ClientIo = {
  readFile: (path) => readFileSync(path, 'utf8'),
  readStdin: async () => (await stdinBytes()).toString('utf8'),
  cwd: () => process.cwd(),
  readFileBytes: (path) => readFileSync(path),
  readStdinBytes: stdinBytes,
  teamParts: teamPartsOf,
}

const stripBom = (s: string): string => s.replace(/^\uFEFF/, '')

function readUserFile(io: ClientIo, path: string, label: string): string {
  const abs = resolve(io.cwd(), path)
  const why = io.refuse?.(abs)
  if (why) throw new UsageError(`cannot read ${label} ${path}: ${why}`)
  try {
    return stripBom(io.readFile(abs))
  } catch {
    throw new UsageError(`cannot read ${label} ${path}`)
  }
}

/**
 * Files a team run never reads, in any folder (B5 integration, fifth round): the master token, the Claude and Codex
 * logins. Sixth round: every secret file of the data folder (DATA_SECRET_FILES, the list the Read denies of a Claude
 * run share).
 */
const SECRET_FILES: readonly string[] = [...DATA_SECRET_FILES, '.credentials.json', 'auth.json']
/** The default root of the worktrees inside the data folder (registerWorktreeIpc: dataDir()/worktrees): task trees live there. */
const WORKTREES_DIR = 'worktrees'

/**
 * A file's or folder's identity (its volume and file index), the same through every alias of it: a share of the same
 * disk (`\\localhost\C$\...`, `\\<host>\C$\...`, whose realpath stays that share), a mapped or subst drive, a junction.
 * Null when unknown: missing, unreadable, or an index of 0 (a file system without file ids gives it to every file).
 */
function fileIdentity(path: string): string | null {
  try {
    const s = statSync(path, { bigint: true, throwIfNoEntry: false })
    return s && s.ino !== 0n ? `${s.dev}:${s.ino}` : null
  } catch {
    return null
  }
}

/**
 * B5 integration, fifth round (security, a second net: main refuses a live token in any team text): inside a team run
 * (SNAOS_TEAM_RUN) the client reads no file whose realpath is inside the data folder (runtime.json holds the master
 * token; the folder also keeps the team state, the device secrets and the saved accounts) and no file named like one
 * of SECRET_FILES anywhere (runtime.json, the other secrets of the data folder, .credentials.json, auth.json; by its
 * own name or its realpath's). The data folder is every absolute one
 * the run could mean: the shim's (SNAOS_CLI is <dataDir>/bin/snaos), the --runtime one (the shim passes it; another
 * --runtime only adds a folder) and the installed build's. Inside it by path or by identity (`identity`, fileIdentity:
 * a folder above the file is the data folder itself), so a share of the same disk does not get around it. Its
 * `worktrees` folder is the run's own tree (the default root of the task worktrees) and stays readable, as long as the
 * realpath stays in it too. Stdin is no path, also when the shell redirects a file into it (`- < file`): main's
 * live-token refusal and the masking of a run's chat cover the tokens.
 */
export function teamReadGuard(
  flags: Record<string, string | true>,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  realpath: (p: string) => string = realpathSync.native,
  identity: (p: string) => string | null = fileIdentity,
): (path: string) => string | null {
  const p = platform === 'win32' ? win32 : posix
  const key = (x: string): string => (platform === 'win32' ? p.resolve(x).toLowerCase() : p.resolve(x))
  const real = (x: string): string => {
    try {
      return realpath(x)
    } catch {
      return x
    }
  }
  const dirs: string[] = []
  const add = (dir: string): void => {
    // A folder of its own only: never a drive or the file system root, never relative to the cwd.
    if (!p.isAbsolute(dir) || p.dirname(p.resolve(dir)) === p.resolve(dir)) return
    for (const d of [dir, real(dir)]) if (!dirs.includes(key(d))) dirs.push(key(d))
  }
  const cli = env[CLI_ENV.cli]
  if (cli) add(p.dirname(p.dirname(cli)))
  if (typeof flags.runtime === 'string') add(p.dirname(flags.runtime))
  add(p.dirname(defaultRuntimePath(env, platform)))
  const inside = (file: string, dir: string): boolean => file === dir || file.startsWith(dir.endsWith(p.sep) ? dir : dir + p.sep)
  const inData = (file: string): boolean => dirs.some((d) => inside(file, d) && !inside(file, p.join(d, WORKTREES_DIR)))
  // The identities of the data folders and of their worktrees folders, read at the first file only.
  let ids: { data: Set<string>; trees: Set<string> } | null = null
  const idsOf = (): { data: Set<string>; trees: Set<string> } => {
    if (ids) return ids
    ids = { data: new Set(), trees: new Set() }
    for (const d of dirs) {
      const a = identity(d)
      if (a) ids.data.add(a)
      const t = identity(p.join(d, WORKTREES_DIR))
      if (t) ids.trees.add(t)
    }
    return ids
  }
  /** Walks up from `file`: a folder that is a data folder (by identity) before its worktrees folder means inside. */
  const inDataById = (file: string): boolean => {
    const { data, trees } = idsOf()
    if (data.size === 0) return false
    let cur = p.resolve(file)
    for (let i = 0; i < 256; i++) {
      const id = identity(cur)
      if (id && trees.has(id)) return false
      if (id && data.has(id)) return true
      const up = p.dirname(cur)
      if (up === cur) return false
      cur = up
    }
    return false
  }
  return (path) => {
    const forms = [path, real(path)]
    if (forms.some((f) => SECRET_FILES.includes(p.basename(f).toLowerCase()))) return `a team run never reads a ${SECRET_FILES.join(', ')} file (they hold secrets)`
    if (forms.some((f) => inData(key(f)) || inDataById(f))) return `a team run never reads a file of the ${PRODUCT} data folder (it holds the app's token)`
    return null
  }
}

/** The text of `send`, `notify`, `status`, `note`, `needs`: the remaining positionals, joined. */
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

// --- snaos team (app 2.7.0, Teams, design 5.2) --------------------------------

/** The even-length bytes of a UTF-16BE text with each pair swapped, so Node decodes it as UTF-16LE. */
function swapped(b: Buffer): Buffer {
  const out = Buffer.from(b.subarray(0, b.length - (b.length % 2)))
  return out.swap16()
}

/**
 * A UTF-16 text without its BOM, told by its NUL bytes: Latin-range UTF-16LE has them at odd offsets only, UTF-16BE at
 * even ones (a UTF-8 text holds none). Even length, two characters at least and three high bytes in four NUL; else
 * null (a stray NUL in UTF-8 stays UTF-8, and readTeamText refuses it).
 */
function bomlessUtf16(b: Buffer): 'le' | 'be' | null {
  if (b.length % 2 !== 0 || b.length < 4) return null
  const n = Math.min(b.length, 4096)
  let even = 0
  let odd = 0
  for (let i = 0; i < n; i += 2) {
    if (b[i] === 0) even++
    if (b[i + 1] === 0) odd++
  }
  const pairs = n / 2
  if (odd * 4 >= pairs * 3 && even === 0) return 'le'
  if (even * 4 >= pairs * 3 && odd === 0) return 'be'
  return null
}

/**
 * The text of `--file`, `--body-file` or stdin of snaos team (design 5.2, decision 4): a UTF-16LE (FF FE) or
 * UTF-16BE (FE FF) BOM decodes as UTF-16 (Windows PowerShell 5.1 Out-File and Set-Content write those), so does a
 * BOM-less UTF-16 text; anything else is UTF-8 with its BOM stripped. Then the trailing CR/LF goes (a PowerShell pipe
 * adds one). An invalid sequence stays as U+FFFD: readTeamText refuses it.
 */
export function decodeTeamText(bytes: Uint8Array): string {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let text: string
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) text = b.subarray(2).toString('utf16le')
  else if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) text = swapped(b.subarray(2)).toString('utf16le')
  else {
    const u16 = bomlessUtf16(b)
    text = u16 === 'le' ? b.toString('utf16le') : u16 === 'be' ? swapped(b).toString('utf16le') : stripBom(b.toString('utf8'))
  }
  return text.replace(/[\r\n]+$/, '')
}

/**
 * `-` = stdin, else the file (resolved against the client cwd), both through decodeTeamText. Text with U+FFFD or a
 * NUL is a usage error naming the fix: a pipe or a file in another encoding broke it. A run of `?` cannot be told
 * from real text; the Windows guide of the run prompt prevents it instead.
 */
async function readTeamText(io: ClientIo, v: string, flag = 'file'): Promise<string> {
  let bytes: Uint8Array
  if (v === '-') bytes = io.readStdinBytes ? await io.readStdinBytes() : Buffer.from(await io.readStdin(), 'utf8')
  else {
    const path = resolve(io.cwd(), v)
    const why = io.refuse?.(path)
    if (why) throw new UsageError(`cannot read --${flag} ${v}: ${why}`)
    try {
      bytes = io.readFileBytes ? io.readFileBytes(path) : Buffer.from(io.readFile(path), 'utf8')
    } catch {
      throw new UsageError(`cannot read --${flag} ${v}`)
    }
  }
  const text = decodeTeamText(bytes)
  const broken = /�/.test(text) ? 'U+FFFD' : /\u0000/.test(text) ? 'a NUL character' : null
  if (broken)
    throw new UsageError(`the text of ${v === '-' ? 'stdin' : v} is not valid UTF-8 or UTF-16 (it has ${broken}): write the text to a UTF-8 file and pass --${flag} <path>`)
  return text
}

/** A team text: `--file` (or `--body-file`), a lone `-` positional (stdin), else the words joined. */
async function teamBody(pos: string[], file: string | undefined, io: ClientIo, flag = 'file'): Promise<string | undefined> {
  if (file !== undefined) {
    if (pos.length) throw new UsageError(`use either a text or --${flag}`)
    return readTeamText(io, file, flag)
  }
  if (pos.length === 1 && pos[0] === '-') return readTeamText(io, '-', flag)
  return restText(pos)
}

/** Client caps of snaos team (the server re-checks them): characters, as the team counts them. */
function capped(text: string | undefined, max: number, what: string): string | undefined {
  if (text !== undefined && text.length > max) throw new UsageError(`${what} is longer than ${max} characters`)
  return text
}

function needText(text: string | undefined, what: string): string {
  if (text === undefined || text.trim() === '') throw new UsageError(`${what} needs a text, - (stdin) or --file <path>`)
  return text
}

function oneOfFlag<T extends string>(v: string | undefined, name: string, values: readonly T[]): T | undefined {
  if (v === undefined) return undefined
  if (!(values as readonly string[]).includes(v)) throw new UsageError(`--${name} must be ${values.join(', ')}`)
  return v as T
}

function idFlag(v: string | undefined, name: string, re: RegExp, what: string): string | undefined {
  if (v === undefined) return undefined
  if (!re.test(v)) throw new UsageError(`--${name} must be ${what}`)
  return v
}

/** `--blocked-by t-1,t-2` split on commas (spaces and empty pieces dropped); `none` = []. */
export function blockedByFlag(v: string | undefined): string[] | undefined {
  if (v === undefined) return undefined
  if (v.trim() === 'none') return []
  const ids = v.split(',').map((s) => s.trim()).filter((s) => s !== '')
  if (!ids.length) throw new UsageError('--blocked-by needs task ids like t-1,t-2 (or none)')
  for (const id of ids) if (!TASK_ID_RE.test(id)) throw new UsageError(`--blocked-by: "${id}" is not a task id like t-12`)
  if (new Set(ids).size > BLOCKED_BY_MAX) throw new UsageError(`--blocked-by takes ${BLOCKED_BY_MAX} tasks at most`)
  return [...new Set(ids)]
}

/** `--options "A|B|C"` split on `|` (trimmed, empty pieces dropped): 1 to 6 answers, each up to CARD_OPTION_MAX. */
export function optionsFlag(v: string | undefined): string[] | undefined {
  if (v === undefined) return undefined
  const opts = v.split('|').map((s) => s.trim()).filter((s) => s !== '')
  if (!opts.length || opts.length > CARD_OPTIONS_MAX) throw new UsageError(`--options takes 1 to ${CARD_OPTIONS_MAX} answers split by | ("A|B|C")`)
  for (const o of opts) if (o.length > CARD_OPTION_MAX) throw new UsageError(`an answer of --options is longer than ${CARD_OPTION_MAX} characters`)
  return opts
}

/** The request still fits the body cap once JSON-escaped (like checkNoteCall). */
function checkTeamCall(call: RpcCall): RpcCall {
  if (Buffer.byteLength(JSON.stringify({ v: 1, method: call.method, params: call.params }), 'utf8') > CTL_MAX_BODY)
    throw new UsageError('the text is too large to send in one request (1 MB after JSON escaping)')
  return call
}

/**
 * The paths of `team diff` and `team log`: only the words after `--` (no other word), repo relative (not absolute, no
 * drive, no `..`), CTL_TEAM_PATHS_MAX of CTL_TEAM_PATH_MAX characters at most. Main checks them again and keeps them
 * inside the tree after realpath; git gets them after its own `--` only, as literal names (`-- --stat` is a file).
 */
function teamPaths(args: ParsedArgs, label: string): string[] {
  const before = args.dashAt ?? args.positionals.length
  if (before > 0) throw new UsageError(`${label} takes paths only after --: snaos ${label} -- src/a.ts`)
  const paths = args.positionals.slice(before)
  if (paths.length > CTL_TEAM_PATHS_MAX) throw new UsageError(`${label} takes ${CTL_TEAM_PATHS_MAX} paths at most`)
  for (const p of paths) {
    if (p === '' || p.length > CTL_TEAM_PATH_MAX) throw new UsageError(`${label}: a path is empty or longer than ${CTL_TEAM_PATH_MAX} characters`)
    if (/^[\\/]/.test(p) || /^[A-Za-z]:/.test(p) || p.split(/[\\/]/).includes('..')) throw new UsageError(`${label}: ${p} is not relative to the repo (no absolute path, drive or ..)`)
  }
  return paths
}

const TEAM_TASK_VERBS = ['get', 'create', 'update'] as const
/** The flags of each `team task` verb (SUBS.team.task is their union). */
const TEAM_TASK_FLAGS: Record<(typeof TEAM_TASK_VERBS)[number], readonly string[]> = {
  get: [],
  create: ['title', 'body-file', 'assign', 'repo', 'isolation', 'blocked-by', 'priority', 'no-plan', 'parent'],
  update: ['rev', 'title', 'body-file', 'assign', 'priority', 'blocked-by', 'isolation', 'state', 'no-plan', 'needs-plan'],
}
const TASK_STATE_FILTERS = ['todo', 'doing', 'review', 'done', 'blocked', 'cancelled', 'open'] as const
const ISOLATIONS = ['worktree', 'main'] as const
const TASK_ID_TEXT = 'a task id like t-12'

/** snaos team <sub> ...: the RPC of design 5.2 (texts read and capped here, every param re-checked by main). */
async function buildTeamCall(args: ParsedArgs, io: ClientIo): Promise<RpcCall> {
  const { positionals: pos, flags } = args
  const flag = (name: string): string | undefined => (typeof flags[name] === 'string' ? (flags[name] as string) : undefined)
  const on = (name: string): boolean => flags[name] === true
  const none = (label: string): void => {
    if (pos.length) throw new UsageError(`${label} takes no argument`)
  }
  const call = (method: TeamCtlMethod, params: Record<string, unknown>): RpcCall => checkTeamCall({ method, params })
  const fileText = async (p: string[]): Promise<string | undefined> => {
    const text = await teamBody(p, flag('file'), io)
    const cap = args.sub !== undefined ? PART_CAPS[args.sub] : undefined
    if (!cap) return text
    const sub = args.sub as string
    const before = io.parts?.read(sub) ?? []
    if (on('part')) {
      if (!io.parts) throw new UsageError('--part works only inside a team run')
      if (text === undefined || text.trim() === '') throw new UsageError(`team ${sub} --part needs a text, - (stdin) or --file <path>`)
      capped([...before, text].join('\n'), cap[0], cap[1])
      const parts = io.parts.append(sub, text)
      throw new TeamPartSaved(parts.length, parts.join('\n').length)
    }
    // The last part: run() clears the store once the app took the joined text.
    if (!before.length) return text
    return text === undefined || text.trim() === '' ? before.join('\n') : [...before, text].join('\n')
  }
  switch (args.sub) {
    case 'show':
      none('team show')
      return call('team.show', {})
    case 'tasks': {
      none('team tasks')
      const state = oneOfFlag(flag('state'), 'state', TASK_STATE_FILTERS)
      return call('team.tasks', { ...(state ? { state } : {}), ...(on('mine') ? { mine: true } : {}) })
    }
    case 'task': {
      const verb = pos[0]
      if (verb === undefined || !(TEAM_TASK_VERBS as readonly string[]).includes(verb)) throw new UsageError(`team task needs one of: ${TEAM_TASK_VERBS.join(', ')}`)
      const own = TEAM_TASK_FLAGS[verb as (typeof TEAM_TASK_VERBS)[number]]
      for (const name of Object.keys(flags)) if (!own.includes(name) && name !== 'json' && name !== 'runtime' && name !== 'help') throw new UsageError(`--${name} does not apply to team task ${verb}`)
      if (on('no-plan') && on('needs-plan')) throw new UsageError('use either --no-plan or --needs-plan')
      const body = flag('body-file') !== undefined ? capped(await readTeamText(io, flag('body-file')!, 'body-file'), TASK_BODY_MAX, 'the body') : undefined
      const title = capped(flag('title'), TASK_TITLE_MAX, 'the title')
      const priority = oneOfFlag(flag('priority'), 'priority', TASK_PRIORITIES)
      const isolation = oneOfFlag(flag('isolation'), 'isolation', ISOLATIONS)
      const blockedBy = blockedByFlag(flag('blocked-by'))
      const assign = flag('assign')
      if (assign !== undefined && assign !== 'none') idFlag(assign, 'assign', AGENT_ID_RE, 'an agent id (snaos team show) or none')
      if (verb === 'get') {
        if (pos.length !== 2) throw new UsageError('team task get takes one task: t-12')
        return call('team.task.get', { task: idFlag(pos[1], 'task', TASK_ID_RE, TASK_ID_TEXT) })
      }
      if (verb === 'create') {
        if (pos.length > 1) throw new UsageError('team task create takes the title in --title, not as words')
        if (title === undefined || title.trim() === '') throw new UsageError('team task create needs --title <text>')
        const repo = idFlag(flag('repo'), 'repo', REPO_ID_RE, 'a repo id of the team (main or an extra repo)')
        const parent = idFlag(flag('parent'), 'parent', TASK_ID_RE, TASK_ID_TEXT)
        return call('team.task.create', {
          title,
          ...(body !== undefined ? { body } : {}),
          ...(assign !== undefined && assign !== 'none' ? { assign } : {}),
          ...(repo !== undefined ? { repo } : {}),
          ...(isolation ? { isolation } : {}),
          ...(blockedBy?.length ? { blockedBy } : {}),
          ...(priority ? { priority } : {}),
          ...(on('no-plan') ? { noPlan: true } : {}),
          ...(parent !== undefined ? { parent } : {}),
        })
      }
      if (pos.length !== 2) throw new UsageError('team task update takes one task: t-12')
      const task = idFlag(pos[1], 'task', TASK_ID_RE, TASK_ID_TEXT)
      const rev = flag('rev')
      if (rev !== undefined && !/^\d{1,15}$/.test(rev)) throw new UsageError('--rev must be the rev number snaos team task get printed')
      const state = oneOfFlag(flag('state'), 'state', ['todo', 'blocked', 'cancelled'] as const)
      if (title !== undefined && title.trim() === '') throw new UsageError('--title is empty')
      const patch = {
        ...(title !== undefined ? { title } : {}),
        ...(body !== undefined ? { body } : {}),
        ...(assign !== undefined ? { assign: assign === 'none' ? null : assign } : {}),
        ...(priority ? { priority } : {}),
        ...(blockedBy !== undefined ? { blockedBy } : {}),
        ...(isolation ? { isolation } : {}),
        ...(state ? { state } : {}),
        ...(on('no-plan') ? { needsPlan: false } : on('needs-plan') ? { needsPlan: true } : {}),
      }
      if (!Object.keys(patch).length) throw new UsageError('team task update needs a field to change')
      return call('team.task.update', { task, ...(rev !== undefined ? { rev: Number(rev) } : {}), ...patch })
    }
    case 'comment': {
      const target = pos[0]
      if (target === undefined || (target !== LEAD_THREAD && !TASK_ID_RE.test(target))) throw new UsageError('team comment needs a target: a task id like t-12, or lead')
      const text = capped(needText(await fileText(pos.slice(1)), 'team comment'), COMMENT_TEXT_MAX, 'the comment')
      return call('team.comment', { target, text })
    }
    case 'note': {
      const text = capped(needText(await fileText(pos), 'team note'), COMMENT_TEXT_MAX, 'the note')
      const title = capped(flag('title'), WS_NOTE_TITLE_MAX, 'the title')
      return call('team.note', { text, ...(title !== undefined ? { title } : {}) })
    }
    case 'ask': {
      const text = capped(needText(await fileText(pos), 'team ask'), CARD_QUESTION_MAX, 'the question')
      const options = optionsFlag(flag('options'))
      if (on('multi') && !options) throw new UsageError('--multi needs --options "A|B|C"')
      if (on('confirm') && (options || on('multi'))) throw new UsageError('--confirm is a yes or no question: leave out --options and --multi')
      const rec = flag('recommended')
      let recommended: number | undefined
      if (rec !== undefined) {
        if (!options || on('multi')) throw new UsageError('--recommended names one answer of --options "A|B|C": leave out --multi')
        recommended = /^\d{1,2}$/.test(rec) ? Number(rec) : NaN
        if (!(recommended >= 1 && recommended <= options.length)) throw new UsageError(`--recommended takes the number of an answer of --options, from 1 to ${options.length}`)
      }
      return call('team.ask', { text, ...(options ? { options } : {}), ...(on('multi') ? { multi: true } : {}), ...(on('confirm') ? { confirm: true } : {}), ...(recommended ? { recommended } : {}) })
    }
    case 'needs':
      return call('team.needs', { text: capped(needText(await fileText(pos), 'team needs'), CARD_QUESTION_MAX, 'the request') })
    case 'plan':
      return call('team.plan', { text: capped(needText(await fileText(pos), 'team plan'), TEAM_PLAN_MAX, 'the plan'), ...(on('small') ? { small: true } : {}) })
    case 'review':
    case 'done': {
      const text = capped(await fileText(pos), COMMENT_TEXT_MAX, 'the text')
      return call(args.sub === 'review' ? 'team.review' : 'team.done', text !== undefined && text.trim() !== '' ? { text } : {})
    }
    case 'verdict': {
      const verdict = pos[0]
      if (verdict !== 'approve' && verdict !== 'changes') throw new UsageError('team verdict needs approve or changes')
      const text = capped(needText(await fileText(pos.slice(1)), 'team verdict'), COMMENT_TEXT_MAX, 'the verdict')
      return call('team.verdict', { verdict, text })
    }
    case 'approve': {
      none('team approve')
      const plan = idFlag(flag('plan'), 'plan', TASK_ID_RE, TASK_ID_TEXT)
      if (plan === undefined) throw new UsageError('team approve needs --plan <t-N> (the task whose plan you approve)')
      return call('team.approve', { plan })
    }
    case 'diff':
    case 'log': {
      const label = `team ${args.sub}`
      const paths = teamPaths(args, label)
      const task = idFlag(flag('task'), 'task', TASK_ID_RE, TASK_ID_TEXT)
      const common = { ...(task !== undefined ? { task } : {}), ...(paths.length ? { paths } : {}) }
      if (args.sub === 'diff') return call('team.diff', { ...(on('stat') ? { stat: true } : {}), ...common })
      const n = flag('lines')
      if (n !== undefined && (!/^\d{1,2}$/.test(n) || Number(n) < 1 || Number(n) > CTL_TEAM_LOG_N_MAX)) throw new UsageError(`-n must be a whole number from 1 to ${CTL_TEAM_LOG_N_MAX}`)
      return call('team.log', { ...(n !== undefined ? { n: Number(n) } : {}), ...common })
    }
    default:
      // hire (parseArgs admits only the subs of SUBS.team)
      return call('team.hire', { text: capped(needText(await fileText(pos), 'team hire'), HIRE_TEXT_MAX, 'the role file') })
  }
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
          if (!pos[0]) throw new UsageError('account use needs an account: its number (account ls), an id or a label')
          return { method: 'account.use', params: { account: pos.join(' '), ...prov } }
        default:
          if (pos.length) throw new UsageError('account status takes no argument')
          return { method: 'account.status', params: {} }
      }
    }
    case 'needs': {
      const text = restText(pos)
      if (text !== undefined && on('clear')) throw new UsageError('use either a text or --clear')
      if (text === undefined && !on('clear')) throw new UsageError('needs takes a text or --clear')
      if (text !== undefined && !text.trim()) throw new UsageError('empty needs text (use --clear)')
      return { method: 'needs', params: { ...(text !== undefined ? { text } : {}), ...(on('clear') ? { clear: true } : {}), ...(flag('console') !== undefined ? { console: flag('console') } : {}), ...ws } }
    }
    case 'team':
      return buildTeamCall(args, io)
  }
}

// --- Connection --------------------------------------------------------------

export interface Connection {
  endpoint: string
  token: string
  /** A console token (inside a SnAgentsOS console) vs the master token of runtime.json. */
  console: boolean
  /** App 2.7.0 (Teams): the run id of SNAOS_TEAM_RUN when the token is a team run's (its 401 names the run). */
  teamRun?: string
}

export class AppUnavailable extends Error {}

/** App 2.7.0 (Teams, decision 47): a team run without its token; never the runtime.json fallback (exit 6, not 5). */
export class TeamTokenLost extends Error {}

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
 * A runtime.json whose pid is dead means the app is not running. Inside a
 * team run (SNAOS_TEAM_RUN) only its own token counts: a lost one (an agent
 * shell that filtered it) is TeamTokenLost, never the master token.
 */
export function resolveConnection(
  flags: Record<string, string | true>,
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
  alive: (pid: number) => boolean = pidAlive,
): Connection {
  const endpoint = env[CLI_ENV.ctlEndpoint]
  const token = env[CLI_ENV.ctlToken]
  const teamRun = env[CLI_ENV.teamRun]
  if (teamRun && !(endpoint && token)) throw new TeamTokenLost('this team run lost its token')
  // A printable run id of 40 characters at most: it only goes into an error message.
  if (endpoint && token) return { endpoint, token, console: true, ...(teamRun ? { teamRun: teamRun.replace(/[^\x21-\x7e]/g, '').slice(0, 40) } : {}) }
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
            return fail(
              'unauthorized',
              conn.teamRun !== undefined
                ? `the token of team run ${conn.teamRun || '(unknown)'} is no longer valid: the run ended or was stopped, so snaos team answers no more; end your turn`
                : conn.console
                  ? "this console's token is no longer valid, restart the console"
                  : 'unauthorized: runtime.json is stale, restart the terminal',
            )
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

/**
 * App 2.7.0 (A3): main's signals in a few words, the free text last:
 * `failed: limit until 15:30`, `quiet 12m`, `needs: <text>`.
 */
function signalParts(s: CtlStatusSignals, now: number = Date.now()): string[] {
  const out: string[] = []
  if (s.failure) out.push(`failed: ${s.failure.kind}${typeof s.failure.until === 'number' ? ` until ${clock(s.failure.until, now)}` : ''}`)
  if (s.silence) out.push(`${s.silence.level} ${elapsed(s.silence.since, now)}`)
  if (s.needs) out.push(`needs: ${s.needs.text}`)
  return out
}

function consoleRow(c: CtlConsoleInfo): string {
  const state = c.agentState ? `${c.agentState}${c.precise ? '' : '?'}${c.reason ? ` (${c.reason})` : ''}` : c.running ? 'running' : 'stopped'
  const tags = [c.self ? 'self' : '', c.sshProtected ? 'ssh' : ''].filter(Boolean).join(',')
  const tail = [c.statusLine ?? '', ...signalParts(c)].filter(Boolean).join('  ')
  return `   ${pad(String(c.index), 3)}${pad(c.title, 22)} ${pad(c.presetName ?? c.type, 14)} ${pad(state, 22)}${tags ? `[${tags}] ` : ''}${tail}`.trimEnd()
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
  out.push(...signalParts(d))
  for (const p of d.pending ?? []) out.push(`pending: ${p.kind}${p.toolName ? ` ${p.toolName}` : ''}: ${p.summary}`)
  if (d.activity) out.push(`activity: ${d.activity}`)
  if (d.digest) out.push(`turn: ${d.digest.line || `${d.digest.tools} tools`}`)
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
  return span(mins)
}

/** Time since an epoch ms in whole minutes, at least 1: `12m`, `1h 5m`, `2d 3h`. */
export function elapsed(ms: number, now: number = Date.now()): string {
  return span(Math.max(1, Math.floor((now - ms) / 60_000)))
}

/** Minutes as `3d 4h`, `2h 10m` or `5m`. */
function span(mins: number): string {
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return h ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`
  return `${m}m`
}

const pct = (p: number | null | undefined): string => (typeof p === 'number' ? `${Math.round(p)}%` : '-')
type NamedAccount = { label?: string; rank?: number; slot?: string; id?: string }
/** #n of an account (app 2.4.0), else its 2.3.0 slot. */
const rankText = (a: NamedAccount | null | undefined): string => (a && typeof a.rank === 'number' ? `#${a.rank}` : (a?.slot ?? ''))
const accountName = (a: NamedAccount | null | undefined): string => (a ? a.label || rankText(a) || a.id || '?' : 'none')
/** The account name, plus ` (#n)` only when a label names it (#n alone is not repeated). */
const accountNameSlot = (a: NamedAccount | null | undefined): string => `${accountName(a)}${a?.label && rankText(a) ? ` (${rankText(a)})` : ''}`
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
  return `${a.active ? '* ' : '  '}${col(rankText(a), 4)}${col(a.label || '-', 18)}${col(a.plan ?? '', 8)}${win('5h', a.fiveHour)}  ${win('7d', a.sevenDay)}${a.ready ? '' : '  (capture it again on the desktop)'}`.trimEnd()
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
      if ('state' in d) return [`${String(d.state ?? 'no agent state')}${d.statusLine ? `: ${String(d.statusLine)}` : ''}`, ...signalParts(d as CtlStatusSignals)].join('  ')
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
    case 'needs':
      return typeof d.needs === 'string' ? `needs: ${d.needs}` : 'needs cleared'
    // app 2.7.0 (Teams): short English lines; agents are told to use --json.
    case 'team.show':
    case 'team.tasks':
    case 'team.task.get':
    case 'team.diff':
    case 'team.log':
    case 'team.task.create':
    case 'team.task.update':
    case 'team.comment':
    case 'team.note':
    case 'team.ask':
    case 'team.needs':
    case 'team.plan':
    case 'team.review':
    case 'team.verdict':
    case 'team.done':
    case 'team.approve':
    case 'team.hire':
      return teamHuman(method, d)
  }
}

type TaskLine = { id?: unknown; state?: unknown; phase?: unknown; title?: unknown }
const word = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '')
/** `t-12    doing     executing     Fix the login`: the `id state phase title` row of snaos team. */
const taskRow = (t: TaskLine): string => `${pad(word(t.id), 8)}${pad(word(t.state), 10)}${pad(word(t.phase), 14)}${word(t.title)}`.trimEnd()
const CONCLUDED = 'this run is concluded'

function teamHuman(method: TeamCtlMethod, d: Record<string, unknown>): string {
  switch (method) {
    case 'team.show': {
      const team = (d.team ?? {}) as Record<string, unknown>
      const you = (d.you ?? {}) as Record<string, unknown>
      const run = (d.run ?? {}) as Record<string, unknown>
      const out = [`team ${word(team.name)} (${word(team.id)})`, `you: ${word(you.agentId)} (${word(you.kind)}), run ${word(run.id)} (${word(run.mode)})`]
      if (d.task) out.push(`task: ${taskRow(d.task as TaskLine)}`)
      const goal = word(team.goal).split('\n')[0]
      if (goal) out.push(`goal: ${goal}`)
      return out.join('\n')
    }
    case 'team.tasks': {
      const tasks = (d.tasks as TaskLine[] | undefined) ?? []
      return tasks.length ? [taskRow({ id: 'id', state: 'state', phase: 'phase', title: 'title' }), ...tasks.map(taskRow)].join('\n') : 'no tasks'
    }
    case 'team.task.get': {
      const t = (d.task ?? {}) as Record<string, unknown>
      const meta = [`rev ${word(t.rev)}`, word(t.priority), word(t.assignee)].filter(Boolean).join(', ')
      const out = [`${word(t.id)} ${word(t.state)}/${word(t.phase)}  ${word(t.title)}  (${meta})`]
      if (word(t.body)) out.push(word(t.body))
      const plan = t.plan as Record<string, unknown> | undefined
      if (plan) out.push(`--- plan (rev ${word(plan.rev)}, ${word(plan.status)}${plan.small ? ', small' : ''})`, word(plan.text))
      const comments = (t.comments as Array<Record<string, unknown>> | undefined) ?? []
      if (comments.length) {
        out.push('--- comments')
        for (const c of comments) out.push(`${word(c.authorName) || word(c.author)} (${word(c.kind)}): ${c.sys ? `[system note ${word((c.sys as Record<string, unknown>).key)}]` : word(c.text)}`)
      }
      return out.join('\n')
    }
    case 'team.diff':
    case 'team.log':
      // What git printed, as is (main cut it past its cap with a marker line); nothing to show reads as such.
      return typeof d.text === 'string' && d.text !== '' ? d.text : method === 'team.diff' ? 'no changes' : 'no commits'
    case 'team.task.create':
      return `${word(d.id)} created`
    case 'team.task.update':
      return `${word(d.id)} updated${d.rev !== undefined ? ` (rev ${word(d.rev)})` : ''}`
    case 'team.comment':
      return `comment ${word(d.id)} added`
    case 'team.note':
      return `note ${word(d.id)} saved`
    case 'team.ask':
      return `asked the user (${word(d.cardId)}); ${CONCLUDED}`
    case 'team.needs':
      return `told the user what you need (${word(d.cardId)}); ${CONCLUDED}`
    case 'team.plan':
      return `plan sent for approval (${word(d.approvalId)}); ${CONCLUDED}`
    case 'team.review':
      return `sent to review; ${CONCLUDED}`
    case 'team.verdict':
      return `verdict sent; ${CONCLUDED}`
    case 'team.done':
      return `reported done${d.approvalId ? ` (${word(d.approvalId)})` : ''}; ${CONCLUDED}`
    case 'team.approve':
      return `plan approved; ${CONCLUDED}`
    case 'team.hire':
      return `role proposed to the user (${word(d.approvalId)}); ${CONCLUDED}`
  }
}

/** Lines a refused `team hire` prints under its error, at most (main sends 20 at most too). */
const HIRE_ISSUE_LINES_MAX = 20
/** Longest printed issue line. */
const HIRE_ISSUE_LINE_MAX = 300

/** Invisible or layout code points an issue line never prints raw: C0, DEL, C1, soft hyphen, ALM, MVS, zero-width and bidi marks, separators, word joiners, BOM, annotations, tags. */
const HIDDEN_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x202e],
  [0x2060, 0x206f], [0xfeff, 0xfeff], [0xfff9, 0xfffb], [0xe0000, 0xe007f],
]

/** A text of an issue as one printable line: each HIDDEN_RANGES code point written as its escape (u{hex}). */
function issueText(v: unknown): string {
  if (typeof v !== 'string' && typeof v !== 'number') return ''
  let out = ''
  for (const ch of String(v)) {
    const cp = ch.codePointAt(0) ?? 0
    out += HIDDEN_RANGES.some(([a, b]) => cp >= a && cp <= b) ? `\\u{${cp.toString(16)}}` : ch
  }
  return out
}

/**
 * App 2.7.0 (Teams, B5): the definition issues a refused `team hire` carries in `data.issues`, one line each
 * (`  roles/hire.md:3 count: bad_value (9)`), escaped and capped, so the Lead sees what to fix in its role file.
 */
export function hireIssueLines(method: string, data: unknown): string[] {
  if (method !== 'team.hire' || !data || typeof data !== 'object') return []
  const issues = (data as { issues?: unknown }).issues
  if (!Array.isArray(issues)) return []
  const out: string[] = []
  for (const i of issues.slice(0, HIRE_ISSUE_LINES_MAX)) {
    if (!i || typeof i !== 'object') continue
    const x = i as Record<string, unknown>
    const where = `${issueText(x.file) || 'role file'}${typeof x.line === 'number' && x.line > 0 ? `:${x.line}` : ''}`
    const key = issueText(x.key)
    const detail = issueText(x.detail)
    const text = `  ${where} ${key ? `${key}: ` : ''}${issueText(x.code)}${detail ? ` (${detail})` : ''}${x.severity === 'warning' ? ' [warning]' : ''}`
    out.push(text.length > HIRE_ISSUE_LINE_MAX ? `${text.slice(0, HIRE_ISSUE_LINE_MAX - 3)}...` : text)
  }
  if (issues.length > HIRE_ISSUE_LINES_MAX) out.push(`  ... ${issues.length - HIRE_ISSUE_LINES_MAX} more`)
  return out
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
  snaos needs "<action>" | --clear [--console <c>]
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
  snaos account [status] | account ls | account use <n|id|label>
  snaos help [--agent]

Inside a team run only (snaos help --agent, section Teams):
  snaos team show | tasks [--state <state>|open] [--mine] | task get <t-N>
  snaos team diff [--stat] [--task <t-N>] [-- <path>...] | log [-n <1..50>] [--task <t-N>] [-- <path>...]
  snaos team task create --title <t> [--body-file <file>|-] [--assign <agent>] [--repo <id>]
             [--isolation worktree|main] [--blocked-by t-1,t-2] [--priority urgent|high|normal|low]
             [--no-plan] [--parent <t-N>]
  snaos team task update <t-N> [--rev <n>] [--title <t>] [--body-file <file>|-] [--assign <agent>|none]
             [--priority <p>] [--blocked-by t-1,t-2|none] [--isolation <i>] [--state todo|blocked|cancelled]
             [--no-plan | --needs-plan]
  snaos team comment <t-N|lead> <text|-> | --file <file>|-
  snaos team note [--title <t>] | ask [--options "A|B|C"] [--recommended <n>] [--multi] [--confirm] | needs <text|-> | --file <file>|-
  snaos team plan --file <file>|- [--small] [--part] | review | done [<text|-> | --file <file>|-]
  snaos team verdict approve|changes <text|-> | --file <file>|-
  snaos team approve --plan <t-N> | hire --file <file>|-
             (hire: a whole role file; an optional id: line in its frontmatter names the role, else the slug of name)

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
  let io: ClientIo = deps.io
  try {
    args = parseArgs(argv)
    json = args.flags.json === true
    if (args.flags.help === true && args.command !== 'help') {
      deps.out(USAGE)
      return 0
    }
    // B5 integration, fifth round: a team run reads no file of the data folder and no credentials file (teamReadGuard).
    const teamRun = deps.env[CLI_ENV.teamRun]
    io = teamRun ? { ...deps.io, refuse: teamReadGuard(args.flags, deps.env), ...(deps.io.teamParts ? { parts: deps.io.teamParts(teamRun) } : {}) } : deps.io
    call = await buildCall(args, io)
  } catch (e) {
    if (e instanceof TeamPartSaved) {
      const data = { part: e.parts, chars: e.chars }
      if (json) deps.out(JSON.stringify({ ok: true, data }))
      else deps.out(`part ${e.parts} kept (${e.chars} characters in all): send the last part without --part`)
      return 0
    }
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
    if (e instanceof TeamTokenLost) return fail('unauthorized', e.message, CTL_EXIT.unauthorized)
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
    if (!json) {
      deps.err(`snaos: ${res.error.message}`)
      for (const line of hireIssueLines(call.method, res.data)) deps.err(line)
    }
    return CTL_EXIT[res.error.code] ?? 1
  }
  // The joined text reached the app: its parts go (a refused call keeps them for the next try).
  if (args.command === 'team' && args.sub !== undefined && PART_CAPS[args.sub] && io.parts) io.parts.clear(args.sub)
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
