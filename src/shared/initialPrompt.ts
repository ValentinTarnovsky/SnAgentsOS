/**
 * Initial prompt of a freshly created agent console (D1: E2-FR-11 unified
 * with E8-FR-02b). Pure rules shared by main (decides with the resolved shell
 * and revalidates), the renderer and the phone's executor (predict the
 * fallback before asking).
 *
 * Two deliveries:
 * - `argv` (direct): the agent command gets a reference to the
 *   SNAOS_INITIAL_PROMPT variable as its positional prompt and main puts the
 *   sanitized text in that variable of the pty. Nothing races the agent's
 *   startup, and `.cmd` shims never see the text itself on the command line.
 * - `gate` (fallback on the desktop): main types the text with Enter only after
 *   a precise ready signal (SessionStart hook, Codex bridge start); without one
 *   in PROMPT_READY_TIMEOUT_MS it is inserted without Enter (bracketed paste
 *   on) or not delivered at all.
 */
import type { PromptShellKind } from './shellKind'

/** The pty variable that carries the sanitized prompt in `argv` mode. */
export const INITIAL_PROMPT_ENV = 'SNAOS_INITIAL_PROMPT'
/** No precise ready signal in this long: the gate gives up on Enter. */
export const PROMPT_READY_TIMEOUT_MS = 20_000
/** How often the gate polls the agent state. */
export const PROMPT_POLL_MS = 100
/**
 * Delay between the drained text and the Enter that submits it. Agent TUIs
 * debounce a fast text+Enter as a paste, turning the Enter into a newline.
 */
export const SUBMIT_DELAY_MS = 150
/**
 * Longest sanitized prompt for `argv`: cmd.exe expands the variable inside a
 * `.cmd` shim and cuts a line at 8191 characters.
 */
export const ARGV_PROMPT_MAX = 2000
/** Largest text a submit accepts (the CLI's `send` bound). */
export const SUBMIT_TEXT_MAX = 256 * 1024

export type LaunchKind = 'claude' | 'codex' | 'other'

/** What a spawn asks main to deliver (PtySpawnReq.initialPrompt). */
export interface InitialPromptReq {
  text: string
  /** Gate mode: submit with Enter once the agent is ready (always true for agents). */
  enter: boolean
  /**
   * 'auto' (default) falls back to the gate; 'argvOnly' never types anything
   * (the phone keeps the text in its composer instead, E2-FR-11) and reports
   * `not_delivered` when `argv` is not possible.
   */
  mode?: 'auto' | 'argvOnly'
}

/**
 * The text as it goes into the variable (E2-FR-11): line breaks become spaces,
 * other control characters go, `"` becomes `'` (PowerShell 5.1 mangles
 * embedded double quotes when it calls a native program), trailing
 * backslashes go (in PS 5.1 one escapes the closing quote), and a leading
 * space is added when the text has no space or starts with `-`, so the shell
 * always quotes it and the agent never reads it as a flag.
 */
export function sanitizeInitialPrompt(text: string): string {
  let out = text
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    .replace(/"/g, "'")
    .trim()
    .replace(/\\+$/, '')
    .trimEnd()
  if (out && (!out.includes(' ') || out.startsWith('-'))) out = ' ' + out
  return out
}

/**
 * The reference appended to the agent command for each shell, or null when
 * the shell is not one we know how to quote for.
 */
export function initialPromptRef(kind: PromptShellKind): string | null {
  switch (kind) {
    case 'powershell':
      return ` $env:${INITIAL_PROMPT_ENV}`
    case 'posix':
      return ` "$${INITIAL_PROMPT_ENV}"`
    case 'cmd':
      return ` "%${INITIAL_PROMPT_ENV}%"`
    default:
      return null
  }
}

export interface InitialPromptCheck {
  text: string
  shell: PromptShellKind
  /** process.platform of the machine running the shell. */
  platform: string
  /** A Connection Profile (SSH) runs before the agent. */
  hasSetup: boolean
  /** Only a bare claude/codex preset command takes a positional prompt. */
  launchKind?: LaunchKind
}

/**
 * True when `argv` is not possible and the console must open without the
 * prompt on its command line (E2-FR-11): a Connection Profile, an unknown
 * shell, a command that is not a bare claude/codex preset, an empty text or
 * more than ARGV_PROMPT_MAX characters once sanitized, or a `%` on win32
 * (PowerShell runs `.cmd` shims through cmd.exe, which expands `%VAR%` even
 * inside quotes: `%SNAOS_CODEX_TOKEN%` would leak the token).
 */
export function initialPromptFallback(c: InitialPromptCheck): boolean {
  if (c.hasSetup || c.shell === 'unknown') return true
  if (c.launchKind !== undefined && c.launchKind !== 'claude' && c.launchKind !== 'codex') return true
  const clean = sanitizeInitialPrompt(c.text)
  if (!clean.trim() || clean.length > ARGV_PROMPT_MAX) return true
  return c.platform === 'win32' && c.text.includes('%')
}

/**
 * Desktop delivery (E8-FR-02b on D1): `argv` when the E2 rules allow it and
 * the prompt is one line (a multi-line prompt keeps its line breaks through
 * the gate's bracketed paste instead of having them turned into spaces),
 * otherwise `gate`.
 */
export function chooseDelivery(c: InitialPromptCheck & { launchKind: LaunchKind }): 'argv' | 'gate' {
  if (/[\r\n]/.test(c.text.trim())) return 'gate'
  return initialPromptFallback(c) ? 'gate' : 'argv'
}

/**
 * `busy` (v2.3): a gated submit (`readyFor`) found the agent busy or a draft in its input box.
 * With `userGate` (post 2.6.0, `typingBlocked`): `awaiting_user` = the agent waits on the user,
 * nothing was written; `enter_held` = it started waiting after the text was typed, so the
 * deferred Enter (and any trailing line break) was dropped and the text stays unsent.
 */
export type SubmitError = 'multiline_unsafe' | 'not_running' | 'busy' | 'awaiting_user' | 'enter_held'

/**
 * What a submit writes (E8-FR-02a): line breaks normalized to `\r` (like
 * xterm's paste), wrapped in bracketed paste when the text has an inner line
 * break and the pty enabled DECSET 2004, or `multiline_unsafe` when it did not
 * (every line would run as a command). Trailing breaks are not inner ones: they
 * are written after the paste, as typed Enters (an old snippet ending in a
 * newline still runs). Paste markers inside the text are removed so it can
 * never close the paste early.
 */
export function prepareSubmit(
  text: string,
  bracketedPaste: boolean,
  forcePaste = false,
): { ok: true; data: string } | { ok: false; error: 'multiline_unsafe' } {
  const norm = text.replace(/\r\n|\n/g, '\r')
  const tail = /\r*$/.exec(norm)?.[0] ?? ''
  const body = norm.slice(0, norm.length - tail.length)
  // `forcePaste` (the gate's insert without Enter) wraps a one-line text too.
  if (!body.includes('\r') && !(forcePaste && bracketedPaste && body)) return { ok: true, data: norm }
  if (!bracketedPaste) return { ok: false, error: 'multiline_unsafe' }
  return { ok: true, data: `\x1b[200~${body.replace(/\x1b\[20[01]~/g, '')}\x1b[201~${tail}` }
}
