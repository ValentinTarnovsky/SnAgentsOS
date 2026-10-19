import type { RemoteCommand, RemoteCommandFit } from '@shared/ipc-contract'
import type { RemoteCtlAction } from '@shared/remote-protocol'
import type { AgentPreset, Workspace } from '@shared/types'
import { initialPromptFallback } from '@shared/initialPrompt'
import { shellKind } from '@shared/shellKind'
import { type AppState, useAppStore } from './store'
import { resolveLaunch } from './launch'
import { revealPane } from './revealPane'
import { getPtyId, killPanePtys } from './ptyRegistry'
import { fitBaselineOf, useFitStore } from './fitStore'
import { broadcastToWorkspace } from './broadcastPrompt'
import { restartFresh, restartFromButton, restartResume } from './agentLaunch'
import { wakePane } from './hibernation'
import { runRemoteQuickCommand } from './quickCommands'
import { runOpenPath, runOpenUrl } from './remoteOpen'
import { runCreatePaneResume } from './remoteResume'
import { platformDefaultShell, runAgentEnd } from './agentEndRun'
import { sendReviewNotes } from './sendReviewNotes'
import { runCtlOp } from './ctlCommands'
import { runScheduleNow, setScheduleEnabled } from './usePaneScheduler'
import { toast } from './toast'
import { translate } from '@/i18n'
import type { Language } from '@shared/types'

interface CmdResult {
  ok: boolean
  error?: string
  /** createPane: id of the freshly created pane. */
  paneId?: string
  /** globalPrompt: number of consoles the text was inserted into. */
  info?: number
  /** createPane: the prompt could not go on the command line (E2-FR-11). */
  promptFallback?: boolean
}

/**
 * Predicts E2-FR-11's fallback for a phone prompt before the console spawns:
 * a preset that is not claude/codex, a Connection Profile, a shell we cannot
 * quote for, more than 2000 sanitized characters or a `%` on win32. Main
 * decides again with the resolved shell (the spawn carries mode 'argvOnly',
 * so a miss is never typed by the gate). Exported for tests.
 */
export function remotePromptFallback(
  state: Pick<AppState, 'presets' | 'connections' | 'settings'>,
  ws: Workspace,
  preset: AgentPreset | undefined,
  text: string,
  platform: string,
): boolean {
  if (!preset || (preset.type !== 'claude' && preset.type !== 'codex')) return true
  const pane = { id: '', type: preset.type, presetId: preset.id, title: preset.name, color: preset.color, icon: preset.icon }
  const launch = resolveLaunch(pane, ws, state.presets, state.connections)
  const configured = platform === 'win32' || platform === 'darwin' || platform === 'linux' ? state.settings.defaultShell[platform] : undefined
  const shell = configured?.trim() ? configured : platformDefaultShell(platform)
  return initialPromptFallback({ text, shell: shellKind(shell, platform), platform, hasSetup: !!launch.setup, launchKind: launch.launchKind ?? 'other' })
}

/**
 * Execute a phone control action through the existing store actions. Ids are
 * validated first so a stale phone view can't act on a deleted workspace/pane.
 */
