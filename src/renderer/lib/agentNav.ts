/**
 * Agent navigation model (E5-FR-15..19): which consoles the palette's
 * "Waiting for you" section, the sidebar agent rows and "next waiting" show,
 * in which order, and the words they use. Pure: it reads plain values handed
 * in by the caller and never touches the stores or the DOM, so the rules are
 * unit tested.
 */
import type { AgentPreset, AgentProvider, Language, Pane, PaneStatus, ResumeOnStartup, Workspace } from '@shared/types'
import {
  agentRank,
  compareAgents,
  decideLaunch,
  effectiveProvider,
  formatAgeShort,
  type AgentSessionView,
  type RankedPane,
} from '@shared/agents'
import { displayStatus } from '@shared/status'
import type { TFn } from '@/i18n'
import { isPaneMounted, type MountedWorkspaces } from './mounting'
import { waitingPhrase } from './formatSince'

export interface NavInput {
  workspaces: readonly Workspace[]
  paneStatus: Record<string, PaneStatus>
  paneAttention: Record<string, true>
  mountedWorkspaces: MountedWorkspaces
  sessions: Record<string, AgentSessionView>
  presets: readonly AgentPreset[]
  policy: ResumeOnStartup
  /** Sleeping consoles (E5-FR-25): paneId -> when they went to sleep. */
  sleeping?: Record<string, { at: number }>
}

/** One agent console the navigation surfaces can show. */
export interface AgentEntry extends RankedPane {
  ws: Workspace
  pane: Pane
  status?: PaneStatus
  /** Not spawned yet (workspace not mounted) and resumes its chat on open. */
  notStarted: boolean
  /** Put to sleep by hibernation (E5-FR-25): rank 4, the moon glyph. */
  sleeping?: boolean
  session?: AgentSessionView
}

/** Panes of a workspace in grid (layout.order) order; unknown ids are skipped. */
export function orderedPanes(ws: Workspace): Pane[] {
  const order = ws.layout?.order
  if (!order) return ws.panes
  const byId = new Map(ws.panes.map((p) => [p.id, p]))
  const out: Pane[] = []
  for (const id of order) {
    const p = byId.get(id)
    if (p) {
      out.push(p)
      byId.delete(id)
    }
  }
  return [...out, ...byId.values()]
}

/**
 * True when a console that has not spawned yet will resume its chat the
 * first time its workspace opens (same truth table as the real spawn).
 */
export function willResumeOnOpen(ws: Workspace, pane: Pane, presets: readonly AgentPreset[], session: AgentSessionView | undefined, policy: ResumeOnStartup): boolean {
  if (!session) return false
  const preset = pane.presetId ? presets.find((p) => p.id === pane.presetId) : undefined
  return (
    decideLaunch({
      pane,
      provider: effectiveProvider(pane, preset),
      hasSetup: !!(pane.setupId ?? ws.setupId),
      session,
      startupUnconsumed: true,
      policy,
      modalPending: false,
    }) === 'resume'
  )
}

/**
 * Every agent console of one workspace, in layout order: panes with a live
 * status, plus (in a workspace or partial mount where the pane has not
 * spawned) records that resume when it opens, ranked 4 as "not started".
 */
export function workspaceAgents(ws: Workspace, input: NavInput): AgentEntry[] {
  const out: AgentEntry[] = []
  for (const pane of orderedPanes(ws)) {
    const status = input.paneStatus[pane.id]
    const session = input.sessions[pane.id]
    const sleep = input.sleeping?.[pane.id]
    if (sleep) {
      out.push({ id: pane.id, ws, pane, session, notStarted: false, sleeping: true, rank: 4, unread: false, stateSince: sleep.at })
    } else if (status) {
      out.push({
        id: pane.id,
        ws,
        pane,
        status,
        session,
        notStarted: false,
        rank: agentRank(status.state, status.attention),
        // v2.3: main's attention (a done or error nobody saw), or the CLI's local mark.
        unread: status.attention === true || !!input.paneAttention[pane.id],
        stateSince: status.stateSince ?? status.updatedAt ?? 0,
      })
    } else if (!isPaneMounted(input.mountedWorkspaces, ws.id, pane.id) && willResumeOnOpen(ws, pane, input.presets, session, input.policy)) {
      out.push({ id: pane.id, ws, pane, session, notStarted: true, rank: 4, unread: false, stateSince: session?.updatedAt ?? 0 })
    }
  }
  return out
}

