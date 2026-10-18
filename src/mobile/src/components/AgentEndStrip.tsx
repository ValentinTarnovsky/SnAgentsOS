/**
 * Strip above the KeyBar mirroring the desktop's "Claude exited [Resume]
 * [New]" chip (E6-FR-24) for the viewed console. It shows while the snapshot
 * carries `agentEnded` for that pane (the desktop still offers it) and the
 * exit strip does not. [Resume] / [New] send ctl agentResume: the desktop
 * types the very same text as its own chip, and the first device to answer
 * wins (the rest get `stale`). [Hide] only hides it on this phone until the
 * offer goes away.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { History, Plus, X } from 'lucide-react'
import type { RemoteStateSnapshot } from '@shared/remote-protocol'
import { useRemoteStore } from '../lib/store'
import { useExitStore } from '../lib/exitState'
import { client } from '../lib/client'
import { t } from '../lib/i18n'

/** The viewed pane's offer: its workspace and whether [Resume] applies, or null. */
function offerOf(snapshot: RemoteStateSnapshot | null | undefined, paneId: string | null): { workspaceId: string; canResume: boolean } | null {
  if (!paneId) return null
  for (const ws of snapshot?.workspaces ?? []) {
    const pane = ws.panes.find((p) => p.id === paneId)
    if (pane) return pane.agentEnded ? { workspaceId: ws.id, canResume: pane.agentEnded.canResume } : null
  }
  return null
}

export function AgentEndStrip(): ReactNode {
  const paneId = useRemoteStore((s) => s.subscribedPaneId)
  // Primitive selectors: a fresh object per read would re-render forever.
  const workspaceId = useRemoteStore((s) => offerOf(s.snapshot, paneId)?.workspaceId ?? null)
  const canResume = useRemoteStore((s) => offerOf(s.snapshot, paneId)?.canResume ?? false)
  const exited = useExitStore((s) => !!paneId && s.exit?.paneId === paneId)
  const [hidden, setHidden] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // A new offer (or another console) shows the strip again.
  const offered = !!workspaceId
  useEffect(() => {
    if (!offered) setHidden(null)
  }, [offered, paneId])

  if (!paneId || !workspaceId || exited || hidden === paneId) return null

  const send = async (mode: 'resume' | 'new'): Promise<void> => {
    setBusy(true)
    const res = await client.sendCtl({ kind: 'agentResume', workspaceId, paneId, mode })
    setBusy(false)
    if (res.ok) return
    useRemoteStore.getState().setToast(t(res.error === 'stale' ? 'agentEnd.stale' : 'toast.actionFailed'))
  }

  const btn = 'flex h-9 shrink-0 items-center gap-1.5 rounded-btn px-3 text-xs font-medium disabled:opacity-50'

  return (
    <div
      data-agent-end-strip
      role="status"
      className="flex shrink-0 items-center gap-2 border-t border-border bg-bg-secondary px-3 py-2"
    >
      <History size={14} className="shrink-0 text-accent-violet" />
      <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">{t('agentEnd.title')}</span>
      <button
        data-agent-end="new"
        disabled={busy}
        onClick={() => void send('new')}
        className={`${btn} border border-border text-text-primary active:bg-card`}
      >
        <Plus size={14} />
        {t('agentEnd.new')}
      </button>
      {canResume && (
        <button
          data-agent-end="resume"
          disabled={busy}
          onClick={() => void send('resume')}
          className={`${btn} bg-accent-violet font-semibold text-white active:brightness-110`}
        >
          <History size={14} />
          {t('agentEnd.resume')}
        </button>
      )}
      <button
        data-agent-end="hide"
        onClick={() => setHidden(paneId)}
        aria-label={t('agentEnd.dismiss')}
        className="flex h-9 w-8 shrink-0 items-center justify-center rounded-btn text-text-secondary active:bg-card"
      >
        <X size={14} />
      </button>
    </div>
  )
}
