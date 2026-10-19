/**
 * The `resume` branch of the phone's createPane (E3-FR-38/39): open a
 * history session in a new local console, or point at the console that
 * already holds it.
 *
 * Main already checked the id against its history index (else `notFound`).
 * Here the cwd is resolved from that index through `sessions:list` (never
 * taken from the phone), the console gets `setupId: ''` so the workspace's
 * Connection Profile does not apply (`??` only falls back on nullish), and
 * the first spawn resumes through prepareAgentLaunch and buildAgentArgv, the
 * same road as restartPane.resume. Nothing lands in `pane.command`.
 */
import type { RemoteCtlAction } from '@shared/remote-protocol'
import type { AgentPreset, AgentProvider, Pane } from '@shared/types'
import type { AgentSessionView } from '@shared/agents'
import type { SessionSummary } from '@shared/session-history'
import { useAppStore, type AppState } from './store'
import { useAgentStore } from './agentStore'

type CreatePaneAction = Extract<RemoteCtlAction, { kind: 'createPane' }>

export interface ResumeCmdResult {
  ok: boolean
  error?: string
  paneId?: string
}

/** Look of a console without a preset of that provider (the default presets' own). */
const BARE: Record<AgentProvider, Pick<Pane, 'title' | 'color' | 'icon'>> = {
  claude: { title: 'Claude Code', color: '#d97757', icon: 'claude' },
  codex: { title: 'Codex', color: '#10a37f', icon: 'openai' },
}

/**
 * The console already holding `sessionId` of `provider`: its live status,
 * its session record or its lastSession mirror (E3-FR-39). Null when none.
 */
export function paneHoldingSession(
  state: Pick<AppState, 'workspaces' | 'paneStatus'>,
  sessions: Record<string, AgentSessionView>,
  provider: AgentProvider,
  sessionId: string,
): string | null {
  const id = sessionId.toLowerCase()
  const same = (p: AgentProvider | undefined, s: string | undefined): boolean => !!s && s.toLowerCase() === id && (!p || p === provider)
  for (const ws of state.workspaces) {
    for (const pane of ws.panes) {
      const status = state.paneStatus[pane.id]
      if (same(status?.provider, status?.sessionId)) return pane.id
      const rec = sessions[pane.id]
      if (same(rec?.provider, rec?.sessionId)) return pane.id
      if (same(pane.lastSession?.provider, pane.lastSession?.sessionId)) return pane.id
    }
  }
  return null
}

/** The phone's preset when it is of that provider, else the first one of that type. */
export function resumePreset(presets: AgentPreset[], provider: AgentProvider, presetId: string | undefined): AgentPreset | undefined {
  const asked = presetId ? presets.find((p) => p.id === presetId) : undefined
  if (asked && asked.type === provider) return asked
  return presets.find((p) => p.type === provider)
}

export async function runCreatePaneResume(action: CreatePaneAction & { resume: NonNullable<CreatePaneAction['resume']> }): Promise<ResumeCmdResult> {
  const { provider, sessionId } = action.resume
  const holder = (): string | null => paneHoldingSession(useAppStore.getState(), useAgentStore.getState().sessions, provider, sessionId)
  if (!useAppStore.getState().workspaces.some((w) => w.id === action.workspaceId)) return { ok: false, error: 'not_found' }
  // E3-FR-38: an open session is never resumed twice; the phone goes to it.
  const open = holder()
  if (open) return { ok: true, paneId: open }

  let list: SessionSummary[] = []
  try {
    list = await window.snApi.sessions.list({ query: sessionId })
  } catch {
    list = []
  }
  const hit = list.find((s) => s.provider === provider && s.sessionId.toLowerCase() === sessionId.toLowerCase())
  if (!hit) return { ok: false, error: 'notFound' }

  // The store may have moved during the lookup.
  const store = useAppStore.getState()
  if (!store.workspaces.some((w) => w.id === action.workspaceId)) return { ok: false, error: 'not_found' }
  const late = holder()
  if (late) return { ok: true, paneId: late }

  const preset = resumePreset(store.presets, provider, action.presetId)
  const look = preset ? { presetId: preset.id, title: preset.name, color: preset.color, icon: preset.icon } : BARE[provider]
  const paneId = store.addPane(action.workspaceId, {
    type: provider,
    ...look,
    cwd: hit.cwd,
    setupId: '',
    lastSession: { provider, sessionId: hit.sessionId, cwd: hit.cwd, at: Date.now() },
  })
  if (!paneId) return { ok: false, error: 'not_found' }
  useAgentStore.getState().setResumeTarget(paneId, { provider, sessionId: hit.sessionId, cwd: hit.cwd, updatedAt: hit.updatedAt })
  // Only the new console spawns; the desktop keeps its workspace (E2-FR-06).
  useAppStore.getState().ensureMounted(action.workspaceId, { only: [paneId] })
  return { ok: true, paneId }
}
