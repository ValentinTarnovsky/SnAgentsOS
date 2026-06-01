import { useEffect } from 'react'
import { useAppStore } from './store'
import { getPtyId } from './ptyRegistry'

/** Delay between writing the prompt text and the Enter that submits it. Agent
 *  TUIs (Claude Code, Codex) debounce fast text+Enter as a paste, turning the
 *  Enter into a newline instead of a submit, so we space them out like a human. */
const SUBMIT_DELAY_MS = 150

/**
 * Compute the next epoch-ms occurrence of an "HH:MM" wall-clock time using the
 * local PC clock. If the time has already passed today, it rolls to tomorrow.
 */
export function nextOccurrence(time: string, from: Date = new Date()): number {
  const [h, m] = time.split(':').map((n) => Number.parseInt(n, 10))
  const due = new Date(from)
  due.setHours(h, m, 0, 0)
  if (due.getTime() <= from.getTime()) due.setDate(due.getDate() + 1)
  return due.getTime()
}

/** Fire a console's scheduled prompt into its live pty (no-op if no pty yet). */
function fire(prompt: string, ptyId: string): void {
  window.snApi.pty.write({ ptyId, data: prompt })
  setTimeout(() => window.snApi.pty.write({ ptyId, data: '\r' }), SUBMIT_DELAY_MS)
}

/**
 * Drives every console's one-shot scheduled prompt. A single 1s ticker scans
 * all panes; when one is due and its pty exists, it sends the prompt and clears
 * the schedule. If a due pane has no live pty yet (its workspace was never
 * opened), the schedule stays pending and fires once the console mounts.
 */
export function usePaneScheduler(): void {
  useEffect(() => {
    const tick = (): void => {
      const now = Date.now()
      const { workspaces, setPaneSchedule } = useAppStore.getState()
      for (const ws of workspaces) {
        for (const pane of ws.panes) {
          const sched = pane.schedule
          if (!sched || now < sched.dueAt) continue
          const ptyId = getPtyId(pane.id)
          if (!ptyId) continue // console not mounted yet; retry next tick
          fire(sched.prompt, ptyId)
          setPaneSchedule(ws.id, pane.id, null)
        }
      }
    }
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])
}