/** workspaceAgents of every workspace, in workspace order. */
export function allAgents(input: NavInput): AgentEntry[] {
  return input.workspaces.flatMap((ws) => workspaceAgents(ws, input))
}

/** Rows of the palette's "Waiting for you" section (E5-FR-15). */
export const PALETTE_WAITING_MAX = 6

/**
 * Ids for "Waiting for you": up to 6 agent consoles of every workspace by
 * urgency, without the console the user is looking at.
 */
export function paletteWaiting(entries: readonly AgentEntry[], excludeId: string | null, max = PALETTE_WAITING_MAX): string[] {
  return entries
    .filter((e) => e.id !== excludeId)
    .sort(compareAgents)
    .slice(0, max)
    .map((e) => e.id)
}

/**
 * Consoles "next waiting" walks (E5-FR-17): action/error, then unread done,
 * the ones waiting longest first.
 */
export function waitingIds(entries: readonly AgentEntry[]): string[] {
  return entries
    .filter((e) => !e.notStarted && (e.rank === 1 || (e.rank === 2 && e.unread)))
    .sort(compareAgents)
    .map((e) => e.id)
}

/** Presses of "next waiting" this close together walk one frozen list. */
export const WAITING_WINDOW_MS = 5000

export interface WaitingCursor {
  ids: string[]
  index: number
  at: number
}

/**
 * One press of "next waiting". Inside the 5 s window it advances along the
 * list frozen by the first press (revealing a console clears its unread flag,
 * so a fresh list would skip it), wrapping around and skipping consoles that
 * were closed. Outside the window, or when every frozen one is gone, it starts
 * over from a fresh list. target null = nobody is waiting.
 */
export function advanceWaiting(
  cursor: WaitingCursor | null,
  fresh: () => string[],
  exists: (id: string) => boolean,
  now: number,
): { cursor: WaitingCursor | null; target: string | null } {
  const walk = (ids: string[], start: number): { cursor: WaitingCursor | null; target: string | null } | null => {
    for (let k = 0; k < ids.length; k++) {
      const i = (start + k) % ids.length
      if (exists(ids[i])) return { cursor: { ids, index: i, at: now }, target: ids[i] }
    }
    return null
  }
  if (cursor && now - cursor.at < WAITING_WINDOW_MS && cursor.ids.length > 0) {
    const hit = walk(cursor.ids, cursor.index + 1)
    if (hit) return hit
  }
  return walk(fresh(), 0) ?? { cursor: null, target: null }
}

/**
 * Title of an agent row (E5-FR-19): with topicAsTitle on and the console not
 * renamed (its title is still its preset's name), the agent's topic or first
 * prompt; otherwise the console's own title.
 */
export function agentTitle(pane: Pane, presets: readonly AgentPreset[], info: { topic?: string; firstPrompt?: string } | undefined, topicAsTitle: boolean): string {
  if (!topicAsTitle) return pane.title
  const preset = pane.presetId ? presets.find((p) => p.id === pane.presetId) : undefined
  if (!preset || pane.title !== preset.name) return pane.title
  return info?.topic || info?.firstPrompt || pane.title
}

/**
 * v2.4: the agent a shell console runs right now (`claude` / `codex` typed
 * by hand, or its title), read from the live status; the saved type stays
 * shell. Agent and custom consoles keep their own icon and title.
 */
export function runningAgentOf(pane: Pick<Pane, 'type'>, status: { provider?: AgentProvider } | null | undefined): AgentProvider | undefined {
  return pane.type === 'shell' && status?.provider ? status.provider : undefined
}

/** Icon name of a console's header and agent row: its running agent's for a shell, else its own. */
export function agentIconName(pane: Pick<Pane, 'type' | 'icon'>, status: { provider?: AgentProvider } | null | undefined): string | undefined {
  const agent = runningAgentOf(pane, status)
  return agent ? (agent === 'codex' ? 'openai' : 'claude') : pane.icon
}

