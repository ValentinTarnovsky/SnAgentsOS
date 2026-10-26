// Adaptado de paperclipai/paperclip (MIT) - packages/adapters/codex-local/src/server/codex-args.ts
/**
 * The argv of a team run (app 2.7.0, Tanda B, design 2.6 and 5.4; spike
 * results S1, S4 and S9 in E10). Pure, no Node or DOM.
 *
 * Nothing the user or an agent wrote ever enters argv: the prompt goes by
 * stdin and the instructions by a file; every value here comes from an
 * allowlist (models, efforts, tool patterns) or is a path main built
 * (systemFile, cwd, protect). A value that fails its check is left out.
 */
import type { AgentProvider } from './types'
import type { PermissionProfile, RunMode } from './teams'
import { CLAUDE_EFFORTS, isClaudeModel } from './agentTune'
import { CODEX_EFFORTS, CODEX_MODEL_RE, validToolPattern } from './teamDefinition'

/**
 * Only the Bash twin (E10 SPIKE, deviation of design decision 2): on Windows PowerShell finds `snaos` as the
 * `snaos.cmd` shim, which hands `%*` to cmd.exe, so an argument like `x&calc` (no spaces, so PowerShell does not
 * quote it) would run `calc` outside the profile. Git Bash runs the extensionless sh shim, which passes the
 * arguments to the CLI with no cmd parsing (S9). No allow list ever carries a PowerShell rule that names the CLI.
 */
export const CLAUDE_TEAM_TOOLS = ['Bash(snaos team:*)'] as const
/**
 * B5 integration, fourth round (security, E10 SPIKE, a deviation of the B2 readonly profile): no git log, git diff
 * nor git show. Their options come in any order, so no deny rule fences them: `--output=<file>` writes any file (a
 * repo script a granted command runs next, the git config, the decision 72 paths, which the Edit and Write denies do
 * not cover for Bash), and `git diff --no-index` reads any one (runtime.json). A readonly run reads code changes and
 * history through main instead (`snaos team diff`, `snaos team log`); `git status` stays.
 * Fifth round: only its Bash rule. A PowerShell `$(...)` subexpression inside an allowed prefix could run another
 * command, and how the permission check reads one is unverified; the deny lists keep their PowerShell twins.
 */
export const CLAUDE_READONLY_ALLOW = [
  'Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite',
  'Bash(git status:*)',
] as const
export const CLAUDE_READONLY_DENY = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const
export const CLAUDE_TOTAL_DENY = [
  'Bash(git push:*)', 'Bash(git merge:*)', 'Bash(git worktree:*)', 'Bash(git update-ref:*)', 'Bash(git send-pack:*)', 'Bash(git http-push:*)',
  'PowerShell(git push:*)', 'PowerShell(git merge:*)', 'PowerShell(git worktree:*)', 'PowerShell(git update-ref:*)', 'PowerShell(git send-pack:*)', 'PowerShell(git http-push:*)',
] as const
/** Every Claude team run, new and resume: no project settings, hooks or MCP servers from the run cwd (decision 34). */
export const CLAUDE_ISOLATION_FLAGS = ['--setting-sources', 'user', '--strict-mcp-config'] as const

/**
 * The secret files of the data folder by their name in dataDir() (decision 72, B5 integration, sixth round): the
 * master token (runtime.json), the phones' device secrets (remote-devices.json), the Web Push keys (push-keys.json),
 * the Share host identity, grants and links (share-identity.json, share-grants.json, share-links.json: sealed with
 * safeStorage, which any process of the user can open) and the 1.x backup with its config and devices
 * (migration-backup-v1.zip). Names no repo gives a file of its own, so the client guard of a team run (cliEntry
 * teamReadGuard) refuses them in any folder too, next to the Claude and Codex logins. One list for both sides.
 */
export const DATA_SECRET_FILES = ['runtime.json', 'remote-devices.json', 'push-keys.json', 'share-identity.json', 'share-grants.json', 'share-links.json', 'migration-backup-v1.zip'] as const
/**
 * What every Claude run may never Read (TeamService.protectPaths, joined to dataDir()): DATA_SECRET_FILES, plus the
 * secrets whose names are common elsewhere, which the client guard refuses inside the data folder only (it refuses
 * every file there anyway): config.json, its last copy and its backups (the ntfy token, the Discord webhook, the hooks
 * token) and the saved Claude logins (claude-accounts/, sealed with safeStorage). A trailing `/` marks a folder.
 */
export const DATA_SECRET_PATHS = [...DATA_SECRET_FILES, 'config.json', 'config.json.bak', 'backups/', 'claude-accounts/'] as const

