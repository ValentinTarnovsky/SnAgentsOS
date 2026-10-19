/**
 * The single builder of agent command lines (CONTRATOS `buildAgentArgv`, D1).
 * Every place that types an agent command into a shell (launch, restart
 * resuming, reopen, the phone's restartPane) goes through here, so the session
 * id and the cwd are validated in one spot before anything reaches a shell.
 * Pure: no Node or DOM imports, safe in main, renderer and tests.
 */
import type { AgentPreset, AgentProvider } from './types'
import { initialPromptRef } from './initialPrompt'
import type { PromptShellKind } from './shellKind'

/** Agent session ids we accept (Claude UUIDs, Codex thread ids). Rejects `launch:` and shell syntax. */
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/

/**
 * A `pane.command` override is only resumed when it is the bare CLI plus
 * flags: no leading positional prompt, no wrapper (`npx claude`), no quotes
 * and no shell operators. A flag may carry a plain value, inline or as the
 * next word (`--model opus`, the PRD's own example; its literal regex only
 * allowed `--model=opus`; Codex `-c model=o3` needs the `=`). stripForResume
 * still drops positionals. A flag name starts with a word character so every
 * token has one parse: the PRD's `--?[\w-]+` backtracks exponentially on a
 * long run of flags.
 */
export const OVERRIDE_RE = /^(claude|codex)(\.exe|\.cmd)?(\s+--?\w[\w-]*(=[\w.:\/,@+=-]+)?(\s+[\w.:\/,@+][\w.:\/,@+=-]*)?)*$/

/** True when `id` can be typed into a shell as a session id. */
export function isSafeSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID_RE.test(id)
}

/**
 * Splits a command line into raw tokens, keeping each token's own quotes so
 * it can be typed back verbatim ("C:\Program Files\claude.exe" stays quoted).
 */
export function tokenize(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let has = false
  for (const ch of line) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
      has = true
      continue
    }
    if (/\s/.test(ch)) {
      if (has) out.push(cur)
      cur = ''
      has = false
      continue
    }
    cur += ch
    has = true
  }
  if (has) out.push(cur)
  return out
}

