/**
 * Renderer side of hibernation (E5-FR-25/26). Main plans and kills; this
 * module tells main what it cannot know (the setting and which consoles are
 * on screen), shows a console as asleep when main put it to sleep, and wakes
 * it: the overlay's [Resume] (click or Enter), a phone restartPane with
 * `resume: true` (any restart goes through restartPaneClean, which clears the
 * sleeping mark) or a schedule about to run. A phone `sub` never wakes.
 *
 * While a woken console comes back, a scheduled prompt waits (isWaking) until
 * the resumed agent reports its first idle, or 1 s after its session start,
 * like the resume nudge of E5-FR-13.
 */
import { normalizeIdleMinutes, type AgentsHibernateEvt, type HibernationConfig } from '@shared/hibernation'
import type { Workspace } from '@shared/types'
import { useAppStore, type AppState } from './store'
import { useAgentStore } from './agentStore'
import { killPanePtys } from './ptyRegistry'
import { visibleConsoles } from './agentNav'
import { restartResume } from './agentLaunch'

/** A woken console stops holding scheduled prompts after this long, signal or not. */
export const WAKE_MAX_MS = 90_000
/** After the resumed session's start, the prompt still waits this long without an idle. */
export const WAKE_AFTER_START_MS = 1_000

const waking = new Map<string, ReturnType<typeof setTimeout>>()
const wakeListeners = new Set<() => void>()

function notifyWaking(): void {
  for (const cb of wakeListeners) cb()
}

/** True while a console woken from sleep has not reported ready yet (holds scheduled prompts). */
export function isWaking(paneId: string): boolean {
  return waking.has(paneId)
}

function endWaking(paneId: string): void {
  const timer = waking.get(paneId)
  if (timer === undefined) return
  clearTimeout(timer)
  waking.delete(paneId)
  notifyWaking()
}

function holdWaking(paneId: string, ms: number): void {
  const prev = waking.get(paneId)
  if (prev !== undefined) clearTimeout(prev)
  waking.set(paneId, setTimeout(() => endWaking(paneId), ms))
  notifyWaking()
}

/**
 * Wake a sleeping console: relaunch it resuming its chat (a record that went
 * unavailable meanwhile starts a new chat with the chip). False when the
 * console is not asleep.
 */
export function wakePane(paneId: string): boolean {
  if (!useAgentStore.getState().sleeping[paneId]) return false
  holdWaking(paneId, WAKE_MAX_MS)
  restartResume(paneId)
  return true
}

/**
 * Consoles that never sleep: the visible ones of the active workspace (only
 * the maximized one while one is maximized, never the minimized ones) plus
 * the ones waking up. Pure over the store values.
 */
export function hibernationKeep(
  app: Pick<AppState, 'workspaces' | 'activeWorkspaceId' | 'minimized' | 'maximized'>,
  wakingIds: Iterable<string> = [],
): string[] {
  const ws: Workspace | undefined = app.workspaces.find((w) => w.id === app.activeWorkspaceId)
  const ids = ws ? visibleConsoles(ws, app.minimized[ws.id] ?? [], app.maximized[ws.id]) : []
  return [...new Set([...ids, ...wakingIds])]
}

/** What the renderer pushes on `agents:setHibernation`. */
export function hibernationConfig(app: Pick<AppState, 'workspaces' | 'activeWorkspaceId' | 'minimized' | 'maximized' | 'settings'>): HibernationConfig {
  return { idleMinutes: normalizeIdleMinutes(app.settings.hibernateIdleMinutes), keep: hibernationKeep(app, waking.keys()) }
}

/** Main put a console to sleep: show it asleep (the pty is already gone). */
export function applyHibernate(evt: AgentsHibernateEvt): boolean {
  if (!evt || typeof evt.paneId !== 'string') return false
  const exists = useAppStore.getState().workspaces.some((w) => w.panes.some((p) => p.id === evt.paneId))
  if (!exists) return false
  useAgentStore.getState().setSleeping(evt.paneId, { at: evt.at, idleMinutes: evt.idleMinutes })
  // Drops the local pty binding (main already killed it; idempotent there).
  killPanePtys([evt.paneId])
  return true
}

let stop: (() => void) | null = null

/**
 * Wire hibernation once the store is hydrated: push the setting and the
 * visible consoles to main on every change, apply main's sleeps, end the
 * wake hold on the resumed agent's ready signal and forget sleeping consoles
 * that were closed. Idempotent; returns a stop function.
 */
export function initHibernation(): () => void {
  if (stop) return () => undefined
  const api = window.snApi.agents
  let lastSent = ''
  const push = (): void => {
    const cfg = hibernationConfig(useAppStore.getState())
    const key = JSON.stringify(cfg)
    if (key === lastSent) return
    lastSent = key
    api.setHibernation(cfg)
  }
  push()
  const offApp = useAppStore.subscribe((s, prev) => {
    if (s.workspaces !== prev.workspaces) {
      const sleeping = useAgentStore.getState().sleeping
      const ids = Object.keys(sleeping)
      if (ids.length > 0) {
        const alive = new Set(s.workspaces.flatMap((w) => w.panes.map((p) => p.id)))
        for (const id of ids) if (!alive.has(id)) useAgentStore.getState().setSleeping(id, null)
      }
    }
    if (
      s.workspaces !== prev.workspaces ||
      s.activeWorkspaceId !== prev.activeWorkspaceId ||
      s.minimized !== prev.minimized ||
      s.maximized !== prev.maximized ||
      s.settings.hibernateIdleMinutes !== prev.settings.hibernateIdleMinutes
    ) {
      push()
    }
  })
  wakeListeners.add(push)
  const offHibernate = api.onHibernate((evt) => applyHibernate(evt))
  const offReady = api.onReady((evt) => {
    if (!waking.has(evt.paneId)) return
    if (evt.phase === 'idle') endWaking(evt.paneId)
    else holdWaking(evt.paneId, WAKE_AFTER_START_MS)
  })
  const off = (): void => {
    offApp()
    offHibernate()
    offReady()
    wakeListeners.delete(push)
    stop = null
  }
  stop = off
  return off
}
