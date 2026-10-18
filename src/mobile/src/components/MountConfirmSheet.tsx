/**
 * Confirmation before opening a stopped console of a workspace the desktop
 * has not mounted (E2-FR-06): "This starts N consoles of <workspace> on the PC
 * (without changing what you are looking at)". Start sends `mountWorkspace`
 * and opens the console once acked; Cancel leaves everything as it was. The
 * sheet is driven by store.mountAsk, which client.requestOpen sets, so every
 * entry point (rows, Resume, tabs, the waiting pill, deep links) shares it.
 */
import { useRef, useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { Sheet } from './Sheet'
import { useRemoteStore } from '../lib/store'
import { client } from '../lib/client'
import { workspaceOfPane } from '../lib/workspace'
import { t } from '../lib/i18n'

export function MountConfirmSheet(): ReactNode {
  const paneId = useRemoteStore((s) => s.mountAsk)
  const update = useRemoteStore((s) => s.update)
  // Keep the text through the exit animation, after mountAsk cleared.
  const last = useRef<string | null>(null)
  if (paneId) last.current = paneId
  const shown = paneId ?? last.current
  const ws = useRemoteStore((s) => {
    if (!s.snapshot || !shown) return undefined
    const wsId = workspaceOfPane(s.snapshot, shown)
    return s.snapshot.workspaces.find((w) => w.id === wsId)
  })
  const [busy, setBusy] = useState(false)
  const close = (): void => update({ mountAsk: null })

  const start = async (): Promise<void> => {
    if (!paneId || busy) return
    setBusy(true)
    try {
      await client.mountAndOpen(paneId)
    } finally {
      setBusy(false)
      close()
    }
  }

  return (
    <Sheet open={paneId != null} onClose={close} title={ws?.name ?? ''}>
      <p data-mount-message className="mb-5 text-sm leading-relaxed text-text-secondary">
        {t('mount.body', { n: ws?.panes.length ?? 0, ws: ws?.name ?? '' })}
      </p>
      <div className="flex gap-2">
        <button
          onClick={close}
          className="h-12 flex-1 rounded-btn border border-border bg-bg-secondary text-sm font-medium text-text-primary active:bg-card"
        >
          {t('act.cancel')}
        </button>
        <button
          data-mount-start
          disabled={busy}
          onClick={() => void start()}
          className="flex h-12 flex-1 items-center justify-center gap-2 rounded-btn bg-accent-violet text-sm font-semibold text-white active:brightness-110 disabled:opacity-60"
        >
          {busy && <Loader2 size={16} className="spin" />}
          {t('mount.start')}
        </button>
      </div>
    </Sheet>
  )
}