/** The git commands no team run may run (CLAUDE_TOTAL_DENY, as command prefixes); send-pack and http-push are git push's plumbing. */
const DENIED_COMMANDS = ['git push', 'git merge', 'git worktree', 'git update-ref', 'git send-pack', 'git http-push']
/** A first word that names the CLI: `snaos`, its Windows shims (`snaos.cmd`), a path to one, or its env var. */
const CLI_WORD_RE = /^(?:.*[\\/])?snaos(?:\.(?:cmd|bat|exe))?$|snaos_cli/i
/** The file names of CLI_WORD_RE, for a one-word prefix rule that could still grow into one. */
const CLI_NAMES = ['snaos', 'snaos.cmd', 'snaos.bat', 'snaos.exe']
/** Claude and Codex session / thread ids are UUIDs (fixtures of S1 and S4). */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A plan-mode run is always readonly (plan 3.4); otherwise the role's profile. */
export function effectiveProfile(permission: PermissionProfile, mode: RunMode): PermissionProfile {
  return mode === 'plan' ? 'readonly' : permission
}

/** True when the role's base permission writes (total, custom): it decides the task worktree (decision 24) and the write lock. */
export function roleWrites(permission: PermissionProfile): boolean {
  return permission === 'total' || permission === 'custom'
}

/**
 * Claude's absolute-path rule form (`//` + the path with forward slashes, then the glob) for main-built paths only.
 * Its exact Windows spelling is a B2 manual haiku check item (9.1 risk 2); a wrong spelling only loses this hardening.
 *
 * Claude Code matches Windows paths in their POSIX form (`C:\Users\a` is `/c/Users/a`), so a drive path is written
 * `//c/Users/a/...`; a POSIX path `/home/a` is `//home/a`.
 */
export function claudePathRule(tool: 'Read' | 'Edit' | 'Write' | 'MultiEdit', absPath: string, glob?: '/**'): string {
  let p = absPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const drive = /^([A-Za-z]):(?:\/|$)/.exec(p)
  if (drive) p = `${drive[1].toLowerCase()}${p.slice(2)}`
  p = p.replace(/^\/+/, '')
  return `${tool}(//${p}${glob ?? ''})`
}

export interface TeamArgvInput {
  provider: AgentProvider
  profile: PermissionProfile                       // effectiveProfile(...)
  allowedTools?: readonly string[]                 // custom role list
  grants?: readonly string[]                       // task.grants of this role (approved permission asks)
  model?: string; effort?: string                  // validated by the definition parser; 'default' omitted
  session: { kind: 'new'; sessionId?: string /* Claude: required */ } | { kind: 'resume'; sessionId: string }
  systemFile?: string                              // Claude: absolute teams/<id>/runs/<runId>.system.md (every run, resume included)
  cwd: string                                      // Codex new thread: -C
  /**
   * Decision 72, built in main from dataDir(): Read deny of runtime.json (since the sixth round of the B5 integration,
   * of every DATA_SECRET_PATHS entry); Edit/Write/MultiEdit deny of teams/**, trusted-teams.json, runtime.json.
   * A path that ends with a separator is a folder and gets only its `/**` rule; any other path gets both its exact
   * rule and its `/**` rule (a file then simply has nothing under it), so a folder passed without the separator is
   * still covered.
   */
  protect?: { readDeny: readonly string[]; writeDeny: readonly string[] }   // absolute paths, never user text
}
export interface TeamArgv {
  argv: string[]
  sandbox?: 'read-only' | 'danger-full-access'     // Codex only
  /** Codex readonly/custom: actions travel in a ```snaos-team block (decision 7). */
  reportsByBlock: boolean
  /** Codex new thread: the system text goes at the top of stdin (decision 8). */
  instructionsInStdin: boolean
}

/** Keeps the first occurrence of each item, in order. */
function dedupe(items: readonly string[]): string[] {
  return [...new Set(items)]
}

function sessionIdOf(id: string | undefined): string {
  if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) throw new Error('teamArgv: the session id is not a UUID')
  return id
}

/** The protect rules of one path (see TeamArgvInput.protect). */
function pathRules(tools: ReadonlyArray<'Read' | 'Edit' | 'Write' | 'MultiEdit'>, p: string): string[] {
  if (typeof p !== 'string' || p.trim() === '') return []
  const folder = /[\\/]$/.test(p)
  return tools.flatMap((t) => (folder ? [claudePathRule(t, p, '/**')] : [claudePathRule(t, p), claudePathRule(t, p, '/**')]))
}

