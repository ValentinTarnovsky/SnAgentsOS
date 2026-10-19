import { Hourglass, Play, RotateCw, XCircle } from 'lucide-react'
import { useAppStore, type HeldPane } from '@/lib/store'
import { useT } from '@/i18n'

/**
 * What a console shows while its repo setup runs (E8-FR-25): "Waiting for
 * setup..." with "Start now", or "Setup failed (code N)" with "Retry" and
 * "Start anyway". The terminal mounts (and spawns) once it is released.
 */
export function RepoSetupPlaceholder({ paneId, held }: { paneId: string; held: HeldPane }) {
  const t = useT()
  const release = useAppStore((s) => s.releaseHeldPanes)
  const retry = useAppStore((s) => s.retryRepoSetup)
  const btn = 'flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-text-primary transition-colors hover:bg-bg-secondary'

  if (held.state === 'failed') {
    // "Start anyway" releases every console still held by this setup.
    const startAll = (): void => {
      const all = useAppStore.getState().heldPanes
      release(Object.keys(all).filter((id) => all[id].setupPaneId === held.setupPaneId))
    }
    return (
      <div data-pane-held="failed" className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-xs text-text-secondary">
        <span className="flex items-center gap-1.5 text-red-400">
          <XCircle size={13} className="shrink-0" />
          {t('repo.held.failed', { code: held.code ?? -1 })}
        </span>
        <div className="flex gap-2">
          <button data-pane-held-retry onClick={() => retry(held.setupPaneId)} className={btn}>
            <RotateCw size={12} />
            {t('repo.held.retry')}
          </button>
          <button data-pane-held-start onClick={startAll} className={btn}>
            <Play size={12} />
            {t('repo.held.startAnyway')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div data-pane-held="waiting" className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-xs text-text-secondary">
      <span className="flex items-center gap-1.5">
        <Hourglass size={13} className="shrink-0 text-accent-violet" />
        {t('repo.held.waiting')}
      </span>
      <button data-pane-held-start onClick={() => release([paneId])} className={btn}>
        <Play size={12} />
        {t('repo.held.startNow')}
      </button>
    </div>
  )
}
