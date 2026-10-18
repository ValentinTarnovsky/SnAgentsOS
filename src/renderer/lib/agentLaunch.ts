/**
 * Launch decisions for agent consoles (E5-FR-08..11, 14): whether a spawn
 * resumes the pane's last chat or starts fresh, the chips that explain it,
 * the 20 s "did the resume work?" watch and the restart actions the menu,
 * the header button and the phone use.
 *
 * Runs only on a real spawn: a renderer reload or remount reattaches to the
 * live pty first (useXterm), so nothing is relaunched twice. The startup
 * policy is spent per pane through agents:consumeStartup, which main answers
 * true once per run.
 */
import { buildAgentArgv } from '@shared/agent-argv'
import { decideLaunch, effectiveProvider, type AgentSessionView } from '@shared/agents'
import type { AgentPreset, AgentProvider, Pane, Workspace } from '@shared/types'
import type { MessageKey } from '@/i18n'
import type { ResolvedLaunch } from './launch'
import { useAppStore, type AppState } from './store'
import { useAgentStore } from './agentStore'

/** No `start` from a resumed session in this long = the resume failed (E5-FR-08). */
export const RESUME_WATCH_MS = 20_000

let loading: Promise<void> | null = null
const watches = new Map<string, ReturnType<typeof setTimeout>>()

function findPane(s: Pick<AppState, 'workspaces'>, paneId: string): { ws: Workspace; pane: Pane } | null {
  for (const ws of s.workspaces) {
    const pane = ws.panes.find((p) => p.id === paneId)
    if (pane) return { ws, pane }
  }
  return null
}

function presetOf(s: Pick<AppState, 'presets'>, pane: Pane): AgentPreset | undefined {
  return pane.presetId ? s.presets.find((p) => p.id === pane.presetId) : undefined
}

function cancelWatch(paneId: string): void {
  const t = watches.get(paneId)
  if (t) clearTimeout(t)
  watches.delete(paneId)
}

/**
 * Loads main's session views and the startup info once, and keeps them
 * current (agents:changed / agents:ready). Every caller shares one promise.
 */
export function ensureAgentsLoaded(): Promise<void> {
  if (loading) return loading
  const api = window.snApi.agents
  const agents = useAgentStore.getState()
  api.onChanged((evt) => useAgentStore.getState().applyChanged(evt))
  api.onReady((evt) => {
    if (evt.phase !== 'start') return
    // Any session start in the pane proves the resume worked.
    cancelWatch(evt.paneId)
    if (useAgentStore.getState().resumeChip[evt.paneId]?.kind === 'failed') useAgentStore.getState().setChip(evt.paneId, null)
  })
  // The list is applied the moment its reply lands: an agents:changed that
  // arrives later (another IPC message) must not be overwritten by it.
  const list = api.list().then((views) => agents.setSessions(views), () => undefined)
  const startup = api.startup().then(
    (info) => agents.setStartup(info),
    () => agents.setStartup({ trigger: null, interrupted: [] }),
  )
  loading = Promise.all([list, startup]).then(() => undefined)
  return loading
}

/** Whether a resume can be confirmed at all: Claude needs hooks, Codex the bridge. */
function hasReadySignal(provider: AgentProvider): boolean {
  const n = useAppStore.getState().settings.notifications
  return provider === 'claude' ? n.hooksEnabled : n.codexEnabled
}

/**
 * What the next spawn of `paneId` runs (called by useXterm on a real spawn,
 * never on a reattach). Consumes the pane's one-shot intent and, the first
 * time in this run, its startup decision. Resuming relaunches in the
 * session's spawn directory with the command from buildAgentArgv.
 */
