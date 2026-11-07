/**
 * App 2.10.0 (schema 21, `settings.agents.autoYes`): whether main answers a
 * Claude Code permission prompt on its own. The decision travels back as the
 * PermissionRequest hook's response body (HookServer), never as keystrokes,
 * so no Enter ever reaches a pty. Pure: the caller hands in the setting and
 * whether the console is one of the app's live ptys.
 *
 * Bypass mode still prompts for a few things (critical-path `rm`/`rmdir`,
 * ask rules, a teammate's request shown in the lead), and an unanswered one
 * stalls a whole night of work. 'bypass' answers only those of a session in
 * bypassPermissions; 'all' answers any permission prompt. Questions
 * (AskUserQuestion) and plan approvals (ExitPlanMode) are never answered:
 * they wait for the user in every mode. Deny rules still win inside Claude
 * Code (a hook's allow never overrides them).
 */
import type { AutoYesMode } from '@shared/types'

/** The tools whose prompt is the user's to answer, whatever the setting. */
export const AUTO_YES_NEVER: ReadonlySet<string> = new Set(['AskUserQuestion', 'ExitPlanMode'])

/** Claude Code's `permission_mode` values (the hook's common input field). */
export const PERMISSION_MODES = ['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

/** A raw `permission_mode` as one of the known values, else undefined. */
export function permissionModeOf(raw: unknown): PermissionMode | undefined {
  return typeof raw === 'string' && (PERMISSION_MODES as readonly string[]).includes(raw) ? (raw as PermissionMode) : undefined
}

export interface AutoYesInput {
  mode: AutoYesMode | undefined
  /** The hook event name (only PermissionRequest is ever answered). */
  event: string
  toolName?: string
  permissionMode?: PermissionMode
  /** The console id names a live pty of the app (a claude outside the app never gets an answer). */
  consoleKnown: boolean
  /**
   * A sub-session (a `claude -p` the console's agent started, HookEvent.nested):
   * it cannot prompt, so its PermissionRequest means "auto-deny unless a hook
   * allows"; never widened. A teammate of the console is not nested.
   */
  nested?: boolean
}

/** 'allow' when main answers the prompt, null when the user does. */
export function autoYesDecision(input: AutoYesInput): 'allow' | null {
  if (input.event !== 'PermissionRequest' || !input.consoleKnown || input.nested) return null
  if (input.mode !== 'bypass' && input.mode !== 'all') return null
  if (!input.toolName || AUTO_YES_NEVER.has(input.toolName)) return null
  if (input.mode === 'bypass' && input.permissionMode !== 'bypassPermissions') return null
  return 'allow'
}

/** The PermissionRequest hook output that approves the prompt (hooks.md, HTTP response body). */
export const AUTO_YES_ALLOW_BODY = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })

/**
 * One autoyes.log line (the logger stamps the time). Never the command or any
 * tool input: those are user content. Ids and tool names are clipped to plain
 * tokens.
 */
export function autoYesLogLine(consoleId: string, toolName: string, teammate: boolean, permissionMode: PermissionMode | undefined): string {
  // Only the leading token: a tool name never has a space, so anything after one is not a name.
  const tool = (/^[A-Za-z0-9_.:-]+/.exec(toolName)?.[0] ?? '').slice(0, 80) || '?'
  const id = (/^[A-Za-z0-9_-]+/.exec(consoleId)?.[0] ?? '').slice(0, 64) || '?'
  return `allow console=${id} tool=${tool} teammate=${teammate ? 1 : 0} mode=${permissionMode ?? '?'}`
}