function run(action: RemoteCtlAction, fit?: RemoteCommandFit): CmdResult | Promise<CmdResult> {
  const store = useAppStore.getState()

  switch (action.kind) {
    case 'switchWorkspace': {
      const ws = store.workspaces.find((w) => w.id === action.workspaceId)
      if (!ws) return { ok: false, error: 'not_found' }
      store.setActive(action.workspaceId)
      // The phone's "Show on the PC" of a workspace (E2-FR-09): the phone no
      // longer switches to navigate, so this is always an explicit ask and the
      // window comes up with it.
      window.snApi.window.reveal()
      return { ok: true }
    }

    case 'createPane': {
      // E3-FR-38/39: a history session in a new local console (or its open one).
      if (action.resume) return runCreatePaneResume({ ...action, resume: action.resume })
      const ws = store.workspaces.find((w) => w.id === action.workspaceId)
      if (!ws) return { ok: false, error: 'not_found' }
      const preset = action.presetId
        ? store.presets.find((p) => p.id === action.presetId)
        : undefined
      let paneId: string
      if (preset) {
        paneId = store.addPane(action.workspaceId, {
          type: preset.type,
          presetId: preset.id,
          title: preset.name,
          color: preset.color,
          icon: preset.icon,
        })
      } else if (action.paneType) {
        paneId = store.addPane(action.workspaceId, { type: action.paneType })
      } else {
        paneId = store.addPane(action.workspaceId)
      }
      if (!paneId) return { ok: false, error: 'not_found' }
      // E2-FR-11: line breaks become spaces (the variable is one line) and the
      // spawn never falls back to typing it: the phone keeps it instead.
      const text = action.prompt?.replace(/\r\n|\r|\n/g, ' ').trim() ?? ''
      let promptFallback = false
      if (text) {
        promptFallback = remotePromptFallback(store, ws, preset, text, window.snApi.platform)
        if (!promptFallback) {
          useAppStore.getState().setPendingPrompt(paneId, { text, enter: true, source: 'remote', createdAt: Date.now(), mode: 'argvOnly' })
        }
      }
      // Only the new console spawns; the desktop keeps its workspace (E2-FR-06).
      useAppStore.getState().ensureMounted(action.workspaceId, { only: [paneId] })
      return { ok: true, paneId, ...(promptFallback ? { promptFallback: true } : {}) }
    }

    case 'closePane': {
      const ws = store.workspaces.find((w) => w.id === action.workspaceId)
      if (!ws || !ws.panes.some((p) => p.id === action.paneId)) {
        return { ok: false, error: 'not_found' }
      }
      killPanePtys([action.paneId])
      // Through closePane so the desktop can reopen it (E5-FR-14). A worktree
      // console keeps its folder and branch (E7-FR-32): never the delete
      // dialog, never git:worktreeRemove; it shows up as an orphan in Settings.
      store.closePane(action.workspaceId, action.paneId)
      return { ok: true }
    }

    case 'restartPane': {
      const ws = store.workspaces.find((w) => w.id === action.workspaceId)
      if (!ws || !ws.panes.some((p) => p.id === action.paneId)) {
        return { ok: false, error: 'not_found' }
      }
      // E5-FR-11: true resumes (falls back to a new chat with the chip when the
      // record is gone), false forgets the session, absent = the header button.
      // A sleeping console wakes through the overlay's path (E5-FR-26), so a
      // scheduled prompt waits for the resumed agent; a phone `sub` never gets here.
      if (action.resume === true) {
        if (!wakePane(action.paneId)) restartResume(action.paneId)
      }
      else if (action.resume === false) restartFresh(action.paneId)
      else restartFromButton(action.paneId)
      return { ok: true }
    }

    case 'globalPrompt': {
      const ws = store.workspaces.find((w) => w.id === action.workspaceId)
      if (!ws) return { ok: false, error: 'not_found' }
      const count = broadcastToWorkspace(ws, action.text)
      return { ok: true, info: count }
    }

    case 'setTheme': {
      store.updateSettings({ theme: action.theme })
      return { ok: true }
    }

    case 'renamePane': {
      const ws = store.workspaces.find((w) => w.id === action.workspaceId)
      if (!ws || !ws.panes.some((p) => p.id === action.paneId)) {
        return { ok: false, error: 'not_found' }
      }
      store.renamePane(action.workspaceId, action.paneId, action.title)
      return { ok: true }
    }

    case 'runQuickCommand':
      // E8-FR-07: strict variant (the phone's console, its workspace, no activation).
      return runRemoteQuickCommand(action)

    case 'mountWorkspace': {
      // E2-FR-06: start every console of the workspace without activating it.
      const ws = store.workspaces.find((w) => w.id === action.workspaceId)
      if (!ws) return { ok: false, error: 'not_found' }
      store.ensureMounted(ws.id)
      return { ok: true, info: ws.panes.length }
    }

    case 'revealPane': {
      // E2-FR-07: bring the window up first, then the console (workspace,
      // maximize, minimize, focus) through the shared revealPane().
      if (!store.workspaces.some((w) => w.panes.some((p) => p.id === action.paneId))) {
        return { ok: false, error: 'not_found' }
      }
      window.snApi.window.reveal()
      return revealPane(action.paneId) ? { ok: true } : { ok: false, error: 'not_found' }
    }

    // E2-FR-28..30: links tapped in the phone terminal.
    case 'openPath':
      return runOpenPath(action)

    case 'openUrl':
      return runOpenUrl(action)

    case 'agentResume':
      // E6-FR-24: the same text as the desktop chip. Membership is checked like
      // restartPane; the first action of any device wins, the rest ack stale.
      return runAgentEnd(action.paneId, action.mode, action.workspaceId)

    // E3 M11 (R30-04): main already decided the owner; this applies the size.
    case 'fitPane':
      return runFitPane(action, fit)

    case 'releaseFit':
      return runReleaseFit(action.paneId, fit)
    case 'sendReviewNotes': {
      // E7-FR-25: the phone's notes come inline and are never stored on the
      // desktop; same checks, format and bracketed paste as the desktop send.
      // Enter only with the phone's explicit checkbox, only to an agent.
      const res = sendReviewNotes(action.workspaceId, action.paneId, { notes: action.notes, submit: action.enter })
      return res.ok ? { ok: true, info: res.sent } : { ok: false, error: res.error }
    }

    // v3.1 (E8-FR-32): the phone's Automations section.
    case 'scheduleRun':
    case 'scheduleToggle':
      return runScheduleCtl(action)

    default:
      return { ok: false, error: 'unknown_action' }
  }
}

