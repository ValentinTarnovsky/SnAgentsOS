/**
 * Silence watch settings (schema 19, app 2.7.0, plan A3): a working agent
 * with no signal for quietMin minutes reads `quiet`, for stalledMin minutes
 * `stalled`. Pure; shared by the main schema, SilenceWatch and the renderer.
 */
import type { SilenceSettings } from './types'

export const SILENCE_QUIET_MIN = { min: 1, max: 120 } as const
export const SILENCE_STALLED_MIN = { min: 2, max: 240 } as const

export const DEFAULT_SILENCE: Readonly<SilenceSettings> = { enabled: true, quietMin: 10, stalledMin: 20 }

function minutes(v: unknown, range: { min: number; max: number }, fallback: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= range.min && v <= range.max ? v : fallback
}

/**
 * Any value (a `config:save` blob is unvalidated) as complete settings: a
 * field that is missing, junk or out of its range goes back to its default,
 * then stalledMin is forced above quietMin (quietMin moves down when
 * stalledMin cannot grow).
 */
export function normalizeSilence(v: unknown): SilenceSettings {
  const src = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  const enabled = typeof src.enabled === 'boolean' ? src.enabled : DEFAULT_SILENCE.enabled
  let quietMin = minutes(src.quietMin, SILENCE_QUIET_MIN, DEFAULT_SILENCE.quietMin)
  let stalledMin = minutes(src.stalledMin, SILENCE_STALLED_MIN, DEFAULT_SILENCE.stalledMin)
  if (stalledMin <= quietMin) {
    if (quietMin + 1 <= SILENCE_STALLED_MIN.max) stalledMin = quietMin + 1
    else quietMin = stalledMin - 1
  }
  return { enabled, quietMin, stalledMin }
}
