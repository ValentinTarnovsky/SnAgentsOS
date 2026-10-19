import { create } from 'zustand'
import type {
  AgentPreset,
  AgentSessionEndEvt,
  PaneStatus,
  ConfigFile,
  ConnectionProfile,
  GridPreset,
  KeyButton,
  Pane,
  PaneSchedule,
  PaneStatusEvt,
  PaneWorktree,
  PaneType,
  QuickCommand,
  Settings,
  Workspace,
  WorkspaceLayout,
  WorkspaceRepoConfig,
  WorkspaceTaskState,
} from '@shared/types'
import { isTaskState, normalizeWorkspaceNote } from '@shared/workspaceNote'
import { gridForCount, orderPanes } from '@/components/layout/gridTemplates'
import {
  QUICK_COMMANDS_MAX,
  mergeQuickCommands,
  migrateQuickCommandsConfig,
  parseQuickCommand,
} from '@shared/quickCommands'
import { killPanePtys } from '@/lib/ptyRegistry'
import { trashSavedScrollback } from '@/lib/scrollback'
import { restartInPlace } from '@/lib/restartRegistry'
import { visiblePaneIds } from '@shared/status'
import { useAgentStore } from '@/lib/agentStore'
import { orderIndexOf, transferPane, type PaneHome, type PaneHomes } from '@/lib/paneHome'
import {
  type EnsureMountedOpts,
  type MountedWorkspaces,
  keepMounted,
  withMounted,
  withoutMounted,
} from '@/lib/mounting'