/**
 * scheduleRun / scheduleToggle (E8-FR-32, v3.1): the same paths as the
 * desktop's Automations table. "Run now" is the manual run of R30-13 (waits
 * for a free agent, mounts a console of a workspace that is not mounted,
 * never moves `dueAt`); the switch pauses or re-arms. The pane must belong to
 * `workspaceId` (not_found) and have a schedule (no_schedule); a run also
 * needs a saved prompt (no_schedule as well, CONTRATOS v3.1). A run asked
 * again while one waits is a no-op ok ack (the contract's `info: 'pending'`
 * cannot travel: `ctlAck.info` is a number; the phone reads `runPending`).
 * Exported for tests.
 */
export function runScheduleCtl(action: Extract<RemoteCtlAction, { kind: 'scheduleRun' | 'scheduleToggle' }>): CmdResult {
  const ws = useAppStore.getState().workspaces.find((w) => w.id === action.workspaceId)
  const pane = ws?.panes.find((p) => p.id === action.paneId)
  if (!pane) return { ok: false, error: 'not_found' }
  if (!pane.schedule) return { ok: false, error: 'no_schedule' }
  if (action.kind === 'scheduleToggle') {
    setScheduleEnabled(pane.id, action.enabled)
    return { ok: true }
  }
  return runScheduleNow(pane.id) ? { ok: true } : { ok: false, error: 'no_schedule' }
}

/**
 * fitPane (E3-FR-14/17/23): the owner goes to fitStore, where a mounted
 * terminal picks it up (grid and smaller font) and a later mount reads it
 * before its first fit; the pty is resized here too, so a pane that is not
 * mounted (another workspace) still takes the phone size. Exported for tests.
 */
export function runFitPane(action: Extract<RemoteCtlAction, { kind: 'fitPane' }>, fit?: RemoteCommandFit): CmdResult {
  const ws = useAppStore.getState().workspaces.find((w) => w.id === action.workspaceId)
  if (!ws || !ws.panes.some((p) => p.id === action.paneId)) return { ok: false, error: 'not_found' }
  useFitStore.getState().setOwner(action.paneId, { cols: action.cols, rows: action.rows, chat: fit?.chat === true })
  const ptyId = fit?.ptyId ?? getPtyId(action.paneId)
  if (ptyId) window.snApi.pty.resize({ ptyId, cols: action.cols, rows: action.rows })
  return { ok: true }
}