/** A token without its surrounding quotes (classification only, never typed). */
function unquote(token: string): string {
  return token.replace(/^(["'])(.*)\1$/s, '$2')
}

/** claude | codex from a command token (any directory, .exe/.cmd tolerated), else null. */
export function providerOfCommand(command: string | undefined): AgentProvider | null {
  const first = command ? tokenize(command.trim())[0] : undefined
  if (!first) return null
  const base = unquote(first).split(/[\\/]/).pop()!.toLowerCase().replace(/\.(exe|cmd)$/, '')
  return base === 'claude' || base === 'codex' ? base : null
}

// Flags whose next token is their value. Anything else is treated as a
// boolean, so a following token counts as a positional (the prompt) and is
// dropped on resume: re-sending a prompt is worse than losing an odd flag.
const VALUE_FLAGS: Record<AgentProvider, Set<string>> = {
  claude: new Set([
    '--model', '--permission-mode', '--allowedTools', '--allowed-tools', '--disallowedTools',
    '--disallowed-tools', '--tools', '--add-dir', '--mcp-config', '--append-system-prompt',
    '--system-prompt', '--output-format', '--input-format', '--settings', '--setting-sources',
    '--agents', '--agent', '--fallback-model', '--max-turns', '--permission-prompt-tool',
    '--plugin-dir', '--betas', '--max-budget-usd', '--json-schema', '--debug-file',
  ]),
  codex: new Set([
    '-m', '--model', '-p', '--profile', '-c', '--config', '-s', '--sandbox', '-a',
    '--ask-for-approval', '-C', '--cd', '-i', '--image', '--local-provider', '--add-dir',
    '--enable', '--disable', '--remote', '--remote-auth-token-env',
  ]),
}
/** Claude session flags removed before adding our own `--resume <id>`. */
const CLAUDE_SESSION_FLAGS = new Set(['--resume', '-r', '--continue', '-c', '--session-id', '--fork-session'])
/** The ones that may carry a value. */
const CLAUDE_SESSION_VALUE = new Set(['--resume', '-r', '--session-id'])

/**
 * Keeps the command and its flags; drops positionals (an initial prompt) and
 * any existing session selection: Claude `--resume/-r [id]`, `--continue/-c`,
 * `--session-id <id>`, `--fork-session`; Codex `resume [id]` and `--last`.
 * `tokens[0]` is the command itself and is always kept.
 */
export function stripForResume(provider: AgentProvider, tokens: string[]): string[] {
  if (tokens.length === 0) return []
  const out = [tokens[0]]
  const values = VALUE_FLAGS[provider]
  for (let i = 1; i < tokens.length; i++) {
    const raw = tokens[i]
    const tok = unquote(raw)
    const isFlag = tok.startsWith('-') && tok.length > 1
    if (!isFlag) {
      // Codex `resume <id>`: drop the subcommand and the id after it.
      if (provider === 'codex' && tok === 'resume') {
        const next = tokens[i + 1]
        if (next !== undefined && !unquote(next).startsWith('-')) i++
      }
      continue // positional: a prompt or a stray argument
    }
    const [name] = tok.split('=', 1)
    const inline = tok.includes('=')
    if (provider === 'claude' && CLAUDE_SESSION_FLAGS.has(name)) {
      const next = tokens[i + 1]
      if (!inline && CLAUDE_SESSION_VALUE.has(name) && next !== undefined && !unquote(next).startsWith('-')) i++
      continue
    }
    if (provider === 'codex' && (name === '--last' || name === '--all')) continue
    out.push(raw)
    if (!inline && values.has(name) && i + 1 < tokens.length) out.push(tokens[++i])
  }
  return out
}

/**
 * Command line that resumes `sessionId`, or null when the id is unsafe.
 * Claude: `<command> <flags> --resume <id>`. Codex: `<command> <flags> resume
 * <id>` (top-level flags before the subcommand, the same side the status shim
 * puts its own `--remote`; E5 risk 1, verified by hand per release).
 */
export function buildResumeCommand(provider: AgentProvider, effectiveCommand: string, sessionId: string): string | null {
  if (!isSafeSessionId(sessionId)) return null
  const tokens = stripForResume(provider, tokenize(effectiveCommand.trim()))
  if (tokens.length === 0) return null
  return [...tokens, ...(provider === 'claude' ? ['--resume', sessionId] : ['resume', sessionId])].join(' ')
}

export interface AgentArgvInput {
  /** The pane's preset (shell presets never produce a command). */
  preset?: Pick<AgentPreset, 'type' | 'command' | 'args'> | null
  /** `pane.command` override; wins over the preset. */
  command?: string
  /** Resume this session instead of starting a new one. */
  resume?: { provider: AgentProvider; sessionId: string }
  /**
   * Initial prompt in `argv` mode (E2-FR-11, D1): the command gets the
   * reference to SNAOS_INITIAL_PROMPT for this shell. Never with `resume`.
   */
  promptShell?: PromptShellKind
}

/**
 * The command typed into the shell for an agent pane, or undefined when there
 * is nothing to type (shell panes) or a resume cannot be built safely.
 *
 * Without `resume` it is today's precedence: override > preset command+args.
 * With `resume` the base is the override (only when it matches OVERRIDE_RE),
 * else the preset when its binary is that provider, else the bare provider
 * binary (`claude` / `codex`), so wrappers like `npx claude` never get flags
 * appended in the wrong place.
 */
export function buildAgentArgv(input: AgentArgvInput): string | undefined {
  const override = input.command?.trim()
  const preset = input.preset
  const presetLine =
    preset && preset.type !== 'shell' && preset.command.trim()
      ? [preset.command, ...preset.args].join(' ').trim()
      : undefined
  if (!input.resume) {
    const line = override || presetLine || undefined
    return line && input.promptShell ? appendPromptRef(line, input.promptShell) : line
  }
  const { provider, sessionId } = input.resume
  let base: string = provider
  if (override) {
    if (!OVERRIDE_RE.test(override) || providerOfCommand(override) !== provider) return undefined
    base = override
  } else if (presetLine && providerOfCommand(preset!.command) === provider) {
    base = presetLine
  }
  return buildResumeCommand(provider, base, sessionId) ?? undefined
}

/** Shell family as reported by PtyManager (mirrors ipc-contract ShellKind). */
export type CdShellKind = 'powershell' | 'cmd' | 'posix' | 'other'

/**
 * `cd` prefix typed before a resume command in a live shell (E6-FR-22/23), or
 * '' when the cwd is unsafe or the shell is unknown. The cwd must be absolute,
 * at most 1024 chars and free of control characters; cmd also rejects `"` and
 * `%`. Quotes are escaped per shell.
 */
export function buildCdPrefix(shellKind: CdShellKind, cwd: string | undefined): string {
  if (!cwd || cwd.length > 1024 || /[\x00-\x1f\x7f]/.test(cwd)) return ''
  if (!/^([A-Za-z]:[\\/]|\\\\|\/)/.test(cwd)) return ''
  switch (shellKind) {
    case 'powershell':
      // PowerShell also ends a single-quoted string at the typographic quotes
      // U+2018..U+201B; doubling any of them escapes it like ''.
      return `Set-Location -LiteralPath '${cwd.replace(/['‘’‚‛]/g, '$&$&')}'; `
    case 'cmd':
      return /["%]/.test(cwd) ? '' : `cd /d "${cwd}" && `
    case 'posix':
      return `cd -- '${cwd.replace(/'/g, "'\\''")}' && `
    default:
      return ''
  }
}

/**
 * `command` with the initial prompt reference for `shell` appended (argv mode,
 * D1), or the command unchanged when the shell has no known reference. Main
 * calls it with the resolved shell; the text itself only lives in the pty's
 * SNAOS_INITIAL_PROMPT variable, never on the command line.
 */
export function appendPromptRef(command: string, shell: PromptShellKind): string {
  const ref = initialPromptRef(shell)
  return ref ? command.trimEnd() + ref : command
}
