/**
 * "The update did not finish" toast (app 2.4.0). The silent Windows update
 * quits the app before the setup runs; when the setup never completes (a
 * declined permission prompt), main finds its marker on the next start and
 * hands it out once on `update:notApplied`. [Retry] reopens the update card
 * and checks again, so the normal install flow takes over.
 */
import type { UpdateNotApplied } from '@shared/ipc-contract'
import { translate, type MessageKey } from '@/i18n'
import { useAppStore } from './store'
import { toast } from './toast'
import { useUpdaterStore } from './updater'

/** dedupeKey of the toast (one per start at most). */
export const UPDATE_NOT_APPLIED_KEY = 'update-not-applied'

/** Shows the toast for `info`; exported for tests. */
export function notifyUpdateNotApplied(info: UpdateNotApplied): void {
  const lang = useAppStore.getState().settings.language
  const t = (key: MessageKey, vars?: Record<string, string | number>): string => translate(lang, key, vars)
  toast.warning(t('update.notApplied.title', { version: info.to }), {
    body: t('update.notApplied.body'),
    durationMs: null,
    dedupeKey: UPDATE_NOT_APPLIED_KEY,
    actions: [
      {
        label: t('update.notApplied.retry'),
        run: () => {
          const updater = useUpdaterStore.getState()
          updater.showCard()
          void updater.check()
        },
      },
    ],
  })
}

/** Asks main once whether the last silent update failed to apply, and tells the user. */
export async function checkUpdateNotApplied(): Promise<void> {
  try {
    const info = await window.snApi.updates.takeNotApplied()
    if (info) notifyUpdateNotApplied(info)
  } catch {
    /* an older preload or a failed invoke: nothing to show */
  }
}