function protectRules(protect: TeamArgvInput['protect']): string[] {
  if (!protect) return []
  return [...protect.readDeny.flatMap((p) => pathRules(['Read'], p)), ...protect.writeDeny.flatMap((p) => pathRules(['Edit', 'Write', 'MultiEdit'], p))]
}

function claudeArgv(i: TeamArgvInput): string[] {
  const argv = ['-p', '--output-format', 'stream-json', '--verbose', ...CLAUDE_ISOLATION_FLAGS]
  argv.push(i.session.kind === 'new' ? '--session-id' : '--resume', sessionIdOf(i.session.sessionId))
  if (i.model && i.model !== 'default' && isClaudeModel(i.model)) argv.push('--model', i.model)
  if (i.effort && (CLAUDE_EFFORTS as readonly string[]).includes(i.effort)) argv.push('--effort', i.effort)
  if (i.systemFile) argv.push('--append-system-prompt-file', i.systemFile)
  const protect = protectRules(i.protect)
  // Grants only on allowlist profiles (total needs none) and never one that reopens what the profile denies.
  const grants = (i.grants ?? []).filter(isGrantable)
  if (i.profile === 'total') {
    argv.push('--permission-mode', 'bypassPermissions', '--disallowedTools', ...dedupe([...CLAUDE_TOTAL_DENY, ...protect]))
  } else if (i.profile === 'readonly') {
    argv.push('--permission-mode', 'dontAsk')
    argv.push('--allowedTools', ...dedupe([...CLAUDE_READONLY_ALLOW, ...CLAUDE_TEAM_TOOLS, ...grants]))
    // B close: the git fence too. `--setting-sources user` keeps the user's own permissions.allow, and under dontAsk
    // only a deny wins over one (a global `Bash(git:*)` would let a readonly or plan run push or merge).
    argv.push('--disallowedTools', ...dedupe([...CLAUDE_READONLY_DENY, ...CLAUDE_TOTAL_DENY, ...protect]))
  } else {
    // A role's own shell rule for the CLI adds nothing a run needs (CLAUDE_TEAM_TOOLS is there; every other command
    // but ping and usage answers forbidden to a team run) and could reopen the cmd.exe hole: PowerShell(snaos ...),
    // or Bash(snaos.cmd ...), since Git Bash also hands a .cmd to cmd.exe. Dropped.
    const own = (i.allowedTools ?? []).filter((t) => validToolPattern(t) && !namesCli(shellSpec(t) ?? ''))
    argv.push('--permission-mode', 'dontAsk')
    argv.push('--allowedTools', ...dedupe([...own, ...CLAUDE_TEAM_TOOLS, ...grants]))
    argv.push('--disallowedTools', ...dedupe([...CLAUDE_TOTAL_DENY, ...protect]))
  }
  return argv
}

function codexArgv(i: TeamArgvInput, sandbox: 'read-only' | 'danger-full-access'): string[] {
  const tune: string[] = []
  if (i.model && i.model !== 'default' && CODEX_MODEL_RE.test(i.model)) tune.push('-m', i.model)
  if (i.effort && (CODEX_EFFORTS as readonly string[]).includes(i.effort)) tune.push('-c', `model_reasoning_effort=${JSON.stringify(i.effort)}`)
  // S4: `exec` has no -a; `exec resume` takes neither -C nor -s (its cwd is the spawn cwd, the sandbox goes by -c).
  if (i.session.kind === 'new') {
    return ['exec', '--json', '--skip-git-repo-check', '-C', i.cwd, ...tune, '-c', 'approval_policy="never"', '-s', sandbox, '-']
  }
  return ['exec', 'resume', sessionIdOf(i.session.sessionId), '--json', '--skip-git-repo-check', ...tune, '-c', 'approval_policy="never"', '-c', `sandbox_mode="${sandbox}"`, '-']
}