export async function prepareAgentLaunch(paneId: string, base: ResolvedLaunch): Promise<ResolvedLaunch> {
  await ensureAgentsLoaded()
  const app = useAppStore.getState()
  const found = findPane(app, paneId)
  const agents = useAgentStore.getState()
  const intent = agents.takeIntent(paneId)
  cancelWatch(paneId)
  if (!found) return base
  const { pane } = found
  const preset = presetOf(app, pane)
  const provider = effectiveProvider(pane, preset)
  const session: AgentSessionView | undefined = agents.sessions[paneId]
  const hasSetup = !!base.setup
  let startupUnconsumed = false
  try {
    startupUnconsumed = await window.snApi.agents.consumeStartup(paneId)
  } catch {
    startupUnconsumed = false
  }
  const policy = app.settings.agents?.resumeOnStartup ?? 'ask'
  const decision = decideLaunch({ pane, provider, hasSetup, session, intent, startupUnconsumed, policy, modalPending: agents.modalPending })
  // 'pending' needs the startup dialog (E5-FR-12); without it `ask` acts as `auto`.
  if (decision !== 'fresh' && session) {
    const command = buildAgentArgv({ preset, command: pane.command, resume: { provider: session.provider, sessionId: session.sessionId } })
    if (command) {
      agents.setChip(paneId, { kind: 'resumed', provider: session.provider, updatedAt: session.updatedAt, shownAt: Date.now() })
      if (hasReadySignal(session.provider)) {
        watches.set(
          paneId,
          setTimeout(() => {
            watches.delete(paneId)
            useAgentStore.getState().setChip(paneId, { kind: 'failed', shownAt: Date.now() })
          }, RESUME_WATCH_MS),
        )
      }
      return { ...base, cwd: session.spawnCwd || session.cwd || base.cwd, initialCommand: command, resumed: true }
    }
  }
  // The chat that would have come back is gone: say so (explicit resume, or
  // the startup policy acting on this pane's own agent).
  const policyWanted =
    startupUnconsumed && policy !== 'off' && !!session && !session.endedAt && session.provider === provider && !hasSetup
  // A phone resume:true on a plain shell or an SSH console has no chat to miss.
  const explicitMiss = intent === 'resume' && !hasSetup && (!!session || provider !== null)
  if (explicitMiss || (policyWanted && session?.available === false)) {
    agents.setChip(paneId, { kind: 'unavailable', shownAt: Date.now() })
  } else if (agents.resumeChip[paneId]) {
    agents.setChip(paneId, null)
  }
  return base
}

/** Resume menu state for a pane (E5-FR-09). `show: false` hides both entries. */
export interface ResumeMenuState {
  show: boolean
  provider: AgentProvider | null
  canResume: boolean
  /** Why "Restart resuming the chat" is disabled. */
  reason?: MessageKey
  /** What the header restart button does (its tooltip). */
  button: 'resume' | 'fresh'
}

const UNAVAILABLE_KEYS: Record<NonNullable<AgentSessionView['unavailableReason']>, MessageKey> = {
  transcript: 'agents.why.transcript',
  cwd: 'agents.why.cwd',
  claimed: 'agents.why.claimed',
}

/** Pure: resume menu state from the stores' current values. */
export function resumeMenuState(app: Pick<AppState, 'workspaces' | 'presets' | 'settings'>, sessions: Record<string, AgentSessionView>, paneId: string): ResumeMenuState {
  const found = findPane(app, paneId)
  const none: ResumeMenuState = { show: false, provider: null, canResume: false, button: 'fresh' }
  if (!found) return none
  const { ws, pane } = found
  // Same rule as main's registry: a console behind a Connection Profile never resumes.
  if (pane.setupId ?? ws.setupId) return none
  const own = effectiveProvider(pane, presetOf(app, pane))
  const session = sessions[paneId]
  const provider = session?.provider ?? own
  if (!provider) return none
  const policy = app.settings.agents?.resumeOnStartup ?? 'ask'
  const resumable = !!session && session.available !== false
  const button = policy !== 'off' && resumable && session!.provider === own ? 'resume' : 'fresh'
  const n = app.settings.notifications
  let reason: MessageKey | undefined
  if (provider === 'claude' && !n.hooksEnabled) reason = 'agents.why.hooks'
  else if (provider === 'codex' && !n.codexEnabled) reason = 'agents.why.codex'
  else if (!session) reason = 'agents.why.noRecord'
  else if (session.available === false) reason = UNAVAILABLE_KEYS[session.unavailableReason ?? 'transcript']
  return { show: true, provider, canResume: !reason, reason, button }
}

