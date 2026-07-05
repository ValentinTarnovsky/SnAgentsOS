import { Notification, type BrowserWindow } from 'electron'
import { CH } from '@shared/ipc-channels'
import type {
  ClaudePaneState,
  ConfigFile,
  NotificationSettings,
  PaneStatusEvt,
} from '@shared/types'
import type { PtySink } from '../pty/PtyManager'
import { mainT } from '../i18n'
import type { HookEvent } from './HookServer'

/** What the OSC title alone can tell us about the Claude session. */
type TitleState = 'working' | 'stopped' | 'claudePresent' | null

interface PaneTrack {
  state: ClaudePaneState | null
  /** True once hook events flow for this pane (exact 3-state channel). */
  precise: boolean
  titleState: TitleState
  hookState: ClaudePaneState | null
  /** hooks say working + title stopped sustained => AskUserQuestion etc. */
  fusionTimer: NodeJS.Timeout | null
  /** Neutral (shell) title sustained => claude exited, clear the indicator. */
  clearTimer: NodeJS.Timeout | null
  lastNotifyAt: number
}

/** hooks-working + title-stopped must hold this long to count as needs-action. */
const FUSION_MS = 2500
/** A non-claude title must hold this long before the indicator clears. */
const NEUTRAL_CLEAR_MS = 3000
/** Per-pane floor between desktop notifications. */
const NOTIFY_DEBOUNCE_MS = 15000

/** Titles Claude Code sets that carry no work/idle information. */
function isNeutralClaudeTitle(title: string): boolean {
  return title === 'claude' || title === 'Claude Code' || title === 'claude daemon' ||
    title.startsWith('claude · ')
}

/**
 * Classifies one OSC title update. Ground truth from Claude Code v2.1.200:
 * while an agent turn runs the title prefix alternates between two fixed-width
 * braille frames (U+2802 / U+2810; older builds used a 10-frame braille set,
 * so the whole U+2800-U+28FF block counts); when the REPL sits at the prompt,
 * finished OR waiting on a permission/question, the prefix is U+2733.
 */
function classifyTitle(title: string): TitleState {
  const t = title.trim()
  if (!t) return null
  const cp = t.codePointAt(0) ?? 0
  if (cp >= 0x2800 && cp <= 0x28ff) return 'working'
  if (cp === 0x2733) return 'stopped'
  if (isNeutralClaudeTitle(t)) return 'claudePresent'
  return null
}

/**
 * Per-console Claude state machine fed by two structured channels: xterm OSC
 * title changes relayed by the renderer, and (when the user enables the
 * integration) Claude Code hook events from the local HookServer. Never reads
 * pty bytes. Emits PaneStatusEvt on changes and owns the desktop-notification
 * decision (the renderer reuses the `notify` flag for the sound so the two
 * can never diverge).
 */
export class StatusManager implements PtySink {
  readonly id = 'status'