/**
 * Claude: -p --output-format stream-json --verbose ...CLAUDE_ISOLATION_FLAGS (--session-id <uuid> | --resume <uuid>) [--model m] [--effort e]
 *   --append-system-prompt-file <file> --permission-mode <mode> [--allowedTools ...] [--disallowedTools ...]
 *   total:    bypassPermissions, --disallowedTools ...CLAUDE_TOTAL_DENY ...protect rules
 *   readonly: dontAsk, --allowedTools ...CLAUDE_READONLY_ALLOW ...CLAUDE_TEAM_TOOLS ...grants, --disallowedTools ...CLAUDE_READONLY_DENY ...protect rules
 *   custom:   dontAsk, --allowedTools ...allowedTools (but a shell rule that names the CLI) ...CLAUDE_TEAM_TOOLS ...grants, --disallowedTools ...CLAUDE_TOTAL_DENY ...protect rules
 *   protect rules: claudePathRule('Read', p) per readDeny, claudePathRule(Edit|Write|MultiEdit, p[, '/**']) per writeDeny.
 * Codex new:    exec --json --skip-git-repo-check -C <cwd> [-m m] [-c model_reasoning_effort="e"] -c approval_policy="never" -s <sb> -
 * Codex resume: exec resume <thread> --json --skip-git-repo-check [-m m] [-c model_reasoning_effort="e"] -c approval_policy="never" -c sandbox_mode="<sb>" -
 *   sb: total danger-full-access; readonly and custom read-only (reportsByBlock: Codex has no tool allowlist).
 * No user text ever enters argv; values come from allowlists and main-built paths (systemFile, cwd, protect) only. Deduplicates tool lists keeping first order.
 *
 * Throws when the session id is not a UUID (Claude needs one for a new session too): main mints and stores them.
 */
export function teamArgv(i: TeamArgvInput): TeamArgv {
  if (i.provider === 'claude') return { argv: claudeArgv(i), reportsByBlock: false, instructionsInStdin: false }
  // S4: read-only and workspace-write both deny the CLI's named pipe, so only total can call `snaos team`.
  const sandbox = i.profile === 'total' ? 'danger-full-access' : 'read-only'
  return { argv: codexArgv(i, sandbox), sandbox, reportsByBlock: sandbox === 'read-only', instructionsInStdin: i.session.kind === 'new' }
}

/** `Bash(<spec>)` / `PowerShell(<spec>)`: the command spec, else null. */
function shellSpec(tool: string): string | null {
  const m = /^(?:Bash|PowerShell)\((.*)\)$/.exec(tool)
  return m ? m[1] : null
}

/** True when a shell pattern could match a command of CLAUDE_TOTAL_DENY (prefix rules match by text). */
function coversDenied(spec: string): boolean {
  const prefix = spec.endsWith(':*')
  const body = (prefix ? spec.slice(0, -2) : spec).replace(/\s+/g, ' ').trim().toLowerCase()
  // Any other wildcard could match anything.
  if (body.includes('*')) return true
  // The command as git runs it: past its `NAME=value` words, its program without a folder or `.exe` (`CI=1 git push`,
  // `/usr/bin/git push` and `git.exe -c x=y log` are git's too). Only assignments: a prefix could still reach git.
  const words = body === '' ? [] : body.split(' ')
  const program = programAt(words)
  if (program === -1) return prefix
  const cmd = [programName(words[program]), ...words.slice(program + 1)].join(' ')
  // Git's global options come before the subcommand (`git -C <dir> push`), so a grant that starts with one could
  // reach every denied command: an agent's `git -C <dir> log` denial must never become `Bash(git -C:*)`.
  if (/^git -/.test(cmd)) return true
  return DENIED_COMMANDS.some((d) => (prefix && d.startsWith(cmd)) || cmd === d || cmd.startsWith(`${d} `))
}

/**
 * True when a shell pattern could match a call of the CLI: its first word names it (CLI_WORD_RE, after PowerShell's
 * `&` call or `.` dot-source operator, which run the next word), or a one-word prefix rule whose name (after its
 * folder) could still grow into one of CLI_NAMES (`sna:*`, `snaos.c:*`, `C:/bin/sn:*`: prefix rules match by text).
 */
function namesCli(spec: string): boolean {
  const prefix = spec.endsWith(':*')
  const body = (prefix ? spec.slice(0, -2) : spec).replace(/\s+/g, ' ').trim().replace(/^(?:&|\.(?= |$)) ?/, '')
  const first = body.split(' ')[0] ?? ''
  if (CLI_WORD_RE.test(first)) return true
  const name = first.replace(/^.*[\\/]/, '').toLowerCase()
  return prefix && first === body && CLI_NAMES.some((n) => n.startsWith(name))
}

/** A `NAME=value` word before the program of a command (`CI=1 npm test`). */
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

/** The words of a shell pattern's spec (single spaces) and whether it is a `:*` prefix rule. */
function specWords(spec: string): { prefix: boolean; words: string[] } {
  const prefix = spec.endsWith(':*')
  const body = (prefix ? spec.slice(0, -2) : spec).replace(/\s+/g, ' ').trim()
  return { prefix, words: body === '' ? [] : body.split(' ') }
}

/** Index of the program word (the first that is not a `NAME=value` assignment), -1 when there is none. */
function programAt(words: readonly string[]): number {
  return words.findIndex((w) => !ASSIGN_RE.test(w))
}