/**
 * releaseFit (E3-FR-18/19/20): the owner leaves fitStore and the pty gets the
 * latest baseline the desktop measured (main's pre-phone size when this
 * renderer never measured the pane). A visible terminal refits right after
 * and corrects any drift. Idempotent; a pane nobody owned is still ok.
 */
export function runReleaseFit(paneId: string, fit?: RemoteCommandFit): CmdResult {
  useFitStore.getState().clearOwner(paneId)
  const base = fitBaselineOf(paneId) ?? fit?.baseline ?? null
  const ptyId = fit?.ptyId ?? getPtyId(paneId)
  if (ptyId && base && base.cols > 0 && base.rows > 0) window.snApi.pty.resize({ ptyId, cols: base.cols, rows: base.rows })
  return { ok: true }
}

/**
 * Text of the info toast for a phone action that changed the desktop
 * (E4-FR-08): globalPrompt, restartPane and closePane. `deviceName` is the one
 * main resolved from the authenticated session; without it the text says
 * "from the phone". Null for every other action or a failed one.
 */
export function remoteNoticeText(
  action: RemoteCtlAction,
  result: CmdResult,
  deviceName: string | undefined,
  paneTitle: string | undefined,
  lang: Language,
): string | null {
  if (!result.ok) return null
  let what: string
  if (action.kind === 'globalPrompt') {
    const count = result.info ?? 0
    what = translate(lang, count === 1 ? 'toast.remote.promptOne' : count === 0 ? 'toast.remote.promptNone' : 'toast.remote.promptMany', { count })
  } else if (action.kind === 'restartPane') {
    what = translate(lang, 'toast.remote.restarted', { pane: paneTitle ?? '' })
  } else if (action.kind === 'closePane') {
    what = translate(lang, 'toast.remote.closed', { pane: paneTitle ?? '' })
  } else return null
  const name = deviceName?.trim()
  return name ? translate(lang, 'toast.remote.fromDevice', { device: name, what }) : translate(lang, 'toast.remote.fromPhone', { what })
}

/** Title of the pane an action targets, read before it runs (closePane removes it). */
function targetTitle(action: RemoteCtlAction): string | undefined {
  if (action.kind !== 'restartPane' && action.kind !== 'closePane') return undefined
  const ws = useAppStore.getState().workspaces.find((w) => w.id === action.workspaceId)
  return ws?.panes.find((p) => p.id === action.paneId)?.title
}

let wired = false

/** Wire the main->renderer control-command stream to the store actions (idempotent). */
export function initRemoteCommands(): () => void {
  if (wired) return () => undefined
  wired = true
  const off = window.snApi.remote.onCommand((cmd: RemoteCommand) => {
    // snaos CLI bus (R30-11): main-only ops on the same relay, no phone toast.
    if (cmd.action.kind === 'cli') {
      let res: ReturnType<typeof runCtlOp>
      try {
        res = runCtlOp(cmd.action.op)
      } catch (err) {
        res = { ok: false, error: err instanceof Error ? err.message : 'internal' }
      }
      window.snApi.remote.commandResult({ id: cmd.id, ...res })
      return
    }
    const action = cmd.action
    const title = targetTitle(action)
    const report = (result: CmdResult): void => {
      window.snApi.remote.commandResult({ id: cmd.id, ...result })
      const notice = remoteNoticeText(action, result, cmd.deviceName, title, useAppStore.getState().settings.language)
      if (notice) toast.info(notice)
    }
    const failed = (err: unknown): CmdResult => ({ ok: false, error: err instanceof Error ? err.message : 'error' })
    let out: CmdResult | Promise<CmdResult>
    try {
      out = run(action, cmd.fit)
    } catch (err) {
      out = failed(err)
    }
    // Most actions answer synchronously; a Quick Command waits for its submit.
    if ('then' in out) void out.then(report, (err: unknown) => report(failed(err)))
    else report(out)
  })
  return () => {
    wired = false
    off()
  }
}
