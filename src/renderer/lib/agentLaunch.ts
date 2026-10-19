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
import { translate, type MessageKey } from '@/i18n'
import type { ResolvedLaunch } from './launch'
import { useAppStore, type AppState } from './store'
import { useAgentStore } from './agentStore'
import { getPtyId } from './ptyRegistry'
import { resumeModalCandidates } from './resumeModal'
import { createNudger, type Nudger } from './resumeNudge'

/** No `start` from a resumed session in this long = the resume failed (E5-FR-08). */
export const RESUME_WATCH_MS = 20_000

let loading: Promise<void> | null = null
const watches = new Map<string, ReturnType<typeof setTimeout>>()
/** Spawns held back by the resume dialog, released when it is decided (E5-FR-12). */
let modalWaiters: Array<() => void> = []
let nudger: Nudger | null = null

/** The resume nudge (E5-FR-13) over the real pty and status. */
function getNudger(): Nudger {
  nudger ??= createNudger({
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    write: (paneId, data) => {
      const ptyId = getPtyId(paneId)
      if (!ptyId) return false
      window.snApi.pty.write({ ptyId, data })
      return true
    },
    isAction: (paneId) => useAppStore.getState().paneStatus[paneId]?.state === 'action',
  })
  return nudger
}

/** Text the nudge writes: the user's own, or the default of the UI language. */
export function nudgeText(): string {
  const s = useAppStore.getState().settings
  // One line: a control character from a hand-edited config (a CR above all) never reaches the pty.
  // eslint-disable-next-line no-control-regex
  const own = (s.agents?.resumeNudgeText ?? '').replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim()
  return own || translate(s.language, 'agents.nudge.default')
}

/** Closes the resume dialog and lets every spawn it held go. */
function closeModal(): void {
  useAgentStore.getState().setModal(null)
  const waiters = modalWaiters
  modalWaiters = []
  for (const release of waiters) release()
}

/**
 * A listed console that started anyway (a restart from its menu or the phone
 * while the dialog is open) leaves the dialog: its placeholder lifts off the
 * running console and the dialog's later choice does not linger as an intent
 * for its next restart. The last one leaving closes the dialog.
 */
function leaveModal(paneId: string): void {
  const modal = useAgentStore.getState().modal
  if (!modal || !modal.paneIds.includes(paneId)) return
  const paneIds = modal.paneIds.filter((id) => id !== paneId)
  if (paneIds.length === 0) closeModal()
  else useAgentStore.getState().setModal({ ...modal, paneIds })
}

/** Resolves once the resume dialog is closed (at once when none is open). */
function waitForModal(): Promise<void> {
  if (!useAgentStore.getState().modalPending) return Promise.resolve()
  return new Promise((resolve) => modalWaiters.push(resolve))
}

/**
 * Opens the "resume interrupted chats?" dialog (E5-FR-12) when the `ask`
 * policy has interrupted chats whose startup decision is still unspent (a
 * renderer reload after the decision does not ask again). Runs inside
 * ensureAgentsLoaded, so no spawn decides before the dialog is known.
 */
async function openResumeModalIfNeeded(): Promise<void> {
  const app = useAppStore.getState()
  const agents = useAgentStore.getState()
  if (agents.modal) return
  const ids = resumeModalCandidates({
    workspaces: app.workspaces,
    presets: app.presets,
    sessions: agents.sessions,
    startup: agents.startup,
    policy: app.settings.agents?.resumeOnStartup ?? 'ask',
  })
  if (ids.length === 0) return
  let pending: string[] = []
  try {
    pending = await window.snApi.agents.startupPending(ids)
  } catch {
    pending = []
  }
  const open = ids.filter((id) => pending.includes(id))
  if (open.length === 0) return
  useAgentStore.getState().setModal({ paneIds: open, trigger: agents.startup?.trigger ?? null, openedAt: Date.now() })
}

/** What the dialog's buttons (and its countdown) apply. */
export interface ResumeChoice {
  /** Panes to resume; every other listed pane starts a new chat. */
  resume: string[]
  /** "Start fresh": no pane resumes and every listed chat is forgotten. */
  startFresh?: boolean
  /** "Don't ask again": the policy becomes `auto`. */
  dontAskAgain?: boolean
  /** The nudge checkbox, saved as settings.agents.resumeNudge. */
  nudge?: boolean
}

/**
 * Applies the dialog's decision: one-shot intents for every listed pane
 * (resume or fresh), the settings it changed, mounting of the resumed
 * consoles in workspaces not opened yet (E5-FR-10), then the held spawns go.
 */