/** True when a word of a shell pattern names a Windows batch file (`npm.cmd`, `C:/x/build.bat`, `env npm.cmd`): Git Bash hands it to cmd.exe, which parses `%*` again. */
function namesBatch(spec: string): boolean {
  return specWords(spec).words.some((w) => /\.(?:cmd|bat)$/i.test(w))
}

/**
 * Programs that run another command or a shell, never grantable (B5, E10 SPIKE): a grant of one would allow anything.
 * The shells and wrappers the security decision names, plus the other POSIX shells and the plain wrappers of the
 * same kind (they only start the command that follows).
 */
const SHELL_ESCAPES: ReadonlySet<string> = new Set([
  'bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'csh', 'tcsh', 'busybox', 'cmd', 'powershell', 'pwsh', 'wsl',
  'env', 'xargs', 'eval', 'exec', 'sudo', 'doas', 'su', 'runas', 'start', 'nohup', 'timeout', 'nice', 'time', 'command',
  'builtin', 'stdbuf', 'setsid', 'chroot', 'ionice', 'taskset', 'unbuffer',
])
/** Interpreters and the word that makes them run code given inline (node -e/-p/--eval, python -c, ruby -e, perl -e, deno eval, bun -e). */
const INLINE_CODE: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [/^node(?:js)?$/, /^(?:-[a-z]*[ep][a-z]*|--(?:eval|print)(?:=.*)?)$/i],
  [/^bun$/, /^(?:-[a-z]*[ep][a-z]*|--(?:eval|print)(?:=.*)?)$/i],
  [/^(?:python[0-9.]*|pythonw|py)$/, /^-[a-z]*c/i],
  [/^(?:ruby|perl[0-9.]*)$/, /^-[a-z]*e/i],
  [/^deno$/, /^(?:eval|-[a-z]*e)$/i],
]

/** A program word as a name: no folder, lowercase, no `.exe`. */
function programName(word: string): string {
  return word.replace(/^.*[\\/]/, '').toLowerCase().replace(/\.exe$/, '')
}

/**
 * The only commands a grant names as a `:*` prefix rule (B5 integration, third round, security, E10 SPIKE): well
 * understood test, build, lint and git read commands. Every other grantable denial gets the exact command rule
 * (grantPatternOf), which shows the user exactly what will run: a denylist of runners and launchers (`npx`, `npm exec`,
 * `find -exec`, `go run`, `cross-env`...) can never be complete, this list is. Each row is a program, as programName
 * reads it (no folder, no `.exe`, lowercase: `./gradlew` is `gradlew`, `git.exe` is `git`), and the words that follow
 * it, matched past the command's `NAME=value` words: a literal word must be equal, `<target>` is one word that names
 * something in the repo (repoWord: `make all`, `pytest tests/x.py`) and `<script>` such a word that ends in .js, .cjs,
 * .mjs, .ts or .py (`node scripts/build.js`). The prefix rule is the row's words (two at least, decision 1): only
 * `npx tsc`, `npx eslint`, `npx prettier`, `npx vitest` and `npx jest` of npx. `git grep` is not here although it
 * reads: its `-O<pager>` runs a command through the shell. Nor, since the fourth round (security), `git log`, `git
 * diff`, `git show` and `git blame` (`--output=<file>` writes any file, `diff --no-index` and `blame --contents` read
 * any one: `snaos team diff` and `snaos team log` read through main instead) or `git branch --list` (`--list --no-list
 * -D <branch>` deletes a branch); a denial of one gets its exact rule like any other command. A row still runs code
 * of the repo (a package script, a make recipe, a test) and takes its program's flags.
 */
export const GRANT_PREFIX_ALLOWLIST: ReadonlyArray<readonly string[]> = [
  ['npm', 'test'], ['npm', 'run'], ['pnpm', 'test'], ['pnpm', 'run'], ['yarn', 'test'], ['yarn', 'run'], ['bun', 'test'],
  ['cargo', 'test'], ['cargo', 'build'], ['cargo', 'check'], ['cargo', 'clippy'], ['cargo', 'fmt'],
  ['go', 'test'], ['go', 'build'], ['go', 'vet'], ['dotnet', 'test'], ['dotnet', 'build'], ['mvn', 'test'], ['mvn', 'verify'],
  ['gradle', 'test'], ['gradle', 'build'], ['gradlew', 'test'], ['gradlew', 'build'],
  ['python', '-m', 'pytest'], ['python3', '-m', 'pytest'], ['py', '-m', 'pytest'], ['pytest', '<target>'], ['make', '<target>'],
  ['npx', 'tsc'], ['npx', 'eslint'], ['npx', 'prettier'], ['npx', 'vitest'], ['npx', 'jest'],
  ['node', '<script>'], ['python', '<script>'],
  ['git', 'status'], ['git', 'ls-files'], ['git', 'rev-parse'],
]