  private readonly panes = new Map<string, PaneTrack>()
  private viewed = new Set<string>()
  private cfg: NotificationSettings | null = null

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly getConfig: () => ConfigFile | null,
  ) {}

  // --- PtySink (lifecycle only; onData is a hot path and must stay a no-op) ---
  onSpawn(_ptyId: string, _paneId: string): void {}
  onData(_ptyId: string, _paneId: string, _data: string): void {}
  onExit(_ptyId: string, paneId: string, _exitCode: number): void {
    this.clearPane(paneId)
  }

  setConfig(cfg: NotificationSettings): void {
    this.cfg = cfg
  }

  setViewed(paneIds: string[]): void {
    this.viewed = new Set(paneIds)
  }

  /** Renderer relayed an xterm onTitleChange for one console. */
  reportTitle(paneId: string, title: string): void {
    const titleState = classifyTitle(title)
    const track = this.panes.get(paneId)

    if (!track) {
      if (titleState === null) return
      const fresh: PaneTrack = {
        state: null,
        precise: false,
        titleState,
        hookState: null,
        fusionTimer: null,
        clearTimer: null,
        lastNotifyAt: 0,
      }
      this.panes.set(paneId, fresh)
      // First sighting: working is trustworthy; a lone stopped/neutral title
      // (reattach replay, app restart) just means "a claude is there".
      this.setState(paneId, fresh, titleState === 'working' ? 'working' : 'idle')
      return
    }

    const prevTitle = track.titleState
    track.titleState = titleState

    if (titleState === null) {
      // Shell took the title back (claude exited). Clear after it holds.
      if (!track.clearTimer) {
        track.clearTimer = setTimeout(() => {
          track.clearTimer = null
          this.clearPane(paneId)
        }, NEUTRAL_CLEAR_MS)
      }
      return
    }
    if (track.clearTimer) {
      clearTimeout(track.clearTimer)
      track.clearTimer = null
    }

    if (track.precise) {
      // Hooks own the state; the title only powers the AskUserQuestion fusion:
      // Claude is mid-turn (no Stop yet) but its spinner stopped => it is
      // waiting on a question/permission UI that fires no hook.
      if (track.hookState === 'working' && titleState === 'stopped') {
        if (!track.fusionTimer) {
          track.fusionTimer = setTimeout(() => {
            track.fusionTimer = null
            if (track.hookState === 'working' && track.titleState === 'stopped') {
              this.setState(paneId, track, 'action')
            }
          }, FUSION_MS)
        }
      } else if (track.fusionTimer) {
        clearTimeout(track.fusionTimer)
        track.fusionTimer = null
      }
      return
    }

    // Title-only mode: 2 honest states. A working -> stopped transition means
    // "Claude stopped, look at it" (finished OR waiting, the title cannot tell
    // them apart, so we never claim 'done' here).
    if (titleState === 'working') this.setState(paneId, track, 'working')
    else if (titleState === 'stopped') {
      this.setState(paneId, track, prevTitle === 'working' || track.state === 'working' ? 'action' : 'idle')
    } else if (track.state === null) this.setState(paneId, track, 'idle')
  }

  /** A Claude Code hook event arrived for one console. */
  onHookEvent(evt: HookEvent): void {
    const track = this.ensureTrack(evt.consoleId)
    if (!track.precise) track.precise = true

    switch (evt.name) {
      case 'UserPromptSubmit':
        track.hookState = 'working'
        this.cancelFusion(track)
        this.setState(evt.consoleId, track, 'working')
        break
      case 'Stop':
        track.hookState = 'done'
        this.cancelFusion(track)
        this.setState(evt.consoleId, track, 'done')
        break
      case 'StopFailure':
        track.hookState = 'action'
        this.cancelFusion(track)
        this.setState(evt.consoleId, track, 'action')
        break
      case 'Notification': {
        // Exact match only: substring checks would misfire on types like
        // chrome_permission_prompt.
        const t = evt.notificationType
        if (t === 'permission_prompt' || t === 'elicitation_dialog') {
          track.hookState = 'action'
          this.cancelFusion(track)
          this.setState(evt.consoleId, track, 'action')
        } else if (t === 'idle_prompt' && track.state === 'working') {
          // Advisory (fires ~60s into idle; flaky in some builds).
          track.hookState = 'action'
          this.setState(evt.consoleId, track, 'action')
        }
        break
      }
      case 'SessionStart':
        track.hookState = 'idle'
        if (track.state === null) this.setState(evt.consoleId, track, 'idle')
        break
      case 'SessionEnd':
        this.clearPane(evt.consoleId)
        break
      default:
        break
    }
  }

  dispose(): void {
    for (const paneId of [...this.panes.keys()]) this.clearPane(paneId)
  }

  private ensureTrack(paneId: string): PaneTrack {
    let track = this.panes.get(paneId)
    if (!track) {
      track = {
        state: null,
        precise: false,
        titleState: null,
        hookState: null,
        fusionTimer: null,
        clearTimer: null,
        lastNotifyAt: 0,
      }
      this.panes.set(paneId, track)
    }
    return track
  }

  private cancelFusion(track: PaneTrack): void {
    if (track.fusionTimer) {
      clearTimeout(track.fusionTimer)
      track.fusionTimer = null
    }
  }

  private clearPane(paneId: string): void {
    const track = this.panes.get(paneId)
    if (!track) return
    this.cancelFusion(track)
    if (track.clearTimer) clearTimeout(track.clearTimer)
    this.panes.delete(paneId)
    if (track.state !== null) {
      this.emit({ paneId, state: null, precise: track.precise, notify: false })
    }
  }

  private setState(paneId: string, track: PaneTrack, state: ClaudePaneState): void {
    if (track.state === state) return
    track.state = state
    const notify = this.shouldNotify(paneId, track, state)
    this.emit({ paneId, state, precise: track.precise, notify })
    if (notify) {
      track.lastNotifyAt = Date.now()
      this.showNotification(paneId, track, state)
    }
  }

  private shouldNotify(paneId: string, track: PaneTrack, state: ClaudePaneState): boolean {
    const cfg = this.cfg
    if (!cfg?.enabled) return false
    if (state !== 'done' && state !== 'action') return false
    if (state === 'done' && !cfg.notifyDone) return false
    if (state === 'action' && !cfg.notifyAction) return false
    const win = this.getWindow()
    const inView = this.viewed.has(paneId) && (win?.isFocused() ?? false)
    if (inView) return false
    return Date.now() - track.lastNotifyAt >= NOTIFY_DEBOUNCE_MS
  }

  private showNotification(paneId: string, track: PaneTrack, state: ClaudePaneState): void {
    const win = this.getWindow()
    const cfg = this.getConfig()
    if (Notification.isSupported()) {
      const key =
        state === 'done'
          ? 'status.notif.done'
          : track.precise
            ? 'status.notif.action'
            : 'status.notif.generic'
      const notification = new Notification({
        title: 'SnMultiCC',
        body: mainT(cfg, key, { pane: this.paneName(cfg, paneId) }),
        silent: true, // the renderer plays the configurable sound instead
      })
      notification.on('click', () => {
        const w = this.getWindow()
        if (!w) return
        if (w.isMinimized()) w.restore()
        w.show()
        w.focus()
        w.webContents.send(CH.STATUS_REVEAL, paneId)
      })
      notification.show()
    }
    if (this.cfg?.flashTaskbar && win && !win.isFocused()) win.flashFrame(true)
  }

  private paneName(cfg: ConfigFile | null, paneId: string): string {
    for (const ws of cfg?.workspaces ?? []) {
      const pane = ws.panes.find((p) => p.id === paneId)
      if (pane) return pane.title
    }
    return 'Claude'
  }

  private emit(evt: PaneStatusEvt): void {
    this.getWindow()?.webContents.send(CH.STATUS_STATE, evt)
  }
}
