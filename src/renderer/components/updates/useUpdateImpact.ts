import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/lib/store'
import type { TFn } from '@/i18n'

/** How often the open console count refreshes while the notice is on screen (E4-FR-15). */
export const IMPACT_REFRESH_MS = 5000
/** How long the armed "close N consoles and update" button waits for the second click. */
export const CONFIRM_WINDOW_MS = 5000

/** Consoles with an agent working or waiting for an answer. */
export function countBusyAgents(paneStatus: Record<string, { state: string } | undefined>): number {
  let n = 0
  for (const s of Object.values(paneStatus)) if (s && (s.state === 'working' || s.state === 'action')) n++
  return n
}

/**
 * Live impact of an update that closes the app (E4-FR-15): N open consoles
 * from main's pty count (`system.getMetrics().consoles`, refreshed every 5 s
 * while `active`) and M of them with an agent working or waiting. `consoles`
 * is null until the first answer.
 */
export function useUpdateImpact(active: boolean): { consoles: number | null; busy: number } {
  const busy = useAppStore((s) => countBusyAgents(s.paneStatus))
  const [consoles, setConsoles] = useState<number | null>(null)
  useEffect(() => {
    if (!active) return
    let alive = true
    const load = (): void => {
      window.snApi.system
        .getMetrics()
        .then((m) => {
          if (alive) setConsoles(m.consoles)
        })
        .catch(() => undefined)
    }
    load()
    const timer = setInterval(load, IMPACT_REFRESH_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [active])
  return { consoles, busy }
}

/** The notice line: "N consoles will close (M with an agent working or waiting)". */
export function impactText(t: TFn, consoles: number, busy: number): string {
  if (consoles <= 0) return t('update.impact.none')
  const b = Math.min(busy, consoles)
  if (b > 0) return consoles === 1 ? t('update.impact.busyOne') : t('update.impact.busy', { count: consoles, busy: b })
  return consoles === 1 ? t('update.impact.consolesOne') : t('update.impact.consoles', { count: consoles })
}

/**
 * Two-step confirm: the first `click()` arms for 5 s and returns false, a
 * second one inside the window returns true. `needed` false confirms at once.
 */
export function useDoubleConfirm(needed: boolean): { armed: boolean; click: () => boolean; reset: () => void } {
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reset = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setArmed(false)
  }, [])
  useEffect(() => reset, [reset])
  const click = useCallback((): boolean => {
    if (!needed || armed) {
      reset()
      return true
    }
    setArmed(true)
    timer.current = setTimeout(() => {
      timer.current = null
      setArmed(false)
    }, CONFIRM_WINDOW_MS)
    return false
  }, [needed, armed, reset])
  return { armed, click, reset }
}