/** A word that names something in the repo: no option, assignment or root (`/`, `~`, a drive) and no `..` segment. */
function repoWord(word: string): boolean {
  return !/^(?:[-~/]|[A-Za-z]:)/.test(word) && !word.includes('=') && !word.split('/').includes('..')
}

/** One word of a GRANT_PREFIX_ALLOWLIST row against one word of a command. */
function rowWordFits(want: string, word: string): boolean {
  if (want === '<target>') return repoWord(word)
  if (want === '<script>') return repoWord(word) && /\.(?:js|cjs|mjs|ts|py)$/i.test(word)
  return word === want
}

/** The number of words, from the program at `program`, that a row of GRANT_PREFIX_ALLOWLIST takes; 0 when none fits. */
function allowlistedAt(words: readonly string[], program: number): number {
  const name = programName(words[program])
  for (const [prog, ...rest] of GRANT_PREFIX_ALLOWLIST) {
    if (prog === name && rest.every((w, i) => words[program + 1 + i] !== undefined && rowWordFits(w, words[program + 1 + i]))) return 1 + rest.length
  }
  return 0
}

/**
 * True when `words` (a command's leading plain words, or a rule's) start a shell or an escape wrapper (SHELL_ESCAPES),
 * or an interpreter with an inline code word among the options after it. `prefix`: a rule that ends with an option of
 * an interpreter could still grow into its inline code flag by text (`Bash(node --inspect:*)` matches `node --inspect -e`).
 */
function escapeWords(words: readonly string[], prefix: boolean): boolean {
  const program = programAt(words)
  if (program === -1) return false
  const name = programName(words[program])
  if (SHELL_ESCAPES.has(name)) return true
  const inline = INLINE_CODE.find(([prog]) => prog.test(name))?.[1]
  if (!inline) return false
  for (let i = program + 1; i < words.length; i++) {
    if (inline.test(words[i])) return true
    if (!words[i].startsWith('-')) return false
  }
  return prefix && words.length > program + 1
}

/**
 * TOOL_PATTERN_RE shape, not covered by CLAUDE_TOTAL_DENY (a git push grant is never offered), not `mcp__*` (no MCP loads: --strict-mcp-config), not `Task` / `Agent`.
 * Never a shell pattern that names the CLI: `Bash(snaos team:*)` is on every allow list already, every other `snaos`
 * command answers forbidden to a team run, and a PowerShell one would reach cmd.exe through `snaos.cmd` (CLAUDE_TEAM_TOOLS).
 *
 * Never a PowerShell rule at all (E10 SPIKE, B5, a deviation of decision 2): on Windows a `.cmd` or `.bat` program
 * (npm.cmd, npx.cmd, yarn.cmd, pnpm.cmd, the snaos.cmd shim) hands `%*` to cmd.exe, so `PowerShell(npm test:*)` would
 * let an argument like `x&calc` run a second command outside the grant. A grant is a `Bash(...)` rule only, and the
 * allow list of a run drops any other shell rule it finds in the task's grants (teamArgv filters them through here).
 * Nor a Bash rule that names such a batch file (namesBatch): Git Bash hands it to cmd.exe the same way; nor a shell or
 * interpreter escape (escapeWords: `bash`, `env`, `xargs`, `node -e`, `python -c`...), which would allow any command.
 *
 * B5 integration, third round (security, E10 SPIKE): every word of a Bash rule is a plain word (PLAIN_WORD_RE: no
 * backslash, `$`, backtick, quote, glob, redirection or operator; TOOL_PATTERN_RE already keeps quotes out, and a quote
 * would reach cmd.exe when the CLI is a `.cmd`) without a `%` (cmd.exe would expand a `%VAR%` of it), so its text is
 * what runs. A `:*` prefix rule only for a row of GRANT_PREFIX_ALLOWLIST, past its `NAME=value` words and no longer
 * (`Bash(npm test:*)`, `Bash(CI=1 make all:*)`): a prefix outside the list, also one written by an older version into
 * `task.grants`, is refused. Any other command is grantable only as its exact rule (`Bash(npx tsc --noEmit)`), which
 * must also pass isShellEscape as a whole.
 */
