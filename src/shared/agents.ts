/**
 * Agent session model shared by main and renderer (E5 G2 "Resume"): the view
 * of main's agent-sessions.json the renderer gets over `agents:*`, and the
 * pure launch decision. No Node or DOM imports.
 */
import type { AgentPreset, AgentProvider, AttentionReason, ClaudePaneState, Pane, ResumeOnStartup } from './types'
import { OVERRIDE_RE, providerOfCommand } from './agent-argv'

/** Why the previous run ended (E5-FR-06). */
export type ExitTrigger = 'quit' | 'update' | 'shutdown' | 'crash'

/** Claude SessionEnd reasons that end a chat for good; anything else keeps it resumable (E5-FR-05). */
export const ENDING_REASONS: ReadonlySet<string> = new Set(['prompt_input_exit', 'logout'])

/** One pane's agent session as the renderer sees it (no transcript path). */
export interface AgentSessionView {
  paneId: string
  provider: AgentProvider
  sessionId: string
  /** Directory PtyManager handed node-pty when the session's console spawned. */
  spawnCwd: string
  /** Last directory the agent reported (hook cwd); a fallback for spawnCwd. */
  cwd?: string
  topic?: string
  firstPrompt?: string
  /** First line of the last prompt, <= 120. */
  lastPrompt?: string
  activity: ClaudePaneState
  reason?: AttentionReason
  updatedAt: number
  endedAt?: number
  hibernatedAt?: number
  /** Set by the exit snapshot when the agent was mid-turn or waiting on the user. */
  interrupted?: { activity: 'working' | 'action'; reason?: AttentionReason; trigger: ExitTrigger; at: number }
  available: boolean | 'unknown'
  unavailableReason?: 'transcript' | 'cwd' | 'claimed'
}

/** How the previous run ended and which panes it interrupted. Stable for the whole run. */
export interface AgentsStartup {
  trigger: ExitTrigger | null
  /** paneIds */
  interrupted: string[]
}

/** `agents:changed`: a view that changed in a field the UI shows, or a removal. */
export type AgentsChangedEvt = AgentSessionView | { paneId: string; removed: true }

/** `agents:ready`: a session (re)started or reached its first idle after a start. */
export interface AgentsReadyEvt {
  paneId: string
  sessionId: string
  phase: 'start' | 'idle'
}

export type LaunchDecision = 'resume' | 'fresh' | 'pending'

/**
 * The agent a pane runs, from its preset (or its own type) the same way
 * resolveLaunch reads it: claude/codex types directly, a `custom` one when its
 * binary is claude/codex (any directory, .exe/.cmd). Shell panes have none,
 * even when the user typed `claude` into them by hand.
 */
export function effectiveProvider(pane: Pick<Pane, 'type' | 'command'>, preset?: Pick<AgentPreset, 'type' | 'command'>): AgentProvider | null {
  const type = preset?.type ?? pane.type
  if (type === 'claude' || type === 'codex') return type
  if (type === 'custom') return providerOfCommand(preset?.command ?? pane.command)
  return null
}

export interface LaunchInput {
  pane: Pick<Pane, 'command'>
  /** effectiveProvider() of the pane. */
  provider: AgentProvider | null
  /** pane.setupId ?? workspace.setupId resolves to a Connection Profile. */
  hasSetup: boolean
  session?: AgentSessionView
  /** One-shot intent of an explicit action (menu, phone, chip). */
  intent?: 'resume' | 'fresh'
  /** First spawn of this pane in this run (agents:consumeStartup said true). */
  startupUnconsumed: boolean
  policy: ResumeOnStartup
  /** The "resume interrupted chats?" dialog is still open (E5-FR-12). */
  modalPending: boolean
}

/**
 * Resume or start fresh (E5 G2 truth table). An explicit `fresh` always wins;
 * an explicit `resume` works on any pane with a record that is not known to be
 * unavailable. Without intent, a resume needs an available, not ended record
 * of the pane's own provider, no Connection Profile and a resumable override;
 * `off` only applies to the startup decision. Connection Profiles never resume
 * (main does not even record them).
 */
export function decideLaunch(i: LaunchInput): LaunchDecision {
  if (i.intent === 'fresh' || i.hasSetup) return 'fresh'
  const s = i.session
  if (i.intent === 'resume') return s && s.available !== false ? 'resume' : 'fresh'
  if (i.policy === 'off' && i.startupUnconsumed) return 'fresh'
  if (!s || s.available === false || s.endedAt) return 'fresh'
  if (i.provider !== s.provider) return 'fresh'
  const override = i.pane.command?.trim()
  if (override && !OVERRIDE_RE.test(override)) return 'fresh'
  if (i.startupUnconsumed && i.policy === 'ask' && s.interrupted && i.modalPending) return 'pending'
  return 'resume'
}

/**
 * Urgency rank shared by the palette, sidebar rows and the board (E5-FR-15):
 * 1 action/error, 2 done (unread first via `unread`), 3 working, 4 the rest.
 */
export function agentRank(state: ClaudePaneState | null | undefined): 1 | 2 | 3 | 4 {
  if (state === 'action' || state === 'error') return 1
  if (state === 'done') return 2
  if (state === 'working') return 3
  return 4
}

/**
 * Compact age, the same in es and en ("<1 min", "5 min", "2 h", "3 d").
 * Negative spans (clock skew) count as now.
 */
export function formatAge(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60000)
  if (min < 1) return '<1 min'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} h`
  return `${Math.floor(h / 24)} d`
}

/**
 * One console as the navigation surfaces rank it (palette "Waiting for you",
 * sidebar agent rows, next waiting): its rank, whether it is unread (the
 * attention flag) and since when it is in its state.
 */
export interface RankedPane {
  id: string
  rank: 1 | 2 | 3 | 4
  unread: boolean
  /** Epoch ms of the last state change; 0 when unknown. */
  stateSince: number
}

/**
 * Urgency order (E5-FR-15): rank ascending; inside rank 2 unread first; ranks
 * 1-2 wait longest first (stateSince ascending), ranks 3-4 most recent first.
 * Ties fall back to the id so the order is stable.
 */
export function compareAgents(a: RankedPane, b: RankedPane): number {
  if (a.rank !== b.rank) return a.rank - b.rank
  if (a.rank === 2 && a.unread !== b.unread) return a.unread ? -1 : 1
  const since = a.rank <= 2 ? a.stateSince - b.stateSince : b.stateSince - a.stateSince
  if (since !== 0) return since
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Most sidebar agent rows shown under one workspace before "+N more" (E5-FR-19). */
export const AGENT_ROWS_MAX = 6

/**
 * Sidebar agent rows of one workspace (E5-FR-19): with 7 or more, the 6 best
 * by compareAgents, shown in layout order, plus how many stayed hidden.
 * `items` comes in layout order.
 */
export function pickAgentRows<T extends RankedPane>(items: readonly T[], max = AGENT_ROWS_MAX): { shown: T[]; hidden: number } {
  if (items.length <= max) return { shown: [...items], hidden: 0 }
  const best = new Set([...items].sort(compareAgents).slice(0, max).map((i) => i.id))
  return { shown: items.filter((i) => best.has(i.id)), hidden: items.length - max }
}

/**
 * Compact age for dense rows (palette, sidebar rows): "now"/"ahora", "3m",
 * "2h", "1d". Negative spans (clock skew) count as now.
 */
export function formatAgeShort(ms: number, lang: 'en' | 'es'): string {
  const min = Math.floor(Math.max(0, ms) / 60000)
  if (min < 1) return lang === 'es' ? 'ahora' : 'now'
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}
