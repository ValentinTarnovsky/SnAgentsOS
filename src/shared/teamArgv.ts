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
export const CLAUDE_READONLY_ALLOW = [
  'Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite',
  'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git status:*)',
  'PowerShell(git log:*)', 'PowerShell(git diff:*)', 'PowerShell(git show:*)', 'PowerShell(git status:*)',
] as const
export const CLAUDE_READONLY_DENY = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const
export const CLAUDE_TOTAL_DENY = [
  'Bash(git push:*)', 'Bash(git merge:*)', 'Bash(git worktree:*)', 'Bash(git update-ref:*)',
  'PowerShell(git push:*)', 'PowerShell(git merge:*)', 'PowerShell(git worktree:*)', 'PowerShell(git update-ref:*)',
] as const
/** Every Claude team run, new and resume: no project settings, hooks or MCP servers from the run cwd (decision 34). */
export const CLAUDE_ISOLATION_FLAGS = ['--setting-sources', 'user', '--strict-mcp-config'] as const

/** The git commands no team run may run (CLAUDE_TOTAL_DENY, as command prefixes). */
const DENIED_COMMANDS = ['git push', 'git merge', 'git worktree', 'git update-ref']
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
   * Decision 72, built in main from dataDir(): Read deny of runtime.json; Edit/Write/MultiEdit deny of teams/**, trusted-teams.json, runtime.json.
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
    argv.push('--disallowedTools', ...dedupe([...CLAUDE_READONLY_DENY, ...protect]))
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
  // Git's global options come before the subcommand (`git -C <dir> push`), so a grant that starts with one could
  // reach every denied command: an agent's `git -C <dir> log` denial must never become `Bash(git -C:*)`.
  if (/^git -/.test(body)) return true
  return DENIED_COMMANDS.some((d) => (prefix && d.startsWith(body)) || body === d || body.startsWith(`${d} `))
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

/**
 * TOOL_PATTERN_RE shape, not covered by CLAUDE_TOTAL_DENY (a git push grant is never offered), not `mcp__*` (no MCP loads: --strict-mcp-config), not `Task` / `Agent`.
 * Never a shell pattern that names the CLI: `Bash(snaos team:*)` is on every allow list already, every other `snaos`
 * command answers forbidden to a team run, and a PowerShell one would reach cmd.exe through `snaos.cmd` (CLAUDE_TEAM_TOOLS).
 */
export function isGrantable(tool: string): boolean {
  if (!validToolPattern(tool)) return false
  const name = tool.replace(/\(.*$/, '')
  if (/^mcp__/i.test(name) || name === 'Task' || name === 'Agent') return false
  if (name === 'Bash' || name === 'PowerShell') {
    const spec = shellSpec(tool)
    // A bare shell grant is every command, git push included.
    return spec !== null && !coversDenied(spec) && !namesCli(spec)
  }
  return true
}

/** A word of a command that may go in a grant pattern: no quotes, operators, variables or path separators of Windows. */
const PLAIN_WORD_RE = /^[A-Za-z0-9_.\/:@%+=,~-]+$/

/**
 * Denial -> grant patterns (deduped, each isGrantable): a Bash or PowerShell denial -> BOTH `Bash(<w1 w2>:*)` and
 * `PowerShell(<w1 w2>:*)` (decision 2; a PowerShell denial granted only as Bash would be denied again, a loop);
 * other tools -> [the tool name]; [] when nothing is grantable.
 *
 * `<w1 w2>`: the first two words of the command's first line, stopping at the first word that is not plain (a quote,
 * a pipe, a redirection, a variable). A denied call of the CLI (`snaos team ...` through the PowerShell tool) grants
 * nothing: the run already has `Bash(snaos team:*)` (isGrantable).
 */
export function grantPatternOf(d: { tool: string; input?: unknown }): string[] {
  if (typeof d?.tool !== 'string') return []
  if (d.tool === 'Bash' || d.tool === 'PowerShell') {
    const command = d.input && typeof d.input === 'object' ? (d.input as { command?: unknown }).command : undefined
    if (typeof command !== 'string') return []
    const words: string[] = []
    for (const w of (command.split(/\r?\n/)[0] ?? '').trim().split(/\s+/)) {
      if (words.length === 2 || !PLAIN_WORD_RE.test(w)) break
      words.push(w)
    }
    if (words.length === 0) return []
    const spec = `${words.join(' ')}:*`
    return dedupe([`Bash(${spec})`, `PowerShell(${spec})`]).filter(isGrantable)
  }
  return isGrantable(d.tool) ? [d.tool] : []
}