export function isGrantable(tool: string): boolean {
  if (!validToolPattern(tool)) return false
  const name = tool.replace(/\(.*$/, '')
  if (/^mcp__/i.test(name) || name === 'Task' || name === 'Agent') return false
  if (/^powershell$/i.test(name)) return false
  if (name === 'Bash') {
    const spec = shellSpec(tool)
    if (spec === null) return false
    const { prefix, words } = specWords(spec)
    // No `%` either: when Claude's CLI is a `.cmd` (agentCli spawnTarget), cmd.exe expands `%VAR%` in its argv, also
    // inside quotes, so the run would get another rule than the one the user approved (`rm -rf %SystemDrive%/`).
    if (words.length === 0 || !words.every((w) => PLAIN_WORD_RE.test(w) && !w.includes('%'))) return false
    // A bare shell grant is every command, git push included.
    if (coversDenied(spec) || namesCli(spec) || namesBatch(spec) || escapeWords(words, prefix)) return false
    if (!prefix) return !isShellEscape(spec)
    const program = programAt(words)
    return program !== -1 && allowlistedAt(words, program) === words.length - program
  }
  return true
}

/** A word of a command that may go in a grant pattern: no quotes, operators, variables or path separators of Windows. */
const PLAIN_WORD_RE = /^[A-Za-z0-9_.\/:@%+=,~-]+$/
/** A heredoc that starts at `lastIndex` (`<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`, `<<\EOF`), for commandParts. */
const HEREDOC_RE = /<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|(\\?)([A-Za-z_][A-Za-z0-9_.-]*))/y

/** The leading plain words of one command text. */
function plainWords(text: string): string[] {
  const words: string[] = []
  for (const w of text.trim().split(/\s+/)) {
    if (!PLAIN_WORD_RE.test(w)) break
    words.push(w)
  }
  return words
}

/**
 * The commands of a shell command text, for isShellEscape (a scan of its quotes, not a full parser). A command ends at
 * `&&`, `||`, `;`, `|`, `&` or a newline outside quotes; `$(`, `(` and a backtick start one inside it (`$(` and a
 * backtick also inside double quotes, where they still run), and its `)` or closing backtick goes back to the outer
 * one. Single-quoted text, a `#` comment and the body of a heredoc are data, but the `$(` and the backticks of a
 * heredoc whose delimiter is not quoted. So `git commit -m "Fix the header & start page"` and a commit message in a
 * heredoc are one command each (never `start page`), while `echo "$(bash -c x)"` and `cat x | sh` name their shell.
 */
