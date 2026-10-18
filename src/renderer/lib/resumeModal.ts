/**
 * Model of the "resume interrupted chats?" dialog (E5-FR-12): which panes it
 * lists, how they group and read, and its unattended countdown. Pure: plain
 * values in, plain values out, so the rules are unit tested without React.
 */
import type { AgentPreset, AgentProvider, ResumeOnStartup, Workspace } from '@shared/types'
import { decideLaunch, effectiveProvider, type AgentSessionView, type AgentsStartup, type ExitTrigger } from '@shared/agents'
import type { MessageKey } from '@/i18n'
import { orderedPanes } from './agentNav'
import { sidebarOrder } from './sidebarOrder'

export interface ModalInput {
  workspaces: readonly Workspace[]
  presets: readonly AgentPreset[]
  sessions: Record<string, AgentSessionView>
  startup: AgentsStartup | null
  policy: ResumeOnStartup
}

/**
 * Interrupted panes the dialog asks about, in sidebar and grid order: with
 * the `ask` policy, the ones whose first spawn would wait for the dialog
 * (same truth table as the real spawn). Everything else resumes or starts
 * fresh on its own.
 */
export function resumeModalCandidates(input: ModalInput): string[] {
  if (input.policy !== 'ask' || !input.startup || input.startup.interrupted.length === 0) return []
  const interrupted = new Set(input.startup.interrupted)
  const out: string[] = []
  for (const ws of sidebarOrder(input.workspaces)) {
    for (const pane of orderedPanes(ws)) {
      if (!interrupted.has(pane.id)) continue
      const preset = pane.presetId ? input.presets.find((p) => p.id === pane.presetId) : undefined
      const decision = decideLaunch({
        pane,
        provider: effectiveProvider(pane, preset),
        hasSetup: !!(pane.setupId ?? ws.setupId),
        session: input.sessions[pane.id],
        startupUnconsumed: true,
        policy: input.policy,
        modalPending: true,
      })
      if (decision === 'pending') out.push(pane.id)
    }
  }
  return out
}

export interface ResumeRow {
  paneId: string
  provider: AgentProvider
  /** Topic, first prompt or the console's own title. */
  title: string
  /** What the agent was doing when the app closed. */
  stateKey: MessageKey
  lastPrompt?: string
  /** Last activity of the chat (epoch ms): the row's age. */
  updatedAt: number
  /** Mid-turn when interrupted: the ones the nudge writes to. */
  working: boolean
}

export interface ResumeGroup {
  workspaceId: string
  name: string
  rows: ResumeRow[]
}

/** "was working" / "waiting for you: permission" / "question pending" / "plan pending". */
export function interruptedStateKey(i: AgentSessionView['interrupted']): MessageKey {
  if (!i || i.activity === 'working') return 'agents.modal.state.working'
  if (i.reason === 'permission') return 'agents.modal.state.permission'
  if (i.reason === 'question' || i.reason === 'elicitation') return 'agents.modal.state.question'
  if (i.reason === 'plan') return 'agents.modal.state.plan'
  return 'agents.modal.state.action'
}

/** Subtitle by how the previous run ended ("on update", "on quit", ...). */
export function triggerKey(trigger: ExitTrigger | null | undefined): MessageKey {
  switch (trigger) {
    case 'update':
      return 'agents.modal.sub.update'
    case 'quit':
      return 'agents.modal.sub.quit'
    case 'shutdown':
      return 'agents.modal.sub.shutdown'
    default:
      return 'agents.modal.sub.crash'
  }
}

/** The dialog's rows grouped by workspace, in the order `paneIds` comes (sidebar, then grid). */
export function resumeGroups(paneIds: readonly string[], workspaces: readonly Workspace[], sessions: Record<string, AgentSessionView>): ResumeGroup[] {
  const groups: ResumeGroup[] = []
  for (const paneId of paneIds) {
    const ws = workspaces.find((w) => w.panes.some((p) => p.id === paneId))
    const pane = ws?.panes.find((p) => p.id === paneId)
    const session = sessions[paneId]
    if (!ws || !pane || !session) continue
    let group = groups.find((g) => g.workspaceId === ws.id)
    if (!group) {
      group = { workspaceId: ws.id, name: ws.name, rows: [] }
      groups.push(group)
    }
    group.rows.push({
      paneId,
      provider: session.provider,
      title: session.topic || session.firstPrompt || pane.title,
      stateKey: interruptedStateKey(session.interrupted),
      lastPrompt: session.lastPrompt || undefined,
      updatedAt: session.updatedAt,
      working: session.interrupted?.activity === 'working',
    })
  }
  return groups
}

/** Tri-state of a workspace checkbox. */
export function groupCheck(rows: readonly ResumeRow[], selected: ReadonlySet<string>): 'all' | 'some' | 'none' {
  const n = rows.filter((r) => selected.has(r.paneId)).length
  return n === 0 ? 'none' : n === rows.length ? 'all' : 'some'
}

/**
 * Unattended countdown (E5-FR-12): ms left before "Resume N" applies itself,
 * or null when there is none (timeout 0 = never, or cancelled by any
 * interaction with the dialog).
 */
export function countdownLeft(openedAt: number, timeoutSec: number, now: number, cancelled: boolean): number | null {
  if (cancelled || !(timeoutSec > 0)) return null
  return Math.max(0, openedAt + timeoutSec * 1000 - now)
}

/** "0:45", "1:00", "10:00": whole seconds rounded up so it never reads 0:00 early. */
export function formatCountdown(ms: number): string {
  const total = Math.ceil(Math.max(0, ms) / 1000)
  const min = Math.floor(total / 60)
  const sec = total % 60
  return `${min}:${sec < 10 ? '0' : ''}${sec}`
}