const ACCENTS = ['#6366f1', '#8b5cf6', '#60a5fa']

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`
}

function makeShellPane(index: number): Pane {
  return {
    id: uid('pane'),
    type: 'shell',
    title: 'PowerShell',
    color: ACCENTS[index % ACCENTS.length],
    icon: 'terminal',
  }
}

const DEFAULT_PRESETS: AgentPreset[] = [
  { id: 'preset-shell', name: 'Shell', type: 'shell', command: '', args: [], color: '#6366f1', icon: 'terminal' },
  { id: 'preset-claude', name: 'Claude Code', type: 'claude', command: 'claude', args: [], color: '#d97757', icon: 'claude' },
  { id: 'preset-codex', name: 'Codex', type: 'codex', command: 'codex', args: [], color: '#10a37f', icon: 'openai' },
]

const DEFAULT_SETTINGS: Settings = {
  defaultShell: {},
  fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
  fontSize: 13,
  accent: 'violet',
  theme: 'midnight',
  customColors: {},
  language: 'en',
  scrollback: 5000,
  infiniteScrollback: true,
  terminalRenderer: 'canvas',
  terminalSelectionOverride: true,
  terminalUnicode11: true,
  terminalAgentEndChip: true,
  awakeMode: 'auto',
  terminalSnapshotMode: 'auto',
  persistScrollback: true,
  persistScrollbackLines: 2000,
  gitChip: true,
  explorerMenu: false,
  updateDismissedVersion: '',
  cliEnabled: true,
  worktreesRoot: '',
  hibernateIdleMinutes: 0,
  terminalShellIntegration: true,
  restoreLastWorkspace: true,
  confirmCloseRunning: true,
  autoCheckUpdates: true,
  closeToTray: true,
  launchOnStartup: false,
  globalHotkeyEnabled: false,
  globalHotkey: 'Super+Alt+O',
  keymap: {},
  sidebarCollapsed: false,
  usage: {
    enabled: true,
    claudeIntervalMs: 60000,
    codexIntervalMs: 10000,
    refreshOnFocus: true,
    showStatus: true,
    rows: {
      claude5h: true,
      claude7d: true,
      claudeOpus7d: false,
      claudeSonnet7d: false,
      codex5h: true,
      codex7d: true,
    },
    custom: [],
    collapsed: false,
  },
  remote: {
    enabled: false,
    port: 4517,
    phoneFit: true,
    https: { enabled: false, mode: 'tailscaleServe' },
  },
  notifications: {
    enabled: true,
    notifyDone: true,
    notifyAction: true,
    sound: true,
    soundId: 'chime',
    volume: 70,
    flashTaskbar: true,
    hooksEnabled: false,
    hookPort: 43917,
    hookToken: '',
    codexEnabled: false,
    discord: { enabled: false, webhookUrl: '', userId: '', notifyAction: true, notifyDone: true },
    inAppWhenFocused: true,
    ntfy: { enabled: false, server: 'https://ntfy.sh', topic: '', token: '', notifyAction: true, notifyDone: false },
    onlyWhenAway: false,
  },
  agents: {
    resumeOnStartup: 'ask',
    awakeDisplay: false,
    sidebarAgentRows: true,
    topicAsTitle: true,
    ctrlDigitFocus: true,
    resumeModalTimeoutSec: 60,
    resumeNudge: false,
    resumeNudgeText: '',
    sidebarSort: 'manual',
    cacheTimer: { enabled: false, ttlMinutes: 5 },
  },
  automation: {
    defaultAgentPresetId: '',
    composerCreateAnother: false,
    cliProtectSsh: true,
    cliUserPath: false,
    scheduleGraceMin: 120,
    scheduleMaxWaitMin: 30,
    scheduleNotify: false,
  },
}

/** A single terminal cell chosen in the new-workspace wizard. */
export interface WorkspaceDraftPane {
  type: PaneType
  presetId?: string
  title: string
  color: string
  icon: string
  command?: string
  /** Absolute folder override (a repo file's console cwd, E8-FR-25). */
  cwd?: string
  /** One-shot first prompt of this console (a repo file's, E8-FR-25), source 'repo'. */
  prompt?: string
  /** The isolated worktree this console runs in (a race contestant, E7-FR-34); `cwd` is its path. */
  worktree?: PaneWorktree
}

/** A repo file's one-time setup console (E8-FR-25). */
export interface WorkspaceDraftSetup {
  command: string
  title?: string
  /** The other consoles wait for exit code 0 (only when the shell's exit is observable). */
  wait: boolean
}

/** A Quick Command a repo file brings; the store gives it an id and the new workspace's scope. */
export type DraftQuickCommand = Omit<QuickCommand, 'id' | 'workspaceId'>

export interface WorkspaceDraft {
  name: string
  cwd: string
  grid: GridPreset
  panes: WorkspaceDraftPane[]
  /** Connection profile applied to every console in the new workspace. */
  setupId?: string
  /**
   * Composer's first prompt (E8-FR-08): queued for the first console that is
   * not a shell, delivered once through the shared path (E8-FR-02b).
   */
  firstPrompt?: string
  /** Repo file setup console, placed first (E8-FR-25). */
  setup?: WorkspaceDraftSetup
  /** Repo file Quick Commands, scoped to the new workspace and listed in its repoConfig. */
  quickCommands?: DraftQuickCommand[]
  /** Hash of the applied repo file: the workspace gets `repoConfig` (E8-FR-25). */
  repoConfig?: { sha256: string }
}

/**
 * A console held back until its repo setup ends (E8-FR-25; transient): it
 * shows "Waiting for setup..." or "Setup failed (code N)" instead of a terminal.
 */
export interface HeldPane {
  setupPaneId: string
  state: 'waiting' | 'failed'
  code?: number
}

/** The one-time setup of a workspace created from a repo file (transient, never persisted). */
export interface RepoSetupRun {
  workspaceId: string
  command: string
  /** pending: the next spawn of the setup console runs it; running: spawned; ok/failed: exited. */
  status: 'pending' | 'running' | 'ok' | 'failed'
  code?: number
  heldPaneIds: string[]
}

/** What reloadWorkspaceFromRepo did (E8-FR-27). */
export interface RepoReloadResult {
  /** Consoles with a live pty that were left alone. */
  kept: number
}

/** What "Advanced..." hands the 3-step wizard (E8-FR-08); every cell gets `presetId`. */
export interface WizardInitialDraft {
  name: string
  cwd: string
  grid: GridPreset
  presetId: string
  setupId: string
}

/** What a merge import added, so the caller can warn about the 100 cap. */
export interface MergeConfigResult {
  quickCommands: { imported: number; total: number }
}

/** The renderer side of the v12 step (main already migrates on parse). */
function quickCommandsOf(config: ConfigFile): QuickCommand[] {
  return migrateQuickCommandsConfig(config).config.quickCommands ?? []
}

/**
 * A one-shot initial prompt waiting for its pane's first spawn (E8-FR-02):
 * useXterm consumes and deletes it, so a restart never finds it again.
 */
export interface PendingPrompt {
  text: string
  enter: boolean
  source: 'quick' | 'composer' | 'cli' | 'repo' | 'schedule' | 'remote'
  createdAt: number
  /**
   * 'argvOnly' (a phone's createPane.prompt, E2-FR-11): never typed by the
   * gate; the phone keeps the text in its composer when argv is not possible.
   */
  mode?: 'auto' | 'argvOnly'
}

/** Editor target of Settings > Quick Commands (see AppState.quickEdit). */
export type QuickEditRequest = { id: string } | { newScope: string | null }

/** Prefill for the new-workspace wizard (setWizardOpen(true, prefill)). */
export interface WizardPrefill {
  cwd?: string
  name?: string
}

export interface AppState {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  /** Last active workspace (drives Ctrl+Tab quick-flip). */
  previousWorkspaceId: string | null
  sidebarCollapsed: boolean
  presets: AgentPreset[]
  /** Schema 12 (E8-FR-01): replaces snippets; at most QUICK_COMMANDS_MAX. */
  quickCommands: QuickCommand[]
  keyButtons: KeyButton[]
  connections: ConnectionProfile[]
  settings: Settings
  settingsOpen: boolean
  /** Deep-link target for the settings modal: the category to open on. */
  settingsCategory: string | null
  /** Settings search text (E4-FR-26); cleared on close and on every deep link. */
  settingsQuery: string
  /** Row to scroll to and ring once its category renders ('notifications.sound', E4-FR-27). */
  settingsAnchor: string | null
  /**
   * The new-workspace flow is open (E8-FR-08): the composer card, or the
   * 3-step wizard it hands off to. Every "a modal is open" check reads this.
   */
  wizardOpen: boolean
  /** Which surface of the flow shows: the composer (true) or the 3-step wizard (false). */
  composerOpen: boolean
  /** Values the composer opens with (cwd/name); null = empty draft. */
  wizardPrefill: WizardPrefill | null
  /** Draft the 3-step wizard opens with ("Advanced..."); null = its own defaults. */
  wizardDraft: WizardInitialDraft | null
  paletteOpen: boolean
  globalPromptOpen: boolean
  /** Quick Commands popover, Ctrl+Shift+Q (E8-FR-04; transient). */
  quickPopoverOpen: boolean
  /**
   * What the Quick Commands editor opens on (transient): an existing command
   * (its preset was deleted, E8-FR-05) or a new one scoped to a workspace
   * (the popover's "Create", E8-FR-03/04).
   */
  quickEdit: QuickEditRequest | null
  /** paneId -> initial prompt for the pane's next real spawn (E8-FR-02; transient). */
  pendingPrompts: Record<string, PendingPrompt>
  /** workspaceId -> maximized paneId (transient; never persisted). */
  maximized: Record<string, string | null>
  /** workspaceId -> minimized paneIds (transient; never persisted). */
  minimized: Record<string, string[]>
  /** paneId -> home of a console shown in another workspace ("Move to workspace", transient; persist.ts writes it back home). */
  paneHome: PaneHomes
  /** paneId -> folder the console's shell reported last (OSC 7, transient): its own git chip. */
  paneCwd: Record<string, string>
  /** paneId -> relaunch counter (transient; bumping it remounts the console). */
  paneEpoch: Record<string, number>
  /** paneId -> live Claude state (transient; fed by main over STATUS_STATE). */
  paneStatus: Record<string, PaneStatus>
  /** paneId -> unacknowledged done/action flag (transient; drives sidebar badges). */
  paneAttention: Record<string, true>
  /** paneId -> exit code of a shell that ended on its own (transient; "exited" label, E6-FR-38). */
  paneExit: Record<string, number>
  /** paneId -> Claude session that just ended (transient; "Claude exited" chip, E6-FR-22). */
  agentEnded: Record<string, AgentSessionEndEvt>
  /**
   * workspaceId -> 'full' | mounted paneIds (transient; never persisted). The
   * single mounting primitive (D4): activating a workspace mounts it 'full',
   * and nothing unmounts except deleting the workspace.
   */
  mountedWorkspaces: MountedWorkspaces
  /** paneId -> console waiting for its repo setup (E8-FR-25; transient). */
  heldPanes: Record<string, HeldPane>
  /** setup paneId -> its one-time repo setup (E8-FR-25; transient). */
  repoSetups: Record<string, RepoSetupRun>
  /** False until persisted config has been loaded (gates the persistence writer). */
  hydrated: boolean

  hydrate: (config: ConfigFile | null) => void
  createWorkspace: (name: string, cwd: string) => string
  createWorkspaceFull: (draft: WorkspaceDraft) => string
  /**
   * "Reload from .snagentsos.json" (E8-FR-27): replaces the grid, the consoles
   * without a live pty and the Quick Commands listed in `repoConfig`. Live
   * consoles and hand-made commands stay. No setup console on a reload.
   */
  reloadWorkspaceFromRepo: (workspaceId: string, draft: WorkspaceDraft, livePaneIds: string[]) => RepoReloadResult
  /** Set (or clear, with null) the repo file trace of a workspace (export, E8-FR-26). */
  setWorkspaceRepoConfig: (workspaceId: string, repoConfig: WorkspaceRepoConfig | null) => void
  /** The setup command for this console's next spawn, once (pending -> running). */
  takeRepoSetupCommand: (paneId: string) => string | null
  /** Let held consoles start ("Start now", "Start anyway"). */
  releaseHeldPanes: (paneIds: string[]) => void
  /** Run a failed setup again; its still-held consoles go back to waiting. */
  retryRepoSetup: (setupPaneId: string) => void
  importConfig: (config: ConfigFile) => void
  /** Appends the imported config; reports a Quick Commands import cut by the limit. */
  mergeConfig: (config: ConfigFile) => MergeConfigResult
  deleteWorkspace: (id: string) => void
  renameWorkspace: (id: string, name: string) => void
  /** Set (or clear, with null or blank) a workspace's note, normalized (E8-FR-10). */
  setWorkspaceNote: (id: string, note: string | null) => void
  /** Set (or clear, with null) a workspace's task state (E8-FR-10). */
  setWorkspaceTaskState: (id: string, state: WorkspaceTaskState | null) => void
  toggleFavorite: (id: string) => void
  /** Fold or unfold the sidebar agent rows under a workspace (persisted, E5-FR-19). */
  toggleAgentsCollapsed: (id: string) => void
  setActive: (id: string) => void
  toggleSidebar: () => void
  /** Appends a console; returns its new id ('' when the workspace is unknown). */
  addPane: (workspaceId: string, pane?: Partial<Pane>) => string
  removePane: (workspaceId: string, paneId: string) => void
  /**
   * Close a console the way the user does (grid, phone): remembers it on the
   * closed stack for reopenClosedPane, then removes it (E5-FR-14).
   */
  closePane: (workspaceId: string, paneId: string) => void
  /** Put a closed pane back with its own id at `orderIndex` of layout.order. */
  restorePane: (workspaceId: string, pane: Pane, orderIndex: number) => boolean
  /**
   * Reopen the most recently closed console still restorable (its workspace
   * exists). Activates its workspace. Returns the reopened entry, or null.
   */
  reopenClosedPane: () => { workspaceId: string; paneId: string } | null
  /** Drop a pane's lastSession mirror ("Restart with a new chat"). */
  clearLastSession: (paneId: string) => void
  renamePane: (workspaceId: string, paneId: string, title: string) => void
  setPaneFontSize: (workspaceId: string, paneId: string, fontSize: number) => void
  /**
   * Relaunch a console: in place when its terminal is mounted (same xterm,
   * scrollback kept, E6-FR-18), else by remount.
   */
  restartPane: (paneId: string) => void
  /** "Restart clean": kill the pty, then remount the console (empty screen, fresh pty). */
  restartPaneClean: (paneId: string) => void
  /** Record (code) or clear (null) a console's natural shell exit. */
  setPaneExit: (paneId: string, code: number | null) => void
  /** Show the "Claude exited" chip for the event's console (E6-FR-22). */
  setAgentEnded: (evt: AgentSessionEndEvt) => void
  /** Hide a console's "Claude exited" chip (typing, exit, an action, [x]). */
  clearAgentEnded: (paneId: string) => void
  /** Set (or clear, with null) a console's one-shot scheduled prompt. */
  setPaneSchedule: (workspaceId: string, paneId: string, schedule: PaneSchedule | null) => void
  /**
   * Move a console onto a worktree (its path becomes the cwd) or, with null,
   * off it: the cwd override goes too, so it runs in its normal folder again
   * (E7-FR-36 Recreate / Remove from pane).
   */
  setPaneWorktree: (workspaceId: string, paneId: string, worktree: PaneWorktree | null) => void
  setGrid: (workspaceId: string, grid: GridPreset) => void
  movePane: (workspaceId: string, paneId: string, toIndex: number) => void
  /** Puts the workspaces in this order (sidebar drag); ids it leaves out keep their place after them. */
  setWorkspaceOrder: (ids: string[]) => void
  /**
   * Show a console in another workspace for this session (its pty keeps
   * running). Moving it back home forgets the move. False when nothing moved.
   */
  movePaneToWorkspace: (paneId: string, toWorkspaceId: string) => boolean
  /** The shell of a console reported its working folder (OSC 7). */
  setPaneCwd: (paneId: string, cwd: string) => void
  toggleMaximize: (workspaceId: string, paneId: string) => void
  clearMaximize: (workspaceId: string) => void
  toggleMinimize: (workspaceId: string, paneId: string) => void

  savePreset: (preset: AgentPreset) => void
  deletePreset: (id: string) => void
  newPresetId: () => string

  /**
   * Insert or replace by id. Returns false (and changes nothing) for an
   * invalid command or a new one past the 100 limit.
   */
  saveQuickCommand: (cmd: QuickCommand) => boolean
  deleteQuickCommand: (id: string) => void
  /** Moves a command one slot up (-1) or down (+1) in the Settings order. */
  moveQuickCommand: (id: string, delta: -1 | 1) => void
  newQuickCommandId: () => string

  saveKeyButton: (button: KeyButton) => void
  deleteKeyButton: (id: string) => void
  newKeyButtonId: () => string

  saveConnection: (connection: ConnectionProfile) => void
  deleteConnection: (id: string) => void
  newConnectionId: () => string

  updateSettings: (patch: Partial<Settings>) => void
  setSettingsOpen: (open: boolean) => void
  /**
   * Open settings, optionally deep-linking to a category ('remote') or to a
   * row inside it ('notifications#sound', E4-FR-27).
   */
  openSettings: (target?: string) => void
  setSettingsQuery: (query: string) => void
  setSettingsAnchor: (anchor: string | null) => void
  /** Open the new-workspace composer (optionally prefilled), or close the whole flow. */
  setWizardOpen: (open: boolean, prefill?: WizardPrefill) => void
  /** Swap the composer for the 3-step wizard, prefilled with `draft` ("Advanced..."). */
  openAdvancedWizard: (draft: WizardInitialDraft | null) => void
  setPaletteOpen: (open: boolean) => void
  setGlobalPromptOpen: (open: boolean) => void
  setQuickPopoverOpen: (open: boolean) => void
  setQuickEdit: (req: QuickEditRequest | null) => void
  /** Queue (or clear, with null) the initial prompt of a pane's next spawn. */
  setPendingPrompt: (paneId: string, prompt: PendingPrompt | null) => void
  /** Consume the pane's pending prompt (useXterm, on a real spawn only). */
  takePendingPrompt: (paneId: string) => PendingPrompt | null

  /** Apply a Claude status update pushed by main (also flags attention). */
  setPaneStatus: (evt: PaneStatusEvt) => void
  /** Acknowledge one console's attention flag (typing into it, restoring it). */
  clearPaneAttention: (paneId: string) => void
  /** Acknowledge every non-minimized console of a workspace (viewing it). */
  markWorkspaceSeen: (workspaceId: string) => void
  /**
   * Mount a workspace without activating it: every console, or with `only`
   * just those panes (the rest show the "console not started" placeholder).
   * No-op for unknown workspaces and when already mounted that far.
   */
  ensureMounted: (workspaceId: string, opts?: EnsureMountedOpts) => void
}

/** Mount `wsId` fully in `map` (activation). Null ids leave the map as is. */
function mountActive(map: MountedWorkspaces, wsId: string | null): MountedWorkspaces {
  return wsId ? withMounted(map, wsId, []) : map
}

/**
 * `workspaces` with `pane.lastSession` updated from a status event carrying a
 * session id (main already dropped `launch:` ids and SSH consoles). Returns
 * the same reference when nothing changes, so status traffic stays transient.
 */
function withLastSession(workspaces: Workspace[], evt: PaneStatusEvt): Workspace[] {
  if (!evt.sessionId || !evt.provider) return workspaces
  const { sessionId, provider } = evt
  for (const ws of workspaces) {
    const pane = ws.panes.find((p) => p.id === evt.paneId)
    if (!pane) continue
    const prev = pane.lastSession
    // The first cwd of a session is its launch directory (what a resume needs,
    // E5 spawnCwd). Claude's hook cwd follows a later `cd`, so it never moves it.
    const same = prev?.sessionId === sessionId && prev.provider === provider
    const cwd = same && prev.cwd ? prev.cwd : evt.cwd ?? ''
    if (prev && prev.sessionId === sessionId && prev.provider === provider && prev.cwd === cwd) return workspaces
    const lastSession = { provider, sessionId, cwd, at: evt.updatedAt ?? Date.now() }
    return workspaces.map((w) => (w === ws ? { ...w, panes: w.panes.map((p) => (p === pane ? { ...p, lastSession } : p)) } : w))
  }
  return workspaces
}

/** Panes and their queued prompts for a draft (composer, wizard, repo file). */
function buildDraftPanes(draft: WorkspaceDraft): { panes: Pane[]; prompts: Record<string, PendingPrompt> } {
  const prompts: Record<string, PendingPrompt> = {}
  const now = Date.now()
  const panes = draft.panes.map((p) => {
    const pane: Pane = {
      id: uid('pane'),
      type: p.type,
      presetId: p.presetId,
      command: p.command,
      title: p.title,
      color: p.color,
      icon: p.icon,
      ...(p.cwd ? { cwd: p.cwd } : {}),
      ...(p.worktree ? { worktree: { ...p.worktree } } : {}),
    }
    // E8-FR-25: a repo console's prompt goes through E8-FR-02 like any other.
    if (p.prompt?.trim()) prompts[pane.id] = { text: p.prompt, enter: true, source: 'repo', createdAt: now }
    return pane
  })
  return { panes, prompts }
}

/**
 * Append a repo file's Quick Commands scoped to `workspaceId`, up to the 100
 * cap and 20 per file. Returns the new list and the ids that made it in.
 */
function importRepoQuick(list: QuickCommand[], items: DraftQuickCommand[], workspaceId: string): { list: QuickCommand[]; ids: string[] } {
  const out = [...list]
  const ids: string[] = []
  for (const item of items) {
    if (out.length >= QUICK_COMMANDS_MAX || ids.length >= 20) break
    const cmd = parseQuickCommand({ ...item, id: uid('qc'), workspaceId })
    if (!cmd) continue
    out.push(cmd)
    ids.push(cmd.id)
  }
  return { list: out, ids }
}

type StoreSet = (partial: (s: AppState) => Partial<AppState>) => void

/** A running repo setup exited (E8-FR-25): 0 releases its held consoles, anything else marks them failed. */
function settleRepoSetup(set: StoreSet, setupPaneId: string, run: RepoSetupRun, code: number): void {
  set((s) => {
    const heldPanes = { ...s.heldPanes }
    for (const id of run.heldPaneIds) {
      if (heldPanes[id]?.setupPaneId !== setupPaneId) continue
      if (code === 0) delete heldPanes[id]
      else heldPanes[id] = { setupPaneId, state: 'failed', code }
    }
    return { heldPanes, repoSetups: { ...s.repoSetups, [setupPaneId]: { ...run, status: code === 0 ? 'ok' : 'failed', code } } }
  })
}

export const useAppStore = create<AppState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  previousWorkspaceId: null,
  sidebarCollapsed: false,
  presets: DEFAULT_PRESETS,
  quickCommands: [],
  keyButtons: [],
  connections: [],
  settings: DEFAULT_SETTINGS,
  settingsOpen: false,
  settingsCategory: null,
  settingsQuery: '',
  settingsAnchor: null,
  wizardOpen: false,
  composerOpen: false,
  wizardPrefill: null,
  wizardDraft: null,
  paletteOpen: false,
  globalPromptOpen: false,
  quickPopoverOpen: false,
  quickEdit: null,
  pendingPrompts: {},
  maximized: {},
  minimized: {},
  paneHome: {},
  paneCwd: {},
  paneEpoch: {},
  paneStatus: {},
  paneAttention: {},
  paneExit: {},
  agentEnded: {},
  mountedWorkspaces: {},
  heldPanes: {},
  repoSetups: {},
  hydrated: false,

  hydrate: (config) =>
    set((s) => {
      if (!config) return { hydrated: true }
      const workspaces = config.workspaces ?? []
      const presets = config.presets && config.presets.length ? config.presets : s.presets
      const quickCommands = quickCommandsOf(config)
      const keyButtons = config.keyButtons ?? []
      const connections = config.connections ?? []
      const settings: Settings = { ...s.settings, ...config.settings }
      let activeWorkspaceId: string | null = null
      if (settings.restoreLastWorkspace) {
        const wanted = config.activeWorkspaceId ?? null
        activeWorkspaceId = workspaces.some((w) => w.id === wanted)
          ? wanted
          : (workspaces[0]?.id ?? null)
      }
      return {
        workspaces,
        presets,
        quickCommands,
        keyButtons,
        connections,
        settings,
        sidebarCollapsed: settings.sidebarCollapsed,
        activeWorkspaceId,
        mountedWorkspaces: mountActive(s.mountedWorkspaces, activeWorkspaceId),
        paneHome: {},
        hydrated: true,
      }
    }),

  createWorkspace: (name, cwd) => {
    const pane = makeShellPane(0)
    const ws: Workspace = {
      id: uid('ws'),
      name,
      cwd,
      panes: [pane],
      favorite: false,
      layout: { grid: 1, order: [pane.id] },
    }
    set((s) => ({
      workspaces: [...s.workspaces, ws],
      activeWorkspaceId: ws.id,
      mountedWorkspaces: mountActive(s.mountedWorkspaces, ws.id),
    }))
    return ws.id
  },

  createWorkspaceFull: (draft) => {
    const built = buildDraftPanes(draft)
    let panes: Pane[] = built.panes.length > 0 ? built.panes : [makeShellPane(0)]
    // E8-FR-25: the repo setup console goes first and runs its command once.
    const setupPane: Pane | null = draft.setup ? { ...makeShellPane(0), title: draft.setup.title?.trim() || 'Setup' } : null
    if (setupPane) panes = [setupPane, ...panes]
    const grid: GridPreset = draft.grid >= panes.length ? draft.grid : gridForCount(panes.length)
    const layout: WorkspaceLayout = { grid, order: panes.map((p) => p.id) }
    const wsId = uid('ws')
    const repoQuick = draft.quickCommands ? importRepoQuick(get().quickCommands, draft.quickCommands, wsId) : null
    const ws: Workspace = {
      id: wsId,
      name: draft.name,
      cwd: draft.cwd,
      panes,
      favorite: false,
      layout,
      setupId: draft.setupId,
      ...(draft.repoConfig
        ? { repoConfig: { sha256: draft.repoConfig.sha256, appliedAt: Date.now(), quickCommandIds: repoQuick?.ids ?? [] } }
        : {}),
    }
    // E8-FR-08: the first prompt goes to the first agent console only.
    const prompt = draft.firstPrompt?.trim() ? draft.firstPrompt : ''
    const agentPane = prompt ? built.panes.find((p) => p.type !== 'shell') : undefined
    const now = Date.now()
    set((s) => {
      const pendingPrompts = { ...s.pendingPrompts, ...built.prompts }
      if (agentPane) pendingPrompts[agentPane.id] = { text: prompt, enter: true, source: 'composer', createdAt: now }
      let heldPanes = s.heldPanes
      let repoSetups = s.repoSetups
      if (setupPane && draft.setup) {
        const heldPaneIds = draft.setup.wait ? built.panes.map((p) => p.id) : []
        repoSetups = { ...repoSetups, [setupPane.id]: { workspaceId: wsId, command: draft.setup.command, status: 'pending', heldPaneIds } }
        if (heldPaneIds.length > 0) {
          heldPanes = { ...heldPanes }
          for (const id of heldPaneIds) heldPanes[id] = { setupPaneId: setupPane.id, state: 'waiting' }
        }
      }
      return {
        workspaces: [...s.workspaces, ws],
        activeWorkspaceId: ws.id,
        mountedWorkspaces: mountActive(s.mountedWorkspaces, ws.id),
        pendingPrompts,
        heldPanes,
        repoSetups,
        ...(repoQuick ? { quickCommands: repoQuick.list } : {}),
      }
    })
    return ws.id
  },

  reloadWorkspaceFromRepo: (workspaceId, draft, livePaneIds) => {
    const ws = get().workspaces.find((w) => w.id === workspaceId)
    if (!ws) return { kept: 0 }
    const live = new Set(livePaneIds)
    const kept = orderPanes(ws.panes, ws.layout?.order).filter((p) => live.has(p.id))
    const dropped = ws.panes.filter((p) => !live.has(p.id)).map((p) => p.id)
    const built = buildDraftPanes(draft)
    const panes = [...kept, ...built.panes].slice(0, 12)
    const grid: GridPreset = draft.grid >= panes.length ? draft.grid : gridForCount(panes.length)
    // Only the commands this file brought before are replaced; hand-made ones stay.
    const listed = new Set(ws.repoConfig?.quickCommandIds ?? [])
    const base = get().quickCommands.filter((c) => !listed.has(c.id))
    const repoQuick = importRepoQuick(base, draft.quickCommands ?? [], workspaceId)
    // A dropped console without a live pty may still own one in main (a pane
    // never remounted after a reload): kill by pane id, idempotent.
    killPanePtys(dropped)
    set((s) => {
      const pendingPrompts = { ...s.pendingPrompts }
      for (const id of dropped) delete pendingPrompts[id]
      Object.assign(pendingPrompts, built.prompts)
      return {
        pendingPrompts,
        quickCommands: repoQuick.list,
        workspaces: s.workspaces.map((w) =>
          w.id === workspaceId
            ? {
                ...w,
                panes,
                layout: { grid, order: panes.map((p) => p.id) },
                setupId: draft.setupId,
                repoConfig: { sha256: draft.repoConfig?.sha256 ?? w.repoConfig?.sha256 ?? '', appliedAt: Date.now(), quickCommandIds: repoQuick.ids },
              }
            : w,
        ),
      }
    })
    trashSavedScrollback(dropped)
    return { kept: kept.length }
  },

  setWorkspaceRepoConfig: (workspaceId, repoConfig) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w
        if (repoConfig) return { ...w, repoConfig: { ...repoConfig, quickCommandIds: repoConfig.quickCommandIds.slice(0, 20) } }
        const { repoConfig: _gone, ...rest } = w
        return rest
      }),
    })),

  takeRepoSetupCommand: (paneId) => {
    const run = get().repoSetups[paneId]
    if (!run || run.status !== 'pending') return null
    set((s) => ({ repoSetups: { ...s.repoSetups, [paneId]: { ...run, status: 'running', code: undefined } } }))
    return run.command
  },

  releaseHeldPanes: (paneIds) =>
    set((s) => {
      if (!paneIds.some((id) => id in s.heldPanes)) return {}
      const heldPanes = { ...s.heldPanes }
      for (const id of paneIds) delete heldPanes[id]
      return { heldPanes }
    }),

  retryRepoSetup: (setupPaneId) => {
    const run = get().repoSetups[setupPaneId]
    if (!run) return
    set((s) => {
      const heldPanes = { ...s.heldPanes }
      for (const id of run.heldPaneIds) {
        if (heldPanes[id]?.setupPaneId === setupPaneId) heldPanes[id] = { setupPaneId, state: 'waiting' }
      }
      return { heldPanes, repoSetups: { ...s.repoSetups, [setupPaneId]: { ...run, status: 'pending', code: undefined } } }
    })
    get().restartPaneClean(setupPaneId)
  },

  importConfig: (config) =>
    set((s) => ({
      // Workspaces that leave the list unmount; ones that survive the import
      // (same id) keep their consoles running, and the new active one mounts.
      mountedWorkspaces: mountActive(
        keepMounted(s.mountedWorkspaces, (config.workspaces ?? []).map((w) => w.id)),
        config.workspaces?.[0]?.id ?? null,
      ),
      workspaces: config.workspaces ?? [],
      presets: config.presets && config.presets.length ? config.presets : s.presets,
      quickCommands: quickCommandsOf(config),
      keyButtons: config.keyButtons ?? [],
      connections: config.connections ?? [],
      settings: { ...s.settings, ...config.settings },
      sidebarCollapsed: config.settings?.sidebarCollapsed ?? s.sidebarCollapsed,
      activeWorkspaceId: config.workspaces?.[0]?.id ?? null,
      previousWorkspaceId: null,
      paneHome: {},
    })),

  mergeConfig: (config) => {
    const result: MergeConfigResult = { quickCommands: { imported: 0, total: 0 } }
    set((s) => {
      const existingPreset = new Set(s.presets.map((p) => p.id))
      const newPresets = (config.presets ?? []).filter((p) => !existingPreset.has(p.id))
      // Re-id imported workspaces + their panes so they never collide with ours.
      const wsIdMap = new Map<string, string>()
      const importedWs: Workspace[] = (config.workspaces ?? []).map((w) => {
        const idMap = new Map<string, string>()
        const panes = w.panes.map((p) => {
          const nid = uid('pane')
          idMap.set(p.id, nid)
          return { ...p, id: nid }
        })
        const layout: WorkspaceLayout | undefined = w.layout
          ? { grid: w.layout.grid, order: w.layout.order.map((id) => idMap.get(id) ?? id) }
          : undefined
        const id = uid('ws')
        wsIdMap.set(w.id, id)
        return { ...w, id, panes, layout }
      })
      // Scoped commands follow their workspace to its new id; the 100 cap holds.
      const qc = mergeQuickCommands(s.quickCommands, quickCommandsOf(config), wsIdMap)
      result.quickCommands = { imported: qc.imported, total: qc.total }
      const existingKeyButton = new Set(s.keyButtons.map((x) => x.id))
      const newKeyButtons = (config.keyButtons ?? []).filter((x) => !existingKeyButton.has(x.id))
      const existingConn = new Set(s.connections.map((x) => x.id))
      const newConnections = (config.connections ?? []).filter((x) => !existingConn.has(x.id))
      return {
        workspaces: [...s.workspaces, ...importedWs],
        presets: [...s.presets, ...newPresets],
        quickCommands: qc.list,
        keyButtons: [...s.keyButtons, ...newKeyButtons],
        connections: [...s.connections, ...newConnections],
      }
    })
    return result
  },

  deleteWorkspace: (id) => {
    // Consoles only shown here go back to their homes instead of dying with it.
    const visiting = get().workspaces.find((w) => w.id === id)?.panes.filter((p) => {
      const home = get().paneHome[p.id]
      return home && home.workspaceId !== id
    })
    for (const p of visiting ?? []) get().movePaneToWorkspace(p.id, get().paneHome[p.id].workspaceId)
    // Force-kill the workspace's consoles so nothing lingers in the background
    // (ptyLifecycle would too; both are idempotent, E4-FR-36).
    const ws = get().workspaces.find((w) => w.id === id)
    if (ws) killPanePtys(ws.panes.map((p) => p.id))
    set((s) => {
      const workspaces = s.workspaces.filter((w) => w.id !== id)
      const activeWorkspaceId =
        s.activeWorkspaceId === id ? (workspaces[0]?.id ?? null) : s.activeWorkspaceId
      const maximized = { ...s.maximized }
      delete maximized[id]
      const minimized = { ...s.minimized }
      delete minimized[id]
      const mountedWorkspaces = mountActive(withoutMounted(s.mountedWorkspaces, id), activeWorkspaceId)
      // E8-FR-01: the workspace's scoped Quick Commands go with it.
      const quickCommands = s.quickCommands.some((c) => c.workspaceId === id)
        ? s.quickCommands.filter((c) => c.workspaceId !== id)
        : s.quickCommands
      // Consoles away from this home stay where they are, now theirs.
      const paneHome = Object.fromEntries(Object.entries(s.paneHome).filter(([, h]) => h.workspaceId !== id))
      return { workspaces, activeWorkspaceId, maximized, minimized, mountedWorkspaces, quickCommands, paneHome }
    })
    // Their saved scrollback waits in main's trash until the next start (E6-FR-12).
    if (ws) trashSavedScrollback(ws.panes.map((p) => p.id))
  },

  renameWorkspace: (id, name) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === id ? { ...w, name: name.trim() || w.name } : w,
      ),
    })),

  setWorkspaceNote: (id, note) =>
    set((s) => {
      const ws = s.workspaces.find((w) => w.id === id)
      const next = normalizeWorkspaceNote(note)
      if (!ws || ws.note === next) return {}
      return {
        workspaces: s.workspaces.map((w) => {
          if (w.id !== id) return w
          if (next) return { ...w, note: next }
          const { note: _gone, ...rest } = w
          return rest
        }),
      }
    }),

  setWorkspaceTaskState: (id, state) =>
    set((s) => {
      const ws = s.workspaces.find((w) => w.id === id)
      const next = isTaskState(state) ? state : undefined
      if (!ws || ws.taskState === next) return {}
      return {
        workspaces: s.workspaces.map((w) => {
          if (w.id !== id) return w
          if (next) return { ...w, taskState: next }
          const { taskState: _gone, ...rest } = w
          return rest
        }),
      }
    }),

  toggleFavorite: (id) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, favorite: !w.favorite } : w)),
    })),

  toggleAgentsCollapsed: (id) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== id) return w
        if (w.agentsCollapsed) {
          const { agentsCollapsed: _open, ...rest } = w
          return rest
        }
        return { ...w, agentsCollapsed: true }
      }),
    })),

  setActive: (id) => {
    set((s) => ({
      activeWorkspaceId: id,
      previousWorkspaceId: s.activeWorkspaceId !== id ? s.activeWorkspaceId : s.previousWorkspaceId,
      mountedWorkspaces: mountActive(s.mountedWorkspaces, id),
    }))
    // Viewing a workspace acknowledges its visible consoles' attention badges.
    get().markWorkspaceSeen(id)
  },

  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  addPane: (workspaceId, pane) => {
    if (!get().workspaces.some((w) => w.id === workspaceId)) return ''
    const id = uid('pane')
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w
        const newPane: Pane = { ...makeShellPane(w.panes.length), ...pane, id }
        const panes = [...w.panes, newPane]
        const order = [...(w.layout?.order ?? w.panes.map((p) => p.id)), newPane.id]
        const grid = gridForCount(panes.length)
        return { ...w, panes, layout: { grid, order } }
      }),
    }))
    return id
  },

  removePane: (workspaceId, paneId) => {
    set((s) => {
      const maximized = { ...s.maximized }
      if (maximized[workspaceId] === paneId) maximized[workspaceId] = null
      const minimized = { ...s.minimized }
      if (minimized[workspaceId]?.includes(paneId)) {
        minimized[workspaceId] = minimized[workspaceId].filter((id) => id !== paneId)
      }
      const paneExit = { ...s.paneExit }
      delete paneExit[paneId]
      const agentEnded = { ...s.agentEnded }
      delete agentEnded[paneId]
      // E8-FR-25: a closed setup console lets its held consoles start.
      let heldPanes = s.heldPanes
      let repoSetups = s.repoSetups
      if (paneId in heldPanes || paneId in repoSetups) {
        heldPanes = { ...heldPanes }
        delete heldPanes[paneId]
        for (const [id, h] of Object.entries(heldPanes)) if (h.setupPaneId === paneId) delete heldPanes[id]
        repoSetups = { ...repoSetups }
        delete repoSetups[paneId]
      }
      // A prompt that never reached its spawn goes with the pane: restorePane
      // brings the same id back, which must not deliver it later (E8-FR-02).
      let pendingPrompts = s.pendingPrompts
      if (paneId in pendingPrompts) {
        pendingPrompts = { ...pendingPrompts }
        delete pendingPrompts[paneId]
      }
      let paneHome = s.paneHome
      if (paneId in paneHome) {
        paneHome = { ...paneHome }
        delete paneHome[paneId]
      }
      let paneCwd = s.paneCwd
      if (paneId in paneCwd) {
        paneCwd = { ...paneCwd }
        delete paneCwd[paneId]
      }
      return {
        maximized,
        minimized,
        paneHome,
        paneCwd,
        paneExit,
        agentEnded,
        pendingPrompts,
        heldPanes,
        repoSetups,
        workspaces: s.workspaces.map((w) => {
          if (w.id !== workspaceId) return w
          const panes = w.panes.filter((p) => p.id !== paneId)
          const order = (w.layout?.order ?? w.panes.map((p) => p.id)).filter((id) => id !== paneId)
          // Shrink the grid back to the smallest preset that fits the remaining
          // panes so removing a console reflows the rest (no leftover empty cells).
          const grid = gridForCount(panes.length)
          return { ...w, panes, layout: { grid, order } }
        }),
      }
    })
    // The pty died with the store change above; its saved scrollback goes to the trash (E6-FR-12).
    trashSavedScrollback([paneId])
  },

  closePane: (workspaceId, paneId) => {
    const ws = get().workspaces.find((w) => w.id === workspaceId)
    const pane = ws?.panes.find((p) => p.id === paneId)
    if (!ws || !pane) return
    // A moved console reopens at home: the move was for this session only.
    const home = get().paneHome[paneId]
    const order = ws.layout?.order ?? ws.panes.map((p) => p.id)
    const orderIndex = home ? home.orderIndex : Math.max(0, order.indexOf(paneId))
    useAgentStore.getState().pushClosed({ workspaceId: home?.workspaceId ?? workspaceId, pane, orderIndex })
    get().removePane(workspaceId, paneId)
  },

  restorePane: (workspaceId, pane, orderIndex) => {
    const ws = get().workspaces.find((w) => w.id === workspaceId)
    if (!ws || get().workspaces.some((w) => w.panes.some((p) => p.id === pane.id))) return false
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w
        const panes = [...w.panes, pane]
        const order = (w.layout?.order ?? w.panes.map((p) => p.id)).filter((id) => id !== pane.id)
        order.splice(Math.max(0, Math.min(orderIndex, order.length)), 0, pane.id)
        return { ...w, panes, layout: { grid: gridForCount(panes.length), order } }
      }),
    }))
    return true
  },

  reopenClosedPane: () => {
    const agents = useAgentStore.getState()
    for (;;) {
      const entry = agents.popClosed()
      if (!entry) return null
      // A deleted workspace drops the entry; try the next one down the stack.
      if (!get().restorePane(entry.workspaceId, entry.pane, entry.orderIndex)) continue
      get().setActive(entry.workspaceId)
      return { workspaceId: entry.workspaceId, paneId: entry.pane.id }
    }
  },

  clearLastSession: (paneId) =>
    set((s) => {
      const ws = s.workspaces.find((w) => w.panes.some((p) => p.id === paneId && p.lastSession))
      if (!ws) return {}
      return {
        workspaces: s.workspaces.map((w) =>
          w === ws
            ? {
                ...w,
                panes: w.panes.map((p) => {
                  if (p.id !== paneId) return p
                  const { lastSession: _dropped, ...rest } = p
                  return rest
                }),
              }
            : w,
        ),
      }
    }),

  renamePane: (workspaceId, paneId, title) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === workspaceId
          ? {
              ...w,
              panes: w.panes.map((p) =>
                p.id === paneId ? { ...p, title: title.trim() || p.title } : p,
              ),
            }
          : w,
      ),
    })),

  setPaneFontSize: (workspaceId, paneId, fontSize) =>
    set((s) => {
      const clamped = Math.max(8, Math.min(40, Math.round(fontSize)))
      return {
        workspaces: s.workspaces.map((w) =>
          w.id === workspaceId
            ? {
                ...w,
                panes: w.panes.map((p) =>
                  p.id === paneId ? { ...p, fontSize: clamped } : p,
                ),
              }
            : w,
        ),
      }
    }),

  restartPane: (paneId) => {
    if (restartInPlace(paneId)) return
    get().restartPaneClean(paneId)
  },

  restartPaneClean: (paneId) => {
    // Any restart wakes a sleeping console (E5-FR-26): the overlay gives way to a new terminal.
    useAgentStore.getState().setSleeping(paneId, null)
    // Unmounting never kills (E4-FR-36), so kill first, by paneId in main: IPC
    // from one renderer is handled in order and the kill is synchronous, so the
    // new mount's reattach finds nothing and spawns a fresh shell.
    killPanePtys([paneId])
    set((s) => ({ paneEpoch: { ...s.paneEpoch, [paneId]: (s.paneEpoch[paneId] ?? 0) + 1 } }))
    // A console outside the mounted set (a workspace not revisited since a
    // reload, a phone restart) mounts now, so the kill is followed by a fresh
    // shell instead of leaving the pane without one.
    const ws = get().workspaces.find((w) => w.panes.some((p) => p.id === paneId))
    if (ws) get().ensureMounted(ws.id, { only: [paneId] })
  },

  setPaneExit: (paneId, code) => {
    // Hot path on every spawn: no set() when nothing changes.
    const cur = get().paneExit[paneId]
    if (code === null ? cur === undefined : cur === code) return
    set((s) => {
      const paneExit = { ...s.paneExit }
      if (code === null) delete paneExit[paneId]
      else paneExit[paneId] = code
      return { paneExit }
    })
    // E8-FR-25: a repo setup console exited; exit 0 releases its held consoles.
    const run = code === null ? undefined : get().repoSetups[paneId]
    if (run && run.status === 'running' && code !== null) settleRepoSetup(set, paneId, run, code)
  },

  setAgentEnded: (evt) => set((s) => ({ agentEnded: { ...s.agentEnded, [evt.paneId]: evt } })),

  clearAgentEnded: (paneId) => {
    // Hot path (called per keystroke): bail without a set() when clean.
    if (!(paneId in get().agentEnded)) return
    set((s) => {
      const agentEnded = { ...s.agentEnded }
      delete agentEnded[paneId]
      return { agentEnded }
    })
  },

  setPaneSchedule: (workspaceId, paneId, schedule) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === workspaceId
          ? {
              ...w,
              panes: w.panes.map((p) =>
                p.id === paneId ? { ...p, schedule: schedule ?? undefined } : p,
              ),
            }
          : w,
      ),
    })),

  setPaneWorktree: (workspaceId, paneId, worktree) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === workspaceId
          ? {
              ...w,
              panes: w.panes.map((p) => {
                if (p.id !== paneId) return p
                if (worktree) return { ...p, cwd: worktree.path, worktree: { ...worktree } }
                const { worktree: _gone, cwd: _cwd, ...rest } = p
                return rest
              }),
            }
          : w,
      ),
    })),

  setGrid: (workspaceId, grid) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === workspaceId
          ? { ...w, layout: { grid, order: w.layout?.order ?? w.panes.map((p) => p.id) } }
          : w,
      ),
    })),

  movePane: (workspaceId, paneId, toIndex) =>
    set((s) => {
      const ws = s.workspaces.find((w) => w.id === workspaceId)
      if (!ws) return s
      // The order as rendered (panes missing from layout.order appended), so
      // toIndex means the same slot the grid shows.
      const order = orderPanes(ws.panes, ws.layout?.order).map((p) => p.id)
      const from = order.indexOf(paneId)
      const to = Math.max(0, Math.min(toIndex, order.length - 1))
      // A drag reports the same slot many times: no new state, no re-render.
      if (from === -1 || from === to) return s
      order.splice(from, 1)
      order.splice(to, 0, paneId)
      const grid = gridForCount(ws.panes.length)
      return { workspaces: s.workspaces.map((w) => (w.id === workspaceId ? { ...w, layout: { grid, order } } : w)) }
    }),

  setWorkspaceOrder: (ids) =>
    set((s) => {
      const rank = new Map(ids.map((id, i) => [id, i]))
      const at = (w: Workspace): number => rank.get(w.id) ?? ids.length + s.workspaces.indexOf(w)
      const workspaces = [...s.workspaces].sort((a, b) => at(a) - at(b))
      return workspaces.every((w, i) => w === s.workspaces[i]) ? s : { workspaces }
    }),

  setPaneCwd: (paneId, cwd) =>
    set((s) => (s.paneCwd[paneId] === cwd ? s : { paneCwd: { ...s.paneCwd, [paneId]: cwd } })),

  movePaneToWorkspace: (paneId, toWorkspaceId) => {
    const s = get()
    const from = s.workspaces.find((w) => w.panes.some((p) => p.id === paneId))
    if (!from || from.id === toWorkspaceId) return false
    const prev = s.paneHome[paneId]
    const back = prev?.workspaceId === toWorkspaceId
    const home: PaneHome = prev ?? { workspaceId: from.id, orderIndex: orderIndexOf(from, paneId) }
    // One set: the pane id never leaves the workspaces, so its pty lives on.
    const workspaces = transferPane(s.workspaces, paneId, toWorkspaceId, back ? home.orderIndex : undefined)
    if (!workspaces) return false
    const paneHome = { ...s.paneHome }
    if (back) delete paneHome[paneId]
    else paneHome[paneId] = home
    const maximized = { ...s.maximized }
    if (maximized[from.id] === paneId) maximized[from.id] = null
    const minimized = { ...s.minimized }
    if (minimized[from.id]?.includes(paneId)) minimized[from.id] = minimized[from.id].filter((id) => id !== paneId)
    set({ workspaces, paneHome, maximized, minimized })
    get().ensureMounted(toWorkspaceId, { only: [paneId] })
    return true
  },

  toggleMaximize: (workspaceId, paneId) =>
    set((s) => ({
      maximized: {
        ...s.maximized,
        [workspaceId]: s.maximized[workspaceId] === paneId ? null : paneId,
      },
    })),

  clearMaximize: (workspaceId) =>
    set((s) => ({ maximized: { ...s.maximized, [workspaceId]: null } })),

  toggleMinimize: (workspaceId, paneId) => {
    const wasMinimized = (get().minimized[workspaceId] ?? []).includes(paneId)
    set((s) => {
      const current = s.minimized[workspaceId] ?? []
      const next = current.includes(paneId)
        ? current.filter((id) => id !== paneId)
        : [...current, paneId]
      return { minimized: { ...s.minimized, [workspaceId]: next } }
    })
    // Restoring a minimized console counts as looking at it.
    if (wasMinimized) get().clearPaneAttention(paneId)
  },

  savePreset: (preset) =>
    set((s) => {
      const exists = s.presets.some((p) => p.id === preset.id)
      return {
        presets: exists
          ? s.presets.map((p) => (p.id === preset.id ? preset : p))
          : [...s.presets, preset],
      }
    }),

  deletePreset: (id) => set((s) => ({ presets: s.presets.filter((p) => p.id !== id) })),

  newPresetId: () => uid('preset'),

  saveQuickCommand: (input) => {
    const cmd = parseQuickCommand(input)
    if (!cmd) return false
    const list = get().quickCommands
    const exists = list.some((x) => x.id === cmd.id)
    if (!exists && list.length >= QUICK_COMMANDS_MAX) return false
    set({ quickCommands: exists ? list.map((x) => (x.id === cmd.id ? cmd : x)) : [...list, cmd] })
    return true
  },

  deleteQuickCommand: (id) => set((s) => ({ quickCommands: s.quickCommands.filter((x) => x.id !== id) })),

  moveQuickCommand: (id, delta) =>
    set((s) => {
      const from = s.quickCommands.findIndex((x) => x.id === id)
      const to = from + delta
      if (from < 0 || to < 0 || to >= s.quickCommands.length) return {}
      const quickCommands = [...s.quickCommands]
      const [item] = quickCommands.splice(from, 1)
      quickCommands.splice(to, 0, item)
      return { quickCommands }
    }),

  newQuickCommandId: () => uid('qc'),

  saveKeyButton: (button) =>
    set((s) => {
      const exists = s.keyButtons.some((x) => x.id === button.id)
      return {
        keyButtons: exists
          ? s.keyButtons.map((x) => (x.id === button.id ? button : x))
          : [...s.keyButtons, button],
      }
    }),

  deleteKeyButton: (id) => set((s) => ({ keyButtons: s.keyButtons.filter((x) => x.id !== id) })),

  newKeyButtonId: () => uid('key'),

  saveConnection: (connection) =>
    set((s) => {
      const exists = s.connections.some((c) => c.id === connection.id)
      return {
        connections: exists
          ? s.connections.map((c) => (c.id === connection.id ? connection : c))
          : [...s.connections, connection],
      }
    }),

  deleteConnection: (id) => set((s) => ({ connections: s.connections.filter((c) => c.id !== id) })),

  newConnectionId: () => uid('conn'),

  updateSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

  setSettingsOpen: (open) => set(open ? { settingsOpen: true } : { settingsOpen: false, settingsQuery: '', settingsAnchor: null }),

  openSettings: (target) => {
    const [category, row] = (target ?? '').split('#', 2)
    set({
      settingsOpen: true,
      settingsCategory: target ?? null,
      settingsQuery: '',
      settingsAnchor: category && row ? `${category}.${row}` : null,
    })
  },

  setSettingsQuery: (query) => set({ settingsQuery: query }),

  setSettingsAnchor: (anchor) => set({ settingsAnchor: anchor }),

  setPaneStatus: (evt) =>
    set((s) => {
      const paneStatus = { ...s.paneStatus }
      let paneAttention = s.paneAttention
      if (evt.state === null) {
        if (!(evt.paneId in paneStatus) && !(evt.paneId in paneAttention)) return {}
        delete paneStatus[evt.paneId]
        if (evt.paneId in paneAttention) {
          paneAttention = { ...paneAttention }
          delete paneAttention[evt.paneId]
        }
        return { paneStatus, paneAttention }
      }
      paneStatus[evt.paneId] = {
        state: evt.state, precise: evt.precise, provider: evt.provider, reason: evt.reason, pendingCount: evt.pendingCount, updatedAt: evt.updatedAt,
        stateSince: evt.stateSince, lastMessage: evt.lastMessage, activity: evt.activity, pending: evt.pending, sessionId: evt.sessionId, cwd: evt.cwd,
        detail: evt.detail, topic: evt.topic, firstPrompt: evt.firstPrompt, cacheSince: evt.cacheSince,
      }
      // A new session (or Claude working again) hides the "Claude exited" chip (E6-FR-22).
      let agentEnded = s.agentEnded
      const ended = agentEnded[evt.paneId]
      if (ended && (evt.state === 'working' || (evt.sessionId && evt.sessionId !== ended.sessionId))) {
        agentEnded = { ...agentEnded }
        delete agentEnded[evt.paneId]
      }
      // E4-FR-09 (d): mirror a validated session id onto pane.lastSession
      // (schema 11, a seed for main's agent-sessions.json). Only a change of
      // session, provider or cwd writes, so plain status traffic never persists.
      const workspaces = withLastSession(s.workspaces, evt)
      if (evt.state === 'done' || evt.state === 'action' || evt.state === 'error') {
        // Only flag attention when the console is not being looked at right now:
        // other workspace, minimized in the active one, or the window unfocused.
        const wsId = s.workspaces.find((w) => w.panes.some((p) => p.id === evt.paneId))?.id
        const visible = wsId ? visiblePaneIds(s.workspaces.find(w => w.id === wsId), s.minimized[wsId] ?? [], s.maximized[wsId]) : []
        const inView = wsId === s.activeWorkspaceId && visible.includes(evt.paneId) && document.hasFocus()
        if (!inView && !(evt.paneId in paneAttention)) {
          paneAttention = { ...paneAttention, [evt.paneId]: true }
        }
      } else if ((evt.state === 'working' || evt.state === 'idle') && evt.paneId in paneAttention) {
        // Back to work: the pending "look at me" flag is stale.
        paneAttention = { ...paneAttention }
        delete paneAttention[evt.paneId]
      }
      return workspaces === s.workspaces ? { paneStatus, paneAttention, agentEnded } : { paneStatus, paneAttention, agentEnded, workspaces }
    }),

  clearPaneAttention: (paneId) => {
    // Hot path (called per keystroke): bail without a set() when clean.
    if (!(paneId in get().paneAttention)) return
    set((s) => {
      const paneAttention = { ...s.paneAttention }
      delete paneAttention[paneId]
      return { paneAttention }
    })
  },

  markWorkspaceSeen: (workspaceId) =>
    set((s) => {
      const ws = s.workspaces.find((w) => w.id === workspaceId)
      if (!ws) return {}
      const visible = new Set(visiblePaneIds(ws, s.minimized[workspaceId] ?? [], s.maximized[workspaceId]))
      const toClear = ws.panes.filter(
        (p) => p.id in s.paneAttention && visible.has(p.id),
      )
      if (toClear.length === 0) return {}
      const paneAttention = { ...s.paneAttention }
      for (const p of toClear) delete paneAttention[p.id]
      return { paneAttention }
    }),

  ensureMounted: (workspaceId, opts) => {
    const s = get()
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    if (!ws) return
    const next = withMounted(s.mountedWorkspaces, workspaceId, ws.panes.map((p) => p.id), opts)
    if (next !== s.mountedWorkspaces) set({ mountedWorkspaces: next })
  },

  setWizardOpen: (open, prefill) =>
    set({ wizardOpen: open, composerOpen: open, wizardPrefill: open ? (prefill ?? null) : null, wizardDraft: null }),

  openAdvancedWizard: (draft) => set({ wizardOpen: true, composerOpen: false, wizardPrefill: null, wizardDraft: draft }),

  setPaletteOpen: (open) => set({ paletteOpen: open }),

  setGlobalPromptOpen: (open) => set({ globalPromptOpen: open }),

  setQuickPopoverOpen: (open) => set({ quickPopoverOpen: open }),

  setQuickEdit: (req) => set({ quickEdit: req }),

  setPendingPrompt: (paneId, prompt) =>
    set((s) => {
      if (!prompt && !(paneId in s.pendingPrompts)) return {}
      const pendingPrompts = { ...s.pendingPrompts }
      if (prompt) pendingPrompts[paneId] = prompt
      else delete pendingPrompts[paneId]
      return { pendingPrompts }
    }),

  takePendingPrompt: (paneId) => {
    const prompt = get().pendingPrompts[paneId]
    if (!prompt) return null
    get().setPendingPrompt(paneId, null)
    return prompt
  },
}))
