import type { AgentDetail, AgentProvider, AttentionReason, ConfigFile, RemotePending } from '@shared/types'
import type { FailureInfo } from '@shared/failure'
import { mainT } from '../i18n'
import type { BackgroundTasks } from './HookServer'
export interface AgentEvent {
  paneId: string
  ptyId: string
  provider: AgentProvider
  sessionId: string
  kind: 'start' | 'working' | 'request' | 'resolved' | 'done' | 'error' | 'idle' | 'end' | 'unknown'
  turnId?: string
  /**
   * `request` / `resolved`: the request's id. A `resolved` also closes the
   * open tool with this id (Claude PostToolUse tool_use_id, Codex item id).
   */
  requestId?: string
  reason?: AttentionReason
  /**
   * App 2.7.0 (A3): the tool call a `working` event opens (Claude PreToolUse
   * tool_use_id, Codex item id); its `resolved` closes it through requestId.
   * The PreToolUse of a prompt tool (ExitPlanMode, AskUserQuestion) carries
   * it on its `request` too, so the turn digest counts it once.
   */
  toolUseId?: string
  /**
   * App 2.7.0 (A3): why an `error` turn failed (claudeFailure, codexFailure),
   * bounded by the producer (code <= 32).
   */
  failure?: FailureInfo
  /** App 2.7.0 (A3): an ExitPlanMode request's whole plan, <= PLAN_TEXT_MAX, line breaks kept. Main only. */
  planText?: string
  /** The plan was longer than PLAN_TEXT_MAX and was cut. */
  planTruncated?: boolean
  /**
   * App 2.7.0 (A3): the file a tool call works on (fileOfToolInput, <= 120),
   * for the turn digest. Main only.
   */
  toolFile?: string
  // Enrichment (E4-FR-09, E5-FR-01). All optional and already bounded by the
  // producer; prompts and replies live in memory only and are never logged.
  /** Absolute existing directory the agent reported. */
  cwd?: string
  /** Claude transcript, only after isSafeTranscriptPath. Main only. */
  transcriptPath?: string
  /** UserPromptSubmit text, <= 2000. */
  prompt?: string
  /** Assistant reply (Stop last_assistant_message, Codex last agentMessage of the turn), <= 2000. */
  reply?: string
  /** First user message of a resumed thread (Codex `thread.preview`), <= 2000; never a last prompt. */
  firstPrompt?: string
  /** SessionEnd reason as sent by Claude ('prompt_input_exit', 'other', 'clear', ...). */
  endReason?: string
  /** Replaces the pane detail when set. */
  detail?: AgentDetail
  /** Current tool summary (activity), <= 160. */
  tool?: string
  /**
   * The tool's name: Claude's tool_name, or the Codex item type
   * (commandExecution, fileChange, mcpToolCall, webSearch). familyOf reads
   * it for the published toolFamily and the turn digest.
   */
  toolName?: string
  /** Pending card summary, <= 200. */
  summary?: string
  questions?: RemotePending['questions']
  /** Event of a subagent: never changes the main detail. */
  subagent?: boolean
  /** Stop: background work the turn left running (v2.2). */
  background?: BackgroundTasks
  /** v2.3 (agentTune read-back): the model SessionStart named, <= 64. */
  model?: string
  /** v2.3: the effort level a hook reported (allowlisted). */
  effort?: string
  /** v2.3: SessionStart `source` ('startup' | 'resume' | 'clear' | 'compact' | 'fork'), <= 32. */
  source?: string
}
export interface StatusNotice {
  paneId: string
  provider: AgentProvider
  state: 'action' | 'done' | 'error'
  reason?: AttentionReason
}

/**
 * A `snaos notify` for the remote channels (E8-FR-19, kind `custom`). Kept
 * apart from StatusNotice so every agent-notice consumer stays as it is.
 * Title (<= 80) and body (<= 300) arrive already sanitized to one line each.
 */
export interface CustomNotice {
  kind: 'custom'
  /** The calling console, or null from an external terminal (master token). */
  paneId: string | null
  title: string
  body: string
}

/** "workspace / console" of a pane and its workspace id, or the fallback. */
export function describePlace(paneId: string | null, config: ConfigFile | null, fallbackPlace: string): { place: string; workspaceId: string | null } {
  if (paneId) {
    for (const ws of config?.workspaces ?? []) {
      const pane = ws.panes.find(p => p.id === paneId)
      if (pane) return { place: `${ws.name} / ${pane.title}`, workspaceId: ws.id }
    }
  }
  return { place: fallbackPlace, workspaceId: null }
}

/**
 * The words every remote channel (Discord, ntfy) sends for a notice: agent
 * name, reason in the config language, "workspace / console" and the
 * workspace id the deep link needs. Never any text of the agent's reply.
 */
export interface NoticeText {
  agent: 'Claude' | 'Codex'
  message: string
  /** "workspace / console", or the product name when the pane is unknown. */
  place: string
  workspaceId: string | null
}

export function describeNotice(notice: StatusNotice, config: ConfigFile | null, fallbackPlace: string): NoticeText {
  let place = fallbackPlace
  let workspaceId: string | null = null
  for (const ws of config?.workspaces ?? []) {
    const pane = ws.panes.find(p => p.id === notice.paneId)
    if (pane) { place = `${ws.name} / ${pane.title}`; workspaceId = ws.id; break }
  }
  const reason: AttentionReason = notice.reason ?? (notice.state === 'error' ? 'failure' : 'question')
  // The words live in main/i18n.ts, in the config language (E2 i18n).
  const message = mainT(config, notice.state === 'done' ? 'status.push.done' : `status.push.${reason}`)
  return { agent: notice.provider === 'codex' ? 'Codex' : 'Claude', message, place, workspaceId }
}
