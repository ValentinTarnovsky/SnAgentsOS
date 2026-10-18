import { useEffect } from 'react'
import { translate } from '@/i18n'
import { useAppStore } from './store'
import { getPtyId } from './ptyRegistry'
import { toast } from './toast'

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

/**
 * Fire a console's scheduled prompt into its live pty through the shared
 * delivery path (E8-FR-02a): the Enter goes 150 ms after the text drained.
 */
function fire(prompt: string, ptyId: string, paneId: string): void {
  void window.snApi.pty.submit({ ptyId, paneId, text: prompt, enter: true }).then((res) => {
    if (res.ok || res.error !== 'multiline_unsafe') return
    toast.warning(translate(useAppStore.getState().settings.language, 'quick.toast.multiline'), { dedupeKey: 'schedule' })
  })
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
          fire(sched.prompt, ptyId, pane.id)
          setPaneSchedule(ws.id, pane.id, null)
        }
      }
    }
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])
}