/**
 * `RemotePaneInfo.resumable` (D10): an agent pane without a Connection
 * Profile whose session can be resumed. Absent/false hides the phone's
 * "Relaunch resuming" and "New chat".
 */
export function paneResumable(pane: Pane, ws: Workspace, presets: AgentPreset[], session: AgentSessionView | undefined): boolean {
  if (pane.setupId ?? ws.setupId) return false
  const preset = pane.presetId ? presets.find((p) => p.id === pane.presetId) : undefined
  return effectiveProvider(pane, preset) !== null && !!session && session.available !== false
}

/** "Restart resuming the chat" (menu, phone `resume: true`, reopen). */
export function restartResume(paneId: string): void {
  useAgentStore.getState().setIntent(paneId, 'resume')
  useAppStore.getState().restartPane(paneId)
}

/** "Restart with a new chat": forget the session everywhere, then relaunch clean. */
export function restartFresh(paneId: string): void {
  window.snApi.agents.forget(paneId)
  const agents = useAgentStore.getState()
  if (agents.sessions[paneId]) agents.applyChanged({ paneId, removed: true })
  agents.setChip(paneId, null)
  cancelWatch(paneId)
  useAppStore.getState().clearLastSession(paneId)
  agents.setIntent(paneId, 'fresh')
  useAppStore.getState().restartPane(paneId)
}

/** The header restart button (and a phone restartPane without `resume`). */
export function restartFromButton(paneId: string): void {
  const state = resumeMenuState(useAppStore.getState(), useAgentStore.getState().sessions, paneId)
  useAgentStore.getState().setIntent(paneId, state.button)
  useAppStore.getState().restartPane(paneId)
}

/**
 * "Restart clean" (E6-FR-18): same launch decision as the header button, but
 * remounts the console (empty screen) instead of restarting in place.
 */
export function restartClean(paneId: string): void {
  const state = resumeMenuState(useAppStore.getState(), useAgentStore.getState().sessions, paneId)
  useAgentStore.getState().setIntent(paneId, state.button)
  useAppStore.getState().restartPaneClean(paneId)
}

/** Chip button "Start a new chat" after a failed resume. */
export function startNewChatAfterFailure(paneId: string): void {
  restartFresh(paneId)
}

/**
 * Reopen the last closed console (context menu, palette, Ctrl+Shift+U from
 * R21-05). It keeps its id, so its session record is still there: resume when
 * it is available.
 */
export function reopenClosedConsole(): boolean {
  const reopened = useAppStore.getState().reopenClosedPane()
  if (!reopened) return false
  const session = useAgentStore.getState().sessions[reopened.paneId]
  if (session && session.available !== false) useAgentStore.getState().setIntent(reopened.paneId, 'resume')
  return true
}

/**
 * Startup mounting (E5-FR-10): consoles whose agent was interrupted and will
 * resume under the policy are mounted right away, even in workspaces never
 * opened; the rest resume on the first visit. Call once after hydrate.
 */
export async function mountInterruptedAgents(): Promise<void> {
  await ensureAgentsLoaded()
  const app = useAppStore.getState()
  const agents = useAgentStore.getState()
  const policy = app.settings.agents?.resumeOnStartup ?? 'ask'
  if (policy === 'off' || !agents.startup) return
  const byWs = new Map<string, string[]>()
  for (const paneId of agents.startup.interrupted) {
    const found = findPane(app, paneId)
    const session = agents.sessions[paneId]
    if (!found || !session) continue
    const { ws, pane } = found
    if (pane.setupId ?? ws.setupId) continue
    const decision = decideLaunch({
      pane,
      provider: effectiveProvider(pane, presetOf(app, pane)),
      hasSetup: false,
      session,
      startupUnconsumed: true,
      policy,
      modalPending: agents.modalPending,
    })
    if (decision !== 'resume') continue
    byWs.set(ws.id, [...(byWs.get(ws.id) ?? []), paneId])
  }
  for (const [wsId, only] of byWs) useAppStore.getState().ensureMounted(wsId, { only })
}
