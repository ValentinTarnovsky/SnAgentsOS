/**
 * "Send N notes" (E3-FR-55): pick the console (by default the agent console
 * of this workspace the phone viewed last) and the "Press Enter" switch, off
 * by default. The notes go inline on the `sendReviewNotes` ctl, cut into
 * batches the desktop accepts (chunkNotes); Enter only rides on the last
 * batch. The desktop formats them with the shared review-notes format,
 * sanitizes and pastes each batch with the console's real bracketed paste.
 * Each acked batch is stamped sent (hidden behind "Show sent"); a refusal
 * says why and keeps the rest pending, no answer shows "The PC did not answer
 * [Retry]" and Retry sends what is still pending.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { Check, Loader2 } from 'lucide-react'
import { Sheet } from '../Sheet'
import { NoReply } from '../NoReply'
import { store, useRemoteStore } from '../../lib/store'
import { client } from '../../lib/client'
import { isNoReply } from '../../lib/pending'
import { PaneIcon } from '../../lib/paneIcon'
import { closeNotesUi, defaultNotesTarget, useChangesStore } from '../../lib/changes'
import { chunkNotes, pendingNotes, toPayload, useNotesStore } from '../../lib/notesStore'
import { t, type MobileMessageKey } from '../../lib/i18n'

const ERROR_KEYS: Record<string, MobileMessageKey> = {
  not_found: 'notes.err.not_found',
  no_pty: 'notes.err.no_pty',
  not_agent: 'notes.err.not_agent',
  no_notes: 'notes.err.no_notes',
  too_large: 'notes.err.too_large',
}

export function SendNotesSheet(): ReactNode {
  const workspaceId = useChangesStore((s) => s.workspaceId)
  const open = useChangesStore((s) => s.notesUi === 'send' && s.workspaceId != null)
  const ws = useRemoteStore((s) => s.snapshot?.workspaces.find((w) => w.id === workspaceId) ?? null)
  const notes = useNotesStore((s) => (workspaceId ? s.byWs[workspaceId] : undefined))
  const [paneId, setPaneId] = useState<string | null>(null)
  const [enter, setEnter] = useState(false)
  const [busy, setBusy] = useState(false)
  const [noReply, setNoReply] = useState(false)
  const inFlight = useRef(false)

  useEffect(() => {
    if (!open || !workspaceId) return
    const s = store.getState()
    setPaneId(defaultNotesTarget(s.snapshot, workspaceId, s.lastViewedAt, s.paneStatus, s.lastPane))
    setEnter(false)
    setBusy(false)
    setNoReply(false)
  }, [open, workspaceId])

  const pending = pendingNotes(notes ?? [])
  const panes = ws?.panes ?? []

  const send = async (): Promise<void> => {
    if (!workspaceId || !paneId || inFlight.current) return
    const batches = chunkNotes(useNotesStore.getState().ensure(workspaceId))
    if (!batches.length) return
    inFlight.current = true
    setBusy(true)
    setNoReply(false)
    const total = batches.reduce((n, b) => n + b.length, 0)
    let sent = 0
    let error: string | undefined
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i]
      const res = await client.sendCtl({ kind: 'sendReviewNotes', workspaceId, paneId, notes: batch.map(toPayload), enter: enter && i === batches.length - 1 })
      if (!res.ok) {
        error = res.error ?? 'error'
        break
      }
      useNotesStore.getState().markSent(workspaceId, batch.map((n) => n.id), Date.now())
      sent += batch.length
    }
    inFlight.current = false
    setBusy(false)
    const s = store.getState()
    const pane = panes.find((p) => p.id === paneId)?.title ?? ''
    if (!error) {
      s.pushToast({ text: sent === 1 ? t('notes.sent1', { pane }) : t('notes.sent', { n: sent, pane }), kind: 'done' })
      closeNotesUi()
      return
    }
    if (isNoReply(error) || error === 'offline') {
      setNoReply(true)
      return
    }
    const why = t(ERROR_KEYS[error] ?? 'notes.err.generic')
    s.pushToast({ text: sent > 0 ? `${t('notes.partSent', { sent, total })} ${why}` : why, kind: 'error' })
  }

  return (
    <Sheet open={open} onClose={closeNotesUi} title={pending.length === 1 ? t('notes.send1') : t('notes.send', { n: pending.length })}>
      <div data-notes-send-sheet={workspaceId ?? ''} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="px-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">{t('notes.target')}</span>
          {panes.length === 0 ? (
            <p data-notes-no-consoles className="px-1 text-sm text-text-secondary">{t('notes.noConsoles')}</p>
          ) : (
            <div role="radiogroup" aria-label={t('notes.target')} className="overflow-hidden rounded-card border border-border bg-bg-secondary">
              {panes.map((p) => {
                const on = p.id === paneId
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    data-notes-target={p.id}
                    onClick={() => setPaneId(p.id)}
                    className={clsx('flex min-h-12 w-full items-center gap-3 border-b border-border px-3 text-left last:border-b-0', on ? 'bg-accent-violet/10' : 'active:bg-card')}
                  >
                    <PaneIcon type={p.type} size={16} className="text-text-secondary" />
                    <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{p.title}</span>
                    {on && <Check size={16} className="shrink-0 text-accent-violet" />}
                  </button>
                )
              })}
            </div>
          )}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enter}
          data-notes-enter
          onClick={() => setEnter((v) => !v)}
          className="flex min-h-12 items-center gap-3 rounded-card border border-border bg-bg-secondary px-3 py-2 text-left"
        >
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm text-text-primary">{t('notes.enter')}</span>
            <span className="text-[11px] text-text-secondary">{t('notes.enterHint')}</span>
          </span>
          <span className={clsx('relative h-6 w-10 shrink-0 rounded-full transition-colors', enter ? 'bg-accent-violet' : 'bg-border')}>
            <span className={clsx('absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform', enter ? 'translate-x-[18px]' : 'translate-x-0.5')} />
          </span>
        </button>
        {noReply && <NoReply onRetry={() => void send()} />}
        <button
          type="button"
          data-notes-confirm
          disabled={busy || !paneId || pending.length === 0}
          aria-busy={busy || undefined}
          onClick={() => void send()}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-btn bg-accent-violet text-sm font-semibold text-white active:opacity-90 disabled:opacity-50"
        >
          {busy && <Loader2 size={16} className="animate-spin" />}
          {pending.length === 1 ? t('notes.send1') : t('notes.send', { n: pending.length })}
        </button>
      </div>
    </Sheet>
  )
}
