/**
 * What the "Claude / Codex exited [Resume] [New]" chip types into the shell
 * (E6-FR-22/23). Pure: the command lines come from buildAgentArgv (D1), the
 * cd prefix from buildCdPrefix, and nothing unvalidated reaches the shell.
 */
import { buildAgentArgv, buildCdPrefix, isSafeSessionId, providerOfCommand } from '@shared/agent-argv'
import type { ShellKind } from '@shared/ipc-contract'
import type { AgentPreset, AgentSessionEndEvt } from '@shared/types'

/** Without shell integration the buttons enable this long after the event (E6-FR-22, shellReady). */
export const AGENT_END_READY_MS = 800

export interface AgentEndInput {
  /** `provider` absent = Claude. */
  evt: Pick<AgentSessionEndEvt, 'sessionId' | 'cwd'> & Partial<Pick<AgentSessionEndEvt, 'provider'>>
  /** Family of the live shell; null/other omits the cd prefix. */
  shellKind: ShellKind | null
  preset?: Pick<AgentPreset, 'type' | 'command' | 'args'> | null
  /** `pane.command` override. */
  paneCommand?: string
  /** The pane's launch command (resolveLaunch), when any. */
  initialCommand?: string
}

export interface AgentEndCommands {
  /** `<cd prefix><claude ... --resume id>` (Codex: `codex ... resume id`), or null when the id or the command is unsafe (only [New]). */
  resume: string | null
  /** The pane's launch command of that agent, else `claude` / `codex`. */
  fresh: string
}

export function agentEndCommands(input: AgentEndInput): AgentEndCommands {
  const provider = input.evt.provider ?? 'claude'
  const launch = input.initialCommand?.trim()
  const fresh = launch && providerOfCommand(launch) === provider ? launch : provider
  const { sessionId, cwd } = input.evt
  if (!isSafeSessionId(sessionId)) return { resume: null, fresh }
  const argv = buildAgentArgv({ preset: input.preset, command: input.paneCommand, resume: { provider, sessionId } })
  if (!argv) return { resume: null, fresh }
  // The cd is sent even when the shell is already there: harmless, and it
  // covers a shell (or Claude's `!cd`) that moved since the session started.
  return { resume: buildCdPrefix(input.shellKind ?? 'other', cwd) + argv, fresh }
}