function commandParts(text: string): string[] {
  const parts: string[] = []
  type Frame = { cur: string; dq: boolean; close: '' | ')' | '`' }
  const stack: Frame[] = [{ cur: '', dq: false, close: '' }]
  const heredocs: Array<{ word: string; strip: boolean; literal: boolean }> = []
  const flush = (f: Frame): void => {
    if (f.cur.trim()) parts.push(f.cur)
    f.cur = ''
  }
  const heredocAt = (at: number): RegExpExecArray | null => {
    HEREDOC_RE.lastIndex = at
    return HEREDOC_RE.exec(text)
  }
  let i = 0
  while (i < text.length) {
    const f = stack[stack.length - 1]
    const ch = text[i]
    const two = text.slice(i, i + 2)
    if (ch === '\\') {
      f.cur += two
      i += 2
    } else if (two === '$(' || (ch === '(' && !f.dq)) {
      stack.push({ cur: '', dq: false, close: ')' })
      i += ch === '(' ? 1 : 2
    } else if (ch === '`') {
      if (f.close === '`' && !f.dq) {
        flush(f)
        stack.pop()
      } else stack.push({ cur: '', dq: false, close: '`' })
      i++
    } else if (f.dq) {
      if (ch === '"') f.dq = false
      f.cur += ch
      i++
    } else if (ch === '"') {
      f.dq = true
      f.cur += ch
      i++
    } else if (ch === "'" || (ch === '#' && (f.cur === '' || /\s/.test(f.cur[f.cur.length - 1])))) {
      // A single-quoted text up to its quote, a comment up to its line end: data.
      const end = ch === "'" ? text.indexOf("'", i + 1) : text.indexOf('\n', i)
      const stop = end === -1 ? text.length : ch === "'" ? end + 1 : end
      if (ch === "'") f.cur += text.slice(i, stop)
      i = stop
    } else if (ch === ')' && f.close === ')') {
      flush(f)
      stack.pop()
      i++
    } else if (two === '<<' && text[i + 2] === '<') {
      f.cur += '<<<'
      i += 3
    } else if (two === '<<' && heredocAt(i)) {
      const m = heredocAt(i) as RegExpExecArray
      heredocs.push({ word: m[2] ?? m[3] ?? m[5], strip: m[1] === '-', literal: m[5] === undefined || m[4] === '\\' })
      f.cur += m[0]
      i += m[0].length
    } else if (ch === '\n' || ch === '\r') {
      flush(f)
      i += two === '\r\n' ? 2 : 1
      // The bodies of the heredocs this line opened, in order, up to each delimiter line.
      for (const h of heredocs.splice(0)) {
        let body = ''
        while (i < text.length) {
          const nl = text.indexOf('\n', i)
          const line = text.slice(i, nl === -1 ? text.length : nl).replace(/\r$/, '')
          i = nl === -1 ? text.length : nl + 1
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.word) break
          body += `${line}\n`
        }
        if (!h.literal) for (const sub of body.split(/\$\(|`/).slice(1)) parts.push(sub)
      }
    } else if (ch === ';' || ch === '|' || ch === '&') {
      flush(f)
      i += two === '&&' || two === '||' ? 2 : 1
    } else {
      f.cur += ch
      i++
    }
  }
  for (const f of stack) flush(f)
  return parts
}

/**
 * True when a denied shell command starts a shell or runs inline code in any of its commands (commandParts: every
 * line, split at `&&`, `||`, `;`, `|` and `&` outside quotes, and each `$(...)`, `(...)` and backtick; escapeWords on
 * the leading plain words of each): `bash -c ...`, `cmd /c ...`, `env X=1 make`, `ls && node -e ...`,
 * `echo "$(sh -c ...)"`. Quoted text is data: `git commit -m "a & start b"` is no escape. Such a denial is never an
 * approval (permissionAsk); the run's next prompt says the command needs the user (AgentState.escapeHint,
 * flow/runs.ts).
 */
export function isShellEscape(command: unknown): boolean {
  if (typeof command !== 'string') return false
  return commandParts(command).some((part) => escapeWords(plainWords(part), false))
}

/**
 * Denial -> grant patterns (deduped, each isGrantable): a Bash or PowerShell denial -> one `Bash(...)` rule only, never
 * a `PowerShell(...)` rule (E10 SPIKE, B5, a deviation of decision 2's twins: see isGrantable). A PowerShell denial is
 * granted as its Bash rule, and the run that the grant wakes is told to run that command with its Bash tool (the
 * system hint of a `grant` wake, RunStarter), so it is not denied again. Other tools -> [the tool name]; [] when nothing
 * is grantable.
 *
 * The rule (B5 integration, third round): the leading plain words of the command's first line (stopping at a quote, a
 * pipe, a redirection, a variable). When they start, past their `NAME=value` words, with a row of
 * GRANT_PREFIX_ALLOWLIST: the prefix rule of the words up to the end of that row (`Bash(npm test:*)`,
 * `Bash(CI=1 npm test:*)`, `Bash(python -m pytest:*)`, `Bash(node scripts/build.js:*)`). Any other command: the exact
 * command rule, the full command the user approves with its spacing as the run wrote it (`Bash(make)`,
 * `Bash(npx tsc-watch --once)`, `Bash(go run .)`), and only for a one-line command made of plain words alone; else
 * nothing (`find . -name "*.ts"`, a command with a pipe or more lines, a rule with a `%`: isGrantable). A shell or
 * interpreter escape (isShellEscape) grants nothing, nor a denied call of the CLI (`snaos team ...` through the
 * PowerShell tool: the run already has `Bash(snaos team:*)`, isGrantable).
 */
export function grantPatternOf(d: { tool: string; input?: unknown }): string[] {
  if (typeof d?.tool !== 'string') return []
  if (d.tool === 'Bash' || d.tool === 'PowerShell') {
    const command = d.input && typeof d.input === 'object' ? (d.input as { command?: unknown }).command : undefined
    if (typeof command !== 'string' || isShellEscape(command)) return []
    const lines = command.trim().split(/\r?\n/)
    const line = (lines[0] ?? '').trim()
    const words = plainWords(line)
    const program = programAt(words)
    if (program === -1) return []
    const take = allowlistedAt(words, program)
    let rule: string
    if (take > 0) rule = `Bash(${words.slice(0, program + take).join(' ')}:*)`
    else if (lines.length === 1 && line.split(/ +/).every((w) => PLAIN_WORD_RE.test(w))) rule = `Bash(${line})`
    else return []
    return isGrantable(rule) ? [rule] : []
  }
  return isGrantable(d.tool) ? [d.tool] : []
}
