import { Notification, type BrowserWindow } from 'electron'
import { CH } from '@shared/ipc-channels'
import type { AgentProvider, AttentionReason, ClaudePaneState, ConfigFile, NotificationSettings, PaneStatusEvt } from '@shared/types'
import type { PtySink } from '../pty/PtyManager'
import { mainT } from '../i18n'
import type { HookEvent } from './HookServer'
import type { AgentEvent, StatusNotice } from './events'

interface PaneTrack {
  provider: AgentProvider
  sessionId: string
  retired: Set<string>
  precise: boolean
  activity: ClaudePaneState
  pending: Map<string, AttentionReason>
  seen: Set<string>
  turnId: string
  turn: number
  timer: NodeJS.Timeout | null
  updatedAt: number
  ended: boolean
}

/** Requests survive title changes, renderer reloads and concurrent background work. */
export class StatusManager implements PtySink {
  readonly id = 'status'
  private readonly panes = new Map<string, PaneTrack>()
  private readonly ptys = new Map<string, string>()
  private viewed = new Set<string>()
  private cfg: NotificationSettings | null = null
  private promptSequence = 0
  lastClaudeEventAt: number | null = null
  desktopError: 'blocked' | 'failed' | 'unavailable' | null = null
  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly getConfig: () => ConfigFile | null,
    private readonly onNotice: (notice: StatusNotice) => void = () => {},
  ) {}
  onSpawn(ptyId: string, paneId: string): void { this.clearPane(paneId); this.ptys.set(paneId, ptyId) }
  onData(): void {}
  onExit(ptyId: string, paneId: string): void {
    if (this.ptys.get(paneId) !== ptyId) return
    this.ptys.delete(paneId)
    this.clearPane(paneId)
  }
  setConfig(cfg: NotificationSettings): void { this.cfg = cfg }
  setViewed(paneIds: string[]): void { this.viewed = new Set(paneIds) }
  snapshot(): PaneStatusEvt[] { return [...this.panes].map(([id, track]) => this.event(id, track, false)) }
  testDesktop(): void { this.showNative(mainT(this.getConfig(), 'status.notif.test')) }

  reportTitle(paneId: string, title: string): void {
    if (!this.ptys.has(paneId)) return
    const current = this.panes.get(paneId)
    if (current?.precise) return
    const t = title.trim(), cp = t.codePointAt(0) ?? 0
    const working = cp >= 0x2800 && cp <= 0x28ff, stopped = cp === 0x2733
    const present = /^(claude|Claude Code|claude daemon)$/.test(t) || t.startsWith('claude · ')
    if (!working && !stopped && !present) {
      if (current && !current.timer) current.timer = setTimeout(() => this.clearPane(paneId), 3000)
      return
    }
    const track = current ?? this.createTrack('claude', '')
    this.panes.set(paneId, track)
    this.cancelTimer(track)
    if (working) {
      if (track.activity !== 'working') track.turn++
      track.activity = 'working'
      track.pending.clear()
    } else if (stopped && track.activity === 'working') {
      track.activity = 'idle'
      track.pending.set('title', 'question')
      this.publish(paneId, track, `title:${track.turn}`, 'action')
      return
    }
    this.publish(paneId, track)
  }

  onHookEvent(evt: HookEvent): void {
    if (!evt.ptyId || !evt.sessionId || this.ptys.get(evt.consoleId) !== evt.ptyId) return
    if (evt.agentId && !['PermissionRequest', 'Elicitation', 'ElicitationResult', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification'].includes(evt.name)) return
    if (evt.agentId && evt.name === 'PreToolUse' && !['AskUserQuestion', 'ExitPlanMode'].includes(evt.toolName ?? '')) return
    const base = { paneId: evt.consoleId, ptyId: evt.ptyId, provider: 'claude' as const, sessionId: evt.agentId ? this.panes.get(evt.consoleId)?.sessionId ?? evt.sessionId : evt.sessionId }
    const requestId = evt.toolUseId ?? evt.elicitationId
    let event: AgentEvent | undefined
    switch (evt.name) {
      case 'SessionStart': event = { ...base, kind: 'start' }; break
      case 'SessionEnd': event = { ...base, kind: 'end' }; break
      case 'UserPromptSubmit': event = { ...base, kind: 'working', turnId: `prompt:${++this.promptSequence}` }; break
      case 'Stop': event = { ...base, kind: 'done' }; break
      case 'StopFailure': event = { ...base, kind: 'error', reason: 'failure' }; break
      case 'PermissionRequest': event = { ...base, kind: 'request', requestId, reason: 'permission' }; break
      case 'Elicitation': event = { ...base, kind: 'request', requestId, reason: 'elicitation' }; break
      case 'ElicitationResult': event = { ...base, kind: 'resolved', requestId, reason: 'elicitation' }; break
      case 'PreToolUse':
        event = evt.toolName === 'AskUserQuestion' || evt.toolName === 'ExitPlanMode'
          ? { ...base, kind: 'request', requestId, reason: evt.toolName === 'ExitPlanMode' ? 'plan' : 'question' }
          : { ...base, kind: 'working' }
        break
      case 'PostToolUse':
      case 'PostToolUseFailure': event = { ...base, kind: 'resolved', requestId }; break
      case 'Notification': {
        const reason = evt.notificationType === 'permission_prompt' ? 'permission' : evt.notificationType === 'elicitation_dialog' ? 'elicitation' : undefined
        if (reason && ![...(this.panes.get(evt.consoleId)?.pending.values() ?? [])].includes(reason)) event = { ...base, kind: 'request', reason }
        break
      }
    }
    if (event) { this.lastClaudeEventAt = Date.now(); this.onAgentEvent(event) }
  }

  onAgentEvent(evt: AgentEvent): void {
    if (this.ptys.get(evt.paneId) !== evt.ptyId) return
    let track = this.panes.get(evt.paneId)
    if (track?.retired.has(`${evt.provider}:${evt.sessionId}`)) {
      if (evt.kind === 'start' && (evt.provider === 'codex' || (track.ended && track.sessionId === evt.sessionId))) track.retired.delete(`${evt.provider}:${evt.sessionId}`)
      else return
    }
    if (track?.precise && (track.sessionId !== evt.sessionId || track.provider !== evt.provider)) {
      if (evt.kind !== 'start') return
      const retired = track.retired
      retired.add(`${track.provider}:${track.sessionId}`)
      if (retired.size > 64) retired.delete(retired.values().next().value!)
      this.cancelTimer(track)
      track = this.createTrack(evt.provider, evt.sessionId)
      track.retired = retired
    }
    if (!track) track = this.createTrack(evt.provider, evt.sessionId)
    if (!track.precise) { this.cancelTimer(track); track.pending.clear(); track.sessionId = evt.sessionId; track.provider = evt.provider }
    track.precise = true
    this.panes.set(evt.paneId, track)
    this.cancelTimer(track)
    if (evt.turnId) track.turnId = evt.turnId
    let notice: StatusNotice['state'] | undefined, key: string | undefined
    switch (evt.kind) {
      case 'start':
        track.ended = false; track.activity = 'idle'; track.pending.clear(); track.seen.clear()
        track.turnId = evt.turnId ?? ''
        break
      case 'working': track.activity = 'working'; break
      case 'idle': track.activity = 'idle'; break
      case 'request': {
        const id = evt.requestId ?? `fallback:${evt.reason ?? 'question'}`
        key = evt.requestId ? `request:${id}` : `request:${track.turnId}:${id}`
        if (evt.requestId && track.seen.has(key)) return
        const promoted = !!evt.requestId && track.pending.delete(`fallback:${evt.reason ?? 'question'}`)
        track.pending.set(id, evt.reason ?? 'question')
        if (!promoted) notice = 'action'
        break
      }
      case 'resolved':
        if (evt.requestId) {
          track.pending.delete(evt.requestId)
          // A stable request ID remains deduplicated after resolution.
        }
        if (evt.reason) track.pending.delete(`fallback:${evt.reason}`)
        if (evt.provider === 'claude') {
          track.pending.delete('fallback:permission')
          track.seen.delete(`request:${track.turnId}:fallback:permission`)
          if (evt.reason) track.seen.delete(`request:${track.turnId}:fallback:${evt.reason}`)
          track.activity = 'working'
        }
        break
      case 'done':
        if (evt.provider === 'claude') {
          const target = track
          target.timer = setTimeout(() => {
            target.timer = null
            target.activity = 'done'
            target.pending.clear()
            this.publish(evt.paneId, target, `done:${target.turnId}`, 'done')
          }, 700)
          return
        }
        track.activity = 'done'; key = `done:${track.turnId}`; notice = 'done'
        break
      case 'error': track.activity = 'error'; key = `error:${track.turnId}`; notice = 'error'; break
      case 'unknown': track.activity = 'unknown'; break
      case 'end':
        track.retired.add(`${evt.provider}:${evt.sessionId}`)
        track.pending.clear(); track.activity = 'idle'; track.ended = true
        break
    }
    this.publish(evt.paneId, track, key, notice)
  }

  dispose(): void { for (const id of [...this.panes.keys()]) this.clearPane(id); this.ptys.clear() }
  private createTrack(provider: AgentProvider, sessionId: string): PaneTrack {
    return { provider, sessionId, retired: new Set(), precise: false, activity: 'idle', pending: new Map(), seen: new Set(), turnId: '', turn: 0, timer: null, updatedAt: Date.now(), ended: false }
  }
  private cancelTimer(track: PaneTrack): void { if (track.timer) clearTimeout(track.timer); track.timer = null }
  private clearPane(paneId: string): void {
    const track = this.panes.get(paneId)
    if (!track) return
    this.cancelTimer(track); this.panes.delete(paneId)
    this.emit({ paneId, state: null, precise: false, notify: false })
  }
  private event(paneId: string, track: PaneTrack, notify: boolean): PaneStatusEvt {
    return {
      paneId, provider: track.provider, precise: track.precise, notify,
      state: track.activity === 'error' || track.activity === 'unknown' ? track.activity : track.pending.size ? 'action' : track.activity,
      reason: track.activity === 'error' ? 'failure' : track.pending.values().next().value,
      pendingCount: track.pending.size, updatedAt: track.updatedAt,
    }
  }
  private publish(paneId: string, track: PaneTrack, key?: string, state?: StatusNotice['state']): void {
    track.updatedAt = Date.now()
    const fresh = !!key && !track.seen.has(key)
    if (key) { track.seen.add(key); if (track.seen.size > 512) track.seen.delete(track.seen.values().next().value!) }
    const evt = this.event(paneId, track, false), cfg = this.cfg
    if (fresh && state) {
      this.onNotice({ paneId, provider: track.provider, state, reason: evt.reason })
      const inView = this.viewed.has(paneId) && (this.getWindow()?.isFocused() ?? false)
      evt.notify = !!cfg?.enabled && (state === 'done' ? cfg.notifyDone : cfg.notifyAction) && !inView
      if (evt.notify) this.showNotification(paneId, track, state)
    }
    this.emit(evt)
  }
  private showNotification(paneId: string, track: PaneTrack, state: StatusNotice['state']): void {
    const win = this.getWindow(), cfg = this.getConfig()
    let pane = track.provider === 'codex' ? 'Codex' : 'Claude'
    for (const ws of cfg?.workspaces ?? []) {
      const found = ws.panes.find(p => p.id === paneId)
      if (found) { pane = `${ws.name} / ${found.title}`; break }
    }
    const key = state === 'done' ? 'status.notif.done' : state === 'error' ? 'status.notif.error' : track.precise ? 'status.notif.action' : 'status.notif.generic'
    this.showNative(mainT(cfg, key, { pane, provider: track.provider === 'codex' ? 'Codex' : 'Claude' }), paneId)
    if (this.cfg?.flashTaskbar && win && !win.isFocused()) win.flashFrame(true)
  }
  private showNative(body: string, paneId?: string): void {
    this.desktopError = null
    if (Notification.isSupported()) {
      const notification = new Notification({ title: 'SnMultiCC', body, silent: true })
      notification.on('click', () => {
        const w = this.getWindow()
        if (!w || w.isDestroyed()) return
        if (w.isMinimized()) w.restore()
        w.show(); w.focus()
        if (paneId) w.webContents.send(CH.STATUS_REVEAL, paneId)
      })
      notification.on('failed', (_event, error) => {
        this.desktopError = /-214342014[03]/.test(error) ? 'blocked' : 'failed'
        console.warn('[status] Desktop notification could not be displayed')
      })
      notification.show()
    } else this.desktopError = 'unavailable'
  }
  private emit(evt: PaneStatusEvt): void {
    const win = this.getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(CH.STATUS_STATE, evt)
  }
}
