/**
 * Pure helpers for the "PC awake" UI (E5-FR-24). No window access, so
 * scripts/test-agents.cjs runs them directly.
 */
import type { PowerState } from '@shared/ipc-contract'
import type { AwakeMode } from '@shared/types'
import type { MessageKey } from '@/i18n'

/**
 * Reconciles settings.awakeMode (renderer, persisted) with the mode main
 * reports on power:state. A mode picked from the tray arrives only through
 * power:state, so it has to be persisted; but a power:state already in flight
 * when the user changes the setting carries the old mode and must not revert
 * it. While one of our pushes is unanswered, `mode` is ignored until main
 * echoes it (main answers every power:setConfig).
 */
export function createAwakeModeSync(send: (mode: AwakeMode) => void, persist: (mode: AwakeMode) => void) {
  let pending: AwakeMode | null = null
  let mainMode: AwakeMode | null = null
  return {
    /** settings.awakeMode changed (or was hydrated). */
    push(mode: AwakeMode): void {
      if (pending === null && mode === mainMode) return
      pending = mode
      send(mode)
    },
    /** A power:state (or the power:getState answer) arrived. */
    onState(state: PowerState): void {
      const mode = state.mode
      if (!mode) return
      mainMode = mode
      if (pending !== null) {
        if (mode === pending) pending = null
        return
      }
      persist(mode)
    },
  }
}

/** The coffee icon shows while the block is held, and always in `always` mode. */
export function awakeIndicatorVisible(state: PowerState | null, mode: AwakeMode): boolean {
  if (!state) return false
  return state.blocking || (state.mode ?? mode) === 'always'
}

/** "1:45" for the grace countdown (never negative). */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Tooltip copy for the indicator. */
export function awakeTooltip(
  state: PowerState,
  mode: AwakeMode,
  now: number,
): { key: MessageKey; vars?: Record<string, string | number> } {
  if ((state.mode ?? mode) === 'always') return { key: 'awake.tip.always' }
  if (state.releaseAt !== undefined) return { key: 'awake.tip.grace', vars: { time: formatCountdown(state.releaseAt - now) } }
  const n = state.workingCount ?? 0
  if (n === 1) return { key: 'awake.tip.workingOne' }
  if (n > 1) return { key: 'awake.tip.workingMany', vars: { n } }
  return { key: 'awake.tip.phone' }
}