export function applyResumeChoice(choice: ResumeChoice): void {
  const agents = useAgentStore.getState()
  const modal = agents.modal
  if (!modal) return
  const app = useAppStore.getState()
  const current = app.settings.agents
  if (current && ((choice.dontAskAgain && current.resumeOnStartup !== 'auto') || (choice.nudge !== undefined && choice.nudge !== current.resumeNudge))) {
    app.updateSettings({
      agents: {
        ...current,
        ...(choice.dontAskAgain ? { resumeOnStartup: 'auto' as const } : {}),
        ...(choice.nudge !== undefined ? { resumeNudge: choice.nudge } : {}),
      },
    })
  }
  const resume = new Set(choice.startFresh ? [] : choice.resume.filter((id) => modal.paneIds.includes(id)))
  for (const paneId of modal.paneIds) {
    if (resume.has(paneId)) {
      agents.setIntent(paneId, 'resume')
      continue
    }
    agents.setIntent(paneId, 'fresh')
    if (choice.startFresh) {
      window.snApi.agents.forget(paneId)
      if (useAgentStore.getState().sessions[paneId]) useAgentStore.getState().applyChanged({ paneId, removed: true })
      app.clearLastSession(paneId)
    }
  }
  closeModal()
  const byWs = new Map<string, string[]>()
  for (const paneId of resume) {
    const found = findPane(useAppStore.getState(), paneId)
    if (found) byWs.set(found.ws.id, [...(byWs.get(found.ws.id) ?? []), paneId])
  }
  for (const [wsId, only] of byWs) useAppStore.getState().ensureMounted(wsId, { only })
}

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
    if (nudger) nudger.onReady(evt)
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
  loading = Promise.all([list, startup])
    .then(() => openResumeModalIfNeeded())
    .catch(() => undefined)
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
  let intent = agents.takeIntent(paneId)
  const target = agents.takeResumeTarget(paneId)
  cancelWatch(paneId)
  getNudger().cancel(paneId)
  if (!found) return base
  const { pane } = found
  const preset = presetOf(app, pane)
  const provider = effectiveProvider(pane, preset)
  // E3-FR-39: a console the phone opened from the history resumes that session
  // on its first spawn only, in the session's own folder; it is never written
  // to pane.command, so later spawns follow the usual rules (lastSession).
  if (target && !base.setup) {
    const command = buildAgentArgv({ preset, command: pane.command, resume: { provider: target.provider, sessionId: target.sessionId } })
    if (command) {
      try {
        await window.snApi.agents.consumeStartup(paneId)
      } catch {
        /* a new console has no startup decision to spend */
      }
      armResumed(paneId, target.provider, target.updatedAt)
      return { ...base, cwd: target.cwd || base.cwd, initialCommand: command, launchKind: 'other', resumed: true }
    }
  }
  let session: AgentSessionView | undefined = agents.sessions[paneId]
  const hasSetup = !!base.setup
  let startupUnconsumed = false
  try {
    startupUnconsumed = await window.snApi.agents.consumeStartup(paneId)
  } catch {
    startupUnconsumed = false
  }
  const policy = app.settings.agents?.resumeOnStartup ?? 'ask'
  let decision = decideLaunch({ pane, provider, hasSetup, session, intent, startupUnconsumed, policy, modalPending: useAgentStore.getState().modalPending })
  if (decision === 'pending') {
    // Held back by the resume dialog (E5-FR-12): its decision arrives as this pane's intent.
    await waitForModal()
    intent = useAgentStore.getState().takeIntent(paneId)
    session = useAgentStore.getState().sessions[paneId]
    decision = decideLaunch({ pane, provider, hasSetup, session, intent, startupUnconsumed, policy, modalPending: false })
  } else {
    leaveModal(paneId)
  }
  if (decision !== 'fresh' && session) {
    const command = buildAgentArgv({ preset, command: pane.command, resume: { provider: session.provider, sessionId: session.sessionId } })
    if (command) {
      agents.setChip(paneId, { kind: 'resumed', provider: session.provider, updatedAt: session.updatedAt, shownAt: Date.now() })
      // A chat that was mid-turn when the app closed gets "continue where you left off" once ready (E5-FR-13).
      if (startupUnconsumed && session.interrupted?.activity === 'working' && useAppStore.getState().settings.agents?.resumeNudge) {
        getNudger().arm(paneId, nudgeText())
      }
      if (hasReadySignal(session.provider)) {
        watches.set(
          paneId,
          setTimeout(() => {
            watches.delete(paneId)
            useAgentStore.getState().setChip(paneId, { kind: 'failed', shownAt: Date.now() })
          }, RESUME_WATCH_MS),
        )
      }
      // A resume command never takes a positional prompt (E8-FR-02b): 'other'.
      return { ...base, cwd: session.spawnCwd || session.cwd || base.cwd, initialCommand: command, launchKind: 'other', resumed: true }
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

/** The "resumed" chip and, when the provider can confirm it, the 20 s watch (E5-FR-08). */
function armResumed(paneId: string, provider: AgentProvider, updatedAt: number): void {
  useAgentStore.getState().setChip(paneId, { kind: 'resumed', provider, updatedAt, shownAt: Date.now() })
  if (!hasReadySignal(provider)) return
  watches.set(
    paneId,
    setTimeout(() => {
      watches.delete(paneId)
      useAgentStore.getState().setChip(paneId, { kind: 'failed', shownAt: Date.now() })
    }, RESUME_WATCH_MS),
  )
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
