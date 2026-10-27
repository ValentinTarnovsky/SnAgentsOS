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
  /**
   * App 2.7.0 (A5): a `done` notice's turn digest line ("Edit 3, Read 2
   * (src/a.ts)"), built by StatusManager from tool families and file names
   * only, redacted (redactCredentials) and <= NOTICE_DIGEST_MAX. Never any
   * text of the agent's reply. Every remote channel appends it to its done
   * notice through 'status.push.doneDigest'.
   */
  digest?: string
  /**
   * App 2.8.0: the pane's stateSeq when the notice was raised. noticeDelay drops
   * a delayed notice whose pane moved on since (StatusManager.noticeCurrent).
   */
  seq?: number
  /**
   * App 2.7.0 (A5): set only on the one notice a channel sends for the
   * notices it held in a window (noticeCoalescer). Its paneId is '' and its
   * state is 'error' when any held one was an error, else 'done'.
   */
  summary?: NoticeSummary
}

/** Longest digest line a notice carries. */
export const NOTICE_DIGEST_MAX = 160

/** The notices a channel held in one 10 s window (noticeCoalescer), as one summary. */
export interface NoticeSummary {
  /** How many notices were held. */
  count: number
  /** 'status.push.digest' in the config language ("More notices from SnAgentsOS: 5"), redacted. */
  text: string
  /** "workspace / console" of the held notices, comma separated, '' when they do not fit; redacted. */
  places: string
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

/**
 * A notice of a team (app 2.7.0, E10 B5 and B8, design 3.1 Notices and 6.3): one per new "Te necesita" row with
 * `push` (an approval, a card, the trust state, an auth or billing pause) and per integrate result. `title` and `body`
 * come from the main catalog (`teams.push.*`) with the trusted team name and the task id only, never agent text,
 * redacted. `tag` is `team:<teamId>:<rowId>` (the push tag; a newer push of the same row replaces the older one);
 * `urgent` for a row that blocks the team (rank 1). `push: false` stays a desktop toast: noticeRouter.routeTeam sends
 * nothing to the phone, Discord or ntfy for it.
 */
export interface TeamNotice { kind: 'team'; teamId: string; taskId?: string; tag: string; title: string; body: string; urgent: boolean; push: boolean }

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
  /** App 2.7.0 (A5): a done notice's 'status.push.doneDigest' line ("Tools: Edit 3, Read 2"); absent otherwise. */
  digest?: string
}

/** App 2.7.0 (A5): the 'status.push.doneDigest' line of a done notice that carries a digest, or undefined. */
export function noticeDigestLine(notice: StatusNotice, config: ConfigFile | null): string | undefined {
  if (notice.state !== 'done' || notice.summary || typeof notice.digest !== 'string') return undefined
  const line = notice.digest.trim()
  return line ? mainT(config, 'status.push.doneDigest', { line }) : undefined
}

/**
 * A summary notice (noticeCoalescer) reads as its own text and places;
 * `agent` is not shown for it and `workspaceId` is null (no console to open).
 */
export function describeNotice(notice: StatusNotice, config: ConfigFile | null, fallbackPlace: string): NoticeText {
  const agent = notice.provider === 'codex' ? 'Codex' : 'Claude'
  if (notice.summary) return { agent, message: notice.summary.text, place: notice.summary.places || fallbackPlace, workspaceId: null }
  let place = fallbackPlace
  let workspaceId: string | null = null
  for (const ws of config?.workspaces ?? []) {
    const pane = ws.panes.find(p => p.id === notice.paneId)
    if (pane) { place = `${ws.name} / ${pane.title}`; workspaceId = ws.id; break }
  }
  const reason: AttentionReason = notice.reason ?? (notice.state === 'error' ? 'failure' : 'question')
  // The words live in main/i18n.ts, in the config language (E2 i18n).
  const message = mainT(config, notice.state === 'done' ? 'status.push.done' : `status.push.${reason}`)
  const digest = noticeDigestLine(notice, config)
  return { agent, message, place, workspaceId, ...(digest ? { digest } : {}) }
}