/** First line of a text, trimmed. */
function firstLine(text: string | undefined): string {
  return (text ?? '').split(/\r?\n/, 1)[0].trim()
}

/**
 * Second line of an agent row (E5 G4 phrases): what the agent is on, plus
 * its age where the table has one. `withAge: false` drops the age (the
 * palette already shows it on the first line).
 */
export function agentPhrase(e: AgentEntry, t: TFn, lang: Language, now: number, withAge = true): string {
  if (e.sleeping) return withAge && e.stateSince ? `${t('agents.row.sleeping')} · ${formatAgeShort(now - e.stateSince, lang)}` : t('agents.row.sleeping')
  if (e.notStarted || !e.status) return t('agents.row.notStarted')
  // v2.3: an answered request reads like the glyph (working, or idle title-only).
  const s = displayStatus(e.status)
  const age = formatAgeShort(now - e.stateSince, lang)
  const tail = (text: string): string => (withAge && e.stateSince ? `${text} · ${age}` : text)
  const detail = firstLine(s.detail?.text)
  switch (s.state) {
    case 'working':
      if (s.waiting) return tail(waitingPhrase(s.waiting, t))
      return tail(detail || t('agents.row.working'))
    case 'action':
      if (s.reason === 'permission') return detail ? t('agents.row.permission', { text: detail }) : t('agents.row.action')
      if (s.reason === 'question') return detail ? t('agents.row.question', { text: detail }) : t('agents.row.action')
      if (s.reason === 'plan') return t('agents.row.plan')
      return t('agents.row.action')
    case 'done': {
      const reply = firstLine(s.lastMessage) || (s.detail?.kind === 'reply' ? detail : '')
      const done = reply ? t('agents.row.doneReply', { text: reply }) : t('agents.row.done')
      // v2.2: work left running that does not hold the console (a dev server).
      const text = s.backgroundOther ? `${done} · ${t('agents.row.backgroundOther', { count: s.backgroundOther })}` : done
      return withAge && e.stateSince ? `${text} · ${t('agents.row.ago', { age })}` : text
    }
    case 'error':
      return t('agents.row.error')
    case 'idle':
      return tail(t('agents.row.idle'))
    default:
      return t('agents.row.unknown')
  }
}

/**
 * Console ids of the active workspace in grid order without minimized ones
 * (focus next/previous, E5-FR-18).
 */
export function navigablePanes(ws: Workspace, minimized: readonly string[]): string[] {
  return orderedPanes(ws).filter((p) => !minimized.includes(p.id)).map((p) => p.id)
}

/**
 * The visible consoles of a workspace in grid order, the targets of
 * Ctrl+1..9: only the maximized one while a console is maximized.
 */
export function visibleConsoles(ws: Workspace, minimized: readonly string[], maximized: string | null | undefined): string[] {
  const ids = navigablePanes(ws, minimized)
  return maximized && ids.includes(maximized) ? [maximized] : ids
}

/** Next (dir 1) or previous (dir -1) console after `current`, wrapping. */
export function stepPane(ids: readonly string[], current: string | null, dir: 1 | -1): string | null {
  if (ids.length === 0) return null
  const at = current ? ids.indexOf(current) : -1
  if (at < 0) return dir === 1 ? ids[0] : ids[ids.length - 1]
  return ids[(at + dir + ids.length) % ids.length]
}

/** NavInput from the app and agent stores' current values. */
export function navInputFrom(
  app: Pick<NavInput, 'workspaces' | 'paneStatus' | 'paneAttention' | 'mountedWorkspaces' | 'presets'> & { settings: { agents?: { resumeOnStartup?: ResumeOnStartup } } },
  agents: { sessions: Record<string, AgentSessionView>; sleeping?: Record<string, { at: number }> },
): NavInput {
  return {
    workspaces: app.workspaces,
    paneStatus: app.paneStatus,
    paneAttention: app.paneAttention,
    mountedWorkspaces: app.mountedWorkspaces,
    sessions: agents.sessions,
    presets: app.presets,
    policy: app.settings.agents?.resumeOnStartup ?? 'ask',
    sleeping: agents.sleeping,
  }
}
