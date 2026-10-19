/**
 * Agent hibernation and the Claude cache timer (E5-FR-25..28), shared by
 * main, the desktop renderer and the phone. Pure values and rules only: no
 * Node or DOM imports.
 */
import type { AgentProvider, ClaudePaneState } from './types'

/** Planner period (E5-FR-25). The interval only runs with hibernation on. */
export const HIBERNATE_TICK_MS = 60_000
/** Most consoles put to sleep in one tick. */
export const HIBERNATE_MAX_PER_TICK = 3
/** What Settings proposes when the user turns hibernation on. */
export const HIBERNATE_SUGGESTED_MINUTES = 30
export const HIBERNATE_MIN_MINUTES = 5
export const HIBERNATE_MAX_MINUTES = 1440
/** A schedule due this soon (or overdue) wakes its sleeping console (E5-FR-26). */
export const SCHEDULE_WAKE_LEAD_MS = 30_000

/**
 * `settings.hibernateIdleMinutes` as the schema reads it: 0 (off) or a whole
 * number of minutes in 5..1440; anything else is off.
 */
export function normalizeIdleMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return 0
  return value >= HIBERNATE_MIN_MINUTES && value <= HIBERNATE_MAX_MINUTES ? value : 0
}

/**
 * Renderer -> main (`agents:setHibernation`): the setting and the consoles
 * the user can see right now (or that a run is about to use), which never
 * sleep. Main reads everything else itself.
 */
export interface HibernationConfig {
  idleMinutes: number
  /** Visible consoles plus consoles with a scheduled run in flight. */
  keep: string[]
}

/** Main -> renderer (`agents:hibernate`): main killed this console's pty to save memory. */
export interface AgentsHibernateEvt {
  paneId: string
  /** Epoch ms it went to sleep. */
  at: number
  /** The idle threshold that put it to sleep ("after 30 min idle"). */
  idleMinutes: number
}

/** The last minute of the cache countdown turns amber (E5-FR-28). */
export const CACHE_WARN_MS = 60_000

/** What the cache timer needs from a pane's status (desktop PaneStatus or phone RemotePaneStatus). */
export interface CacheStatusLike {
  state: ClaudePaneState
  provider?: AgentProvider
}

/** Only Claude has the prompt cache the countdown tracks, and only between turns. */
export function cacheApplies(status: CacheStatusLike | null | undefined): boolean {
  return !!status && status.provider === 'claude' && (status.state === 'done' || status.state === 'idle')
}

/** Epoch ms the cache expires, from the working -> done/idle transition. */
export function cacheDeadline(since: number | undefined, ttlMinutes: number): number | null {
  if (typeof since !== 'number' || !Number.isFinite(since) || since <= 0) return null
  return since + (ttlMinutes === 60 ? 60 : 5) * 60_000
}

/** "4:12": whole seconds left, rounded up, so the chip reads 0:01 in its last second. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const min = Math.floor(total / 60)
  const sec = total % 60
  return `${min}:${sec < 10 ? '0' : ''}${sec}`
}
